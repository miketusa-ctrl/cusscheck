// CussCheck (codename SwearGuard) HTTP layer: routing, body/text caps, rate limits, KV quotas, key issuance.
// PRIVACY INVARIANT: submitted text is never logged, stored, cached or sent anywhere. The only console output in
// this Worker is the global-cap warning (counts only), and Workers observability/logs are disabled in wrangler.toml.
import { check, normalizeList, ListError, LIBRARY, MAX_LIST_ITEMS, MAX_LIST_ITEM_LEN } from './filter.js';
import { rateLimit, memLimit, counterValue, counterIncr, utcDay, lookupKey, isKeyCached, generateKey, sha256hex, hmacHex, ipBucket } from './limits.js';
import { indexHtml, docsHtml, privacyHtml, appJs } from './pages.js';
import { VERSION, MAX_MATCHES, MAX_BODY_BYTES, MAX_TEXT_BYTES } from './version.js';
import { handleMcp } from './lib/mcp.js';
import { llmsTxt, openApiSpec, serverCard } from './lib/agentdocs.js';
import { countVisitor } from './lib/visitors.js';
import { validateFleetLicense, isFleetLicenseCached } from './fleet-license.js';
import { PRO_PRODUCT_SLUG, PRO_PRICE_USD, looksLikeProKey, proKeyIdFor, proCheckoutUrl } from './pro.js';

export { VERSION, MAX_MATCHES, MAX_BODY_BYTES, MAX_TEXT_BYTES }; // constants live in version.js (shared with lib/mcp.js)
export const COUNTER_TTL = 2 * 86400;     // every KV counter expires after 2 days (matches /privacy)

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
export function config(env) {
  return {
    env: env.ENVIRONMENT || 'development',
    publicLaunch: env.PUBLIC_LAUNCH === 'true',
    build: env.BUILD_COMMIT || 'dev',
    brand: env.BRAND_NAME || 'CussCheck',
    supportEmail: typeof env.SUPPORT_EMAIL === 'string' && /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(env.SUPPORT_EMAIL) ? env.SUPPORT_EMAIL : null,
    anonPerMin: num(env.ANON_PER_MIN, 10),
    anonDailyPerIp: num(env.ANON_DAILY_PER_IP, 200),
    keyPerMin: num(env.KEY_PER_MIN, 60),
    keyDailyQuota: num(env.KEY_DAILY_QUOTA, 1000),
    keyIssuerDailyQuota: num(env.KEY_ISSUER_DAILY_QUOTA, 3000),
    keyIssuePerIpPerDay: num(env.KEY_ISSUE_PER_IP_PER_DAY, 3),
    keyIssueGlobalPerDay: num(env.KEY_ISSUE_GLOBAL_PER_DAY, 200),
    globalDailyRequestCap: num(env.GLOBAL_DAILY_REQUEST_CAP, 15000),
    // CussCheck Pro (Polar license keys, v0.3.0): own per-license quota and own global counter, separate from the free
    // pool (GLOBAL_DAILY_REQUEST_CAP is neither used nor raised by Pro traffic). Same pattern/numbers as PlainGrade Pro.
    proDailyQuota: num(env.PRO_DAILY_QUOTA, 5000),
    proGlobalDailyCap: num(env.PRO_GLOBAL_DAILY_CAP, 5000),
    proCheckout: proCheckoutUrl(env), // also the launch flag for Pro pricing/docs copy
    proPrice: PRO_PRICE_USD,
    pepper: typeof env.HASH_PEPPER === 'string' && env.HASH_PEPPER.length >= 16 ? env.HASH_PEPPER : null,
  };
}

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

function baseHeaders(cfg, extra = {}) {
  const h = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'strict-transport-security': 'max-age=31536000',
    'permissions-policy': 'interest-cohort=(), camera=(), microphone=(), geolocation=()',
    ...extra,
  };
  if (!cfg.publicLaunch) h['x-robots-tag'] = 'noindex, nofollow';
  return h;
}
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, x-ratelimit-policy, x-api-plan, retry-after',
};
function json(cfg, status, obj, extra = {}, { cors = true, compact = false } = {}) {
  return new Response(compact ? JSON.stringify(obj) : JSON.stringify(obj, null, 2), {
    status,
    headers: baseHeaders(cfg, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(cors ? CORS : {}), ...extra }),
  });
}
const errBody = (code, message) => ({ ok: false, error: { code, message } });

const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
function page(cfg, method, body, type = 'text/html; charset=utf-8', extra = {}) {
  return new Response(method === 'HEAD' ? null : body, { headers: baseHeaders(cfg, { 'content-type': type, 'cache-control': 'public, max-age=300', 'content-security-policy': CSP, ...extra }) });
}

export async function readBodyCapped(req, max = MAX_BODY_BYTES) {
  const cl = req.headers.get('content-length');
  if (cl !== null && (!/^\d+$/.test(cl) || Number(cl) > max)) {
    throw new HttpError(413, 'body_too_large', `Request body exceeds ${max} bytes (16 KB). Send at most 10 KB of text per request.`);
  }
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new HttpError(413, 'body_too_large', `Request body exceeds ${max} bytes (16 KB). Send at most 10 KB of text per request.`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total); let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

const nextResetEpoch = () => { const d = new Date(); return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) / 1000); };
const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'unknown';
function requirePepper(cfg) {
  if (!cfg.pepper) throw new HttpError(503, 'not_configured', 'This deployment is missing its HASH_PEPPER secret; the API is disabled until it is set.');
}
const friendlyCap = () => 'The service reached its free daily request allowance for today. It resets at 00:00 UTC; please retry later.';

const capWarned = new Set();
function capWarn(used, cap, day) {
  if (!cap) return;
  const pct = (used / cap) * 100;
  for (const t of [100, 80]) {
    if (pct >= t && !capWarned.has(`${day}:${t}`)) {
      capWarned.add(`${day}:${t}`);
      console.warn(`profanity-api: global request cap at ${Math.floor(pct)}% (${used}/${cap}) for ${day} UTC`); // counts only
      return;
    }
  }
}

// ---------- auth + quotas ----------
const INVALID_KEY_MSG = 'X-API-Key is not valid. Omit the header for anonymous (lower-rate) use, or get a free key with POST /v1/keys.';
const proCapMsg = () => 'CussCheck Pro reached its shared daily capacity for today. It resets at 00:00 UTC; please retry later.';
/** Pro license gate: read-only LICENSES KV lookup (PlainGrade pattern). Every non-active result (unknown, revoked,
 * expired, other product, unknown plan, KV missing/error) gets the SAME 401 as any bad key, so a key's state is never
 * revealed. Lookups that would read KV go through the per-IP 'auth:' limiter, like free keys. */
async function authenticatePro(env, cfg, key, ipHash) {
  if (!isFleetLicenseCached(key) && !(await rateLimit(env.IP_LIMITER, 'auth:' + ipHash, cfg.anonPerMin))) {
    throw new HttpError(429, 'rate_limited', 'Too many key lookups from your IP. Retry in a minute.', { 'retry-after': '60' });
  }
  const r = await validateFleetLicense(env.LICENSES, key, PRO_PRODUCT_SLUG);
  if (!r.valid || r.plan !== 'pro') throw new HttpError(401, 'invalid_api_key', INVALID_KEY_MSG);
  return { plan: 'pro', proId: await proKeyIdFor(key) };
}

async function authorizePro(env, cfg, ctx, key, ipHash, day, reset) {
  const kv = env.SWEARGUARD_KV;
  const { proId } = await authenticatePro(env, cfg, key, ipHash);
  if (!(await rateLimit(env.KEY_LIMITER, 'k:' + proId, cfg.keyPerMin))) {
    throw new HttpError(429, 'rate_limited', `Per-key rate limit (${cfg.keyPerMin}/min) exceeded. Retry in a minute.`, { 'retry-after': '60' });
  }
  const quota = cfg.proDailyQuota;
  const headers = { 'x-api-plan': 'pro', 'x-ratelimit-limit': String(quota), 'x-ratelimit-reset': reset, 'x-ratelimit-policy': `${quota};w=86400, ${cfg.keyPerMin};w=60` };
  const pgName = `q:global:pro:${day}`;
  if ((await counterValue(kv, pgName)) >= cfg.proGlobalDailyCap) throw new HttpError(429, 'daily_cap_reached', proCapMsg(), { ...headers, 'retry-after': '3600' });
  const usedName = `q:key:${proId}:${day}`;
  if ((await counterValue(kv, usedName)) >= quota) throw new HttpError(429, 'key_quota_exceeded', `Daily quota for this Pro license (${quota} requests/day) is used up. It resets at 00:00 UTC.`, { ...headers, 'x-ratelimit-remaining': '0', 'retry-after': '3600' });
  const n = await counterIncr(kv, usedName, ctx, 1, { flushFirst: true, ttl: COUNTER_TTL });
  await counterIncr(kv, pgName, ctx, 1, { ttl: COUNTER_TTL });
  headers['x-ratelimit-remaining'] = String(Math.max(0, quota - n));
  return { plan: 'pro', headers };
}

// v0.2.0: the key is read from X-API-Key, or (additive alias, for MCP clients) Authorization: Bearer <key>.
// X-API-Key wins when both are sent. Returns null when no key was sent (anonymous use).
export function apiKeyOf(req) {
  const k = req.headers.get('x-api-key');
  if (k !== null) return k;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') || '');
  return m ? m[1] : null;
}

/**
 * Key gate only (no quota charge), used by /mcp before processing any message so a bad key gets 401 on every
 * method. Same rules as authorize(): uncached key lookups go through the per-IP 'auth:' limiter; a valid key is then
 * cached, so the following /v1/check (runApi) doesn't charge the auth limiter twice.
 */
export async function authenticate(req, env, cfg = config(env)) {
  const apiKey = apiKeyOf(req);
  if (apiKey === null) return { ok: true, plan: 'anonymous' };
  if (!cfg.pepper || !env.SWEARGUARD_KV) return { ok: false, status: 503, code: 'not_configured', message: 'Service is not configured yet.' };
  const ipHash = (await hmacHex(cfg.pepper, 'ip:' + ipBucket(clientIp(req)))).slice(0, 32);
  if (looksLikeProKey(apiKey)) {
    try { await authenticatePro(env, cfg, apiKey.trim(), ipHash); } catch (e) {
      if (e instanceof HttpError) return { ok: false, status: e.status, code: e.code, message: e.status === 401 ? 'The API key is not valid. Omit it for anonymous (lower-rate) use, or get a free key with POST /v1/keys.' : e.message, headers: e.headers };
      throw e;
    }
    return { ok: true, plan: 'pro' };
  }
  if (!(await isKeyCached(apiKey.trim())) && !(await rateLimit(env.IP_LIMITER, 'auth:' + ipHash, cfg.anonPerMin))) {
    return { ok: false, status: 429, code: 'rate_limited', message: 'Too many key lookups from your IP. Retry in a minute.', headers: { 'retry-after': '60' } };
  }
  const rec = await lookupKey(env.SWEARGUARD_KV, apiKey.trim());
  if (!rec || rec.revoked) return { ok: false, status: 401, code: 'invalid_api_key', message: 'The API key is not valid. Omit it for anonymous (lower-rate) use, or get a free key with POST /v1/keys.' };
  return { ok: true, plan: 'free_key' };
}

async function authorize(req, env, cfg, ctx) {
  const kv = env.SWEARGUARD_KV;
  const bucket = ipBucket(clientIp(req));
  const day = utcDay();
  const reset = String(nextResetEpoch());
  const apiKey = apiKeyOf(req);
  // rate-limiter keys and KV counter names use a keyed HMAC of the IP bucket, never the raw IP.
  const ipHash = (await hmacHex(cfg.pepper, 'ip:' + bucket)).slice(0, 32);
  // CussCheck Pro: checked before the free pool, so the free global cap neither counts nor blocks Pro traffic.
  if (apiKey !== null && looksLikeProKey(apiKey)) return authorizePro(env, cfg, ctx, apiKey.trim(), ipHash, day, reset);
  // Global soft cap first (approximate, batched KV counter).
  const gName = `q:global:req:${day}`;
  const gUsed = await counterValue(kv, gName);
  capWarn(gUsed, cfg.globalDailyRequestCap, day);
  if (gUsed >= cfg.globalDailyRequestCap) throw new HttpError(429, 'daily_cap_reached', friendlyCap(), { 'retry-after': '3600' });

  if (apiKey !== null) {
    // Key lookups that would read KV (isolate-cache misses, incl. every new random key) go through the per-IP
    // limiter (separate 'auth:' bucket, binding limit 10/min), so key guessing can't run up KV reads. Cached valid
    // keys skip it, so a key's 60/min isn't capped by the anonymous per-IP limit.
    if (!(await isKeyCached(apiKey.trim())) && !(await rateLimit(env.IP_LIMITER, 'auth:' + ipHash, cfg.anonPerMin))) {
      throw new HttpError(429, 'rate_limited', 'Too many key lookups from your IP. Retry in a minute.', { 'retry-after': '60' });
    }
    const rec = await lookupKey(kv, apiKey.trim());
    if (!rec || rec.revoked) throw new HttpError(401, 'invalid_api_key', 'X-API-Key is not valid. Omit the header for anonymous (lower-rate) use, or get a free key with POST /v1/keys.');
    if (!(await rateLimit(env.KEY_LIMITER, 'k:' + rec.id, cfg.keyPerMin))) {
      throw new HttpError(429, 'rate_limited', `Per-key rate limit (${cfg.keyPerMin}/min) exceeded. Retry in a minute.`, { 'retry-after': '60' });
    }
    const quota = rec.dailyQuota || cfg.keyDailyQuota;
    const usedName = `q:key:${rec.id}:${day}`;
    const used = await counterValue(kv, usedName);
    const headers = { 'x-api-plan': 'free_key', 'x-ratelimit-limit': String(quota), 'x-ratelimit-reset': reset, 'x-ratelimit-policy': `${quota};w=86400, ${cfg.keyPerMin};w=60` };
    if (used >= quota) throw new HttpError(429, 'key_quota_exceeded', `Daily quota for this API key (${quota} requests/day) is used up. It resets at 00:00 UTC.`, { ...headers, 'x-ratelimit-remaining': '0', 'retry-after': '3600' });
    const issuerName = `q:issuer:${rec.issuer || 'k-' + rec.id}:${day}`;
    if ((await counterValue(kv, issuerName)) >= cfg.keyIssuerDailyQuota) {
      throw new HttpError(429, 'issuer_quota_exceeded', `Combined daily quota for keys issued to your network (${cfg.keyIssuerDailyQuota} requests/day) is used up. It resets at 00:00 UTC.`, { ...headers, 'retry-after': '3600' });
    }
    const n = await counterIncr(kv, usedName, ctx, 1, { flushFirst: true, ttl: COUNTER_TTL });
    await counterIncr(kv, issuerName, ctx, 1, { ttl: COUNTER_TTL });
    await counterIncr(kv, gName, ctx, 1, { ttl: COUNTER_TTL });
    headers['x-ratelimit-remaining'] = String(Math.max(0, quota - n));
    return { plan: 'free_key', headers };
  }
  if (!(await rateLimit(env.IP_LIMITER, 'ip:' + ipHash, cfg.anonPerMin))) {
    throw new HttpError(429, 'rate_limited', `Anonymous rate limit (${cfg.anonPerMin} requests/min per IP) exceeded. Retry in a minute, or use a free API key (X-API-Key) for higher limits.`, { 'retry-after': '60' });
  }
  const ipName = `q:ipday:${ipHash}:${day}`;
  const used = await counterValue(kv, ipName);
  const headers = { 'x-api-plan': 'anonymous', 'x-ratelimit-limit': String(cfg.anonDailyPerIp), 'x-ratelimit-reset': reset, 'x-ratelimit-policy': `${cfg.anonDailyPerIp};w=86400, ${cfg.anonPerMin};w=60` };
  if (used >= cfg.anonDailyPerIp) throw new HttpError(429, 'ip_daily_quota', `Anonymous daily quota (${cfg.anonDailyPerIp} requests/day per IP) reached. It resets at 00:00 UTC; a free API key gives 1,000/day.`, { ...headers, 'x-ratelimit-remaining': '0', 'retry-after': '3600' });
  const n = await counterIncr(kv, ipName, ctx, 1, { flushEvery: 10, maxAgeMs: Infinity, ttl: COUNTER_TTL });
  await counterIncr(kv, gName, ctx, 1, { ttl: COUNTER_TTL });
  headers['x-ratelimit-remaining'] = String(Math.max(0, cfg.anonDailyPerIp - n));
  return { plan: 'anonymous', headers };
}

// ---------- handlers ----------
function utf8Len(s) { return new TextEncoder().encode(s).byteLength; }

export function parseCheckBody(raw) {
  let body;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON: {"text": "..."}'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object: {"text": "..."}');
  if (typeof body.text !== 'string') throw new HttpError(400, 'missing_text', '"text" (string) is required.');
  const textBytes = utf8Len(body.text);
  if (textBytes > MAX_TEXT_BYTES) throw new HttpError(413, 'text_too_large', `"text" is ${textBytes} bytes; the limit is ${MAX_TEXT_BYTES} bytes (10 KB, UTF-8). Split longer text into several requests.`);
  if (body.censor !== undefined && typeof body.censor !== 'boolean') throw new HttpError(400, 'invalid_censor', '"censor" must be true or false.');
  let allow; let deny;
  try {
    allow = normalizeList(body.allow, 'allow');
    deny = normalizeList(body.deny, 'deny');
  } catch (e) {
    if (e instanceof ListError) throw new HttpError(400, 'invalid_' + e.field, e.message);
    throw e;
  }
  return { text: body.text, textBytes, censor: body.censor !== false, allow, deny };
}

async function handleCheck(req, env, ctx, cfg) {
  requirePepper(cfg);
  if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send the body as application/json: {"text": "..."}');
  }
  // Reject a declared oversize body before it counts against any quota (the streamed read re-checks actual bytes).
  const cl = req.headers.get('content-length');
  if (cl !== null && (!/^\d+$/.test(cl) || Number(cl) > MAX_BODY_BYTES)) {
    throw new HttpError(413, 'body_too_large', `Request body exceeds ${MAX_BODY_BYTES} bytes (16 KB). Send at most 10 KB of text per request.`);
  }
  const auth = await authorize(req, env, cfg, ctx);
  try {
    const raw = await readBodyCapped(req);
    const p = parseCheckBody(raw);
    const r = check(p.text, { censor: p.censor, allow: p.allow, deny: p.deny });
    const truncated = r.matches.length > MAX_MATCHES;
    const body = { ok: true, ...r, matches: truncated ? r.matches.slice(0, MAX_MATCHES) : r.matches, truncated, text_bytes: p.textBytes, engine: LIBRARY, version: VERSION };
    return json(cfg, 200, body, auth.headers, { compact: true });
  } catch (e) {
    if (e instanceof HttpError) e.headers = { ...auth.headers, ...e.headers };
    throw e;
  }
}

async function handleKeys(req, env, ctx, cfg) {
  const kv = env.SWEARGUARD_KV;
  if (!kv) throw new HttpError(503, 'unavailable', 'Key issuance is not configured.');
  requirePepper(cfg);
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) throw new HttpError(403, 'cross_origin_forbidden', 'API keys can only be requested from this site or directly (e.g. curl), not from other websites.');
  if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) throw new HttpError(415, 'unsupported_media_type', 'POST with Content-Type: application/json (an empty {} body is fine).');
  const bucket = ipBucket(clientIp(req));
  if (!(await rateLimit(env.IP_LIMITER, 'keys:' + (await hmacHex(cfg.pepper, 'ip:' + bucket)).slice(0, 32), cfg.anonPerMin))) throw new HttpError(429, 'rate_limited', 'Too many requests. Retry in a minute.', { 'retry-after': '60' });
  const raw = await readBodyCapped(req, 1024);
  if (raw.trim()) { try { const b = JSON.parse(raw); if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error(); } catch { throw new HttpError(400, 'invalid_json', 'Body must be a JSON object (or empty).'); } }
  const day = utcDay();
  const ipName = `q:keyissue:${(await hmacHex(cfg.pepper, 'ip:' + bucket)).slice(0, 32)}:${day}`;
  const gName = `q:keyissue:global:${day}`;
  const [ipCount, gCount] = await Promise.all([kv.get(ipName), kv.get(gName)]);
  const ipN = Number(ipCount || 0); const gN = Number(gCount || 0);
  if (ipN >= cfg.keyIssuePerIpPerDay) throw new HttpError(429, 'key_issue_limit', `At most ${cfg.keyIssuePerIpPerDay} keys per IP (IPv6: per /64) per day.`, { 'retry-after': '3600' });
  if (gN >= cfg.keyIssueGlobalPerDay) throw new HttpError(429, 'daily_cap_reached', 'Free key issuance reached its daily limit. It resets at 00:00 UTC.', { 'retry-after': '3600' });
  await Promise.all([
    kv.put(ipName, String(ipN + 1), { expirationTtl: 2 * 86400 }),
    kv.put(gName, String(gN + 1), { expirationTtl: 2 * 86400 }),
  ]);
  const apiKey = generateKey();
  const keyHash = await sha256hex(apiKey);
  const id = keyHash.slice(0, 16);
  const rec = { id, created: new Date().toISOString(), plan: 'free', dailyQuota: cfg.keyDailyQuota, issuer: (await hmacHex(cfg.pepper, 'issuer:' + bucket)).slice(0, 32) };
  await kv.put('key:' + keyHash, JSON.stringify(rec));
  return json(cfg, 201, {
    ok: true, api_key: apiKey, key_id: id, plan: 'free', daily_quota: cfg.keyDailyQuota, per_minute: cfg.keyPerMin,
    commercial_use: true,
    note: 'Store this key now: it is shown only once (we keep only a SHA-256 hash). Send it as the X-API-Key header.',
  }, {}, { cors: false });
}

async function handleUsage(req, env, cfg) {
  const apiKey = apiKeyOf(req);
  if (!apiKey) throw new HttpError(401, 'missing_api_key', 'Send your key in the X-API-Key header (or Authorization: Bearer).');
  const bucket = ipBucket(clientIp(req));
  requirePepper(cfg);
  const ipHash = (await hmacHex(cfg.pepper, 'ip:' + bucket)).slice(0, 32);
  if (looksLikeProKey(apiKey)) {
    let pro;
    try { pro = await authenticatePro(env, cfg, apiKey.trim(), ipHash); } catch (e) { if (e instanceof HttpError && e.status === 401) throw new HttpError(401, 'invalid_api_key', 'X-API-Key is not valid.'); throw e; }
    const used = await counterValue(env.SWEARGUARD_KV, `q:key:${pro.proId}:${utcDay()}`);
    return json(cfg, 200, { ok: true, plan: 'pro', daily_quota: cfg.proDailyQuota, used_today: used, remaining_today: Math.max(0, cfg.proDailyQuota - used), per_minute: cfg.keyPerMin, resets_at: new Date(nextResetEpoch() * 1000).toISOString(), note: 'Usage counts are approximate (batched counters).' });
  }
  if (!(await isKeyCached(apiKey.trim())) && !(await rateLimit(env.IP_LIMITER, 'auth:' + ipHash, cfg.anonPerMin))) throw new HttpError(429, 'rate_limited', 'Too many key lookups from your IP. Retry in a minute.', { 'retry-after': '60' });
  const rec = await lookupKey(env.SWEARGUARD_KV, apiKey.trim());
  if (!rec || rec.revoked) throw new HttpError(401, 'invalid_api_key', 'X-API-Key is not valid.');
  const used = await counterValue(env.SWEARGUARD_KV, `q:key:${rec.id}:${utcDay()}`);
  const quota = rec.dailyQuota || cfg.keyDailyQuota;
  return json(cfg, 200, { ok: true, key_id: rec.id, plan: rec.plan, daily_quota: quota, used_today: used, remaining_today: Math.max(0, quota - used), per_minute: cfg.keyPerMin, resets_at: new Date(nextResetEpoch() * 1000).toISOString(), note: 'Usage counts are approximate (batched counters).' });
}

function robots(cfg, origin) {
  return cfg.publicLaunch ? `User-agent: *\nAllow: /\nDisallow: /v1/\n\nSitemap: ${origin}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n';
}
// Same pattern as the sibling sites (certguard, linkpulse, dnsguard, headerguard): only served once PUBLIC_LAUNCH is true.
function sitemap(origin) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['/', '/docs', '/privacy'].map((p) => `  <url><loc>${origin}${p}</loc></url>\n`).join('')}</urlset>\n`;
}

const ROUTES = {
  '/': ['GET', 'HEAD'],
  '/docs': ['GET', 'HEAD'],
  '/privacy': ['GET', 'HEAD'],
  '/app.js': ['GET', 'HEAD'],
  '/health': ['GET', 'HEAD'],
  '/robots.txt': ['GET', 'HEAD'],
  '/sitemap.xml': ['GET', 'HEAD'],
  '/v1/check': ['POST', 'OPTIONS'],
  '/v1/keys': ['POST'],
  '/v1/usage': ['GET'],
};

// ---------- v0.2.0 agent surface (recipe r2) ----------
const AGENT_DOCS = ['/llms.txt', '/openapi.json', '/.well-known/mcp/server-card.json', '/.well-known/mcp-registry-auth', '/.well-known/glama.json'];
// Glama connector ownership claim, served at /.well-known/glama.json. Replace the placeholder with your own claim token from glama.ai.
export const GLAMA_CLAIM_JSON = "{\"$schema\":\"https://glama.ai/mcp/schemas/connector.json\",\"claim\":\"<GLAMA_CLAIM_TOKEN>\"}";
export const REGISTRY_AUTH_RE = /^v=MCPv1; k=(ed25519|ecdsap384); p=[A-Za-z0-9+/=]{20,120}$/;
// Daily unique visitors: human/API entry points only, never internal MCP->API calls, never /health, docs or assets.
const COUNTED = (path, method) => (method === 'GET' && (path === '/' || path === '/docs' || path === '/privacy'))
  || (method === 'POST' && (path === '/v1/check' || path === '/v1/keys' || path === '/mcp'));
const internal = new WeakSet();
const limitsOf = (cfg) => ({ anonPerMin: cfg.anonPerMin, anonDaily: cfg.anonDailyPerIp, keyPerMin: cfg.keyPerMin, keyDaily: cfg.keyDailyQuota });

export function createApp() {
  // Internal call into the exact POST /v1/check route (same key gate, limiters, quotas, global cap) for the MCP tool.
  // Only the caller's key + client IP headers are forwarded; the text travels in the POST body, never a URL.
  function runApi(request, env, ctx, { method, path, body }) {
    const h = new Headers({ 'content-type': 'application/json' });
    for (const k of ['authorization', 'x-api-key', 'cf-connecting-ip']) { const v = request.headers.get(k); if (v !== null) h.set(k, v); }
    const req = new Request(new URL(path, request.url), { method, headers: h, ...(body ? { body: JSON.stringify(body) } : {}) });
    internal.add(req);
    return route(req, env, ctx);
  }

  async function route(req, env, ctx) {
      const cfg = config(env);
      const url = new URL(req.url);
      const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
      const method = req.method.toUpperCase();
      if (!internal.has(req) && COUNTED(path, method)) countVisitor(req, env, ctx, ipBucket(clientIp(req)));
      if (path === '/mcp') {
        return handleMcp(req, env, ctx, {
          authenticate: (r, e) => authenticate(r, e, cfg), runApi, ipBucket: ipBucket(clientIp(req)), memLimit,
          origin: url.origin, allowedOrigins: env.MCP_ALLOWED_ORIGINS, limits: limitsOf(cfg), security: baseHeaders(cfg),
        });
      }
      if (AGENT_DOCS.includes(path)) {
        if (method === 'OPTIONS') return new Response(null, { status: 204, headers: baseHeaders(cfg, { ...CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-max-age': '86400' }) });
        if (method !== 'GET' && method !== 'HEAD') return json(cfg, 405, errBody('method_not_allowed', 'Use GET.'), { allow: 'GET, HEAD, OPTIONS' });
        const doc = (body, type, cache = 'public, max-age=3600', status = 200) => new Response(method === 'HEAD' ? null : body, {
          status, headers: baseHeaders(cfg, { 'content-type': type, 'cache-control': cache, 'access-control-allow-origin': '*' }),
        });
        const L = limitsOf(cfg);
        const X = { proCheckout: cfg.proCheckout, proPrice: cfg.proPrice, proDaily: cfg.proDailyQuota, supportEmail: cfg.supportEmail, maxBody: MAX_BODY_BYTES, maxText: MAX_TEXT_BYTES, maxMatches: MAX_MATCHES, maxListItems: MAX_LIST_ITEMS, maxListItemLen: MAX_LIST_ITEM_LEN };
        if (path === '/llms.txt') return doc(llmsTxt(url.origin, L, X), 'text/plain; charset=utf-8');
        if (path === '/openapi.json') return doc(JSON.stringify(openApiSpec(url.origin, L, X), null, 2), 'application/json; charset=utf-8');
        if (path === '/.well-known/glama.json') return doc(GLAMA_CLAIM_JSON, 'application/json');
        if (path === '/.well-known/mcp/server-card.json') return doc(JSON.stringify(serverCard(url.origin, L), null, 2), 'application/json; charset=utf-8');
        const v = String(env.MCP_REGISTRY_AUTH || '');
        if (REGISTRY_AUTH_RE.test(v)) return doc(v, 'text/plain; charset=utf-8', 'no-store');
        return doc('Not found\n', 'text/plain; charset=utf-8', 'no-store', 404);
      }
      const allowed = ROUTES[path];
      try {
        if (!allowed) throw new HttpError(404, 'not_found', 'Not found. See /docs.');
        if (!allowed.includes(method)) throw new HttpError(405, 'method_not_allowed', `Use ${allowed.join(', ')}.`, { allow: allowed.join(', ') });
        const pageOpts = { brand: cfg.brand, supportEmail: cfg.supportEmail, maxMatches: MAX_MATCHES, env: cfg.env, publicLaunch: cfg.publicLaunch, version: VERSION, origin: url.origin, maxText: MAX_TEXT_BYTES, maxBody: MAX_BODY_BYTES, anonPerMin: cfg.anonPerMin, anonDaily: cfg.anonDailyPerIp, keyPerMin: cfg.keyPerMin, keyDaily: cfg.keyDailyQuota, maxListItems: MAX_LIST_ITEMS, maxListItemLen: MAX_LIST_ITEM_LEN, proCheckout: cfg.proCheckout, proPrice: cfg.proPrice, proDaily: cfg.proDailyQuota };
        switch (path) {
          case '/': return page(cfg, method, indexHtml(pageOpts));
          case '/docs': return page(cfg, method, docsHtml(pageOpts));
          case '/privacy': return page(cfg, method, privacyHtml(pageOpts));
          case '/app.js': return page(cfg, method, appJs, 'text/javascript; charset=utf-8');
          case '/robots.txt': return page(cfg, method, robots(cfg, url.origin), 'text/plain; charset=utf-8');
          case '/sitemap.xml':
            if (!cfg.publicLaunch) throw new HttpError(404, 'not_found', 'Not found. See /docs.');
            return page(cfg, method, sitemap(url.origin), 'application/xml; charset=utf-8');
          case '/health': return json(cfg, 200, { ok: true, service: 'profanity-api', name: cfg.brand, version: VERSION, build: cfg.build, environment: cfg.env, engine: LIBRARY, configured: !!cfg.pepper && !!env.SWEARGUARD_KV });
          case '/v1/check':
            if (method === 'OPTIONS') return new Response(null, { status: 204, headers: baseHeaders(cfg, { ...CORS, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-api-key, authorization', 'access-control-max-age': '86400' }) });
            return await handleCheck(req, env, ctx, cfg);
          case '/v1/keys': return await handleKeys(req, env, ctx, cfg);
          case '/v1/usage': return await handleUsage(req, env, cfg);
        }
        throw new HttpError(404, 'not_found', 'Not found.');
      } catch (e) {
        if (e instanceof HttpError) return json(cfg, e.status, errBody(e.code, e.message), e.headers, { cors: path !== '/v1/keys' });
        // Never include the request body or text in error output.
        console.error('profanity-api: internal error', e && e.name);
        return json(cfg, 500, errBody('internal_error', 'Internal error.'));
      }
  }

  return { fetch: (req, env, ctx) => route(req, env, ctx) };
}
