# Roadmap

## v2.1 - Multi-Session Support

### Problem
When multiple Claude Code instances call `comet_ask` simultaneously, requests go to the same Comet tab instead of separate conversations.

### Proposed Solution

**Option A: Auto New Tab**
- Each `comet_ask` opens a new Perplexity conversation
- `comet_poll` tracks which tab it's monitoring
- Pros: Simple, no API change
- Cons: Could create many tabs

**Option B: Session ID**
```typescript
comet_ask({
  prompt: "...",
  session_id: "project-a"  // optional
})
```
- Reuses existing tab if same session_id
- Creates new tab if new session_id
- Pros: More control
- Cons: API change

### Implementation Notes
- Need to track tab-to-session mapping in `cdp-client.ts`
- Store active sessions: `Map<session_id, tab_id>`
- On `comet_ask`: check if session exists, reuse or create
- On `comet_poll`: return results for specific session

---

## Future Ideas
- [ ] `comet_history` - Get conversation history
- [ ] `comet_export` - Export research as markdown
- [ ] Auto-reconnect improvements
- [ ] Support for Comet's file upload feature
