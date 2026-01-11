#!/usr/bin/env node

// Comet Browser MCP Server
// Claude Code ↔ Perplexity Comet bidirectional interaction
// Simplified to 6 essential tools

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
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

const SCREENSHOT_DIR = path.join(os.tmpdir(), "comet-mcp", "screenshots");
const SCREENSHOT_TTL_MS = (() => {
  const parsed = Number(process.env.COMET_SCREENSHOT_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
})();
const SCREENSHOT_MAX_ENTRIES = (() => {
  const parsed = Number(process.env.COMET_SCREENSHOT_MAX ?? "20");
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 20;
})();
const SCREENSHOT_URI_PREFIX = "comet://screenshots";

interface ScreenshotResourceEntry {
  uri: string;
  path: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  createdAt: number;
  size: number;
}

const screenshotResources = new Map<string, ScreenshotResourceEntry>();
let screenshotDirReady = false;

const ensureScreenshotDir = async () => {
  if (screenshotDirReady) return;
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  screenshotDirReady = true;
};

const removeScreenshotEntry = async (entry: ScreenshotResourceEntry) => {
  screenshotResources.delete(entry.uri);
  try {
    await fs.unlink(entry.path);
  } catch {}
};

const pruneScreenshotResources = async (): Promise<boolean> => {
  await ensureScreenshotDir();
  const now = Date.now();
  const existing = Array.from(screenshotResources.values());
  const toRemove = new Map<string, ScreenshotResourceEntry>();

  for (const entry of existing) {
    if (now - entry.createdAt > SCREENSHOT_TTL_MS) {
      toRemove.set(entry.uri, entry);
      continue;
    }
    try {
      await fs.access(entry.path);
    } catch {
      toRemove.set(entry.uri, entry);
    }
  }

  const survivors = existing
    .filter((entry) => !toRemove.has(entry.uri))
    .sort((a, b) => a.createdAt - b.createdAt);

  while (survivors.length > SCREENSHOT_MAX_ENTRIES) {
    const entry = survivors.shift();
    if (entry) {
      toRemove.set(entry.uri, entry);
    }
  }

  if (!toRemove.size) return false;

  await Promise.all([...toRemove.values()].map((entry) => removeScreenshotEntry(entry)));
  return true;
};

const toResourceDescriptor = (entry: ScreenshotResourceEntry) => ({
  name: entry.name,
  title: entry.title,
  uri: entry.uri,
  description: entry.description,
  mimeType: entry.mimeType,
  annotations: {
    lastModified: new Date(entry.createdAt).toISOString(),
  },
});

const listScreenshotResourceDescriptors = () => {
  return Array.from(screenshotResources.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toResourceDescriptor);
};

const toResourceLink = (entry: ScreenshotResourceEntry) => ({
  type: "resource_link" as const,
  ...toResourceDescriptor(entry),
});

const saveScreenshotResource = async (
  base64Data: string,
  mimeType: string
): Promise<ScreenshotResourceEntry> => {
  await ensureScreenshotDir();
  const buffer = Buffer.from(base64Data, "base64");
  const timestamp = Date.now();
  const extension = mimeType === "image/jpeg" ? "jpg" : "png";
  const fileName = `screenshot-${timestamp}-${randomUUID()}.${extension}`;
  const filePath = path.join(SCREENSHOT_DIR, fileName);
  await fs.writeFile(filePath, buffer);

  const entry: ScreenshotResourceEntry = {
    uri: `${SCREENSHOT_URI_PREFIX}/${fileName}`,
    path: filePath,
    name: fileName,
    title: "Comet Screenshot",
    description: `Screenshot captured at ${new Date(timestamp).toISOString()}`,
    mimeType,
    createdAt: timestamp,
    size: buffer.length,
  };

  screenshotResources.set(entry.uri, entry);
  return entry;
};

const getScreenshotEntry = (uri: string) => screenshotResources.get(uri);

const readScreenshotBlob = async (entry: ScreenshotResourceEntry) => {
  const data = await fs.readFile(entry.path);
  return data.toString("base64");
};

const TOOLS: Tool[] = [
  {
    name: "comet_reset",
    description:
      "Reset Comet to clean state: closes extra tabs, navigates to Perplexity home, returns current state (mode, model, defaultModel). Use when Comet is in a bad state or before starting fresh.",
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
        tempChat: { type: "boolean", description: "Enable/disable Perplexity temporary/private chat mode (default: true). Set to false to disable incognito mode." },
        mode: { type: "string", enum: ["search", "research", "studio"], description: "Perplexity mode: 'search' (basic), 'research' (deep), 'studio' (labs/analytics). If omitted, uses current mode." },
        model: { type: "string", description: "Perplexity model to use (e.g. 'gpt-4o', 'claude-sonnet'). Only works in search mode. If omitted, uses current model." },
        agentPolicy: { type: "string", enum: ["exit", "continue"], description: "Behavior when in agent mode (browsing a website): 'exit' (default) exits agent mode and returns to search, 'continue' sends prompt to sidecar to continue browsing." },
        reasoning: { type: "boolean", description: "Enable/disable reasoning mode (带着推理). Only available in search mode with certain models." },
        attachments: { type: "array", items: { type: "string" }, description: "File paths or file:// URIs to attach (supports: png, jpg, gif, webp, pdf, txt, csv, md). Max 25MB per file." },
        blocking: { type: "boolean", description: "If true (default), wait until completion or timeout. If false, return immediately once task starts - use comet_poll to get result later." },
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
        includeSettings: { type: "boolean", description: "Include current session settings (mode, tempChat, model). Default: false" },
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
    name: "comet_list_models",
    description:
      "List available Perplexity models (best-effort; depends on account/UI). Use openMenu=true to actively open the model selector and scrape options.",
    inputSchema: {
      type: "object",
      properties: {
        openMenu: { type: "boolean", description: "Attempt to open model selector dropdown (default: false)" },
        inspectAllReasoning: { type: "boolean", description: "Check reasoning support for each model (slow, implies openMenu=true)" },
        includeRaw: { type: "boolean", description: "Include debug details (default: false)" },
      },
    },
  },
  {
    name: "comet_set_model",
    description:
      "Set default Perplexity model for subsequent comet_ask calls. Model will be switched automatically when needed. Use comet_list_models to see available options. Call with empty name to clear default.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Model name (case-insensitive substring match). Empty to clear." },
      },
    },
  },
];

const server = new Server(
  { name: "comet-bridge", version: "2.0.0" },
  { capabilities: { tools: {}, resources: { listChanged: true } } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  await pruneScreenshotResources();
  return { resources: listScreenshotResourceDescriptors() };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  await pruneScreenshotResources();
  const uri = request.params.uri;
  const entry = getScreenshotEntry(uri);
  if (!entry) {
    throw new Error(`Resource not found: ${uri}`);
  }
  try {
    const blob = await readScreenshotBlob(entry);
    return {
      contents: [
        {
          uri: entry.uri,
          mimeType: entry.mimeType,
          blob,
        },
      ],
    };
  } catch (error) {
    await removeScreenshotEntry(entry);
    throw new Error(
      `Failed to read resource ${uri}: ${error instanceof Error ? error.message : error}`
    );
  }
});

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

    const startResult = await cometClient.startComet();

    const targets = await cometClient.listTargets();
    const pageTabs = targets.filter((t) => t.type === "page");

    const candidateTabs = [
      ...pageTabs.filter((t) => t.url.includes("perplexity.ai") && !t.url.includes("sidecar")),
      ...pageTabs.filter((t) => t.url.includes("perplexity.ai")),
      ...pageTabs.filter((t) => t.url !== "about:blank" && !t.url.startsWith("chrome://")),
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
      case "comet_reset": {
        // Auto-start Comet with debug port (will restart if running without it)
        const startResult = await cometClient.startComet();

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
          await cometClient.navigate("https://www.perplexity.ai/", true);
          await new Promise(resolve => setTimeout(resolve, 1500));
        } else {
          const newTab = await cometClient.newTab("https://www.perplexity.ai/");
          await new Promise(resolve => setTimeout(resolve, 2000));
          await cometClient.connect(newTab.id);
        }

        const [uiMode, modelInfo] = await Promise.all([
          cometAI.getPerplexityUIMode().catch(() => null),
          cometAI.getModelInfo({ openMenu: false }).catch(() => null),
        ]);

        const info = {
          status: "connected",
          mode: uiMode || "unknown",
          model: modelInfo?.currentModel || "unknown",
          defaultModel: cometAI.getDefaultModel(),
          tabsCleaned: pageTabs.length > 1 ? pageTabs.length - 1 : 0,
        };

        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }

      case "comet_ask": {
        await ensureConnectedToComet();

        const prompt = String(args?.prompt ?? "").trim();
        if (!prompt) {
          return {
            content: [{ type: "text", text: "Error: prompt is required and cannot be empty" }],
            isError: true,
          };
        }
        const MAX_PROMPT_LENGTH = 50000;
        if (prompt.length > MAX_PROMPT_LENGTH) {
          return {
            content: [{ type: "text", text: `Error: prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters` }],
            isError: true,
          };
        }
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
        const tempChat = (args as any)?.tempChat !== false;
        const mode = (args as any)?.mode as string | undefined;
        const agentPolicy = ((args as any)?.agentPolicy as string) || "exit";
        const reasoning = (args as any)?.reasoning as boolean | undefined;
        const blocking = (args as any)?.blocking !== false;
        const model = (args as any)?.model as string | undefined;

        // Guard: don't accidentally start a new prompt while an agentic run is in-flight.
        const preStatus = await cometAI.getAgentStatus();
        const isBusy = preStatus.status === "working" || preStatus.hasStopButton || preStatus.hasLoadingSpinner;
        if (!force && isBusy) {
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

        let isAgentMode = await cometAI.isAgentMode();

        if (isAgentMode && agentPolicy === "exit") {
          sendProgress("Exiting agent mode…", 2, 100);
          await cometAI.exitAgentMode();
          isAgentMode = false;
        }

        if (!isAgentMode) {
          const urlResult = await cometClient.safeEvaluate('window.location.href');
          const currentUrl = urlResult.result.value as string;
          const isOnPerplexity = currentUrl?.includes('perplexity.ai');

          const wantsModelSwitch = (model || cometAI.getDefaultModel()) && (!mode || mode === "search");
          if (newChat || !isOnPerplexity || wantsModelSwitch) {
            await cometClient.navigate("https://www.perplexity.ai/", true);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }

          if (mode) {
            sendProgress(`Switching to ${mode} mode…`, 3, 100);
            await cometClient.safeEvaluate(`
              (() => {
                const radio = document.querySelector('button[role="radio"][value="${mode}"]');
                if (radio && radio.getAttribute('aria-checked') !== 'true') {
                  radio.click();
                  return true;
                }
                return false;
              })()
            `);
            await new Promise(resolve => setTimeout(resolve, 300));
          }

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
            const res = await cometAI.ensureTemporaryChatEnabled(tempChat, { maxAgeMs });
            if (res.checked && res.changed) {
              sendProgress(tempChat ? "Enabling incognito (隐身) mode…" : "Disabling incognito (隐身) mode…", 8, 100);
            }
          } catch {
            // Best-effort only; continue with the prompt.
          }

          const targetModel = model || cometAI.getDefaultModel();
          if (targetModel) {
            sendProgress(`Checking model: ${targetModel}…`, 6, 100);
            try {
              const modelResult = await cometAI.ensureModel(targetModel);
              if (modelResult.changed) {
                sendProgress(`Switched to model: ${modelResult.currentModel}`, 7, 100);
              } else if (modelResult.skipped) {
                console.error(`[comet] ensureModel skipped: ${modelResult.skipped}`);
              }
            } catch (e) {
              console.error(`[comet] ensureModel error:`, e);
            }
          }

          if (typeof reasoning === "boolean") {
            try {
              sendProgress(`Setting reasoning mode…`, 9, 100);
              const reasoningResult = await cometAI.setReasoning(reasoning);
              console.error(`[comet] setReasoning(${reasoning}):`, JSON.stringify(reasoningResult, null, 2));
            } catch (e) {
              console.error(`[comet] setReasoning error:`, e);
            }
          }
        } else {
          sendProgress("Continuing in agent mode…", 5, 100);
          const tabs = await cometClient.listTabsCategorized();
          if (tabs.sidecar) {
            await cometClient.connect(tabs.sidecar.id);
            await new Promise((r) => setTimeout(r, 300));
          }
        }

        const attachments = (args as { attachments?: string[] })?.attachments;
        if (attachments && attachments.length > 0) {
          sendProgress(`Uploading ${attachments.length} file(s)…`, 10, 100);
          const filePaths = attachments.map((a) => {
            if (a.startsWith("file://")) {
              try {
                return decodeURIComponent(new URL(a).pathname);
              } catch {
                return a.replace(/^file:\/\/(localhost)?/, "");
              }
            }
            return a;
          });
          const uploadResult = await cometAI.uploadFiles(filePaths);
          if (!uploadResult.success) {
            return {
              content: [{
                type: "text",
                text: `File upload failed: ${uploadResult.errors.join(", ")}`,
              }],
              isError: true,
            };
          }
          if (uploadResult.errors.length > 0) {
            sendProgress(`Uploaded ${uploadResult.uploaded} file(s) with warnings: ${uploadResult.errors.join(", ")}`, 15, 100);
          } else {
            sendProgress(`Uploaded ${uploadResult.uploaded} file(s)`, 15, 100);
          }
          await new Promise((r) => setTimeout(r, 500));
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

          // Only return completed if we've seen the task actually start (working state)
          // or the response looks different from baseline
          if (
            status.status === "completed" &&
            (candidateLen > 0 || (status.latestResponse || status.response || "").length > 0) &&
            Date.now() - startTime > 800 &&
            (sawWorkingState || responseLooksNew)
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

              if (!blocking) {
                log('⏳ Task in progress (non-blocking)');
                return {
                  content: [{
                    type: "text",
                    text: `Task in progress (non-blocking mode).\n\nProgress:\n${progressLog.join('\n')}\n\nUse comet_poll to monitor and get the result when done.`,
                  }],
                };
              }
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

        log('⏰ Timeout');
        return {
          content: [{
            type: "text",
            text: `Timeout after ${timeout/1000}s.\n\nProgress:\n${progressLog.join('\n')}\n\nUse comet_poll to check if still working.`,
          }],
        };
      }

      case "comet_poll": {
        await ensureConnectedToComet();
        const offsetRaw = (args as any)?.offset;
        const offset = (Number.isFinite(Number(offsetRaw)) && Number(offsetRaw) >= 0)
          ? Math.trunc(Number(offsetRaw))
          : 0;
        const limit = parsePositiveInt((args as any)?.limit) ?? 24000;
        const includeSettings = !!(args as any)?.includeSettings;
        const status = await cometAI.getAgentStatus();
        let output = `Status: ${status.status.toUpperCase()}\n`;

        if (includeSettings) {
          const modeResult = await cometClient.safeEvaluate(`
            (() => {
              const checked = document.querySelector('button[role="radio"][aria-checked="true"]');
              if (checked) return checked.getAttribute('value') || 'search';
              return 'search';
            })()
          `);
          const currentMode = modeResult.result.value as string;
          const tempChatInfo = await cometAI.inspectTemporaryChat();
          const modelInfo = await cometAI.getModelInfo({ openMenu: false });

          const reasoningInfo = await cometAI.inspectReasoning();

          output += `\n--- Settings ---\n`;
          output += `Mode: ${currentMode}\n`;
          output += `TempChat: ${tempChatInfo.enabled === null ? "(unknown)" : tempChatInfo.enabled ? "enabled" : "disabled"}\n`;
          output += `Model: ${modelInfo.currentModel ?? "(unknown)"}\n`;
          output += `Reasoning: ${reasoningInfo.detected ? (reasoningInfo.enabled ? "enabled" : "disabled") : "(not available)"}\n`;
        }

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
        await pruneScreenshotResources();
        const result = await cometClient.screenshot("png");
        const entry = await saveScreenshotResource(result.data, "image/png");
        void server.sendResourceListChanged().catch(() => {});
        const kb = (entry.size / 1024).toFixed(1);
        const text = [
          `Saved screenshot to ${entry.uri}`,
          `Size: ${kb} KB`,
          `Captured at ${new Date(entry.createdAt).toISOString()}`,
          "Use resources/read with this URI to download the file.",
        ].join("\n");
        return {
          content: [
            { type: "text", text },
            toResourceLink(entry),
          ],
        };
      }

      case "comet_list_models": {
        await ensureConnectedToComet();
        const openMenu = !!(args as any)?.openMenu;
        const inspectAllReasoning = !!(args as any)?.inspectAllReasoning;
        const includeRaw = !!(args as any)?.includeRaw;

        const info = await cometAI.getModelInfo({ openMenu, inspectAllReasoning, includeRaw });
        const reasoningStatus = info.reasoningAvailable
          ? (info.reasoningEnabled ? "enabled" : "disabled")
          : "not available";
        const lines = [
          `Mode: ${info.mode}`,
          `Current model: ${info.currentModel ?? "(unknown)"}`,
          `Reasoning: ${reasoningStatus}`,
          `Supports switching: ${info.supportsModelSwitching ? "yes" : "no"}`,
          "",
          "Available models:",
        ];

        if (info.modelReasoningSupport) {
          for (const m of info.availableModels) {
            const support = info.modelReasoningSupport[m] ?? "unknown";
            const tag = support === "available" ? "[R]" : support === "disabled" ? "[r]" : "";
            lines.push(`- ${m} ${tag}`.trim());
          }
          lines.push("", "[R] = reasoning available, [r] = reasoning disabled");
        } else if (info.availableModels.length) {
          lines.push(...info.availableModels.map((m) => `- ${m}`));
        } else {
          lines.push("- (none detected)");
        }

        if (info.mode === "agent") {
          lines.push("", "Note: Model switching is not available in agent mode. Use search mode instead.");
        }

        if (includeRaw) {
          lines.push("", "--- Debug ---", JSON.stringify(info.debug ?? { error: "debug is undefined" }, null, 2));
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "comet_set_model": {
        const name = String((args as any)?.name ?? "").trim();
        const previous = cometAI.getDefaultModel();
        cometAI.setDefaultModel(name || null);

        const lines = [
          `Default model ${name ? "set" : "cleared"}`,
          `Previous: ${previous ?? "(none)"}`,
          `Current: ${cometAI.getDefaultModel() ?? "(none)"}`,
          "",
          "Note: Model will be switched on next comet_ask if needed.",
        ];

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
