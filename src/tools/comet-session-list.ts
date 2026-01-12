import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { sessionManager } from "../session-manager.js";

const schema = z.object({});

const description = `List all active sessions with their status. Sessions are sorted by last activity (most recent first).`;

export function registerCometSessionListTool(server: FastMCP) {
  server.addTool({
    name: "comet_session_list",
    description,
    parameters: schema,
    execute: async () => {
      const sessions = sessionManager.listSessions();
      const focusedName = sessionManager.getFocusedSessionName();
      
      const result = sessions.map((s) => ({
        name: s.name,
        tabId: s.tabId,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        isFocused: s.name === focusedName,
        defaultModel: s.defaultModel,
      }));
      
      return JSON.stringify(result, null, 2);
    },
  });
}
