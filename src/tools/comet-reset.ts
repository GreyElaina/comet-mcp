import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { cometClient, OperationTimeoutError } from "../cdp-client.js";
import { CometAI } from "../comet-ai.js";
import { resetState } from "../concurrency/reset-state.js";
import { sessionManager, PERPLEXITY_URL } from "../session-manager.js";

const schema = z.object({
  hard: z.boolean().optional().describe(
    "If true, destroy ALL sessions. If false (default), sync sessions with browser (remove orphaned)."
  ),
});

const description = `Reset Comet to clean state: closes extra tabs, navigates to Perplexity home, cleans up sessions (hard=destroy all, soft=remove orphaned), returns current state (mode, model, defaultModel, session counts). Use when Comet is in a bad state or before starting fresh.`;

export function registerCometResetTool(server: FastMCP) {
  server.addTool({
    name: "comet_reset",
    description,
    parameters: schema,
    execute: async (args) => {
      if (resetState.isResetting()) {
        return JSON.stringify({ status: "already_resetting" }, null, 2);
      }

      resetState.beginReset();

      let phase = "preSync";
      const failedOps: Array<{ op: string; targetId?: string; error: string }> = [];
      const hard = args.hard === true;
      const sessionsBefore = sessionManager.getSessionCount();
      let tabsCleaned = 0;
      let mode = "unknown";
      let model = "unknown";
      let reason: string | null = null;

      const buildResult = (status: string, resultReason: string | null) => {
        const sessionsAfter = sessionManager.getSessionCount();
        return JSON.stringify(
          {
            status,
            mode,
            model,
            tabsCleaned,
            sessionsBefore,
            sessionsAfter,
            sessionsRemoved: sessionsBefore - sessionsAfter,
            phase,
            elapsedMs: resetState.elapsedMs(),
            failedOps,
            reason: resultReason,
          },
          null,
          2
        );
      };

      const checkTimeout = () => {
        if (resetState.elapsedMs() > 30000) {
          reason = "reset exceeded 30000ms";
          return buildResult("timeout", reason);
        }
        return null;
      };

      try {
        for (const session of sessionManager.listSessions()) {
          try {
            await session.ai.stopAgent();
          } catch {
          }
        }

        const preSyncTimeout = checkTimeout();
        if (preSyncTimeout) {
          return preSyncTimeout;
        }

        if (hard) {
          await sessionManager.destroyAllSessions();
        } else {
          await sessionManager.syncWithBrowser();
        }

        const syncTimeout = checkTimeout();
        if (syncTimeout) {
          return syncTimeout;
        }

        phase = "startComet";
        await cometClient.startComet();

        const startTimeout = checkTimeout();
        if (startTimeout) {
          return startTimeout;
        }

        phase = "closeTabs";
        const targets = await cometClient.listTargets();
        const pageTabs = targets.filter((t) => t.type === "page");

        if (pageTabs.length > 1) {
          for (let i = 1; i < pageTabs.length; i++) {
            try {
              await cometClient.closeTab(pageTabs[i].id);
              tabsCleaned += 1;
            } catch (error) {
              failedOps.push({
                op: "closeTab",
                targetId: pageTabs[i].id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }

        const closeTimeout = checkTimeout();
        if (closeTimeout) {
          return closeTimeout;
        }

        phase = "postSync";
        if (!hard && pageTabs.length > 1) {
          await sessionManager.syncWithBrowser();
        }

        const postTimeout = checkTimeout();
        if (postTimeout) {
          return postTimeout;
        }

        phase = "ensureMainTab";
        const freshTargets = await cometClient.listTargets();
        const anyPage = freshTargets.find((t) => t.type === "page");

        let activeTabId: string;
        if (anyPage) {
          await cometClient.connect(anyPage.id);
          await cometClient.navigate(PERPLEXITY_URL, true, anyPage.id);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          activeTabId = anyPage.id;
        } else {
          const newTab = await cometClient.newTab(PERPLEXITY_URL);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          await cometClient.connect(newTab.id);
          activeTabId = newTab.id;
        }

        const ensureTimeout = checkTimeout();
        if (ensureTimeout) {
          return ensureTimeout;
        }

        phase = "stateQuery";
        const tempAI = new CometAI(activeTabId);
        const [uiMode, modelInfo] = await Promise.all([
          tempAI.getPerplexityUIMode().catch(() => null),
          tempAI.getModelInfo({ openMenu: false }).catch(() => null),
        ]);

        mode = uiMode || "unknown";
        model = modelInfo?.currentModel || "unknown";

        const stateTimeout = checkTimeout();
        if (stateTimeout) {
          return stateTimeout;
        }

        return buildResult("connected", null);
      } catch (error) {
        if (error instanceof OperationTimeoutError) {
          return buildResult("timeout", error.message);
        }

        const message = error instanceof Error ? error.message : String(error);
        return buildResult("error", message);
      } finally {
        resetState.endReset();
      }
    },
  });
}
