import { registerPeriodic } from '../../jobs/registry';
import { deliverDueGiftCards } from './online';

/** Online gift cards: send to the recipient at the time the buyer chose (every minute). */
registerPeriodic({ name: 'giftcards.deliver-scheduled', everySec: 60, run: async () => { await deliverDueGiftCards(); } });
