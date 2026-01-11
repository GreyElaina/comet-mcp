import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { cometAI } from "../comet-ai.js";

const schema = z.object({});

const description = `Stop the current agent task if it's going off track`;

export function registerCometStopTool(server: FastMCP) {
  server.addTool({
    name: "comet_stop",
    description,
    parameters: schema,
    execute: async () => {
      const stopped = await cometAI.stopAgent();
      return JSON.stringify({ stopped }, null, 2);
    },
  });
}
