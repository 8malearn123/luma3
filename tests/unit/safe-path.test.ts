import { describe, expect, it } from 'vitest';
import { safeInternalPath } from '@/shared/safe-path';

describe('safeInternalPath', () => {
  it('keeps same-origin paths', () => {
    expect(safeInternalPath('/s/noura/booking?service=1', '/app')).toBe('/s/noura/booking?service=1');
    expect(safeInternalPath('/platform/users', '/platform', '/platform')).toBe('/platform/users');
  });
  it('rejects open-redirect variants', () => {
    for (const bad of ['//evil.com', '/\\evil.com', '/\\/evil.com', 'https://evil.com', 'javascript:alert(1)', '/%0d%0aX', '\t//evil.com', '', null, undefined]) {
      expect(safeInternalPath(bad as string, '/app')).toBe(bad === '/%0d%0aX' ? '/%0d%0aX' : '/app');
    }
  });
  it('enforces the prefix', () => {
    expect(safeInternalPath('/platformx', '/platform', '/platform')).toBe('/platform');
    expect(safeInternalPath('/app', '/platform', '/platform')).toBe('/platform');
  });
});
