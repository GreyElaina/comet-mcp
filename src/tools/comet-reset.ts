import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { cometClient } from "../cdp-client.js";
import { cometAI } from "../comet-ai.js";

const schema = z.object({});

const description = `Reset Comet to clean state: closes extra tabs, navigates to Perplexity home, returns current state (mode, model, defaultModel). Use when Comet is in a bad state or before starting fresh.`;

export function registerCometResetTool(server: FastMCP) {
  server.addTool({
    name: "comet_reset",
    description,
    parameters: schema,
    execute: async () => {
      await cometClient.startComet();

      const targets = await cometClient.listTargets();
      const pageTabs = targets.filter((t) => t.type === "page");

      if (pageTabs.length > 1) {
        for (let i = 1; i < pageTabs.length; i++) {
          await cometClient.closeTab(pageTabs[i].id).catch(() => {});
        }
      }

      const freshTargets = await cometClient.listTargets();
      const anyPage = freshTargets.find((t) => t.type === "page");

      if (anyPage) {
        await cometClient.connect(anyPage.id);
        await cometClient.navigate("https://www.perplexity.ai/", true);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      } else {
        const newTab = await cometClient.newTab("https://www.perplexity.ai/");
        await new Promise((resolve) => setTimeout(resolve, 2000));
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

      return JSON.stringify(info, null, 2);
    },
  });
}
