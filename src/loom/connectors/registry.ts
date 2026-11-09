import type { LoomConnector } from '../contracts/connector';
import { LumaConnector } from './luma';

/** Connector registry. A new connector registers its kind here (docs/LOOM_CORE.md "Adding a connector"). */
const connectors = new Map<string, LoomConnector>([['luma', new LumaConnector()]]);

export function registerConnector(c: LoomConnector) { connectors.set(c.kind, c); }
export function connectorFor(kind: string): LoomConnector {
  const c = connectors.get(kind);
  if (!c) throw new Error(`unknown loom connector: ${kind}`);
  return c;
}
