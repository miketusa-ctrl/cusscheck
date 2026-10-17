// Shared constants (no imports) so app.js, mcp.js and agentdocs.js can all read them without import cycles.
export const VERSION = '0.3.1';
export const MAX_TEXT_BYTES = 10 * 1024;  // 10,240 bytes, UTF-8 length of "text"
export const MAX_BODY_BYTES = 16 * 1024;  // 16,384 bytes, POST /v1/check body
export const MAX_MATCHES = 500;           // matches[] per /v1/check response (match_count is always the full total)
