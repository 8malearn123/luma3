'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { ClientAccess } from '@/server/pages';

const Ctx = createContext<ClientAccess | null>(null);

export function AccessProvider({ access, children }: { access: ClientAccess; children: ReactNode }) {
  return <Ctx.Provider value={access}>{children}</Ctx.Provider>;
}

/** Tenant access for client components. UI hiding is convenience only — the server enforces. */
export function useAccess() {
  const a = useContext(Ctx);
  if (!a) throw new Error('useAccess outside AccessProvider');
  return {
    ...a,
    can: (...caps: string[]) => caps.some((c) => a.capabilities.includes(c)),
    hasFeature: (f: string) => !!a.plan.features[f]?.enabled,
    api: (path: string) => `/api/v1/t/${a.slug}${path}`,
  };
}
