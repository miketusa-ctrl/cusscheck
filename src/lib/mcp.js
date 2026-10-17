/**
 * CussCheck remote MCP server (v0.2.0, agent-ready recipe r2). Hand-rolled JSON-RPC 2.0 over Streamable HTTP; no SDK,
 * no dependencies. Transport adapted from CheckDigit src/lib/mcp.js (itself from BurnerCheck / CertGuard c2606ed /
 * DnsGuard): modern 2026-07-28 tool errors keep _meta["profanity-api/error"] next to serverInfo.
 *
 * Dual-era and stateless: modern 2026-07-28 (server/discover, tools/list, tools/call with per-request _meta and
 * MCP-Protocol-Version / Mcp-Method / Mcp-Name headers) and legacy (initialize, ping, tools/list, tools/call; batches
 * max 10, at most one tools/call). No sessions, no SSE: GET/DELETE -> 405.
 *
 * Auth + limits are NOT implemented here: the router passes authenticate() and runApi() from app.js. runApi() runs the
 * exact POST /v1/check code (same key gate, per-minute limiters, daily quotas, global cap). One check_profanity call =
 * one /v1/check request. PRIVACY: the text travels only in POST bodies and is never stored, logged or cached.
 */
import { VERSION, MAX_TEXT_BYTES } from '../version.js';
import { MAX_LIST_ITEMS, MAX_LIST_ITEM_LEN } from '../filter.js';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_BATCH = 10;
export const MAX_CHECKS_PER_REQUEST = 1;
export const DISCOVERY_PER_MIN = 120;
export const MCP_MAX_MATCHES = 50; // matches[] in structuredContent (match_count stays the full total)
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER = 'io.modelcontextprotocol/serverInfo';
const ERROR_META = 'profanity-api/error';
export const PASS_HEADERS = ['retry-after', 'x-api-plan', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-policy']; // what /v1/check sends
export const E = {
  PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603,
  SERVER: -32000, HEADER_MISMATCH: -32020, UNSUPPORTED_VERSION: -32022,
};

// Keys: X-Api-Key (as on /v1/*) or Authorization: Bearer pf_...
export const MCP_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept, authorization, x-api-key, mcp-protocol-version, mcp-method, mcp-name',
  'access-control-expose-headers': ['mcp-protocol-version', ...PASS_HEADERS].join(', '),
  'access-control-max-age': '86400',
};

export const SERVER_INFO = { name: 'profanity-api', title: 'CussCheck', version: VERSION };
export const instructions = (L = { anonPerMin: 10, anonDaily: 200, keyPerMin: 60, keyDaily: 1000 }) => `CussCheck finds English swear words in text and returns their positions and a censored copy. It is a word-list filter (obscenity englishDataset) with leetspeak, look-alike character, repeated-letter, dotted/spaced-letter and hidden-character handling; it is not AI moderation and does not understand context. Use check_profanity with "text" (at most ${MAX_TEXT_BYTES} UTF-8 bytes). Optional "allow" and "deny" word lists (up to ${MAX_LIST_ITEMS} words each). Positions are UTF-16 indices into your original text (start inclusive, end exclusive). The text is checked in memory and never stored or logged. Anonymous use: about ${L.anonPerMin} checks per minute and ${L.anonDaily} per day per IP. A free API key (POST /v1/keys) gives about ${L.keyPerMin} per minute and ${L.keyDaily} per day; send it as X-Api-Key or "Authorization: Bearer pf_...". Each check_profanity call counts as one check.`;

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WORDS = (what) => ({ type: 'array', description: what, maxItems: MAX_LIST_ITEMS, items: { type: 'string', minLength: 1, maxLength: MAX_LIST_ITEM_LEN } });
export const MATCH_OUT = { type: 'object', properties: {
  term: { type: 'string' }, match: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' },
  source: { type: 'string' }, obfuscated: { type: 'boolean' },
}, required: ['term', 'start', 'end'] };
export const RESULT_OUT = { type: 'object', properties: {
  has_profanity: { type: 'boolean' }, match_count: { type: 'integer', description: 'Total number of matches in the text (not capped).' }, terms: { type: 'array', items: { type: 'string' } },
  matches: { type: 'array', items: MATCH_OUT, maxItems: MCP_MAX_MATCHES, description: `Matches in text order, at most ${MCP_MAX_MATCHES} here (see match_count for the total). start/end are UTF-16 indices into your text.` }, matches_returned: { type: 'integer' }, truncated: { type: 'boolean', description: `True when matches lists fewer than match_count (over ${MCP_MAX_MATCHES} here, or the API's own cap).` },
  censored: { type: 'string', description: 'Your text with each match replaced by asterisks (same length). Omitted when censor is false.' }, text_bytes: { type: 'integer' }, engine: { type: 'string' }, version: { type: 'string' },
}, required: ['has_profanity', 'match_count', 'terms', 'matches'] };

export const TOOLS = [
  {
    name: 'check_profanity',
    title: 'Find and censor English swear words',
    description: `Detect English profanity in text (word list with leetspeak, look-alike letters, repeated letters, dotted/spaced letters and hidden characters handled) and return the matched terms, their positions (UTF-16 start/end in your text) and, unless censor is false, a censored copy of the same length. Common innocent words (Scunthorpe, cockpit, Shiite, cumin) are whitelisted; it does not understand context and is English only. Text up to ${MAX_TEXT_BYTES} UTF-8 bytes; it is not stored or logged. matches is capped at ${MCP_MAX_MATCHES} here (match_count is the full total). Read-only. Same engine, keys and limits as POST /v1/check.`,
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: `The text to check, at most ${MAX_TEXT_BYTES} UTF-8 bytes.`, maxLength: MAX_TEXT_BYTES },
      censor: { type: 'boolean', description: 'Return a censored copy (default true).' },
      allow: WORDS('Words never to flag, e.g. ["hell", "damn"]. Allow wins over deny.'),
      deny: WORDS('Extra words to flag on word boundaries, e.g. ["jerk"].'),
    }, required: ['text'], additionalProperties: false },
    outputSchema: RESULT_OUT,
    annotations: { title: 'Check profanity', ...RO },
  },
];
const ROUTE = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
export const PUBLIC_TOOLS = TOOLS;

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function shapeResult(b) {
  const all = Array.isArray(b.matches) ? b.matches : [];
  const matches = all.slice(0, MCP_MAX_MATCHES).map((m) => ({ term: String(m.term), match: clip(String(m.match), 40), start: m.start, end: m.end, source: String(m.source), obfuscated: !!m.obfuscated }));
  const out = {
    has_profanity: !!b.has_profanity, match_count: Number(b.match_count) || 0, terms: (b.terms || []).slice(0, 50).map((t) => clip(String(t), 40)),
    matches, matches_returned: matches.length, truncated: !!b.truncated || all.length > MCP_MAX_MATCHES,
    text_bytes: b.text_bytes, engine: b.engine, version: b.version,
  };
  if (typeof b.censored === 'string') out.censored = b.censored; // <= MAX_TEXT_BYTES: the caller's own text, censored
  return out;
}

export function summaryText(b) {
  if (!b.has_profanity) return 'No profanity found.' + (b.censored !== undefined ? ' The text is unchanged.' : '');
  const terms = b.terms.join(', ');
  return `Found ${b.match_count} match${b.match_count === 1 ? '' : 'es'} (terms: ${terms}).${b.censored !== undefined ? ` Censored text: ${clip(b.censored, 1500)}` : ''}`;
}

function toolError(message, data, extra = {}) {
  return { content: [{ type: 'text', text: message }], isError: true, ...(data ? { _meta: { [ERROR_META]: data } } : {}), ...extra };
}

function checkArgs(tool, args) {
  const props = tool.inputSchema.properties;
  const unknown = Object.keys(args).filter((k) => !Object.prototype.hasOwnProperty.call(props, k));
  if (unknown.length) return { code: 'invalid_arguments', msg: `Unknown argument(s): ${clip(unknown.slice(0, 5).join(', '), 80)}. Allowed: ${Object.keys(props).join(', ')}.` };
  if (typeof args.text !== 'string') return { code: 'missing_text', msg: '"text" (string) is required.' };
  if (args.text.length > MAX_TEXT_BYTES) return { code: 'text_too_large', msg: `"text" is longer than ${MAX_TEXT_BYTES} characters; the limit is ${MAX_TEXT_BYTES} UTF-8 bytes. Split longer text into several calls.`, status: 413 };
  if (args.censor !== undefined && typeof args.censor !== 'boolean') return { code: 'invalid_censor', msg: '"censor" must be true or false.' };
  for (const k of ['allow', 'deny']) {
    const v = args[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > MAX_LIST_ITEMS || v.some((w) => typeof w !== 'string' || w.length > MAX_LIST_ITEM_LEN)) {
      return { code: `invalid_${k}`, msg: `"${k}" must be an array of at most ${MAX_LIST_ITEMS} strings of at most ${MAX_LIST_ITEM_LEN} characters.` };
    }
  }
  return null;
}

async function callTool(params, deps) {
  const { name } = params;
  const args = params.arguments === undefined ? {} : params.arguments;
  const tool = typeof name === 'string' && Object.prototype.hasOwnProperty.call(ROUTE, name) ? ROUTE[name] : null;
  if (!tool) return { error: { code: E.INVALID_PARAMS, message: `Unknown tool: ${clip(String(name), 80)}` } };
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: { code: E.INVALID_PARAMS, message: 'arguments must be an object' } };
  const bad = checkArgs(tool, args);
  if (bad) return { result: toolError(bad.msg, { code: bad.code, httpStatus: bad.status || 400 }) };
  const body = { text: args.text };
  for (const k of ['censor', 'allow', 'deny']) if (args[k] !== undefined) body[k] = args[k];
  const res = await deps.runApi(deps.request, deps.env, deps.ctx, { method: 'POST', path: '/v1/check', body });
  const headers = Object.fromEntries(res.headers);
  let b;
  try { b = JSON.parse(await res.text()); } catch { b = {}; }
  if (res.status !== 200) {
    const retry = headers['retry-after'] ? Number(headers['retry-after']) : undefined;
    const e = (b && b.error) || {};
    const msg = clip(String(e.message || 'The check could not be completed.'), 600) + (retry ? ` (retry after ${retry} seconds)` : '');
    return { result: toolError(msg, { code: String(e.code || 'error'), httpStatus: res.status, ...(retry ? { retryAfterSeconds: retry } : {}) }), headers };
  }
  const out = shapeResult(b);
  return { result: { content: [{ type: 'text', text: summaryText(out) }], structuredContent: out, isError: false }, headers };
}

// ---------- transport helpers ----------

/** Origin policy: absent = OK (CLI / server-side clients). Present: must be a bare https origin or an http loopback
 * origin, or (if MCP_ALLOWED_ORIGINS is set) same-origin / listed. Malformed, "null" and plain-http remote → 403. */
export function originAllowed(origin, selfOrigin, allowList) {
  if (origin === null || origin === undefined) return true;
  if (origin === selfOrigin) return true;
  if (allowList) return String(allowList).split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin !== origin) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

async function readCapped(request, cap) {
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > cap) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

function decodeHeaderValue(v) {
  if (v == null) return v;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0))); } catch { return null; }
}

const isId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), error: { code, message, ...(data !== undefined ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

/**
 * Handle one JSON-RPC message. Returns { response?, status?, headers?, isCheck? }.
 * `response` undefined = notification accepted (202 when it's the whole request).
 */
async function handleMessage(msg, { modern, request, deps, auth, checkBudget }) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request'), status: 400 };
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  if (msg.jsonrpc !== '2.0') return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"'), status: 400 };
  if (typeof msg.method !== 'string') {
    // A JSON-RPC response or garbage. Legacy clients may POST responses → accept like a notification.
    if (!modern && hasId && ('result' in msg || 'error' in msg)) return {};
    return { response: rpcError(hasId && isId(msg.id) ? msg.id : null, E.INVALID_REQUEST, 'Invalid Request: method is required'), status: 400 };
  }
  if (!hasId) return {}; // notification (notifications/initialized, cancelled, …): accepted, nothing to do
  if (!isId(msg.id)) return { response: rpcError(null, E.INVALID_REQUEST, 'Invalid Request: id must be a string or number'), status: 400 };
  const { id, method } = msg;
  const params = msg.params === undefined ? {} : msg.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return { response: rpcError(id, E.INVALID_PARAMS, 'params must be an object') };

  // Modern results carry serverInfo in _meta; merge so a tool error's _meta["profanity-api/error"] is kept (CertGuard c2606ed).
  const done = (result) => ({ response: rpcResult(id, modern ? { resultType: 'complete', ...result, _meta: { ...(result._meta || {}), [META_SERVER]: SERVER_INFO } } : result) });
  const notFound = () => ({ response: rpcError(id, E.METHOD_NOT_FOUND, `Method not found: ${clip(method, 80)}`), status: modern ? 404 : 200 });
  const instr = instructions(deps.limits);

  if (modern) {
    // MCP 2026-07-28 per-request validation (version, capabilities, mirrored headers).
    const hName = decodeHeaderValue(request.headers.get('mcp-name'));
    if (request.headers.get('mcp-method') !== method) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Method header is missing or does not match the body method'), status: 400 };
    if (!params._meta || typeof params._meta[META_CAPS] !== 'object' || params._meta[META_CAPS] === null) {
      return { response: rpcError(id, E.INVALID_PARAMS, `Missing required _meta field ${META_CAPS}`), status: 400 };
    }
    if (method === 'tools/call' && hName !== params.name) return { response: rpcError(id, E.HEADER_MISMATCH, 'Header mismatch: Mcp-Name header is missing or does not match params.name'), status: 400 };
    if (method === 'server/discover') {
      return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, instructions: instr, ttlMs: 3_600_000, cacheScope: 'public' });
    }
    if (method === 'tools/list') return done({ tools: PUBLIC_TOOLS, ttlMs: 3_600_000, cacheScope: 'public' });
    if (method !== 'tools/call') return notFound(); // includes initialize and ping (removed in 2026-07-28)
  } else {
    if (method === 'initialize') {
      const req = params.protocolVersion;
      const protocolVersion = LEGACY_VERSIONS.includes(req) ? req : LEGACY_VERSIONS[0];
      return done({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instr });
    }
    if (method === 'ping') return done({});
    if (method === 'tools/list') return done({ tools: PUBLIC_TOOLS });
    if (method === 'server/discover') return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: instr });
    if (method !== 'tools/call') return notFound();
  }

  // tools/call
  if (typeof params.name !== 'string') return { response: rpcError(id, E.INVALID_PARAMS, 'params.name (tool name) is required') };
  if (checkBudget.used >= MAX_CHECKS_PER_REQUEST) {
    return { response: rpcError(id, E.INVALID_REQUEST, `At most ${MAX_CHECKS_PER_REQUEST} tools/call per HTTP request; send each call as its own request.`) };
  }
  checkBudget.used++;
  const r = await callTool(params, { ...deps, request });
  if (r.error) return { response: rpcError(id, r.error.code, r.error.message), isCheck: true };
  return { ...done(r.result), headers: r.headers, isCheck: true };
}

/** Entry point from the router for every request to /mcp. */
export async function handleMcp(request, env, ctx, deps) {
  const base = { ...MCP_CORS, ...deps.security };
  const reply = (status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { ...(body === null ? {} : { 'content-type': 'application/json; charset=utf-8' }), 'cache-control': 'no-store', ...base, ...extra },
  });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...MCP_CORS, ...deps.security } });
  if (!originAllowed(request.headers.get('origin'), deps.origin, deps.allowedOrigins)) {
    return reply(403, rpcError(undefined, E.SERVER, 'Forbidden: Origin not allowed'));
  }
  if (request.method !== 'POST') {
    return reply(405, rpcError(undefined, E.SERVER, 'Method not allowed. This MCP endpoint is stateless: POST JSON-RPC messages (no SSE stream, no sessions). Docs: /llms.txt'), { allow: 'POST, OPTIONS' });
  }
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) return reply(413, rpcError(undefined, E.INVALID_REQUEST, `Request body too large (max ${MAX_BODY_BYTES} bytes)`));
  let payload;
  try { payload = JSON.parse(text); } catch { return reply(400, rpcError(null, E.PARSE, 'Parse error: body must be valid JSON')); }

  // Era detection. Modern = per-request _meta version or a modern MCP-Protocol-Version header.
  const hVer = request.headers.get('mcp-protocol-version');
  const single = !Array.isArray(payload);
  const metaVer = single && payload && typeof payload === 'object' && payload.params && typeof payload.params === 'object'
    && payload.params._meta && typeof payload.params._meta === 'object' ? payload.params._meta[META_VERSION] : undefined;
  const modern = metaVer !== undefined || MODERN_VERSIONS.includes(hVer);
  const idOf = (p) => (p && typeof p === 'object' && isId(p.id) ? p.id : null);
  if (modern) {
    if (!single) return reply(400, rpcError(null, E.INVALID_REQUEST, 'JSON-RPC batches are not supported in protocol 2026-07-28; send one message per POST'));
    if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'id')) {
      if (metaVer === undefined && typeof payload.method === 'string') {
        return reply(400, rpcError(idOf(payload), E.INVALID_PARAMS, `Missing required _meta field ${META_VERSION}`));
      }
      if (metaVer !== undefined && !SUPPORTED_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(String(metaVer), 40) }));
      }
      if (metaVer !== undefined && !MODERN_VERSIONS.includes(metaVer)) {
        return reply(400, rpcError(idOf(payload), E.UNSUPPORTED_VERSION, `Protocol version ${metaVer} uses the initialize handshake; per-request _meta requires one of: ${MODERN_VERSIONS.join(', ')}`, { supported: SUPPORTED_VERSIONS, requested: metaVer }));
      }
      if (hVer !== metaVer) return reply(400, rpcError(idOf(payload), E.HEADER_MISMATCH, 'Header mismatch: MCP-Protocol-Version header is missing or does not match _meta protocolVersion'));
    }
  } else if (hVer && !LEGACY_VERSIONS.includes(hVer)) {
    return reply(400, rpcError(single ? idOf(payload) : null, E.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: clip(hVer, 40) }));
  }

  const msgs = single ? [payload] : payload;
  if (!msgs.length) return reply(400, rpcError(null, E.INVALID_REQUEST, 'Invalid Request: empty batch'));
  if (msgs.length > MAX_BATCH) return reply(400, rpcError(null, E.INVALID_REQUEST, `Batch too large (max ${MAX_BATCH} messages)`));

  // Light per-IP-bucket cap on non-check messages (checks are governed by the /v1/* limits inside runApi).
  const nonCheck = msgs.filter((m) => !(m && m.method === 'tools/call')).length;
  for (let i = 0; i < nonCheck; i++) {
    if (!deps.memLimit(`mcp:${deps.ipBucket}`, DISCOVERY_PER_MIN, 60_000)) {
      return reply(429, rpcError(single ? idOf(payload) : null, E.SERVER, `Too many MCP requests from your IP (about ${DISCOVERY_PER_MIN} per minute). Retry in a minute.`, { code: 'rate_limited', retryAfterSeconds: 60 }), { 'retry-after': '60' });
    }
  }

  // Same key gate as /v1/* (authenticate() in app.js), evaluated once per HTTP request (bad key → 401 for every method).
  const auth = await deps.authenticate(request, env, ctx);
  if (!auth.ok) {
    // No WWW-Authenticate on /mcp: MCP clients treat a 401 Bearer challenge as "start OAuth discovery", which this
    // server doesn't offer; the JSON-RPC error body (data.code = invalid_api_key) is the useful signal.
    return reply(auth.status, rpcError(single ? idOf(payload) : null, E.SERVER, auth.message, { code: auth.code, httpStatus: auth.status }), { ...(auth.headers || {}) });
  }

  const mdeps = { ...deps, env, ctx };
  const checkBudget = { used: 0 };
  const responses = [];
  let status = 200;
  let headers = {};
  for (const m of msgs) {
    let out;
    try {
      out = await handleMessage(m, { modern, request, deps: mdeps, auth, checkBudget });
    } catch {
      out = { response: rpcError(idOf(m), E.INTERNAL, 'Internal error') };
    }
    if (out.response) responses.push(out.response);
    if (single) status = out.status || 200;
    if (out.headers) headers = out.headers; // the (single) tools/call's /api headers, for batches too
  }
  if (!responses.length) return reply(202, null);
  const exposed = {};
  for (const h of PASS_HEADERS) if (headers[h]) exposed[h] = headers[h];
  return reply(status, single ? responses[0] : responses, exposed);
}
