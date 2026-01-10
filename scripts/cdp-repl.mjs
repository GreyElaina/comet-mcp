#!/usr/bin/env node

import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'fs';
import { spawn } from 'child_process';

const PORT = parseInt(process.env.COMET_PORT || '9222', 10);
const COMET_PATH = '/Applications/Comet.app/Contents/MacOS/Comet';

let browser = null;
let session = null;
let currentTargetId = null;

async function getVersion() {
  const resp = await fetch(`http://localhost:${PORT}/json/version`);
  return resp.json();
}

async function listTargets() {
  const resp = await fetch(`http://localhost:${PORT}/json/list`);
  const targets = await resp.json();
  targets.forEach((t, i) => {
    const marker = t.id === currentTargetId ? '→' : ' ';
    console.log(`${marker}[${i}] ${t.type} | ${t.title.slice(0, 40)} | ${t.url.slice(0, 60)}`);
  });
  return targets;
}

async function connectBrowser() {
  if (browser?.connected) return;
  
  const version = await getVersion();
  browser = await puppeteer.connect({
    browserWSEndpoint: version.webSocketDebuggerUrl,
    defaultViewport: null,
  });
  console.log('Browser connected');
}

async function connect(targetId) {
  await connectBrowser();
  
  if (!targetId) {
    const targets = await listTargets();
    const page = targets.find(t => t.type === 'page' && t.url.includes('perplexity'));
    targetId = page?.id || targets.find(t => t.type === 'page')?.id;
  }
  
  if (!targetId) throw new Error('No page target found');
  
  const target = await browser.waitForTarget(t => {
    const cdpTarget = t._getTargetInfo?.() || {};
    return cdpTarget.targetId === targetId;
  }, { timeout: 5000 });
  
  const page = await target.asPage();
  session = await page.createCDPSession();
  currentTargetId = targetId;
  
  const url = await page.url();
  console.log(`Connected to: ${url}`);
  return url;
}

async function connectTo(index) {
  const targets = await listTargets();
  const target = targets[index];
  if (!target) throw new Error(`No target at index ${index}`);
  return connect(target.id);
}

async function e(expr) {
  if (!session) throw new Error('Not connected. Run: await connect()');
  
  const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  
  if (exceptionDetails) {
    throw new Error(exceptionDetails.text + (exceptionDetails.exception?.description || ''));
  }
  return result.value;
}

async function html(selector) {
  const result = await e(`document.querySelector('${selector}')?.outerHTML?.slice(0, 3000) || 'not found'`);
  console.log(result);
  return result;
}

async function text(selector) {
  const result = await e(`document.querySelector('${selector}')?.innerText?.slice(0, 2000) || 'not found'`);
  console.log(result);
  return result;
}

async function click(selector) {
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

async function queryAll(selector) {
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

async function screenshot(filename = 'debug-screenshot.png') {
  if (!session) throw new Error('Not connected');
  
  const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(filename, Buffer.from(data, 'base64'));
  console.log(`Screenshot saved: ${filename}`);
  return filename;
}

async function setFiles(selector, filePaths) {
  if (!session) throw new Error('Not connected');
  
  const { root } = await session.send('DOM.getDocument');
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`Element not found: ${selector}`);
  
  const { node } = await session.send('DOM.describeNode', { nodeId });
  
  await session.send('DOM.setFileInputFiles', {
    files: filePaths,
    backendNodeId: node.backendNodeId,
  });
  
  console.log('Files set:', filePaths);
  return true;
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
  const result = await e(`
    (() => {
      const radio = document.querySelector('button[role="radio"][aria-checked="true"]');
      return radio ? radio.getAttribute('value') : null;
    })()
  `);
  console.log('Current mode:', result);
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

async function clickModelSelector() {
  const result = await e(`
    (() => {
      const cpuUse = Array.from(document.querySelectorAll('use')).find(u => 
        u.getAttribute('xlink:href')?.includes('cpu') && 
        u.closest('button')?.getAttribute('aria-haspopup') !== 'dialog'
      );
      const btn = cpuUse?.closest('button');
      if (btn) {
        btn.click();
        return { clicked: true, aria: btn.getAttribute('aria-label') };
      }
      return { clicked: false };
    })()
  `);
  console.log(result);
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
        '[role="listbox"] [role="option"]',
        '[role="menu"] button',
        '[role="menu"] div[tabindex]',
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
  console.log('\n=== Model Selector Candidates ===');
  await findModelSelector();
  
  console.log('\n=== Clicking Model Selector ===');
  await clickModelSelector();
  
  await new Promise(r => setTimeout(r, 500));
  
  console.log('\n=== Menu Items ===');
  await listMenuItems();
  
  console.log('\n=== All visible menus ===');
  const menus = await e(`
    Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], .shadow-overlay')).map(el => ({
      role: el.getAttribute('role'),
      class: (el.className || '').slice(0, 50),
      children: el.children.length,
      visible: el.getBoundingClientRect().width > 0,
    }))
  `);
  console.table(menus);
}

async function startComet() {
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

async function startREPL() {
  global.connect = connect;
  global.listTargets = listTargets;
  global.connectTo = connectTo;
  global.e = e;
  global.js = e;
  global.html = html;
  global.text = text;
  global.click = click;
  global.queryAll = queryAll;
  global.setFiles = setFiles;
  global.findFileInputs = findFileInputs;
  global.screenshot = screenshot;
  global.startComet = startComet;
  global.getCurrentMode = getCurrentMode;
  global.findModelSelector = findModelSelector;
  global.clickModelSelector = clickModelSelector;
  global.listMenuItems = listMenuItems;
  global.inspectModelMenu = inspectModelMenu;
  
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║        CDP REPL for Comet (puppeteer-core)                ║
╠═══════════════════════════════════════════════════════════╣
║  await startComet()       - Start Comet if not running    ║
║  await listTargets()      - List all browser tabs         ║
║  await connect()          - Connect to Perplexity tab     ║
║  await connectTo(0)       - Connect to tab by index       ║
║                                                           ║
║  await e('...')           - Evaluate JS in page           ║
║  await html('selector')   - Get element HTML              ║
║  await text('selector')   - Get element text              ║
║  await click('selector')  - Click element                 ║
║  await queryAll('sel')    - List all matching elements    ║
║  await screenshot()       - Save screenshot               ║
║                                                           ║
║  === Model Selector ===                                   ║
║  await getCurrentMode()      - Get current mode           ║
║  await findModelSelector()   - Find model selector btn    ║
║  await clickModelSelector()  - Click to open model menu   ║
║  await listMenuItems()       - List visible menu items    ║
║  await inspectModelMenu()    - Full model menu inspection ║
║                                                           ║
║  === File Upload ===                                      ║
║  await findFileInputs()   - Find all file inputs          ║
║  await setFiles('input[type="file"]', ['/path/file.png']) ║
╚═══════════════════════════════════════════════════════════╝
`);

  const repl = await import('repl');
  const r = repl.start({
    prompt: 'cdp> ',
    useGlobal: true,
  });
  
  r.on('exit', () => {
    if (browser) browser.disconnect();
    process.exit(0);
  });
}

startREPL().catch(console.error);
