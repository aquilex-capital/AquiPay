// End-to-end flow against a local chain and database.
// Needs `docker compose up -d` and `npm run contracts:build` first.
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pino } from 'pino'
import postgres from 'postgres'
import {
  createTestClient,
  createWalletClient,
  http,
  parseUnits,
  publicActions,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildServer } from '../src/api/server.ts'
import { loadConfig, type ChainConfig } from '../src/config.ts'
import type { Context } from '../src/context.ts'
import { connect, migrate } from '../src/db.ts'
import { dispatchTick, verifySignature } from '../src/dispatcher.ts'
import { factoryAbi } from '../src/forwarder.ts'
import { sweepTick } from '../src/sweeper.ts'
import { AddressBook, watcherTick } from '../src/watcher.ts'

const RPC_URL = process.env.TEST_RPC_URL ?? 'http://127.0.0.1:8545'
const PG_URL = process.env.TEST_PG_URL ?? 'postgres://aquipay:aquipay@127.0.0.1:54329'
const TEST_DB = 'aquipay_test'
const API_KEY = 'test-api-key'
const WEBHOOK_SECRET = 'test-webhook-secret'

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

const usdtArtifact = artifact('MockUSDT')
const chainClient = createTestClient({ chain: foundry, mode: 'anvil', transport: http(RPC_URL) }).extend(publicActions)
const deployer = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain: foundry, transport: http(RPC_URL) })
const payer = createWalletClient({ account: privateKeyToAccount(PAYER_KEY), chain: foundry, transport: http(RPC_URL) })

async function deploy(name: string, args: unknown[]): Promise<Address> {
  const { abi, bytecode } = artifact(name)
  const hash = await deployer.deployContract({ abi, bytecode, args })
  const receipt = await chainClient.waitForTransactionReceipt({ hash })
  return receipt.contractAddress!
}

interface Received {
  body: string
  signature: string
  payload: { id: string; type: string; data: Record<string, unknown> }
}

describe('top-up flow', () => {
  let ctx: Context
  let chain: ChainConfig
  let usdt: Address
  let app: ReturnType<typeof buildServer>
  let receiver: Server
  const received: Received[] = []
  const book = new AddressBook()

  const usdtBalance = (address: Address) =>
    chainClient.readContract({ address: usdt, abi: usdtArtifact.abi, functionName: 'balanceOf', args: [address] })

  async function pay(to: Address, amount: string): Promise<Hex> {
    const hash = await payer.writeContract({
      address: usdt,
      abi: usdtArtifact.abi,
      functionName: 'transfer',
      args: [to, parseUnits(amount, 6)],
    })
    await chainClient.waitForTransactionReceipt({ hash })
    return hash
  }

  async function createInvoice(reference: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { reference, metadata: { plan: 'pro' } },
    })
    expect(response.statusCode).toBe(201)
    return response.json() as { id: string; address: Address; checkout_url: string }
  }

  async function getInvoice(id: string) {
    const response = await app.inject({ url: `/v1/invoices/${id}`, headers: { authorization: `Bearer ${API_KEY}` } })
    return response.json() as { transfers: { amount: string; status: string; credited: boolean; swept_tx_hash: string | null }[] }
  }

  const tick = () => watcherTick(ctx, chain, book)
  const confirmBlocks = () => chainClient.mine({ blocks: Number(chain.confirmations) })
  async function drainWebhooks() {
    while ((await dispatchTick(ctx)) > 0);
  }

  beforeAll(async () => {
    const admin = postgres(`${PG_URL}/postgres`, { onnotice: () => {} })
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`)
    await admin.unsafe(`create database ${TEST_DB}`)
    await admin.end()

    usdt = await deploy('MockUSDT', [6])
    const factory = await deploy('ForwarderFactory', [DESTINATION])
    const mint = await deployer.writeContract({
      address: usdt,
      abi: usdtArtifact.abi,
      functionName: 'mint',
      args: [payer.account.address, parseUnits('1000', 6)],
    })
    await chainClient.waitForTransactionReceipt({ hash: mint })

    receiver = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        received.push({ body, signature: String(req.headers['x-aquipay-signature']), payload: JSON.parse(body) })
        res.writeHead(204).end()
      })
    })
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))

    const config = loadConfig({
      DATABASE_URL: `${PG_URL}/${TEST_DB}`,
      API_KEY,
      WEBHOOK_URL: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`,
      WEBHOOK_SECRET,
      FORWARDER_FACTORY_ADDRESS: factory,
      CHAINS: 'local',
      USDT_ADDRESS_LOCAL: usdt,
      RPC_URLS_LOCAL: RPC_URL,
      CONFIRMATIONS_LOCAL: '5',
      SWEEPER_PRIVATE_KEY: SWEEPER_KEY,
    })
    chain = config.chains[0]!
    const sql = connect(config.databaseUrl)
    await migrate(sql)
    ctx = { config, sql, log: pino({ level: 'silent' }) }
    app = buildServer(ctx)
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
    await ctx?.sql.end()
    receiver?.close()
  })

  it('rejects requests without the API key', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/invoices', payload: { reference: 'x' } })
    expect(response.statusCode).toBe(401)
  })

  it('predicts the same addresses as the contract', async () => {
    const onChainImplementation = await chainClient.readContract({
      address: ctx.config.factory,
      abi: factoryAbi,
      functionName: 'implementation',
    })
    expect(ctx.config.implementation).toBe(onChainImplementation)

    const invoice = await createInvoice('address-check')
    const [row] = await ctx.sql<{ salt: Hex }[]>`select salt from invoices where id = ${invoice.id}`
    const onChainAddress = await chainClient.readContract({
      address: ctx.config.factory,
      abi: factoryAbi,
      functionName: 'forwarderAddress',
      args: [row!.salt],
    })
    expect(invoice.address).toBe(onChainAddress)
  })

  it('credits a top-up, holds a small transfer until the total reaches the minimum, and sweeps both', async () => {
    const invoice = await createInvoice('user-42')
    const topupTx = await pay(invoice.address, '25.5')
    await pay(invoice.address, '5')

    await tick()
    expect((await getInvoice(invoice.id)).transfers.map((t) => t.status)).toEqual(['pending', 'pending'])
    await drainWebhooks()
    expect(received).toHaveLength(0)

    await confirmBlocks()
    await tick()
    await tick() // a repeated pass must not credit twice
    expect((await getInvoice(invoice.id)).transfers).toMatchObject([
      { amount: '25.5', status: 'confirmed', credited: true },
      { amount: '5', status: 'confirmed', credited: false },
    ])

    await drainWebhooks()
    expect(received).toHaveLength(1)
    const [hook] = received
    expect(verifySignature(WEBHOOK_SECRET, hook!.body, hook!.signature)).toBe(true)
    expect(verifySignature('wrong-secret', hook!.body, hook!.signature)).toBe(false)
    expect(hook!.payload).toMatchObject({
      type: 'topup.confirmed',
      data: {
        invoice_id: invoice.id,
        reference: 'user-42',
        metadata: { plan: 'pro' },
        chain: 'local',
        currency: 'USDT',
        amount: '25.5',
        transfers: [{ tx_hash: topupTx, amount: '25.5' }],
      },
    })

    const sweepTx = await sweepTick(ctx, chain)
    expect(sweepTx).toBeDefined()
    expect(await usdtBalance(DESTINATION)).toBe(parseUnits('30.5', 6))
    expect(await usdtBalance(invoice.address)).toBe(0n)
    expect((await getInvoice(invoice.id)).transfers.every((t) => t.swept_tx_hash === sweepTx)).toBe(true)
    expect(await sweepTick(ctx, chain)).toBeUndefined()

    // The address keeps working after its forwarder is deployed.
    await pay(invoice.address, '12')
    await tick()
    await confirmBlocks()
    await tick()
    await drainWebhooks()
    expect(received).toHaveLength(2)
    // The earlier 5 USDT was waiting; 5 + 12 crosses the minimum and is credited as one top-up.
    expect(received[1]!.payload.data).toMatchObject({ amount: '17', transfers: [{ amount: '5' }, { amount: '12' }] })
    expect((await getInvoice(invoice.id)).transfers.every((t) => t.credited)).toBe(true)
    await sweepTick(ctx, chain)
    expect(await usdtBalance(DESTINATION)).toBe(parseUnits('42.5', 6))
  })

  it('does not credit a transfer that is reorged out', async () => {
    const before = received.length
    const invoice = await createInvoice('reorg')
    const snapshot = await chainClient.snapshot()
    await pay(invoice.address, '50')
    await tick()
    expect((await getInvoice(invoice.id)).transfers.map((t) => t.status)).toEqual(['pending'])

    // Replace the block holding the payment with a different chain of blocks.
    await chainClient.revert({ id: snapshot })
    await chainClient.mine({ blocks: Number(chain.confirmations) + 3 })
    await tick()

    expect((await getInvoice(invoice.id)).transfers.map((t) => t.status)).toEqual(['orphaned'])
    await drainWebhooks()
    expect(received).toHaveLength(before)
  })

  it('parks a frozen address without blocking the rest of the batch', async () => {
    const destinationBefore = (await usdtBalance(DESTINATION)) as bigint
    const frozen = await createInvoice('frozen')
    const healthy = await createInvoice('healthy')
    await pay(frozen.address, '10')
    await pay(healthy.address, '20')
    const freeze = await deployer.writeContract({
      address: usdt,
      abi: usdtArtifact.abi,
      functionName: 'setFrozen',
      args: [frozen.address, true],
    })
    await chainClient.waitForTransactionReceipt({ hash: freeze })
    await tick()
    await confirmBlocks()
    await tick()

    await sweepTick(ctx, chain)

    expect(await usdtBalance(DESTINATION)).toBe(destinationBefore + parseUnits('20', 6))
    expect(await usdtBalance(frozen.address)).toBe(parseUnits('10', 6))
    const [parked] = await ctx.sql`select sweep_error from transfers where invoice_id = ${frozen.id}`
    expect(parked!.sweep_error).toMatch(/flush failed/)
    // Parked transfers are not retried, so the sweeper stops spending gas on them.
    expect(await sweepTick(ctx, chain)).toBeUndefined()
  })

  it('serves the checkout page and its status feed', async () => {
    const invoice = await createInvoice('checkout')
    const page = await app.inject({ url: `/checkout/${invoice.id}` })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain(invoice.address)
    expect(page.headers['content-security-policy']).toContain("default-src 'none'")

    const status = await app.inject({ url: `/checkout/${invoice.id}/status` })
    expect(status.json()).toEqual({ transfers: [] })
    const missing = await app.inject({ url: '/checkout/not-a-uuid' })
    expect(missing.statusCode).toBe(404)
    expect(missing.body).toContain("This top-up link doesn't work")
    expect((await app.inject({ url: '/assets/fonts/jetbrains-mono.woff2' })).headers['content-type']).toBe('font/woff2')
  })
})
