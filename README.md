# comet-mcp

[![npm version](https://img.shields.io/npm/v/comet-mcp.svg)](https://www.npmjs.com/package/comet-mcp)

<a href="https://glama.ai/mcp/servers/@hanzili/comet-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@hanzili/comet-mcp/badge" />
</a>

**Give Claude Code a browser that thinks.**

An MCP server that connects Claude Code to [Perplexity Comet](https://www.perplexity.ai/comet) - enabling agentic web browsing, deep research, and real-time task monitoring.

![Demo](demo.gif)

## Why?

Existing web tools for Claude Code fall short:
- **WebSearch/WebFetch** only return static text - no interaction, no login, no dynamic content
- **Browser automation MCPs** (like browser-use) are agentic but use a generic LLM to control a browser - less polished, more fragile

**Comet is Perplexity's native agentic browser** - their AI is purpose-built for web research, deeply integrated with search, and battle-tested. Give it a goal, it figures out how to get there.

**comet-mcp** bridges Claude Code and Comet: Claude's coding intelligence + Perplexity's web intelligence.

## Quick Start

### 1. Configure Claude Code

Add to `~/.claude.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "comet-bridge": {
      "command": "npx",
      "args": ["-y", "comet-mcp"]
    }
  }
}
```

### 2. Install Comet Browser

Download and install [Perplexity Comet](https://www.perplexity.ai/comet).

That's it! The MCP server will automatically launch Comet with remote debugging enabled when needed. If Comet is already running, it will restart it with the correct flags.

### 3. Use in Claude Code

```
You: "Use Comet to research the top AI frameworks in 2025"
Claude: [connects to Comet, delegates research, monitors progress, returns results]
```

## Notes for MCPorter

- `comet_ask` (and `comet_poll`, etc.) auto-starts Comet + connects via CDP if needed. `comet_connect` is optional.
- MCPorter may start a fresh stdio process per `mcporter call` unless the server is configured as keep-alive (daemon-managed). If you want to reuse state/cookies between calls, enable the daemon and keep-alive for `comet-mcp`.

## Tools

| Tool | Description |
|------|-------------|
| `comet_connect` | Connect to Comet (auto-starts if needed) |
| `comet_ask` | Send a task and wait for response. Params: `mode`, `tempChat` (default: true), `reasoning`, `attachments` |
| `comet_poll` | Check task progress. Use `includeSettings` to show current mode/tempChat/model/reasoning |
| `comet_debug` | Dump CDP/UI status for debugging |
| `comet_stop` | Stop current task |
| `comet_screenshot` | Capture current page (saves as a resource) |
| `comet_list_models` | List available Perplexity models (best-effort) |
| `comet_set_model` | Switch Perplexity model by name (best-effort) |

### File attachments

`comet_ask` supports attaching files (images, PDFs, etc.) for Perplexity to analyze:

```json
{
  "prompt": "Describe this image",
  "attachments": ["/path/to/image.png"]
}
```

- Accepts local file paths or `file://` URIs
- Supported formats: png, jpg, jpeg, gif, webp, pdf, txt, csv, md
- Max file size: 25MB per file
- Multiple files can be attached in a single request

### Screenshots & resources

`comet_screenshot` no longer dumps base64 blobs into the tool response. Instead it writes the PNG to your OS temp directory (e.g. `/tmp/comet-mcp/screenshots`) and returns a `resource_link` pointing at `comet://screenshots/<filename>`. Use the standard MCP resource APIs to retrieve the data:

- `resources/list` shows every retained screenshot, newest first.
- `resources/read` downloads the referenced file with the correct MIME type.

Older screenshots are pruned automatically. By default we keep 20 files for up to 30 minutes; override via `COMET_SCREENSHOT_MAX` (count) and `COMET_SCREENSHOT_TTL_MS` (milliseconds) if you need longer retention.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMET_PORT` | `9222` | CDP debug port (change if 9222 conflicts with other Chrome debuggers) |
| `COMET_FOREGROUND` | unset | Set to `1` to bring Comet window to front on connect |
| `COMET_SCREENSHOT_MAX` | `20` | Maximum screenshots to retain |
| `COMET_SCREENSHOT_TTL_MS` | `1800000` | Screenshot retention time (30 min) |

## Architecture

```
Claude Code <-> MCP <-> comet-mcp <-> CDP <-> Comet Browser <-> Perplexity AI
```

## Requirements

- Node.js 18+
- [Perplexity Comet Browser](https://www.perplexity.ai/comet)
- Claude Code (or any MCP client)

## Troubleshooting

**"Cannot connect to Comet"**
- Make sure Comet is installed at `/Applications/Comet.app`
- Check if the debug port is available (default 9222, configurable via `COMET_PORT` env var)
- If port 9222 conflicts with another Chrome debugger, set `COMET_PORT=9333` (or any free port)

**"Comet keeps popping to the front / steals my keyboard focus"**
- Newer versions avoid foregrounding by default. Set `COMET_FOREGROUND=1` only if you explicitly want the tab/window to be brought to front.

**"I set timeout=900000 but it still times out in ~2-3 minutes"**
- `comet_ask`'s `timeout` controls how long this server will poll for completion (newer versions default to 60s to encourage using `comet_poll`), but your MCP client may enforce its own per-request timeout.
- If your client supports MCP progress notifications, newer versions of `comet-mcp` will emit `notifications/progress` heartbeats to help keep long requests alive.
- If the call still returns early, use `comet_poll` to continue monitoring and retrieve the final response.

**"I don't want Comet chats to affect my normal Perplexity account history"**
- `comet_ask` enables Perplexity "隐身" (incognito) mode by default via the `tempChat` parameter (best-effort; UI/account dependent).
- Set `tempChat: false` in your `comet_ask` call to disable this behavior.

**"Claude Code says the tool response was truncated"**
- This can happen if the response text is very long and the MCP client/UI enforces its own display/size limits.
- Newer versions of `comet-mcp` limit `comet_ask` output by default (`maxOutputChars`, default 24000) and support paging the final response via `comet_poll` with `offset`/`limit`.

**"Using mcporter: I ran comet_connect, but a later call says 'Not connected to Comet'"**
- MCPorter can launch a new stdio process per `mcporter call`, so in-memory connection state may not carry over.
- Newer versions of `comet-mcp` auto-connect on every tool call; alternatively enable MCPorter keep-alive/daemon for this server to reuse a single process across calls.

**"Result is visible in Comet, but mcporter/Claude Code call never returns"**
- This is usually caused by UI state detection not flipping to "completed" reliably (e.g. the page still looks "working" even though the answer is already rendered).
- Newer versions of `comet-mcp` include a fallback that returns once the latest answer text becomes stable and loading indicators stop.
- If you still hit it, run `comet_poll` to confirm the latest response text is present, then share the `comet_poll` output so we can tune selectors for your UI variant.

**"Tools not showing in Claude"**
- Restart Claude Code after config changes

## License

MIT

---

[Report Issues](https://github.com/hanzili/comet-mcp/issues) · [Contribute](https://github.com/hanzili/comet-mcp)
