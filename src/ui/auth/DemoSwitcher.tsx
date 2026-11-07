'use client';

import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiQuery, useErrorMessage } from '../hooks';

type DemoUser = { key: string; label: string; role: string };

const PLATFORM_ROLES = new Set(['platform_owner', 'support_admin', 'policy_reviewer', 'technical_admin']);
const groupOf = (role: string) => (PLATFORM_ROLES.has(role) ? 'platform' : role === 'customer' ? 'customer' : 'business');

/**
 * PRIVATE DEMO ONLY: one-click sign-in as seeded demo identities, grouped by
 * kind of user (platform staff, business teams, customers). The server route
 * returns 404 unless DEMO_MODE is on and APP_ENV is not production, and it only
 * accepts users flagged is_demo.
 */
export function DemoSwitcher({ next }: { next: string }) {
  const { t } = useI18n();
  const msg = useErrorMessage();
  const q = useApiQuery<DemoUser[]>(['demo-users'], '/api/v1/demo/users');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!q.data?.length) return null;
  const roleLabel = (role: string) => (PLATFORM_ROLES.has(role) ? t(`platform.roles.${role}`) : role === 'customer' ? t('auth.demo_role_customer') : t(`roles.${role}`));
  const groups = (['platform', 'business', 'customer'] as const)
    .map((g) => ({ g, users: q.data!.filter((u) => groupOf(u.role) === g) }))
    .filter((x) => x.users.length);
  return (
    <div className="mt-6 rounded-xl border border-dashed border-luma-300 bg-luma-50 p-3">
      <p className="text-sm font-semibold text-luma-800">{t('auth.demo_title')}</p>
      <p className="mb-2 text-xs text-ink-muted">{t('auth.demo_hint')}</p>
      {err ? <p className="mb-2 text-xs text-danger">{msg(err)}</p> : null}
      <div className="flex flex-col gap-3">
        {groups.map(({ g, users }) => (
          <div key={g}>
            <p className="mb-1 text-xs font-semibold text-ink-muted">{t(`auth.demo_group_${g}`)}</p>
            <div className="flex flex-wrap gap-1.5">
              {users.map((u) => (
                <button key={u.key} type="button" disabled={busy !== null}
                  className="rounded-full border border-luma-300 bg-white px-3 py-1 text-start text-xs hover:bg-luma-100 disabled:opacity-60"
                  onClick={async () => {
                    setBusy(u.key); setErr(null);
                    try { const r = await api<{ redirect: string }>('/api/v1/demo/sign-in', { body: { key: u.key } }); window.location.href = r.redirect || next; }
                    catch (e) { setErr(e); setBusy(null); }
                  }}>
                  <span className="font-medium">{u.label}</span>
                  <span className="ms-1 text-ink-muted">· {roleLabel(u.role)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
