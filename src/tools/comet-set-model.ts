import { z } from "zod";
import { UserError } from "fastmcp";
import type { FastMCP } from "fastmcp";
import { cometClient } from "../cdp-client.js";
import { sessionManager, SessionError } from "../session-manager.js";
import { SessionState, INVALID_SESSION_NAME_ERROR } from "../types.js";

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
  session: z.string().optional().describe(
    "Named session to set model for. Default: use focused session or auto-create 'default'."
  ),
});

const description = `Set default Perplexity model for subsequent comet_ask calls. Model will be switched automatically when needed. Use comet_list_models to see available options. Call with empty name to clear default.`;

export function registerCometSetModelTool(server: FastMCP) {
  server.addTool({
    name: "comet_set_model",
    description,
    parameters: schema,
    execute: async (args) => {
      let session: SessionState;
      if (args.session) {
        if (!sessionManager.validateSessionName(args.session)) {
          throw new UserError(INVALID_SESSION_NAME_ERROR + args.session);
        }
        const existingSession = sessionManager.getSession(args.session);
        if (!existingSession) {
          throw new UserError(
            `Session '${args.session}' not found.\n\nUse comet_ask({ session: "${args.session}" }) to create it first, or comet_session_list to see active sessions.`
          );
        }
        session = existingSession;
      } else {
        session = await sessionManager.resolveFocusedOrDefault();
      }
      try {
        await sessionManager.connectToSession(session.name);
      } catch (e) {
        if (e instanceof SessionError) {
          throw new UserError(e.message);
        }
        throw e;
      }
      sessionManager.updateSessionActivity(session.name);

      const name = String(args.name ?? "").trim();
      const validate = !!args.validate;
      const previous = session.ai.getDefaultModel();

      const result: Record<string, unknown> = {
        action: name ? "set" : "cleared",
        previous: previous ?? null,
        current: name || null,
      };

      if (validate && name) {
        if (cometClient.isConnected) {
          try {
            const info = await session.ai.getModelInfo({ openMenu: true });
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

      session.ai.setDefaultModel(name || null);
      result.current = session.ai.getDefaultModel() ?? null;

      return JSON.stringify(result, null, 2);
    },
  });
}
