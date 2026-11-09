'use client';

import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { useI18n } from '@/i18n/client';
import { useApiQuery } from '../hooks';
import { useAccess } from '../shell/access-context';

type Data = { branches: Array<{ id: string; name: string; city: string | null; is_primary: boolean }>; selected: string | null; restricted: boolean; allow_all: boolean };

export const branchCookie = (slug: string) => `luma_branch_${slug}`;

/**
 * Header branch switcher: one branch or «كل الفروع». The choice is stored per
 * user and business in a cookie the read APIs honour (bookings, team,
 * finance, inventory, analytics, overview); every query is refetched on change.
 * Staff assigned to a branch only see their own branch(es).
 */
export function BranchSwitcher() {
  const { t } = useI18n();
  const access = useAccess();
  const qc = useQueryClient();
  const router = useRouter();
  const q = useApiQuery<Data>(['branch-scope', access.slug], access.api('/branch-scope'));
  const d = q.data;
  if (!d || d.branches.length === 0) return null;
  if (d.branches.length === 1 && !d.restricted) return null;
  if (d.branches.length === 1) {
    return <span className="hidden items-center gap-1 text-xs text-ink-muted sm:inline-flex"><MapPin className="size-3.5" aria-hidden />{d.branches[0]!.name}</span>;
  }
  const change = (v: string) => {
    document.cookie = `${branchCookie(access.slug)}=${v}; path=/; max-age=31536000; samesite=lax`;
    void qc.invalidateQueries();
    router.refresh();
  };
  return (
    <label className="inline-flex items-center gap-1 text-sm">
      <MapPin className="size-4 text-luma-500" aria-hidden />
      <span className="sr-only">{t('business.branch.label')}</span>
      <select value={d.selected ?? 'all'} onChange={(e) => change(e.target.value)} data-testid="branch-switcher"
        className="h-8 max-w-[11rem] rounded-lg border border-line bg-white px-2 text-sm">
        {d.allow_all ? <option value="all">{d.restricted ? t('business.branch.all_mine') : t('business.branch.all')}</option> : null}
        {d.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </label>
  );
}
