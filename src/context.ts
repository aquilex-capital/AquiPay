import { createPublicClient, fallback, http, type PublicClient } from 'viem'
import type { ChainConfig, Config } from './config.ts'
import type { Sql } from './db.ts'

/** The subset of pino the workers use; the API server needs a full pino instance. */
export interface Logger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export interface Context {
  config: Config
  sql: Sql
  log: Logger
}

export function rpcTransport(chain: ChainConfig) {
  if (chain.rpcUrls.length === 0) {
    throw new Error(`No RPC URLs configured for ${chain.key}; set RPC_URLS_${chain.key.toUpperCase()}`)
  }
  // Tries providers in order and falls through on failure.
  return fallback(chain.rpcUrls.map((url) => http(url, { timeout: 15_000 })))
}

const publicClients = new Map<string, PublicClient>()

export function publicClient(chain: ChainConfig): PublicClient {
  let client = publicClients.get(chain.key)
  if (!client) {
    client = createPublicClient({ chain: chain.viemChain, transport: rpcTransport(chain) })
    publicClients.set(chain.key, client)
  }
  return client
}
