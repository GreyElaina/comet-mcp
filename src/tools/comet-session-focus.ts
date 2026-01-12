import { z } from "zod";
import { UserError } from "fastmcp";
import type { FastMCP } from "fastmcp";
import { sessionManager, SessionError } from "../session-manager.js";
import { cometAI } from "../comet-ai.js";

const schema = z.object({
  name: z.string().describe("Name of the session to focus"),
});

const description = `Switch focus to an existing session. The focused session is used by default when no session is specified in other tools.`;

export function registerCometSessionFocusTool(server: FastMCP) {
  server.addTool({
    name: "comet_session_focus",
    description,
    parameters: schema,
    execute: async (args) => {
      try {
         await sessionManager.connectToSession(args.name);
         sessionManager.focusSession(args.name);
        
        const model = sessionManager.getSessionDefaultModel(args.name);
        if (model) {
          cometAI.setDefaultModel(model);
        }
        
        const session = sessionManager.getSession(args.name)!;
        return JSON.stringify({
          focused: true,
          session: {
            name: session.name,
            tabId: session.tabId,
            defaultModel: session.defaultModel,
            lastActivity: session.lastActivity,
          },
        }, null, 2);
      } catch (e) {
        if (e instanceof SessionError) {
          throw new UserError(e.message);
        }
        throw e;
      }
    },
  });
}
