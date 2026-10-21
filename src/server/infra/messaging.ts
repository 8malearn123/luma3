import { env } from '../env';
import { db, withSystem, withTenant, type Tx } from '../db/client';
import { maskDestination } from '../auth/crypto';

export type Channel = 'email' | 'sms' | 'whatsapp';

export type DeliveryResult =
  /** A real provider accepted the message. */
  | { status: 'sent'; provider: string; providerRef?: string }
  /** Development only: nothing left the server; the content is in the dev outbox. */
  | { status: 'simulated'; provider: 'dev-outbox' }
  /** No provider is configured for this channel. Nothing was sent. */
  | { status: 'unavailable'; reason: 'no_provider' };

export interface MessageProvider {
  readonly name: string;
  readonly channel: Channel;
  send(msg: { to: string; subject?: string; body: string }): Promise<{ providerRef?: string }>;
}

/**
 * Provider registry. No live email/SMS/WhatsApp provider is connected in this
 * delivery (no credentials were provided), so every channel resolves to "none".
 * A real provider implements MessageProvider and is registered here.
 */
function providerFor(channel: Channel): MessageProvider | null {
  const e = env();
  const configured = channel === 'email' ? e.EMAIL_PROVIDER : channel === 'sms' ? e.SMS_PROVIDER : e.WHATSAPP_PROVIDER;
  if (configured === 'none') return null;
  return null;
}

export function channelStatus(channel: Channel): 'connected' | 'dev_simulation' | 'disconnected' {
  if (providerFor(channel)) return 'connected';
  return env().devOtpEcho ? 'dev_simulation' : 'disconnected';
}

/**
 * Sends a transactional message (verification codes, receipts). Never claims a
 * message was sent unless a provider accepted it.
 */
export async function sendTransactional(opts: {
  channel: Channel;
  to: string;
  subject?: string;
  body: string;
  templateKey: string;
  locale?: 'ar' | 'en';
  tenantId?: string | null;
  dedupeKey?: string;
}): Promise<DeliveryResult> {
  const provider = providerFor(opts.channel);
  let result: DeliveryResult;
  if (provider) {
    const r = await provider.send({ to: opts.to, subject: opts.subject, body: opts.body });
    result = { status: 'sent', provider: provider.name, providerRef: r.providerRef };
  } else if (env().devOtpEcho) {
    await db().insertInto('dev_message_outbox').values({ destination: opts.to, channel: opts.channel, subject: opts.subject ?? null, body: opts.body }).execute();
    result = { status: 'simulated', provider: 'dev-outbox' };
  } else {
    result = { status: 'unavailable', reason: 'no_provider' };
  }

  const record = (trx: Tx) => trx
    .insertInto('notification_deliveries')
    .values({
      tenant_id: opts.tenantId ?? null,
      channel: opts.channel,
      destination_masked: maskDestination(opts.to),
      template_key: opts.templateKey,
      locale: opts.locale ?? 'ar',
      status: result.status === 'sent' ? 'sent' : result.status === 'simulated' ? 'simulated' : 'failed',
      provider: result.status === 'sent' ? result.provider : result.status === 'simulated' ? 'dev-outbox' : 'none',
      provider_ref: result.status === 'sent' ? (result.providerRef ?? null) : null,
      error: result.status === 'unavailable' ? 'no_provider_configured' : null,
      dedupe_key: opts.dedupeKey ?? null,
      attempts: 1,
    })
    .onConflict((oc) => oc.column('dedupe_key').doNothing())
    .execute();
  if (opts.tenantId) await withTenant(opts.tenantId, record);
  else await withSystem('record platform-level message delivery', record);
  return result;
}
