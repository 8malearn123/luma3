'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { PageBlock } from '@/shared/builder/blocks';
import type { BuilderState, Doc, RefWarning } from './types';

type Part = 'brand' | 'layout' | `page:${string}`;
type Versions = { brand: number; layout: number; pages: Record<string, number> };
const HISTORY = 100;
const AUTOSAVE_MS = 1200;

export function docFromState(s: BuilderState): Doc {
  const { version: _v, ...brand } = s.brand;
  return { brand, layout: s.layout, blocks: Object.fromEntries(s.pages.map((p) => [p.id, p.blocks])) };
}
const versionsFromState = (s: BuilderState): Versions => ({ brand: s.brand_version, layout: s.layout_version, pages: Object.fromEntries(s.pages.map((p) => [p.id, p.version])) });

/** Parts whose current value differs (by reference) from the last persisted value. */
function dirtyParts(doc: Doc, saved: Doc): Part[] {
  const out: Part[] = [];
  if (doc.brand !== saved.brand) out.push('brand');
  if (doc.layout !== saved.layout) out.push('layout');
  for (const id of Object.keys(doc.blocks)) if (doc.blocks[id] !== saved.blocks[id]) out.push(`page:${id}`);
  return out;
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

/**
 * Local working copy of the draft with undo/redo history and debounced
 * autosave. Every document is saved with its version; a 409 stops autosave and
 * surfaces a conflict the owner must resolve (reload latest, or keep mine and
 * overwrite) — changes are never silently lost.
 */
export function useBuilder(slug: string, initial: BuilderState) {
  const [server, setServer] = useState(initial);
  const [doc, setDoc] = useState<Doc>(() => docFromState(initial));
  const [saved, setSaved] = useState<Doc>(() => docFromState(initial));
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<Part | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [warnings, setWarnings] = useState<RefWarning[]>(initial.validation.warnings);

  const docRef = useRef(doc);
  const pastRef = useRef<Doc[]>([]);
  const futureRef = useRef<Doc[]>([]);
  const savedRef = useRef(saved);
  const [hist, setHist] = useState({ past: 0, future: 0 });
  const syncHist = () => setHist({ past: pastRef.current.length, future: futureRef.current.length });
  /** Updates the last-persisted snapshot (ref for async code, state for rendering). */
  const markSaved = useCallback((fn: (d: Doc) => Doc) => { savedRef.current = fn(savedRef.current); setSaved(savedRef.current); }, []);
  const versions = useRef<Versions>(versionsFromState(initial));
  const failed = useRef(new WeakSet<object>());
  const saving = useRef<Promise<boolean> | null>(null);
  const coalesce = useRef<{ key: string; at: number } | null>(null);
  const conflictRef = useRef<Part | null>(null);
  const markConflict = useCallback((c: Part | null) => { conflictRef.current = c; setConflict(c); }, []);

  const dirty = useMemo(() => dirtyParts(doc, saved), [doc, saved]);

  /** Applies a change; `key` coalesces rapid edits of the same field into one undo step. */
  const commit = useCallback((fn: (d: Doc) => Doc, key?: string) => {
    const cur = docRef.current;
    const next = fn(cur);
    if (next === cur) return;
    const now = Date.now();
    const merge = !!key && coalesce.current?.key === key && now - coalesce.current.at < 1000;
    coalesce.current = key ? { key, at: now } : null;
    if (!merge) pastRef.current = [...pastRef.current.slice(-HISTORY + 1), cur];
    futureRef.current = [];
    docRef.current = next;
    setDoc(next);
    syncHist();
  }, []);

  const setBlocks = useCallback((pageId: string, fn: (b: PageBlock[]) => PageBlock[], key?: string) => {
    commit((d) => ({ ...d, blocks: { ...d.blocks, [pageId]: fn(d.blocks[pageId] ?? []) } }), key);
  }, [commit]);

  const undo = useCallback(() => {
    const p = pastRef.current;
    if (!p.length) return;
    const prev = p[p.length - 1]!;
    pastRef.current = p.slice(0, -1);
    futureRef.current = [docRef.current, ...futureRef.current].slice(0, HISTORY);
    coalesce.current = null;
    docRef.current = prev;
    setDoc(prev);
    syncHist();
  }, []);
  const redo = useCallback(() => {
    const f = futureRef.current;
    if (!f.length) return;
    const next = f[0]!;
    futureRef.current = f.slice(1);
    pastRef.current = [...pastRef.current, docRef.current].slice(-HISTORY);
    coalesce.current = null;
    docRef.current = next;
    setDoc(next);
    syncHist();
  }, []);

  const savePart = useCallback(async (part: Part, d: Doc) => {
    const base = `/api/v1/t/${slug}/builder`;
    if (part === 'brand') {
      const r = await api<{ version: number }>(`${base}/brand`, { method: 'PATCH', body: { version: versions.current.brand, brand: d.brand } });
      versions.current.brand = r.version;
      markSaved((s) => ({ ...s, brand: d.brand }));
    } else if (part === 'layout') {
      const r = await api<{ version: number }>(`${base}/layout`, { method: 'PATCH', body: { version: versions.current.layout, layout: d.layout } });
      versions.current.layout = r.version;
      markSaved((s) => ({ ...s, layout: d.layout }));
    } else {
      const id = part.slice(5);
      const blocks = d.blocks[id]!;
      const r = await api<{ version: number; warnings: RefWarning[] }>(`${base}/pages/${id}/blocks`, { method: 'PUT', body: { version: versions.current.pages[id] ?? 0, blocks } });
      versions.current.pages[id] = r.version;
      markSaved((s) => ({ ...s, blocks: { ...s.blocks, [id]: blocks } }));
      setWarnings((w) => [...w.filter((x) => x.pageId !== id), ...r.warnings]);
    }
  }, [slug, markSaved]);

  /** Saves every dirty document now. Resolves false on conflict/error. */
  const flush = useCallback(async (): Promise<boolean> => {
    while (saving.current) await saving.current;
    if (conflictRef.current) return false;
    const run = (async () => {
      const d = docRef.current;
      const parts = dirtyParts(d, savedRef.current);
      if (!parts.length) return true;
      setStatus('saving');
      for (const part of parts) {
        try {
          await savePart(part, d);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) { markConflict(part); setStatus('conflict'); return false; }
          const ref = part === 'brand' ? d.brand : part === 'layout' ? d.layout : d.blocks[part.slice(5)];
          if (ref) failed.current.add(ref);
          setError(e); setStatus('error');
          return false;
        }
      }
      setError(null); setStatus('saved'); setLastSavedAt(new Date());
      return true;
    })();
    saving.current = run;
    try { return await run; } finally { saving.current = null; }
  }, [savePart, markConflict]);

  // Debounced autosave (skips values that already failed validation until they change).
  useEffect(() => {
    if (!dirty.length || conflict) return;
    const pending = dirty.filter((p) => {
      const ref = p === 'brand' ? doc.brand : p === 'layout' ? doc.layout : doc.blocks[p.slice(5)];
      return ref && !failed.current.has(ref);
    });
    if (!pending.length) return;
    const t = setTimeout(() => { void flush(); }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [doc, dirty, conflict, flush]);

  /** Replaces everything with the server's latest draft (discarding unsaved local changes). */
  const reload = useCallback(async () => {
    const s = await api<BuilderState>(`/api/v1/t/${slug}/builder`);
    setServer(s);
    const d = docFromState(s);
    docRef.current = d; pastRef.current = []; futureRef.current = [];
    setDoc(d); markSaved(() => d); syncHist();
    versions.current = versionsFromState(s);
    setWarnings(s.validation.warnings);
    markConflict(null); setError(null); setStatus('idle');
    return s;
  }, [slug, markSaved, markConflict]);

  /** Refreshes server-side info (validation, readiness, catalog, pages) without touching the local draft. */
  const refreshServer = useCallback(async () => {
    const s = await api<BuilderState>(`/api/v1/t/${slug}/builder`);
    setServer(s);
    setWarnings(s.validation.warnings);
    // Pick up pages created/changed elsewhere without losing local edits.
    const merged = { ...docRef.current, blocks: { ...Object.fromEntries(s.pages.map((p) => [p.id, p.blocks])), ...docRef.current.blocks } };
    docRef.current = merged;
    setDoc(merged);
    markSaved((d) => ({ ...d, blocks: { ...Object.fromEntries(s.pages.map((p) => [p.id, p.blocks])), ...d.blocks } }));
    for (const p of s.pages) if (versions.current.pages[p.id] === undefined) versions.current.pages[p.id] = p.version;
    return s;
  }, [slug, markSaved]);

  /** Conflict resolution: adopt the latest server versions and overwrite them with the local draft. */
  const keepMine = useCallback(async () => {
    const s = await api<BuilderState>(`/api/v1/t/${slug}/builder`);
    setServer(s);
    versions.current = versionsFromState(s);
    // Mark everything that differs from the server as dirty so it is re-sent.
    const serverDoc = docFromState(s);
    markSaved(() => serverDoc);
    markConflict(null);
    setStatus('idle');
    return flush();
  }, [slug, flush, markSaved, markConflict]);

  const retry = useCallback(() => { failed.current = new WeakSet(); setError(null); return flush(); }, [flush]);

  /** Registers a page created through the API. */
  const addPage = useCallback((page: { id: string; version: number; blocks: PageBlock[] }) => {
    versions.current.pages[page.id] = page.version;
    const next = { ...docRef.current, blocks: { ...docRef.current.blocks, [page.id]: page.blocks } };
    docRef.current = next;
    setDoc(next);
    markSaved((d) => ({ ...d, blocks: { ...d.blocks, [page.id]: page.blocks } }));
  }, [markSaved]);

  return {
    server, setServer, doc, commit, setBlocks, undo, redo, canUndo: hist.past > 0, canRedo: hist.future > 0,
    dirty, status, error, conflict, lastSavedAt, warnings, flush, reload, refreshServer, keepMine, retry, addPage,
  };
}

export type BuilderApi = ReturnType<typeof useBuilder>;
