import { registerPeriodic } from '../../jobs/registry';
import { maintainUsageCounters, runSubscriptionLifecycle } from './service';

/**
 * Subscription lifecycle (trial end → past_due with grace → expired; period
 * roll-over in test mode; scheduled cancellations) and usage counters /
 * overage-state refresh. Support-grant expiry needs no job: grants are checked
 * against expires_at on every request.
 */
registerPeriodic({ name: 'subscriptions-lifecycle', everySec: 300, run: async () => { await runSubscriptionLifecycle(); } });
registerPeriodic({ name: 'subscriptions-usage-counters', everySec: 3600, run: async () => { await maintainUsageCounters(); } });
