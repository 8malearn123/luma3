import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/server/env';
import { pendingFromToken } from '@/server/domains/platform/mfa';
import { decryptSecret, encryptSecret } from '@/server/domains/platform/totp';

/**
 * Embedded demo (each serverless instance holds its own data copy): the TOTP
 * enrolment's pending secret returns to the client sealed and bound to the user,
 * so the confirming request may reach another instance. Accepted only in that mode.
 */
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetEnvCache();
});
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

describe('sealed pending TOTP secret (embedded multi-instance demo)', () => {
  it('is accepted for the same user only, never tampered, never outside the embedded database', () => {
    process.env.DB_DRIVER = 'pglite';
    resetEnvCache();
    const token = encryptSecret(JSON.stringify({ u: USER, s: 'JBSWY3DPEHPK3PXP' }));
    const enc = pendingFromToken(USER, token);
    expect(enc).not.toBeNull();
    expect(decryptSecret(enc!)).toBe('JBSWY3DPEHPK3PXP');
    expect(pendingFromToken(OTHER, token)).toBeNull();
    const parts = token.split('.');
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith('A') ? 'BB' : 'AA');
    expect(pendingFromToken(USER, parts.join('.'))).toBeNull();
    expect(pendingFromToken(USER, undefined)).toBeNull();

    process.env.DB_DRIVER = 'pg';
    resetEnvCache();
    expect(pendingFromToken(USER, token)).toBeNull();
  });
});
