# Integrating with AquiPay

This guide is for the system that sells something and wants to accept USDT
top-ups through AquiPay. The integration has three parts:

1. Create an invoice when a user wants to top up.
2. Show the user where to pay.
3. Receive a webhook when the payment is credited.

You need three values from whoever runs the gateway:

| Value | Used for |
|---|---|
| Base URL, e.g. `https://pay.example.com` | All API calls |
| API key (`API_KEY`) | Authenticating your API calls |
| Webhook secret (`WEBHOOK_SECRET`) | Verifying webhooks the gateway sends you |

The gateway sends all webhooks to one URL, set in its own configuration
(`WEBHOOK_URL`). Tell the operator which URL of yours to use.

## 1. Create an invoice

Call this from your backend, never from a browser: the API key must stay secret.

```sh
curl -X POST https://pay.example.com/v1/invoices \
  -H 'Authorization: Bearer <API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{"reference": "user-42", "metadata": {"plan": "pro"}}'
```

| Field | Required | Notes |
|---|---|---|
| `reference` | yes | Your own id for who or what is being topped up, 1 to 255 characters. Returned in every webhook. |
| `metadata` | no | Any JSON object. Returned in every webhook. |

Response, `201 Created`:

```json
{
  "id": "e01ae86c-9266-4bf7-b1ee-7a503f92de66",
  "reference": "user-42",
  "metadata": { "plan": "pro" },
  "address": "0xf3ed68Da02C53c64c4cf880D254A8442d4535638",
  "checkout_url": "https://pay.example.com/checkout/e01ae86c-9266-4bf7-b1ee-7a503f92de66",
  "created_at": "2026-11-22T07:58:19.092Z",
  "networks": [
    { "chain": "arbitrum", "chain_id": 42161, "name": "Arbitrum One",
      "token_address": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "min_amount": "10" }
  ],
  "transfers": []
}
```

Create a new invoice for each top-up a user starts. Store the `id` next to your
own record if you want to look the invoice up later.

## 2. Show the user where to pay

Pick one:

- **Hosted page.** Redirect the user to `checkout_url`. It shows the network
  picker, the address, a QR code and live payment status. Nothing else to build.
- **Your own UI.** Show `address` and let the user choose from `networks`. Tell
  them to send only USDT, only on the network they chose, and show that
  network's `min_amount`.

The same address is valid on every network in the list.

## 3. Receive the webhook

When payments to an invoice are confirmed and reach the minimum, the gateway
POSTs a `topup.confirmed` event to your webhook URL:

```json
{
  "id": "5dc6091a-0de7-4975-bda0-23a038cbfcaa",
  "type": "topup.confirmed",
  "created_at": "2026-11-22T07:52:26.475Z",
  "data": {
    "invoice_id": "e01ae86c-9266-4bf7-b1ee-7a503f92de66",
    "reference": "user-42",
    "metadata": { "plan": "pro" },
    "chain": "arbitrum",
    "chain_id": 42161,
    "currency": "USDT",
    "amount": "17",
    "transfers": [
      { "tx_hash": "0x…", "log_index": 3, "from": "0x…", "amount": "5" },
      { "tx_hash": "0x…", "log_index": 0, "from": "0x…", "amount": "12" }
    ]
  }
}
```

Credit `data.amount` to the account identified by `data.reference`.

Your handler must do three things, in this order:

1. **Verify the signature** (below). Reject with `401` if it fails.
2. **Skip duplicates.** Delivery is at-least-once, so the same event can arrive
   twice. Record `id` under a unique constraint, in the same database
   transaction that credits the balance.
3. **Respond with any 2xx within 10 seconds.** Anything else, or a timeout,
   counts as a failure and is retried. Redirects are not followed.

### Verifying the signature

Each request carries:

```
X-AquiPay-Signature: t=1795334977,v1=5f2c…
X-AquiPay-Event-Id: 5dc6091a-0de7-4975-bda0-23a038cbfcaa
```

To verify:

1. Split the header into `t` (Unix seconds) and `v1` (hex).
2. Reject if `t` is more than 5 minutes from your clock.
3. Compute HMAC-SHA256 of the string `<t>.<raw request body>` with the webhook
   secret as the key.
4. Compare the result with `v1` using a constant-time comparison.

Use the raw body bytes exactly as received. Parsing the JSON and serialising it
again changes the bytes and the signature will not match.

A complete receiver in TypeScript, using only Node built-ins, is in
[`examples/webhook-receiver.ts`](../examples/webhook-receiver.ts). The same
check in Python:

```python
import hashlib, hmac, time

def is_authentic(secret: str, raw_body: bytes, header: str, tolerance: int = 300) -> bool:
    parts = dict(part.split("=", 1) for part in header.split(",") if "=" in part)
    try:
        timestamp = int(parts["t"])
        given = parts["v1"]
    except (KeyError, ValueError):
        return False
    if abs(time.time() - timestamp) > tolerance:
        return False
    signed = f"{timestamp}.".encode() + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, given)
```

### Retries

A failed delivery is retried up to 20 times. The wait doubles each time,
starting at 30 seconds and capped at 6 hours.

## What to expect

- **Amounts are decimal strings** in whole USDT (`"25.5"`). Parse them with a
  decimal type or convert to integer micro-units. Do not use floating point for
  balances.
- **One invoice can produce several events.** Every time the uncredited
  payments to an address reach the minimum, you get another `topup.confirmed`.
  Addresses do not expire.
- **Small payments accumulate.** A transfer below the minimum is not credited
  on its own. It waits, per invoice and per network, and is included in the next
  event once the waiting total reaches the minimum. That is why `transfers` can
  hold more than one entry; `amount` is always their sum.
- **Minimums differ by network** (`min_amount` in `networks`). Payments on
  different networks are not added together.
- **Timing.** A payment is credited after the network's confirmation depth:
  typically under a minute on Arbitrum, Optimism and BNB Smart Chain, and a few
  minutes on Polygon and Ethereum.

## Checking status without webhooks

Use these to reconcile, or as a fallback if your webhook endpoint was down for
longer than the retry window.

| Request | Returns |
|---|---|
| `GET /v1/invoices/<id>` | The invoice with every transfer, each with `status` (`pending`, `confirmed`, `orphaned`) and `credited`. |
| `GET /v1/invoices?reference=user-42` | Invoices for one of your references, newest first. |
| `GET /v1/transfers?status=confirmed&credited=false` | Confirmed payments still waiting to reach the minimum. |

List endpoints return `{"data": [...]}` and accept `limit` (default 50, maximum 200).

## Errors

| Status | Body | Meaning |
|---|---|---|
| `400` | `{"error": "invalid_request", "issues": [...]}` | The request body or query is malformed; `issues` says which field. |
| `401` | `{"error": "unauthorized"}` | Missing or wrong API key. |
| `404` | `{"error": "not_found"}` | No invoice with that id. |
| `5xx` | `{"error": "internal_error"}` | Gateway problem. Safe to retry. |

## Testing locally

1. Start the gateway on a local chain as described in the
   [README](../README.md#local-development).
2. Run the example receiver with the gateway's `WEBHOOK_SECRET`, and point the
   gateway's `WEBHOOK_URL` at it:

   ```sh
   AQUIPAY_WEBHOOK_SECRET=change-me-too node examples/webhook-receiver.ts
   ```

3. Create an invoice, then send mock USDT to its address from the pre-funded
   local account and mine the confirmation blocks:

   ```sh
   docker compose exec -T anvil cast send <USDT_ADDRESS_LOCAL> \
     "transfer(address,uint256)" <INVOICE_ADDRESS> 25000000 \
     --private-key 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
     --rpc-url http://localhost:8545
   docker compose exec -T anvil cast rpc anvil_mine 0x5 --rpc-url http://localhost:8545
   ```

   `25000000` is 25 USDT (6 decimals). The receiver prints the credit within a
   few seconds.
