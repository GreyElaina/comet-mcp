# Marketing Copy for comet-mcp

## One-liner

> Give Claude Code a browser that thinks.

## Taglines

- "Claude + Comet = Autonomous web research"
- "Let Claude browse the web like a human"
- "Bridge Claude Code to Perplexity's agentic browser"

---

## Twitter/X Thread

**Tweet 1 (Main):**
```
Just released comet-mcp - an MCP server that connects Claude Code to Perplexity Comet browser.

Now Claude can:
• Browse the web autonomously
• Do deep research with real sources
• Execute multi-step web tasks

3 steps to set up. Open source.

github.com/anthropics/comet-mcp
```

**Tweet 2:**
```
The problem: Claude Code is powerful but can't browse the web.

Comet is an agentic browser that can navigate, click, scroll, and research - but it's isolated.

comet-mcp bridges them via Chrome DevTools Protocol.
```

**Tweet 3:**
```
Example workflow:

Me: "Find the top trending Python repos on GitHub"

Claude:
→ Connects to Comet
→ Navigates to GitHub trending
→ Filters by Python
→ Returns structured results

All while I watch the browser do its thing.
```

**Tweet 4:**
```
Setup is dead simple:

1. Add config to ~/.claude.json
2. Start Comet with --remote-debugging-port=9222
3. Ask Claude to use Comet

npx comet-mcp - no install needed.
```

---

## Reddit Post (r/ClaudeAI)

**Title:** I built an MCP server that lets Claude Code control Perplexity Comet browser

**Body:**
```
Hey everyone,

I've been using Claude Code for a while and the biggest limitation was always web access. Yes, there's WebSearch and WebFetch, but they're limited.

So I built **comet-mcp** - an MCP server that connects Claude Code to Perplexity's Comet browser via Chrome DevTools Protocol.

**What it does:**
- Claude can send tasks to Comet's agentic browser
- Real-time monitoring of browsing progress
- Ability to stop tasks if they go off-track
- Support for all Perplexity modes (search, research, labs, learn)

**Example:**
```
Me: "Use Comet to find the best restaurants in Tokyo with Michelin stars"

Claude connects to Comet, watches it navigate Google Maps, Michelin Guide, etc., and returns a comprehensive answer with sources.
```

**Setup (3 steps):**
1. Add to ~/.claude.json:
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

2. Start Comet with: `/Applications/Comet.app/Contents/MacOS/Comet --remote-debugging-port=9222`

3. Ask Claude to use Comet

**Links:**
- GitHub: [link]
- npm: `npx comet-mcp`

Open source, MIT licensed. Would love feedback!
```

---

## Reddit Post (r/LocalLLaMA)

**Title:** MCP Server to connect any Claude-compatible client to Perplexity Comet browser

**Body:**
```
Built an MCP server that bridges Claude (or any MCP client) to Perplexity's Comet browser.

Uses Chrome DevTools Protocol to:
- Send prompts to Comet
- Poll for status (working/completed)
- Extract responses
- Take screenshots
- Switch between modes (search/research/labs/learn)

The interesting part: Comet has agentic browsing - it can actually navigate websites, click buttons, fill forms, etc. So you can ask it to "go to HN and find posts about X" and watch it do it.

6 tools total:
- comet_connect
- comet_ask
- comet_poll
- comet_stop
- comet_screenshot
- comet_mode

GitHub: [link]
npm: comet-mcp

Works with Claude Code, Claude Desktop, or any MCP-compatible client.
```

---

## Hacker News

**Title:** Show HN: comet-mcp – Connect Claude Code to Perplexity's agentic browser

**Body:**
```
I built an MCP server that bridges Claude Code to Perplexity Comet browser via Chrome DevTools Protocol.

Problem: Claude Code can't browse the web autonomously. Perplexity Comet has an agentic browser that can navigate, click, and research - but it's siloed in a browser window.

Solution: comet-mcp connects them. Claude sends tasks to Comet, monitors progress, and gets results back.

Technical details:
- Uses chrome-remote-interface for CDP communication
- Non-blocking architecture with polling for long-running tasks
- Auto-reconnect on connection drops
- 6 minimal tools (connect, ask, poll, stop, screenshot, mode)

Setup:
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

Then start Comet with --remote-debugging-port=9222.

GitHub: [link]
```

---

## LinkedIn

```
Excited to share comet-mcp - an open source tool that connects Claude Code to Perplexity's Comet browser.

The problem: AI coding assistants are great at writing code, but limited when it comes to web research.

The solution: Bridge Claude to an agentic browser that can actually navigate websites, find information, and execute complex research tasks.

Key features:
→ Autonomous web browsing via Comet
→ Real-time task monitoring
→ Multiple research modes
→ Simple 3-step setup

Built with: TypeScript, Chrome DevTools Protocol, MCP

Check it out: [GitHub link]

#AI #DeveloperTools #OpenSource #Claude #Perplexity
```

---

## Product Hunt (if launching there)

**Tagline:** Give Claude Code a browser that thinks

**Description:**
```
comet-mcp connects Claude Code to Perplexity Comet - enabling autonomous web browsing and deep research.

🔗 Bridge: Claude Code ↔ MCP ↔ CDP ↔ Comet Browser ↔ Perplexity AI

✨ Features:
• Delegate web research to Comet's agentic browser
• Monitor browsing progress in real-time
• Stop tasks that go off track
• Switch between search, research, labs, and learn modes

🚀 3-step setup, no install required (npx comet-mcp)

Perfect for developers who want Claude to do real web research, not just API calls.
```

---

## Demo Script (for GIF/Video)

1. Show terminal with Claude Code
2. Type: "Use Comet to find the top 3 AI news stories today"
3. Show Claude calling comet_connect
4. Split screen: Claude Code + Comet browser
5. Show Comet navigating to news sites
6. Show comet_poll returning status updates
7. Show final results in Claude Code
8. End card: "comet-mcp - Give Claude Code a browser that thinks"

Duration: 30-45 seconds
