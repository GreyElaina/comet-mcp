# comet-mcp

[![npm version](https://img.shields.io/npm/v/comet-mcp.svg)](https://www.npmjs.com/package/comet-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<a href="https://glama.ai/mcp/servers/@hanzili/comet-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@hanzili/comet-mcp/badge" />
</a>

**Give Claude Code a browser that thinks.**

An MCP server that connects Claude Code to [Perplexity Comet](https://www.perplexity.ai/comet) — enabling agentic web browsing, deep research, and real-time task monitoring.

![Demo](demo.gif)

## Why comet-mcp?

| Approach | Limitation |
|----------|------------|
| **WebSearch/WebFetch** | Static text only — no interaction, no login, no dynamic content |
| **Browser automation MCPs** | Generic LLM controlling browser — less polished, more fragile |
| **Comet + comet-mcp** | Perplexity's native agentic browser — purpose-built for web research, battle-tested |

**comet-mcp** = Claude's coding intelligence + Perplexity's web intelligence.

## Quick Start

### 1. Install Comet Browser

Download [Perplexity Comet](https://www.perplexity.ai/comet) and install it.

### 2. Configure Your MCP Client

Add to `~/.claude.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "comet": {
      "command": "npx",
      "args": ["-y", "comet-mcp"]
    }
  }
}
```

### 3. Use It

```
You: "Use Comet to research the latest React 19 features"
Claude: [connects to Comet, delegates research, monitors progress, returns results]
```

The MCP server auto-launches Comet with remote debugging when needed.

## Tools

### Core

| Tool | Description |
|------|-------------|
| `comet_ask` | Send a prompt and wait for response |
| `comet_poll` | Check task progress (for long-running tasks) |
| `comet_stop` | Cancel current task |
| `comet_reset` | Reset to clean state, returns current mode/model |

### Utilities

| Tool | Description |
|------|-------------|
| `comet_screenshot` | Capture current page as MCP resource |
| `comet_list_models` | List available Perplexity models |
| `comet_set_model` | Set default Perplexity model for subsequent asks |
| `comet_debug` | Dump CDP/UI status for debugging |

## `comet_ask` Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | *required* | Question or task for Comet |
| `mode` | string | current | `search`, `research`, or `studio` |
| `model` | string | current | Model name (e.g. `gpt-4o`, `claude-sonnet`). Only in search mode |
| `newChat` | boolean | `false` | Start a fresh conversation |
| `tempChat` | boolean | `true` | Enable Perplexity incognito mode |
| `agentPolicy` | string | `exit` | When browsing a website: `exit` returns to search, `continue` keeps browsing |
| `reasoning` | boolean | - | Enable/disable reasoning mode |
| `attachments` | string[] | - | File paths to attach (images, PDFs, etc.) |
| `timeout` | number | `60000` | Max wait time in ms |
| `maxOutputChars` | number | `24000` | Truncate response length |
| `force` | boolean | `false` | Send even if Comet appears busy |
| `blocking` | boolean | `true` | If `false`, return immediately once task starts |

### Agent Mode & `agentPolicy`

When Comet is actively browsing a website (agent mode), you can control behavior:

```jsonc
// Default: exit agent mode, return to normal search
{ "prompt": "What is 2+2?" }

// Continue browsing the current page
{ "prompt": "Now click the submit button", "agentPolicy": "continue" }
```

### File Attachments

```json
{
  "prompt": "Describe this image",
  "attachments": ["/path/to/image.png"]
}
```

Supported: `png`, `jpg`, `gif`, `webp`, `pdf`, `txt`, `csv`, `md` (max 25MB each)

## Screenshots & Resources

`comet_screenshot` saves to temp directory and returns an MCP resource link:

```
comet://screenshots/<filename>.png
```

Use `resources/list` and `resources/read` to access. Auto-pruned after 30 minutes (configurable).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COMET_PORT` | `9222` | CDP debug port |
| `COMET_FOREGROUND` | unset | Set `1` to bring Comet to front |
| `COMET_SCREENSHOT_MAX` | `20` | Max screenshots retained |
| `COMET_SCREENSHOT_TTL_MS` | `1800000` | Screenshot retention (30 min) |

## Architecture

```
Claude Code <-> MCP <-> comet-mcp <-> CDP <-> Comet Browser <-> Perplexity AI
```

## Requirements

- Node.js 18+
- [Perplexity Comet](https://www.perplexity.ai/comet) (macOS)
- Claude Code or any MCP client

## Troubleshooting

<details>
<summary><strong>Cannot connect to Comet</strong></summary>

- Ensure Comet is installed at `/Applications/Comet.app`
- Check port availability: `lsof -i :9222`
- Try different port: `COMET_PORT=9333`
</details>

<details>
<summary><strong>Comet steals keyboard focus</strong></summary>

Default behavior avoids foregrounding. Only set `COMET_FOREGROUND=1` if you want it.
</details>

<details>
<summary><strong>Timeout issues</strong></summary>

- `comet_ask` defaults to 60s timeout
- Your MCP client may have its own timeout
- Use `comet_poll` for long-running tasks
</details>

<details>
<summary><strong>Response truncated</strong></summary>

- Default `maxOutputChars` is 24000
- Use `comet_poll` with `offset`/`limit` to page through large responses
</details>

<details>
<summary><strong>Tools not showing in Claude</strong></summary>

Restart Claude Code after config changes.
</details>

## MCPorter Notes

- All tools auto-connect; `comet_connect` is optional
- Enable daemon/keep-alive mode to persist state across calls

## License

MIT

---

[Issues](https://github.com/hanzili/comet-mcp/issues) · [Contribute](https://github.com/hanzili/comet-mcp)
