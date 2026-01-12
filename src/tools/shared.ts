import { cometClient } from "../cdp-client.js";
import { SessionState } from "../types.js";

export const chunkText = (text: string, chunkSize = 8000): string[] => {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
};

export const toTextContent = (text: string) => {
  const chunks = chunkText(text);
  if (chunks.length === 1) return [{ type: "text" as const, text }];
  return chunks.map((chunk, index) => ({
    type: "text" as const,
    text: `[Part ${index + 1}/${chunks.length}]\n${chunk}`,
  }));
};

export const parsePositiveInt = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
};

export const isUsableViewport = async (): Promise<boolean> => {
  try {
    const metrics = await cometClient.safeEvaluate(
      `(() => ({ w: window.innerWidth, h: window.innerHeight }))()`
    );
    const v = metrics?.result?.value as any;
    const w = Number(v?.w ?? 0);
    const h = Number(v?.h ?? 0);
    return Number.isFinite(w) && Number.isFinite(h) && w >= 200 && h >= 200;
  } catch {
    return false;
  }
};

export const ensureConnectedToComet = async (session?: SessionState): Promise<string | null> => {
  if (session) {
    return null;
  }

  if (cometClient.isConnected) {
    if (await isUsableViewport()) return null;
    try {
      await cometClient.disconnect();
    } catch {}
  }

  const startResult = await cometClient.startComet();

  const targets = await cometClient.listTargets();
  const pageTabs = targets.filter((t) => t.type === "page");

  const candidateTabs = [
    ...pageTabs.filter(
      (t) => t.url.includes("perplexity.ai") && !t.url.includes("sidecar")
    ),
    ...pageTabs.filter((t) => t.url.includes("perplexity.ai")),
    ...pageTabs.filter(
      (t) => t.url !== "about:blank" && !t.url.startsWith("chrome://")
    ),
  ];

  const seen = new Set<string>();
  for (const tab of candidateTabs) {
    if (!tab?.id || seen.has(tab.id)) continue;
    seen.add(tab.id);
    try {
      await cometClient.connect(tab.id);
      await new Promise((r) => setTimeout(r, 150));
      if (await isUsableViewport()) return startResult;
    } catch {}
  }

  const newTab = await cometClient.newTab("https://www.perplexity.ai/");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await cometClient.connect(newTab.id);
  return startResult;
};
