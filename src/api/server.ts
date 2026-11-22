import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { getAddress } from 'viem'
import { z } from 'zod'
import type { Context } from '../context.ts'
import { forwarderAddress, invoiceSalt } from '../forwarder.ts'
import { trimAmount } from '../watcher.ts'
import { fonts } from './assets.ts'
import { renderCheckout, renderNotFound } from './checkout.ts'

const createInvoiceBody = z.object({
  reference: z.string().min(1).max(255),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

const listInvoicesQuery = z.object({
  reference: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const listTransfersQuery = z.object({
  chain: z.string().optional(),
  status: z.enum(['pending', 'confirmed', 'orphaned']).optional(),
  credited: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

const uuidParam = z.object({ id: z.uuid() })

interface InvoiceRow {
  id: string
  reference: string
  metadata: unknown
  address: string
  created_at: Date
  expires_at: Date
}

interface TransferRow {
  invoice_id: string
  chain: string
  tx_hash: string
  log_index: number
  from_address: string
  amount: string
  status: string
  credited: boolean
  detected_at: Date
  confirmed_at: Date | null
  swept_tx_hash: string | null
  swept_at: Date | null
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export function buildServer(ctx: Context): FastifyInstance {
  const { config, sql } = ctx
  if (!config.apiKey) throw new Error('API_KEY is required')
  const apiKeyDigest = digest(config.apiKey)
  const app = Fastify({ loggerInstance: ctx.log as FastifyBaseLogger, trustProxy: true })

  const networks = config.chains.map((chain) => ({
    chain: chain.key,
    chain_id: chain.viemChain.id,
    name: chain.name,
    token_address: chain.usdt,
    min_amount: chain.minTopup,
  }))

  const presentTransfer = (row: TransferRow) => ({
    invoice_id: row.invoice_id,
    chain: row.chain,
    tx_hash: row.tx_hash,
    log_index: row.log_index,
    from: row.from_address,
    amount: trimAmount(row.amount),
    status: row.status,
    credited: row.credited,
    detected_at: row.detected_at,
    confirmed_at: row.confirmed_at,
    swept_tx_hash: row.swept_tx_hash,
    swept_at: row.swept_at,
  })

  const presentInvoice = (row: InvoiceRow, transfers: TransferRow[] = []) => ({
    id: row.id,
    reference: row.reference,
    metadata: row.metadata,
    address: getAddress(row.address),
    checkout_url: `${config.publicBaseUrl}/checkout/${row.id}`,
    created_at: row.created_at,
    expires_at: row.expires_at,
    networks,
    transfers: transfers.map(presentTransfer),
  })

  const transfersOf = (invoiceId: string) => sql<TransferRow[]>`
    select invoice_id, chain, tx_hash, log_index, from_address, amount::text as amount, status, credited,
           detected_at, confirmed_at, swept_tx_hash, swept_at
    from transfers where invoice_id = ${invoiceId} order by detected_at`

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid_request', issues: error.issues })
    }
    const status = (error as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) request.log.error({ err: error }, 'request failed')
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : (error as Error).message })
  })

  app.get('/healthz', async () => ({ ok: true }))
  app.get('/readyz', async () => {
    await sql`select 1`
    return { ok: true }
  })

  // Authenticated merchant API.
  app.register(async (api) => {
    api.addHook('onRequest', async (request, reply) => {
      const token = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
      if (!timingSafeEqual(digest(token), apiKeyDigest)) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
    })

    api.post('/v1/invoices', async (request, reply) => {
      const body = createInvoiceBody.parse(request.body)
      const id = randomUUID()
      const salt = invoiceSalt(id)
      const address = forwarderAddress(config.factory, config.implementation, salt).toLowerCase()
      const [row] = await sql<InvoiceRow[]>`
        insert into invoices (id, reference, metadata, salt, address, expires_at)
        values (${id}, ${body.reference}, ${sql.json(body.metadata as never)}, ${salt}, ${address},
                now() + make_interval(secs => ${config.invoiceTtlSeconds}))
        returning id, reference, metadata, address, created_at, expires_at`
      return reply.code(201).send(presentInvoice(row!))
    })

    api.get('/v1/invoices', async (request) => {
      const query = listInvoicesQuery.parse(request.query)
      const rows = await sql<InvoiceRow[]>`
        select id, reference, metadata, address, created_at, expires_at from invoices
        ${query.reference ? sql`where reference = ${query.reference}` : sql``}
        order by created_at desc limit ${query.limit}`
      return { data: rows.map((row) => presentInvoice(row)) }
    })

    api.get('/v1/invoices/:id', async (request, reply) => {
      const { id } = uuidParam.parse(request.params)
      const [row] = await sql<InvoiceRow[]>`
        select id, reference, metadata, address, created_at, expires_at from invoices where id = ${id}`
      if (!row) return reply.code(404).send({ error: 'not_found' })
      return presentInvoice(row, await transfersOf(id))
    })

    // E.g. ?status=confirmed&credited=false lists payments below the minimum.
    api.get('/v1/transfers', async (request) => {
      const query = listTransfersQuery.parse(request.query)
      const rows = await sql<TransferRow[]>`
        select invoice_id, chain, tx_hash, log_index, from_address, amount::text as amount, status, credited,
               detected_at, confirmed_at, swept_tx_hash, swept_at
        from transfers
        where true
          ${query.chain ? sql`and chain = ${query.chain}` : sql``}
          ${query.status ? sql`and status = ${query.status}` : sql``}
          ${query.credited ? sql`and credited = ${query.credited === 'true'}` : sql``}
        order by detected_at desc limit ${query.limit}`
      return { data: rows.map(presentTransfer) }
    })
  })

  // Public checkout. The invoice id is an unguessable UUID and acts as the capability.
  app.get('/checkout/:id', async (request, reply) => {
    const nonce = randomUUID()
    const sendPage = (status: number, html: string) =>
      reply
        .code(status)
        .header(
          'content-security-policy',
          `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
        )
        .header('referrer-policy', 'no-referrer')
        .header('cache-control', 'no-store')
        .type('text/html; charset=utf-8')
        .send(html)

    // A mistyped link gets the same page as an unknown invoice.
    const params = uuidParam.safeParse(request.params)
    const [row] = params.success
      ? await sql<{ id: string; address: string; seconds_left: number }[]>`
          select id, address, greatest(0, ceil(extract(epoch from expires_at - now())))::int as seconds_left
          from invoices where id = ${params.data.id}`
      : []
    if (!row) return sendPage(404, renderNotFound(nonce))
    const html = await renderCheckout({
      invoiceId: row.id,
      address: getAddress(row.address),
      secondsLeft: row.seconds_left,
      nonce,
      networks: config.chains.map((chain) => ({
        key: chain.key,
        name: chain.name,
        minAmount: chain.minTopup,
        explorerTx: chain.explorerTx,
      })),
    })
    return sendPage(200, html)
  })

  app.get('/assets/fonts/:name', async (request, reply) => {
    const font = fonts.get((request.params as { name: string }).name)
    if (!font) return reply.code(404).send({ error: 'not_found' })
    return reply.header('cache-control', 'public, max-age=2592000').type('font/woff2').send(font)
  })

  app.get('/checkout/:id/status', async (request, reply) => {
    const { id } = uuidParam.parse(request.params)
    const [invoice] = await sql<{ expired: boolean }[]>`select expires_at <= now() as expired from invoices where id = ${id}`
    const transfers = await transfersOf(id)
    return reply.header('cache-control', 'no-store').send({
      // So an open page stops showing the address even if its own clock is off.
      expired: invoice?.expired ?? true,
      transfers: transfers
        .filter((row) => row.status !== 'orphaned')
        .map((row) => ({
          chain: row.chain,
          tx_hash: row.tx_hash,
          amount: trimAmount(row.amount),
          status: row.status,
          credited: row.credited,
        })),
    })
  })

  return app
}
