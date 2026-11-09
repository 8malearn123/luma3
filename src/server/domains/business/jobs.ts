import { registerPeriodic } from '../../jobs/registry';
import { runDueDigests } from './digest';

/** Weekly owner digest: checked every 15 minutes; each tenant gets one per week at its chosen local day/hour. */
registerPeriodic({ name: 'business.weekly-digest', everySec: 900, run: async () => { await runDueDigests(); } });
