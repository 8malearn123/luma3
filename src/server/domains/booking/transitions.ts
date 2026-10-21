import type { Capability } from '../../auth/capabilities';

/**
 * Booking lifecycle (spec §18). The server-side table below is the only way a
 * booking changes state. Service state and financial state are separate
 * (bookings.status vs bookings.payment_status).
 *
 *   draft → held → pending_payment → confirmed → checked_in → in_service → completed
 *               ↘ pending_approval ↗        ↘ no_show (after start + grace)
 *   held / pending_payment → expired         any active → cancelled
 */
export type BookingStatus = 'draft' | 'held' | 'pending_approval' | 'pending_payment' | 'confirmed' | 'checked_in' | 'in_service' | 'completed' | 'expired' | 'cancelled' | 'no_show';
export type BookingAction = 'approve' | 'reject' | 'check_in' | 'start' | 'complete' | 'no_show' | 'cancel' | 'expire';

export type ActorKind = 'staff' | 'customer' | 'system';

export type TransitionRule = {
  from: BookingStatus[];
  to: BookingStatus;
  /** Staff capabilities (any). 'assigned' variants require the actor to be the assigned specialist. */
  staffCaps: Capability[];
  assignedCaps?: Capability[];
  customer: boolean;
  system: boolean;
  /** Guards evaluated by the service with the booking + settings + clock. */
  guards: Array<'not_before_start_plus_grace' | 'customer_before_start' | 'within_service_day' | 'reason_required'>;
  releasesAllocations: boolean;
};

export const TRANSITIONS: Record<BookingAction, TransitionRule> = {
  approve: { from: ['pending_approval'], to: 'confirmed', staffCaps: ['bookings.manage'], customer: false, system: false, guards: [], releasesAllocations: false },
  reject: { from: ['pending_approval'], to: 'cancelled', staffCaps: ['bookings.manage'], customer: false, system: false, guards: ['reason_required'], releasesAllocations: true },
  check_in: { from: ['confirmed'], to: 'checked_in', staffCaps: ['bookings.manage'], assignedCaps: ['bookings.manage_assigned'], customer: false, system: false, guards: ['within_service_day'], releasesAllocations: false },
  start: { from: ['confirmed', 'checked_in'], to: 'in_service', staffCaps: ['bookings.manage'], assignedCaps: ['bookings.manage_assigned'], customer: false, system: false, guards: ['within_service_day'], releasesAllocations: false },
  complete: { from: ['checked_in', 'in_service'], to: 'completed', staffCaps: ['bookings.manage'], assignedCaps: ['bookings.manage_assigned'], customer: false, system: false, guards: [], releasesAllocations: false },
  no_show: { from: ['confirmed'], to: 'no_show', staffCaps: ['bookings.manage'], assignedCaps: ['bookings.manage_assigned'], customer: false, system: false, guards: ['not_before_start_plus_grace'], releasesAllocations: true },
  cancel: { from: ['held', 'pending_approval', 'pending_payment', 'confirmed', 'checked_in'], to: 'cancelled', staffCaps: ['bookings.manage'], customer: true, system: true, guards: ['customer_before_start', 'reason_required'], releasesAllocations: true },
  expire: { from: ['held', 'pending_payment'], to: 'expired', staffCaps: [], customer: false, system: true, guards: [], releasesAllocations: true },
};

export const ACTIVE_STATUSES: BookingStatus[] = ['held', 'pending_approval', 'pending_payment', 'confirmed', 'checked_in', 'in_service'];
export const TERMINAL_STATUSES: BookingStatus[] = ['completed', 'expired', 'cancelled', 'no_show'];

/** Which actions the UI may offer for a booking in a given status (server still re-checks). */
export function actionsFor(status: BookingStatus): BookingAction[] {
  return (Object.keys(TRANSITIONS) as BookingAction[]).filter((a) => a !== 'expire' && TRANSITIONS[a].from.includes(status));
}
