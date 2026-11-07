import { registerPeriodic } from '../../jobs/registry';
import { runAttendanceScan } from './deductions';
import { runExpiryAlerts } from './files';

/** Daily: lateness/absence suggestions for the last days, and ID/document expiry alerts (60/30/7 days). */
registerPeriodic({ name: 'hr.attendance-scan', everySec: 6 * 3600, run: async () => { await runAttendanceScan(); } });
registerPeriodic({ name: 'hr.expiry-alerts', everySec: 12 * 3600, run: async () => { await runExpiryAlerts(); } });
