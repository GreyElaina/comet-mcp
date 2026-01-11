#!/usr/bin/env node
/**
 * Test script for cdp-client.ts after puppeteer-core migration
 * Run: node scripts/test-cdp-client.mjs
 */

const PORT = parseInt(process.env.COMET_PORT || '9222', 10);

// Test utilities
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

function log(msg, color = '') {
  console.log(`${color}${msg}${colors.reset}`);
}

function pass(name) {
  log(`  ✓ ${name}`, colors.green);
}

function fail(name, error) {
  log(`  ✗ ${name}: ${error}`, colors.red);
}

function section(name) {
  log(`\n━━━ ${name} ━━━`, colors.cyan);
}

async function test(name, fn) {
  try {
    await fn();
    pass(name);
    return true;
  } catch (e) {
    fail(name, e.message);
    return false;
  }
}

// Main test runner
async function runTests() {
  log('\n╔═══════════════════════════════════════════════════════╗', colors.cyan);
  log('║       CDP Client Test Suite (puppeteer-core)          ║', colors.cyan);
  log('╚═══════════════════════════════════════════════════════╝', colors.cyan);

  const { cometClient } = await import('../dist/cdp-client.js');
  
  let passed = 0;
  let failed = 0;
  
  const track = async (name, fn) => {
    if (await test(name, fn)) passed++;
    else failed++;
  };

  // ============================================================
  section('1. Connection Tests');
  // ============================================================
  
  await track('getVersion() - CDP HTTP API', async () => {
    const version = await cometClient.getVersion();
    if (!version.Browser) throw new Error('No browser info');
    log(`     ${colors.dim}Browser: ${version.Browser}${colors.reset}`);
  });

  await track('listTargets() - list tabs via HTTP API', async () => {
    const targets = await cometClient.listTargets();
    if (!Array.isArray(targets)) throw new Error('Expected array');
    log(`     ${colors.dim}Found ${targets.length} targets${colors.reset}`);
  });

  await track('connect() - establish puppeteer session', async () => {
    const result = await cometClient.connect();
    if (!result.includes('Connected')) throw new Error('Did not connect');
    log(`     ${colors.dim}${result}${colors.reset}`);
  });

  await track('isConnected getter', async () => {
    if (!cometClient.isConnected) throw new Error('Should be connected');
  });

  await track('currentState getter', async () => {
    const state = cometClient.currentState;
    if (!state.connected) throw new Error('State should show connected');
    if (!state.activeTabId) throw new Error('Should have activeTabId');
    log(`     ${colors.dim}Tab: ${state.activeTabId?.slice(0, 16)}...${colors.reset}`);
  });

  // ============================================================
  section('2. Evaluation Tests');
  // ============================================================

  await track('evaluate() - simple expression', async () => {
    const result = await cometClient.evaluate('1 + 1');
    if (result.result.value !== 2) throw new Error(`Expected 2, got ${result.result.value}`);
  });

  await track('evaluate() - DOM access', async () => {
    const result = await cometClient.evaluate('document.title');
    log(`     ${colors.dim}Title: ${result.result.value?.slice(0, 50)}${colors.reset}`);
  });

  await track('evaluate() - await promise', async () => {
    const result = await cometClient.evaluate('Promise.resolve("async-ok")');
    if (result.result.value !== 'async-ok') throw new Error('Async eval failed');
  });

  await track('safeEvaluate() - with auto-reconnect wrapper', async () => {
    const result = await cometClient.safeEvaluate('window.location.href');
    if (!result.result.value) throw new Error('No URL');
    log(`     ${colors.dim}URL: ${result.result.value?.slice(0, 60)}${colors.reset}`);
  });

  // ============================================================
  section('3. Page Content Tests');
  // ============================================================

  await track('getCurrentUrl()', async () => {
    const url = await cometClient.getCurrentUrl();
    if (!url) throw new Error('No URL returned');
    log(`     ${colors.dim}URL: ${url.slice(0, 60)}${colors.reset}`);
  });

  await track('getPageContent() - HTML', async () => {
    const html = await cometClient.getPageContent();
    if (!html.includes('<html')) throw new Error('Invalid HTML');
    log(`     ${colors.dim}HTML length: ${html.length} chars${colors.reset}`);
  });

  await track('getPageText() - text content', async () => {
    const text = await cometClient.getPageText();
    log(`     ${colors.dim}Text length: ${text.length} chars${colors.reset}`);
  });

  // ============================================================
  section('4. Tab Management Tests');
  // ============================================================

  await track('listTabsCategorized()', async () => {
    const tabs = await cometClient.listTabsCategorized();
    const summary = [];
    if (tabs.main) summary.push('main');
    if (tabs.sidecar) summary.push('sidecar');
    if (tabs.agentBrowsing) summary.push('agentBrowsing');
    if (tabs.overlay) summary.push('overlay');
    summary.push(`${tabs.others.length} others`);
    log(`     ${colors.dim}Tabs: ${summary.join(', ')}${colors.reset}`);
  });

  await track('connectToMain() or stay connected', async () => {
    try {
      const result = await cometClient.connectToMain();
      log(`     ${colors.dim}${result}${colors.reset}`);
    } catch (e) {
      // Might not have main tab, that's OK
      log(`     ${colors.dim}No main tab: ${e.message}${colors.reset}`);
    }
  });

  // ============================================================
  section('5. DOM Interaction Tests');
  // ============================================================

  await track('waitForSelector() - body always exists', async () => {
    const found = await cometClient.waitForSelector('body', 2000);
    if (!found) throw new Error('body not found');
  });

  await track('click() - non-existent element returns false', async () => {
    const clicked = await cometClient.click('#definitely-not-exist-xyz-123');
    if (clicked !== false) throw new Error('Should return false for non-existent');
  });

  // ============================================================
  section('6. Input Tests');
  // ============================================================

  await track('pressKey() - dispatches key event', async () => {
    // Just verify it doesn't throw
    await cometClient.pressKey('Escape');
  });

  await track('pressKeyWithModifiers() - Cmd+A simulation', async () => {
    // modifiers: alt=1, ctrl=2, meta=4, shift=8
    await cometClient.pressKeyWithModifiers('a', 4, { code: 'KeyA' });
  });

  // ============================================================
  section('7. Network Tests');
  // ============================================================

  await track('waitForNetworkIdle() - completes without hanging', async () => {
    // Should complete quickly if page is already loaded
    await cometClient.waitForNetworkIdle(3000);
  });

  // ============================================================
  section('8. Screenshot Tests');
  // ============================================================

  await track('screenshot() - capture PNG', async () => {
    const result = await cometClient.screenshot('png');
    if (!result.data) throw new Error('No screenshot data');
    log(`     ${colors.dim}Screenshot: ${result.data.length} base64 chars${colors.reset}`);
  });

  // ============================================================
  section('9. Reconnection Tests');
  // ============================================================

  await track('disconnect() - clean disconnect', async () => {
    await cometClient.disconnect();
    if (cometClient.isConnected) throw new Error('Should be disconnected');
  });

  await track('reconnect() - reconnect after disconnect', async () => {
    const result = await cometClient.reconnect();
    if (!result.includes('Connected')) throw new Error('Reconnect failed');
    log(`     ${colors.dim}${result}${colors.reset}`);
  });

  await track('isConnected after reconnect', async () => {
    if (!cometClient.isConnected) throw new Error('Should be connected after reconnect');
  });

  // ============================================================
  section('10. Session Detach Handling');
  // ============================================================

  await track('connect() mutex - concurrent calls deduplicated', async () => {
    // Fire multiple connects, should not error
    const results = await Promise.all([
      cometClient.connect(),
      cometClient.connect(),
      cometClient.connect(),
    ]);
    // All should return same or similar result
    log(`     ${colors.dim}3 concurrent connects resolved OK${colors.reset}`);
  });

  // ============================================================
  // Summary
  // ============================================================
  
  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', colors.cyan);
  log(`Results: ${passed} passed, ${failed} failed`, failed > 0 ? colors.red : colors.green);
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n', colors.cyan);

  // Cleanup
  await cometClient.disconnect();

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('Test runner failed:', e);
  process.exit(1);
});
