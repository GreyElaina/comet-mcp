import { z } from "zod";
import { UserError } from "fastmcp";
import type { FastMCP } from "fastmcp";
import { cometClient } from "../cdp-client.js";
import { parsePositiveInt } from "./shared.js";
import { sessionManager, SessionError } from "../session-manager.js";
import { SessionState, INVALID_SESSION_NAME_ERROR } from "../types.js";

const schema = z.object({
  includeTargets: z
    .boolean()
    .optional()
    .describe("Include raw /json/list targets (default: false)"),
  sliceOffset: z
    .number()
    .optional()
    .describe("Response preview slice offset (default: 0)"),
  sliceLimit: z
    .number()
    .optional()
    .describe("Response preview slice limit (default: 500)"),
  session: z.string().optional().describe(
    "Named session to debug. Default: use focused session or auto-create 'default'."
  ),
});

const description = `Debug helper: shows current CDP connection state, relevant tabs, and extracted UI/status signals.`;

export function registerCometDebugTool(server: FastMCP) {
  server.addTool({
    name: "comet_debug",
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

      const includeTargets = args.includeTargets === true;
      const sliceOffsetRaw = args.sliceOffset;
      const sliceOffset =
        Number.isFinite(Number(sliceOffsetRaw)) && Number(sliceOffsetRaw) >= 0
          ? Math.trunc(Number(sliceOffsetRaw))
          : 0;
      const sliceLimit = parsePositiveInt(args.sliceLimit) ?? 500;

      const state = cometClient.currentState;
      const status = await session.ai.getAgentStatus();
      const iface = await session.ai.inspectInterface();
      const tabs = await cometClient.listTabsCategorized().catch(() => null);
      const targets = includeTargets
        ? await cometClient.listTargets().catch(() => [])
        : undefined;
      const responsePreview = await session.ai.getLatestResponseSlice(
        sliceOffset,
        sliceLimit
      );

      const debug = {
        state,
        tabs,
        interface: iface,
        status,
        responsePreview: { offset: sliceOffset, limit: sliceLimit, ...responsePreview },
        targets,
      };

      return JSON.stringify(debug, null, 2);
    },
  });
}
