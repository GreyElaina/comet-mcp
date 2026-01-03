# comet-mcp Marketing Strategy

## Core Positioning

### The Pain Point (Crystal Clear)
> "Claude Code is powerful but blind to the live web. You can't ask it to check real prices, navigate dashboards, or research across dynamic sites."

### The Solution (One Sentence)
> "comet-mcp gives Claude Code a browser that can think, click, and research autonomously."

### Why It's Different (Not 10% Better)
- Not just another web search tool - it's **agentic browsing**
- Claude delegates entire research tasks, not just queries
- Real-time monitoring - watch the AI browse, intervene if needed
- Perplexity's research engine + Claude's intelligence = unprecedented combo

---

## Launch Channels (Priority Order)

### 1. MCP Ecosystem (Do First!)

**awesome-mcp-servers GitHub**
- Submit PR to: https://github.com/punkpeye/awesome-mcp-servers
- Category: "Browser Automation" or "Research"
- This is where developers discover MCP servers

**mcpservers.org**
- Submit to directory
- Include clear description + Claude Code setup

**MCP Discord**
- Join the community Discord by Frank Fiegel
- Share genuinely, help others, then mention your tool

### 2. Hacker News (Show HN)

**Title Options (Clear > Clever):**
```
Show HN: comet-mcp – Give Claude Code a browser that browses autonomously
Show HN: I built an MCP server connecting Claude Code to Perplexity's agentic browser
Show HN: Claude Code can now browse the web like a human via Perplexity Comet
```

**Post Body:**
```
I built an MCP server that bridges Claude Code to Perplexity Comet browser.

The problem: Claude Code can search the web, but it can't actually browse it.
It can't log into dashboards, navigate dynamic sites, or do multi-step research.

The solution: Connect Claude to Perplexity's agentic browser via Chrome DevTools Protocol.
Now Claude can delegate entire browsing tasks - "go to GitHub trending, find top Python repos" -
and Comet will navigate, click, scroll, and return results.

What makes it different:
- Non-blocking: send task, poll for progress, intervene if needed
- Real browser: handles login walls, dynamic content, JS-heavy sites
- Perplexity's research: deep analysis with source citations

6 tools: connect, ask, poll, stop, screenshot, mode

Setup: add one JSON block to ~/.claude.json, start Comet with --remote-debugging-port=9222

GitHub: https://github.com/hanzili/comet-mcp
npm: npx comet-mcp
```

**HN Success Tips:**
- Post 6-9am PST (HN peak hours)
- Engage with EVERY comment (be human, not defensive)
- Don't ask friends to upvote (HN detects this)
- Link goes to GitHub, not landing page

### 3. Reddit

**r/ClaudeAI** (Primary - 100k+ members, perfect audience)

Title: `I made Claude Code browse the web autonomously using Perplexity Comet`

```
Been using Claude Code for months and the biggest limitation was always live web access.
WebSearch works for simple queries but can't:
- Navigate dynamic sites
- Handle login walls
- Do multi-step research
- Interact with web apps

So I built comet-mcp - connects Claude Code to Perplexity's Comet browser via CDP.

Example workflow:
Me: "Research the pricing of Auth0 vs Clerk vs Supabase Auth for a B2B SaaS"

Claude:
→ Connects to Comet
→ Delegates the research task
→ Comet visits each site, navigates pricing pages
→ Returns structured comparison with sources

The cool part: you can watch Comet browse in real-time and stop it if it goes off track.

Setup is 2 steps:
1. Add config to ~/.claude.json
2. Start Comet with remote debugging

GitHub: [link]
npm: `npx comet-mcp`

Would love feedback from other Claude Code users!
```

**r/LocalLLaMA** (Technical audience)
- Focus on the architecture: MCP + CDP bridge
- Mention it works with any MCP-compatible client

**r/programming** (Broader reach)
- More technical, show the code architecture

### 4. Twitter/X

**Thread Hook Options:**
```
1. "Claude Code is blind to the live web. Here's how I fixed it:"

2. "I gave Claude Code a browser that thinks.
   Now it can browse autonomously, research deeply, and report back.
   Here's the open-source tool (and how to set it up in 2 minutes):"

3. "The problem with AI coding assistants:
   They can write code but can't check if the API they're using still exists.

   I built comet-mcp to fix this. Thread 🧵"
```

**Thread Structure (7 tweets):**

Tweet 1 (Hook):
```
Claude Code is powerful but web-blind.

It can't:
- Check real-time prices
- Navigate dashboards
- Research across dynamic sites

I built comet-mcp to fix this.

Here's how it works 🧵
```

Tweet 2 (Problem):
```
The current tools (WebSearch, WebFetch) are limited:
- Static content only
- No login handling
- No multi-step navigation
- No interaction with web apps

But what if Claude could control a real browser?
```

Tweet 3 (Solution):
```
comet-mcp connects Claude Code to Perplexity Comet browser.

Comet has "agentic browsing" - it can:
- Navigate sites autonomously
- Click buttons, fill forms
- Research across multiple sources
- Handle dynamic content
```

Tweet 4 (How it works):
```
The architecture:

Claude Code
  ↓ (MCP Protocol)
comet-mcp server
  ↓ (Chrome DevTools Protocol)
Comet Browser
  ↓
Perplexity AI (agentic browsing)

Claude sends tasks, polls progress, gets results.
```

Tweet 5 (Example):
```
Example:

Me: "Compare pricing of the top 3 auth providers"

Claude:
→ comet_connect
→ comet_ask "Research Auth0 vs Clerk vs Supabase pricing..."
→ comet_poll (watching Comet browse)
→ Returns structured comparison

[screenshot or GIF here]
```

Tweet 6 (Setup):
```
Setup takes 2 minutes:

1. Add to ~/.claude.json:
{
  "mcpServers": {
    "comet-bridge": {
      "command": "npx",
      "args": ["-y", "comet-mcp"]
    }
  }
}

2. Start Comet with:
--remote-debugging-port=9222

Done.
```

Tweet 7 (CTA):
```
Try it:

GitHub: github.com/hanzili/comet-mcp
npm: npx comet-mcp

6 tools. Open source. MIT licensed.

If you build something cool with it, let me know!
```

### 5. Product Hunt (Later)

- Wait until you have: demo GIF, some GitHub stars, user testimonials
- Launch on Tuesday-Thursday
- Prepare hunter, tagline, screenshots in advance

---

## Content Assets Needed

### Must Have:
- [ ] **Demo GIF** (30 sec): Show Claude delegating task → Comet browsing → results returned
- [ ] **GitHub README** with clear setup steps ✅
- [ ] **Architecture diagram** (simple ASCII is fine) ✅

### Nice to Have:
- [ ] **Video demo** (2-3 min YouTube)
- [ ] **Blog post**: "How I built comet-mcp" (technical deep-dive)
- [ ] **Comparison chart**: comet-mcp vs WebSearch vs WebFetch vs Puppeteer MCP

---

## Messaging Framework

### For Different Audiences:

**Claude Code Users:**
> "Give Claude Code real browsing superpowers. Research live sites, navigate dashboards, handle dynamic content."

**MCP Developers:**
> "An MCP server bridging Claude to Perplexity Comet via CDP. 6 tools: connect, ask, poll, stop, screenshot, mode."

**General Developers:**
> "Connect your AI assistant to an agentic browser. Delegate web research, monitor progress, get comprehensive results."

### Objection Handling:

**"Why not just use WebSearch?"**
> WebSearch returns static results. comet-mcp can navigate, click, fill forms, handle login walls, and do multi-step research on live sites.

**"Why Perplexity Comet specifically?"**
> Comet has built-in agentic browsing - it's not just a browser, it's an AI that knows how to research. We're connecting two AI systems (Claude + Perplexity) to get the best of both.

**"Is this secure?"**
> You control the browser. It runs locally. No credentials are sent through the MCP server.

---

## Launch Timeline

### Day -7 (Prep)
- [ ] Record demo GIF
- [ ] Verify npm package works via npx
- [ ] Test setup on fresh machine
- [ ] Submit to awesome-mcp-servers

### Day -1
- [ ] Draft all posts (HN, Reddit, Twitter)
- [ ] Prepare to respond quickly to comments

### Day 0 (Launch)
- Morning: Post on Hacker News (Show HN)
- Afternoon: Post on r/ClaudeAI
- Evening: Twitter thread

### Day +1 to +7
- [ ] Engage with all comments
- [ ] Post on r/LocalLLaMA, r/programming
- [ ] Share on LinkedIn
- [ ] Submit to mcpservers.org

---

## Success Metrics

- GitHub stars: 100+ in first week
- npm downloads: 500+ in first month
- HN: Front page (even briefly)
- Reddit: 50+ upvotes on r/ClaudeAI
- Twitter: 10k+ impressions on thread

---

## Key Learnings from Research

1. **Developers distrust marketing fluff** - Show, don't tell
2. **HN values clear titles** - Make it obvious what you built
3. **Link to GitHub** - Signals working code, open source, dev tool
4. **Engage authentically** - Respond to every comment like a human
5. **Solve real pain** - Not "nice to have" but "fundamentally different"
6. **MCP ecosystem is hot** - Get listed in directories early
7. **Demo > Description** - A 30-sec GIF is worth 1000 words
