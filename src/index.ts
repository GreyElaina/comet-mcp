#!/usr/bin/env node

import { FastMCP } from "fastmcp";
import {
  registerCometResetTool,
  registerCometAskTool,
  registerCometPollTool,
  registerCometStopTool,
  registerCometScreenshotTool,
  registerCometListModelsTool,
  registerCometSetModelTool,
  registerCometDebugTool,
  registerCometSessionFocusTool,
  registerCometSessionDestroyTool,
  registerCometSessionListTool,
} from "./tools/index.js";
import {
  getScreenshotEntry,
  readScreenshotBlob,
  listScreenshotResourceDescriptors,
  SCREENSHOT_URI_PREFIX,
} from "./screenshot-manager.js";

const server = new FastMCP({
  name: "comet-bridge",
  version: "2.0.0",
});

server.addResourceTemplate({
  uriTemplate: `${SCREENSHOT_URI_PREFIX}/{filename}`,
  name: "Comet Screenshot",
  mimeType: "image/png",
  description: "Screenshots captured from Comet browser",
  arguments: [
    {
      name: "filename",
      description: "Screenshot filename",
      required: true,
      complete: async () => {
        const descriptors = listScreenshotResourceDescriptors();
        return {
          values: descriptors.map((d) => d.name),
        };
      },
    },
  ],
  async load({ filename }) {
    const uri = `${SCREENSHOT_URI_PREFIX}/${filename}`;
    const entry = getScreenshotEntry(uri);
    if (!entry) {
      throw new Error(`Screenshot not found: ${filename}`);
    }
    const blob = await readScreenshotBlob(entry);
    return {
      blob,
      mimeType: entry.mimeType,
      uri: entry.uri,
    };
  },
});

registerCometResetTool(server);
registerCometAskTool(server);
registerCometPollTool(server);
registerCometStopTool(server);
registerCometScreenshotTool(server);
registerCometListModelsTool(server);
registerCometSetModelTool(server);
registerCometDebugTool(server);
registerCometSessionFocusTool(server);
registerCometSessionDestroyTool(server);
registerCometSessionListTool(server);

server.start({
  transportType: "stdio",
});
