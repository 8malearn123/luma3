'use client';

import { useState } from 'react';
import { useI18n } from '@/i18n/client';
import { api } from '../api';
import { useApiMutation, useErrorMessage } from '../hooks';
import { Button } from '../components/button';
import { Field, FormErrorSummary, Input, MoneyInput, Select } from '../components/form';
import { Dialog } from '../components/overlay';
import { useAccess } from '../shell/access-context';

/** Records a tip for one of the staff members who served a booking. Tips go 100% to her payroll. */
export function TipDialog({ bookingId, staff, onClose, onDone }: { bookingId: string; staff: Array<{ id: string; name: string }>; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n();
  const access = useAccess();
  const msg = useErrorMessage();
  const [staffId, setStaffId] = useState(staff[0]?.id ?? '');
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<'cash' | 'pos_terminal'>('cash');
  const [note, setNote] = useState('');
  const m = useApiMutation(() => api(access.api('/payroll/tips'), { body: { booking_id: bookingId, staff_id: staffId, amount_minor: amount, method, note: note.trim() || undefined } }), { onSuccess: () => onDone() });
  const ok = !!staffId && (amount ?? 0) > 0;
  return (
    <Dialog open onClose={onClose} title={t('payroll.tip.title')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('actions.cancel')}</Button>
      <Button loading={m.isPending} disabled={!ok} onClick={() => m.mutate(undefined)}>{t('actions.save')}</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <FormErrorSummary message={m.error ? msg(m.error) : null} />
        <p className="text-sm text-ink-muted">{t('payroll.tip.hint')}</p>
        <Field label={t('payroll.fields.staff')} required>{(p) => (
          <Select {...p} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        )}</Field>
        <Field label={t('payroll.fields.amount')} required>{(p) => <MoneyInput {...p} value={amount} onChange={setAmount} />}</Field>
        <Field label={t('booking.dashboard.method')} required>{(p) => (
          <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'pos_terminal')}>
            <option value="cash">{t('booking.dashboard.cash')}</option>
            <option value="pos_terminal">{t('booking.dashboard.pos')}</option>
          </Select>
        )}</Field>
        <Field label={t('fields.notes')} hint={t('fields.optional')}>{(p) => <Input {...p} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}
