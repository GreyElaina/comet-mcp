import { z } from "zod";
import { UserError } from "fastmcp";
import type { FastMCP } from "fastmcp";
import { cometAI } from "../comet-ai.js";
import { sessionManager, SessionError } from "../session-manager.js";
import { SessionState, INVALID_SESSION_NAME_ERROR } from "../types.js";

const schema = z.object({
  session: z.string().optional().describe(
    "Named session to stop. Default: use focused session."
  ),
});

const description = `Stop the current agent task if it's going off track`;

export function registerCometStopTool(server: FastMCP) {
  server.addTool({
    name: "comet_stop",
    description,
    parameters: schema,
    execute: async (args) => {
      let session: SessionState;
      if (args.session) {
        if (!sessionManager.validateSessionName(args.session)) {
          throw new UserError(INVALID_SESSION_NAME_ERROR + args.session);
        }
        session = await sessionManager.getOrCreateSession(args.session);
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

      const stopped = await cometAI.stopAgent();
      return JSON.stringify({ stopped }, null, 2);
    },
  });
}
