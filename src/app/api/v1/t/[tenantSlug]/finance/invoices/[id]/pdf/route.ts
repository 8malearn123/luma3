import { route } from '@/server/http/route';
import { requireUuidParam } from '@/server/http/params';
import { getInvoice } from '@/server/domains/finance/service';
import { invoiceHtml } from '@/server/domains/finance/documents';
import { renderPdf } from '@/server/infra/pdf';

/** GET ?format=html (print view) | pdf (default). Tenant-scoped, authorised download. */
export const GET = route({
  auth: 'tenant', capability: ['finance.view', 'payments.collect'],
  handler: async ({ tenant, params, req, locale }) => {
    const inv = await getInvoice(tenant.tenantId, requireUuidParam(params, 'id'));
    const html = invoiceHtml(inv, locale);
    if (req.nextUrl.searchParams.get('format') === 'html') return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store' } });
    const pdf = await renderPdf(html);
    return new Response(new Uint8Array(pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${inv.number}.pdf"`, 'Cache-Control': 'private, no-store' } });
  },
});
