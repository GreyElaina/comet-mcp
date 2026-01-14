#!/usr/bin/env npx tsx
// Run: npx tsx scripts/stress-test-reset.ts

import { resetState } from "../src/concurrency/reset-state.js";

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  details: string;
}

const results: TestResult[] = [];

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
}

function logSection(title: string) {
  console.log("\n" + "=".repeat(60));
  console.log(`  ${title}`);
  console.log("=".repeat(60) + "\n");
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function simulateReset(label: string): Promise<{ status: string; phase?: string; elapsedMs?: number }> {
  log(`[${label}] Starting reset...`);

  if (resetState.isResetting()) {
    log(`[${label}] Already resetting, returning early`);
    return { status: "already_resetting" };
  }

  resetState.beginReset();
  const startTime = Date.now();

  try {
    await delay(100);
    await delay(100);
    await delay(100);
    await delay(100);
    await delay(100);

    const elapsed = Date.now() - startTime;
    log(`[${label}] Reset completed in ${elapsed}ms`);
    return { status: "connected", phase: "stateQuery", elapsedMs: elapsed };
  } finally {
    resetState.endReset();
  }
}

async function simulatePoll(label: string): Promise<{ status: string; reason?: string }> {
  log(`[${label}] Polling...`);

  if (resetState.isResetting()) {
    log(`[${label}] Reset in progress, returning blocked`);
    return { status: "blocked", reason: "reset in progress" };
  }

  await delay(50);
  return { status: "idle" };
}

async function simulateAsk(label: string): Promise<{ status: string; reason?: string }> {
  log(`[${label}] Asking...`);

  if (resetState.isResetting()) {
    log(`[${label}] Reset in progress, returning blocked`);
    return { status: "blocked", reason: "reset in progress" };
  }

  await delay(50);
  return { status: "complete" };
}

async function testConcurrentResets(): Promise<TestResult> {
  logSection("Test 1: Concurrent Reset Calls");
  const start = Date.now();

  try {
    const [result1, result2] = await Promise.all([
      simulateReset("reset-1"),
      simulateReset("reset-2"),
    ]);

    log(`Reset 1 result: ${JSON.stringify(result1)}`);
    log(`Reset 2 result: ${JSON.stringify(result2)}`);

    const statuses = [result1.status, result2.status].sort();
    const expected = ["already_resetting", "connected"];

    const passed = JSON.stringify(statuses) === JSON.stringify(expected);

    return {
      name: "Concurrent Reset Calls",
      passed,
      duration: Date.now() - start,
      details: passed
        ? "One reset succeeded, one returned already_resetting"
        : `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(statuses)}`,
    };
  } catch (error) {
    return {
      name: "Concurrent Reset Calls",
      passed: false,
      duration: Date.now() - start,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function testResetWithPoll(): Promise<TestResult> {
  logSection("Test 2: Reset + Poll Concurrent");
  const start = Date.now();

  try {
    const resetPromise = simulateReset("reset");
    await delay(10);

    const pollResult = await simulatePoll("poll");
    const resetResult = await resetPromise;

    log(`Reset result: ${JSON.stringify(resetResult)}`);
    log(`Poll result: ${JSON.stringify(pollResult)}`);

    const passed =
      resetResult.status === "connected" && pollResult.status === "blocked";

    return {
      name: "Reset + Poll Concurrent",
      passed,
      duration: Date.now() - start,
      details: passed
        ? "Reset succeeded, poll was blocked"
        : `Reset: ${resetResult.status}, Poll: ${pollResult.status}`,
    };
  } catch (error) {
    return {
      name: "Reset + Poll Concurrent",
      passed: false,
      duration: Date.now() - start,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function testResetWithAsk(): Promise<TestResult> {
  logSection("Test 3: Reset + Ask Concurrent");
  const start = Date.now();

  try {
    const resetPromise = simulateReset("reset");
    await delay(10);

    const askResult = await simulateAsk("ask");
    const resetResult = await resetPromise;

    log(`Reset result: ${JSON.stringify(resetResult)}`);
    log(`Ask result: ${JSON.stringify(askResult)}`);

    const passed =
      resetResult.status === "connected" && askResult.status === "blocked";

    return {
      name: "Reset + Ask Concurrent",
      passed,
      duration: Date.now() - start,
      details: passed
        ? "Reset succeeded, ask was blocked"
        : `Reset: ${resetResult.status}, Ask: ${askResult.status}`,
    };
  } catch (error) {
    return {
      name: "Reset + Ask Concurrent",
      passed: false,
      duration: Date.now() - start,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function testSequentialResets(): Promise<TestResult> {
  logSection("Test 4: Sequential Resets");
  const start = Date.now();

  try {
    const result1 = await simulateReset("reset-1");
    log(`First reset result: ${JSON.stringify(result1)}`);

    const result2 = await simulateReset("reset-2");
    log(`Second reset result: ${JSON.stringify(result2)}`);

    const passed =
      result1.status === "connected" && result2.status === "connected";

    return {
      name: "Sequential Resets",
      passed,
      duration: Date.now() - start,
      details: passed
        ? "Both sequential resets succeeded"
        : `First: ${result1.status}, Second: ${result2.status}`,
    };
  } catch (error) {
    return {
      name: "Sequential Resets",
      passed: false,
      duration: Date.now() - start,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function testMultiplePollsDuringReset(): Promise<TestResult> {
  logSection("Test 5: Multiple Polls During Reset");
  const start = Date.now();

  try {
    const resetPromise = simulateReset("reset");
    await delay(10);

    const pollResults = await Promise.all([
      simulatePoll("poll-1"),
      simulatePoll("poll-2"),
      simulatePoll("poll-3"),
    ]);

    const resetResult = await resetPromise;

    log(`Reset result: ${JSON.stringify(resetResult)}`);
    pollResults.forEach((r, i) => log(`Poll ${i + 1} result: ${JSON.stringify(r)}`));

    const allPollsBlocked = pollResults.every((r) => r.status === "blocked");
    const passed = resetResult.status === "connected" && allPollsBlocked;

    return {
      name: "Multiple Polls During Reset",
      passed,
      duration: Date.now() - start,
      details: passed
        ? "Reset succeeded, all polls were blocked"
        : `Reset: ${resetResult.status}, Polls blocked: ${pollResults.filter((r) => r.status === "blocked").length}/3`,
    };
  } catch (error) {
    return {
      name: "Multiple Polls During Reset",
      passed: false,
      duration: Date.now() - start,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function testPollAfterReset(): Promise<TestResult> {
  logSection("Test 6: Poll After Reset Completes");
  const start = Date.now();

  try {
    const resetResult = await simulateReset("reset");
    log(`Reset result: ${JSON.stringify(resetResult)}`);

    const pollResult = await simulatePoll("poll");
    log(`Poll result: ${JSON.stringify(pollResult)}`);

    const passed =
      resetResult.status === "connected" && pollResult.status === "idle";

    return {
      name: "Poll After Reset Completes",
      passed,
      duration: Date.now() - start,
      details: passed
        ? "Reset succeeded, subsequent poll worked normally"
        : `Reset: ${resetResult.status}, Poll: ${pollResult.status}`,
    };
  } catch (error) {
    return {
      name: "Poll After Reset Completes",
      passed: false,
      duration: Date.now() - start,
      details: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function runAllTests() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           comet_reset Concurrency Stress Test                 ║
╚═══════════════════════════════════════════════════════════════╝
`);

  log("Starting stress tests...\n");

  results.push(await testConcurrentResets());
  await delay(100);

  results.push(await testResetWithPoll());
  await delay(100);

  results.push(await testResetWithAsk());
  await delay(100);

  results.push(await testSequentialResets());
  await delay(100);

  results.push(await testMultiplePollsDuringReset());
  await delay(100);

  results.push(await testPollAfterReset());

  logSection("Test Results Summary");

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  results.forEach((r) => {
    const status = r.passed ? "✅ PASS" : "❌ FAIL";
    console.log(`${status} | ${r.name} (${r.duration}ms)`);
    console.log(`       ${r.details}\n`);
  });

  console.log("─".repeat(60));
  console.log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log("─".repeat(60));

  if (failed > 0) {
    console.log("\n⚠️  Some tests failed. Review the details above.");
    process.exit(1);
  } else {
    console.log("\n✅ All tests passed!");
    process.exit(0);
  }
}

runAllTests().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
