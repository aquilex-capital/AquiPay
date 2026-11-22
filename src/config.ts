import { getAddress, isAddress, parseGwei, parseUnits, type Address, type Chain, type Hex } from 'viem'
import { arbitrum, bsc, foundry, mainnet, optimism, polygon } from 'viem/chains'
import { implementationAddress } from './forwarder.ts'

interface ChainDefaults {
  viemChain: Chain
  name: string
  /** Canonical USDT contract. Transfers of any other token are ignored. */
  usdt?: Address
  decimals: number
  confirmations: number
  minTopup: string
  /** How often a live checkout's balance is read. */
  pollSeconds: number
  /**
   * A lower bound on the time between blocks, so that a count of blocks
   * derived from it reaches back at least as far as an invoice's age. 0 means
   * "from the first block", for anvil, which mines a block per transaction.
   */
  minBlockMs: number
  explorerTx: string
}

/** Multicall3's address on every chain that has it. */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

const CHAIN_DEFAULTS: Record<string, ChainDefaults> = {
  ethereum: {
    viemChain: mainnet,
    name: 'Ethereum',
    usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
    confirmations: 12,
    minTopup: '20',
    pollSeconds: 12,
    minBlockMs: 6000,
    explorerTx: 'https://etherscan.io/tx/',
  },
  arbitrum: {
    viemChain: arbitrum,
    name: 'Arbitrum One',
    usdt: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    decimals: 6,
    confirmations: 60,
    minTopup: '10',
    pollSeconds: 5,
    minBlockMs: 100,
    explorerTx: 'https://arbiscan.io/tx/',
  },
  optimism: {
    viemChain: optimism,
    name: 'Optimism',
    usdt: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    decimals: 6,
    confirmations: 15,
    minTopup: '10',
    pollSeconds: 5,
    minBlockMs: 500,
    explorerTx: 'https://optimistic.etherscan.io/tx/',
  },
  polygon: {
    viemChain: polygon,
    name: 'Polygon',
    usdt: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    decimals: 6,
    confirmations: 64,
    minTopup: '10',
    pollSeconds: 5,
    minBlockMs: 500,
    explorerTx: 'https://polygonscan.com/tx/',
  },
  bsc: {
    viemChain: bsc,
    name: 'BNB Smart Chain',
    usdt: '0x55d398326f99059fF775485246999027B3197955',
    // BSC USDT is the odd one out: 18 decimals, not 6.
    decimals: 18,
    confirmations: 20,
    minTopup: '10',
    pollSeconds: 5,
    minBlockMs: 100,
    explorerTx: 'https://bscscan.com/tx/',
  },
  // Local anvil node for development and tests; USDT_ADDRESS_LOCAL is required.
  local: {
    viemChain: foundry,
    name: 'Local (anvil)',
    decimals: 6,
    confirmations: 2,
    minTopup: '10',
    pollSeconds: 1,
    minBlockMs: 0,
    explorerTx: '',
  },
}

export interface ChainConfig {
  key: string
  name: string
  viemChain: Chain
  usdt: Address
  decimals: number
  confirmations: bigint
  minTopup: string
  minTopupRaw: bigint
  pollMs: number
  logRange: bigint
  minBlockMs: number
  multicall3: Address
  /** Whether the RPC answers balance reads at past blocks; without them, changes are found by scanning logs. */
  historicalReads: boolean
  rpcUrls: string[]
  maxGasPriceWei?: bigint
  explorerTx: string
}

export interface Config {
  databaseUrl: string
  port: number
  publicBaseUrl: string
  apiKey?: string
  webhookUrl?: string
  webhookSecret?: string
  factory: Address
  implementation: Address
  chains: ChainConfig[]
  sweeperPrivateKey?: Hex
  sweepIntervalMs: number
  sweepBatchSize: number
  /** How long a new invoice's address is live. */
  invoiceTtlSeconds: number
  /** How long after expiry a payment is still looked for and credited. */
  lateWindowSeconds: number
  /** How often addresses inside that window are read. */
  latePassMs: number
  /** Addresses per Multicall3 call. */
  multicallBatch: number
}

type Env = Record<string, string | undefined>

function required(env: Env, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

function address(env: Env, name: string): Address {
  const value = required(env, name)
  if (!isAddress(value)) throw new Error(`${name} is not a valid address`)
  return getAddress(value)
}

function positiveInt(env: Env, name: string, fallback: number, { zero = false } = {}): number {
  const raw = env[name]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < (zero ? 0 : 1)) {
    throw new Error(`${name} must be a ${zero ? 'non-negative' : 'positive'} integer`)
  }
  return value
}

function boolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.toLowerCase()
  if (!raw) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new Error(`${name} must be true or false`)
}

/** `NAME_<CHAIN>` if that is set, else the chain-wide `NAME`, so one line can tune every chain. */
function perChain(env: Env, name: string, suffix: string): string {
  return env[`${name}_${suffix}`] ? `${name}_${suffix}` : name
}

function loadChain(env: Env, key: string): ChainConfig {
  const defaults = CHAIN_DEFAULTS[key]
  if (!defaults) {
    throw new Error(`Unknown chain "${key}". Known: ${Object.keys(CHAIN_DEFAULTS).join(', ')}`)
  }
  const suffix = key.toUpperCase()
  const minTopup = env[`MIN_TOPUP_${suffix}`] ?? defaults.minTopup
  const maxGasPrice = env[`MAX_GAS_PRICE_GWEI_${suffix}`]
  return {
    key,
    name: defaults.name,
    viemChain: defaults.viemChain,
    usdt: defaults.usdt ?? address(env, `USDT_ADDRESS_${suffix}`),
    decimals: defaults.decimals,
    confirmations: BigInt(positiveInt(env, `CONFIRMATIONS_${suffix}`, defaults.confirmations)),
    minTopup,
    minTopupRaw: parseUnits(minTopup, defaults.decimals),
    pollMs: positiveInt(env, perChain(env, 'POLL_SECONDS', suffix), defaults.pollSeconds) * 1000,
    // Ten blocks is the widest getLogs range free RPC plans allow (Alchemy's, for one).
    logRange: BigInt(positiveInt(env, perChain(env, 'LOG_RANGE', suffix), 10)),
    minBlockMs: positiveInt(env, `MIN_BLOCK_MS_${suffix}`, defaults.minBlockMs, { zero: true }),
    multicall3: env[`MULTICALL3_ADDRESS_${suffix}`] ? address(env, `MULTICALL3_ADDRESS_${suffix}`) : MULTICALL3,
    historicalReads: boolean(env, perChain(env, 'HISTORICAL_READS', suffix), true),
    rpcUrls: (env[`RPC_URLS_${suffix}`] ?? '').split(',').map((url) => url.trim()).filter(Boolean),
    maxGasPriceWei: maxGasPrice ? parseGwei(maxGasPrice) : undefined,
    explorerTx: defaults.explorerTx,
  }
}

export function loadConfig(env: Env = process.env): Config {
  const factory = address(env, 'FORWARDER_FACTORY_ADDRESS')
  const chainKeys = required(env, 'CHAINS').split(',').map((key) => key.trim().toLowerCase()).filter(Boolean)
  const sweeperKey = env.SWEEPER_PRIVATE_KEY
  if (sweeperKey && !/^0x[0-9a-fA-F]{64}$/.test(sweeperKey)) {
    throw new Error('SWEEPER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  }
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    port: positiveInt(env, 'PORT', 8080),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? 'http://localhost:8080').replace(/\/+$/, ''),
    apiKey: env.API_KEY,
    webhookUrl: env.WEBHOOK_URL,
    webhookSecret: env.WEBHOOK_SECRET,
    factory,
    implementation: implementationAddress(factory),
    chains: chainKeys.map((key) => loadChain(env, key)),
    sweeperPrivateKey: sweeperKey as Hex | undefined,
    sweepIntervalMs: positiveInt(env, 'SWEEP_INTERVAL_SECONDS', 3600) * 1000,
    sweepBatchSize: positiveInt(env, 'SWEEP_BATCH_SIZE', 50),
    invoiceTtlSeconds: positiveInt(env, 'INVOICE_TTL_SECONDS', 600),
    lateWindowSeconds: positiveInt(env, 'LATE_PAYMENT_HOURS', 24, { zero: true }) * 3600,
    latePassMs: positiveInt(env, 'LATE_PASS_SECONDS', 3600) * 1000,
    multicallBatch: positiveInt(env, 'MULTICALL_BATCH', 500),
  }
}
