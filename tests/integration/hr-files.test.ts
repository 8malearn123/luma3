import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { makeSalon } from '../helpers/salon';
import { callForm, dayOffset, member, userId } from '../helpers/hr';
import { withTenant } from '@/server/db/client';
import { runExpiryAlerts } from '@/server/domains/hr/files';
import * as files from '@/app/api/v1/t/[tenantSlug]/hr/staff-files/route';
import * as file from '@/app/api/v1/t/[tenantSlug]/hr/staff-files/[staffId]/route';
import * as reveal from '@/app/api/v1/t/[tenantSlug]/hr/staff-files/[staffId]/reveal/route';
import * as docs from '@/app/api/v1/t/[tenantSlug]/hr/staff-files/[staffId]/documents/route';
import * as doc from '@/app/api/v1/t/[tenantSlug]/hr/staff-files/[staffId]/documents/[docId]/route';
import * as meHr from '@/app/api/v1/t/[tenantSlug]/me/hr/route';
import * as invitations from '@/app/api/v1/t/[tenantSlug]/invitations/route';
import { signup } from '../helpers/factory';

describe('staff file (owner only)', () => {
  it('stores the file with a masked ID (audited reveal), private documents, and shows staff only their own non-sensitive fields', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    const fp = { ...p, staffId: s.staff.sara };
    const put = await s.owner.call(file.PUT, {
      method: 'PUT', params: fp, body: {
        employee_number: 'E-001', nationality: 'سعودية', residence: 'الرياض — حي النرجس', id_type: 'iqama', id_number: '2123456789',
        id_expiry: dayOffset(25), hire_date: '2024-03-01', admin_notes: 'ملاحظة إدارية سرية',
      },
    });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ employee_number: 'E-001', id_number_masked: '••••••6789', has_id_number: true, hire_date: '2024-03-01', admin_notes: 'ملاحظة إدارية سرية' });
    expect(JSON.stringify(put.body.data)).not.toContain('2123456789');
    expect((await s.owner.call(file.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.huda }, body: { employee_number: 'E-001' } })).body.error.code).toBe('employee_number_taken');
    expect((await s.owner.call(files.GET, { params: p })).body.data.find((r: any) => r.staff_id === s.staff.sara)).toMatchObject({ employee_number: 'E-001', id_expiry: dayOffset(25), hire_date: '2024-03-01' });

    const shown = await s.owner.call(reveal.POST, { params: fp, body: {} });
    expect(shown.body.data).toEqual({ id_type: 'iqama', id_number: '2123456789' });
    const audits = await withTenant(s.tenantId, (trx) => trx.selectFrom('audit_logs').select(['action', 'data']).where('action', 'in', ['hr.staff_id_revealed', 'hr.staff_file_updated']).execute());
    expect(audits.map((a) => a.action).sort()).toEqual(['hr.staff_file_updated', 'hr.staff_id_revealed']);
    expect(JSON.stringify(audits)).not.toContain('2123456789');

    // Documents: PDF kept as is, images re-encoded; private download.
    const pdf = Buffer.from('%PDF-1.4\n% test\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    const f1 = new FormData();
    f1.set('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'iqama.pdf');
    f1.set('title', 'صورة الإقامة');
    f1.set('expires_on', dayOffset(5));
    const up = await callForm(s.owner, docs.POST, fp, f1);
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({ title: 'صورة الإقامة', mime: 'application/pdf', expires_on: dayOffset(5) });
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#7c3aed' } }).png().toBuffer();
    const f2 = new FormData();
    f2.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'contract.png');
    f2.set('title', 'العقد');
    expect((await callForm(s.owner, docs.POST, fp, f2)).body.data.mime).toBe('image/webp');
    const f3 = new FormData();
    f3.set('file', new Blob(['<script>alert(1)</script>'], { type: 'application/pdf' }), 'x.pdf');
    f3.set('title', 'bad');
    expect((await callForm(s.owner, docs.POST, fp, f3)).body.error.code).toBe('unsupported_file');
    const dl = await s.owner.call(doc.GET, { params: { ...fp, docId: up.body.data.id } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/pdf');
    expect(String(dl.body)).toContain('%PDF-1.4');
    const full = (await s.owner.call(file.GET, { params: fp })).body.data;
    expect(full.documents).toHaveLength(2);

    // Nobody but the owner: not managers (not even by delegation), finance, reception or the staff member herself.
    const bad = await signup('Manager');
    const inv = await s.owner.call(invitations.POST, { params: p, body: { identifier: bad.identifier, role: 'manager', granted_capabilities: ['staff_file.manage'] } });
    expect(inv.body.error.code).toBe('capability_not_delegable');
    const manager = await member(s, 'manager', undefined, ['team.manage', 'staff.edit']);
    const fin = await member(s, 'finance');
    const sara = await member(s, 'specialist', s.staff.sara);
    for (const c of [manager, fin, sara]) {
      expect((await c.call(file.GET, { params: fp })).status).toBe(403);
      expect((await c.call(files.GET, { params: p })).status).toBe(403);
      expect((await c.call(reveal.POST, { params: fp, body: {} })).status).toBe(403);
      expect((await c.call(doc.GET, { params: { ...fp, docId: up.body.data.id } })).status).toBe(403);
      expect((await callForm(c, docs.POST, fp, f1)).status).toBe(403);
    }

    // The staff member sees her own non-sensitive fields only.
    const own = (await sara.call(meHr.GET, { params: p })).body.data.file;
    expect(own).toMatchObject({ employee_number: 'E-001', nationality: 'سعودية', id_type: 'iqama', id_expiry: dayOffset(25), hire_date: '2024-03-01' });
    expect(own).not.toHaveProperty('id_number');
    expect(own).not.toHaveProperty('admin_notes');
    expect(own).not.toHaveProperty('residence');
    expect(own.documents.map((d: any) => Object.keys(d).sort())).toEqual([['expires_on', 'id', 'title'], ['expires_on', 'id', 'title']]);
    const hudaUser = await member(s, 'specialist', s.staff.huda);
    expect((await hudaUser.call(meHr.GET, { params: p })).body.data.file).toMatchObject({ employee_number: null, documents: [] });

    // Delete a document.
    expect((await s.owner.call(doc.DELETE, { method: 'DELETE', params: { ...fp, docId: up.body.data.id } })).status).toBe(200);
    expect((await s.owner.call(doc.GET, { params: { ...fp, docId: up.body.data.id } })).status).toBe(404);
  });

  it('alerts the owner 60, 30 and 7 days before an iqama or document expires, once per threshold', async () => {
    const s = await makeSalon();
    const p = { tenantSlug: s.slug };
    await s.owner.call(file.PUT, { method: 'PUT', params: { ...p, staffId: s.staff.sara }, body: { id_type: 'iqama', id_number: '2123456789', id_expiry: dayOffset(25) } });
    const pdf = new FormData();
    pdf.set('file', new Blob([new Uint8Array(Buffer.from('%PDF-1.4\n%%EOF\n'))], { type: 'application/pdf' }), 'p.pdf');
    pdf.set('title', 'شهادة صحية');
    pdf.set('expires_on', dayOffset(5));
    expect((await callForm(s.owner, docs.POST, { ...p, staffId: s.staff.huda }, pdf)).status).toBe(201);
    const far = new FormData();
    far.set('file', new Blob([new Uint8Array(Buffer.from('%PDF-1.4\n%%EOF\n'))], { type: 'application/pdf' }), 'p.pdf');
    far.set('title', 'رخصة');
    far.set('expires_on', dayOffset(200));
    await callForm(s.owner, docs.POST, { ...p, staffId: s.staff.huda }, far);
    const sara = await member(s, 'specialist', s.staff.sara);

    await runExpiryAlerts();
    await runExpiryAlerts();
    const owner = await userId(s.owner);
    const notes = await withTenant(s.tenantId, (trx) => trx.selectFrom('notifications').select(['user_id', 'title_ar', 'data']).where('kind', '=', 'hr.document_expiring').execute());
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.user_id === owner)).toBe(true);
    expect(notes.map((n) => (n.data as any).threshold).sort()).toEqual([30, 7]);
    expect(notes.some((n) => n.title_ar.includes('الإقامة'))).toBe(true);
    const saraId = await userId(sara);
    expect(notes.some((n) => n.user_id === saraId)).toBe(false);
  });
});
