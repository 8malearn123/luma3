import { registerPeriodic } from '../../jobs/registry';
import { expireStaleHolds } from './service';

/** Holds past their TTL are released exactly once (expireBookings is guarded by status). */
registerPeriodic({ name: 'booking.expire-holds', everySec: 30, run: async () => { await expireStaleHolds(); } });
