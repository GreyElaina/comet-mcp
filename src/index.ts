#!/usr/bin/env node

// Comet Browser MCP Server
// Claude Code ↔ Perplexity Comet bidirectional interaction
// Simplified to 6 essential tools

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { cometClient } from "./cdp-client.js";
import { cometAI } from "./comet-ai.js";

const chunkText = (text: string, chunkSize = 8000): string[] => {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
};

const toTextContent = (text: string) => {
  const chunks = chunkText(text);
  if (chunks.length === 1) return [{ type: "text" as const, text }];
  return chunks.map((chunk, index) => ({
    type: "text" as const,
    text: `[Part ${index + 1}/${chunks.length}]\n${chunk}`,
  }));
};

const parsePositiveInt = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
};

const TOOLS: Tool[] = [
  {
    name: "comet_connect",
    description:
      "Connect to Comet browser (auto-starts if needed). Optional: other tools auto-connect if needed. Warning: this may reset tabs/state (use comet_poll if a task is already running).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_ask",
    description: `Send a prompt to Comet/Perplexity and wait for the complete response (blocking). Auto-connects if needed.

IMPORTANT (in-flight tasks):
- If a previous Comet task is still running, DO NOT call comet_ask again (it will start a new prompt).
- Use comet_poll to monitor the existing task until it completes.
- Use comet_stop to cancel the current task if needed, then call comet_ask again.

WHEN TO USE COMET vs other tools:
- USE COMET for: tasks requiring real browser interaction (login walls, dynamic content, multi-step navigation, filling forms, clicking buttons, scraping live data from specific sites)
- USE COMET for: deep research that benefits from Perplexity's agentic browsing (comparing multiple sources, following links, comprehensive analysis)
- USE regular WebSearch/WebFetch for: simple factual queries, quick lookups, static content

IMPORTANT - Comet is for DOING, not just ASKING:
- DON'T ask "how to" questions → use WebSearch instead
- DO ask Comet to perform actions: "Go to X and do Y"
- Bad: "How do I generate a P8 key in App Store Connect?"
- Good: "Take over the browser, go to App Store Connect, navigate to In-App Purchase keys section"

PROMPTING TIPS:
- Give context and goals, not step-by-step instructions
- Example: "Research the pricing models of top 3 auth providers for a B2B SaaS" (good)
- Example: "Go to auth0.com, click pricing, then go to clerk.dev..." (less effective)
- Comet will figure out the best browsing strategy

FORMATTING WARNING:
- Write prompts as natural sentences, NOT bullet points or markdown
- Bad: "- Name: foo\\n- URL: bar" (newlines may be stripped, becomes confusing text)
- Good: "The name is foo and the URL is bar"`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question or task for Comet - focus on goals and context" },
        timeout: { type: "number", description: "Max server-side wait in ms (default: 60000 = 60s). Note: your MCP client may enforce a shorter request timeout; use comet_poll if the call returns early." },
        newChat: { type: "boolean", description: "Start a fresh conversation (default: false)" },
        force: { type: "boolean", description: "Force sending a new prompt even if Comet appears busy (default: false). Prefer comet_poll or comet_stop." },
        maxOutputChars: { type: "number", description: "Limit returned text length (chars). If truncated, use comet_poll with offset/limit to page (default: 24000)." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "comet_poll",
    description: "Check agent status and progress (does not start a new task). Call repeatedly to monitor an existing agentic task.",
    inputSchema: {
      type: "object",
      properties: {
        offset: { type: "number", description: "Response slice start (chars). Default: 0" },
        limit: { type: "number", description: "Response slice length (chars). Default: 24000" },
      },
    },
  },
  {
    name: "comet_debug",
    description: "Debug helper: shows current CDP connection state, relevant tabs, and extracted UI/status signals.",
    inputSchema: {
      type: "object",
      properties: {
        includeTargets: { type: "boolean", description: "Include raw /json/list targets (default: false)" },
        sliceOffset: { type: "number", description: "Response preview slice offset (default: 0)" },
        sliceLimit: { type: "number", description: "Response preview slice limit (default: 500)" },
      },
    },
  },
  {
    name: "comet_stop",
    description: "Stop the current agent task if it's going off track",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_screenshot",
    description: "Capture a screenshot of current page",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "comet_mode",
    description: "Switch Perplexity search mode. Modes: 'search' (basic), 'research' (deep research), 'labs' (analytics/visualization), 'learn' (educational). Call without mode to see current mode.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["search", "research", "labs", "learn"],
          description: "Mode to switch to (optional - omit to see current mode)",
        },
      },
    },
  },
  {
    name: "comet_models",
    description:
      "List available Perplexity models (best-effort; depends on account/UI). Use openMenu=true to actively open the model selector and scrape options.",
    inputSchema: {
      type: "object",
      properties: {
        openMenu: { type: "boolean", description: "Attempt to open model selector dropdown (default: false)" },
        includeRaw: { type: "boolean", description: "Include debug details (default: false)" },
      },
    },
  },
  {
    name: "comet_model",
    description:
      "Switch Perplexity model by name (best-effort; depends on account/UI). Use comet_models first to see available options.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Model name (case-insensitive substring match)" },
        includeRaw: { type: "boolean", description: "Include debug details (default: false)" },
      },
      required: ["name"],
    },
  },
  {
    name: "comet_temp_chat",
    description:
      "Inspect or toggle Perplexity temporary/private chat mode (best-effort; depends on account/UI). Call without enable to inspect.",
    inputSchema: {
      type: "object",
      properties: {
        enable: { type: "boolean", description: "Enable/disable temporary chat mode (omit to only inspect)" },
        includeRaw: { type: "boolean", description: "Include debug details (default: false)" },
      },
    },
  },
];

const server = new Server(
  { name: "comet-bridge", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  const progressToken = extra?._meta?.progressToken;
  const sendProgress = (message: string, progress: number, total?: number) => {
    if (progressToken === undefined) return;
    void extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, total, message },
    } as any).catch(() => {});
  };

  const ensureConnectedToComet = async (): Promise<string | null> => {
    const isUsableViewport = async (): Promise<boolean> => {
      try {
        const metrics = await cometClient.safeEvaluate(`(() => ({ w: window.innerWidth, h: window.innerHeight }))()`);
        const v = metrics?.result?.value as any;
        const w = Number(v?.w ?? 0);
        const h = Number(v?.h ?? 0);
        return Number.isFinite(w) && Number.isFinite(h) && w >= 200 && h >= 200;
      } catch {
        return false;
      }
    };

    if (cometClient.isConnected) {
      if (await isUsableViewport()) return null;
      // Sometimes CDP attaches to a hidden/prerendered Perplexity tab (0x0 viewport).
      // Reconnect to a visible page target in that case.
      try {
        await cometClient.disconnect();
      } catch {
        // ignore
      }
    }

    const startResult = await cometClient.startComet(9222);

    const targets = await cometClient.listTargets();
    const pageTabs = targets.filter((t) => t.type === "page");

    // Prefer an existing Perplexity tab if present; otherwise use any visible page.
    const candidateTabs = [
      ...pageTabs.filter((t) => t.url.includes("perplexity.ai") && !t.url.includes("sidecar")),
      ...pageTabs.filter((t) => t.url.includes("perplexity.ai")),
      ...pageTabs.filter((t) => t.url !== "about:blank"),
    ];

    const seen = new Set<string>();
    for (const tab of candidateTabs) {
      if (!tab?.id || seen.has(tab.id)) continue;
      seen.add(tab.id);
      try {
        await cometClient.connect(tab.id);
        await new Promise((r) => setTimeout(r, 150));
        if (await isUsableViewport()) return startResult;
      } catch {
        // Try the next tab
      }
    }

    // No tabs at all - create a new one
    const newTab = await cometClient.newTab("https://www.perplexity.ai/");
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for page load
    await cometClient.connect(newTab.id);
    return startResult;
  };

  try {
    switch (name) {
      case "comet_connect": {
        // Auto-start Comet with debug port (will restart if running without it)
        const startResult = await cometClient.startComet(9222);

        // Get all tabs and clean up - close all except one
        const targets = await cometClient.listTargets();
        const pageTabs = targets.filter(t => t.type === 'page');

        // Close extra tabs, keep only one
        if (pageTabs.length > 1) {
          for (let i = 1; i < pageTabs.length; i++) {
            try {
              await cometClient.closeTab(pageTabs[i].id);
            } catch { /* ignore */ }
          }
        }

        // Get fresh tab list
        const freshTargets = await cometClient.listTargets();
        const anyPage = freshTargets.find(t => t.type === 'page');

        if (anyPage) {
          await cometClient.connect(anyPage.id);
          // Always navigate to Perplexity home for clean state
          await cometClient.navigate("https://www.perplexity.ai/", true);
          await new Promise(resolve => setTimeout(resolve, 1500));
          return { content: [{ type: "text", text: `${startResult}\nConnected to Perplexity (cleaned ${pageTabs.length - 1} old tabs)` }] };
        }

        // No tabs at all - create a new one
        const newTab = await cometClient.newTab("https://www.perplexity.ai/");
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for page load
        await cometClient.connect(newTab.id);
        return { content: [{ type: "text", text: `${startResult}\nCreated new tab and navigated to Perplexity` }] };
      }

      case "comet_ask": {
        // Ensure CDP connection exists (mcporter may launch a fresh stdio process per call)
        await ensureConnectedToComet();

        const prompt = args?.prompt as string;
        const force = (args as any)?.force === true;
        const maxOutputChars = parsePositiveInt((args as any)?.maxOutputChars) ?? 24000;
        const timeoutRaw = (args as any)?.timeout;
        const timeoutParsed =
          typeof timeoutRaw === "number" ? timeoutRaw : Number(timeoutRaw);
        const timeout =
          Number.isFinite(timeoutParsed) && timeoutParsed > 0
            ? timeoutParsed
            : 60000; // Default 60 seconds (use comet_poll for long tasks)
        const newChat = (args?.newChat as boolean) || false;

        // Guard: don't accidentally start a new prompt while an agentic run is in-flight.
        const preStatus = await cometAI.getAgentStatus();
        if (!force && preStatus.status === "working") {
          return {
            content: [{
              type: "text",
              text:
                "Comet appears to be busy with an in-flight task.\n\n" +
                "Use comet_poll to monitor progress, or comet_stop to cancel.\n" +
                "If you really want to send a new prompt anyway, call comet_ask with force=true.",
            }],
            isError: true,
          };
        }

        const sleep = (ms: number) =>
          new Promise<void>((resolve) => {
            if (extra.signal.aborted) return resolve();
            const timer = setTimeout(resolve, ms);
            extra.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          });

        // Get fresh URL from browser (not cached state)
        const urlResult = await cometClient.evaluate('window.location.href');
        const currentUrl = urlResult.result.value as string;
        const isOnPerplexity = currentUrl?.includes('perplexity.ai');

        // Start fresh conversation if requested, or navigate if not on Perplexity
        if (newChat || !isOnPerplexity) {
          await cometClient.navigate("https://www.perplexity.ai/", true);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for page load
        }

        // Ensure "隐身" (incognito/temporary) mode is enabled if available.
        // This reduces interference with the user's normal Perplexity account history.
        // Policy:
        // - Force-check on newChat (or when we had to navigate back to Perplexity).
        // - Otherwise use a short TTL cache to avoid paying UI automation cost every call.
        try {
          const forceCheckIncognito = newChat || !isOnPerplexity;
          const maxAgeMs = forceCheckIncognito ? 0 : 5 * 60 * 1000;
          sendProgress(
            forceCheckIncognito
              ? "Checking incognito (隐身) mode…"
              : "Checking incognito (隐身) mode (cached)…",
            5,
            100
          );
          const res = await cometAI.ensureTemporaryChatEnabled(true, { maxAgeMs });
          if (res.checked && res.changed) {
            sendProgress("Enabling incognito (隐身) mode…", 8, 100);
          }
        } catch {
          // Best-effort only; continue with the prompt.
        }

        // Send the prompt
        const baselineStatus = await cometAI.getAgentStatus();
        const baselineLen = baselineStatus.latestResponseLength || baselineStatus.responseLength || 0;
        const baselinePageUrl = baselineStatus.pageUrl || "";
        const baselineTail =
          baselineStatus.latestResponseTail ||
          (baselineStatus.latestResponse || baselineStatus.response || "").slice(-4000);

        await cometAI.sendPrompt(prompt);

        // Wait for completion with polling - log progress to stderr in real-time
        const startTime = Date.now();
        const progressLog: string[] = [];
        const seenSteps = new Set<string>();
        let lastUrl = '';
        let sawWorkingState = false;  // Track if we've seen task actually start
        let lastResponseSignature = "";
        let stableResponseCount = 0;

        const log = (msg: string) => {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const line = `[comet ${elapsed}s] ${msg}`;
          console.error(line);  // stderr won't interfere with MCP protocol
          progressLog.push(line);
          sendProgress(line, Date.now() - startTime, timeout);
        };

        log('🚀 Task started');

        while (!extra.signal.aborted && Date.now() - startTime < timeout) {
          const elapsedMs = Date.now() - startTime;
          // Fast polling early so short queries return quickly; back off for long agent runs.
          const pollMs = elapsedMs < 2500 ? 500 : elapsedMs < 8000 ? 1200 : 2000;
          await sleep(pollMs);
          if (extra.signal.aborted) break;

          const status = await cometAI.getAgentStatus();
          sendProgress(
            `Polling... ${status.status}${status.currentStep ? ` (${status.currentStep})` : ""}`,
            Date.now() - startTime,
            timeout
          );

          const candidateLen =
            status.latestResponseLength || status.responseLength || 0;
          const candidateTail =
            status.latestResponseTail ||
            (status.latestResponse || status.response || "").slice(-4000);
          const responseLooksNew =
            candidateLen > 0 &&
            (candidateLen !== baselineLen ||
              candidateTail !== baselineTail ||
              (status.pageUrl && status.pageUrl !== baselinePageUrl));
          const signature = `${candidateLen}:${candidateTail}`;
          if (responseLooksNew) {
            if (signature === lastResponseSignature) stableResponseCount++;
            else stableResponseCount = 0;
            lastResponseSignature = signature;
          }

          // Since sendPrompt() throws if it can't submit, we can safely return a completed state
          // even if the text matches the previous response (e.g. repeating the same query).
          if (
            status.status === "completed" &&
            (candidateLen > 0 || (status.latestResponse || status.response || "").length > 0) &&
            Date.now() - startTime > 800
          ) {
            log("✅ Task completed");
            const { total, slice } = await cometAI.getLatestResponseSlice(0, maxOutputChars);
            let output =
              slice ||
              status.latestResponse ||
              status.response ||
              "Task completed (no response text extracted)";
            if (total > maxOutputChars) {
              output += `\n\n[TRUNCATED: returned first ${maxOutputChars}/${total} chars. Use comet_poll offset=${maxOutputChars} limit=24000 to fetch more.]`;
            }
            return { content: toTextContent(output) };
          }

          // Log new steps we haven't seen
          for (const step of status.steps) {
            if (!seenSteps.has(step)) {
              seenSteps.add(step);
              log(`📋 ${step}`);
            }
          }

          // Log URL changes during agentic browsing
          if (status.agentBrowsingUrl && status.agentBrowsingUrl !== lastUrl) {
            lastUrl = status.agentBrowsingUrl;
            log(`🌐 ${lastUrl}`);
          }

          // Track if task has actually started (working state).
          // Some UI variants may not report status correctly, so treat active controls/spinners as "working".
          if (status.status === 'working' || status.hasStopButton || status.hasLoadingSpinner) {
            if (!sawWorkingState) {
              sawWorkingState = true;
              log('⚙️ Task processing...');
            }
            if (status.currentStep && !progressLog[progressLog.length - 1]?.includes(status.currentStep)) {
              log(`⏳ ${status.currentStep}`);
            }
          }

          // Fallback: some clients/pages never flip to "completed" reliably.
          // If the latest response text is stable and loading has stopped, treat as complete.
          if (
            responseLooksNew &&
            stableResponseCount >= 3 &&
            !status.hasStopButton &&
            !status.hasLoadingSpinner
          ) {
            log('✅ Task completed (stable response detected)');
            const { total, slice } = await cometAI.getLatestResponseSlice(0, maxOutputChars);
            let output = slice;
            if (total > maxOutputChars) {
              output += `\n\n[TRUNCATED: returned first ${maxOutputChars}/${total} chars. Use comet_poll offset=${maxOutputChars} limit=24000 to fetch more.]`;
            }
            return { content: toTextContent(output) };
          }

          // If still showing "completed" but we haven't seen "working" yet,
          // it's likely the old response - wait for the new task to start.
          if (status.status === 'completed' && !sawWorkingState) {
            // Check if it's been too long without seeing working state (maybe simple query)
            const elapsed = Date.now() - startTime;
            if (elapsed > 10000 && responseLooksNew) {
              // After 10s, if still showing completed, accept it
              log('✅ Task completed (quick response)');
              const { total, slice } = await cometAI.getLatestResponseSlice(0, maxOutputChars);
              let output = slice || status.latestResponse || status.response || 'Task completed (no response text extracted)';
              if (total > maxOutputChars) {
                output += `\n\n[TRUNCATED: returned first ${maxOutputChars}/${total} chars. Use comet_poll offset=${maxOutputChars} limit=24000 to fetch more.]`;
              }
              return { content: toTextContent(output) };
            }
          }
        }

        if (extra.signal.aborted) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          log("🛑 Request cancelled by client");
          return {
            content: [{
              type: "text",
              text: `Request was cancelled after ${elapsed}s (client-side timeout/cancel).\n\nThe Comet agent may still be working.\nUse comet_poll to check status and retrieve the result.`,
            }],
            isError: true,
          };
        }

        // Timeout
        log('⏰ Timeout');
        return {
          content: [{
            type: "text",
            text: `Timeout after ${timeout/1000}s.\n\nProgress:\n${progressLog.join('\n')}\n\nUse comet_poll to check if still working.`,
          }],
        };
      }

      case "comet_temp_chat": {
        await ensureConnectedToComet();
        const enable = (args as any)?.enable;
        const includeRaw = (args as any)?.includeRaw === true;

        if (typeof enable !== "boolean") {
          const info = await cometAI.inspectTemporaryChat({ includeRaw });
          const lines = [
            `Detected: ${info.detected ? "yes" : "no"}`,
            `Enabled: ${info.enabled === null ? "(unknown)" : info.enabled ? "yes" : "no"}`,
          ];
          if (includeRaw && info.debug) {
            lines.push("", "--- Debug ---", JSON.stringify(info.debug, null, 2));
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        const res = await cometAI.setTemporaryChatEnabled(enable, { includeRaw });
        const lines = [
          `Requested: ${enable ? "enable" : "disable"}`,
          `Attempted: ${res.attempted ? "yes" : "no"}`,
          `Changed: ${res.changed ? "yes" : "no"}`,
          `Before: ${res.before.enabled === null ? "(unknown)" : res.before.enabled ? "enabled" : "disabled"}`,
          `After: ${res.after.enabled === null ? "(unknown)" : res.after.enabled ? "enabled" : "disabled"}`,
        ];
        if (includeRaw && res.debug) {
          lines.push("", "--- Debug ---", JSON.stringify(res.debug, null, 2));
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "comet_poll": {
        await ensureConnectedToComet();
        const offsetRaw = (args as any)?.offset;
        const offset = (Number.isFinite(Number(offsetRaw)) && Number(offsetRaw) >= 0)
          ? Math.trunc(Number(offsetRaw))
          : 0;
        const limit = parsePositiveInt((args as any)?.limit) ?? 24000;
        const status = await cometAI.getAgentStatus();
        let output = `Status: ${status.status.toUpperCase()}\n`;

        if (status.agentBrowsingUrl) {
          output += `Browsing: ${status.agentBrowsingUrl}\n`;
        }

        if (status.steps.length > 0) {
          output += `\nRecent steps:\n${status.steps.map(s => `  • ${s}`).join('\n')}\n`;
        }

        if (status.currentStep && status.status === 'working') {
          output += `\nCurrent: ${status.currentStep}\n`;
        }

        if (status.status === 'completed') {
          const { total, slice } = await cometAI.getLatestResponseSlice(offset, limit);
          if (slice) {
            const start = Math.min(offset, total);
            const end = Math.min(start + limit, total);
            const more = end < total;
            const header =
              `${output}\n--- Response ---\n` +
              `[Slice ${start}-${end} of ${total} chars${more ? `; next offset=${end}` : ""}]\n`;
            return { content: [{ type: "text", text: header }, ...toTextContent(slice)] };
          }
        } else if (status.status === 'working' && status.hasStopButton) {
          output += `\n[Agent is working - use comet_stop to interrupt if needed]`;
        }

        return { content: [{ type: "text", text: output }] };
      }

      case "comet_stop": {
        await ensureConnectedToComet();
        const stopped = await cometAI.stopAgent();
        return {
          content: [{
            type: "text",
            text: stopped ? "Agent stopped" : "No active agent to stop",
          }],
        };
      }

      case "comet_screenshot": {
        await ensureConnectedToComet();
        const result = await cometClient.screenshot("png");
        return {
          content: [{ type: "image", data: result.data, mimeType: "image/png" }],
        };
      }

      case "comet_mode": {
        await ensureConnectedToComet();
        const mode = args?.mode as string | undefined;

        // If no mode provided, show current mode
        if (!mode) {
          const result = await cometClient.evaluate(`
            (() => {
              // Try button group first (wide screen)
              const modes = ['Search', 'Research', 'Labs', 'Learn'];
              for (const mode of modes) {
                const btn = document.querySelector('button[aria-label="' + mode + '"]');
                if (btn && btn.getAttribute('data-state') === 'checked') {
                  return mode.toLowerCase();
                }
              }
              // Try dropdown (narrow screen) - look for the mode selector button
              const dropdownBtn = document.querySelector('button[class*="gap"]');
              if (dropdownBtn) {
                const text = dropdownBtn.innerText.toLowerCase();
                if (text.includes('search')) return 'search';
                if (text.includes('research')) return 'research';
                if (text.includes('labs')) return 'labs';
                if (text.includes('learn')) return 'learn';
              }
              return 'search';
            })()
          `);

          const currentMode = result.result.value as string;
          const descriptions: Record<string, string> = {
            search: 'Basic web search',
            research: 'Deep research with comprehensive analysis',
            labs: 'Analytics, visualizations, and coding',
            learn: 'Educational content and explanations'
          };

          let output = `Current mode: ${currentMode}\n\nAvailable modes:\n`;
          for (const [m, desc] of Object.entries(descriptions)) {
            const marker = m === currentMode ? "→" : " ";
            output += `${marker} ${m}: ${desc}\n`;
          }

          return { content: [{ type: "text", text: output }] };
        }

        // Switch mode
        const modeMap: Record<string, string> = {
          search: "Search",
          research: "Research",
          labs: "Labs",
          learn: "Learn",
        };
        const ariaLabel = modeMap[mode];
        if (!ariaLabel) {
          return {
            content: [{ type: "text", text: `Invalid mode: ${mode}. Use: search, research, labs, learn` }],
            isError: true,
          };
        }

        // Navigate to Perplexity first if not there
        const state = cometClient.currentState;
        if (!state.currentUrl?.includes("perplexity.ai")) {
          await cometClient.navigate("https://www.perplexity.ai/", true);
        }

        // Try both UI patterns: button group (wide) and dropdown (narrow)
        const result = await cometClient.evaluate(`
          (() => {
            // Strategy 1: Direct button (wide screen)
            const btn = document.querySelector('button[aria-label="${ariaLabel}"]');
            if (btn) {
              btn.click();
              return { success: true, method: 'button' };
            }

            // Strategy 2: Dropdown menu (narrow screen)
            // Find and click the dropdown trigger (button with current mode text)
            const allButtons = document.querySelectorAll('button');
            for (const b of allButtons) {
              const text = b.innerText.toLowerCase();
              if ((text.includes('search') || text.includes('research') ||
                   text.includes('labs') || text.includes('learn')) &&
                  b.querySelector('svg')) {
                b.click();
                return { success: true, method: 'dropdown-open', needsSelect: true };
              }
            }

            return { success: false, error: "Mode selector not found" };
          })()
        `);

        const clickResult = result.result.value as { success: boolean; method?: string; needsSelect?: boolean; error?: string };

        if (clickResult.success && clickResult.needsSelect) {
          // Wait for dropdown to open, then select the mode
          await new Promise(resolve => setTimeout(resolve, 300));
          const selectResult = await cometClient.evaluate(`
            (() => {
              // Look for dropdown menu items
              const items = document.querySelectorAll('[role="menuitem"], [role="option"], button');
              for (const item of items) {
                if (item.innerText.toLowerCase().includes('${mode}')) {
                  item.click();
                  return { success: true };
                }
              }
              return { success: false, error: "Mode option not found in dropdown" };
            })()
          `);
          const selectRes = selectResult.result.value as { success: boolean; error?: string };
          if (selectRes.success) {
            return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
          } else {
            return { content: [{ type: "text", text: `Failed: ${selectRes.error}` }], isError: true };
          }
        }

        if (clickResult.success) {
          return { content: [{ type: "text", text: `Switched to ${mode} mode` }] };
        } else {
          return {
            content: [{ type: "text", text: `Failed to switch mode: ${clickResult.error}` }],
            isError: true,
          };
        }
      }

      case "comet_models": {
        await ensureConnectedToComet();
        const openMenu = (args as any)?.openMenu === true;
        const includeRaw = (args as any)?.includeRaw === true;

        const info = await cometAI.getModelInfo({ openMenu, includeRaw });
        const lines = [
          `Current model: ${info.currentModel ?? "(unknown)"}`,
          `Supports switching: ${info.supportsModelSwitching ? "yes" : "no"}`,
          "",
          "Available models:",
          ...(info.availableModels.length
            ? info.availableModels.map((m) => `- ${m}`)
            : ["- (none detected)"]),
        ];

        if (includeRaw && info.debug) {
          lines.push("", "--- Debug ---", JSON.stringify(info.debug, null, 2));
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "comet_model": {
        await ensureConnectedToComet();
        const name = String((args as any)?.name ?? "");
        const includeRaw = (args as any)?.includeRaw === true;

        const res = await cometAI.setModel(name);
        const lines = [
          `Requested: ${name}`,
          `Changed: ${res.changed ? "yes" : "no"}`,
          `Current model: ${res.currentModel ?? "(unknown)"}`,
          "",
          "Available models (best-effort):",
          ...(res.availableModels.length
            ? res.availableModels.map((m) => `- ${m}`)
            : ["- (none detected)"]),
        ];

        if (includeRaw && res.debug) {
          lines.push("", "--- Debug ---", JSON.stringify(res.debug, null, 2));
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "comet_debug": {
        await ensureConnectedToComet();
        const includeTargets = (args as any)?.includeTargets === true;
        const sliceOffsetRaw = (args as any)?.sliceOffset;
        const sliceOffset =
          Number.isFinite(Number(sliceOffsetRaw)) && Number(sliceOffsetRaw) >= 0
            ? Math.trunc(Number(sliceOffsetRaw))
            : 0;
        const sliceLimit = parsePositiveInt((args as any)?.sliceLimit) ?? 500;

        const state = cometClient.currentState;
        const status = await cometAI.getAgentStatus();
        const iface = await cometAI.inspectInterface();
        const tabs = await cometClient.listTabsCategorized().catch(() => null);
        const targets = includeTargets ? await cometClient.listTargets().catch(() => []) : undefined;
        const responsePreview = await cometAI.getLatestResponseSlice(sliceOffset, sliceLimit);

        const debug = {
          state,
          tabs,
          interface: iface,
          status,
          responsePreview: { offset: sliceOffset, limit: sliceLimit, ...responsePreview },
          targets,
        };

        return { content: [{ type: "text", text: JSON.stringify(debug, null, 2) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : error}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport);
