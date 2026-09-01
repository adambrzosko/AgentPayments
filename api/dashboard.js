/**
 * Vendor dashboard HTML generator.
 *
 * Renders a self-contained HTML page with:
 *   - Key issuance stats (all-time + this month)
 *   - 30-day bar chart (inline SVG)
 *   - On-chain platform fee status
 *   - API key management (masked, with rotation)
 *   - Account details
 */

'use strict';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Shows enough of the key to recognize it, masks the rest. */
function maskApiKey(key) {
  if (!key || key.length < 24) return key;
  return `${key.slice(0, 16)}${'•'.repeat(16)}${key.slice(-6)}`;
}

/**
 * @param {object} vendor     — vendor record from store
 * @param {number} thisMonth  — keys issued this billing period
 * @param {Array}  dailyUsage — [{ day: 'YYYY-MM-DD', count: N }, ...]
 * @param {object} opts
 * @param {string|null} opts.platformFeeWallet   — current global fee wallet, or null if fee enforcement is off
 * @param {number|null} opts.platformFeeRatePct  — current global fee rate, meaningful only when platformFeeWallet is set
 * @param {string} [opts.newApiKey]              — set immediately after a rotation, shown once in a reveal banner
 * @param {Array}  [opts.domains]                — vendor's registered domains, see serializeDomain in server.js
 * @param {string} [opts.domainError]            — error message from the last domain action, shown inline
 */
function dashboardHtml(vendor, thisMonth, dailyUsage, opts = {}) {
  const { platformFeeWallet, platformFeeRatePct, newApiKey, domains, domainError } = opts;
  const chart = buildChart(dailyUsage);
  const feeHtml = buildFeeSection(platformFeeWallet, platformFeeRatePct);
  const apiKeyHtml = buildApiKeySection(vendor, newApiKey);
  const domainsHtml = buildDomainsSection(domains, domainError);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentPayments — Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5; color: #1a1a1a; min-height: 100vh; }
    header { background: #111; color: #fff; padding: 16px 32px; display: flex; align-items: center; justify-content: space-between; }
    header h1 { font-size: 18px; font-weight: 600; letter-spacing: -0.3px; }
    header .meta { font-size: 13px; color: #aaa; }
    header a.logout { color: #aaa; font-size: 13px; text-decoration: none; margin-left: 20px; }
    header a.logout:hover { color: #fff; }
    main { max-width: 960px; margin: 32px auto; padding: 0 24px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .card { background: #fff; border-radius: 10px; padding: 20px 24px; border: 1px solid #e8e8e8; }
    .card .label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.6px; color: #888; margin-bottom: 8px; }
    .card .value { font-size: 32px; font-weight: 700; line-height: 1; }
    .card .sub { font-size: 12px; color: #999; margin-top: 6px; }
    .card.green .value { color: #16a34a; }
    .card.amber .value { color: #d97706; }
    .section { background: #fff; border-radius: 10px; border: 1px solid #e8e8e8; padding: 24px; margin-bottom: 24px; }
    .section h2 { font-size: 15px; font-weight: 600; margin-bottom: 20px; color: #111; }
    .chart-wrap { overflow-x: auto; }
    .chart-wrap svg { display: block; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 32px; }
    .info-row { display: flex; flex-direction: column; gap: 2px; }
    .info-row .k { font-size: 11px; color: #999; text-transform: uppercase; letter-spacing: 0.5px; }
    .info-row .v { font-size: 14px; color: #222; font-family: monospace; word-break: break-all; }
    .badge { display: inline-block; padding: 3px 9px; border-radius: 99px; font-size: 11px; font-weight: 600; }
    .badge.verified { background: #dcfce7; color: #16a34a; }
    .badge.unverified { background: #fef9c3; color: #a16207; }
    .badge.free { background: #e0e7ff; color: #3730a3; }
    .fee-note { font-size: 13px; color: #444; line-height: 1.6; }
    .new-key-banner { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px 18px; margin-bottom: 16px; }
    .new-key-banner-title { font-size: 14px; font-weight: 700; color: #15803d; margin-bottom: 4px; }
    .new-key-banner-sub { font-size: 12px; color: #4b5563; margin-bottom: 12px; }
    .new-key-value { display: block; font-family: monospace; font-size: 13px; background: #fff; border: 1px solid #d1d5db; border-radius: 6px; padding: 10px 12px; word-break: break-all; }
    .rotate-link { display: inline-block; margin-top: 16px; font-size: 13px; color: #b91c1c; text-decoration: none; font-weight: 500; }
    .rotate-link:hover { text-decoration: underline; }
    .error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; border-radius: 6px; padding: 10px 14px; font-size: 13px; }
    .domain-row { padding: 14px 0; border-bottom: 1px solid #f0f0f0; }
    .domain-row:last-of-type { border-bottom: none; }
    .domain-info { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    .domain-name { font-family: monospace; font-size: 14px; }
    .domain-instructions { font-size: 12px; color: #666; line-height: 1.7; margin-bottom: 10px; }
    .domain-instructions code { background: #f5f5f5; padding: 2px 5px; border-radius: 4px; }
    .token-value { display: block; margin-top: 4px; word-break: break-all; font-family: monospace; }
    .domain-actions { display: flex; gap: 10px; }
    .mini-btn { padding: 6px 12px; font-size: 12px; font-weight: 600; border: 1px solid #ddd; border-radius: 6px; background: #fff; cursor: pointer; color: #333; }
    .mini-btn:hover { background: #f5f5f5; }
    .mini-btn.danger { color: #b91c1c; border-color: #fecaca; }
    .mini-btn.danger:hover { background: #fef2f2; }
    .add-domain-form { margin-top: 16px; display: flex; gap: 8px; }
    .add-domain-form input { flex: 1; padding: 9px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; }
    .add-domain-form input:focus { outline: none; border-color: #111; }
  </style>
</head>
<body>
  <header>
    <h1>AgentPayments</h1>
    <div style="display:flex;align-items:center;gap:4px">
      <span class="meta">${escapeHtml(vendor.name || vendor.email)}</span>
      <a class="logout" href="/dashboard/logout">Sign out</a>
    </div>
  </header>
  <main>
    <div class="cards">
      <div class="card">
        <div class="label">Keys issued — all time</div>
        <div class="value">${Number(vendor.keys_issued ?? vendor.keysIssued ?? 0).toLocaleString()}</div>
      </div>
      <div class="card">
        <div class="label">Keys issued — this month</div>
        <div class="value">${Number(thisMonth).toLocaleString()}</div>
      </div>
      <div class="card ${vendor.email_verified ?? vendor.emailVerified ? 'green' : 'amber'}">
        <div class="label">Account status</div>
        <div class="value" style="font-size:20px;padding-top:6px">
          ${vendor.email_verified ?? vendor.emailVerified
            ? '<span class="badge verified">Verified</span>'
            : '<span class="badge unverified">Pending verification</span>'}
        </div>
      </div>
      <div class="card">
        <div class="label">Plan</div>
        <div class="value" style="font-size:20px;padding-top:6px">
          <span class="badge free">${escapeHtml(vendor.plan || 'free')}</span>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Key issuance — last 30 days</h2>
      <div class="chart-wrap">
        ${chart}
      </div>
    </div>

    ${feeHtml}

    ${apiKeyHtml}

    ${domainsHtml}

    <div class="section">
      <h2>Account details</h2>
      <div class="info-grid">
        <div class="info-row"><span class="k">Vendor ID</span><span class="v">${escapeHtml(vendor.vendor_id || vendor.vendorId)}</span></div>
        <div class="info-row"><span class="k">Email</span><span class="v">${escapeHtml(vendor.email)}</span></div>
        <div class="info-row"><span class="k">Member since</span><span class="v">${new Date(Number(vendor.created_at || vendor.createdAt)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span></div>
      </div>
    </div>
  </main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// SVG bar chart (server-side, no JS required)
// ---------------------------------------------------------------------------

function buildChart(dailyUsage) {
  // Fill in zeros for missing days over the last 30 days
  const today = new Date();
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const byDay = Object.fromEntries((dailyUsage || []).map((r) => [r.day, Number(r.count)]));
  const counts = days.map((d) => byDay[d] || 0);
  const max = Math.max(...counts, 1);

  const W = 900, H = 140, PAD = { top: 8, bottom: 28, left: 0, right: 0 };
  const barW = Math.floor((W - PAD.left - PAD.right) / 30) - 2;
  const chartH = H - PAD.top - PAD.bottom;

  const bars = counts.map((c, i) => {
    const barH = Math.max(c === 0 ? 2 : Math.round((c / max) * chartH), 2);
    const x = PAD.left + i * (barW + 2);
    const y = PAD.top + chartH - barH;
    const fill = c === 0 ? '#e5e7eb' : '#111';
    const label = days[i].slice(5); // MM-DD
    const showLabel = i === 0 || i === 14 || i === 29;
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${fill}" rx="2">
        <title>${days[i]}: ${c} key${c !== 1 ? 's' : ''}</title>
      </rect>
      ${showLabel ? `<text x="${x + barW / 2}" y="${H - 6}" text-anchor="middle" font-size="10" fill="#999">${label}</text>` : ''}`;
  }).join('');

  // Y-axis hint
  const yHint = `<text x="${W - 2}" y="${PAD.top + 4}" text-anchor="end" font-size="10" fill="#ccc">${max}</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg"
    role="img" aria-label="30-day key issuance chart">
    ${yHint}
    ${bars}
  </svg>`;
}

function buildFeeSection(platformFeeWallet, platformFeeRatePct) {
  return `
    <div class="section">
      <h2>On-chain platform fee</h2>
      ${platformFeeWallet
        ? `<p class="fee-note">Agents using your hosted keys pay an additional <strong>${escapeHtml(String(platformFeeRatePct))}%</strong> platform fee in the same Solana transaction as their payment to you. Your own payment still goes directly to your wallet — the fee is a separate transfer to AgentPayments, never routed through your account.</p>`
        : `<p class="fee-note">No platform fee is currently active on your account. Payments from agents go directly to your wallet on-chain — AgentPayments never holds or routes your funds.</p>`}
    </div>`;
}

function buildApiKeySection(vendor, newApiKey) {
  const currentKey = vendor.api_key ?? vendor.apiKey;
  return `
    <div class="section">
      <h2>API key</h2>
      ${newApiKey ? `
        <div class="new-key-banner">
          <div class="new-key-banner-title">Your API key was rotated</div>
          <div class="new-key-banner-sub">Update your SDK config with this key now — the old one stopped working immediately. It won't be shown again after you leave this page.</div>
          <code class="new-key-value">${escapeHtml(newApiKey)}</code>
        </div>` : `
        <div class="info-row">
          <span class="k">Current key</span>
          <span class="v">${escapeHtml(maskApiKey(currentKey))}</span>
        </div>`}
      <a class="rotate-link" href="/dashboard/rotate-key">Rotate API key →</a>
    </div>`;
}

function buildDomainsSection(domains, domainError) {
  const rows = (domains || []).map((d) => `
    <div class="domain-row">
      <div class="domain-info">
        <span class="domain-name">${escapeHtml(d.domain)}</span>
        ${d.verified ? '<span class="badge verified">Verified</span>' : '<span class="badge unverified">Unverified</span>'}
      </div>
      ${d.verified ? '' : `
        <div class="domain-instructions">
          Publish a file at <code>${escapeHtml(d.verifyUrl)}</code> whose contents are exactly:
          <code class="token-value">${escapeHtml(d.verificationToken)}</code>
        </div>`}
      <div class="domain-actions">
        ${d.verified ? '' : `
          <form method="POST" action="/dashboard/domains/${encodeURIComponent(d.id)}/verify">
            <button type="submit" class="mini-btn">Check now</button>
          </form>`}
        <form method="POST" action="/dashboard/domains/${encodeURIComponent(d.id)}/delete">
          <button type="submit" class="mini-btn danger">Remove</button>
        </form>
      </div>
    </div>`).join('') || '<p class="fee-note">No domains added yet.</p>';

  return `
    <div class="section">
      <h2>Domain ownership</h2>
      ${domainError ? `<div class="error" style="margin-bottom:16px">${escapeHtml(domainError)}</div>` : ''}
      <p class="fee-note" style="margin-bottom:12px">Verify a domain to prove you control the resource you're gating with AgentPayments. This will be required before payout onboarding.</p>
      ${rows}
      <form method="POST" action="/dashboard/domains" class="add-domain-form">
        <input type="text" name="domain" placeholder="example.com" required>
        <button type="submit" class="mini-btn">Add domain</button>
      </form>
    </div>`;
}

// ---------------------------------------------------------------------------
// Login page
// ---------------------------------------------------------------------------

function loginHtml(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentPayments — Sign in</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .box { background: #fff; border: 1px solid #e8e8e8; border-radius: 12px; padding: 40px; width: 100%; max-width: 400px; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
    p { font-size: 14px; color: #666; margin-bottom: 24px; }
    label { font-size: 13px; font-weight: 500; display: block; margin-bottom: 6px; }
    input { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; font-family: monospace; margin-bottom: 16px; }
    input:focus { outline: none; border-color: #111; box-shadow: 0 0 0 2px rgba(0,0,0,0.08); }
    button { width: 100%; padding: 11px; background: #111; color: #fff; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #333; }
    .error { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; border-radius: 6px; padding: 10px 14px; font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="box">
    <h1>AgentPayments</h1>
    <p>Enter your platform API key to view your dashboard.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form method="POST" action="/dashboard/login">
      <label for="key">Platform API key</label>
      <input id="key" name="key" type="password" placeholder="ap_live_..." autocomplete="off" required>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Rotate-key confirmation page
// ---------------------------------------------------------------------------

function rotateKeyConfirmHtml(vendor) {
  const currentKey = vendor.api_key ?? vendor.apiKey;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentPayments — Rotate API key</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f5; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .box { background: #fff; border: 1px solid #e8e8e8; border-radius: 12px; padding: 40px; width: 100%; max-width: 440px; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
    p { font-size: 14px; color: #444; margin-bottom: 16px; line-height: 1.6; }
    .warning { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; border-radius: 6px; padding: 12px 14px; font-size: 13px; margin-bottom: 20px; line-height: 1.6; }
    .current-key { display: block; font-family: monospace; font-size: 12px; background: #f5f5f5; border-radius: 6px; padding: 10px 12px; word-break: break-all; margin-bottom: 24px; color: #555; }
    .actions { display: flex; gap: 10px; }
    button { flex: 1; padding: 11px; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
    .confirm { background: #b91c1c; color: #fff; }
    .confirm:hover { background: #991b1b; }
    .cancel { background: #f0f0f0; color: #333; text-decoration: none; text-align: center; display: flex; align-items: center; justify-content: center; }
    .cancel:hover { background: #e5e5e5; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Rotate API key</h1>
    <p>This generates a new platform API key and immediately deactivates the current one.</p>
    <div class="warning">Any SDK deployment still configured with the current key will start getting <code>401 Unauthorized</code> until you update it with the new key.</div>
    <span class="current-key">${escapeHtml(maskApiKey(currentKey))}</span>
    <div class="actions">
      <a class="cancel" href="/dashboard">Cancel</a>
      <form method="POST" action="/dashboard/rotate-key" style="flex:1">
        <button type="submit" class="confirm">Rotate now</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { dashboardHtml, loginHtml, rotateKeyConfirmHtml };
