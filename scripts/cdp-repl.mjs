#!/usr/bin/env node
/**
 * Interactive CDP REPL for Comet browser debugging
 * 
 * Usage:
 *   node scripts/cdp-repl.mjs
 *   COMET_PORT=9333 node scripts/cdp-repl.mjs
 * 
 * Commands in REPL:
 *   await eval('document.title')
 *   await screenshot()
 *   await listTargets()
 *   await setFiles(['input[type="file"]', ['/path/to/file.png']])
 *   await click('button[aria-label="Attach"]')
 *   await html('body')
 */

import CDP from 'chrome-remote-interface';
import { writeFileSync, statSync } from 'fs';
import { spawn } from 'child_process';

const PORT = parseInt(process.env.COMET_PORT || '9222', 10);
const COMET_PATH = '/Applications/Comet.app/Contents/MacOS/Comet';

let client = null;
let DOM = null;
let Runtime = null;
let Page = null;
let Input = null;

// ============== Core Functions ==============

async function connect(targetId) {
  if (client) {
    try { await client.close(); } catch {}
  }
  
  const options = { port: PORT };
  if (targetId) options.target = targetId;
  
  client = await CDP(options);
  DOM = client.DOM;
  Runtime = client.Runtime;
  Page = client.Page;
  Input = client.Input;
  
  await Promise.all([
    Page.enable(),
    Runtime.enable(),
    DOM.enable(),
  ]);
  
  const { result } = await Runtime.evaluate({ expression: 'window.location.href' });
  console.log(`Connected to: ${result.value}`);
  return result.value;
}

async function listTargets() {
  const resp = await fetch(`http://localhost:${PORT}/json/list`);
  const targets = await resp.json();
  targets.forEach((t, i) => {
    console.log(`[${i}] ${t.type} | ${t.title.slice(0, 40)} | ${t.url.slice(0, 60)}`);
  });
  return targets;
}

async function connectTo(index) {
  const targets = await listTargets();
  const target = targets[index];
  if (!target) throw new Error(`No target at index ${index}`);
  return connect(target.id);
}

// ============== Evaluation ==============

async function eval_(expr) {
  const { result, exceptionDetails } = await Runtime.evaluate({
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(exceptionDetails.text + (exceptionDetails.exception?.description || ''));
  }
  return result.value;
}

// ============== DOM Operations ==============

async function html(selector) {
  const result = await eval_(`document.querySelector('${selector}')?.outerHTML?.slice(0, 2000) || 'not found'`);
  console.log(result);
  return result;
}

async function text(selector) {
  const result = await eval_(`document.querySelector('${selector}')?.innerText?.slice(0, 2000) || 'not found'`);
  console.log(result);
  return result;
}

async function click(selector) {
  const result = await eval_(`
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

async function queryAll(selector) {
  const result = await eval_(`
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

// ============== File Upload ==============

async function getBackendNodeId(selector) {
  const doc = await DOM.getDocument();
  const { nodeId } = await DOM.querySelector({
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!nodeId) return null;
  
  const { node } = await DOM.describeNode({ nodeId });
  return node.backendNodeId;
}

async function setFiles(selector, filePaths) {
  // Validate files exist
  for (const f of filePaths) {
    try {
      statSync(f);
    } catch {
      throw new Error(`File not found: ${f}`);
    }
  }
  
  const backendNodeId = await getBackendNodeId(selector);
  if (!backendNodeId) {
    throw new Error(`Element not found: ${selector}`);
  }
  
  console.log(`Setting files on backendNodeId=${backendNodeId}:`, filePaths);
  
  await DOM.setFileInputFiles({
    files: filePaths,
    backendNodeId,
  });
  
  console.log('Files set successfully');
  return true;
}

async function findFileInputs() {
  const result = await eval_(`
    Array.from(document.querySelectorAll('input[type="file"]')).map((el, i) => ({
      i,
      id: el.id || null,
      name: el.name || null,
      accept: el.accept || null,
      multiple: el.multiple,
      visible: el.offsetParent !== null,
      parent: el.parentElement?.tagName || null,
    }))
  `);
  console.table(result);
  return result;
}

// ============== Screenshot ==============

async function screenshot(filename = 'debug-screenshot.png') {
  const { data } = await Page.captureScreenshot({ format: 'png' });
  writeFileSync(filename, Buffer.from(data, 'base64'));
  console.log(`Screenshot saved: ${filename}`);
  return filename;
}

// ============== Perplexity Specific ==============

async function findAttachButton() {
  const result = await eval_(`
    (() => {
      const selectors = [
        'button[aria-label*="Attach"]',
        'button[aria-label*="attach"]',
        'button[aria-label*="Upload"]',
        'button[aria-label*="upload"]',
        'button[aria-label*="Add file"]',
        'button[aria-label*="添加"]',
        'button[aria-label*="附件"]',
      ];
      
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          return { found: true, selector: sel, aria: el.getAttribute('aria-label'), text: (el.innerText || '').slice(0, 30) };
        }
      }
      
      // Fallback: find buttons with + icon near input
      const inputArea = document.querySelector('[contenteditable="true"]')?.closest('form') 
                     || document.querySelector('textarea')?.closest('form');
      if (inputArea) {
        const buttons = inputArea.querySelectorAll('button');
        for (const btn of buttons) {
          const aria = btn.getAttribute('aria-label') || '';
          const text = btn.innerText || '';
          if (btn.querySelector('svg') && !aria.toLowerCase().includes('submit') && !aria.toLowerCase().includes('send')) {
            return { found: true, selector: 'form button (heuristic)', aria, text: text.slice(0, 30) };
          }
        }
      }
      
      return { found: false };
    })()
  `);
  console.log(result);
  return result;
}

async function inspectUploadUI() {
  console.log('\n=== File Inputs ===');
  await findFileInputs();
  
  console.log('\n=== Attach Button ===');
  await findAttachButton();
  
  console.log('\n=== Buttons near input ===');
  await eval_(`
    (() => {
      const input = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
      if (!input) return [];
      let parent = input.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        const buttons = parent.querySelectorAll('button');
        if (buttons.length > 0) {
          return Array.from(buttons).map(b => ({
            aria: b.getAttribute('aria-label') || null,
            text: (b.innerText || '').slice(0, 20),
            hasSvg: !!b.querySelector('svg'),
            disabled: b.disabled,
          }));
        }
        parent = parent.parentElement;
      }
      return [];
    })()
  `).then(r => console.table(r));
}

// ============== Start Comet ==============

async function startComet() {
  // Check if already running
  try {
    const resp = await fetch(`http://localhost:${PORT}/json/version`);
    if (resp.ok) {
      console.log('Comet already running');
      return;
    }
  } catch {}
  
  console.log('Starting Comet...');
  const proc = spawn(COMET_PATH, [`--remote-debugging-port=${PORT}`], {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  
  // Wait for it
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const resp = await fetch(`http://localhost:${PORT}/json/version`);
      if (resp.ok) {
        console.log('Comet started');
        return;
      }
    } catch {}
  }
  throw new Error('Timeout starting Comet');
}

// ============== REPL ==============

async function startREPL() {
  // Export to global for REPL access
  global.connect = connect;
  global.listTargets = listTargets;
  global.connectTo = connectTo;
  global.e = eval_;           // e('document.title')
  global.js = eval_;          // js('document.title') - alias
  global.html = html;
  global.text = text;
  global.click = click;
  global.queryAll = queryAll;
  global.setFiles = setFiles;
  global.findFileInputs = findFileInputs;
  global.getBackendNodeId = getBackendNodeId;
  global.screenshot = screenshot;
  global.findAttachButton = findAttachButton;
  global.inspectUploadUI = inspectUploadUI;
  global.startComet = startComet;
  
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           CDP REPL for Comet Browser Debugging            ║
╠═══════════════════════════════════════════════════════════╣
║  await startComet()       - Start Comet if not running    ║
║  await listTargets()      - List all browser tabs         ║
║  await connect()          - Connect to first tab          ║
║  await connectTo(0)       - Connect to tab by index       ║
║                                                           ║
║  await e('...')           - Evaluate JS in page           ║
║  await js('...')          - Alias for e()                 ║
║  await html('selector')   - Get element HTML              ║
║  await text('selector')   - Get element text              ║
║  await click('selector')  - Click element                 ║
║  await queryAll('sel')    - List all matching elements    ║
║  await screenshot()       - Save screenshot               ║
║                                                           ║
║  === File Upload ===                                      ║
║  await findFileInputs()   - Find all file inputs          ║
║  await findAttachButton() - Find Perplexity attach btn    ║
║  await inspectUploadUI()  - Full upload UI inspection     ║
║  await setFiles('input[type="file"]', ['/path/file.png']) ║
╚═══════════════════════════════════════════════════════════╝
`);

  // Start Node REPL
  const repl = await import('repl');
  const r = repl.start({
    prompt: 'cdp> ',
    useGlobal: true,
  });
  
  r.on('exit', () => {
    if (client) client.close().catch(() => {});
    process.exit(0);
  });
}

// Auto-start
startREPL().catch(console.error);
