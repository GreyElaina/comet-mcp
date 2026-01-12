import { z } from "zod";
import { UserError } from "fastmcp";
import type { FastMCP } from "fastmcp";
import { cometClient } from "../cdp-client.js";
import {
  pruneScreenshotResources,
  saveScreenshotResource,
  toResourceLink,
} from "../screenshot-manager.js";
import { sessionManager, SessionError } from "../session-manager.js";
import { SessionState, INVALID_SESSION_NAME_ERROR } from "../types.js";

const schema = z.object({
  session: z.string().optional().describe(
    "Named session to capture. Default: use focused session or auto-create 'default'."
  ),
});

const description = `Capture a screenshot of current page`;

export function registerCometScreenshotTool(server: FastMCP) {
  server.addTool({
    name: "comet_screenshot",
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

      await pruneScreenshotResources();

      const result = await cometClient.screenshot("png", undefined, session.tabId);
      const entry = await saveScreenshotResource(result.data, "image/png");

      const metadata = {
        uri: entry.uri,
        name: entry.name,
        mimeType: entry.mimeType,
        size: entry.size,
        sizeKB: (entry.size / 1024).toFixed(1),
        capturedAt: new Date(entry.createdAt).toISOString(),
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(metadata, null, 2) },
          toResourceLink(entry),
        ],
      };
    },
  });
}
