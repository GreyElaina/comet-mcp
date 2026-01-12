import { z } from "zod";
import { UserError } from "fastmcp";
import type { FastMCP } from "fastmcp";
import { sessionManager, SessionError } from "../session-manager.js";

const schema = z.object({
  name: z.string().describe("Name of the session to destroy"),
});

const description = `Destroy a session: closes its browser tab and removes it. If this was the focused session, focus becomes null.`;

export function registerCometSessionDestroyTool(server: FastMCP) {
  server.addTool({
    name: "comet_session_destroy",
    description,
    parameters: schema,
    execute: async (args) => {
      try {
        const { wasFocused } = await sessionManager.destroySession(args.name);
        return JSON.stringify({
          destroyed: true,
          name: args.name,
          wasFocused,
          hint: "Use comet_session_list to see remaining sessions",
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
