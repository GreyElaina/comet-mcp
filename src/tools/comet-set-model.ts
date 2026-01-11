import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { cometClient } from "../cdp-client.js";
import { cometAI } from "../comet-ai.js";

const schema = z.object({
  name: z
    .string()
    .optional()
    .describe(
      "Model name (case-insensitive substring match). Empty to clear."
    ),
  validate: z
    .boolean()
    .optional()
    .describe(
      "Validate model exists in available models (requires Comet connection). Default: false"
    ),
});

const description = `Set default Perplexity model for subsequent comet_ask calls. Model will be switched automatically when needed. Use comet_list_models to see available options. Call with empty name to clear default.`;

export function registerCometSetModelTool(server: FastMCP) {
  server.addTool({
    name: "comet_set_model",
    description,
    parameters: schema,
    execute: async (args) => {
      const name = String(args.name ?? "").trim();
      const validate = !!args.validate;
      const previous = cometAI.getDefaultModel();

      const result: Record<string, unknown> = {
        action: name ? "set" : "cleared",
        previous: previous ?? null,
        current: name || null,
      };

      if (validate && name) {
        if (cometClient.isConnected) {
          try {
            const info = await cometAI.getModelInfo({ openMenu: true });
            const available = info.availableModels;
            const nameLower = name.toLowerCase();
            const match = available.find((m) =>
              m.toLowerCase().includes(nameLower)
            );

            if (match) {
              result.validation = {
                status: "valid",
                matchedModel: match,
              };
            } else {
              result.validation = {
                status: "not_found",
                availableModels: available,
              };
            }
          } catch (e) {
            result.validation = {
              status: "error",
              error: e instanceof Error ? e.message : String(e),
            };
          }
        } else {
          result.validation = {
            status: "skipped",
            reason: "not_connected",
          };
        }
      }

      cometAI.setDefaultModel(name || null);
      result.current = cometAI.getDefaultModel() ?? null;

      return JSON.stringify(result, null, 2);
    },
  });
}
