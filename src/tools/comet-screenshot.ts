import { z } from "zod";
import type { FastMCP } from "fastmcp";
import { cometClient } from "../cdp-client.js";
import {
  pruneScreenshotResources,
  saveScreenshotResource,
  toResourceLink,
} from "../screenshot-manager.js";
import { ensureConnectedToComet } from "./shared.js";

const schema = z.object({});

const description = `Capture a screenshot of current page`;

export function registerCometScreenshotTool(server: FastMCP) {
  server.addTool({
    name: "comet_screenshot",
    description,
    parameters: schema,
    execute: async () => {
      await ensureConnectedToComet();

      await pruneScreenshotResources();

      const result = await cometClient.screenshot("png");
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
