// Minimal AquiPay webhook receiver, using only Node built-ins.
// Run: AQUIPAY_WEBHOOK_SECRET=... node examples/webhook-receiver.ts
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const SECRET = process.env.AQUIPAY_WEBHOOK_SECRET
if (!SECRET) throw new Error('Set AQUIPAY_WEBHOOK_SECRET to the gateway WEBHOOK_SECRET')
const PORT = Number(process.env.PORT ?? 3000)
const TOLERANCE_SECONDS = 300

interface TopupEvent {
  id: string
  type: 'topup.confirmed'
  created_at: string
  data: {
    invoice_id: string
    reference: string
    metadata: Record<string, unknown>
    chain: string
    chain_id: number
    currency: 'USDT'
    amount: string
    transfers: { tx_hash: string; log_index: number; from: string; amount: string }[]
  }
}

/** Header format: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. */
function isAuthentic(rawBody: string, header: string | undefined): boolean {
  const parts = Object.fromEntries((header ?? '').split(',').map((part) => part.split('=')))
  const timestamp = Number(parts.t)
  if (!Number.isFinite(timestamp) || typeof parts.v1 !== 'string') return false
  // Reject old signatures so a captured request cannot be replayed later.
  if (Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) return false
  const expected = createHmac('sha256', SECRET!).update(`${timestamp}.${rawBody}`).digest()
  const given = Buffer.from(parts.v1, 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

// Stand-in for your database. In production, store the event id under a unique
// constraint in the same transaction that credits the balance.
const processed = new Set<string>()

function creditTopup(event: TopupEvent): void {
  console.log(`credit ${event.data.amount} USDT to ${event.data.reference} (event ${event.id})`)
}

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhooks/aquipay') {
    res.writeHead(404).end()
    return
  }
  let rawBody = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => (rawBody += chunk))
  req.on('end', () => {
    // Verify against the raw bytes, before parsing.
    if (!isAuthentic(rawBody, req.headers['x-aquipay-signature'] as string | undefined)) {
      res.writeHead(401).end()
      return
    }
    const event = JSON.parse(rawBody) as TopupEvent
    if (event.type === 'topup.confirmed' && !processed.has(event.id)) {
      creditTopup(event)
      processed.add(event.id)
    }
    // Any 2xx stops retries, including for duplicates and event types you ignore.
    res.writeHead(204).end()
  })
}).listen(PORT, () => console.log(`listening on :${PORT}`))
