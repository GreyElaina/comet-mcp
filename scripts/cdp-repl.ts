#!/usr/bin/env npx tsx

// CDP REPL for Comet - Run: npx tsx scripts/cdp-repl.ts

import repl from "repl";
import { writeFileSync } from "fs";
import { cometClient } from "../src/cdp-client.js";
import { cometAI } from "../src/comet-ai.js";

async function listTargets() {
  const targets = await cometClient.listTargets();
  const state = cometClient.currentState;
  targets.forEach((t, i) => {
    const marker = t.id === state.activeTabId ? "→" : " ";
    console.log(
      `${marker}[${i}] ${t.type} | ${t.title.slice(0, 40)} | ${t.url.slice(0, 60)}`
    );
  });
  return targets;
}

async function connectTo(index: number) {
  const targets = await cometClient.listTargets();
  const target = targets[index];
  if (!target) throw new Error(`No target at index ${index}`);
  return cometClient.connect(target.id);
}

async function e(expr: string) {
  const result = await cometClient.safeEvaluate(expr);
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text +
        (result.exceptionDetails.exception?.description || "")
    );
  }
  return result.result.value;
}

async function html(selector: string) {
  const result = await e(
    `document.querySelector('${selector}')?.outerHTML?.slice(0, 3000) || 'not found'`
  );
  console.log(result);
  return result;
}

async function text(selector: string) {
  const result = await e(
    `document.querySelector('${selector}')?.innerText?.slice(0, 2000) || 'not found'`
  );
  console.log(result);
  return result;
}

async function click(selector: string) {
  const result = await e(`
    (() => {
      const el = document.querySelector('${selector}');
      if (!el) return { ok: false, reason: 'not found' };
      el.click();
      return { ok: true, tag: el.tagName, text: (el.innerText || '').slice(0, 50) };
    })()
  `);
  console.log(result);
  return result;
}

async function queryAll(selector: string) {
  const result = await e(`
    Array.from(document.querySelectorAll('${selector}')).map((el, i) => ({
      i,
      tag: el.tagName,
      id: el.id || null,
      class: el.className?.slice?.(0, 50) || null,
      aria: el.getAttribute('aria-label') || null,
      text: (el.innerText || '').slice(0, 30).replace(/\\n/g, ' '),
      visible: el.offsetParent !== null,
    }))
  `);
  console.table(result);
  return result;
}

async function screenshot(filename = "debug-screenshot.png") {
  const result = await cometClient.screenshot("png");
  writeFileSync(filename, Buffer.from(result.data, "base64"));
  console.log(`Screenshot saved: ${filename}`);
  return filename;
}

async function findFileInputs() {
  const result = await e(`
    Array.from(document.querySelectorAll('input[type="file"]')).map((el, i) => ({
      i,
      id: el.id || null,
      name: el.name || null,
      accept: el.accept || null,
      multiple: el.multiple,
      visible: el.offsetParent !== null,
    }))
  `);
  console.table(result);
  return result;
}

async function getCurrentMode() {
  const result = await cometAI.getPerplexityUIMode();
  console.log("Current mode:", result);
  return result;
}

async function findModelSelector() {
  const result = await e(`
    (() => {
      const cpuButtons = Array.from(document.querySelectorAll('use'))
        .filter(u => u.getAttribute('xlink:href')?.includes('cpu'))
        .map(u => u.closest('button'))
        .filter(Boolean);
      
      return cpuButtons.map(btn => {
        const rect = btn.getBoundingClientRect();
        return {
          tag: btn.tagName,
          aria: btn.getAttribute('aria-label') || '',
          haspopup: btn.getAttribute('aria-haspopup'),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        };
      });
    })()
  `);
  console.table(result);
  return result;
}

async function listMenuItems() {
  const result = await e(`
    (() => {
      const selectors = [
        '[role="menu"] [role="menuitem"]',
        '.shadow-overlay [role="menuitem"]',
        'div[style*="position: fixed"] [role="menuitem"]',
        '[role="menuitem"]',
      ];
      
      let items = [];
      for (const sel of selectors) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) {
          items = Array.from(found);
          break;
        }
      }
      
      return items.map((el, i) => {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        const text = (el.innerText || '').split('\\n')[0].trim().slice(0, 50);
        return {
          i,
          text,
          role: el.getAttribute('role'),
          aria: (el.getAttribute('aria-label') || '').slice(0, 30),
          visible,
          rect: visible ? { x: Math.round(rect.x), y: Math.round(rect.y) } : null,
        };
      }).filter(x => x.visible);
    })()
  `);
  console.table(result);
  return result;
}

async function inspectModelMenu() {
  console.log("\n=== Model Info (via cometAI) ===");
  const modelInfo = await cometAI.getModelInfo({ openMenu: true, includeRaw: true });
  console.log("Current model:", modelInfo.currentModel);
  console.log("Available models:", modelInfo.availableModels);
  console.log("Supports switching:", modelInfo.supportsModelSwitching);
  console.log("Reasoning available:", modelInfo.reasoningAvailable);
  console.log("Reasoning enabled:", modelInfo.reasoningEnabled);
  return modelInfo;
}

async function status() {
  const s = await cometAI.getAgentStatus();
  console.log("Status:", s.status);
  console.log("Has stop button:", s.hasStopButton);
  console.log("Has loading spinner:", s.hasLoadingSpinner);
  console.log("Response length:", s.responseLength);
  if (s.currentStep) console.log("Current step:", s.currentStep);
  if (s.steps.length) console.log("Steps:", s.steps);
  return s;
}

async function response(offset = 0, limit = 2000) {
  const { total, slice } = await cometAI.getLatestResponseSlice(offset, limit);
  console.log(`[${offset}-${Math.min(offset + limit, total)} of ${total} chars]`);
  console.log(slice);
  return { total, slice };
}

async function ask(prompt: string, options?: number | { timeout?: number; stripCitations?: boolean }) {
  console.log("Sending prompt...");
  const result = await cometAI.ask(prompt, options);
  console.log("Complete:", result.complete, "Length:", result.text.length);
  return result;
}

async function tempChat() {
  const result = await cometAI.inspectTemporaryChat();
  console.log("Detected:", result.detected);
  console.log("Enabled:", result.enabled);
  return result;
}

async function reasoning() {
  const result = await cometAI.inspectReasoning();
  console.log("Detected:", result.detected);
  console.log("Enabled:", result.enabled);
  return result;
}

async function mode() {
  const result = await cometAI.detectMode();
  console.log("Mode:", result.mode);
  console.log("Has agent browsing:", result.hasAgentBrowsing);
  return result;
}

async function tabs() {
  const t = await cometClient.listTabsCategorized();
  console.log("Main:", t.main?.url?.slice(0, 60) || "(none)");
  console.log("Sidecar:", t.sidecar?.url?.slice(0, 60) || "(none)");
  console.log("Agent browsing:", t.agentBrowsing?.url?.slice(0, 60) || "(none)");
  console.log("Others:", t.others.length);
  return t;
}

async function startREPL() {
  const g = global as any;

  g.cometClient = cometClient;
  g.cometAI = cometAI;

  g.connect = (id?: string) => cometClient.connect(id);
  g.disconnect = () => cometClient.disconnect();
  g.reconnect = () => cometClient.reconnect();
  g.startComet = (port?: number) => cometClient.startComet(port);
  g.listTargets = listTargets;
  g.connectTo = connectTo;
  g.tabs = tabs;

  g.e = e;
  g.js = e;
  g.html = html;
  g.text = text;
  g.click = click;
  g.queryAll = queryAll;

  g.screenshot = screenshot;
  g.navigate = (url: string) => cometClient.navigate(url);
  g.url = () => cometClient.getCurrentUrl();

  g.ask = ask;
  g.status = status;
  g.response = response;
  g.stop = () => cometAI.stopAgent();

  g.mode = mode;
  g.getCurrentMode = getCurrentMode;
  g.tempChat = tempChat;
  g.reasoning = reasoning;

  g.findModelSelector = findModelSelector;
  g.listMenuItems = listMenuItems;
  g.inspectModelMenu = inspectModelMenu;
  g.getModelInfo = (opts?: any) => cometAI.getModelInfo(opts);
  g.setModel = (name: string) => cometAI.setDefaultModel(name);
  g.ensureModel = (name: string) => cometAI.ensureModel(name);

  g.findFileInputs = findFileInputs;
  g.uploadFiles = (paths: string[]) => cometAI.uploadFiles(paths);

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║        CDP REPL for Comet (uses cometClient/cometAI)          ║
╠═══════════════════════════════════════════════════════════════╣
║  CONNECTION                                                   ║
║    await startComet()      - Start Comet if not running       ║
║    await connect()         - Connect to first Perplexity tab  ║
║    await listTargets()     - List all browser tabs            ║
║    await connectTo(0)      - Connect to tab by index          ║
║    await tabs()            - List tabs (categorized)          ║
║    await disconnect()      - Disconnect from current tab      ║
║                                                               ║
║  EVALUATION                                                   ║
║    await e('...')          - Evaluate JS in page              ║
║    await html('selector')  - Get element HTML                 ║
║    await text('selector')  - Get element text                 ║
║    await click('selector') - Click element                    ║
║    await queryAll('sel')   - List all matching elements       ║
║                                                               ║
║  PAGE                                                         ║
║    await screenshot()      - Save screenshot                  ║
║    await navigate(url)     - Navigate to URL                  ║
║    await url()             - Get current URL                  ║
║                                                               ║
║  AI (via cometAI)                                             ║
║    await ask('prompt')     - Send prompt to Perplexity        ║
║    await status()          - Get agent status                 ║
║    await response()        - Get latest response              ║
║    await stop()            - Stop agent                       ║
║                                                               ║
║  SETTINGS                                                     ║
║    await mode()            - Detect search vs agent mode      ║
║    await getCurrentMode()  - Get Perplexity UI mode           ║
║    await tempChat()        - Inspect temp chat status         ║
║    await reasoning()       - Inspect reasoning toggle         ║
║                                                               ║
║  MODEL                                                        ║
║    await getModelInfo()    - Get model info                   ║
║    await inspectModelMenu()- Full model menu inspection       ║
║    await ensureModel(name) - Switch to model                  ║
║                                                               ║
║  FILES                                                        ║
║    await findFileInputs()  - Find all file inputs             ║
║    await uploadFiles([..]) - Upload files to Perplexity       ║
║                                                               ║
║  RAW ACCESS                                                   ║
║    cometClient             - Raw CDP client instance          ║
║    cometAI                 - Raw AI module instance           ║
╚═══════════════════════════════════════════════════════════════╝
`);

  const r = repl.start({
    prompt: "cdp> ",
    useGlobal: true,
  });

  r.on("exit", async () => {
    try {
      await cometClient.disconnect();
    } catch {}
    process.exit(0);
  });
}

startREPL().catch(console.error);
