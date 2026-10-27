/**
 * Imports every domain's job/outbox/periodic registrations.
 * Each domain adds exactly one line here.
 */
import '../boot';
import './maintenance';
import '../domains/booking/jobs';
import '../domains/payments/jobs';
import '../domains/waitlist/jobs';
import '../domains/engagement/jobs';
import '../domains/notifications/jobs';
import '../domains/commerce/jobs';
import '../domains/finance/jobs';
import '../domains/policy/jobs';
import '../domains/subscriptions/jobs';
import '../domains/analytics/jobs';
import '../domains/marketing/jobs';
