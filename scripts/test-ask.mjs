#!/usr/bin/env node
/**
 * Test the core ask() functionality
 * This is the most critical test - sending prompts and receiving responses
 * Run: node scripts/test-ask.mjs
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

async function runTest() {
  log('\n╔═══════════════════════════════════════════════════════╗', colors.cyan);
  log('║       CometAI ask() End-to-End Test                    ║', colors.cyan);
  log('╚═══════════════════════════════════════════════════════╝', colors.cyan);

  const { cometClient } = await import('../dist/cdp-client.js');
  const { cometAI } = await import('../dist/comet-ai.js');
  
  // Connect first
  log('\n1. Connecting to Comet...', colors.cyan);
  const connectResult = await cometClient.connect();
  log(`   ${colors.dim}${connectResult}${colors.reset}`);

  // Check initial state
  log('\n2. Checking initial state...', colors.cyan);
  const status = await cometAI.getAgentStatus();
  log(`   ${colors.dim}Status: ${status.status}, responseLength: ${status.responseLength}${colors.reset}`);

  // Clear conversation for clean test
  log('\n3. Clearing conversation...', colors.cyan);
  const clearResult = await cometAI.clearConversation();
  log(`   ${colors.dim}Cleared: ${clearResult}${colors.reset}`);

  // Wait a moment for UI to settle
  await new Promise(r => setTimeout(r, 1000));

  // Send a simple prompt using step-by-step approach for debugging
  log('\n4. Sending test prompt step by step...', colors.cyan);
  const startTime = Date.now();
  
  try {
    // Step 4a: Send the prompt
    log('   4a. Calling sendPrompt()...', colors.dim);
    const sendResult = await cometAI.sendPrompt("What is 2+2? Reply with just the number.");
    log(`   ${colors.dim}sendPrompt result: ${sendResult}${colors.reset}`);
    
    // Step 4b: Wait a moment
    log('   4b. Waiting 2 seconds for response to start...', colors.dim);
    await new Promise(r => setTimeout(r, 2000));
    
    // Step 4c: Check if loading
    const isLoading = await cometAI.isLoading();
    log(`   ${colors.dim}isLoading: ${isLoading}${colors.reset}`);
    
    // Step 4d: Get status
    const midStatus = await cometAI.getAgentStatus();
    log(`   ${colors.dim}midStatus: ${midStatus.status}, responseLen: ${midStatus.responseLength}${colors.reset}`);
    
    // Step 4e: Wait for response
    log('   4e. Waiting for response (30s timeout)...', colors.dim);
    const response = await cometAI.waitForResponse(30000);
    
    const elapsed = Date.now() - startTime;
    
    log('\n5. Response received:', colors.cyan);
    log(`   ${colors.dim}Status: ${response.status}${colors.reset}`);
    log(`   ${colors.dim}Elapsed: ${elapsed}ms${colors.reset}`);
    log(`   ${colors.dim}Response length: ${response.text?.length || 0} chars${colors.reset}`);
    
    // Show first 200 chars of response
    const preview = response.text?.slice(0, 200)?.replace(/\n/g, ' ') || '(empty)';
    log(`   ${colors.dim}Preview: ${preview}${colors.reset}`);
    
    // Validate response contains "4"
    if (response.text?.includes('4')) {
      log('\n✓ TEST PASSED - Response contains expected answer "4"', colors.green);
    } else {
      log('\n⚠ TEST WARNING - Response may not contain expected answer "4"', colors.yellow);
      log(`   ${colors.dim}Full response: ${response.text}${colors.reset}`);
    }
    
  } catch (error) {
    log(`\n✗ TEST FAILED: ${error.message}`, colors.red);
    console.error(error);
  }

  // Cleanup
  log('\n6. Disconnecting...', colors.cyan);
  await cometClient.disconnect();
  log('   Done', colors.dim);
}

runTest().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
