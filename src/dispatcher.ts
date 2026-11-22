import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from './context.ts'

const MAX_ATTEMPTS = 20
const BATCH = 10

/** Stripe-style signature: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`. */
export function signPayload(secret: string, body: string, timestamp: number): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${mac}`
}

/** Reference verifier for receivers; rejects signatures older than `toleranceSeconds`. */
export function verifySignature(secret: string, body: string, header: string, toleranceSeconds = 300): boolean {
  const parts = Object.fromEntries(header.split(',').map((part) => part.split('=') as [string, string]))
  const timestamp = Number(parts.t)
  if (!Number.isFinite(timestamp) || !parts.v1) return false
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false
  const expected = Buffer.from(signPayload(secret, body, timestamp).split('v1=')[1]!, 'hex')
  const given = Buffer.from(parts.v1, 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

function backoffSeconds(attempts: number): number {
  return Math.min(15 * 2 ** attempts, 6 * 3600)
}

/** Delivers due webhooks. Returns how many were attempted. */
export async function dispatchTick(ctx: Context): Promise<number> {
  const { webhookUrl, webhookSecret } = ctx.config
  if (!webhookUrl || !webhookSecret) throw new Error('WEBHOOK_URL and WEBHOOK_SECRET are required')
  return ctx.sql.begin(async (tx) => {
    // SKIP LOCKED lets several dispatchers run without double-sending.
    const due = await tx<{ id: string; payload: unknown; attempts: number }[]>`
      select id, payload, attempts from webhook_deliveries
      where delivered_at is null and attempts < ${MAX_ATTEMPTS} and next_attempt_at <= now()
      order by created_at limit ${BATCH} for update skip locked`
    for (const delivery of due) {
      const body = JSON.stringify(delivery.payload)
      let error: string | undefined
      try {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-aquipay-signature': signPayload(webhookSecret, body, Math.floor(Date.now() / 1000)),
            'x-aquipay-event-id': delivery.id,
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) error = `HTTP ${response.status}`
      } catch (err) {
        error = String(err)
      }
      if (error) {
        const attempts = delivery.attempts + 1
        await tx`update webhook_deliveries
                 set attempts = ${attempts}, last_error = ${error},
                     next_attempt_at = now() + make_interval(secs => ${backoffSeconds(attempts)})
                 where id = ${delivery.id}`
        ctx.log.warn({ eventId: delivery.id, attempts, error }, 'webhook delivery failed')
      } else {
        await tx`update webhook_deliveries
                 set attempts = attempts + 1, delivered_at = now(), last_error = null
                 where id = ${delivery.id}`
        ctx.log.info({ eventId: delivery.id }, 'webhook delivered')
      }
    }
    return due.length
  })
}
