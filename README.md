# CussCheck

English profanity filter: find and censor swear words, incl. obfuscations. Word list, not AI.

## Live service

- Web app and API: https://profanity-api.mike-tusa.workers.dev/
- Pricing: https://profanity-api.mike-tusa.workers.dev/docs
- Support: digitalpromohub.support@gmail.com

## Use it from an AI assistant (MCP)

CussCheck is a remote MCP server (Streamable HTTP) at `https://profanity-api.mike-tusa.workers.dev/mcp`. Tools: `check_profanity`.

Cursor and Windsurf accept this config:

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

Cline (MCP Servers > Remote Servers, or `cline_mcp_settings.json`) needs `"type": "streamableHttp"`:

```json
{
  "mcpServers": {
    "cusscheck": {
      "type": "streamableHttp",
      "url": "https://profanity-api.mike-tusa.workers.dev/mcp"
    }
  }
}
```

Claude Desktop: open Settings > Connectors, choose "Add custom connector" and paste `https://profanity-api.mike-tusa.workers.dev/mcp`. Or, for clients that only support local (stdio) servers, use the mcp-remote bridge: `npx mcp-remote https://profanity-api.mike-tusa.workers.dev/mcp`.

VS Code uses a `servers` key instead of `mcpServers`.

The `server.json` file is the [MCP Registry](https://registry.modelcontextprotocol.io) manifest for this server.

## Run your own copy

Requires Node.js 22+ and a Cloudflare account.

```bash
npm install
npx wrangler@4 dev      # local dev server
```

`wrangler.toml` is a template: create your own KV namespaces / D1 databases / rate-limit namespaces and replace the `<PLACEHOLDER>` values before `npx wrangler@4 deploy`. Any secrets the Worker reads go in `wrangler secret put` (or `.dev.vars` locally), never in the repo.

## Third-party data

Word matching uses the English dataset of the [`obscenity`](https://github.com/jo3-l/obscenity) npm package (MIT); no word list is stored in this repo.

## License

MIT (c) Digital Promo Hub. See [LICENSE](LICENSE).
