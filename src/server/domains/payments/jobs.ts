import { withSystem } from '../../db/client';
import { registerPeriodic } from '../../jobs/registry';
import { reconcileTenant } from './service';

/** Daily reconciliation of provider records vs LUMA payments for tenants with recent payments. */
registerPeriodic({
  name: 'payments.reconcile',
  everySec: 6 * 3600,
  run: async () => {
    const tenants = await withSystem('find tenants with recent payments', (trx) => trx.selectFrom('payments').select('tenant_id').distinct()
      .where('created_at', '>', new Date(Date.now() - 2 * 86_400_000)).where('provider', '<>', 'on_site').execute());
    for (const t of tenants) await reconcileTenant(t.tenant_id);
  },
});
