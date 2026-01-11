import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { cometClient } from "../cdp-client.js";
import { cometAI } from "../comet-ai.js";
import { parsePositiveInt } from "./shared.js";

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
});

const description = `Debug helper: shows current CDP connection state, relevant tabs, and extracted UI/status signals.`;

export function registerCometDebugTool(server: FastMCP) {
  server.addTool({
    name: "comet_debug",
    description,
    parameters: schema,
    execute: async (args) => {
      const includeTargets = args.includeTargets === true;
      const sliceOffsetRaw = args.sliceOffset;
      const sliceOffset =
        Number.isFinite(Number(sliceOffsetRaw)) && Number(sliceOffsetRaw) >= 0
          ? Math.trunc(Number(sliceOffsetRaw))
          : 0;
      const sliceLimit = parsePositiveInt(args.sliceLimit) ?? 500;

      const state = cometClient.currentState;
      const status = await cometAI.getAgentStatus();
      const iface = await cometAI.inspectInterface();
      const tabs = await cometClient.listTabsCategorized().catch(() => null);
      const targets = includeTargets
        ? await cometClient.listTargets().catch(() => [])
        : undefined;
      const responsePreview = await cometAI.getLatestResponseSlice(
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
