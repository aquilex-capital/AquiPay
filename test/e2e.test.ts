// End-to-end tests against a local chain and database.
// Needs `docker compose up -d` and `npm run contracts:build` first.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pino } from 'pino'
import postgres from 'postgres'
import {
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseGwei,
  parseUnits,
  publicActions,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/api/server.ts'
import { run } from '../src/app.ts'
import { loadConfig, type ChainConfig, type Config } from '../src/config.ts'
import type { Context } from '../src/context.ts'
import { connect, migrate, type Sql } from '../src/db.ts'
import { dispatchTick, verifySignature } from '../src/dispatcher.ts'
import { readAddresses } from '../src/chain.ts'
import { factoryAbi } from '../src/forwarder.ts'
import { sweepTick } from '../src/sweeper.ts'
import { confirmTransfer, watchHorizonSeconds, watcherTick } from '../src/watcher.ts'

const RPC_URL = process.env.TEST_RPC_URL ?? 'http://127.0.0.1:8545'
const PG_URL = process.env.TEST_PG_URL ?? 'postgres://aquipay:aquipay@127.0.0.1:54329'
const TEST_DB = 'aquipay_test'
const API_KEY = 'test-api-key'
const WEBHOOK_SECRET = 'test-webhook-secret'
const AUTH = { authorization: `Bearer ${API_KEY}` }

// Well-known anvil development keys.
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const SWEEPER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
const DESTINATION: Address = '0x00000000000000000000000000000000000d3571'

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = join(import.meta.dirname, '..', 'contracts', 'out', `${name}.sol`, `${name}.json`)
  const json = JSON.parse(readFileSync(path, 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode.object }
}

const usdtAbi = artifact('MockUSDT').abi
const chainClient = createTestClient({ chain: foundry, mode: 'anvil', transport: http(RPC_URL) }).extend(publicActions)
const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain: foundry, transport: http(RPC_URL) })
const payer = createWalletClient({ account: privateKeyToAccount(PAYER_KEY), chain: foundry, transport: http(RPC_URL) })

const mined = (hash: Hex) => chainClient.waitForTransactionReceipt({ hash })

async function deploy(name: string, args: unknown[]): Promise<Address> {
  const { abi, bytecode } = artifact(name)
  return (await mined(await deployer.deployContract({ abi, bytecode, args }))).contractAddress!
}

async function waitFor(condition: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

interface TopupEvent {
  id: string
  type: string
  data: { invoice_id: string; amount: string; transfers: { tx_hash: string; amount: string }[] } & Record<string, unknown>
}

interface InvoiceJson {
  id: string
  reference: string
  address: Address
  checkout_url: string
  created_at: string
  expires_at: string
  networks: { chain: string; chain_id: number; min_amount: string; token_address: string }[]
  transfers: {
    chain: string
    tx_hash: string
    amount: string
    status: string
    credited: boolean
    swept_tx_hash: string | null
    swept_at: string | null
  }[]
}

interface RpcCall {
  id: number
  method: string
  params: unknown[]
}

describe('AquiPay', () => {
  let ctx: Context
  let chain: ChainConfig
  let usdt: Address
  let app: ReturnType<typeof buildServer>
  let receiver: Server
  let receiverStatus = 204
  const received: { body: string; signature: string; eventId: string; payload: TopupEvent }[] = []

  // AquiPay reaches the chain through this proxy, which counts what it asks
  // for and can answer in the chain's place to stand in for a failing provider.
  let proxy: Server
  const rpcCalls: RpcCall[] = []
  let rpcFault: ((call: RpcCall) => object | undefined) | undefined
  /** The RPC methods AquiPay called while `fn` ran. */
  async function rpcMethods(fn: () => Promise<unknown>): Promise<string[]> {
    const start = rpcCalls.length
    await fn()
    return rpcCalls.slice(start).map((call) => call.method)
  }
  /** Runs `fn` with `fault` answering the calls it matches. */
  async function withFault<T>(fault: (call: RpcCall) => object | undefined, fn: () => Promise<T>): Promise<T> {
    rpcFault = fault
    try {
      return await fn()
    } finally {
      rpcFault = undefined
    }
  }
  const usdtCallTo = (call: RpcCall) =>
    call.method === 'eth_call' && (call.params[0] as { to?: string }).to?.toLowerCase() === usdt.toLowerCase()

  /** A context whose warnings and errors are kept, for the paths that only log. */
  function recording(): { context: Context; warnings: object[]; errors: object[] } {
    const warnings: object[] = []
    const errors: object[] = []
    const log = { info() {}, warn: (obj: object) => warnings.push(obj), error: (obj: object) => errors.push(obj) }
    return { context: { ...ctx, log }, warnings, errors }
  }

  const usdtBalance = (address: Address) =>
    chainClient.readContract({ address: usdt, abi: usdtAbi, functionName: 'balanceOf', args: [address] }) as Promise<bigint>

  /** Sends USDT from the payer; resolves once the transfer is mined. */
  async function pay(to: Address, amount: string): Promise<Hex> {
    const hash = await payer.writeContract({
      address: usdt,
      abi: usdtAbi,
      functionName: 'transfer',
      args: [to, parseUnits(amount, 6)],
    })
    await mined(hash)
    return hash
  }

  /** A signed transfer that can be broadcast more than once, e.g. on both sides of a reorg. */
  async function signTransfer(to: Address, amount: string): Promise<Hex> {
    const request = await payer.prepareTransactionRequest({
      to: usdt,
      data: encodeFunctionData({ abi: usdtAbi, functionName: 'transfer', args: [to, parseUnits(amount, 6)] }),
      gas: 120_000n,
      maxFeePerGas: parseGwei('100'),
      maxPriorityFeePerGas: parseGwei('1'),
    })
    return payer.signTransaction(request)
  }

  async function broadcast(serializedTransaction: Hex): Promise<Hex> {
    const hash = await chainClient.sendRawTransaction({ serializedTransaction })
    await mined(hash)
    return hash
  }

  async function createInvoice(reference: string, metadata?: Record<string, unknown>): Promise<InvoiceJson> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: AUTH,
      payload: metadata ? { reference, metadata } : { reference },
    })
    expect(response.statusCode).toBe(201)
    return response.json()
  }

  const getInvoice = async (id: string): Promise<InvoiceJson> =>
    (await app.inject({ url: `/v1/invoices/${id}`, headers: AUTH })).json()
  const statuses = async (id: string) => (await getInvoice(id)).transfers.map((t) => t.status)
  const eventsFor = (invoiceId: string) => received.map((r) => r.payload).filter((e) => e.data.invoice_id === invoiceId)

  const tick = (variant: ChainConfig = chain, options?: { late?: boolean }) => watcherTick(ctx, variant, options)
  const latePass = () => tick(chain, { late: true })
  /** Moves an invoice's expiry `seconds` into the past. */
  const expire = (invoiceId: string, seconds: number) =>
    ctx.sql`update invoices set expires_at = now() - make_interval(secs => ${seconds}) where id = ${invoiceId}`
  /** Past the late-payment window, as if its last look came after the window closed: the watcher is done with it. */
  const finish = (invoiceId: string) => expire(invoiceId, ctx.config.lateWindowSeconds + 86_400)
  /** Empties an invoice's address the way anyone can: ForwarderFactory.sweep is open to all. */
  async function flush(invoiceId: string) {
    const [row] = await ctx.sql<{ salt: Hex }[]>`select salt from invoices where id = ${invoiceId}`
    await mined(
      await deployer.writeContract({ address: ctx.config.factory, abi: factoryAbi, functionName: 'sweep', args: [usdt, [row!.salt]] }),
    )
  }
  const confirmBlocks = () => chainClient.mine({ blocks: Number(chain.confirmations) })
  /** Watcher pass, enough blocks to confirm, another pass. */
  async function settle() {
    await tick()
    await confirmBlocks()
    await tick()
  }
  async function drainWebhooks(context: Context = ctx) {
    while ((await dispatchTick(context)) > 0);
  }
  const withConfig = (overrides: Partial<Config>): Context => ({ ...ctx, config: { ...ctx.config, ...overrides } })

  beforeAll(async () => {
    const admin = postgres(`${PG_URL}/postgres`, { onnotice: () => {} })
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`)
    await admin.unsafe(`create database ${TEST_DB}`)
    await admin.end()

    await chainClient.setAutomine(true)
    usdt = await deploy('MockUSDT', [6])
    const factory = await deploy('ForwarderFactory', [DESTINATION])
    // Anvil has no Multicall3 of its own; deploying one elsewhere also exercises MULTICALL3_ADDRESS_<CHAIN>.
    const multicall = await deploy('Multicall3', [])
    await mined(
      await deployer.writeContract({
        address: usdt,
        abi: usdtAbi,
        functionName: 'mint',
        args: [payer.account.address, parseUnits('100000', 6)],
      }),
    )

    receiver = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        if (receiverStatus < 300) {
          received.push({
            body,
            signature: String(req.headers['x-aquipay-signature']),
            eventId: String(req.headers['x-aquipay-event-id']),
            payload: JSON.parse(body),
          })
        }
        res.writeHead(receiverStatus).end()
      })
    })
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))

    proxy = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', async () => {
        const call = JSON.parse(body) as RpcCall
        rpcCalls.push(call)
        const fault = rpcFault?.(call)
        const answer = fault
          ? JSON.stringify({ jsonrpc: '2.0', id: call.id, ...fault })
          : await (await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).text()
        res.writeHead(200, { 'content-type': 'application/json' }).end(answer)
      })
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))

    const config = loadConfig({
      DATABASE_URL: `${PG_URL}/${TEST_DB}`,
      PORT: '18473',
      API_KEY,
      WEBHOOK_URL: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`,
      WEBHOOK_SECRET,
      FORWARDER_FACTORY_ADDRESS: factory,
      CHAINS: 'local',
      USDT_ADDRESS_LOCAL: usdt,
      RPC_URLS_LOCAL: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      MULTICALL3_ADDRESS_LOCAL: multicall,
      CONFIRMATIONS_LOCAL: '5',
      SWEEPER_PRIVATE_KEY: SWEEPER_KEY,
    })
    chain = config.chains[0]!
    const sql = connect(config.databaseUrl)
    ctx = { config, sql, log: pino({ level: 'silent' }) }
    app = buildServer(ctx)
  })

  afterAll(async () => {
    await chainClient.setAutomine(true)
    await app?.close()
    await ctx?.sql.end()
    receiver?.close()
    proxy?.close()
  })

  describe('database', () => {
    it('applies migrations once and is a no-op afterwards', async () => {
      const all = ['001_init.sql', '002_credit_event.sql', '003_expiry_and_balances.sql']
      expect(await migrate(ctx.sql)).toEqual(all)
      expect(await migrate(ctx.sql)).toEqual([])
      const names = await ctx.sql`select name from schema_migrations order by name`
      expect(names.map((row) => row.name)).toEqual(all)
    })

    it('gives an invoice from the previous release ten minutes, so a rollout does not refuse it', async () => {
      // An API pod not yet replaced inserts without expires_at.
      const [row] = await ctx.sql`
        insert into invoices (reference, salt, address) values ('old-release', 'old-release-salt', '0xold-release')
        returning extract(epoch from expires_at - created_at)::int as ttl`
      expect(row!.ttl).toBe(600)
      await ctx.sql`delete from invoices where reference = 'old-release'`
    })
  })

  // What fits a free RPC plan: nothing while no checkout is open, two calls a
  // pass however many are, and a handful more for each payment.
  describe('RPC budget', () => {
    it('makes no call at all while no checkout is open and nothing is confirming', async () => {
      expect(await rpcMethods(() => tick())).toEqual([])
      expect(await rpcMethods(() => tick())).toEqual([])
    })

    it('reads every open checkout in one call', async () => {
      await createInvoice('budget-one')
      expect(await rpcMethods(() => tick())).toEqual(['eth_blockNumber', 'eth_call'])
      const many = await Promise.all(Array.from({ length: 300 }, (_, i) => createInvoice(`budget-${i}`)))
      expect(await rpcMethods(() => tick())).toEqual(['eth_blockNumber', 'eth_call'])
      // MULTICALL_BATCH addresses per call.
      const small = (context: Context) => watcherTick(context, chain)
      expect(await rpcMethods(() => small(withConfig({ multicallBatch: 100 })))).toEqual([
        'eth_blockNumber',
        'eth_call',
        'eth_call',
        'eth_call',
        'eth_call',
      ])

      // Each address gets one more look after it expires, then none.
      await ctx.sql`update invoices set expires_at = now() where id in ${ctx.sql(many.map((i) => i.id))} or reference = 'budget-one'`
      expect(await rpcMethods(() => tick())).toEqual(['eth_blockNumber', 'eth_call'])
      expect(await rpcMethods(() => tick())).toEqual([])
    })

    it('spends a few calls and one log query on a payment', async () => {
      const invoice = await createInvoice('budget-payment')
      await tick()
      await pay(invoice.address, '10')
      const methods = await rpcMethods(() => tick())
      expect(methods.filter((m) => m === 'eth_getLogs')).toHaveLength(1)
      expect(methods.length).toBeLessThanOrEqual(6)
      expect(await statuses(invoice.id)).toEqual(['pending'])

      // Confirming goes on after the address stops being read: the tip, then the block's hash.
      await expire(invoice.id, 1)
      await confirmBlocks()
      expect(await rpcMethods(() => tick())).toEqual(['eth_blockNumber', 'eth_getBlockByNumber'])
      expect(await statuses(invoice.id)).toEqual(['confirmed'])
      expect(await rpcMethods(() => tick())).toEqual([])
    })

    it('fails the pass rather than guess at a balance it cannot read', async () => {
      // USDT moved, or the wrong address configured: balanceOf answers nothing.
      const wrongToken: ChainConfig = { ...chain, usdt: deployer.account.address }
      await expect(readAddresses(ctx, wrongToken, [payer.account.address])).rejects.toThrow()
    })

    it('never reads an address past the horizon, however many invoices there are', async () => {
      // Never looked at, and no late pass would reach it any more: an invoice
      // from before the watcher ran, say. Old invoices cost nothing.
      const old = await createInvoice('past-horizon')
      await expire(old.id, watchHorizonSeconds(ctx.config) + 60)
      expect(await rpcMethods(() => tick())).toEqual([])
      await latePass()
      expect(await ctx.sql`select 1 from watch_state where invoice_id = ${old.id}`).toHaveLength(0)
    })

    it('saves what it read of more addresses than one statement can bind', async () => {
      // Four parameters a row against Postgres's 65,535: more than 16,383
      // addresses would not fit one insert.
      const count = 17_000
      await ctx.sql`
        -- Clear of the precompiles at 0x01 to 0x0a, which no CREATE2 address is.
        insert into invoices (reference, salt, address)
        select 'bulk-' || g, 'bulk-salt-' || g, '0xb' || lpad(to_hex(g), 39, '0')
        from generate_series(1, ${count}) g`
      try {
        await tick()
        const [{ saved }] = (await ctx.sql`
          select count(*)::int as saved from watch_state w join invoices i on i.id = w.invoice_id
          where i.reference like 'bulk-%'`) as [{ saved: number }]
        expect(saved).toBe(count)
      } finally {
        await ctx.sql`update invoices set expires_at = now() - interval '30 days' where reference like 'bulk-%'`
      }
    }, 120_000)
  })

  describe('API', () => {
    it('reports liveness and readiness', async () => {
      expect((await app.inject({ url: '/healthz' })).json()).toEqual({ ok: true })
      expect((await app.inject({ url: '/readyz' })).json()).toEqual({ ok: true })
    })

    it('refuses to start without an API key', () => {
      expect(() => buildServer(withConfig({ apiKey: undefined }))).toThrow('API_KEY is required')
    })

    it.each([
      ['no header', {}],
      ['a wrong key', { authorization: 'Bearer nope' }],
      ['a non-bearer scheme', { authorization: `Basic ${API_KEY}x` }],
    ])('rejects %s on every /v1 route', async (_name, headers) => {
      for (const url of ['/v1/invoices', '/v1/transfers', `/v1/invoices/${randomUUID()}`]) {
        const response = await app.inject({ url, headers })
        expect(response.statusCode).toBe(401)
        expect(response.json()).toEqual({ error: 'unauthorized' })
      }
      const create = await app.inject({ method: 'POST', url: '/v1/invoices', headers, payload: { reference: 'x' } })
      expect(create.statusCode).toBe(401)
    })

    it('creates an invoice with a deposit address, checkout link and network list', async () => {
      const invoice = await createInvoice('order-1', { plan: 'pro' })
      expect(invoice).toMatchObject({
        reference: 'order-1',
        metadata: { plan: 'pro' },
        checkout_url: `http://localhost:8080/checkout/${invoice.id}`,
        networks: [{ chain: 'local', chain_id: 31337, min_amount: '10', token_address: chain.usdt }],
        transfers: [],
      })
      expect(invoice.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect((await createInvoice('order-1')).address).not.toBe(invoice.address)
      // Live for INVOICE_TTL_SECONDS.
      expect(Date.parse(invoice.expires_at) - Date.parse(invoice.created_at)).toBe(600_000)
      expect((await getInvoice(invoice.id)).expires_at).toBe(invoice.expires_at)
    })

    it('makes invoices live for as long as INVOICE_TTL_SECONDS says', async () => {
      const short = buildServer(withConfig({ invoiceTtlSeconds: 30 }))
      const invoice = (await short.inject({ method: 'POST', url: '/v1/invoices', headers: AUTH, payload: { reference: 'ttl' } })).json()
      expect(Date.parse(invoice.expires_at) - Date.parse(invoice.created_at)).toBe(30_000)
      await short.close()
    })

    it('defaults metadata to an empty object', async () => {
      expect(await createInvoice('no-metadata')).toMatchObject({ metadata: {} })
    })

    it.each([
      ['a missing reference', {}],
      ['an empty reference', { reference: '' }],
      ['an over-long reference', { reference: 'x'.repeat(256) }],
      ['non-object metadata', { reference: 'x', metadata: 'nope' }],
    ])('rejects %s with 400', async (_name, payload) => {
      const response = await app.inject({ method: 'POST', url: '/v1/invoices', headers: AUTH, payload })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ error: 'invalid_request', issues: expect.any(Array) })
    })

    it('rejects a body that is not JSON', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/invoices',
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: '{not json',
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toEqual(expect.any(String))
    })

    it('finds invoices by id and by reference', async () => {
      const first = await createInvoice('lookup-user')
      const second = await createInvoice('lookup-user')
      await createInvoice('someone-else')

      expect(await getInvoice(first.id)).toMatchObject({ id: first.id, reference: 'lookup-user' })

      const byReference = (await app.inject({ url: '/v1/invoices?reference=lookup-user', headers: AUTH })).json()
      expect(byReference.data.map((i: InvoiceJson) => i.id)).toEqual([second.id, first.id])

      const limited = (await app.inject({ url: '/v1/invoices?limit=2', headers: AUTH })).json()
      expect(limited.data).toHaveLength(2)
      expect(limited.data[0].reference).toBe('someone-else')
    })

    it('answers 404 for an unknown invoice and 400 for a malformed id or query', async () => {
      const unknown = await app.inject({ url: `/v1/invoices/${randomUUID()}`, headers: AUTH })
      expect(unknown.statusCode).toBe(404)
      expect(unknown.json()).toEqual({ error: 'not_found' })
      expect((await app.inject({ url: '/v1/invoices/123', headers: AUTH })).statusCode).toBe(400)
      expect((await app.inject({ url: '/v1/invoices?limit=0', headers: AUTH })).statusCode).toBe(400)
      expect((await app.inject({ url: '/v1/invoices?limit=201', headers: AUTH })).statusCode).toBe(400)
      expect((await app.inject({ url: '/v1/transfers?status=paid', headers: AUTH })).statusCode).toBe(400)
      expect((await app.inject({ url: '/v1/transfers?credited=maybe', headers: AUTH })).statusCode).toBe(400)
    })

    it('hides internal errors behind a 500', async () => {
      const brokenSql = (() => {
        throw new Error('connection refused: secret-host')
      }) as unknown as Sql
      const broken = buildServer({ ...ctx, sql: brokenSql })
      const response = await broken.inject({ url: '/readyz' })
      expect(response.statusCode).toBe(500)
      expect(response.json()).toEqual({ error: 'internal_error' })
      await broken.close()
    })

    it('serves the bundled fonts and nothing else from /assets', async () => {
      for (const name of ['golos-text.woff2', 'jetbrains-mono.woff2']) {
        const font = await app.inject({ url: `/assets/fonts/${name}` })
        expect(font.statusCode).toBe(200)
        expect(font.headers['content-type']).toBe('font/woff2')
        expect(font.headers['cache-control']).toContain('max-age')
        expect(font.rawPayload.subarray(0, 4).toString()).toBe('wOF2')
      }
      expect((await app.inject({ url: '/assets/fonts/..%2Fpackage.json' })).statusCode).toBe(404)
      expect((await app.inject({ url: '/assets/fonts/other.woff2' })).statusCode).toBe(404)
    })
  })

  describe('checkout page', () => {
    it('serves the page with a locked-down content security policy', async () => {
      const invoice = await createInvoice('checkout')
      const page = await app.inject({ url: `/checkout/${invoice.id}` })
      expect(page.statusCode).toBe(200)
      expect(page.headers['content-type']).toContain('text/html')
      expect(page.headers['cache-control']).toBe('no-store')
      expect(page.headers['referrer-policy']).toBe('no-referrer')
      expect(page.body).toContain(`aria-label="${invoice.address}"`)

      const csp = String(page.headers['content-security-policy'])
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain("frame-ancestors 'none'")
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]
      expect(page.body).toContain(`<script nonce="${nonce}">`)
      // Each response gets its own nonce.
      const again = await app.inject({ url: `/checkout/${invoice.id}` })
      expect(again.headers['content-security-policy']).not.toBe(csp)

      expect((await app.inject({ url: `/checkout/${invoice.id}/status` })).json()).toEqual({ expired: false, transfers: [] })
      expect(page.body).toMatch(/id="clock" role="timer">(10:00|9:5\d)</)
    })

    it('stops showing the address once the invoice has expired', async () => {
      const invoice = await createInvoice('checkout-expired')
      await expire(invoice.id, 1)
      const page = await app.inject({ url: `/checkout/${invoice.id}` })
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain("This address has expired. Don't send to it.")
      // Not in the markup, and not in the data the page's script reads either.
      expect(page.body.toLowerCase()).not.toContain(invoice.address.toLowerCase())
      expect((await app.inject({ url: `/checkout/${invoice.id}/status` })).json()).toEqual({ expired: true, transfers: [] })
      // A status poll for an id that is not an invoice says so the same way.
      expect((await app.inject({ url: `/checkout/${randomUUID()}/status` })).json()).toEqual({ expired: true, transfers: [] })
    })

    it('shows the not-found page for an unknown or malformed link', async () => {
      for (const id of [randomUUID(), 'not-a-uuid']) {
        const missing = await app.inject({ url: `/checkout/${id}` })
        expect(missing.statusCode).toBe(404)
        expect(missing.body).toContain("This top-up link doesn't work")
        expect(missing.headers['content-security-policy']).toContain("default-src 'none'")
      }
      expect((await app.inject({ url: '/checkout/not-a-uuid/status' })).statusCode).toBe(400)
    })
  })

  describe('addresses', () => {
    it('predicts the same addresses as the contract', async () => {
      const implementation = await chainClient.readContract({
        address: ctx.config.factory,
        abi: factoryAbi,
        functionName: 'implementation',
      })
      expect(ctx.config.implementation).toBe(implementation)

      const invoice = await createInvoice('address-check')
      const [row] = await ctx.sql<{ salt: Hex }[]>`select salt from invoices where id = ${invoice.id}`
      const onChain = await chainClient.readContract({
        address: ctx.config.factory,
        abi: factoryAbi,
        functionName: 'forwarderAddress',
        args: [row!.salt],
      })
      expect(invoice.address).toBe(onChain)
    })
  })

  describe('top-ups', () => {
    it('credits a payment after confirmations, exactly once, and sweeps it', async () => {
      const destinationBefore = await usdtBalance(DESTINATION)
      const invoice = await createInvoice('user-42', { plan: 'pro' })
      const topupTx = await pay(invoice.address, '25.5')

      await tick()
      expect(await getInvoice(invoice.id)).toMatchObject({
        transfers: [{ chain: 'local', tx_hash: topupTx, amount: '25.5', status: 'pending', credited: false }],
      })
      expect((await app.inject({ url: `/checkout/${invoice.id}/status` })).json()).toEqual({
        expired: false,
        transfers: [{ chain: 'local', tx_hash: topupTx, amount: '25.5', status: 'pending', credited: false }],
      })
      await drainWebhooks()
      expect(eventsFor(invoice.id)).toHaveLength(0)

      // One block short of the confirmation depth is still pending.
      await chainClient.mine({ blocks: Number(chain.confirmations) - 2 })
      await tick()
      expect(await statuses(invoice.id)).toEqual(['pending'])
      await chainClient.mine({ blocks: 1 })
      await tick()
      await tick() // a repeated pass must not credit twice
      expect(await getInvoice(invoice.id)).toMatchObject({
        transfers: [{ amount: '25.5', status: 'confirmed', credited: true, swept_at: null }],
      })

      await drainWebhooks()
      await drainWebhooks()
      expect(eventsFor(invoice.id)).toHaveLength(1)
      const hook = received.find((r) => r.payload.data.invoice_id === invoice.id)!
      expect(hook.eventId).toBe(hook.payload.id)
      expect(verifySignature(WEBHOOK_SECRET, hook.body, hook.signature)).toBe(true)
      expect(verifySignature('wrong-secret', hook.body, hook.signature)).toBe(false)
      expect(hook.payload).toMatchObject({
        type: 'topup.confirmed',
        data: {
          invoice_id: invoice.id,
          reference: 'user-42',
          metadata: { plan: 'pro' },
          chain: 'local',
          chain_id: 31337,
          currency: 'USDT',
          amount: '25.5',
          transfers: [{ tx_hash: topupTx, log_index: 0, from: payer.account.address.toLowerCase(), amount: '25.5' }],
        },
      })

      // Swept once the watcher is done with the address.
      expect(await sweepTick(ctx, chain)).toBeUndefined()
      await finish(invoice.id)
      const sweepTx = await sweepTick(ctx, chain)
      expect(sweepTx).toMatch(/^0x[0-9a-f]{64}$/)
      expect(await usdtBalance(DESTINATION)).toBe(destinationBefore + parseUnits('25.5', 6))
      expect(await usdtBalance(invoice.address)).toBe(0n)
      const swept = await getInvoice(invoice.id)
      expect(swept.transfers[0]).toMatchObject({ swept_tx_hash: sweepTx })
      expect(swept.transfers[0]!.swept_at).not.toBeNull()
      expect(await sweepTick(ctx, chain)).toBeUndefined()
    })

    it('credits a payment that lands after expiry, within the late window, on the hourly pass', async () => {
      const invoice = await createInvoice('late-payment')
      await tick()
      await expire(invoice.id, 3600)
      await pay(invoice.address, '14')

      // An ordinary pass no longer reads the address...
      await tick()
      expect(await statuses(invoice.id)).toEqual([])
      // ...the late pass does.
      await latePass()
      expect(await statuses(invoice.id)).toEqual(['pending'])
      await confirmBlocks()
      await tick()
      await latePass()
      await drainWebhooks()
      expect(eventsFor(invoice.id).map((e) => e.data.amount)).toEqual(['14'])
    })

    it('credits a payment once that both the last look and the late pass see', async () => {
      const invoice = await createInvoice('seen-twice')
      await pay(invoice.address, '16')
      await tick()
      await expire(invoice.id, 0)
      await confirmBlocks()
      await tick()
      await latePass()
      await latePass()
      await drainWebhooks()
      expect(eventsFor(invoice.id).map((e) => e.data.amount)).toEqual(['16'])
      expect(await statuses(invoice.id)).toEqual(['confirmed'])
    })

    it('neither credits nor sweeps a payment that arrives after the late window', async () => {
      const invoice = await createInvoice('too-late')
      await tick()
      await finish(invoice.id)
      await pay(invoice.address, '13')
      await tick()
      await latePass()
      await confirmBlocks()
      await latePass()
      await drainWebhooks()
      expect(await statuses(invoice.id)).toEqual([])
      expect(eventsFor(invoice.id)).toHaveLength(0)
      // Left at the address, for a refund by hand.
      await sweepTick(ctx, chain)
      expect(await usdtBalance(invoice.address)).toBe(parseUnits('13', 6))
    })

    it('credits 4 USDT followed by 30 USDT as one top-up of 34', async () => {
      const invoice = await createInvoice('accumulate')
      const small = await pay(invoice.address, '4')
      await settle()
      await drainWebhooks()
      expect(await getInvoice(invoice.id)).toMatchObject({ transfers: [{ amount: '4', status: 'confirmed', credited: false }] })
      expect(eventsFor(invoice.id)).toHaveLength(0)

      const waiting = (await app.inject({ url: '/v1/transfers?status=confirmed&credited=false&chain=local', headers: AUTH })).json()
      expect(waiting.data.map((t: { tx_hash: string }) => t.tx_hash)).toContain(small)

      const large = await pay(invoice.address, '30')
      await settle()
      await drainWebhooks()
      expect(eventsFor(invoice.id)).toHaveLength(1)
      expect(eventsFor(invoice.id)[0]!.data).toMatchObject({
        amount: '34',
        transfers: [
          { tx_hash: small, amount: '4' },
          { tx_hash: large, amount: '30' },
        ],
      })
      expect((await getInvoice(invoice.id)).transfers.map((t) => t.credited)).toEqual([true, true])
      const links = await ctx.sql`select distinct credit_event_id from transfers where invoice_id = ${invoice.id}`
      expect(links.map((row) => row.credit_event_id)).toEqual([eventsFor(invoice.id)[0]!.id])
    })

    it('credits 30 USDT at once and holds a later 4 USDT until more arrives', async () => {
      const invoice = await createInvoice('large-then-small')
      await pay(invoice.address, '30')
      await settle()
      await pay(invoice.address, '4')
      await settle()
      await drainWebhooks()
      expect(eventsFor(invoice.id).map((e) => e.data.amount)).toEqual(['30'])
      expect((await getInvoice(invoice.id)).transfers.map((t) => t.credited)).toEqual([true, false])

      await pay(invoice.address, '5.999999')
      await settle()
      await drainWebhooks()
      expect(eventsFor(invoice.id)).toHaveLength(1) // 9.999999 is still under the minimum

      await pay(invoice.address, '0.000001')
      await settle()
      await drainWebhooks()
      expect(eventsFor(invoice.id).map((e) => e.data.amount)).toEqual(['30', '10'])
      expect(eventsFor(invoice.id)[1]!.data.transfers).toHaveLength(3)
    })

    it('credits a payment of exactly the minimum', async () => {
      const invoice = await createInvoice('exact-minimum')
      await pay(invoice.address, '10')
      await settle()
      await drainWebhooks()
      expect(eventsFor(invoice.id).map((e) => e.data.amount)).toEqual(['10'])
    })

    it('keeps the waiting totals of different invoices separate', async () => {
      const a = await createInvoice('separate-a')
      const b = await createInvoice('separate-b')
      await pay(a.address, '6')
      await pay(b.address, '6')
      await settle()
      await drainWebhooks()
      expect(eventsFor(a.id)).toHaveLength(0)
      expect(eventsFor(b.id)).toHaveLength(0)
    })

    it('credits two transfers mined in the same block together', async () => {
      const invoice = await createInvoice('same-block')
      await chainClient.setAutomine(false)
      try {
        const args = (amount: string) =>
          ({ address: usdt, abi: usdtAbi, functionName: 'transfer', args: [invoice.address, parseUnits(amount, 6)] }) as const
        const nonce = await chainClient.getTransactionCount({ address: payer.account.address })
        const first = await payer.writeContract({ ...args('6'), nonce })
        const second = await payer.writeContract({ ...args('7'), nonce: nonce + 1 })
        await chainClient.mine({ blocks: 1 })
        const receipts = await Promise.all([mined(first), mined(second)])
        expect(receipts[0].blockNumber).toBe(receipts[1].blockNumber)
      } finally {
        await chainClient.setAutomine(true)
      }
      await settle()
      await drainWebhooks()
      expect(eventsFor(invoice.id)).toHaveLength(1)
      expect(eventsFor(invoice.id)[0]!.data).toMatchObject({ amount: '13', transfers: [{ amount: '6' }, { amount: '7' }] })
    })

    it('ignores zero-value transfers and transfers of other tokens', async () => {
      const invoice = await createInvoice('noise')
      await tick()
      // Searched alongside a real one, the zero-value transfer is skipped.
      await pay(invoice.address, '0')
      const real = await pay(invoice.address, '2')
      await tick()
      expect((await getInvoice(invoice.id)).transfers.map((t) => t.tx_hash)).toEqual([real])
      await ctx.sql`delete from transfers where invoice_id = ${invoice.id}`
      await pay(invoice.address, '0')
      const fakeUsdt = await deploy('MockUSDT', [6])
      await mined(
        await deployer.writeContract({
          address: fakeUsdt,
          abi: usdtAbi,
          functionName: 'mint',
          args: [invoice.address, parseUnits('1000', 6)],
        }),
      )
      await settle()
      await drainWebhooks()
      expect((await getInvoice(invoice.id)).transfers).toEqual([])
      expect(eventsFor(invoice.id)).toHaveLength(0)
    })

    it('searches from the first block and confirms nothing on a chain shorter than the confirmation depth', async () => {
      // A token of its own, so only what this test sends is there to find.
      const young: ChainConfig = {
        ...chain,
        key: 'local-young',
        usdt: await deploy('MockUSDT', [6]),
        confirmations: 10n ** 12n,
        logRange: 10n ** 9n,
      }
      const invoice = await createInvoice('young-chain')
      await tick(young)
      await mined(
        await deployer.writeContract({
          address: young.usdt,
          abi: usdtAbi,
          functionName: 'mint',
          args: [invoice.address, parseUnits('20', 6)],
        }),
      )
      // The search starts at block 0, where the token did not exist yet; its logs are read instead.
      const { context, warnings } = recording()
      await watcherTick(context, young)
      expect(warnings).toHaveLength(1)
      const rows = await ctx.sql`select status from transfers where chain = 'local-young'`
      expect(rows.map((row) => row.status)).toEqual(['pending'])
      await ctx.sql`delete from transfers where chain = 'local-young'`
    })

    it('finds payments when the block range is scanned in small pieces', async () => {
      const invoice = await createInvoice('small-ranges')
      await pay(invoice.address, '11')
      await confirmBlocks()
      await tick({ ...chain, logRange: 2n })
      expect(await statuses(invoice.id)).toEqual(['confirmed'])
    })

    it('searches a new address back to before its invoice existed', async () => {
      // The first look at an address reaches back the invoice's age in blocks,
      // at MIN_BLOCK_MS a block, plus the confirmation depth.
      const invoice = await createInvoice('first-look')
      await pay(invoice.address, '12')
      await chainClient.mine({ blocks: 40 })
      const slowBlocks: ChainConfig = { ...chain, minBlockMs: 60_000 }

      // Guessing blocks too slow would look back too little; the payment is
      // not found, so the balance is not taken as accounted for.
      const { context, errors } = recording()
      await watcherTick(context, slowBlocks)
      expect(errors).toEqual([expect.objectContaining({ invoiceId: invoice.id })])
      expect(String((errors[0] as { err: Error }).err.message)).toMatch(/found 0 of the 12000000/)
      expect(await statuses(invoice.id)).toEqual([])
      const [state] = await ctx.sql`select 1 from watch_state where invoice_id = ${invoice.id}`
      expect(state).toBeUndefined()

      // A fast enough bound reaches it.
      await tick({ ...chain, minBlockMs: 1 })
      expect(await statuses(invoice.id)).toEqual(['confirmed'])
    })

    it('records a payment once though the next search covers its block again', async () => {
      // Each search reaches back the confirmation depth past the last look.
      const invoice = await createInvoice('covered-twice')
      await tick()
      const first = await pay(invoice.address, '3')
      await tick()
      const second = await pay(invoice.address, '8')
      await tick()
      expect((await getInvoice(invoice.id)).transfers.map((t) => t.tx_hash)).toEqual([first, second])
    })

    it('finds two payments made far apart between two passes', async () => {
      const invoice = await createInvoice('two-apart')
      await tick()
      const first = await pay(invoice.address, '6')
      await chainClient.mine({ blocks: 50 })
      const second = await pay(invoice.address, '7')
      await chainClient.mine({ blocks: 50 })
      await tick()
      await drainWebhooks()
      expect(eventsFor(invoice.id)[0]!.data).toMatchObject({ amount: '13', transfers: [{ tx_hash: first }, { tx_hash: second }] })
    })

    it('reads the logs instead when the RPC refuses past balances', async () => {
      const invoice = await createInvoice('no-history')
      await tick()
      await pay(invoice.address, '17')
      await chainClient.mine({ blocks: 30 })
      const { context, warnings } = recording()
      const methods = await withFault(
        (call) => (usdtCallTo(call) ? { error: { code: -32000, message: 'missing trie node' } } : undefined),
        () => rpcMethods(() => watcherTick(context, chain)),
      )
      expect(warnings.length).toBeGreaterThan(0)
      // The 36 or so blocks since the last look, ten at a time.
      expect(methods.filter((m) => m === 'eth_getLogs').length).toBeGreaterThanOrEqual(4)
      expect(await statuses(invoice.id)).toEqual(['confirmed'])
    })

    it('reads only logs when HISTORICAL_READS is off', async () => {
      const invoice = await createInvoice('history-off')
      const noHistory: ChainConfig = { ...chain, historicalReads: false }
      await tick(noHistory)
      await pay(invoice.address, '18')
      await chainClient.mine({ blocks: 30 })
      const methods = await rpcMethods(() => tick(noHistory))
      // The multicall at the tip is the only eth_call: no balance is read in the past.
      expect(methods.filter((m) => m === 'eth_call')).toHaveLength(1)
      expect(await statuses(invoice.id)).toEqual(['confirmed'])

      // And after a reorg asked for a fresh search, with no baseline at all.
      await ctx.sql`update watch_state set balance = null where invoice_id = ${invoice.id}`
      await tick(noHistory)
      expect(await statuses(invoice.id)).toEqual(['confirmed'])
      const [state] = await ctx.sql`select balance::text from watch_state where invoice_id = ${invoice.id}`
      expect(state!.balance).toBe('18000000')
    })

    it('does not take a balance as accounted for when the logs come back short', async () => {
      const invoice = await createInvoice('short-logs')
      await tick()
      await pay(invoice.address, '19')
      const { context, errors } = recording()
      // A node behind the one that answered the balance.
      await withFault(
        (call) => (call.method === 'eth_getLogs' ? { result: [] } : undefined),
        () => watcherTick(context, chain),
      )
      expect(errors).toHaveLength(1)
      expect(await statuses(invoice.id)).toEqual([])
      // The next pass searches the same blocks again and finds it.
      await tick()
      expect(await statuses(invoice.id)).toEqual(['pending'])
    })

    it('counts only what arrived since the last look when the logs come back short without past balances', async () => {
      // The search re-reads the confirmation depth before the last look, so the
      // logs include a payment already counted. It must not stand in for the new one.
      const noHistory: ChainConfig = { ...chain, historicalReads: false }
      const invoice = await createInvoice('short-logs-no-history')
      await tick(noHistory)
      const first = await pay(invoice.address, '10')
      await tick(noHistory)
      const firstBlock = (await chainClient.getTransactionReceipt({ hash: first })).blockNumber
      // As the node sends them, for the stand-in to send on.
      const { result: firstLogs } = await (
        await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getLogs',
            params: [{ address: usdt, fromBlock: toHex(firstBlock), toBlock: toHex(firstBlock) }],
          }),
        })
      ).json()
      await pay(invoice.address, '10')

      // A node behind the one that answered the balance: it has the first payment, not the second.
      const { context, errors } = recording()
      await withFault(
        (call) => {
          if (call.method !== 'eth_getLogs') return undefined
          const { fromBlock, toBlock } = call.params[0] as { fromBlock: Hex; toBlock: Hex }
          return { result: BigInt(fromBlock) <= firstBlock && firstBlock <= BigInt(toBlock) ? firstLogs : [] }
        },
        () => watcherTick(context, noHistory),
      )
      expect(errors).toEqual([expect.objectContaining({ invoiceId: invoice.id })])
      const [state] = await ctx.sql`select balance::text from watch_state where invoice_id = ${invoice.id}`
      expect(state!.balance).toBe('10000000')

      await tick(noHistory)
      expect(await statuses(invoice.id)).toEqual(['pending', 'pending'])
    })

    it('finds a payment to a live address someone flushed, though its balance is back where it was', async () => {
      const invoice = await createInvoice('flushed-live')
      await tick()
      await pay(invoice.address, '10')
      await tick()
      await flush(invoice.id)
      const second = await pay(invoice.address, '10')
      expect(await usdtBalance(invoice.address)).toBe(parseUnits('10', 6))

      // The same balance as at the last look; the logs say otherwise.
      await tick()
      expect((await getInvoice(invoice.id)).transfers.map((t) => t.tx_hash)).toContain(second)
      expect(await statuses(invoice.id)).toEqual(['pending', 'pending'])

      // Once it has stopped being read every poll, it costs nothing again.
      await expire(invoice.id, 1)
      await tick()
      await confirmBlocks()
      expect((await rpcMethods(() => tick())).filter((m) => m === 'eth_getLogs')).toEqual([])
      expect(await statuses(invoice.id)).toEqual(['confirmed', 'confirmed'])
    })

    it('picks up a payment made while the watcher was not running', async () => {
      const invoice = await createInvoice('downtime')
      await tick()
      await pay(invoice.address, '15')
      await chainClient.mine({ blocks: 40 })
      await tick()
      await drainWebhooks()
      expect(eventsFor(invoice.id).map((e) => e.data.amount)).toEqual(['15'])
    })

    it('lists transfers, newest first, with optional filters', async () => {
      const list = async (query: string) =>
        (await app.inject({ url: `/v1/transfers${query}`, headers: AUTH })).json().data as InvoiceJson['transfers']
      const invoice = await createInvoice('listing')
      const credited = await pay(invoice.address, '10')
      await settle()
      const pending = await pay(invoice.address, '1')
      await tick()

      const all = await list('')
      expect(all.slice(0, 2).map((t) => t.tx_hash)).toEqual([pending, credited])
      expect(all.length).toBeGreaterThan(2)
      expect(await list('?limit=1')).toHaveLength(1)
      expect((await list('?status=pending')).map((t) => t.tx_hash)).toEqual([pending])
      expect((await list('?credited=true&limit=200')).every((t) => t.credited)).toBe(true)
      expect((await list('?credited=true&limit=1'))[0]!.tx_hash).toBe(credited)
      expect((await list('?credited=false&limit=200')).some((t) => t.credited)).toBe(false)
      expect(await list('?chain=arbitrum')).toEqual([])
      expect((await list('?chain=local&status=confirmed&credited=true&limit=1'))[0]!.tx_hash).toBe(credited)

      await confirmBlocks()
      await tick()
    })

    it('confirming the same transfer twice credits it once', async () => {
      const invoice = await createInvoice('double-confirm')
      await pay(invoice.address, '20')
      await tick()
      const [row] = await ctx.sql<{ id: string }[]>`select id from transfers where invoice_id = ${invoice.id}`
      await Promise.all([confirmTransfer(ctx, chain, row!), confirmTransfer(ctx, chain, row!)])
      await confirmTransfer(ctx, chain, row!)
      await drainWebhooks()
      expect(eventsFor(invoice.id)).toHaveLength(1)
      const events = await ctx.sql`
        select 1 from webhook_deliveries where payload->'data'->>'invoice_id' = ${invoice.id}`
      expect(events).toHaveLength(1)
    })
  })

  describe('reorgs', () => {
    it('does not credit a transfer that is reorged out', async () => {
      const invoice = await createInvoice('reorg-out')
      const snapshot = await chainClient.snapshot()
      await pay(invoice.address, '50')
      await tick()
      expect(await statuses(invoice.id)).toEqual(['pending'])

      // Replace the block holding the payment with a different chain of blocks.
      await chainClient.revert({ id: snapshot })
      await chainClient.mine({ blocks: Number(chain.confirmations) + 3 })
      await tick()

      expect(await statuses(invoice.id)).toEqual(['orphaned'])
      // The customer no longer sees it.
      expect((await app.inject({ url: `/checkout/${invoice.id}/status` })).json()).toEqual({ expired: false, transfers: [] })
      // The address is searched again, finds nothing, and is settled at nothing.
      await tick()
      const [state] = await ctx.sql`select balance::text from watch_state where invoice_id = ${invoice.id}`
      expect(state!.balance).toBe('0')
      await drainWebhooks()
      expect(eventsFor(invoice.id)).toHaveLength(0)
      // Nor is it ever treated as swept.
      await sweepTick(ctx, chain)
      const [orphan] = await ctx.sql`select swept_at from transfers where invoice_id = ${invoice.id}`
      expect(orphan!.swept_at).toBeNull()
    })

    it('credits once when an orphaned transaction is mined again later', async () => {
      const invoice = await createInvoice('reorg-back')
      const snapshot = await chainClient.snapshot()
      const raw = await signTransfer(invoice.address, '18')
      const hash = await broadcast(raw)
      await tick()

      await chainClient.revert({ id: snapshot })
      await chainClient.mine({ blocks: Number(chain.confirmations) + 1 })
      await tick()
      expect(await statuses(invoice.id)).toEqual(['orphaned'])

      expect(await broadcast(raw)).toBe(hash)
      await tick()
      expect(await statuses(invoice.id)).toEqual(['pending'])
      await confirmBlocks()
      await tick()
      await drainWebhooks()

      expect(await getInvoice(invoice.id)).toMatchObject({ transfers: [{ tx_hash: hash, status: 'confirmed', credited: true }] })
      expect(eventsFor(invoice.id).map((e) => e.data.amount)).toEqual(['18'])
    })

    it('finds a payment that a reorg put under the last look', async () => {
      const invoice = await createInvoice('reorg-under')
      const snapshot = await chainClient.snapshot()
      await chainClient.mine({ blocks: 3 })
      await tick()

      // The blocks the last look saw are replaced by ones holding a payment.
      await chainClient.revert({ id: snapshot })
      const hash = await pay(invoice.address, '9')
      await chainClient.mine({ blocks: 2 })
      await tick()
      expect((await getInvoice(invoice.id)).transfers).toMatchObject([{ tx_hash: hash }])
    })

    it('follows a pending transfer that moves to a different block', async () => {
      const invoice = await createInvoice('reorg-moved')
      const snapshot = await chainClient.snapshot()
      const raw = await signTransfer(invoice.address, '19')
      const hash = await broadcast(raw)
      await tick()
      const [before] = await ctx.sql`select block_number, block_hash from transfers where tx_hash = ${hash}`

      await chainClient.revert({ id: snapshot })
      await chainClient.mine({ blocks: 1 })
      await broadcast(raw)
      // Same balance, so nothing looks different until the old block is deep
      // enough to check: then the transfer is orphaned and the address searched again.
      await tick()
      await confirmBlocks()
      await tick()
      expect(await statuses(invoice.id)).toEqual(['orphaned'])
      await tick()

      const [after] = await ctx.sql`select block_number, block_hash, status from transfers where tx_hash = ${hash}`
      expect(after!.status).toBe('confirmed')
      expect(after!.block_number).toBe((before!.block_number as bigint) + 1n)
      expect(after!.block_hash).not.toBe(before!.block_hash)
      await drainWebhooks()
      expect(await ctx.sql`select 1 from transfers where invoice_id = ${invoice.id}`).toHaveLength(1)
      expect(eventsFor(invoice.id).map((e) => e.data.amount)).toEqual(['19'])
    })
  })

  describe('webhook delivery', () => {
    const deliveryOf = async (invoiceId: string) => {
      const [row] = await ctx.sql`
        select id, attempts, last_error, delivered_at, next_attempt_at > now() as scheduled_later
        from webhook_deliveries where payload->'data'->>'invoice_id' = ${invoiceId}`
      return row!
    }

    it('requires a webhook URL and secret', async () => {
      await expect(dispatchTick(withConfig({ webhookUrl: undefined }))).rejects.toThrow('WEBHOOK_URL and WEBHOOK_SECRET')
      await expect(dispatchTick(withConfig({ webhookSecret: undefined }))).rejects.toThrow('WEBHOOK_URL and WEBHOOK_SECRET')
    })

    it('retries later when the receiver answers with an error', async () => {
      const invoice = await createInvoice('receiver-500')
      await pay(invoice.address, '10')
      await settle()

      receiverStatus = 500
      try {
        expect(await dispatchTick(ctx)).toBe(1)
      } finally {
        receiverStatus = 204
      }
      expect(await deliveryOf(invoice.id)).toMatchObject({
        attempts: 1,
        last_error: 'HTTP 500',
        delivered_at: null,
        scheduled_later: true,
      })
      // Not due yet, so nothing is sent.
      expect(await dispatchTick(ctx)).toBe(0)
      expect(eventsFor(invoice.id)).toHaveLength(0)

      await ctx.sql`update webhook_deliveries set next_attempt_at = now() where delivered_at is null`
      await drainWebhooks()
      expect(eventsFor(invoice.id)).toHaveLength(1)
      const delivered = await deliveryOf(invoice.id)
      expect(delivered).toMatchObject({ attempts: 2, last_error: null })
      expect(delivered.delivered_at).not.toBeNull()
    })

    it('retries later when the receiver is unreachable, and gives up after 20 attempts', async () => {
      const invoice = await createInvoice('receiver-down')
      await pay(invoice.address, '10')
      await settle()

      const unreachable = withConfig({ webhookUrl: 'http://127.0.0.1:1/hook' })
      expect(await dispatchTick(unreachable)).toBe(1)
      const failed = await deliveryOf(invoice.id)
      expect(failed).toMatchObject({ attempts: 1, delivered_at: null, scheduled_later: true })
      expect(failed.last_error).toMatch(/fetch failed/)

      await ctx.sql`update webhook_deliveries set attempts = 20, next_attempt_at = now() where id = ${failed.id}`
      expect(await dispatchTick(ctx)).toBe(0)
      expect(eventsFor(invoice.id)).toHaveLength(0)

      // Left clean for later tests.
      await ctx.sql`update webhook_deliveries set attempts = 1 where id = ${failed.id}`
      await drainWebhooks()
      expect(eventsFor(invoice.id)).toHaveLength(1)
    })
  })

  describe('sweeper', () => {
    const transferRow = async (invoiceId: string) => {
      const [row] = await ctx.sql`
        select swept_at, swept_tx_hash, sweep_error from transfers where invoice_id = ${invoiceId}`
      return row!
    }
    async function confirmedInvoice(reference: string, amount: string): Promise<InvoiceJson> {
      const invoice = await createInvoice(reference)
      await pay(invoice.address, amount)
      await settle()
      await finish(invoice.id)
      return invoice
    }

    it('requires a sweeper key', async () => {
      await expect(sweepTick(withConfig({ sweeperPrivateKey: undefined }), chain)).rejects.toThrow('SWEEPER_PRIVATE_KEY')
    })

    it('does nothing when there is nothing to sweep', async () => {
      await sweepTick(ctx, chain)
      expect(await sweepTick(ctx, chain)).toBeUndefined()
    })

    it('sweeps transfers below the minimum too', async () => {
      const destinationBefore = await usdtBalance(DESTINATION)
      const invoice = await confirmedInvoice('sweep-small', '3')
      expect(await sweepTick(ctx, chain)).toBeDefined()
      expect(await usdtBalance(DESTINATION)).toBe(destinationBefore + parseUnits('3', 6))
      expect((await getInvoice(invoice.id)).transfers[0]).toMatchObject({ credited: false })
      expect((await transferRow(invoice.id)).swept_at).not.toBeNull()
    })

    it('postpones the sweep while gas is above the cap', async () => {
      const invoice = await confirmedInvoice('gas-cap', '10')
      expect(await sweepTick(ctx, { ...chain, maxGasPriceWei: 0n })).toBeUndefined()
      expect(await usdtBalance(invoice.address)).toBe(parseUnits('10', 6))
      expect((await transferRow(invoice.id)).swept_at).toBeNull()

      expect(await sweepTick(ctx, { ...chain, maxGasPriceWei: parseGwei('1000000') })).toBeDefined()
      expect(await usdtBalance(invoice.address)).toBe(0n)
    })

    it('sweeps at most one batch per pass', async () => {
      const a = await confirmedInvoice('batch-a', '10')
      const b = await confirmedInvoice('batch-b', '10')
      const oneAtATime = withConfig({ sweepBatchSize: 1 })

      expect(await sweepTick(oneAtATime, chain)).toBeDefined()
      const afterFirst = [await usdtBalance(a.address), await usdtBalance(b.address)]
      expect(afterFirst.filter((balance) => balance === 0n)).toHaveLength(1)

      expect(await sweepTick(oneAtATime, chain)).toBeDefined()
      expect(await usdtBalance(a.address)).toBe(0n)
      expect(await usdtBalance(b.address)).toBe(0n)
      expect(await sweepTick(oneAtATime, chain)).toBeUndefined()
    })

    it('leaves an address alone while the watcher still reads it', async () => {
      // Emptying a watched address could hide a payment that lands in the same
      // pass: the balance would read as before, and the watcher would look no further.
      const invoice = await createInvoice('still-watched')
      await pay(invoice.address, '10')
      await settle()
      expect(await sweepTick(ctx, chain)).toBeUndefined()

      // A later payment is still found, as the address was not emptied.
      const later = await pay(invoice.address, '11')
      await expire(invoice.id, 3600)
      expect(await sweepTick(ctx, chain)).toBeUndefined()
      await latePass()
      await confirmBlocks()
      await tick()
      await drainWebhooks()
      expect(eventsFor(invoice.id).map((e) => e.data.transfers.map((t) => t.tx_hash))).toEqual([
        [expect.any(String)],
        [later],
      ])
      expect(await usdtBalance(invoice.address)).toBe(parseUnits('21', 6))

      // Once it is done with the address, both go in one sweep.
      await finish(invoice.id)
      const sweepTx = await sweepTick(ctx, chain)
      expect(await usdtBalance(invoice.address)).toBe(0n)
      const rows = await ctx.sql`select swept_tx_hash from transfers where invoice_id = ${invoice.id}`
      expect(rows.map((row) => row.swept_tx_hash)).toEqual([sweepTx, sweepTx])
    })

    it('sweeps an address the watcher never saved once it is past the horizon', async () => {
      const invoice = await createInvoice('unsaved')
      await pay(invoice.address, '10')
      await settle()
      await ctx.sql`delete from watch_state where invoice_id = ${invoice.id}`
      await expire(invoice.id, ctx.config.lateWindowSeconds + 60)
      expect(await sweepTick(ctx, chain)).toBeUndefined()
      await expire(invoice.id, watchHorizonSeconds(ctx.config) + 60)
      expect(await sweepTick(ctx, chain)).toBeDefined()
    })

    it("waits for a reorg's search again before sweeping", async () => {
      const invoice = await confirmedInvoice('recheck-pending', '10')
      await ctx.sql`update watch_state set balance = null where invoice_id = ${invoice.id}`
      expect(await sweepTick(ctx, chain)).toBeUndefined()
      await latePass()
      expect(await sweepTick(ctx, chain)).toBeDefined()
    })

    it('marks an address someone else already flushed, and sweeps the rest', async () => {
      const flushed = await confirmedInvoice('flushed-elsewhere', '10')
      const funded = await confirmedInvoice('still-funded', '10')
      await flush(flushed.id)

      const sweepTx = await sweepTick(ctx, chain)
      expect(sweepTx).toBeDefined()
      expect(await transferRow(funded.id)).toMatchObject({ swept_tx_hash: sweepTx })
      const marked = await transferRow(flushed.id)
      expect(marked.swept_at).not.toBeNull()
      expect(marked.swept_tx_hash).toBeNull()

      // When every address in the batch was flushed already, no transaction is sent.
      const alone = await confirmedInvoice('flushed-alone', '10')
      await flush(alone.id)
      expect(await sweepTick(ctx, chain)).toBeUndefined()
      expect((await transferRow(alone.id)).swept_at).not.toBeNull()
    })

    it('parks a frozen address without blocking the rest of the batch', async () => {
      const destinationBefore = await usdtBalance(DESTINATION)
      const frozen = await createInvoice('frozen')
      const healthy = await createInvoice('healthy')
      await pay(frozen.address, '10')
      await pay(healthy.address, '20')
      const setFrozen = async (value: boolean) =>
        mined(
          await deployer.writeContract({
            address: usdt,
            abi: usdtAbi,
            functionName: 'setFrozen',
            args: [frozen.address, value],
          }),
        )
      await setFrozen(true)
      await settle()
      await finish(frozen.id)
      await finish(healthy.id)

      const sweepTx = await sweepTick(ctx, chain)
      expect(await usdtBalance(DESTINATION)).toBe(destinationBefore + parseUnits('20', 6))
      expect(await usdtBalance(frozen.address)).toBe(parseUnits('10', 6))
      expect(await transferRow(frozen.id)).toMatchObject({ swept_at: null, sweep_error: `flush failed in ${sweepTx}` })
      // Parked transfers are not retried, so the sweeper stops spending gas on them.
      expect(await sweepTick(ctx, chain)).toBeUndefined()

      // A batch holding only a frozen address is parked again rather than marked swept.
      await ctx.sql`update transfers set sweep_error = null where invoice_id = ${frozen.id}`
      expect(await sweepTick(ctx, chain)).toBeDefined()
      expect((await transferRow(frozen.id)).sweep_error).toMatch(/flush failed/)

      // Once unfrozen and cleared by an operator, it sweeps normally.
      await setFrozen(false)
      await ctx.sql`update transfers set sweep_error = null where invoice_id = ${frozen.id}`
      expect(await sweepTick(ctx, chain)).toBeDefined()
      expect(await usdtBalance(DESTINATION)).toBe(destinationBefore + parseUnits('30', 6))
      expect((await transferRow(frozen.id)).swept_at).not.toBeNull()
    })

    it('fails the pass when the sweep transaction reverts, and recovers on the next one', async () => {
      const invoice = await confirmedInvoice('sweep-reverts', '10')
      const factoryCode = await chainClient.getCode({ address: ctx.config.factory })
      await chainClient.setAutomine(false)
      try {
        const pass = sweepTick(ctx, chain)
        pass.catch(() => {})
        await waitFor(async () => (await chainClient.getTxpoolStatus()).pending > 0, 'the sweep transaction')
        // Make the already-submitted transaction revert when it is mined.
        await chainClient.setCode({ address: ctx.config.factory, bytecode: '0x60006000fd' })
        await chainClient.mine({ blocks: 1 })
        await expect(pass).rejects.toThrow(/reverted/)
      } finally {
        await chainClient.setCode({ address: ctx.config.factory, bytecode: factoryCode! })
        await chainClient.setAutomine(true)
      }
      expect((await transferRow(invoice.id)).swept_at).toBeNull()
      expect(await usdtBalance(invoice.address)).toBe(parseUnits('10', 6))

      expect(await sweepTick(ctx, chain)).toBeDefined()
      expect(await usdtBalance(invoice.address)).toBe(0n)
    })
  })

  describe('process roles', () => {
    it('migrate applies migrations and returns', async () => {
      await run('migrate', ctx, new AbortController().signal)
    })

    it('api serves HTTP until shut down', async () => {
      const shutdown = new AbortController()
      const running = run('api', ctx, shutdown.signal)
      await waitFor(
        () => fetch('http://127.0.0.1:18473/healthz').then((r) => r.ok, () => false),
        'the API to listen',
      )
      shutdown.abort()
      await running
      await expect(fetch('http://127.0.0.1:18473/healthz')).rejects.toThrow()
    })

    it('a worker role exits straight away when already shut down', async () => {
      for (const role of ['watcher', 'dispatcher', 'sweeper'] as const) {
        await run(role, ctx, AbortSignal.abort())
      }
    })

    it('all runs every role together: detect, confirm, notify and sweep', async () => {
      const shutdown = new AbortController()
      const running = run('all', withConfig({ sweepIntervalMs: 200, lateWindowSeconds: 0 }), shutdown.signal)
      try {
        await waitFor(
          () => fetch('http://127.0.0.1:18473/readyz').then((r) => r.ok, () => false),
          'the API to listen',
        )
        const created = await fetch('http://127.0.0.1:18473/v1/invoices', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ reference: 'all-in-one' }),
        })
        const invoice = (await created.json()) as InvoiceJson
        await pay(invoice.address, '21')
        await confirmBlocks()
        await waitFor(async () => eventsFor(invoice.id).length === 1, 'the webhook')
        // With no late window, the look after expiry is the last, and the sweep follows.
        expect(await usdtBalance(invoice.address)).toBe(parseUnits('21', 6))
        await expire(invoice.id, 0)
        await waitFor(async () => (await usdtBalance(invoice.address)) === 0n, 'the sweep')
        await waitFor(async () => (await getInvoice(invoice.id)).transfers[0]!.swept_at !== null, 'the sweep to be recorded')
        expect(eventsFor(invoice.id)[0]!.data.amount).toBe('21')
      } finally {
        shutdown.abort()
        await running
      }
    })
  })

  // main.ts is process wiring, so it is exercised as a real process.
  describe('entrypoint', () => {
    const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts')

    function start(args: string[], env: Record<string, string> = {}) {
      const child = spawn(process.execPath, [MAIN, ...args], {
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: ctx.config.databaseUrl,
          API_KEY,
          FORWARDER_FACTORY_ADDRESS: ctx.config.factory,
          CHAINS: 'local',
          USDT_ADDRESS_LOCAL: usdt,
          RPC_URLS_LOCAL: RPC_URL,
          PORT: '18474',
          LOG_LEVEL: 'info',
          ...env,
        },
      })
      let output = ''
      child.stdout.on('data', (chunk) => (output += chunk))
      child.stderr.on('data', (chunk) => (output += chunk))
      const exited = new Promise<{ code: number | null; output: string }>((resolve) =>
        child.on('exit', (code) => resolve({ code, output })),
      )
      return { child, exited }
    }

    it('rejects an unknown role with a usage message', async () => {
      const { code, output } = await start(['bogus']).exited
      expect(code).toBe(2)
      expect(output).toContain('Usage: main <api|watcher|dispatcher|sweeper|migrate|all>')
    })

    it('exits with an error when configuration is missing', async () => {
      const { code, output } = await start(['api'], { CHAINS: '' }).exited
      expect(code).toBe(1)
      expect(output).toContain('Missing required environment variable CHAINS')
    })

    it('runs migrate to completion', async () => {
      const { code, output } = await start(['migrate']).exited
      expect(code).toBe(0)
      expect(output).toContain('migrations up to date')
    })

    it('defaults to the api role and shuts down cleanly on SIGTERM', async () => {
      const { child, exited } = start([])
      await waitFor(
        () => fetch('http://127.0.0.1:18474/readyz').then((r) => r.ok, () => false),
        'the API process to listen',
      )
      child.kill('SIGTERM')
      const { code, output } = await exited
      expect(code).toBe(0)
      expect(output).toContain('"role":"api"')
      expect(output).toContain('shutting down')
    })
  })
})
