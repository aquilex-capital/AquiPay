// Tests that need neither a chain nor a database.
import { parseGwei } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderCheckout, renderNotFound } from '../src/api/checkout.ts'
import { isRole, loop } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { rpcTransport, type Context } from '../src/context.ts'
import { signPayload, verifySignature } from '../src/dispatcher.ts'
import { forwarderAddress, implementationAddress, invoiceSalt } from '../src/forwarder.ts'
import { trimAmount } from '../src/watcher.ts'

const FACTORY = '0x8b12bEfA9826d5c2295256d1DB89c4b36ED3E90d'
const BASE_ENV = {
  DATABASE_URL: 'postgres://localhost/aquipay',
  FORWARDER_FACTORY_ADDRESS: FACTORY,
  CHAINS: 'arbitrum',
}

describe('loadConfig', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('applies defaults', () => {
    const config = loadConfig(BASE_ENV)
    expect(config).toMatchObject({
      port: 8080,
      publicBaseUrl: 'http://localhost:8080',
      sweepIntervalMs: 3_600_000,
      sweepBatchSize: 50,
      apiKey: undefined,
      sweeperPrivateKey: undefined,
    })
    expect(config.implementation).toBe(implementationAddress(FACTORY))
    expect(config.chains).toHaveLength(1)
    expect(config.chains[0]).toMatchObject({
      key: 'arbitrum',
      name: 'Arbitrum One',
      usdt: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      decimals: 6,
      confirmations: 60n,
      minTopup: '10',
      minTopupRaw: 10_000_000n,
      logRange: 1000n,
      rpcUrls: [],
      maxGasPriceWei: undefined,
    })
  })

  it('reads process.env when called without arguments', () => {
    for (const [name, value] of Object.entries(BASE_ENV)) vi.stubEnv(name, value)
    vi.stubEnv('PORT', '9090')
    expect(loadConfig().port).toBe(9090)
  })

  it('pins each chain to its own USDT contract, decimals and minimum', () => {
    const config = loadConfig({ ...BASE_ENV, CHAINS: ' Ethereum, arbitrum ,optimism,polygon,bsc,' })
    const byKey = Object.fromEntries(config.chains.map((chain) => [chain.key, chain]))
    expect(Object.keys(byKey)).toEqual(['ethereum', 'arbitrum', 'optimism', 'polygon', 'bsc'])
    expect(byKey.ethereum).toMatchObject({ usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7', minTopup: '20', minTopupRaw: 20_000_000n })
    expect(byKey.optimism!.usdt).toBe('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58')
    expect(byKey.polygon!.usdt).toBe('0xc2132D05D31c914a87C6611C10748AEb04B58e8F')
    // BSC USDT has 18 decimals, so its 10 USDT minimum is a much larger raw number.
    expect(byKey.bsc).toMatchObject({
      usdt: '0x55d398326f99059fF775485246999027B3197955',
      decimals: 18,
      minTopupRaw: 10n * 10n ** 18n,
    })
    expect(new Set(config.chains.map((chain) => chain.viemChain.id))).toEqual(new Set([1, 42161, 10, 137, 56]))
  })

  it('applies per-chain overrides and optional settings', () => {
    const config = loadConfig({
      ...BASE_ENV,
      PORT: '9000',
      PUBLIC_BASE_URL: 'https://pay.example.com//',
      API_KEY: 'key',
      WEBHOOK_URL: 'https://app.example.com/hook',
      WEBHOOK_SECRET: 'secret',
      MIN_TOPUP_ARBITRUM: '2.5',
      CONFIRMATIONS_ARBITRUM: '7',
      LOG_RANGE_ARBITRUM: '250',
      MAX_GAS_PRICE_GWEI_ARBITRUM: '0.5',
      RPC_URLS_ARBITRUM: ' https://a.example , ,https://b.example',
      SWEEPER_PRIVATE_KEY: `0x${'ab'.repeat(32)}`,
      SWEEP_INTERVAL_SECONDS: '60',
      SWEEP_BATCH_SIZE: '5',
    })
    expect(config).toMatchObject({
      port: 9000,
      publicBaseUrl: 'https://pay.example.com',
      apiKey: 'key',
      webhookUrl: 'https://app.example.com/hook',
      webhookSecret: 'secret',
      sweeperPrivateKey: `0x${'ab'.repeat(32)}`,
      sweepIntervalMs: 60_000,
      sweepBatchSize: 5,
    })
    expect(config.chains[0]).toMatchObject({
      minTopup: '2.5',
      minTopupRaw: 2_500_000n,
      confirmations: 7n,
      logRange: 250n,
      maxGasPriceWei: parseGwei('0.5'),
      rpcUrls: ['https://a.example', 'https://b.example'],
    })
  })

  it('takes the local chain USDT address from the environment', () => {
    const usdt = '0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6'
    const config = loadConfig({ ...BASE_ENV, CHAINS: 'local', USDT_ADDRESS_LOCAL: usdt.toLowerCase() })
    expect(config.chains[0]).toMatchObject({ key: 'local', usdt, confirmations: 2n })
    expect(() => loadConfig({ ...BASE_ENV, CHAINS: 'local' })).toThrow('USDT_ADDRESS_LOCAL')
  })

  it.each([
    [{ DATABASE_URL: undefined }, 'Missing required environment variable DATABASE_URL'],
    [{ CHAINS: undefined }, 'Missing required environment variable CHAINS'],
    [{ FORWARDER_FACTORY_ADDRESS: undefined }, 'Missing required environment variable FORWARDER_FACTORY_ADDRESS'],
    [{ FORWARDER_FACTORY_ADDRESS: '0x1234' }, 'FORWARDER_FACTORY_ADDRESS is not a valid address'],
    [{ CHAINS: 'arbitrum,tron' }, 'Unknown chain "tron"'],
    [{ PORT: '0' }, 'PORT must be a positive integer'],
    [{ PORT: 'http' }, 'PORT must be a positive integer'],
    [{ CONFIRMATIONS_ARBITRUM: '1.5' }, 'CONFIRMATIONS_ARBITRUM must be a positive integer'],
    [{ SWEEPER_PRIVATE_KEY: 'not-a-key' }, 'SWEEPER_PRIVATE_KEY must be'],
    [{ SWEEPER_PRIVATE_KEY: '0xabcd' }, 'SWEEPER_PRIVATE_KEY must be'],
  ])('rejects %j', (override, message) => {
    expect(() => loadConfig({ ...BASE_ENV, ...override })).toThrow(message)
  })
})

describe('forwarder addresses', () => {
  it('derives the implementation the factory creates with nonce 1', () => {
    // Values printed by the deploy script on a local chain.
    expect(implementationAddress(FACTORY)).toBe('0x4365848ad572dE7Ce47bE4EfEDa4619879608F3b')
  })

  it('is deterministic per invoice and distinct across invoices', () => {
    const implementation = implementationAddress(FACTORY)
    const a = forwarderAddress(FACTORY, implementation, invoiceSalt('invoice-a'))
    expect(forwarderAddress(FACTORY, implementation, invoiceSalt('invoice-a'))).toBe(a)
    expect(forwarderAddress(FACTORY, implementation, invoiceSalt('invoice-b'))).not.toBe(a)
    expect(invoiceSalt('invoice-a')).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('webhook signatures', () => {
  const secret = 'whsec'
  const body = '{"id":"evt-1"}'
  const now = () => Math.floor(Date.now() / 1000)

  it('produces a t/v1 header', () => {
    expect(signPayload(secret, body, 1_700_000_000)).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/)
  })

  it('accepts a fresh signature over the exact body', () => {
    expect(verifySignature(secret, body, signPayload(secret, body, now()))).toBe(true)
  })

  it('rejects a wrong secret, a changed body and a truncated digest', () => {
    const header = signPayload(secret, body, now())
    expect(verifySignature('other', body, header)).toBe(false)
    expect(verifySignature(secret, `${body} `, header)).toBe(false)
    expect(verifySignature(secret, body, header.slice(0, -2))).toBe(false)
  })

  it('rejects signatures outside the tolerance window', () => {
    expect(verifySignature(secret, body, signPayload(secret, body, now() - 301))).toBe(false)
    expect(verifySignature(secret, body, signPayload(secret, body, now() + 301))).toBe(false)
    expect(verifySignature(secret, body, signPayload(secret, body, now() - 301), 600)).toBe(true)
  })

  it.each(['', 'garbage', 't=abc,v1=00', `t=${Math.floor(Date.now() / 1000)}`, 'v1=00'])(
    'rejects the malformed header %j',
    (header) => {
      expect(verifySignature(secret, body, header)).toBe(false)
    },
  )
})

describe('trimAmount', () => {
  it.each([
    ['25.500000000000000000', '25.5'],
    ['17.000000', '17'],
    ['0.000001', '0.000001'],
    ['100', '100'],
    ['10.010', '10.01'],
  ])('%s -> %s', (input, expected) => {
    expect(trimAmount(input)).toBe(expected)
  })
})

describe('checkout page', () => {
  const view = {
    invoiceId: 'e01ae86c-9266-4bf7-b1ee-7a503f92de66',
    address: '0xf3ed68Da02C53c64c4cf880D254A8442d4535638',
    nonce: 'nonce-123',
    networks: [
      { key: 'arbitrum', name: 'Arbitrum One', minAmount: '10', explorerTx: 'https://arbiscan.io/tx/' },
      { key: 'ethereum', name: 'Ethereum', minAmount: '20', explorerTx: 'https://etherscan.io/tx/' },
    ],
  }

  it('shows the address in ten groups with the first and last emphasised', async () => {
    const html = await renderCheckout(view)
    const groups = [...html.matchAll(/<span(?: class="edge")?>([0-9a-fA-F]{4})<\/span>/g)].map((m) => m[1])
    expect(groups).toHaveLength(10)
    expect(`0x${groups.join('')}`).toBe(view.address)
    expect(html).toContain('<span class="edge">f3ed</span>')
    expect(html).toContain('<span class="edge">5638</span>')
    expect(html.match(/class="edge"/g)).toHaveLength(2)
    expect(html).toContain('starts with 0xf3ed and ends with 5638')
  })

  it('lists every network and preselects the first', async () => {
    const html = await renderCheckout(view)
    expect(html).toContain('value="arbitrum" checked')
    expect(html).toContain('value="ethereum">')
    expect(html).toContain('20 USDT minimum')
    expect(html.match(/ checked/g)).toHaveLength(1)
  })

  it('embeds a QR code and nonces every inline style and script', async () => {
    const html = await renderCheckout(view)
    expect(html).toContain('src="data:image/png;base64,')
    expect(html).toContain('<style nonce="nonce-123">')
    expect(html).toContain('<script nonce="nonce-123">')
  })

  it('escapes network names in markup and in the embedded JSON', async () => {
    const html = await renderCheckout({
      ...view,
      networks: [{ key: 'x"y', name: `<script>alert('1')</script> & co`, minAmount: '10', explorerTx: '' }],
    })
    expect(html).not.toContain("<script>alert('1')")
    expect(html).toContain('&lt;script&gt;alert(&#39;1&#39;)&lt;/script&gt; &amp; co')
    expect(html).toContain('value="x&quot;y"')
    expect(html).toContain('\\u003cscript>alert')
  })

  it('renders the not-found page without a script', () => {
    const html = renderNotFound('nonce-456')
    expect(html).toContain("This top-up link doesn't work")
    expect(html).toContain("<title>Top-up link doesn&#39;t work</title>")
    expect(html).not.toContain('<script')
  })
})

describe('roles and loops', () => {
  it('recognises valid roles only', () => {
    expect(isRole('watcher')).toBe(true)
    expect(isRole('all')).toBe(true)
    expect(isRole('nope')).toBe(false)
  })

  it('logs a failed pass and keeps going until aborted', async () => {
    const errors: object[] = []
    const ctx = { log: { info() {}, warn() {}, error: (obj: object) => errors.push(obj) } } as unknown as Context
    const shutdown = new AbortController()
    let passes = 0
    await loop(ctx, 'flaky', 1, shutdown.signal, async () => {
      passes += 1
      if (passes === 1) throw new Error('boom')
      if (passes === 3) shutdown.abort()
    })
    expect(passes).toBe(3)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ loop: 'flaky', err: new Error('boom') })
  })

  it('does not run at all when already aborted', async () => {
    let passes = 0
    await loop({} as Context, 'idle', 1, AbortSignal.abort(), async () => void (passes += 1))
    expect(passes).toBe(0)
  })
})

describe('rpcTransport', () => {
  it('refuses to build a client for a chain with no RPC URLs', () => {
    const [chain] = loadConfig(BASE_ENV).chains
    expect(() => rpcTransport(chain!)).toThrow('set RPC_URLS_ARBITRUM')
  })
})
