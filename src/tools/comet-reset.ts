import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { cometClient } from "../cdp-client.js";
import { cometAI } from "../comet-ai.js";
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
      const hard = args.hard === true;
      const sessionsBefore = sessionManager.getSessionCount();

      if (hard) {
        await sessionManager.destroyAllSessions();
      } else {
        await sessionManager.syncWithBrowser();
      }

      await cometClient.startComet();

      const targets = await cometClient.listTargets();
      const pageTabs = targets.filter((t) => t.type === "page");

       if (pageTabs.length > 1) {
         for (let i = 1; i < pageTabs.length; i++) {
           await cometClient.closeTab(pageTabs[i].id).catch(() => {});
         }
       }

       // Sync again after closing tabs to remove stale sessions from SessionMap
       if (!hard && pageTabs.length > 1) {
         await sessionManager.syncWithBrowser();
       }

       const freshTargets = await cometClient.listTargets();
      const anyPage = freshTargets.find((t) => t.type === "page");

      if (anyPage) {
        await cometClient.connect(anyPage.id);
        await cometClient.navigate(PERPLEXITY_URL, true);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } else {
        const newTab = await cometClient.newTab(PERPLEXITY_URL);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await cometClient.connect(newTab.id);
      }

      const [uiMode, modelInfo] = await Promise.all([
        cometAI.getPerplexityUIMode().catch(() => null),
        cometAI.getModelInfo({ openMenu: false }).catch(() => null),
      ]);

      const sessionsAfter = sessionManager.getSessionCount();

      const info = {
        status: "connected",
        mode: uiMode || "unknown",
        model: modelInfo?.currentModel || "unknown",
        defaultModel: cometAI.getDefaultModel(),
        tabsCleaned: pageTabs.length > 1 ? pageTabs.length - 1 : 0,
        sessionsBefore,
        sessionsAfter,
        sessionsRemoved: sessionsBefore - sessionsAfter,
      };

      return JSON.stringify(info, null, 2);
    },
  });
}
