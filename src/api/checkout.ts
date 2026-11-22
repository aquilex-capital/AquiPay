import QRCode from 'qrcode'

export interface CheckoutView {
  invoiceId: string
  address: string
  /** How long the address stays live; 0 when it already has expired. */
  secondsLeft: number
  nonce: string
  networks: { key: string; name: string; minAmount: string; explorerTx: string }[]
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Safe to embed inside a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

// Look: the gagarin.cloud console. A dark panel, Golos Text for prose and
// JetBrains Mono for every reading. Two reserved accents: green (--telemetry)
// for converged truth, amber (--signal) for a problem or a refusal.
const STYLE = `
@font-face { font-family: "Golos Text"; src: url("/assets/fonts/golos-text.woff2") format("woff2");
  font-weight: 400 900; font-display: swap; }
@font-face { font-family: "JetBrains Mono"; src: url("/assets/fonts/jetbrains-mono.woff2") format("woff2");
  font-weight: 100 800; font-display: swap; }

:root { color-scheme: dark;
  --void: #07090d; --plate: #111927; --control: #0d141f; --field: #0b1017; --callout: #11161e;
  --plate-edge: #1c2534; --plate-edge-lit: #27354a; --panel-edge: #161d29; --rule: #10161f;
  --phosphor: #eef2f7; --heading: #f2f6fa; --control-ink: #a6b4c8; --dim: #7d8ea3; --meta: #5c6a80;
  --label: #4f5c72;
  --signal: #e0a75e; --signal-dim: #a8957a;
  --telemetry: #7ee2a8; --telemetry-link: #8fdfb2; --on-telemetry: #0a1a12;
  --sans: "Golos Text", system-ui, sans-serif; --mono: "JetBrains Mono", ui-monospace, monospace; }

* { box-sizing: border-box; }
::selection { background: var(--phosphor); color: var(--void); }
body { margin: 0; padding: 56px 16px 72px; background: var(--void); color: var(--phosphor);
  font: 400 clamp(1rem, 0.96rem + 0.2vw, 1.05rem)/1.55 var(--sans); font-feature-settings: "ss01";
  -webkit-font-smoothing: antialiased; }
main, .stack { display: flex; flex-direction: column; gap: 1.125rem; }
main { max-width: 35rem; margin: 0 auto; }
header { margin-bottom: 0.875rem; }
h1 { margin: 0 0 0.35em; font: 700 clamp(1.6875rem, 1.2rem + 1.9vw, 2.375rem)/1.05 var(--mono);
  letter-spacing: -0.015em; color: var(--heading); text-wrap: balance; }
p { margin: 0; }
.lede { color: var(--dim); max-width: 46ch; }
a { color: var(--phosphor); text-underline-offset: 2px; }
a:hover { color: var(--telemetry-link); }
:focus-visible { outline: 2px solid var(--phosphor); outline-offset: 1px; }

.card { border: 1px solid var(--plate-edge); border-radius: 10px; overflow: hidden;
  background: linear-gradient(var(--plate), var(--control)); }
.card-head { display: flex; align-items: center; gap: 0.625rem; margin: 0; padding: 0.8rem 1.125rem;
  border-bottom: 1px solid var(--plate-edge); font: 400 0.625rem/1.5 var(--mono); letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--label); }
.card-head::after { content: ""; flex: 1; height: 1px; background: var(--rule); }
.card-body { padding: 1.25rem 1.125rem 1.375rem; display: flex; flex-direction: column; gap: 0.875rem; }
.fine { font: 400 0.6875rem/1.6 var(--mono); color: var(--meta); }

.networks { display: grid; grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr)); gap: 0.5rem; }
.network { position: relative; display: block; cursor: pointer; }
.network input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.network span { display: block; padding: 0.6rem 0.8rem; border: 1px solid var(--plate-edge); border-radius: 8px;
  background: var(--control); color: var(--control-ink); transition: border-color 120ms, color 120ms; }
.network b { display: block; font-weight: 500; }
.network small { font: 400 0.6875rem/1.6 var(--mono); color: var(--meta); }
.network:hover span { border-color: var(--plate-edge-lit); color: var(--phosphor); }
.network input:checked + span { border-color: var(--dim); color: var(--phosphor); }
.network input:focus-visible + span { outline: 2px solid var(--phosphor); outline-offset: 1px; }

.pay { display: flex; gap: 1.125rem; align-items: stretch; }
.well { flex: 1; min-width: 0; display: flex; align-items: center; padding: 0.875rem 1rem; background: var(--field);
  border: 1px solid var(--plate-edge-lit); border-radius: 8px; }
/* Groups of four make the address checkable by eye; the gaps are margins, so
   selecting and copying the text still yields the unbroken address. */
.address { margin: 0; padding-left: 2.75ch; text-indent: -2.75ch; max-width: 27ch;
  font: 400 clamp(0.875rem, 4.3vw, 1.25rem)/1.8 var(--mono); color: var(--dim); }
.address span { display: inline-block; text-indent: 0; margin-right: 0.75ch; }
.address .edge { color: var(--phosphor); }
.qr { flex: none; width: 7.25rem; height: 7.25rem; padding: 0.5rem; background: var(--phosphor); border-radius: 8px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1rem; }
.go { flex: none; padding: 0.7rem 0.95rem; border: 0; border-radius: 8px; cursor: pointer;
  background: var(--telemetry); color: var(--on-telemetry); font: 400 0.8125rem/1.2 var(--mono);
  letter-spacing: 0.04em; white-space: nowrap; }
.go:hover { filter: brightness(1.1); }
.actions .fine { flex: 1; min-width: 14rem; }
.clock { font-variant-numeric: tabular-nums; color: var(--phosphor); }
.notice { padding: 0.75rem 1rem; background: var(--callout); border-left: 2px solid var(--signal);
  border-radius: 0 6px 6px 0; font-size: 0.875rem; color: var(--signal-dim); }

.payments { list-style: none; margin: 0; padding: 0; }
.payments li { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.8rem 0; }
.payments li:first-child { padding-top: 0; }
.payments li:last-child { padding-bottom: 0; }
.payments li + li { border-top: 1px solid var(--plate-edge); }
.amount { display: block; font: 400 0.9375rem/1.4 var(--mono); color: var(--phosphor); }
.where { display: block; font: 400 0.6875rem/1.6 var(--mono); color: var(--meta); }
.where a { color: var(--dim); }
.badge { flex: none; padding: 0.19rem 0.5rem; border: 1px solid var(--panel-edge); border-radius: 4px;
  font: 400 0.6875rem/1.5 var(--mono); letter-spacing: 0.08em; white-space: nowrap; color: var(--dim); }
.badge.ok { border-color: var(--telemetry); color: var(--telemetry); }
.badge.no { border-color: var(--signal); color: var(--signal); }
.badge.fresh { animation: land 900ms ease-out both; }
@keyframes land { from { background: var(--telemetry); color: var(--on-telemetry); } to { background: transparent; } }
@media (prefers-reduced-motion: reduce) { .badge.fresh { animation: none; } .network span { transition: none; } }

@media (max-width: 34rem) {
  body { padding: 28px 12px 48px; }
  .pay { flex-direction: column-reverse; }
  .qr { align-self: center; }
}
`

const SCRIPT = `
const data = JSON.parse(document.getElementById('data').textContent);
const byKey = Object.fromEntries(data.networks.map((n) => [n.key, n]));

// Counted from when the page arrived, so a wrong clock on this device does not matter.
const deadline = Date.now() + data.secondsLeft * 1000;
const clock = document.getElementById('clock');
let timer = null;
function expire() {
  clearInterval(timer);
  document.getElementById('live')?.remove();
  document.getElementById('expired').hidden = false;
}
function countDown() {
  const left = Math.ceil((deadline - Date.now()) / 1000);
  if (left <= 0) return expire();
  clock.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
}
if (clock) {
  countDown();
  timer = setInterval(countDown, 1000);
}

function showNetwork(key) {
  const network = byKey[key];
  document.getElementById('notice').textContent =
    'Send only USDT, and only on ' + network.name + '. Payments are credited once they total ' +
    network.minAmount + ' USDT or more.';
}
for (const input of document.querySelectorAll('.network input')) {
  input.addEventListener('change', () => showNetwork(input.value));
  if (input.checked) showNetwork(input.value);
}

const copy = document.getElementById('copy');
copy?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(data.address);
    copy.textContent = 'Address copied';
  } catch {
    copy.textContent = 'Copy failed. Select the address instead';
  }
  setTimeout(() => { copy.textContent = 'Copy address'; }, 2000);
});

// Transactions already shown as credited, so the badge only flashes when one lands.
let credited = null;

function row(transfer, fresh) {
  const network = byKey[transfer.chain];
  const item = document.createElement('li');

  const left = document.createElement('div');
  const amount = document.createElement('span');
  amount.className = 'amount';
  amount.textContent = transfer.amount + ' USDT';
  const where = document.createElement('span');
  where.className = 'where';
  where.textContent = 'on ' + (network ? network.name : transfer.chain);
  if (network && network.explorerTx) {
    const link = document.createElement('a');
    link.href = network.explorerTx + transfer.tx_hash;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'view transaction';
    where.append(', ', link);
  }
  left.append(amount, where);

  const state = document.createElement('span');
  if (transfer.status === 'pending') {
    state.className = 'badge';
    state.textContent = 'Confirming';
  } else if (transfer.credited) {
    state.className = fresh ? 'badge ok fresh' : 'badge ok';
    state.textContent = 'Credited';
  } else {
    state.className = 'badge no';
    state.textContent = 'Not credited yet';
    where.append(network ? ', counts once payments here total ' + network.minAmount + ' USDT' : ', below the minimum so far');
  }
  item.append(left, state);
  return item;
}

async function refresh() {
  try {
    const response = await fetch(location.pathname + '/status', { cache: 'no-store' });
    if (!response.ok) return;
    const { expired, transfers } = await response.json();
    if (expired) expire();
    const now = new Set(transfers.filter((t) => t.credited).map((t) => t.tx_hash));
    const rows = transfers.map((t) => row(t, credited !== null && t.credited && !credited.has(t.tx_hash)));
    credited = now;
    document.getElementById('empty').hidden = transfers.length > 0;
    document.getElementById('payments').replaceChildren(...rows);
  } catch {}
}
refresh();
setInterval(refresh, 5000);
`

function page(nonce: string, title: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<link rel="preload" href="/assets/fonts/golos-text.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/jetbrains-mono.woff2" as="font" type="font/woff2" crossorigin>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
${script}
</body>
</html>`
}

/** "0x" followed by ten groups of four; the first and last groups are what people verify. */
function groupedAddress(address: string): string {
  const groups = Array.from({ length: 10 }, (_, i) => address.slice(2 + i * 4, 6 + i * 4))
  const spans = groups.map((group, i) => {
    const edge = i === 0 || i === groups.length - 1
    return `<span${edge ? ' class="edge"' : ''}>${escapeHtml(group)}</span>`
  })
  return `<span>0x</span>${spans.join('')}`
}

export async function renderCheckout(view: CheckoutView): Promise<string> {
  const qr = await QRCode.toDataURL(view.address, {
    margin: 0,
    width: 512,
    errorCorrectionLevel: 'M',
    color: { dark: '#07090d', light: '#eef2f7' },
  })
  const networks = view.networks
    .map(
      (n, i) => `<label class="network">
      <input type="radio" name="network" value="${escapeHtml(n.key)}"${i === 0 ? ' checked' : ''}>
      <span><b>${escapeHtml(n.name)}</b><small>${escapeHtml(n.minAmount)} USDT minimum</small></span>
    </label>`,
    )
    .join('\n    ')
  const first = view.address.slice(0, 6)
  const last = view.address.slice(-4)
  const minutes = Math.floor(view.secondsLeft / 60)
  const clock = `${minutes}:${String(view.secondsLeft % 60).padStart(2, '0')}`
  // Once expired, the address is not on the page at all, so nobody copies it from a stale tab.
  const live = view.secondsLeft === 0 ? '' : `<div id="live" class="stack">
  <section class="card">
    <h2 class="card-head" id="network-heading">Network you send on</h2>
    <div class="card-body">
      <div class="networks" role="radiogroup" aria-labelledby="network-heading">
    ${networks}
      </div>
    </div>
  </section>

  <section class="card">
    <h2 class="card-head">Deposit address</h2>
    <div class="card-body">
      <div class="pay">
        <div class="well"><p class="address" aria-label="${escapeHtml(view.address)}">${groupedAddress(view.address)}</p></div>
        <img class="qr" src="${qr}" alt="QR code of the address">
      </div>
      <div class="actions">
        <button type="button" class="go" id="copy">Copy address</button>
        <p class="fine">After pasting, check that it starts with ${escapeHtml(first)} and ends with ${escapeHtml(last)}.</p>
      </div>
      <p class="notice" id="notice" role="note"></p>
      <p class="fine">This address is yours for <span class="clock" id="clock" role="timer">${clock}</span> more. Send before then: a payment sent in time counts even if it arrives later.</p>
    </div>
  </section>
  </div>`
  const body = `  <header>
    <h1>Top up with USDT</h1>
    <p class="lede">Send from any wallet or exchange. This page updates on its own when your payment arrives.</p>
  </header>

  ${live}
  <section class="card" id="expired"${view.secondsLeft === 0 ? '' : ' hidden'}>
    <h2 class="card-head">Deposit address</h2>
    <div class="card-body">
      <p class="notice" role="alert">This address has expired. Don't send to it. Start a new payment from where you came, and you get a new address.</p>
      <p class="fine">A payment you sent before it expired is still credited when it arrives, and shows below.</p>
    </div>
  </section>

  <section class="card">
    <h2 class="card-head">Payments to this address</h2>
    <div class="card-body">
      <p class="fine" id="empty">Nothing received yet. A transfer usually shows up here within a minute of being sent.</p>
      <ul class="payments" id="payments" aria-live="polite"></ul>
    </div>
  </section>`
  const script = `<script type="application/json" id="data">${scriptJson({ address: view.address, secondsLeft: view.secondsLeft, networks: view.networks })}</script>
<script nonce="${view.nonce}">${SCRIPT}</script>`
  return page(view.nonce, 'Top up with USDT', body, script)
}

export function renderNotFound(nonce: string): string {
  const body = `  <header>
    <h1>This top-up link doesn't work</h1>
    <p class="lede">The address in your browser may be incomplete. Open the link again from where you got it, or ask for a new one. Don't send funds until you see a deposit address.</p>
  </header>`
  return page(nonce, "Top-up link doesn't work", body)
}
