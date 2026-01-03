# comet-mcp

**Give Claude Code a browser that thinks.**

An MCP server that connects Claude Code to [Perplexity Comet](https://www.perplexity.ai/comet) - enabling agentic web browsing, deep research, and real-time task monitoring.

<!-- ![Demo](demo.gif) -->

## Why?

Claude Code is powerful, but it can't browse the web autonomously. Comet can browse, research, and execute multi-step web tasks - but it's isolated in a browser.

**comet-mcp bridges them.** Now Claude can:
- Delegate web research to Comet's agentic browser
- Monitor browsing progress in real-time
- Intervene if tasks go off track
- Get comprehensive research reports

## Quick Start

### 1. Configure Claude Code

Add to `~/.claude.json` (scope: user) or `.mcp.json` (scope: project):

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

Or install globally first:

```bash
npm install -g comet-mcp
```

Then use:

```json
{
  "mcpServers": {
    "comet-bridge": {
      "command": "comet-mcp"
    }
  }
}
```

### 2. Start Comet Browser

Download [Perplexity Comet](https://www.perplexity.ai/comet) and launch with remote debugging:

```bash
# macOS
/Applications/Comet.app/Contents/MacOS/Comet --remote-debugging-port=9222
```

### 3. Use in Claude Code

```
You: "Use Comet to research the top AI frameworks in 2025"
Claude: [connects to Comet, delegates research, monitors progress, returns results]
```

## Tools (6)

| Tool | Description |
|------|-------------|
| `comet_connect` | Connect to Comet (auto-starts if needed) |
| `comet_ask` | Send a task to Comet (non-blocking) |
| `comet_poll` | Check task progress and get results |
| `comet_stop` | Stop current task if off-track |
| `comet_screenshot` | Capture current page |
| `comet_mode` | Switch modes: search, research, labs, learn |

## Modes

| Mode | Best For |
|------|----------|
| `search` | Quick web searches |
| `research` | Deep, comprehensive analysis |
| `labs` | Data visualization & analytics |
| `learn` | Educational explanations |

## Prompting Tips

When sending tasks to Comet via `comet_ask`, focus on **context and goals** rather than step-by-step instructions:

**Good prompts:**
```
"I need to find the best React state management libraries for a large-scale app.
Compare their bundle sizes, learning curves, and community support."

"Help me understand how Stripe's pricing API works. I'm building a SaaS
and need to implement usage-based billing."
```

**Less effective prompts:**
```
"Go to google.com, search for React state management, click the first result..."
```

Claude understands the task context; Comet handles the browsing. Let them collaborate - Comet will figure out the best way to navigate and gather information.

## Example Workflow

```
# Claude Code conversation

You: Find the top 3 trending Python repos on GitHub

Claude: I'll use Comet to browse GitHub directly.

[comet_connect] → Connected to Perplexity
[comet_mode research] → Switched to research mode
[comet_ask "Find top 3 trending Python repos on GitHub today with their star counts"] → Task sent
[comet_poll] → Status: WORKING, Navigating to github.com/trending...
[comet_poll] → Status: WORKING, Filtering by Python...
[comet_poll] → Status: COMPLETED

Results:
1. project-a - 2.3k stars today
2. project-b - 1.8k stars today
3. project-c - 1.2k stars today
```

## Architecture

```
Claude Code ←→ MCP Protocol ←→ comet-mcp ←→ Chrome DevTools Protocol ←→ Comet Browser
                                                                              ↓
                                                                    Perplexity AI (agentic browsing)
```

## Requirements

- Node.js 18+
- [Perplexity Comet Browser](https://www.perplexity.ai/comet)
- Claude Code (or any MCP-compatible client)

## Troubleshooting

**"Cannot connect to Comet"**
- Make sure Comet is running with `--remote-debugging-port=9222`
- Check if port 9222 is available

**"Tools not showing in Claude"**
- Restart Claude Code after config changes
- Verify `~/.mcp.json` syntax

## License

MIT

---

**Built for the Claude Code community.**

[Report Issues](https://github.com/hanzili/comet-mcp/issues) · [Contribute](https://github.com/hanzili/comet-mcp)
