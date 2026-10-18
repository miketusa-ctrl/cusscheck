# CussCheck

English profanity filter: find and censor swear words, incl. obfuscations. Word list, not AI.

## Live service

- Web app and API: https://profanity-api.mike-tusa.workers.dev/
- Pricing and plans: https://profanity-api.mike-tusa.workers.dev/docs
- Support: digitalpromohub.support@gmail.com

## Use it from an AI assistant (MCP)

CussCheck is a remote MCP server (Streamable HTTP) at `https://profanity-api.mike-tusa.workers.dev/mcp`. Tools: `check_profanity`.

Cursor, Cline and Windsurf accept this config:

```json
{
  "mcpServers": {
    "cusscheck": {
      "type": "http",
      "url": "https://profanity-api.mike-tusa.workers.dev/mcp"
    }
  }
}
```

Claude Desktop: open Settings > Connectors, choose "Add custom connector" and paste `https://profanity-api.mike-tusa.workers.dev/mcp`. Or, for clients that only support local (stdio) servers, use the mcp-remote bridge: `npx mcp-remote https://profanity-api.mike-tusa.workers.dev/mcp`.

VS Code uses a `servers` key instead of `mcpServers`.

The `server.json` file is the [MCP Registry](https://registry.modelcontextprotocol.io) manifest for this server.

## Run your own copy

Requires Node.js 20+ and a Cloudflare account.

```bash
npm install
npx wrangler dev        # local dev server
```

`wrangler.toml` is a template: create your own KV namespaces / D1 databases / rate-limit namespaces and replace the `<PLACEHOLDER>` values before `npx wrangler deploy`. Any secrets the Worker reads go in `wrangler secret put` (or `.dev.vars` locally), never in the repo.

## License

MIT (c) Digital Promo Hub. See [LICENSE](LICENSE).
