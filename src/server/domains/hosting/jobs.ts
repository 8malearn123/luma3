import { registerPeriodic } from '../../jobs/registry';
import { expireLapsed } from './bookings';
import { hostingTx } from './scope';

/**
 * hosting.expire: unanswered approval requests (2h, D1c) and unpaid holds
 * expire and free the chair. Also applied lazily before every action.
 */
registerPeriodic({
  name: 'hosting.expire',
  everySec: 60,
  run: async () => {
    await hostingTx('sweep lapsed space holds', (trx) => expireLapsed(trx, new Date()));
  },
});
