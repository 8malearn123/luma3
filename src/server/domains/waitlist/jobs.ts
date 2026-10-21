import { registerPeriodic } from '../../jobs/registry';
import { expireOffers } from './service';

registerPeriodic({ name: 'waitlist.expire-offers', everySec: 60, run: async () => { await expireOffers(); } });
