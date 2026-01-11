import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { cometAI } from "../comet-ai.js";

const schema = z.object({
  openMenu: z
    .boolean()
    .optional()
    .describe("Attempt to open model selector dropdown (default: false)"),
  inspectAllReasoning: z
    .boolean()
    .optional()
    .describe("Check reasoning support for each model (slow, implies openMenu=true)"),
  includeRaw: z
    .boolean()
    .optional()
    .describe("Include debug details (default: false)"),
});

const description = `List available Perplexity models (best-effort; depends on account/UI). Use openMenu=true to actively open the model selector and scrape options.`;

export function registerCometListModelsTool(server: FastMCP) {
  server.addTool({
    name: "comet_list_models",
    description,
    parameters: schema,
    execute: async (args) => {
      const openMenu = !!args.openMenu;
      const inspectAllReasoning = !!args.inspectAllReasoning;
      const includeRaw = !!args.includeRaw;

      const info = await cometAI.getModelInfo({
        openMenu,
        inspectAllReasoning,
        includeRaw,
      });

      const reasoningStatus = info.reasoningAvailable
        ? info.reasoningEnabled
          ? "enabled"
          : "disabled"
        : "not available";

      const models = info.availableModels.map((name) => {
        const reasoning = info.modelReasoningSupport?.[name] ?? "unknown";
        return { name, reasoning };
      });

      const notes: string[] = [];
      if (info.mode === "agent") {
        notes.push("Model switching is not available in agent mode. Use search mode instead.");
      }

      const result: Record<string, unknown> = {
        mode: info.mode,
        currentModel: info.currentModel ?? null,
        reasoning: {
          status: reasoningStatus,
          available: info.reasoningAvailable,
          enabled: info.reasoningEnabled,
        },
        supportsModelSwitching: info.supportsModelSwitching,
        availableModels: models,
      };

      if (notes.length > 0) {
        result.notes = notes;
      }

      if (includeRaw) {
        result.debug = info.debug ?? null;
      }

      return JSON.stringify(result, null, 2);
    },
  });
}
