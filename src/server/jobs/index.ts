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
