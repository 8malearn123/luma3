import { registerPeriodic } from '../../jobs/registry';
import { abandonStaleCarts, expireStaleOrders } from './orders';

/** Unpaid orders past their payment window are cancelled and their stock released (exactly once). */
registerPeriodic({ name: 'commerce-expire-orders', everySec: 60, run: async () => { await expireStaleOrders(); } });

/** Open carts idle past expires_at (7 days after last activity) are marked abandoned. */
registerPeriodic({ name: 'commerce-abandon-carts', everySec: 3600, run: abandonStaleCarts });
