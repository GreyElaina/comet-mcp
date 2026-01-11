import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

export const SCREENSHOT_DIR = path.join(os.tmpdir(), "comet-mcp", "screenshots");

export const SCREENSHOT_TTL_MS = (() => {
  const parsed = Number(process.env.COMET_SCREENSHOT_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30 * 60 * 1000;
})();

export const SCREENSHOT_MAX_ENTRIES = (() => {
  const parsed = Number(process.env.COMET_SCREENSHOT_MAX ?? "20");
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 20;
})();

export const SCREENSHOT_URI_PREFIX = "comet://screenshots";

export interface ScreenshotResourceEntry {
  uri: string;
  path: string;
  name: string;
  title: string;
  description: string;
  mimeType: string;
  createdAt: number;
  size: number;
}

export const screenshotResources = new Map<string, ScreenshotResourceEntry>();

let screenshotDirReady = false;

export const ensureScreenshotDir = async () => {
  if (screenshotDirReady) return;
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  screenshotDirReady = true;
};

export const removeScreenshotEntry = async (entry: ScreenshotResourceEntry) => {
  screenshotResources.delete(entry.uri);
  try {
    await fs.unlink(entry.path);
  } catch {}
};

export interface PruneResult {
  pruned: boolean;
  removedUris: string[];
}

export const pruneScreenshotResources = async (): Promise<PruneResult> => {
  await ensureScreenshotDir();
  const now = Date.now();
  const existing = Array.from(screenshotResources.values());
  const toRemove = new Map<string, ScreenshotResourceEntry>();

  for (const entry of existing) {
    if (now - entry.createdAt > SCREENSHOT_TTL_MS) {
      toRemove.set(entry.uri, entry);
      continue;
    }
    try {
      await fs.access(entry.path);
    } catch {
      toRemove.set(entry.uri, entry);
    }
  }

  const survivors = existing
    .filter((entry) => !toRemove.has(entry.uri))
    .sort((a, b) => a.createdAt - b.createdAt);

  while (survivors.length > SCREENSHOT_MAX_ENTRIES) {
    const entry = survivors.shift();
    if (entry) {
      toRemove.set(entry.uri, entry);
    }
  }

  if (!toRemove.size) return { pruned: false, removedUris: [] };

  const removedUris = [...toRemove.keys()];
  await Promise.all(
    [...toRemove.values()].map((entry) => removeScreenshotEntry(entry))
  );
  return { pruned: true, removedUris };
};

export const toResourceDescriptor = (entry: ScreenshotResourceEntry) => ({
  name: entry.name,
  title: entry.title,
  uri: entry.uri,
  description: entry.description,
  mimeType: entry.mimeType,
  annotations: {
    lastModified: new Date(entry.createdAt).toISOString(),
  },
});

export const listScreenshotResourceDescriptors = () => {
  return Array.from(screenshotResources.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(toResourceDescriptor);
};

export const toResourceLink = (entry: ScreenshotResourceEntry) => ({
  type: "resource_link" as const,
  ...toResourceDescriptor(entry),
});

export const saveScreenshotResource = async (
  base64Data: string,
  mimeType: string
): Promise<ScreenshotResourceEntry> => {
  await ensureScreenshotDir();
  const buffer = Buffer.from(base64Data, "base64");
  const timestamp = Date.now();
  const extension = mimeType === "image/jpeg" ? "jpg" : "png";
  const fileName = `screenshot-${timestamp}-${randomUUID()}.${extension}`;
  const filePath = path.join(SCREENSHOT_DIR, fileName);
  await fs.writeFile(filePath, buffer);

  const entry: ScreenshotResourceEntry = {
    uri: `${SCREENSHOT_URI_PREFIX}/${fileName}`,
    path: filePath,
    name: fileName,
    title: "Comet Screenshot",
    description: `Screenshot captured at ${new Date(timestamp).toISOString()}`,
    mimeType,
    createdAt: timestamp,
    size: buffer.length,
  };

  screenshotResources.set(entry.uri, entry);
  return entry;
};

export const getScreenshotEntry = (uri: string) => screenshotResources.get(uri);

export const readScreenshotBlob = async (entry: ScreenshotResourceEntry) => {
  const data = await fs.readFile(entry.path);
  return data.toString("base64");
};
