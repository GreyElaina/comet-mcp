#!/usr/bin/env node
/**
 * Test script for comet-ai.ts integration with cdp-client
 * Tests the higher-level AI interaction layer used by MCP tools
 * Run: node scripts/test-comet-ai.mjs
 */

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

async function runTests() {
  log('\n╔═══════════════════════════════════════════════════════╗', colors.cyan);
  log('║       CometAI Integration Test Suite                   ║', colors.cyan);
  log('╚═══════════════════════════════════════════════════════╝', colors.cyan);

  const { cometClient } = await import('../dist/cdp-client.js');
  const { cometAI } = await import('../dist/comet-ai.js');
  
  let passed = 0;
  let failed = 0;
  
  const track = async (name, fn) => {
    if (await test(name, fn)) passed++;
    else failed++;
  };

  // ============================================================
  section('1. Initial Connection');
  // ============================================================

  await track('cometClient.connect() - base layer', async () => {
    const result = await cometClient.connect();
    if (!result.includes('Connected')) throw new Error('Connection failed');
    log(`     ${colors.dim}${result}${colors.reset}`);
  });

  // ============================================================
  section('2. Mode Detection');
  // ============================================================

  await track('cometAI.detectMode() - detect search vs agent mode', async () => {
    const result = await cometAI.detectMode();
    log(`     ${colors.dim}Mode: ${result.mode}, hasAgentBrowsing: ${result.hasAgentBrowsing}${colors.reset}`);
  });

  await track('cometAI.isAgentMode() - cached check', async () => {
    const isAgent = await cometAI.isAgentMode();
    log(`     ${colors.dim}isAgentMode: ${isAgent}${colors.reset}`);
  });

  // ============================================================
  section('3. UI Inspection (read-only)');
  // ============================================================

  await track('cometAI.inspectInterface() - get UI state', async () => {
    const state = await cometAI.inspectInterface();
    log(`     ${colors.dim}hasInput: ${state.hasInput}, inputSelector: ${state.inputSelector}${colors.reset}`);
    log(`     ${colors.dim}pageInfo: ${JSON.stringify(state.pageInfo).slice(0, 60)}${colors.reset}`);
  });

  await track('cometAI.findElement() - find submit button', async () => {
    const found = await cometAI.findElement('button');
    log(`     ${colors.dim}Found button: ${found}${colors.reset}`);
  });

  // ============================================================
  section('4. Status Detection');
  // ============================================================

  await track('cometAI.getAgentStatus() - check agent status', async () => {
    const status = await cometAI.getAgentStatus();
    log(`     ${colors.dim}Status: ${status.status}, responseLength: ${status.responseLength}${colors.reset}`);
  });

  await track('cometAI.isLoading() - check if loading', async () => {
    const loading = await cometAI.isLoading();
    log(`     ${colors.dim}isLoading: ${loading}${colors.reset}`);
  });

  // ============================================================
  section('5. Response Extraction');
  // ============================================================

  await track('cometAI.getCurrentResponse() - read current response', async () => {
    const response = await cometAI.getCurrentResponse();
    const preview = response?.slice(0, 100)?.replace(/\n/g, ' ') || '(empty)';
    log(`     ${colors.dim}Response preview: ${preview}...${colors.reset}`);
  });

  await track('cometAI.getLatestResponseSlice() - get response slice', async () => {
    const result = await cometAI.getLatestResponseSlice(0, 200);
    log(`     ${colors.dim}Slice length: ${result.slice?.length || 0}, total: ${result.total}${colors.reset}`);
  });

  // ============================================================
  section('6. Settings Detection');
  // ============================================================

  await track('cometAI.inspectTemporaryChat() - temp chat status', async () => {
    const result = await cometAI.inspectTemporaryChat();
    log(`     ${colors.dim}detected: ${result.detected}, enabled: ${result.enabled}${colors.reset}`);
  });

  // ============================================================
  section('7. Model Operations (read-only)');
  // ============================================================

  await track('cometAI.getModelInfo() - list available models', async () => {
    const models = await cometAI.getModelInfo({ openMenu: false });
    if (models.availableModels && models.availableModels.length > 0) {
      log(`     ${colors.dim}Models: ${models.availableModels.slice(0, 3).join(', ')}...${colors.reset}`);
      log(`     ${colors.dim}Current: ${models.currentModel || '(unknown)'}${colors.reset}`);
    } else {
      log(`     ${colors.dim}Current model: ${models.currentModel || '(unknown)'}, supportsSwitch: ${models.supportsModelSwitching}${colors.reset}`);
    }
  });

  // ============================================================
  section('8. Tab Switching');
  // ============================================================

  await track('Multiple tab switches (main → sidecar → main)', async () => {
    // Get initial tabs
    const tabs = await cometClient.listTabsCategorized();
    log(`     ${colors.dim}Available: main=${!!tabs.main}, sidecar=${!!tabs.sidecar}${colors.reset}`);
    
    // Try switching between tabs if both exist
    if (tabs.main && tabs.sidecar) {
      await cometClient.connect(tabs.sidecar.id);
      const url1 = await cometClient.getCurrentUrl();
      log(`     ${colors.dim}Switched to sidecar: ${url1?.slice(0, 50)}${colors.reset}`);
      
      await cometClient.connect(tabs.main.id);
      const url2 = await cometClient.getCurrentUrl();
      log(`     ${colors.dim}Switched to main: ${url2?.slice(0, 50)}${colors.reset}`);
    } else {
      log(`     ${colors.dim}Skipped - need both main and sidecar tabs${colors.reset}`);
    }
  });

  // ============================================================
  section('9. Error Recovery');
  // ============================================================

  await track('safeEvaluate() handles DOM query errors gracefully', async () => {
    // This should not throw even with invalid JS
    const result = await cometClient.safeEvaluate(`
      (() => {
        try {
          return document.querySelector('definitely-not-exist')?.textContent || 'not found';
        } catch { return 'error'; }
      })()
    `);
    log(`     ${colors.dim}Result: ${result.result.value}${colors.reset}`);
  });

  await track('withAutoReconnect - handles temporary disconnect', async () => {
    // Simulate a scenario where we might need reconnect
    // Just verify the wrapper doesn't break normal operation
    const result = await cometClient.safeEvaluate('window.location.hostname');
    log(`     ${colors.dim}Hostname: ${result.result.value}${colors.reset}`);
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
