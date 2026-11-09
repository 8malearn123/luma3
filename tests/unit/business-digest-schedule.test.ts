import { describe, expect, it } from 'vitest';
import { digestDue, lastSevenDays, nextDigestAt, stripDigestMoney, type DigestPayload } from '@/server/domains/business/digest';
import { badgeLabel, badgeOf } from '@/shared/badges';
import { cropFromView } from '@/ui/business/CropEditor';
import { clampCrop } from '@/server/domains/assets/service';

const TZ = 'Asia/Riyadh'; // UTC+3, no DST
const S = { enabled: true, weekday: 0, hour: 9 }; // Sunday 09:00

describe('weekly digest schedule', () => {
  it('is due on the chosen local weekday from the chosen hour, for the previous seven days', () => {
    // Sunday 2026-11-08 09:30 Riyadh = 06:30Z
    expect(digestDue(S, TZ, new Date('2026-11-08T06:30:00Z'))).toEqual({ period_start: '2026-11-01', period_end: '2026-11-07' });
    // Sunday 08:59 local → not yet
    expect(digestDue(S, TZ, new Date('2026-11-08T05:59:00Z'))).toBeNull();
    // Saturday 23:30 UTC is already Sunday 02:30 in Riyadh, but before 09:00
    expect(digestDue(S, TZ, new Date('2026-11-07T23:30:00Z'))).toBeNull();
    // Monday → not due
    expect(digestDue(S, TZ, new Date('2026-11-09T07:00:00Z'))).toBeNull();
    // Off
    expect(digestDue({ ...S, enabled: false }, TZ, new Date('2026-11-08T06:30:00Z'))).toBeNull();
  });

  it('uses the business timezone for the day boundary', () => {
    // Thursday 22:00Z = Friday 01:00 Riyadh
    expect(digestDue({ enabled: true, weekday: 5, hour: 1 }, TZ, new Date('2026-11-05T22:00:00Z'))).toEqual({ period_start: '2026-10-30', period_end: '2026-11-05' });
    expect(lastSevenDays(TZ, new Date('2026-11-05T22:00:00Z'))).toEqual({ period_start: '2026-10-30', period_end: '2026-11-05' });
  });

  it('computes the next run', () => {
    expect(nextDigestAt(S, TZ, new Date('2026-11-07T10:00:00Z'))).toBe('2026-11-08T09:00:00.000+03:00');
    expect(nextDigestAt({ ...S, enabled: false }, TZ, new Date())).toBeNull();
  });

  it('strips money for viewers without financial access', () => {
    const p = {
      bookings: { bookings: 3, completed: 2, completed_value_minor: 5000, collections_minor: 4000 }, revenue: { collections_minor: 4000 },
      top_services: [{ service_id: 'a', bookings: 2, value_minor: 3000 }], staff: [{ staff_id: 's', completed: 2, value_minor: 3000 }],
      upcoming: { bookings: 1, expected_value_minor: 900 }, low_stock: [],
    } as unknown as DigestPayload;
    const s = stripDigestMoney(p);
    expect(s.revenue).toBeNull();
    expect(s.top_services[0]!.value_minor).toBeNull();
    expect(s.staff[0]!.value_minor).toBeNull();
    expect(s.upcoming.expected_value_minor).toBeNull();
    expect(s.bookings.bookings).toBe(3);
  });
});

describe('service badges', () => {
  it('maps presets and custom text; incomplete custom badges are dropped', () => {
    expect(badgeLabel(badgeOf({ badge_kind: 'popular' })!, 'ar')).toBe('الأكثر طلباً');
    expect(badgeLabel(badgeOf({ badge_kind: 'new' })!, 'en')).toBe('New');
    expect(badgeLabel(badgeOf({ badge_kind: 'offer' })!, 'ar')).toBe('عرض خاص');
    expect(badgeLabel(badgeOf({ badge_kind: 'custom', badge_text_ar: 'حصري', badge_text_en: null })!, 'en')).toBe('حصري');
    expect(badgeOf({ badge_kind: 'custom' })).toBeNull();
    expect(badgeOf({ badge_kind: null })).toBeNull();
    expect(badgeOf({ badge_kind: 'bogus' })).toBeNull();
  });
});

describe('crop geometry', () => {
  it('maps the editor view to source pixels', () => {
    // 2000x1000 image in a 300x300 frame: cover scale = 0.3; zoom 1, centred (ox = -150).
    expect(cropFromView(2000, 1000, 300, 300, 1, -150, 0)).toEqual({ x: 500, y: 0, width: 1000, height: 1000 });
    // Zoom 2 → half the area.
    const c = cropFromView(2000, 1000, 300, 300, 2, -600, -150);
    expect(c.width).toBeCloseTo(500); expect(c.height).toBeCloseTo(500); expect(c.x).toBeCloseTo(1000); expect(c.y).toBeCloseTo(250);
  });
  it('clamps on the server and treats full-image crops as none', () => {
    expect(clampCrop({ x: -5, y: 10, width: 5000, height: 50 }, 800, 600)).toEqual({ x: 0, y: 10, width: 800, height: 50 });
    expect(clampCrop({ x: 0, y: 0, width: 800, height: 600 }, 800, 600)).toBeNull();
    expect(() => clampCrop({ x: 0, y: 0, width: 2, height: 2 }, 800, 600)).toThrow();
  });
});
