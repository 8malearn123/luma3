import { registerPeriodic } from '../../jobs/registry';
import { abandonStaleCarts, expireStaleOrders } from './orders';
import { runStockBalanceCheck } from './integrity';

/** Unpaid orders past their payment window are cancelled and their stock released (exactly once). */
registerPeriodic({ name: 'commerce-expire-orders', everySec: 60, run: async () => { await expireStaleOrders(); } });

/** Open carts idle past expires_at (7 days after last activity) are marked abandoned. */
registerPeriodic({ name: 'commerce-abandon-carts', everySec: 3600, run: abandonStaleCarts });

/** Stock cache vs movement ledger vs open reservations; mismatches alert inventory managers daily. */
registerPeriodic({ name: 'commerce-stock-balance', everySec: 6 * 3600, run: async () => { await runStockBalanceCheck(); } });
