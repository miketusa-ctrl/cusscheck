import { PRO_PORTAL_URL } from './pro.js';
// Static pages. User-provided text is only ever rendered client-side with textContent (never innerHTML).
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');
// Support address comes from the SUPPORT_EMAIL var (wrangler.toml); nothing is rendered if it's unset.
const contact = (o, prefix = '') => (o.supportEmail ? `${prefix}<a href="mailto:${esc(o.supportEmail)}">${esc(o.supportEmail)}</a>` : '');

function limitations(o) {
  return `<h2 id="limitations">Limitations</h2>
<ul>
<li>English only. It's a word list, so it doesn't judge context, intent or tone, and it can miss new slang.</li>
<li>Not caught: letters split across lines, spaced letters followed by a word (<code>f u c king</code>), most symbol-masked spellings (<code>f**k</code>, <code>b*tch</code>, <code>s**t</code>), phonetic spellings (<code>phuck</code>), deliberate misspellings and words outside the list. Standalone <code>fu</code>/<code>FU</code> is not flagged on purpose (kung fu, Fu Manchu); masked forms like <code>fu*k</code>, <code>fu**ing</code> and <code>fu.ck</code> are, but not <code>fu ck</code> (space), doubled separators (<code>fu..ck</code>, <code>fu--ck</code>) or a hidden character between <code>fu</code> and the mask (e.g. a zero-width space in <code>fu*k</code>).</li>
<li>Caught: leetspeak (<code>sh1t</code>, <code>$h!t</code>), look-alike and accented letters (<code>fück</code>, <code>ｆｕｃｋ</code>), repeated letters (<code>fuuuck</code>), dotted/spaced letters (<code>f.u.c.k</code>, <code>s h i t</code>), dotted letters with a suffix (<code>f.u.c.king</code>, <code>s.h.i.tty</code>), and hidden characters (soft hyphens, zero-width and direction-control characters, other invisible format characters, combining and enclosing marks).</li>
<li>It can flag innocent words that contain a swear word. We whitelist the common ones (like Scunthorpe, cockpit, shiitake, Shiite, cumin, Fukushima, Dickinson). Known false positives: the first name <code>Dick</code> and the place/surname <code>Cumming</code> (e.g. Cumming, Georgia) are still flagged; add <code>"dick"</code> or <code>"cum"</code> to <code>allow</code> if your text has them. Note that <code>allow: ["cum"]</code> turns off <em>all</em> detection of that word (including its slang use), so only use it if place/surname text matters more to you. Rare edge cases also flagged: <code>Fu-kien</code> (old spelling of Fujian) and <code>fu.kr</code>-style domains. Use <code>allow</code> for any others.</li>
</ul>`;
}

const STYLE = `
:root{--fg:#1d2330;--muted:#5b6475;--bg:#f7f8fb;--card:#fff;--line:#dfe3ea;--acc:#2f5bd3;--bad:#b42318;--ok:#067647}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}
header,main,footer{max-width:900px;margin:0 auto;padding:0 18px}header{display:flex;justify-content:space-between;align-items:center;padding-top:18px;flex-wrap:wrap;gap:8px}
header a.brand{font-weight:700;font-size:20px;color:var(--fg);text-decoration:none}nav a{margin-left:16px;color:var(--acc);text-decoration:none}
h1{font-size:30px;margin:22px 0 4px}h2{margin-top:34px}.lead{color:var(--muted);margin-top:0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
textarea{width:100%;min-height:170px;font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:10px;border:1px solid var(--line);border-radius:8px;resize:vertical}
input[type=text]{width:100%;padding:8px;border:1px solid var(--line);border-radius:6px;font:inherit}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.row>label{flex:1;min-width:220px;font-size:14px;color:var(--muted)}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.6}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px}pre{background:#0f1729;color:#e6ebf5;padding:12px;border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-word}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.bad{color:var(--bad);font-weight:700}.ok{color:var(--ok);font-weight:700}.muted{color:var(--muted);font-size:14px}
.tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.tier h3{margin:0 0 4px}.price{font-size:22px;font-weight:700}
.banner{background:#fff4e5;border:1px solid #f5c26b;padding:8px 12px;border-radius:8px;font-size:14px;margin-top:12px}
footer{color:var(--muted);font-size:13px;padding:30px 18px 40px}footer a{color:var(--muted)}
#mcp-config{display:block;white-space:pre;overflow-x:auto}
@media (max-width:560px){#mcp-config{white-space:pre-wrap;word-break:break-all}}`;

function layout(o, title, desc, body) {
  const banner = o.publicLaunch ? '' : `<div class="banner">Preview build (${esc(o.env)}). Not publicly launched yet.</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">${o.publicLaunch ? '' : '<meta name="robots" content="noindex,nofollow">'}
<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt"><link rel="service-desc" type="application/json" href="/openapi.json">
<style>${STYLE}</style></head><body>
<header><a class="brand" href="/">${esc(o.brand)}</a><nav><a href="/">Paste tool</a><a href="/docs">API docs</a><a href="/privacy">Privacy</a></nav></header>
<main>${banner}${body}</main>
<footer>${esc(o.brand)} v${esc(o.version)}: an English profanity word filter (word list + obfuscation handling, not AI moderation). Matching runs in memory with the open-source <a href="https://github.com/jo3-l/obscenity" target="_blank" rel="noopener noreferrer">obscenity</a> library (MIT). We never store or log the text you submit. <a href="/privacy">Privacy</a> · <a href="/docs">API docs</a> · <a href="/health">Status</a>${contact(o, ' · Contact: ')}</footer>
</body></html>`;
}

function pricing(o) {
  return `<h2 id="pricing">Pricing</h2>
<div class="tiers">
<div class="card tier"><h3>Free</h3><div class="price">$0</div><p>${fmt(o.keyDaily)} requests/day with a free API key (${fmt(o.keyPerMin)}/min). Commercial use allowed. No card, no sign-up form.</p><p class="muted">Without a key: ${fmt(o.anonDaily)}/day and ${fmt(o.anonPerMin)}/min per IP.</p></div>
${o.proCheckout ? proTier(o) : `<div class="card tier"><h3>Starter <span class="muted">(coming soon)</span></h3><div class="price">~$9/mo</div><p>About 100,000 requests/month.</p></div>
<div class="card tier"><h3>Pro <span class="muted">(coming soon)</span></h3><div class="price">~$29/mo</div><p>About 1,000,000 requests/month, plus saved custom allow/deny lists.</p></div>`}
</div><p class="muted">${o.proCheckout ? `Payments are handled by Polar (polar.sh), our merchant of record; see <a href="/privacy#payments">Privacy</a>. Manage or cancel a subscription in the <a href="${PRO_PORTAL_URL}" target="_blank" rel="noopener noreferrer">Polar customer portal</a>.` : 'Paid tier prices are estimates and not available to buy yet.'} Per-request <code>allow</code>/<code>deny</code> lists (up to ${o.maxListItems} words each) work on every tier, including free.</p>`;
}

// Live only when PRO_CHECKOUT_URL is a Polar checkout link (the launch flag); until then the old "coming soon" cards stay.
function proTier(o) {
  return `<div class="card tier" id="pro"><h3>Pro</h3><div class="price">$${o.proPrice}/month</div><p>${fmt(o.proDaily)} requests/day per license (${fmt(o.keyPerMin)}/min), with its own capacity separate from the free pool. Same engine and limits per request as free. Send your Pro license key in the X-API-Key header (MCP: Authorization: Bearer). Cancel any time.</p><p><a href="${esc(o.proCheckout)}" target="_blank" rel="noopener noreferrer"><strong>Get CussCheck Pro</strong></a> (secure checkout by Polar)</p></div>`;
}

function agents(o) {
  const cfg = JSON.stringify({ mcpServers: { cusscheck: { type: 'http', url: `${o.origin}/mcp` } } }, null, 2);
  return `<h2 id="agents">For AI agents (MCP)</h2>
<p>${esc(o.brand)} is also a remote <a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">Model Context Protocol</a> (MCP) server with one read-only tool, <code>check_profanity</code> (same engine, keys and limits as the API). Most MCP clients accept this config; some use a different format (for example, VS Code uses a <code>servers</code> key). Clients with a settings screen just need the URL <code id="mcp-url">${esc(o.origin)}/mcp</code>.</p>
<pre><code id="mcp-config">${esc(cfg)}</code></pre>
<p class="muted">Optional: add your free key as <code>X-Api-Key</code> or <code>Authorization: Bearer pf_...</code>. Machine-readable docs: <a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/.well-known/mcp/server-card.json">server card</a>.</p>`;
}

export function indexHtml(o) {
  return layout(o, `${o.brand}: free profanity filter and censor API (English)`, 'Paste text to find swear words, including obfuscations like f.u.c.k and sh1t, and get a censored copy. Free profanity word-filter API with 1,000 requests/day.', `
<h1>Profanity filter: find and censor swear words</h1>
<p class="lead">Paste English text to see which swear words it contains, where they are, and a censored copy. It catches common disguises like <code>f.u.c.k</code>, <code>sh1t</code> and <code>fuuuck</code> (see <a href="#limitations">limitations</a>). This is a word filter based on a word list, not AI moderation, and it supports English only.</p>
<div class="card">
<label for="text" class="muted">Text (up to ${fmt(o.maxText)} bytes)</label>
<textarea id="text" maxlength="${o.maxText}" placeholder="Type or paste text here…"></textarea>
<div class="row" style="margin-top:10px">
<label>Allow (comma-separated words never to flag)<input type="text" id="allow" placeholder="e.g. damn, hell"></label>
<label>Deny (comma-separated extra words to flag)<input type="text" id="deny" placeholder="e.g. jerk, idiot"></label>
</div>
<div class="row" style="margin-top:12px"><button id="go">Check text</button><label style="flex:0 0 auto;min-width:0"><input type="checkbox" id="censor" checked> Show censored copy</label><span id="count" class="muted"></span></div>
</div>
<div id="out" class="card" hidden>
<p id="verdict"></p>
<div id="censoredWrap"><h3>Censored copy</h3><pre id="censored"></pre></div>
<h3>Matches</h3><table><thead><tr><th>Term</th><th>Matched text</th><th>Position</th><th>Obfuscated</th></tr></thead><tbody id="rows"></tbody></table>
</div>
<p class="muted">Your text is sent to this site's API, checked in memory, and discarded. It is never stored or logged (<a href="/privacy">privacy</a>).</p>
<h2>Use the API</h2>
<pre>curl -s ${esc(o.origin)}/v1/check \\
  -H 'content-type: application/json' \\
  -d '{"text":"well f.u.c.k that sh1t","censor":true}'</pre>
<p>Get a free key (${fmt(o.keyDaily)} requests/day, commercial use OK): <code>curl -s -X POST ${esc(o.origin)}/v1/keys -H 'content-type: application/json' -d '{}'</code>. Full reference: <a href="/docs">API docs</a>.</p>
${agents(o)}
${limitations(o)}
${pricing(o)}
<p class="muted">Questions or abuse reports: ${contact(o) || 'see the footer'}.</p>
<script src="/app.js"></script>`);
}

export function docsHtml(o) {
  return layout(o, `${o.brand} API docs: profanity detect and censor`, `${o.brand} reference: POST /v1/check, free API keys, limits and errors.`, `
<h1>API docs</h1>
<p class="lead">Base URL: <code>${esc(o.origin)}</code>. JSON in, JSON out. English word list (obscenity englishDataset) with leetspeak, look-alike character, repeated letter and spaced/dotted letter handling. This is a word filter, not AI moderation, and it does not understand context.</p>
<h2>POST /v1/check</h2>
<p>Request body (JSON, at most ${fmt(o.maxBody)} bytes):</p>
<table><tr><th>Field</th><th>Type</th><th>Notes</th></tr>
<tr><td><code>text</code></td><td>string, required</td><td>At most ${fmt(o.maxText)} bytes (UTF-8).</td></tr>
<tr><td><code>censor</code></td><td>boolean, default <code>true</code></td><td>When false, <code>censored</code> is <code>null</code>.</td></tr>
<tr><td><code>allow</code></td><td>string[]</td><td>Words never to flag (up to ${o.maxListItems}, each ≤ ${o.maxListItemLen} chars, letters/spaces/hyphens/apostrophes). Matched against the canonical term (e.g. <code>"shit"</code>) and the matched text. Allow wins over deny. Allowing a canonical term turns off every match of it: <code>allow: ["cum"]</code> clears "Cumming, Georgia" but also all other uses of that word, so use it only for that case.</td></tr>
<tr><td><code>deny</code></td><td>string[]</td><td>Extra words to flag on word boundaries, with the same leetspeak, look-alike and dotted-letter handling (same limits as allow).</td></tr></table>
<pre>curl -s ${esc(o.origin)}/v1/check -H 'content-type: application/json' -H 'x-api-key: pf_…' \\
  -d '{"text":"well f.u.c.k that sh1t, jerk","deny":["jerk"]}'</pre>
<p>Response:</p>
<pre>{
  "ok": true,
  "has_profanity": true,
  "match_count": 3,
  "terms": ["fuck", "shit", "jerk"],
  "matches": [
    { "term": "fuck", "match": "f.u.c.k", "start": 5, "end": 12, "source": "dataset", "obfuscated": true },
    { "term": "shit", "match": "sh1t", "start": 18, "end": 22, "source": "dataset", "obfuscated": false },
    { "term": "jerk", "match": "jerk", "start": 24, "end": 28, "source": "deny", "obfuscated": false }
  ],
  "censored": "well ******* that ****, ****",
  "truncated": false,
  "text_bytes": 28,
  "engine": "obscenity@0.4.6 (englishDataset)",
  "version": "${esc(o.version)}"
}</pre>
<p><code>start</code> is inclusive and <code>end</code> exclusive, in JavaScript string (UTF-16 code unit) indices of your original text, so <code>text.slice(start, end)</code> returns the match. The censored copy replaces each matched code unit with <code>*</code>, so it has the same length as the input and the same positions apply. <code>obfuscated: true</code> means the match was found after joining spaced or dotted single letters (e.g. <code>f.u.c.k</code>, <code>s h i t</code>) or skipping hidden characters (soft hyphen, zero-width and other invisible format characters, combining marks), or on a masked <code>fu*k</code>-style spelling.</p>
<p>The real response is compact JSON (shown indented here). <code>matches</code> lists at most ${fmt(o.maxMatches)} entries in text order; when there are more, <code>truncated</code> is <code>true</code>. <code>match_count</code> and <code>terms</code> always cover every match, and <code>censored</code> always censors all of them.</p>
<h2>POST /v1/keys</h2>
<p>Issues a free API key: ${fmt(o.keyDaily)} requests/day, ${fmt(o.keyPerMin)}/min, commercial use allowed. No email or sign-up needed. The key is shown once; we store only its SHA-256 hash. Up to 3 keys per IP per day (approximate: the counter is eventually consistent, so parallel requests can occasionally get one more). Lost a key or need it revoked? ${contact(o, 'Email ') || 'Contact us.'}</p>
${o.proCheckout ? `<h2 id="pro-keys">CussCheck Pro license keys</h2>
<p>A <a href="/#pro">Pro subscription</a> ($${o.proPrice}/month) comes with a license key starting <code>CCPR-</code>. Send it in <code>X-API-Key</code> (or <code>Authorization: Bearer</code>, e.g. on <code>/mcp</code>) for ${fmt(o.proDaily)} requests/day and ${fmt(o.keyPerMin)}/min, with its own capacity separate from the free pool. <code>GET /v1/usage</code> works with Pro keys. A cancelled or expired license gets the same <code>401 invalid_api_key</code> as any bad key.</p>` : ''}
<pre>curl -s -X POST ${esc(o.origin)}/v1/keys -H 'content-type: application/json' -d '{}'</pre>
<p>Send it as <code>X-API-Key</code>. <code>GET /v1/usage</code> with the header shows today's usage.</p>
<h2>Limits and headers</h2>
<ul><li>Without a key: ${fmt(o.anonPerMin)} requests/min and ${fmt(o.anonDaily)}/day per IP. With a free key: ${fmt(o.keyPerMin)}/min and ${fmt(o.keyDaily)}/day.</li>
<li>Responses carry <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code> and <code>X-RateLimit-Reset</code> (daily quota, reset at 00:00 UTC, Unix seconds), <code>X-RateLimit-Policy</code> and <code>X-API-Plan</code>. A 429 includes <code>Retry-After</code>.</li>
<li>Body over ${fmt(o.maxBody)} bytes: <code>413 body_too_large</code>. Text over ${fmt(o.maxText)} bytes: <code>413 text_too_large</code>.</li>
<li>There is also a service-wide daily soft cap. If it's reached, you get <code>429 daily_cap_reached</code> until 00:00 UTC.</li></ul>
<h2>Errors</h2>
<p>Errors look like <code>{"ok":false,"error":{"code":"…","message":"…"}}</code>. Codes: <code>invalid_json</code>, <code>missing_text</code>, <code>invalid_censor</code>, <code>invalid_allow</code>, <code>invalid_deny</code> (400); <code>invalid_api_key</code>, <code>missing_api_key</code> (401); <code>cross_origin_forbidden</code> (403); <code>not_found</code> (404); <code>method_not_allowed</code> (405); <code>body_too_large</code>, <code>text_too_large</code> (413); <code>unsupported_media_type</code> (415); <code>rate_limited</code>, <code>ip_daily_quota</code>, <code>key_quota_exceeded</code>, <code>issuer_quota_exceeded</code>, <code>key_issue_limit</code>, <code>daily_cap_reached</code> (429); <code>internal_error</code> (500); <code>not_configured</code>, <code>unavailable</code> (503).</p>
<h2>Other endpoints</h2>
<p><code>GET /health</code> returns the service status and version. <code>GET /privacy</code> is the privacy note.</p>
${limitations(o)}
<h2>Support</h2>
<p>Questions, key revocation or abuse reports: ${contact(o) || 'not configured yet'}.</p>
${pricing(o)}`);
}

export function privacyHtml(o) {
  return layout(o, `${o.brand} privacy`, `${o.brand} never stores or logs submitted text.`, `
<h1>Privacy</h1>
<div class="card">
<p><strong>We never store or log the text you submit.</strong> Each request is checked in memory inside a Cloudflare Worker, the result is returned to you, and the text is discarded. Text is not written to any database or key-value store, it is not logged, it is not used for analytics or training, and it is never sent to any other service. Matching runs locally with the obscenity library and makes no outside calls.</p>
<p>What we do keep, for rate limiting and quotas only:</p>
<ul>
<li>Daily request counters per API key and per IP address. IP addresses are stored only as keyed hashes (HMAC), never in plain form, and every counter expires after 2 days. Our rate limiter is also keyed on that hash, not on your IP address.</li>
<li>To count unique visitors per day: a salted hash of your network address and the date (it changes every day and can't be linked back to an address without our secret key), kept for 9 days. No IP address, user agent or text is stored with it.</li>
<li>For each API key: a SHA-256 hash of the key (never the key itself), its creation time, plan and daily quota, plus a keyed hash of the issuing network for abuse limits. We don't ask for an email address or any personal details.</li>
</ul>
<p>The service runs on Cloudflare Workers, so Cloudflare handles network traffic under its own privacy policy. Our Worker has request logging and analytics turned off.</p>
<p>Questions, data requests or abuse reports: ${contact(o) || 'contact details coming soon'}.</p>
${o.proCheckout ? `<h2 id="payments">Payments (CussCheck Pro)</h2>
<p>Pro subscriptions are sold and billed by <a href="https://polar.sh" target="_blank" rel="noopener noreferrer">Polar</a> (polar.sh), our merchant of record. Polar collects your name, email address and payment details and handles taxes, receipts and cancellations under <a href="https://polar.sh/legal/privacy-policy" target="_blank" rel="noopener noreferrer">its own privacy policy</a>. We never see or store your card details. Manage or cancel your subscription in the <a href="${PRO_PORTAL_URL}" target="_blank" rel="noopener noreferrer">Polar customer portal</a>.</p>
<p>When you subscribe, Polar issues a license key. To check it, our Worker reads a small record (status, plan, product and expiry; no name, email or payment details) from a store kept up to date by our billing service. We do not log the key; usage counters use a one-way hash of it and expire after 2 days. Submitted text is handled exactly as for free users: never stored or logged.</p>
<p class="muted">Last updated: October 16, 2026.</p>` : '<p class="muted">Last updated: October 6, 2026.</p>'}
</div>`);
}

export const appJs = `(() => {
  const $ = (id) => document.getElementById(id);
  const text = $('text'), go = $('go'), out = $('out'), count = $('count');
  const enc = new TextEncoder();
  const limit = Number(text.getAttribute('maxlength')) || 10240;
  const upd = () => { const n = enc.encode(text.value).length; count.textContent = n.toLocaleString() + ' / ' + limit.toLocaleString() + ' bytes'; count.className = n > limit ? 'bad' : 'muted'; };
  text.addEventListener('input', upd); upd();
  const list = (v) => v.split(',').map((s) => s.trim()).filter(Boolean);
  go.addEventListener('click', async () => {
    go.disabled = true; go.textContent = 'Checking…';
    try {
      const body = { text: text.value, censor: $('censor').checked, allow: list($('allow').value), deny: list($('deny').value) };
      const r = await fetch('/v1/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      out.hidden = false;
      const v = $('verdict'), rows = $('rows');
      rows.textContent = '';
      if (!j.ok) { v.className = 'bad'; v.textContent = 'Error: ' + (j.error && j.error.message || r.status); $('censoredWrap').hidden = true; return; }
      v.className = j.has_profanity ? 'bad' : 'ok';
      v.textContent = j.has_profanity ? ('Profanity found: ' + j.match_count + ' match' + (j.match_count === 1 ? '' : 'es') + ' (' + j.terms.join(', ') + ')') : 'No profanity found.';
      $('censoredWrap').hidden = j.censored === null;
      $('censored').textContent = j.censored === null ? '' : j.censored;
      for (const m of j.matches) {
        const tr = document.createElement('tr');
        for (const c of [m.term + (m.source === 'deny' ? ' (deny list)' : ''), m.match, m.start + '–' + m.end, m.obfuscated ? 'yes' : 'no']) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
        rows.appendChild(tr);
      }
      if (!j.matches.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 4; td.textContent = 'None'; tr.appendChild(td); rows.appendChild(tr); }
    } catch (e) {
      out.hidden = false; $('verdict').className = 'bad'; $('verdict').textContent = 'Request failed. Please try again.';
    } finally { go.disabled = false; go.textContent = 'Check text'; }
  });
})();
`;
