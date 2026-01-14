import { z } from "zod";
import { UserError } from "fastmcp";
import type { FastMCP } from "fastmcp";
import { cometClient } from "../cdp-client.js";
import { resetState } from "../concurrency/reset-state.js";
import { parsePositiveInt } from "./shared.js";
import { sessionManager, SessionError } from "../session-manager.js";
import { SessionState, INVALID_SESSION_NAME_ERROR } from "../types.js";

const schema = z.object({
  offset: z
    .number()
    .optional()
    .describe("Response slice start (chars). Default: 0"),
  limit: z
    .number()
    .optional()
    .describe("Response slice length (chars). Default: 24000"),
  includeSettings: z
    .boolean()
    .optional()
    .describe("Include current session settings (mode, tempChat, model). Default: false"),
  session: z.string().optional().describe(
    "Named session to poll. Default: use focused session or auto-create 'default'."
  ),
});

const description = `Check agent status and progress (does not start a new task). Call repeatedly to monitor an existing agentic task.`;

export function registerCometPollTool(server: FastMCP) {
  server.addTool({
    name: "comet_poll",
    description,
    parameters: schema,
    execute: async (args) => {
      if (resetState.isResetting()) {
        return JSON.stringify({ status: "blocked", reason: "reset in progress" }, null, 2);
      }

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

      const offsetRaw = args.offset;
      const offset =
        Number.isFinite(Number(offsetRaw)) && Number(offsetRaw) >= 0
          ? Math.trunc(Number(offsetRaw))
          : 0;
      const limit = parsePositiveInt(args.limit) ?? 24000;
      const includeSettings = !!args.includeSettings;

      const status = await session.ai.getAgentStatus();

      const result: Record<string, unknown> = {
        status: status.status,
      };

      if (includeSettings) {
        const modeResult = await cometClient.safeEvaluate(`
          (() => {
            const checked = document.querySelector('button[role="radio"][aria-checked="true"]');
            if (checked) return checked.getAttribute('value') || 'search';
            return 'search';
          })()
        `, session.tabId);
        const currentMode = modeResult.result.value as string;
        const tempChatInfo = await session.ai.inspectTemporaryChat();
        const modelInfo = await session.ai.getModelInfo({ openMenu: false });
        const reasoningInfo = await session.ai.inspectReasoning();

        result.settings = {
          mode: currentMode,
          tempChat: tempChatInfo.enabled,
          model: modelInfo.currentModel ?? null,
          reasoning: reasoningInfo.detected
            ? reasoningInfo.enabled
              ? "enabled"
              : "disabled"
            : "not available",
        };
      }

      if (status.agentBrowsingUrl) {
        result.agentBrowsingUrl = status.agentBrowsingUrl;
      }

      if (status.steps.length > 0) {
        result.steps = status.steps;
      }

      if (status.currentStep && status.status === "working") {
        result.currentStep = status.currentStep;
      }

      if (status.status === "completed") {
        const { total, slice } = await session.ai.getLatestResponseSlice(offset, limit);
        if (slice) {
          const start = Math.min(offset, total);
          const end = Math.min(start + slice.length, total);
          const hasMore = end < total;

          result.response = {
            total,
            slice: { start, end },
            hasMore,
            ...(hasMore && { nextOffset: end }),
            content: slice,
          };
        }
      } else if (status.status === "working" && status.hasStopButton) {
        result.hint = "Agent is working - use comet_stop to interrupt if needed";
      }

      return JSON.stringify(result, null, 2);
    },
  });
}
