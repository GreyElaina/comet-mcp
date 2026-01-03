// Comet AI interaction module
// Handles sending prompts to Comet's AI assistant and reading responses

import { cometClient } from "./cdp-client.js";
import type { CometAIResponse } from "./types.js";

// Selectors for Perplexity/Comet AI interface
const SELECTORS = {
  // Input selectors - contenteditable div is primary for Perplexity
  input: [
    '[contenteditable="true"]',
    'textarea[placeholder*="Ask"]',
    'textarea[placeholder*="Search"]',
    'textarea',
    'input[type="text"]',
  ],
  // Response/output selectors for Perplexity
  response: [
    '[class*="prose"]',
    'main article',
    '[data-testid*="answer"]',
    '[class*="answer"]',
    '[class*="response"]',
  ],
  // Loading indicator selectors
  loading: [
    '[class*="animate-pulse"]',
    '[class*="loading"]',
    '[class*="thinking"]',
    '.spinner',
  ],
  // Submit button selectors - Perplexity uses arrow button
  submit: [
    'button[aria-label*="Submit"]',
    'button[aria-label*="Send"]',
    'button[type="submit"]',
    'button svg[class*="arrow"]',
  ],
};

export class CometAI {
  private lastResponseText: string = "";

  /**
   * Find the first matching element from a list of selectors
   */
  async findElement(selectors: string[]): Promise<string | null> {
    for (const selector of selectors) {
      const result = await cometClient.evaluate(`
        document.querySelector(${JSON.stringify(selector)}) !== null
      `);
      if (result.result.value === true) {
        return selector;
      }
    }
    return null;
  }

  /**
   * Get information about Comet's AI interface
   */
  async inspectInterface(): Promise<{
    inputSelector: string | null;
    responseSelector: string | null;
    hasInput: boolean;
    pageInfo: string;
  }> {
    const inputSelector = await this.findElement(SELECTORS.input);
    const responseSelector = await this.findElement(SELECTORS.response);

    // Get general page info
    const pageInfoResult = await cometClient.evaluate(`
      JSON.stringify({
        url: window.location.href,
        title: document.title,
        textareas: document.querySelectorAll('textarea').length,
        inputs: document.querySelectorAll('input').length,
        contentEditables: document.querySelectorAll('[contenteditable="true"]').length,
        buttons: document.querySelectorAll('button').length,
      })
    `);

    return {
      inputSelector,
      responseSelector,
      hasInput: inputSelector !== null,
      pageInfo: pageInfoResult.result.value as string,
    };
  }

  /**
   * Send a prompt to Comet's AI (Perplexity)
   */
  async sendPrompt(prompt: string): Promise<string> {
    const inputSelector = await this.findElement(SELECTORS.input);

    if (!inputSelector) {
      throw new Error(
        "Could not find input element. Navigate to Perplexity first."
      );
    }

    // Use execCommand for contenteditable elements (works with React/Vue)
    const result = await cometClient.evaluate(`
      (() => {
        const el = document.querySelector('[contenteditable="true"]');
        if (el) {
          el.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, ${JSON.stringify(prompt)});
          return { success: true, text: el.innerText };
        }
        // Fallback for textarea
        const textarea = document.querySelector('textarea');
        if (textarea) {
          textarea.focus();
          textarea.value = ${JSON.stringify(prompt)};
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return { success: true, text: textarea.value };
        }
        return { success: false };
      })()
    `);

    const typed = (result.result.value as { success: boolean })?.success;
    if (!typed) {
      throw new Error("Failed to type into input element");
    }

    // Submit the prompt
    await this.submitPrompt();

    return `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"`;
  }

  /**
   * Submit the current prompt
   */
  private async submitPrompt(): Promise<void> {
    // Find and click submit button (Perplexity uses an arrow button)
    const result = await cometClient.evaluate(`
      (() => {
        // Try various submit button patterns
        const selectors = [
          'button[aria-label*="Submit"]',
          'button[aria-label*="Send"]',
          'button[type="submit"]',
        ];
        for (const sel of selectors) {
          const btn = document.querySelector(sel);
          if (btn) {
            btn.click();
            return { clicked: true, selector: sel };
          }
        }
        // Try finding button with arrow SVG (common pattern)
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.querySelector('svg') && btn.closest('[class*="input"], [class*="search"]')) {
            btn.click();
            return { clicked: true, selector: 'svg button' };
          }
        }
        return { clicked: false };
      })()
    `);

    const clicked = (result.result.value as { clicked: boolean })?.clicked;
    if (!clicked) {
      // Fallback: press Enter
      await cometClient.pressKey("Enter");
    }
  }

  /**
   * Check if Comet AI is currently processing/loading
   */
  async isLoading(): Promise<boolean> {
    const loadingSelector = await this.findElement(SELECTORS.loading);
    return loadingSelector !== null;
  }

  /**
   * Wait for Comet AI to finish responding
   */
  async waitForResponse(timeout: number = 30000): Promise<CometAIResponse> {
    const startTime = Date.now();
    let lastText = "";
    let stableCount = 0;

    // Wait for page to start loading response
    await new Promise(resolve => setTimeout(resolve, 2000));

    while (Date.now() - startTime < timeout) {
      // Get response text from Perplexity's answer area
      const result = await cometClient.evaluate(`
        (() => {
          // Look for the main answer content
          const proseEl = document.querySelector('[class*="prose"]');
          if (proseEl) return proseEl.innerText;

          // Alternative: look for answer section
          const mainText = document.body.innerText;
          const answerMatch = mainText.match(/Reviewed \\d+ sources[\\s\\S]*?(?=Related|Ask a follow-up|$)/);
          if (answerMatch) return answerMatch[0];

          return "";
        })()
      `);

      const currentText = (result.result.value as string) || "";

      // Check if response has stabilized (text same for 3 consecutive checks)
      if (currentText.length > 10 && currentText === lastText) {
        stableCount++;
        if (stableCount >= 3) {
          this.lastResponseText = currentText;
          return {
            text: currentText,
            complete: true,
            timestamp: Date.now(),
          };
        }
      } else {
        stableCount = 0;
      }

      lastText = currentText;
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Timeout - return whatever we have
    return {
      text: lastText || "No response detected within timeout",
      complete: false,
      timestamp: Date.now(),
    };
  }

  /**
   * Send prompt and wait for response
   */
  async ask(prompt: string, timeout: number = 30000): Promise<CometAIResponse> {
    await this.sendPrompt(prompt);

    // Wait a bit for the response to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    return this.waitForResponse(timeout);
  }

  /**
   * Get the current visible response text
   */
  async getCurrentResponse(): Promise<string> {
    const responseSelector = await this.findElement(SELECTORS.response);

    if (!responseSelector) {
      // Try to get any visible text that looks like a response
      const result = await cometClient.evaluate(`
        // Look for the main content area
        const contentAreas = document.querySelectorAll('main, article, [role="main"], .content');
        for (const area of contentAreas) {
          if (area.innerText.length > 100) {
            return area.innerText;
          }
        }
        return document.body.innerText.substring(0, 5000);
      `);
      return result.result.value as string;
    }

    const result = await cometClient.evaluate(`
      document.querySelector(${JSON.stringify(responseSelector)})?.innerText || ""
    `);
    return result.result.value as string;
  }

  /**
   * Clear the current conversation/input
   */
  async clearConversation(): Promise<boolean> {
    const result = await cometClient.evaluate(`
      (function() {
        const clearButtons = document.querySelectorAll(
          'button[aria-label*="Clear"], button[aria-label*="New"], [class*="clear"], [class*="new-chat"]'
        );
        for (const btn of clearButtons) {
          btn.click();
          return true;
        }
        return false;
      })()
    `);
    return result.result.value as boolean;
  }

  /**
   * Get current agent status and progress (for polling)
   * Improved: Checks for stop button visibility, handles sidecar vs main tab,
   * extracts response from current task context
   */
  async getAgentStatus(): Promise<{
    status: "idle" | "working" | "completed";
    steps: string[];
    currentStep: string;
    response: string;
    hasStopButton: boolean;
    agentBrowsingUrl: string;
  }> {
    // First try to connect to sidecar tab for agent status
    try {
      const tabs = await cometClient.listTabsCategorized();
      if (tabs.sidecar) {
        await cometClient.connect(tabs.sidecar.id);
      }
    } catch {
      // Continue with current connection
    }

    const result = await cometClient.safeEvaluate(`
      (() => {
        const body = document.body.innerText;

        // CRITICAL: Check for ACTIVE stop button (square icon) - most reliable indicator of working state
        const stopButton = document.querySelector('button svg rect, button[aria-label*="Stop"]');
        const hasActiveStopButton = stopButton !== null &&
          stopButton.closest('button')?.offsetParent !== null; // Check if visible

        // Check for "Add details to this task" input - indicates agent mode is active and accepting input
        const hasTaskInput = body.includes('Add details to this task');

        // Check for completion indicators in the LATEST response section only
        // Look for the response area that's NOT in the sidebar/history
        const mainContent = document.querySelector('main, [role="main"], .content');
        const mainText = mainContent ? mainContent.innerText : body;

        // Check if response has "N steps completed" - indicates agent task finished
        const stepsCompletedMatch = mainText.match(/(\\d+) steps completed/);
        const hasStepsCompleted = stepsCompletedMatch !== null;

        // Check for "Finished" marker that appears after agent completes
        const finishedMarkers = document.querySelectorAll('*');
        let hasFinishedMarker = false;
        for (const el of finishedMarkers) {
          if (el.textContent === 'Finished' && el.offsetParent !== null) {
            hasFinishedMarker = true;
            break;
          }
        }

        // "Reviewed N sources" without active stop button means completed
        const hasReviewedSources = /Reviewed \\d+ sources/.test(mainText);

        // Working indicators - only valid if stop button is present
        const workingIndicators = [
          'Working…', 'Working...', 'Searching', 'Reviewing sources',
          'Preparing to assist', 'Clicking', 'Typing:', 'Navigating'
        ];
        const hasWorkingText = workingIndicators.some(indicator => mainText.includes(indicator));

        // Determine status with priority:
        // 1. If stop button is visible AND clickable -> working
        // 2. If "N steps completed" visible -> completed
        // 3. If working text but no stop button -> likely completed (stop button removed)
        // 4. If task input visible but nothing else -> idle (waiting for input)
        let status = 'idle';
        if (hasActiveStopButton || (hasWorkingText && hasTaskInput && !hasStepsCompleted)) {
          status = 'working';
        } else if (hasStepsCompleted || hasFinishedMarker || (hasReviewedSources && !hasActiveStopButton)) {
          status = 'completed';
        } else if (hasTaskInput) {
          status = 'idle';
        }

        // Extract agent steps from the page
        const steps = [];
        const stepPatterns = [
          /Preparing to assist[^\\n]*/g,
          /I can see[^\\n]*/g,
          /Good,[^\\n]*/g,
          /Clicking[^\\n]*/g,
          /Typing:[^\\n]*/g,
          /Navigating[^\\n]*/g,
          /It seems[^\\n]*/g,
          /Let me[^\\n]*/g,
          /I need to[^\\n]*/g,
          /I'll[^\\n]*/g
        ];
        for (const pattern of stepPatterns) {
          const matches = mainText.match(pattern);
          if (matches) steps.push(...matches.map(s => s.trim().substring(0, 100)));
        }

        // Current step is the last meaningful one
        const currentStep = steps.length > 0 ? steps[steps.length - 1] : '';

        // Extract response - find the LATEST answer content
        let response = '';
        if (status === 'completed') {
          // Find main prose blocks (they have "inline" in class, not sub-elements)
          const mainProseEls = Array.from(document.querySelectorAll('[class*="prose"]'))
            .filter(el => el.className.includes('inline'));

          // Get the last main prose element which should be the current response
          if (mainProseEls.length > 0) {
            const lastProse = mainProseEls[mainProseEls.length - 1];
            response = lastProse.innerText;
          }

          // If still empty or too short, try to extract from main content after completion markers
          if (!response || response.length < 50) {
            const completionIndex = mainText.indexOf('steps completed');
            if (completionIndex > -1) {
              // Find the response section after "N steps completed"
              const afterCompletion = mainText.substring(completionIndex);
              // Extract until we hit "Related" or "Ask a follow-up" or end
              const endMarkers = ['Related', 'Ask a follow-up', 'Ask anything'];
              let endIndex = afterCompletion.length;
              for (const marker of endMarkers) {
                const idx = afterCompletion.indexOf(marker);
                if (idx > 0 && idx < endIndex) endIndex = idx;
              }
              response = afterCompletion.substring(15, endIndex).trim();
            }
          }
        }

        // Get the URL the agent is currently browsing (from screenshots or context)
        let agentBrowsingUrl = '';
        const urlMatch = mainText.match(/https?:\\/\\/[^\\s\\n]+/);
        if (urlMatch) {
          agentBrowsingUrl = urlMatch[0];
        }

        return {
          status,
          steps: [...new Set(steps)].slice(-5), // Dedupe and get last 5
          currentStep,
          response: response.substring(0, 2000),
          hasStopButton: hasActiveStopButton || hasTaskInput,
          agentBrowsingUrl
        };
      })()
    `);

    return result.result.value as {
      status: "idle" | "working" | "completed";
      steps: string[];
      currentStep: string;
      response: string;
      hasStopButton: boolean;
      agentBrowsingUrl: string;
    };
  }

  /**
   * Stop the current agent task
   */
  async stopAgent(): Promise<boolean> {
    const result = await cometClient.evaluate(`
      (() => {
        // Try to find and click stop/cancel button
        const stopButtons = document.querySelectorAll(
          'button[aria-label*="Stop"], button[aria-label*="Cancel"], button[aria-label*="Pause"]'
        );
        for (const btn of stopButtons) {
          btn.click();
          return true;
        }

        // Try finding a square stop icon button
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.querySelector('svg rect, svg[class*="stop"]')) {
            btn.click();
            return true;
          }
        }

        return false;
      })()
    `);
    return result.result.value as boolean;
  }
}

export const cometAI = new CometAI();
