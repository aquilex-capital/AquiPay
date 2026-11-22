# AquiPay

Self-hosted USDT payment gateway for EVM chains (Ethereum, Arbitrum, Optimism,
Polygon, BNB Smart Chain).

Your backend creates an invoice and gets a deposit address, live for ten
minutes. Every USDT transfer to that address at or above the chain minimum is a
top-up: AquiPay waits for confirmations and sends your backend a signed
webhook. Funds are swept automatically to one wallet you control.

It is built to run on a free RPC plan: with no checkout open it makes no RPC
call at all, and with any number open it makes two per chain per poll.

## How it works

- **Invoice addresses are contracts, not wallets.** Each address is the
  pre-computed (CREATE2) address of a tiny forwarder contract. It has no private
  key, and the only thing it can do is send its balance to the destination
  wallet stored in the factory. The same address is valid on every chain.
- **Watcher** (one per chain) reads the USDT balance of every live invoice
  address in one Multicall3 call per poll. Only when a balance moves does it
  look for the transfers behind it: it halves the block range on past balances
  until a piece fits one `eth_getLogs` (10 blocks, what free plans allow), so
  a payment costs a handful of calls. It records them as `pending`, and marks
  them `confirmed` once they are deep enough and still on the canonical chain.
  Transfers in reorged-out blocks become `orphaned`, and the address is
  searched again in case the transaction lands elsewhere. It refuses to take a
  balance as accounted for until the logs it found add up to the change, so a
  lagging node costs a retry rather than a payment.
- **Expiry and late payments.** An address is read every poll while its invoice
  is live (`INVOICE_TTL_SECONDS`, 10 minutes), once more after it expires, and
  then once an hour for `LATE_PAYMENT_HOURS` (24): a payment that lands late is
  still credited, within the hour. After that the address is no longer read;
  money sent to it stays there, and is returned by hand. Nothing older is ever
  read, so the work does not grow with every invoice you have made.
- **Dispatcher** delivers `topup.confirmed` webhooks from an outbox table, with
  retries and exponential backoff.
- **Sweeper** calls `factory.sweep(...)` in batches. Its key only pays gas; if it
  leaks, the worst an attacker can do is pay for your sweeps. It sweeps an
  address only once the watcher is done with it, after the late-payment
  window: the watcher finds payments by a balance going up, and emptying an
  address it still reads could hide one that lands in the same poll. Anyone can
  flush a forwarder, though, so the watcher also checks whether one exists. A
  live address whose forwarder exists has its logs read every poll, as its
  balance no longer tells. An address flushed after its last poll, and paid
  again within the late window, is the one case left: the hourly look sees no
  change, and that payment is in your wallet, to be returned by hand.
- **API** serves the merchant endpoints and the hosted checkout page.

All roles are one Docker image: `api | watcher | dispatcher | sweeper | migrate | all`.

### Rules

| Rule | Behaviour |
|---|---|
| Minimum | 10 USDT (20 on Ethereum). Set with `MIN_TOPUP_<CHAIN>`. |
| Below minimum | Small transfers accumulate per invoice and network. Once the uncredited total reaches the minimum, they are credited together as one top-up. Until then they have `credited: false` (list with `GET /v1/transfers?status=confirmed&credited=false`) and are still swept. |
| Repeat payments | Each time the uncredited total reaches the minimum, that is a separate top-up, for as long as the address is read. |
| Expiry | An address is live for `INVOICE_TTL_SECONDS` (600). Payments landing up to `LATE_PAYMENT_HOURS` (24) after expiry are credited on the hourly pass; later ones are not seen. |
| Amount | 1 USDT = 1 unit. Amounts are decimal strings (`"25.5"`). |

## Local development

Requires Node 24+ and Docker.

```sh
npm install
docker compose up -d               # Postgres + local chain (anvil)
npm run contracts:build
cp .env.example .env
node scripts/dev-setup.ts >> .env  # deploys mock USDT + factory, appends their addresses, puts Multicall3 on anvil
npm run dev                        # all roles in one process, applies migrations
```

Tests:

```sh
npm run contracts:test      # Solidity unit tests
npm test                    # unit tests, plus end-to-end tests against the local chain and database
npm run test:coverage       # the same, failing if coverage of src/ drops below 100%
npm run contracts:coverage  # Solidity coverage report
```

`src/main.ts` is excluded from the coverage figure: it is process wiring, and
the tests run it as a child process, which in-process coverage cannot see.

## API

Integrating another system? Follow [docs/INTEGRATION.md](docs/INTEGRATION.md).

All `/v1/*` requests need `Authorization: Bearer $API_KEY`.

| Endpoint | Purpose |
|---|---|
| `POST /v1/invoices` | Body `{"reference": "user-42", "metadata": {...}}`. Returns `id`, `address`, `checkout_url`, `expires_at`, `networks`. |
| `GET /v1/invoices/:id` | Invoice with its transfers. |
| `GET /v1/invoices?reference=` | Look up invoices by your reference. |
| `GET /v1/transfers?chain=&status=&credited=` | Recent transfers, for reconciliation. |
| `GET /checkout/:id` | Public hosted checkout page (QR code, network picker, countdown, live status). Once expired it no longer shows the address. |

### Webhook

```json
{
  "id": "5dc6091a-0de7-4975-bda0-23a038cbfcaa",
  "type": "topup.confirmed",
  "created_at": "2026-11-22T07:52:26.475Z",
  "data": {
    "invoice_id": "06e16ba5-6508-4e38-9dcf-5cf8dbc42540",
    "reference": "user-42",
    "metadata": {},
    "chain": "arbitrum",
    "chain_id": 42161,
    "currency": "USDT",
    "amount": "25.5",
    "transfers": [
      { "tx_hash": "0x…", "log_index": 3, "from": "0x…", "amount": "25.5" }
    ]
  }
}
```

- `amount` is the sum of `transfers`. There is more than one transfer when small
  payments accumulated to reach the minimum.
- Header `X-AquiPay-Signature: t=<unix>,v1=<hex>` where `v1` is
  HMAC-SHA256 of `"<t>.<raw body>"` with `WEBHOOK_SECRET`. A reference verifier
  is `verifySignature` in `src/dispatcher.ts`.
- Delivery is at-least-once. Deduplicate on `id` (also sent as `X-AquiPay-Event-Id`).
- Respond with any 2xx within 10 seconds. Failures retry up to 20 times.

## Going to production

1. **Deploy the factory on each chain** with your wallet as `DESTINATION`. Any
   funded key can broadcast; it gets no privileges. The address comes out the
   same on every chain as long as `DESTINATION` is the same.

   ```sh
   docker run --rm -it -v "$PWD":/repo -w /repo \
     -e DESTINATION=0xYourWallet --entrypoint forge ghcr.io/foundry-rs/foundry:stable \
     script contracts/script/Deploy.s.sol --rpc-url <RPC_URL> --private-key <FUNDED_KEY> --broadcast
   ```

   Running it a second time on the same chain with the same `DESTINATION`
   reverts, because the factory already exists at that address.

2. **Create a sweeper key** and fund it with a little native token on each
   chain (ETH, BNB, POL).

3. **Build and push the image**: `docker build -t <registry>/aquipay:0.1.0 .`

4. **Create the secrets and install the chart**:

   ```sh
   kubectl create secret generic aquipay \
     --from-literal=DATABASE_URL=... --from-literal=API_KEY=... \
     --from-literal=WEBHOOK_SECRET=... \
     --from-literal=RPC_URLS_ARBITRUM=https://...,https://... # one per chain
   kubectl create secret generic aquipay-sweeper --from-literal=SWEEPER_PRIVATE_KEY=0x...

   helm upgrade --install aquipay deploy/helm/aquipay \
     --set image.repository=<registry>/aquipay \
     --set config.forwarderFactoryAddress=0x... \
     --set config.publicBaseUrl=https://pay.example.com \
     --set config.webhookUrl=https://app.example.com/webhooks/aquipay \
     --set ingress.enabled=true --set ingress.host=pay.example.com
   ```

   Migrations run as a pre-install/pre-upgrade hook. Postgres is external
   (any managed Postgres 13+).

### Before real money

- **Verify the USDT contract addresses** in `src/config.ts` against Tether's
  published list. A wrong address means payments are not seen.
- **The contracts are unaudited.** They are small and tested, but get a second
  pair of eyes on `contracts/src` before deploying.
- **Send a small test payment on each chain** and confirm webhook and sweep.
- **Changing the destination wallet** takes two transactions: the current wallet
  calls `proposeDestination`, the new one calls `acceptDestination`.

### Operations

- **Gas cap**: `MAX_GAS_PRICE_GWEI_ETHEREUM=5` postpones mainnet sweeps while gas
  is expensive.
- **Frozen addresses**: if a flush reverts (Tether froze the address), the
  transfer gets a `sweep_error` and is skipped until you clear that column.
- **RPC**: one provider per chain is enough; later URLs are fallbacks. The
  defaults fit a free plan such as Alchemy's. The watcher needs `eth_call` at
  past blocks; without it, set `HISTORICAL_READS=false` and it reads logs
  instead, `LOG_RANGE` blocks at a time.
- **Tuning** (each `<CHAIN>` setting also has a chain-wide form without the
  suffix, which the suffixed one overrides):

  | Variable | Default | What it sets |
  |---|---|---|
  | `INVOICE_TTL_SECONDS` | 600 | How long an invoice's address is live |
  | `LATE_PAYMENT_HOURS` | 24 | How long after expiry a payment is still looked for; 0 for never |
  | `LATE_PASS_SECONDS` | 3600 | How often addresses in that window are read |
  | `POLL_SECONDS_<CHAIN>` | 5 (12 on Ethereum) | How often live addresses are read |
  | `LOG_RANGE_<CHAIN>` | 10 | Blocks per `eth_getLogs` |
  | `HISTORICAL_READS_<CHAIN>` | true | Whether the RPC answers `eth_call` at past blocks |
  | `MULTICALL_BATCH` | 500 | Addresses per Multicall3 call |
  | `MULTICALL3_ADDRESS_<CHAIN>` | `0xcA11bde05977b3631167028862bE2a173976CA11` | Where Multicall3 is |
  | `MIN_BLOCK_MS_<CHAIN>` | per chain | A lower bound on block time, for how far back a new address's first search reaches |

- **Cost**: per chain, two calls per poll while any checkout is open, plus about
  `log2(blocks / LOG_RANGE)` calls for each payment, plus one call an hour
  while any address is in the late window. On Alchemy's free plan that is
  roughly 17,000 compute units for a ten-minute checkout across four chains.
- **Not included yet**: database backups to S3, metrics, an admin UI.
