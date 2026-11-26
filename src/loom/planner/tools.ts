import type { PlanningContext } from './context';
import { freeSlots } from './context';
import type { ToolRequest } from './schema';

/**
 * Bounded read tools for the planner (§6.9). Scoped to the business IN CODE
 * (they only read the PlanningContext loaded for this business), no SQL, no
 * writes, at most MAX_TOOL_CALLS per run. Every answer gets a tr_<n> id the
 * model may cite as evidence; small segments are withheld (privacy minimum).
 */
export const MAX_TOOL_CALLS = 3;
export const MIN_SEGMENT = 5;

export type ToolResult = { id: string; tool: ToolRequest['tool']; status: 'ok' | 'not_found' | 'insufficient' | 'invalid'; value: number | null; note: string };

export function runTools(pc: PlanningContext, requests: ToolRequest[], startAt = 1): ToolResult[] {
  return requests.slice(0, MAX_TOOL_CALLS).map((r, i) => {
    const id = `tr_${startAt + i}`;
    try { return { id, ...answer(pc, r) }; } catch { return { id, tool: r.tool, status: 'invalid' as const, value: null, note: 'invalid request' }; }
  });
}

function offeringOf(pc: PlanningContext, ref: string | null) {
  const o = pc.opps.find((x) => x.ref === ref);
  return o?.offering_id ?? null;
}

function answer(pc: PlanningContext, r: ToolRequest): Omit<ToolResult, 'id'> {
  switch (r.tool) {
    case 'get_metric': {
      if (!r.metric_key) return { tool: r.tool, status: 'invalid', value: null, note: 'metric_key required' };
      const grain = !r.grain_ref || r.grain_ref === 'business' ? 'business' : r.grain_ref.startsWith('offering_ref:') ? `offering:${offeringOf(pc, r.grain_ref.slice(13)) ?? '-'}` : null;
      if (!grain) return { tool: r.tool, status: 'invalid', value: null, note: 'grain_ref must be business or offering_ref:O<n>' };
      const k = `${r.metric_key}|${grain}`;
      if (!pc.metrics.has(k)) return { tool: r.tool, status: 'not_found', value: null, note: `${r.metric_key} not computed for ${r.grain_ref ?? 'business'}` };
      const v = pc.metrics.get(k) ?? null;
      return { tool: r.tool, status: v === null ? 'insufficient' : 'ok', value: v, note: `${r.metric_key} (${r.grain_ref ?? 'business'})` };
    }
    case 'get_capacity': {
      const off = offeringOf(pc, r.offering_ref);
      if (!off) return { tool: r.tool, status: 'invalid', value: null, note: 'offering_ref must be one of the given opportunities' };
      const from = r.window?.from && r.window.from >= pc.today ? r.window.from : pc.period.from;
      const to = r.window?.to && r.window.to >= from ? r.window.to : pc.period.to;
      const s = freeSlots(pc.ctx, off, from, to);
      return { tool: r.tool, status: s.count === null ? 'insufficient' : 'ok', value: s.count, note: `free slots ${from}..${to}` };
    }
    case 'get_segment_size': {
      if (!r.segment) return { tool: r.tool, status: 'invalid', value: null, note: 'segment required' };
      const now = pc.ctx.now;
      const salesByCustomer = new Map<string, Array<{ offering: string; at: number }>>();
      for (const tx of pc.ds.transactions) {
        if (tx.status !== 'fulfilled') continue;
        const a = salesByCustomer.get(tx.customer_ref) ?? [];
        for (const l of tx.lines) a.push({ offering: l.offering_id, at: tx.occurred_at });
        salesByCustomer.set(tx.customer_ref, a);
      }
      let n = 0;
      for (const c of pc.ds.customers) {
        const sales = salesByCustomer.get(c.pseudo_id) ?? [];
        const ok = r.segment.conditions.every((cond) => {
          if (cond.type === 'last_visit_before_days') return !!cond.days && c.last_seen !== null && c.last_seen < now - cond.days * 86_400_000;
          const off = offeringOf(pc, cond.offering_ref);
          if (!off) throw new Error('bad offering');
          const visited = sales.some((x) => x.offering === off);
          if (cond.type === 'visited_offering') return visited;
          if (cond.type === 'not_visited_offering') return !visited;
          // due_for_offering: visited, and the last visit is older than 28 days (approximation of the cycle).
          const last = Math.max(0, ...sales.filter((x) => x.offering === off).map((x) => x.at));
          return visited && last < now - 28 * 86_400_000;
        });
        if (ok) n++;
      }
      return n < MIN_SEGMENT ? { tool: r.tool, status: 'insufficient', value: null, note: `fewer than ${MIN_SEGMENT} customers` } : { tool: r.tool, status: 'ok', value: n, note: 'customers matching all conditions' };
    }
  }
}
