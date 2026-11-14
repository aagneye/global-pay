/**
 * The operator page. Plain HTML and script with no build step; served with a strict CSP, so the
 * script and styles are separate files. Partner data is shown with textContent only, never as HTML.
 */

export const OPS_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>GlobalPay operations</title>
<link rel="stylesheet" href="/ops/ops.css">
</head>
<body>
<header>
  <h1>GlobalPay operations</h1>
  <form id="login">
    <label>Operator <input id="actor" autocomplete="username" required minlength="2" placeholder="your name"></label>
    <label>Token <input id="token" type="password" autocomplete="current-password" required></label>
    <button type="submit">Connect</button>
    <button type="button" id="refresh">Refresh</button>
  </form>
  <p id="status" role="status"></p>
</header>
<main>
  <section>
    <h2>Health</h2>
    <ul id="alerts"></ul>
    <dl id="health"></dl>
  </section>
  <section>
    <h2>Needs attention</h2>
    <div class="scroll">
      <table>
        <thead><tr><th></th><th>Kind</th><th>Payment</th><th>Amount</th><th>Merchant</th><th>Payout</th><th>Since</th><th>Detail</th><th>Actions</th></tr></thead>
        <tbody id="exceptions"></tbody>
      </table>
    </div>
    <p id="empty" hidden>Nothing needs attention.</p>
  </section>
  <section>
    <h2>Payout detail</h2>
    <pre id="detail">Choose a payment above.</pre>
  </section>
  <section>
    <h2>Audit log</h2>
    <div class="scroll">
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Payment</th><th>Note</th></tr></thead>
        <tbody id="actions"></tbody>
      </table>
    </div>
  </section>
</main>
<script src="/ops/ops.js"></script>
</body>
</html>
`;

export const OPS_STYLE = `
:root { color-scheme: light dark; --bg: #fff; --fg: #1a1a1a; --muted: #666; --line: #ddd; --bad: #b42318; --warn: #b54708; --ok: #067647; }
@media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #eee; --muted: #999; --line: #333; --bad: #f97066; --warn: #fdb022; --ok: #47cd89; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; font: 14px/1.45 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
h1 { font-size: 20px; margin: 0 0 8px; } h2 { font-size: 16px; margin: 24px 0 8px; }
form { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; }
label { display: flex; flex-direction: column; font-size: 12px; color: var(--muted); }
input { font: inherit; padding: 6px 8px; min-width: 180px; }
button { font: inherit; padding: 6px 10px; cursor: pointer; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; }
td button { margin: 0 4px 4px 0; padding: 2px 8px; }
.escalated { color: var(--bad); font-weight: 700; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; }
#alerts li { color: var(--warn); } #alerts li.ok { color: var(--ok); }
#status { color: var(--muted); min-height: 1.4em; }
#status.error { color: var(--bad); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; } dt { color: var(--muted); } dd { margin: 0; }
pre { background: color-mix(in srgb, var(--fg) 6%, transparent); padding: 12px; overflow: auto; max-height: 420px; }
`;

export const OPS_SCRIPT = `
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(key) { try { return sessionStorage.getItem(key) || ''; } catch { return ''; } },
    set(key, value) { try { sessionStorage.setItem(key, value); } catch { /* private mode */ } },
  };
  $('token').value = store.get('ops-token');
  $('actor').value = store.get('ops-actor');

  function say(text, isError) {
    $('status').textContent = text;
    $('status').className = isError ? 'error' : '';
  }

  async function call(path, body) {
    const response = await fetch('/ops/api' + path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'x-ops-token': $('token').value }, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || response.statusText);
    return data;
  }

  function cell(row, text, className) {
    const td = document.createElement('td');
    td.textContent = text == null ? '' : String(text);
    if (className) td.className = className;
    row.appendChild(td);
    return td;
  }

  const baht = (amount) => (Number(amount.minor) / 100).toFixed(2) + ' ' + amount.currency;
  // Tap-to-pay rows carry USDC base units (6 decimals).
  const money = (amount) => (amount.currency === 'USDC' ? (Number(amount.minor) / 1e6).toFixed(2) + ' USDC' : baht(amount));
  const when = (iso) => new Date(iso).toLocaleString();

  function renderHealth(health) {
    const alerts = $('alerts');
    alerts.replaceChildren();
    for (const text of health.alerts.length ? health.alerts : ['All clear']) {
      const li = document.createElement('li');
      li.textContent = text;
      if (!health.alerts.length) li.className = 'ok';
      alerts.appendChild(li);
    }
    const rows = [
      ['Payout partner', health.partner.name + (health.partner.ok ? '' : ' (check)')],
      ['Payout float', health.partner.float ? baht(health.partner.float) : 'not reported'],
      ['Relayer', health.relayer ? health.relayer.address + ' · ' + (Number(health.relayer.wei) / 1e18).toFixed(5) + ' ETH' : 'none'],
      ['Payouts', Object.entries(health.payouts).map(([status, count]) => status + ' ' + count).join(' · ')],
      ['Checked', when(health.checkedAt)],
    ];
    const dl = $('health');
    dl.replaceChildren();
    for (const [term, value] of rows) {
      const dt = document.createElement('dt'); dt.textContent = term;
      const dd = document.createElement('dd'); dd.textContent = value;
      dl.append(dt, dd);
    }
  }

  function button(td, label, handler) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', handler);
    td.appendChild(b);
  }

  async function act(id, path, extra) {
    const actor = $('actor').value.trim();
    if (actor.length < 2) return say('Enter your name first', true);
    const note = window.prompt('Why? (kept in the audit log)');
    if (!note) return;
    try {
      const { payout } = await call('/payouts/' + encodeURIComponent(id) + path, Object.assign({ actor, note }, extra));
      say('Done: payout is now ' + payout.status);
    } catch (error) {
      say(error.message, true);
    }
    await refresh();
  }

  function renderExceptions(items) {
    const body = $('exceptions');
    body.replaceChildren();
    $('empty').hidden = items.length > 0;
    for (const item of items) {
      const row = document.createElement('tr');
      cell(row, item.escalated ? '!' : '', item.escalated ? 'escalated' : '');
      cell(row, item.kind.replaceAll('_', ' '));
      const id = cell(row, item.paymentId, 'mono');
      if (!item.kind.startsWith('p2p_')) {
        id.title = 'Show detail';
        id.style.cursor = 'pointer';
        id.addEventListener('click', () => detail(item.paymentId));
      }
      cell(row, money(item.amount));
      cell(row, item.merchant, 'mono');
      cell(row, [item.paymentStatus, item.payoutStatus, item.providerReference].filter(Boolean).join(' / '));
      cell(row, when(item.since));
      cell(row, item.lastError);
      const actions = cell(row, '');
      if (item.payoutStatus) button(actions, 'Re-check', () => act(item.paymentId, '/recheck'));
      if (item.payoutStatus === 'UNKNOWN') {
        button(actions, 'Mark paid', () => {
          const reference = window.prompt('Bank or partner reference proving the merchant was paid');
          if (reference) act(item.paymentId, '/mark-paid', { reference });
        });
        button(actions, 'Approve refund', () => {
          if (window.confirm('Refund the user? Only if the merchant was definitely not paid.')) act(item.paymentId, '/approve-refund');
        });
      }
      body.appendChild(row);
    }
  }

  function renderActions(items) {
    const body = $('actions');
    body.replaceChildren();
    for (const item of items) {
      const row = document.createElement('tr');
      cell(row, when(item.createdAt));
      cell(row, item.actor);
      cell(row, item.action);
      cell(row, item.targetId, 'mono');
      cell(row, item.note);
      body.appendChild(row);
    }
  }

  async function detail(id) {
    try {
      $('detail').textContent = JSON.stringify(await call('/payouts/' + encodeURIComponent(id)), null, 2);
    } catch (error) {
      $('detail').textContent = error.message;
    }
  }

  async function refresh() {
    if (!$('token').value) return say('Enter the operator token');
    try {
      const [health, exceptions, actions] = await Promise.all([call('/health'), call('/exceptions'), call('/actions')]);
      renderHealth(health);
      renderExceptions(exceptions.items);
      renderActions(actions.items);
      if ($('status').className !== 'error') say('Updated ' + new Date().toLocaleTimeString());
    } catch (error) {
      say(error.message, true);
    }
  }

  $('login').addEventListener('submit', (event) => {
    event.preventDefault();
    store.set('ops-token', $('token').value);
    store.set('ops-actor', $('actor').value.trim());
    say('');
    refresh();
  });
  $('refresh').addEventListener('click', () => { say(''); refresh(); });
  setInterval(refresh, 15000);
  refresh();
})();
`;
