import { route } from '@/server/http/route';
import { withTenant } from '@/server/db/client';
import { hasVatNumber } from '@/server/domains/finance/zatca';

/** Simplified tax invoice (ZATCA phase 1) readiness: a VAT number makes receipts/invoices carry the TLV QR. */
export const GET = route({
  auth: 'tenant', capability: ['business.manage', 'finance.view'],
  handler: async ({ tenant }) => {
    const s = await withTenant(tenant.tenantId, (trx) => trx.selectFrom('tenant_settings').select(['tax_number', 'legal_name', 'tax_rate_bp']).where('tenant_id', '=', tenant.tenantId).executeTakeFirstOrThrow());
    return { data: { vat_configured: hasVatNumber(s.tax_number), legal_name_configured: !!s.legal_name, tax_rate_bp: s.tax_rate_bp, phase: 1, phase2_compliance_claimed: false } };
  },
});
