'use client';

import { useI18n } from '@/i18n/client';
import { useFmt } from '../commerce/common';

export type Statement = {
  currency: string; rent_minor: number; salon_percentage: { enabled: boolean; amount_minor: number }; products_minor: number; equipment_minor: number; discounts_minor: number;
  late_fees_minor: number; late_fees_proposed_minor: number; corrections_minor: number; tax_minor: number; tax_included: boolean; total_charges_minor: number;
  collected_minor: number; refunded_minor: number; due_from_guest_minor: number; credit_to_guest_minor: number;
  platform_fee: { enabled: boolean; bp: number; amount_minor: number }; host_net_minor: number;
  lines: Array<{ id: string; kind: string; status: string; description: string; quantity: number; unit_price_minor: number; amount_minor: number }>;
};

export const TONE: Record<string, 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'brand'> = {
  pending_approval: 'warn', held: 'warn', pending_payment: 'warn', confirmed: 'ok', checked_in: 'info', in_use: 'info', completed: 'brand',
  cancelled: 'danger', expired: 'neutral', no_show: 'danger', requested: 'neutral', draft: 'neutral',
};

/** The per-booking settlement statement — the same numbers for the salon and the expert. */
export function StatementTable({ s, as = 'host' }: { s: Statement; as?: 'host' | 'guest' }) {
  const { t } = useI18n();
  const { money } = useFmt();
  const rows: Array<[string, number, boolean?]> = [
    ['rent', s.rent_minor], ['salon_percentage', s.salon_percentage.amount_minor], ['products', s.products_minor], ['equipment', s.equipment_minor],
    ['discounts', -s.discounts_minor], ['late_fees', s.late_fees_minor], ['corrections', s.corrections_minor], ['tax', s.tax_minor],
    ['total', s.total_charges_minor, true], ['collected', s.collected_minor], ['refunded', s.refunded_minor], ['due', s.due_from_guest_minor, true],
    ['credit', s.credit_to_guest_minor], ['platform_fee', s.platform_fee.amount_minor],
  ];
  if (as === 'host') rows.push(['host_net', s.host_net_minor, true]);
  return (
    <table className="w-full text-sm">
      <tbody>
        {rows.filter(([k, v]) => v !== 0 || ['total', 'due', 'collected', 'rent'].includes(k)).map(([k, v, strong]) => (
          <tr key={k} className="border-b border-line last:border-0">
            <th scope="row" className={`py-1.5 text-start font-normal ${strong ? 'font-semibold' : 'text-ink-muted'}`}>{t(`hosting.statement.${k}`)}</th>
            <td className={`py-1.5 text-end ${strong ? 'font-semibold' : ''}`} dir="ltr">{money(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
