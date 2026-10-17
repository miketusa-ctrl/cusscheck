// llms.txt, OpenAPI 3.1 and the MCP server card, generated from code constants and config(env) limits (agent-ready
// recipe r2 §3/§4, Smithery §13.2). Adapted from CheckDigit src/lib/agentdocs.js. Drift tests: test/agent.test.js.
// Contact: the product's SUPPORT_EMAIL, not the recipe's shared address.
import { TOOLS, SUPPORTED_VERSIONS, DISCOVERY_PER_MIN, MAX_BODY_BYTES as MCP_BODY, SERVER_INFO, RESULT_OUT, MCP_MAX_MATCHES } from './mcp.js';
import { VERSION } from '../version.js';

export const mcpClientConfig = (origin) => ({ mcpServers: { cusscheck: { type: 'http', url: `${origin}/mcp` } } });

export const llmsTxt = (origin, L, X) => `# CussCheck

> English profanity filter: finds swear words in text (including obfuscations like f.u.c.k, sh1t and fuuuck), returns their positions and a censored copy. Word-list filter (obscenity englishDataset), not AI moderation; it does not understand context. Public JSON API plus a remote MCP server for AI agents. Submitted text is checked in memory and never stored or logged.

## For AI agents

- [MCP server](${origin}/mcp): remote MCP over Streamable HTTP (POST only, stateless, JSON responses). Protocol versions: ${SUPPORTED_VERSIONS.join(', ')}. Tools: ${TOOLS.map((t) => `\`${t.name}\` (${Object.keys(t.inputSchema.properties).join(', ')})`).join(', ')}. Read-only. Client config (most MCP clients accept this; some use a different format, for example VS Code uses a \`servers\` key): \`${JSON.stringify(mcpClientConfig(origin))}\`
- [OpenAPI 3.1 spec](${origin}/openapi.json): machine-readable description of the JSON API
- [Docs](${origin}/docs): human-readable API docs

## JSON API

- \`POST ${origin}/v1/check\` with JSON \`{"text": "...", "censor": true, "allow": [], "deny": []}\`: text at most ${X.maxText} UTF-8 bytes, body at most ${X.maxBody} bytes; allow/deny up to ${X.maxListItems} words of at most ${X.maxListItemLen} characters.
- Result: has_profanity, match_count, terms, matches (term, match, start, end as UTF-16 indices, source, obfuscated; at most ${X.maxMatches}, truncated flag), censored, text_bytes, engine, version.
- \`POST ${origin}/v1/keys\` with \`{}\`: free API key (${L.keyDaily}/day, ${L.keyPerMin}/min), shown once. \`GET ${origin}/v1/usage\` with the key: today's usage.
- Errors: { "error": { "code", "message" } } with 400 (invalid_json, missing_text, invalid_censor, invalid_allow, invalid_deny), 401 (invalid_api_key, missing_api_key), 403 (cross_origin_forbidden), 404 (not_found), 405 (method_not_allowed), 413 (body_too_large, text_too_large), 415 (unsupported_media_type), 429 (rate_limited, ip_daily_quota, key_quota_exceeded, issuer_quota_exceeded, daily_cap_reached, key_issue_limit; with Retry-After), 500 (internal_error), 503 (not_configured, unavailable).

## Limits and keys

- Anonymous: ${L.anonPerMin} checks/min and ${L.anonDaily}/day per IP. Free API key (\`X-Api-Key: pf_...\` or \`Authorization: Bearer pf_...\`): ${L.keyPerMin}/min and ${L.keyDaily}/day. The MCP endpoint uses the same keys and counters: each \`check_profanity\` call is one check (max ${MCP_MAX_MATCHES} matches listed per call; match_count is the full total); non-call messages don't count as checks but are capped at about ${DISCOVERY_PER_MIN}/min per IP (HTTP 429 + Retry-After). Max MCP body ${MCP_BODY} bytes.
${X.proCheckout ? `- CussCheck Pro: $${X.proPrice}/month (Polar checkout: ${X.proCheckout}). ${X.proDaily} checks/day per license, ${L.keyPerMin}/min, own capacity separate from the free pool. Send the license key (\`CCPR-...\`) as X-Api-Key, or as Authorization: Bearer on /mcp. Same engine and per-request limits as free.\n` : ''}
## Optional

- [Privacy](${origin}/privacy): submitted text is never stored or logged. A salted, daily-rotating hash of the visitor network is kept for up to 9 days to count unique visitors per day; no IP address is stored.
- Contact: ${X.supportEmail}
`;

const errSchema = { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] } }, required: ['error'] };
const resp = (d) => ({ description: d, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
const H = (d) => ({ description: d, schema: { type: 'string' } });
const okHeaders = { 'x-api-plan': H('anonymous or free_key'), 'x-ratelimit-limit': H('Daily limit'), 'x-ratelimit-remaining': H('Requests left today (approximate)'), 'x-ratelimit-reset': H('Unix time of the next 00:00 UTC reset') };
const r429 = { description: 'rate_limited, ip_daily_quota, key_quota_exceeded, issuer_quota_exceeded or daily_cap_reached', headers: { 'retry-after': H('Seconds to wait') }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };

export function openApiSpec(origin, L, X) {
  const words = (d) => ({ type: 'array', description: d, maxItems: X.maxListItems, items: { type: 'string', maxLength: X.maxListItemLen } });
  const paths = {
    '/v1/check': { post: {
      operationId: 'check', summary: 'Find (and optionally censor) English profanity in text',
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
        text: { type: 'string', description: `At most ${X.maxText} UTF-8 bytes` }, censor: { type: 'boolean', default: true },
        allow: words('Words never to flag'), deny: words('Extra words to flag'),
      }, required: ['text'] } } } },
      responses: { 200: { description: 'Result', headers: okHeaders, content: { 'application/json': { schema: { $ref: '#/components/schemas/Result' } } } }, 400: resp('invalid_json, missing_text, invalid_censor, invalid_allow or invalid_deny'), 401: resp('invalid_api_key'), 403: resp('cross_origin_forbidden'), 413: resp('body_too_large or text_too_large'), 415: resp('unsupported_media_type'), 429: r429, 500: resp('internal_error'), 503: resp('not_configured or unavailable') },
    } },
    '/v1/keys': { post: {
      operationId: 'createKey', summary: `Issue a free API key (${L.keyDaily}/day, ${L.keyPerMin}/min; shown once)`, security: [{}],
      requestBody: { required: false, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 201: { description: 'Key issued', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, api_key: { type: 'string' }, key_id: { type: 'string' }, plan: { type: 'string' }, daily_quota: { type: 'integer' }, per_minute: { type: 'integer' } } } } } }, 429: r429, 503: resp('not_configured or unavailable') },
    } },
    '/v1/usage': { get: {
      operationId: 'usage', summary: "Today's usage for your API key", security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
      responses: { 200: { description: 'Usage', content: { 'application/json': { schema: { type: 'object' } } } }, 401: resp('missing_api_key or invalid_api_key'), 429: r429 },
    } },
  };
  const allow = { allow: { schema: { type: 'string', enum: ['POST, OPTIONS'] } } };
  paths['/mcp'] = {
    post: {
      operationId: 'mcp', summary: `MCP JSON-RPC 2.0 (Streamable HTTP, stateless). Protocol versions ${SUPPORTED_VERSIONS.join(', ')}. Max body ${MCP_BODY} bytes.`,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: { 200: { description: 'JSON-RPC response (tool errors are results with isError)', headers: okHeaders }, 202: { description: 'Notification or client response accepted' }, 400: { description: 'Parse error, invalid request, header mismatch or unsupported version' }, 401: { description: 'invalid_api_key (no WWW-Authenticate)' }, 403: { description: 'Origin not allowed' }, 404: { description: 'Unknown method (2026-07-28)' }, 413: { description: 'Body too large' }, 429: { description: 'Too many MCP requests or key checks', headers: { 'retry-after': H('Seconds') } }, 500: { description: 'Internal error' }, 503: { description: 'not_configured' } },
    },
    get: { operationId: 'mcpGet', summary: 'Not supported (stateless, no SSE)', responses: { 405: { description: 'Method not allowed', headers: allow } } },
    delete: { operationId: 'mcpDelete', summary: 'Not supported (no sessions)', responses: { 405: { description: 'Method not allowed', headers: allow } } },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'CussCheck', version: VERSION, description: `English profanity word filter with obfuscation handling: detect and censor swear words. Not AI moderation. Text is never stored or logged. Anonymous ${L.anonPerMin}/min and ${L.anonDaily}/day per IP; free API key ${L.keyPerMin}/min and ${L.keyDaily}/day.${X.proCheckout ? ` CussCheck Pro ($${X.proPrice}/month, Polar): ${X.proDaily}/day per license.` : ''}`, contact: { email: X.supportEmail } },
    servers: [{ url: origin }],
    security: [{}, { bearerAuth: [] }, { apiKeyHeader: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: X.proCheckout ? 'pf_... free API key or CCPR-... CussCheck Pro license key' : 'pf_... API key' }, apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } },
      schemas: { Error: errSchema, Result: RESULT_OUT },
    },
    paths,
  };
}

export const serverCard = (origin) => ({
  serverInfo: { name: SERVER_INFO.name, title: SERVER_INFO.title, version: VERSION },
  transport: { type: 'streamable-http', url: `${origin}/mcp` },
  authentication: { required: false },
  tools: TOOLS, resources: [], prompts: [],
});
