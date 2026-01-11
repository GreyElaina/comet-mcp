import { z } from "zod";
import { UserError } from "fastmcp";
import type { FastMCP } from "fastmcp";
import { cometClient } from "../cdp-client.js";
import { cometAI } from "../comet-ai.js";
import { ensureConnectedToComet, toTextContent, parsePositiveInt } from "./shared.js";

const schema = z.object({
  prompt: z.string().describe(
    "Goal-oriented task description. Example: 'Research pricing of Auth0, Clerk, and Supabase Auth for B2B SaaS'"
  ),
  timeout: z.number().optional().describe(
    "Max wait in ms (default: 60000). For longer tasks, use blocking=false + comet_poll."
  ),
  newChat: z.boolean().optional().describe(
    "Start fresh conversation (default: false). Use when previous context is irrelevant."
  ),
  force: z.boolean().optional().describe(
    "Override busy check (default: false). Prefer comet_poll/comet_stop first."
  ),
  maxOutputChars: z.number().optional().describe(
    "Max response chars (default: 24000). If truncated, use comet_poll with offset to fetch more."
  ),
  tempChat: z.boolean().optional().describe(
    "Perplexity incognito mode (default: true). Set false to save to history."
  ),
  mode: z.enum(["search", "research", "studio"]).optional().describe(
    "Perplexity mode: search (fast), research (deep), studio (analytics). Default: current."
  ),
  model: z.string().optional().describe(
    "Model name substring, e.g. 'gpt-4o', 'claude-sonnet'. Only in search mode. Default: current."
  ),
  agentPolicy: z.enum(["exit", "continue"]).optional().describe(
    "If in agent/browse mode: 'exit' (default) returns to search, 'continue' keeps browsing."
  ),
  reasoning: z.boolean().optional().describe(
    "Enable extended thinking. Only search mode + supported models."
  ),
  attachments: z.array(z.string()).optional().describe(
    "File paths or file:// URIs. Supports: images, documents (pdf/docx/xlsx/pptx), code files, audio, video. Max 25MB each."
  ),
  blocking: z.boolean().optional().describe(
    "Wait for completion (default: true). Set false for async; use comet_poll for result."
  ),
  stripCitations: z.boolean().optional().describe(
    "Remove [1][2] markers from response (default: true)."
  ),
});

const description = `Send a prompt to Perplexity via Comet and wait for the response. Auto-connects if needed.

When to use:
- Real browser interaction needed (login walls, dynamic JS content, forms, buttons)
- Agentic web research (comparing sources, following links, multi-page analysis)
- Scraping live data from specific authenticated sites
- Analyzing files via attachments (images, PDF, text files)

When NOT to use:
- Simple factual queries -> use WebSearch
- Static public content -> use WebFetch
- "How to do X?" questions -> use WebSearch

Returns: Complete response text. If truncated (>maxOutputChars), use comet_poll with offset/limit to paginate.

Important behaviors:
- If task already running: returns error. Use comet_poll to monitor, comet_stop to cancel, or force=true to override.
- Prompts should be goal-oriented natural sentences, not step-by-step instructions or bullet points.`;

type CometAskArgs = z.infer<typeof schema>;

interface ExecuteContext {
  reportProgress: (params: { progress: number; total: number }) => Promise<void>;
}

export function registerCometAskTool(server: FastMCP) {
  server.addTool({
    name: "comet_ask",
    description,
    parameters: schema,
    execute: async (args: CometAskArgs, context: ExecuteContext) => {
      const { reportProgress } = context;

      await ensureConnectedToComet();

      // Validate prompt
      const prompt = String(args.prompt ?? "").trim();
      if (!prompt) {
        throw new UserError("prompt is required and cannot be empty");
      }

      const MAX_PROMPT_LENGTH = 50000;
      if (prompt.length > MAX_PROMPT_LENGTH) {
        throw new UserError(`prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
      }

      // Parse arguments
      const force = args.force === true;
      const maxOutputChars = parsePositiveInt(args.maxOutputChars) ?? 24000;
      const timeoutRaw = args.timeout;
      const timeoutParsed = typeof timeoutRaw === "number" ? timeoutRaw : Number(timeoutRaw);
      const timeout = Number.isFinite(timeoutParsed) && timeoutParsed > 0
        ? timeoutParsed
        : 60000; // Default 60 seconds
      const newChat = args.newChat || false;
      const tempChat = args.tempChat !== false;
      const mode = args.mode;
      const agentPolicy = args.agentPolicy || "exit";
      const reasoning = args.reasoning;
      const blocking = args.blocking !== false;
      const model = args.model;
      const stripCitations = args.stripCitations !== false;

      // Guard: don't accidentally start a new prompt while an agentic run is in-flight
      const preStatus = await cometAI.getAgentStatus();
      const isBusy = preStatus.status === "working" || preStatus.hasStopButton || preStatus.hasLoadingSpinner;
      if (!force && isBusy) {
        throw new UserError(
          "Comet appears to be busy with an in-flight task.\n\n" +
          "Use comet_poll to monitor progress, or comet_stop to cancel.\n" +
          "If you really want to send a new prompt anyway, call comet_ask with force=true."
        );
      }

      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

      let isAgentMode = await cometAI.isAgentMode();

      // Handle agent mode based on policy
      if (isAgentMode && agentPolicy === "exit") {
        console.error("[comet] Exiting agent mode...");
        await reportProgress({ progress: 2, total: 100 });
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

        // Switch mode if requested
        if (mode) {
          console.error(`[comet] Switching to ${mode} mode...`);
          await reportProgress({ progress: 3, total: 100 });
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

        // Handle tempChat (incognito mode)
        try {
          const forceCheckIncognito = newChat || !isOnPerplexity;
          const maxAgeMs = forceCheckIncognito ? 0 : 5 * 60 * 1000;
          console.error(
            forceCheckIncognito
              ? "[comet] Checking incognito mode..."
              : "[comet] Checking incognito mode (cached)..."
          );
          await reportProgress({ progress: 5, total: 100 });
          const res = await cometAI.ensureTemporaryChatEnabled(tempChat, { maxAgeMs });
          if (res.checked && res.changed) {
            console.error(tempChat ? "[comet] Enabling incognito mode..." : "[comet] Disabling incognito mode...");
            await reportProgress({ progress: 8, total: 100 });
          }
        } catch {
          // Best-effort only; continue with the prompt.
        }

        // Handle model switching
        const targetModel = model || cometAI.getDefaultModel();
        if (targetModel) {
          console.error(`[comet] Checking model: ${targetModel}...`);
          await reportProgress({ progress: 6, total: 100 });
          try {
            const modelResult = await cometAI.ensureModel(targetModel);
            if (modelResult.changed) {
              console.error(`[comet] Switched to model: ${modelResult.currentModel}`);
              await reportProgress({ progress: 7, total: 100 });
            } else if (modelResult.skipped) {
              console.error(`[comet] ensureModel skipped: ${modelResult.skipped}`);
            }
          } catch (e) {
            console.error(`[comet] ensureModel error:`, e);
          }
        }

        // Handle reasoning mode
        if (typeof reasoning === "boolean") {
          try {
            console.error(`[comet] Setting reasoning mode...`);
            await reportProgress({ progress: 9, total: 100 });
            const reasoningResult = await cometAI.setReasoning(reasoning);
            console.error(`[comet] setReasoning(${reasoning}):`, JSON.stringify(reasoningResult, null, 2));
          } catch (e) {
            console.error(`[comet] setReasoning error:`, e);
          }
        }
      } else {
        console.error("[comet] Continuing in agent mode...");
        await reportProgress({ progress: 5, total: 100 });
        const tabs = await cometClient.listTabsCategorized();
        if (tabs.sidecar) {
          await cometClient.connect(tabs.sidecar.id);
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      // Handle file attachments
      const attachments = args.attachments;
      if (attachments && attachments.length > 0) {
        console.error(`[comet] Uploading ${attachments.length} file(s)...`);
        await reportProgress({ progress: 10, total: 100 });
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
          throw new UserError(`File upload failed: ${uploadResult.errors.join(", ")}`);
        }
        if (uploadResult.errors.length > 0) {
          console.error(`[comet] Uploaded ${uploadResult.uploaded} file(s) with warnings: ${uploadResult.errors.join(", ")}`);
          await reportProgress({ progress: 15, total: 100 });
        } else {
          console.error(`[comet] Uploaded ${uploadResult.uploaded} file(s)`);
          await reportProgress({ progress: 15, total: 100 });
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      // Capture baseline before sending prompt
      const baselineStatus = await cometAI.getAgentStatus();
      const baselineLen = baselineStatus.latestResponseLength || baselineStatus.responseLength || 0;
      const baselinePageUrl = baselineStatus.pageUrl || "";
      const baselineTail =
        baselineStatus.latestResponseTail ||
        (baselineStatus.latestResponse || baselineStatus.response || "").slice(-4000);

      // Send the prompt
      await cometAI.sendPrompt(prompt);

      // Wait for completion with polling
      const startTime = Date.now();
      const progressLog: string[] = [];
      const seenSteps = new Set<string>();
      let lastUrl = '';
      let sawWorkingState = false;
      let lastResponseSignature = "";
      let stableResponseCount = 0;

      const log = (msg: string) => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const line = `[comet ${elapsed}s] ${msg}`;
        console.error(line);
        progressLog.push(line);
        void reportProgress({ progress: Date.now() - startTime, total: timeout }).catch(() => {});
      };

      log('Task started');

      while (Date.now() - startTime < timeout) {
        const elapsedMs = Date.now() - startTime;
        const pollMs = elapsedMs < 2500 ? 500 : elapsedMs < 8000 ? 1200 : 2000;
        await sleep(pollMs);

        const status = await cometAI.getAgentStatus();
        void reportProgress({
          progress: Date.now() - startTime,
          total: timeout,
        }).catch(() => {});

        const candidateLen = status.latestResponseLength || status.responseLength || 0;
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

        // Check for completion with fresh response
        if (
          status.status === "completed" &&
          (candidateLen > 0 || (status.latestResponse || status.response || "").length > 0) &&
          Date.now() - startTime > 800 &&
          (sawWorkingState || responseLooksNew)
        ) {
          log("Task completed");
          const markdown = await cometAI.getResponseMarkdown({ stripCitations });
          let output = markdown || "Task completed (no response text extracted)";
          if (output.length > maxOutputChars) {
            output = output.slice(0, maxOutputChars) +
              `\n\n[TRUNCATED: returned first ${maxOutputChars}/${output.length} chars. Use comet_poll offset=${maxOutputChars} limit=24000 to fetch more.]`;
          }
          return { content: toTextContent(output) };
        }

        // Log new steps we haven't seen
        for (const step of status.steps) {
          if (!seenSteps.has(step)) {
            seenSteps.add(step);
            log(`Step: ${step}`);
          }
        }

        // Log URL changes during agentic browsing
        if (status.agentBrowsingUrl && status.agentBrowsingUrl !== lastUrl) {
          lastUrl = status.agentBrowsingUrl;
          log(`Browsing: ${lastUrl}`);
        }

        // Track if task has actually started
        if (status.status === 'working' || status.hasStopButton || status.hasLoadingSpinner) {
          if (!sawWorkingState) {
            sawWorkingState = true;
            log('Task processing...');

            if (!blocking) {
              log('Task in progress (non-blocking)');
              return {
                content: [{
                  type: "text" as const,
                  text: `Task in progress (non-blocking mode).\n\nProgress:\n${progressLog.join('\n')}\n\nUse comet_poll to monitor and get the result when done.`,
                }],
              };
            }
          }
          if (status.currentStep && !progressLog[progressLog.length - 1]?.includes(status.currentStep)) {
            log(`Current: ${status.currentStep}`);
          }
        }

        // Fallback: stable response detection
        if (
          responseLooksNew &&
          stableResponseCount >= 3 &&
          !status.hasStopButton &&
          !status.hasLoadingSpinner
        ) {
          log('Task completed (stable response detected)');
          const markdown = await cometAI.getResponseMarkdown({ stripCitations });
          let output = markdown;
          if (output.length > maxOutputChars) {
            output = output.slice(0, maxOutputChars) +
              `\n\n[TRUNCATED: returned first ${maxOutputChars}/${output.length} chars. Use comet_poll offset=${maxOutputChars} limit=24000 to fetch more.]`;
          }
          return { content: toTextContent(output) };
        }

        // Handle completed status without seeing working state
        if (status.status === 'completed' && !sawWorkingState) {
          const elapsed = Date.now() - startTime;
          if (elapsed > 10000 && responseLooksNew) {
            log('Task completed (quick response)');
            const markdown = await cometAI.getResponseMarkdown({ stripCitations });
            let output = markdown || 'Task completed (no response text extracted)';
            if (output.length > maxOutputChars) {
              output = output.slice(0, maxOutputChars) +
                `\n\n[TRUNCATED: returned first ${maxOutputChars}/${output.length} chars. Use comet_poll offset=${maxOutputChars} limit=24000 to fetch more.]`;
            }
            return { content: toTextContent(output) };
          }
        }
      }

      log('Timeout');
      return {
        content: [{
          type: "text" as const,
          text: `Timeout after ${timeout / 1000}s.\n\nProgress:\n${progressLog.join('\n')}\n\nUse comet_poll to check if still working.`,
        }],
      };
    },
  });
}
