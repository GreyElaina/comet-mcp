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
| `comet_ask` | Send a task and wait for response |
| `comet_poll` | Check task progress |
| `comet_debug` | Dump CDP/UI status for debugging |
| `comet_stop` | Stop current task |
| `comet_screenshot` | Capture current page |
| `comet_mode` | Switch modes: search, research, labs, learn |
| `comet_models` | List available Perplexity models (best-effort) |
| `comet_model` | Switch Perplexity model by name (best-effort) |
| `comet_temp_chat` | Inspect/toggle Perplexity “隐身” (temporary/incognito) mode (best-effort) |

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
- Check if port 9222 is available (no other Chrome/debugger using it)

**"Comet keeps popping to the front / steals my keyboard focus"**
- Newer versions avoid foregrounding by default. Set `COMET_FOREGROUND=1` only if you explicitly want the tab/window to be brought to front.

**"I set timeout=900000 but it still times out in ~2-3 minutes"**
- `comet_ask`'s `timeout` controls how long this server will poll for completion (newer versions default to 60s to encourage using `comet_poll`), but your MCP client may enforce its own per-request timeout.
- If your client supports MCP progress notifications, newer versions of `comet-mcp` will emit `notifications/progress` heartbeats to help keep long requests alive.
- If the call still returns early, use `comet_poll` to continue monitoring and retrieve the final response.

**"I don't want Comet chats to affect my normal Perplexity account history"**
- Newer versions of `comet-mcp` will try to enable Perplexity “隐身” mode (from the account dropdown) before sending prompts via `comet_ask` (best-effort; UI/account dependent).
- You can also manually inspect or toggle it via `comet_temp_chat`.

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
