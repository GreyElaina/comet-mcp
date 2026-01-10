// Comet AI interaction module
// Handles sending prompts to Comet's AI assistant and reading responses

import { promises as fs } from "fs";
import path from "path";
import { cometClient } from "./cdp-client.js";
import type { CometAIResponse } from "./types.js";

const MAX_EXTRACTED_RESPONSE_CHARS = 24000;
const RESPONSE_TAIL_CHARS = 4000;
const MAX_FILE_SIZE = 25 * 1024 * 1024;

const JS_HELPERS = {
  norm: `const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();`,
  normLower: `const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();`,
  isVisible: `const isVisible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (Number(style.opacity) === 0) return false;
      return r.width > 0 && r.height > 0;
    } catch { return false; }
  };`,
  isVisibleLarge: `const isVisible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (Number(style.opacity) === 0) return false;
      return r.width > 8 && r.height > 8;
    } catch { return false; }
  };`,
  pickLatestResponse: (selectorsJson: string) => `const pickLatestResponse = () => {
    const responseSelectors = ${selectorsJson};
    for (const sel of responseSelectors) {
      try {
        const allEls = Array.from(document.querySelectorAll(sel));
        // Filter out nested elements (e.g., LI inside a prose DIV)
        const topLevelEls = allEls.filter(el => 
          !allEls.some(other => other !== el && other.contains(el))
        );
        for (let i = topLevelEls.length - 1; i >= 0; i--) {
          const text = (topLevelEls[i].innerText || '').trim();
          if (text.length > 0 && !text.startsWith('Related')) return text;
        }
      } catch {}
    }
    return '';
  };`,
  isCheckVisible: `const isCheckVisible = (root) => {
    try {
      const uses = Array.from(root.querySelectorAll('use'));
      const findHref = (u) =>
        u.getAttribute('href') ||
        u.getAttribute('xlink:href') ||
        u.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ||
        '';
      const checkUse = uses.find((u) => {
        const href = findHref(u);
        return href === '#pplx-icon-check' || href.endsWith('icon-check');
      }) || null;
      if (!checkUse) return false;
      const container = checkUse.closest('span') || checkUse.closest('svg') || checkUse;
      return isVisible(container);
    } catch { return false; }
  };`,
  findStopButton: `const findStopButton = () => {
    const getHref = (u) =>
      u.getAttribute('href') ||
      u.getAttribute('xlink:href') ||
      u.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ||
      '';
    const svgBtn = Array.from(document.querySelectorAll('button'))
      .find(btn => {
        if (btn.offsetParent === null || btn.disabled) return false;
        const use = btn.querySelector('use');
        if (!use) return false;
        const href = getHref(use);
        return href.includes('stop') || href.includes('player-stop');
      });
    if (svgBtn) return svgBtn;
    const textPatterns = ['stop', 'cancel', 'pause', '停止', '取消', '暂停'];
    return Array.from(document.querySelectorAll('button')).find(btn => {
      if (btn.offsetParent === null || btn.disabled) return false;
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const title = (btn.getAttribute('title') || '').toLowerCase();
      return textPatterns.some(p => aria.includes(p) || title.includes(p));
    }) || null;
  };`,
};

const SUPPORTED_FILE_EXTENSIONS: Record<string, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp"],
  document: ["pdf"],
  text: ["txt", "csv", "md"],
};

const EXTENSION_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
};

export interface FileValidationResult {
  valid: boolean;
  error?: string;
  mimeType?: string;
  size?: number;
}

export interface FileUploadResult {
  success: boolean;
  uploaded: number;
  errors: string[];
}

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
  // Response/output selectors for Perplexity (only prose works as of 2025-01)
  response: [
    '[class*="prose"]',
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

export type CometMode = "search" | "agent";

export class CometAI {
  private lastResponseText: string = "";
  private lastInputHint:
    | { kind: "contenteditable" | "textarea" | "input"; selector: string }
    | null = null;
  private tempChatCache:
    | { checkedAt: number; detected: boolean; enabled: boolean | null }
    | null = null;
  private cachedMode: { mode: CometMode; checkedAt: number } | null = null;
  private defaultModel: string | null = null;

  setDefaultModel(model: string | null): void {
    this.defaultModel = model?.trim() || null;
  }

  getDefaultModel(): string | null {
    return this.defaultModel;
  }

  async detectMode(): Promise<{ mode: CometMode; hasAgentBrowsing: boolean }> {
    const tabs = await cometClient.listTabsCategorized().catch(() => null);
    const hasMain = !!tabs?.main;
    const hasSidecar = !!tabs?.sidecar;
    const hasAgentBrowsing = !!tabs?.agentBrowsing;
    const mode: CometMode = (!hasMain && hasSidecar && hasAgentBrowsing) ? "agent" : "search";
    this.cachedMode = { mode, checkedAt: Date.now() };
    return { mode, hasAgentBrowsing };
  }

  async isAgentMode(): Promise<boolean> {
    const cacheMaxAge = 5000;
    if (this.cachedMode && Date.now() - this.cachedMode.checkedAt < cacheMaxAge) {
      return this.cachedMode.mode === "agent";
    }
    const { mode } = await this.detectMode();
    return mode === "agent";
  }

  async getPerplexityUIMode(): Promise<"search" | "research" | "studio" | null> {
    const result = await cometClient.safeEvaluate(`
      (() => {
        const checked = document.querySelector('button[role="radio"][aria-checked="true"]');
        return checked ? checked.getAttribute('value') : null;
      })()
    `);
    const value = result.result.value as string | null;
    if (value === "search" || value === "research" || value === "studio") {
      return value;
    }
    return null;
  }

  private async closeOverlays(): Promise<void> {
    // Try multiple strategies to close any open popups/menus
    for (let attempt = 0; attempt < 3; attempt++) {
      await cometClient.safeEvaluate(`
        (() => {
          try {
            // Strategy 1: Escape key
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            
            // Strategy 2: Click outside any visible popover/dialog
            const overlays = document.querySelectorAll('[data-radix-popper-content-wrapper], [role="dialog"], [role="menu"], [data-state="open"]');
            if (overlays.length > 0) {
              // Click on the main content area to dismiss
              const main = document.querySelector('main') || document.body;
              const rect = main.getBoundingClientRect();
              const clickX = rect.left + 10;
              const clickY = rect.top + 10;
              const clickTarget = document.elementFromPoint(clickX, clickY);
              if (clickTarget && !clickTarget.closest('[data-radix-popper-content-wrapper], [role="dialog"], [role="menu"]')) {
                clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: clickX, clientY: clickY }));
              }
            }
          } catch {}
          return true;
        })()
      `);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async openAccountMenu(): Promise<{ ok: boolean; reason?: string }> {
    await this.closeOverlays();
    // Use structural selector: find div/button with aria-haspopup="menu" in bottom-left corner
    const result = await cometClient.safeEvaluate(`
      (() => {
        const candidates = document.querySelectorAll('div[aria-haspopup="menu"], button[aria-haspopup="menu"]');
        for (const el of candidates) {
          const r = el.getBoundingClientRect();
          // Bottom-left quadrant: x < 200, y > viewport height - 250
          if (r.left < 200 && r.top > window.innerHeight - 250 && r.width > 0 && r.height > 0) {
            try {
              el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
              el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              el.click();
              return { ok: true };
            } catch (e) {
              return { ok: false, reason: String(e) };
            }
          }
        }
        return { ok: false, reason: 'Account menu trigger not found (no aria-haspopup="menu" in bottom-left)' };
      })()
    `);

    return (result.result.value as any) ?? { ok: false, reason: "evaluate failed" };
  }

  private async findIncognitoMenuItem(): Promise<
    | {
        found: true;
        label: string;
        enabled: boolean;
        disabled: boolean;
        selectorHint: string;
      }
    | { found: false; reason: string }
  > {
    // Structural approach: find incognito toggle by switch or checkmark
    const result = await cometClient.safeEvaluate(`
      (() => {
        ${JS_HELPERS.isVisible}
        ${JS_HELPERS.isCheckVisible}

        const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]')).filter(isVisible);
        
        // Strategy 1: Find menuitem with a switch (most reliable if exists)
        for (const item of menuItems) {
          const toggle = item.querySelector('[role="switch"], button[role="switch"]');
          if (toggle) {
            const checked = toggle.getAttribute('aria-checked') === 'true' ||
                           toggle.getAttribute('data-state') === 'checked';
            const disabled = item.getAttribute('aria-disabled') === 'true';
            const label = (item.innerText || '').replace(/\\s+/g, ' ').trim();
            return { found: true, label, enabled: checked, disabled, selectorHint: 'switch' };
          }
        }
        
        // Strategy 2: Find menuitem with checkmark icon (Perplexity uses this for incognito)
        for (const item of menuItems) {
          if (isCheckVisible(item)) {
            const disabled = item.getAttribute('aria-disabled') === 'true';
            const label = (item.innerText || '').replace(/\\s+/g, ' ').trim();
            return { found: true, label, enabled: true, disabled, selectorHint: 'checkmark' };
          }
        }
        
        // Strategy 3: Look for menuitem that COULD have a checkmark (has the icon structure but unchecked)
        for (const item of menuItems) {
          const uses = item.querySelectorAll('use');
          for (const u of uses) {
            const href = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
            if (href.includes('icon-check') || href === '#pplx-icon-check') {
              const disabled = item.getAttribute('aria-disabled') === 'true';
              const label = (item.innerText || '').replace(/\\s+/g, ' ').trim();
              return { found: true, label, enabled: false, disabled, selectorHint: 'checkmark-unchecked' };
            }
          }
        }

        return { found: false, reason: 'No toggle found (menu may not be open)', menuItemCount: menuItems.length };
      })()
    `);

    if (result.exceptionDetails || result.result.value == null) {
      return { found: false, reason: "evaluate failed" };
    }

    return result.result.value as any;
  }

  /**
   * Find the first matching element from a list of selectors
   */
  async findElement(selectors: string[]): Promise<string | null> {
    for (const selector of selectors) {
      const result = await cometClient.safeEvaluate(`
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
    const pageInfoResult = await cometClient.safeEvaluate(`
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
    await cometClient.ensureOnPerplexity();

    let focused: any = null;
    for (let i = 0; i < 30; i++) {
      const probe = await cometClient.safeEvaluate(`
        (() => {
          ${JS_HELPERS.isVisibleLarge}
          const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);

          const candidates = [];
          for (const el of Array.from(document.querySelectorAll('[contenteditable=\"true\"]'))) {
            if (!isVisible(el)) continue;
            const r = el.getBoundingClientRect();
            const role = (el.getAttribute && el.getAttribute('role')) || '';
            const bonus = role === 'textbox' ? 1000 : 0;
            candidates.push({ kind: 'contenteditable', el, score: area(r) + bonus });
          }
          for (const el of Array.from(document.querySelectorAll('textarea'))) {
            if (!isVisible(el)) continue;
            const r = el.getBoundingClientRect();
            candidates.push({ kind: 'textarea', el, score: area(r) });
          }
          for (const el of Array.from(document.querySelectorAll('input[type=\"text\"], input:not([type])'))) {
            if (!isVisible(el)) continue;
            const r = el.getBoundingClientRect();
            candidates.push({ kind: 'input', el, score: area(r) });
          }

          candidates.sort((a, b) => b.score - a.score);
          const target = candidates[0] || null;
          if (!target) return { ok: false, reason: 'no visible input found' };

          const el = target.el;
          try {
            el.focus();
            el.click?.();
          } catch {}

          return { ok: true, kind: target.kind };
        })()
      `);

      focused = probe?.result?.value;
      if (focused?.ok) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!focused?.ok) {
      throw new Error(
        `Failed to type into input element${focused?.reason ? `: ${focused.reason}` : ""}`
      );
    }

    // Clear existing content using real key events (prevents duplicate prompts).
    // On macOS, Cmd+A; also try Ctrl+A as a fallback.
    try {
      await cometClient.pressKeyWithModifiers("a", 4, { code: "KeyA" });
      await cometClient.pressKeyWithModifiers("a", 2, { code: "KeyA" });
      await cometClient.pressKey("Backspace");
      await cometClient.pressKey("Delete");
    } catch {
      // Best-effort; continue.
    }

    // Use CDP Input.insertText to behave like real typing.
    try {
      await cometClient.insertText(prompt);
    } catch (e) {
      throw new Error(`Failed to insert text: ${e instanceof Error ? e.message : String(e)}`);
    }

    this.lastInputHint = { kind: focused.kind, selector: "[focused]" };

    // Submit the prompt
    await this.submitPrompt();

    return `Prompt sent: "${prompt.substring(0, 50)}${prompt.length > 50 ? "..." : ""}"`;
  }

  /**
   * Submit the current prompt - tries multiple strategies
   */
  private async submitPrompt(): Promise<void> {
    // Wait a moment for the UI to register the input
    await new Promise(resolve => setTimeout(resolve, 300));

    const clickEnabledSubmit = async (): Promise<boolean> => {
      // Position-based: find rightmost enabled button near input, excluding known non-submit buttons
      const result = await cometClient.safeEvaluate(`
        (() => {
          ${JS_HELPERS.isVisibleLarge}

          // Fast path: exact aria-label="Submit"
          const exactSubmit = document.querySelector('button[aria-label="Submit"]:not([disabled])');
          if (exactSubmit && isVisible(exactSubmit)) {
            exactSubmit.click();
            return { ok: true, method: 'exact' };
          }

          // Position-based approach: rightmost button near input
          const input = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea');
          if (!input) return { ok: false, reason: 'no input found' };

          const inputRect = input.getBoundingClientRect();
          const excludePatterns = ['attach', 'voice', 'dictate', 'file', 'upload', 'mode',
                                   'search', 'research', 'labs', 'learn', 'source', 'add',
                                   '附加', '听写', '录音', '文件', '搜索', '研究', '实验'];

          const candidates = Array.from(document.querySelectorAll('button:not([disabled])'))
            .filter(btn => {
              if (btn.getAttribute('aria-disabled') === 'true') return false;
              const r = btn.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              // Must be near input vertically and to the right
              if (Math.abs(r.top - inputRect.top) > 100) return false;
              if (r.left < inputRect.left) return false;

              const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
              if (excludePatterns.some(p => aria.includes(p))) return false;
              const text = (btn.innerText || '').trim().toLowerCase();
              if (text === '+') return false;

              return true;
            })
            .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);

          if (candidates[0]) {
            candidates[0].click();
            return { ok: true, method: 'rightmost' };
          }
          return { ok: false, reason: 'no enabled submit button' };
        })()
      `);
      return (result?.result?.value as any)?.ok === true;
    };

    // Prefer clicking the enabled Submit button (more reliable than Enter).
    for (let i = 0; i < 10; i++) {
      if (await clickEnabledSubmit()) return;
      await new Promise((r) => setTimeout(r, 120));
    }

    // Strategy: Use Enter key fallback
    try {
      await cometClient.pressKey("Enter");
      await new Promise(resolve => setTimeout(resolve, 300));
      const submitted = await cometClient.safeEvaluate(`
        (() => {
          const hasLoading =
            document.querySelector('[class*=\"animate-spin\"], [class*=\"animate-pulse\"], [class*=\"loading\"], [class*=\"thinking\"], .spinner') !== null;
          return hasLoading || window.location.href.includes('/search/');
        })()
      `);
      if (submitted.result.value) return;
    } catch {}

    // Strategy 2: Try clicking the submit button with various selectors
    const clickResult = await cometClient.safeEvaluate(`
      (() => {
        // Common submit button selectors for Perplexity
        const selectors = [
          'button[aria-label*="Submit"]',
          'button[aria-label*="Send"]',
          'button[aria-label*="Ask"]',
          'button[type="submit"]',
          // Perplexity specific - arrow button near input
          'button:has(svg path[d*="M12"])',  // Arrow icon paths often start with M12
          'button:has(svg[class*="arrow"])',
          'button:has(svg[class*="send"])',
        ];

        for (const sel of selectors) {
          try {
            const btn = document.querySelector(sel);
            if (btn && !btn.disabled && btn.offsetParent !== null) {
              btn.click();
              return { clicked: true, selector: sel, method: 'direct' };
            }
          } catch (e) {
            // :has() might not be supported, continue
          }
        }

        // Strategy 2: Find the submit button - rightmost button with arrow/send icon
        const inputEl = document.querySelector('[contenteditable="true"]') ||
                        document.querySelector('textarea');
        if (inputEl) {
          const inputRect = inputEl.getBoundingClientRect();
          let parent = inputEl.parentElement;
          let candidates = [];

          for (let i = 0; i < 4 && parent; i++) {
            const btns = parent.querySelectorAll('button:not([disabled])');
            for (const btn of btns) {
              const btnRect = btn.getBoundingClientRect();
              const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
              const btnText = (btn.textContent || '').toLowerCase();

              // Skip: mode buttons, source/attach buttons, voice buttons
              if (ariaLabel.includes('search') || ariaLabel.includes('research') ||
                  ariaLabel.includes('labs') || ariaLabel.includes('learn') ||
                  ariaLabel.includes('mode') || ariaLabel.includes('source') ||
                  ariaLabel.includes('attach') || ariaLabel.includes('add') ||
                  ariaLabel.includes('voice') || ariaLabel.includes('micro') ||
                  ariaLabel.includes('record') || btnText === '+') {
                continue;
              }

              // Must have SVG and be visible and to the right of input
              if (btn.querySelector('svg') && btn.offsetParent !== null &&
                  btnRect.left > inputRect.left && btnRect.width > 0) {
                candidates.push({ btn, right: btnRect.right });
              }
            }
            parent = parent.parentElement;
          }

          // Click the rightmost candidate (submit is usually rightmost)
          if (candidates.length > 0) {
            candidates.sort((a, b) => b.right - a.right);
            candidates[0].btn.click();
            return { clicked: true, selector: 'rightmost-button', method: 'traversal' };
          }
        }

        return { clicked: false };
      })()
    `);

    const clicked = (clickResult.result.value as { clicked: boolean; method?: string })?.clicked;

    if (clicked) return;

    throw new Error("Could not submit prompt");
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
      const result = await cometClient.safeEvaluate(`
        (() => {
          // Look for prose elements and get the last one (most recent response)
          const allEls = Array.from(document.querySelectorAll('[class*="prose"]'));
          // Filter out nested elements (e.g., LI items inside a prose DIV)
          const topLevelEls = allEls.filter(el => 
            !allEls.some(other => other !== el && other.contains(el))
          );
          if (topLevelEls.length > 0) {
            return topLevelEls[topLevelEls.length - 1].innerText;
          }
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
   * Get the current visible response text (returns latest response in multi-turn conversations)
   */
  async getCurrentResponse(): Promise<string> {
    await cometClient.ensureOnPerplexity();

    const result = await cometClient.safeEvaluate(`
      (() => {
        ${JS_HELPERS.pickLatestResponse(JSON.stringify(SELECTORS.response))}
        return pickLatestResponse();
      })()
    `);

    const text = result.result.value as string;
    if (text && text.length > 0) {
      return text;
    }

    // Fallback: try to get text from main content area
    const fallbackResult = await cometClient.safeEvaluate(`
      (() => {
        const main = document.querySelector('main');
        if (!main) return document.body.innerText.substring(0, 5000);
        // Try to find the content area, excluding sidebar/navigation
        const content = main.querySelector('[class*="grow"]') || main;
        return content.innerText.substring(0, 5000);
      })()
    `);
    return (fallbackResult.result.value as string) || "";
  }

  async getLatestResponseSlice(
    offset: number = 0,
    limit: number = 24000
  ): Promise<{ total: number; slice: string }> {
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? Math.trunc(offset) : 0;
    const safeLimit =
      Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 24000;

    const result = await cometClient.safeEvaluate(`
      (() => {
        ${JS_HELPERS.pickLatestResponse(JSON.stringify(SELECTORS.response))}
        const text = pickLatestResponse();
        const total = text.length;
        const start = Math.min(${safeOffset}, total);
        const end = Math.min(start + ${safeLimit}, total);
        return { total, slice: text.slice(start, end) };
      })()
    `);

    if (result.exceptionDetails || result.result.value == null) {
      return { total: 0, slice: "" };
    }

    return result.result.value as { total: number; slice: string };
  }

  async getModelInfo(options?: {
    openMenu?: boolean;
    includeRaw?: boolean;
  }): Promise<{
    currentModel: string | null;
    availableModels: string[];
    supportsModelSwitching: boolean;
    mode: CometMode;
    debug?: unknown;
  }> {
    await cometClient.ensureOnPerplexity();

    const openMenu = options?.openMenu === true;
    const includeRaw = options?.includeRaw === true;

    const { mode, hasAgentBrowsing } = await this.detectMode();
    
    if (mode === "agent") {
      return {
        currentModel: null,
        availableModels: [],
        supportsModelSwitching: false,
        mode,
        debug: includeRaw ? { mode, hasAgentBrowsing, reason: "Agent mode does not support model switching" } : undefined,
      };
    }

    await cometClient.connectToMain().catch(() => {});

    const uiMode = await this.getPerplexityUIMode();
    if (uiMode && uiMode !== "search") {
      return {
        currentModel: null,
        availableModels: [],
        supportsModelSwitching: false,
        mode,
        debug: includeRaw ? { mode, uiMode, reason: `Model switching only available in search mode (current: ${uiMode})` } : undefined,
      };
    }

    const base = await cometClient.safeEvaluate(`
      (() => {
        const cpuUse = Array.from(document.querySelectorAll('use')).find(u => 
          u.getAttribute('xlink:href')?.includes('cpu') && 
          u.closest('button')?.getAttribute('aria-haspopup') !== 'dialog'
        );
        const trigger = cpuUse?.closest('button') || null;
        const currentModel = trigger?.getAttribute('aria-label') || null;

        const debug = { 
          hasCpuIcon: !!cpuUse, 
          triggerAria: currentModel,
          triggerHaspopup: trigger?.getAttribute('aria-haspopup') 
        };

        let opened = false;
        let dataStateBefore = null;
        let dataStateAfter = null;
        if (${openMenu} && trigger) {
          try {
            dataStateBefore = trigger.getAttribute('data-state');
            trigger.click();
            opened = true;
            dataStateAfter = trigger.getAttribute('data-state');
          } catch {}
        }

        return {
          currentModel,
          opened,
          dataStateBefore,
          dataStateAfter,
          debug: ${includeRaw} ? debug : undefined,
        };
      })()
    `);

    if (base.exceptionDetails || base.result.value == null) {
      return {
        currentModel: null,
        availableModels: [],
        supportsModelSwitching: false,
        mode,
        debug: includeRaw
          ? (base.exceptionDetails?.exception?.description || base.exceptionDetails?.text || "evaluate failed")
          : undefined,
      };
    }

    const baseValue = base.result.value as {
      currentModel: string | null;
      opened: boolean;
      dataStateBefore: string | null;
      dataStateAfter: string | null;
      debug?: unknown;
    };

    const readMenuItems = async (onlyVisible: boolean): Promise<{ items: Array<{ name: string; selected: boolean }>; diagnostics: unknown }> => {
      const res = await cometClient.safeEvaluate(`
        (() => {
          const onlyVisible = ${onlyVisible};
          const isVisible = (el) => {
            if (!onlyVisible) return true;
            try {
              const r = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              if (!style) return false;
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              if (Number(style.opacity) === 0) return false;
              return r.width > 0 && r.height > 0;
            } catch {
              return false;
            }
          };
          
          const diagnostics = {
            menuCount: 0,
            menuitemCount: 0,
            triggerDataState: null,
          };
          
          const cpuUse = Array.from(document.querySelectorAll('use')).find(u => 
            u.getAttribute('xlink:href')?.includes('cpu') && 
            u.closest('button')?.getAttribute('aria-haspopup') !== 'dialog'
          );
          const triggerButton = cpuUse?.closest('button');
          if (triggerButton) {
            diagnostics.triggerDataState = triggerButton.getAttribute('data-state');
          }
          
          diagnostics.menuCount = document.querySelectorAll('[role="menu"]').length;
          
          const items = [];
          const menuItems = document.querySelectorAll('[role="menu"] [role="menuitem"]');
          diagnostics.menuitemCount = menuItems.length;
          
          for (const item of menuItems) {
            if (!isVisible(item)) continue;
            const nameEl = item.querySelector('.flex-1 span');
            const name = nameEl?.textContent?.trim();
            if (!name) continue;
            const checkSvg = item.querySelector('svg use[*|href*="check"]')?.closest('svg');
            const selected = checkSvg && !checkSvg.classList.contains('opacity-0');
            items.push({ name, selected });
          }
          
          return { items, diagnostics };
        })()
      `);
      if (res.exceptionDetails || res.result.value == null) return { items: [], diagnostics: null };
      const result = res.result.value as { items: Array<{ name: string; selected: boolean }>; diagnostics: unknown };
      return result;
    };

    if (openMenu && baseValue.opened) {
      await new Promise((r) => setTimeout(r, 300));
    }

    let menuResult = await readMenuItems(openMenu);
    let availableModels = menuResult.items.map(i => i.name);
    let lastDiagnostics = menuResult.diagnostics;
    
    if (openMenu && baseValue.opened && availableModels.length === 0) {
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 150));
        menuResult = await readMenuItems(true);
        availableModels = menuResult.items.map(i => i.name);
        lastDiagnostics = menuResult.diagnostics;
        if (availableModels.length) break;
      }
    }

    if (openMenu && baseValue.opened) {
      await cometClient.safeEvaluate(`
        (() => {
          try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          } catch {}
          return true;
        })()
      `);
    }

    return {
      currentModel: baseValue.currentModel,
      availableModels,
      supportsModelSwitching: openMenu ? baseValue.opened && availableModels.length > 0 : false,
      mode,
      debug: includeRaw ? { 
        baseDebug: baseValue.debug ?? null,
        opened: baseValue.opened,
        dataStateBefore: baseValue.dataStateBefore,
        dataStateAfter: baseValue.dataStateAfter,
        menuDiagnostics: lastDiagnostics 
      } : undefined,
    };
  }

  private async openModelMenu(): Promise<boolean> {
    const openResult = await cometClient.safeEvaluate(`
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
    const value = openResult.result?.value as { clicked: boolean; aria?: string } | undefined;
    if (openResult.exceptionDetails || !value?.clicked) {
      return false;
    }
    await new Promise((r) => setTimeout(r, 300));
    return true;
  }

  private async detectReasoningToggle(): Promise<{ detected: boolean; enabled: boolean | null }> {
    const result = await cometClient.safeEvaluate(`
      (() => {
        const LABELS = ['带着推理', '推理', 'reasoning', 'with reasoning'];
        ${JS_HELPERS.normLower}
        ${JS_HELPERS.isVisible}
        
        // Strategy 1: Look for menuitem containing reasoning text with a switch inside
        const menuItems = document.querySelectorAll('[role="menuitem"]');
        let visibleMenuItems = 0;
        for (const item of menuItems) {
          if (!isVisible(item)) continue;
          visibleMenuItems++;
          const text = norm(item.innerText || item.textContent || '');
          const matched = LABELS.some(l => text.includes(l));
          if (matched) {
            const toggle = item.querySelector('button[role="switch"], [role="switch"]');
            if (toggle) {
              const checked = toggle.getAttribute('aria-checked') === 'true' ||
                             toggle.getAttribute('data-state') === 'checked';
              return { detected: true, enabled: checked, strategy: 1, menuItemsTotal: menuItems.length, visibleMenuItems };
            }
          }
        }
        
        // Strategy 2: Look for any visible switch with reasoning-related ancestor text
        const toggles = document.querySelectorAll('button[role="switch"], [role="switch"], input[type="checkbox"]');
        for (const toggle of toggles) {
          if (!isVisible(toggle)) continue;
          let current = toggle;
          for (let i = 0; i < 6 && current; i++) {
            current = current.parentElement;
            if (current) {
              const text = norm(current.innerText || current.textContent || '');
              if (LABELS.some(l => text.includes(l))) {
                const checked = toggle.getAttribute('aria-checked') === 'true' ||
                               toggle.getAttribute('data-state') === 'checked' ||
                               (toggle instanceof HTMLInputElement && toggle.checked);
                return { detected: true, enabled: checked, strategy: 2, menuItemsTotal: menuItems.length, visibleMenuItems };
              }
            }
          }
        }
        
        return { detected: false, enabled: null, menuItemsTotal: menuItems.length, visibleMenuItems, togglesCount: toggles.length };
      })()
    `);
    const value = result.result.value as { detected: boolean; enabled: boolean | null; [k: string]: unknown } | null;
    if (result.exceptionDetails || value == null) {
      return { detected: false, enabled: null };
    }
    return { detected: value.detected, enabled: value.enabled };
  }

  async inspectReasoning(): Promise<{
    detected: boolean;
    enabled: boolean | null;
  }> {
    let info = await this.detectReasoningToggle();
    if (info.detected) return info;

    const opened = await this.openModelMenu();
    if (!opened) return { detected: false, enabled: null };

    await new Promise((r) => setTimeout(r, 300));

    info = await this.detectReasoningToggle();
    await this.closeOverlays();
    return info;
  }

  async setReasoning(enabled: boolean): Promise<{
    changed: boolean;
    enabled: boolean | null;
    debug?: {
      openMenuResult: boolean;
      beforeDetect: { detected: boolean; enabled: boolean | null };
      clickResult?: unknown;
      afterDetect?: { detected: boolean; enabled: boolean | null };
      earlyExit?: string;
    };
  }> {
    await cometClient.ensureOnPerplexity();

    const opened = await this.openModelMenu();
    if (!opened) {
      return { 
        changed: false, 
        enabled: null,
        debug: { openMenuResult: false, beforeDetect: { detected: false, enabled: null }, earlyExit: 'openModelMenu failed' }
      };
    }

    await new Promise((r) => setTimeout(r, 100));
    const before = await this.detectReasoningToggle();
    if (!before.detected) {
      await this.closeOverlays();
      return { 
        changed: false, 
        enabled: null,
        debug: { openMenuResult: true, beforeDetect: before, earlyExit: 'toggle not detected' }
      };
    }
    if (before.enabled === enabled) {
      await this.closeOverlays();
      return { 
        changed: false, 
        enabled: before.enabled,
        debug: { openMenuResult: true, beforeDetect: before, earlyExit: 'already in target state' }
      };
    }

    const clickResult = await cometClient.safeEvaluate(`
      (() => {
        const LABELS = ['带着推理', '推理', 'reasoning', 'with reasoning'];
        ${JS_HELPERS.normLower}
        ${JS_HELPERS.isVisible}
        
        // Strategy 1: Look for menuitem containing reasoning text with a switch inside
        const menuItems = document.querySelectorAll('[role="menuitem"]');
        for (const item of menuItems) {
          if (!isVisible(item)) continue;
          const text = norm(item.innerText || item.textContent || '');
          const matched = LABELS.some(l => text.includes(l));
          if (matched) {
            const toggle = item.querySelector('button[role="switch"], [role="switch"]');
            if (toggle) {
              toggle.click();
              return { clicked: true, strategy: 1, text };
            }
          }
        }
        
        // Strategy 2: Look for any visible switch with reasoning-related ancestor text
        const toggles = document.querySelectorAll('button[role="switch"], [role="switch"], input[type="checkbox"]');
        for (const toggle of toggles) {
          if (!isVisible(toggle)) continue;
          let current = toggle;
          for (let i = 0; i < 6 && current; i++) {
            current = current.parentElement;
            if (current) {
              const text = norm(current.innerText || current.textContent || '');
              if (LABELS.some(l => text.includes(l))) {
                toggle.click();
                return { clicked: true, strategy: 2, text };
              }
            }
          }
        }
        
        return { clicked: false, menuitemCount: menuItems.length, toggleCount: toggles.length };
      })()
    `);

    await new Promise((r) => setTimeout(r, 400));
    const after = await this.detectReasoningToggle();
    await this.closeOverlays();
    await new Promise((r) => setTimeout(r, 200));
    return {
      changed: before.enabled !== after.enabled,
      enabled: after.enabled,
      debug: {
        openMenuResult: true,
        beforeDetect: before,
        clickResult: clickResult.result.value,
        afterDetect: after,
      },
    };
  }

  async ensureModel(targetModel?: string): Promise<{
    changed: boolean;
    currentModel: string | null;
    targetModel: string | null;
    skipped?: string;
  }> {
    const target = targetModel?.trim() || this.defaultModel;
    if (!target) {
      return { changed: false, currentModel: null, targetModel: null, skipped: "no target model" };
    }

    const { mode } = await this.detectMode();
    if (mode === "agent") {
      return { changed: false, currentModel: null, targetModel: target, skipped: "agent mode" };
    }

    const uiMode = await this.getPerplexityUIMode();
    if (uiMode && uiMode !== "search") {
      return { changed: false, currentModel: null, targetModel: target, skipped: `ui mode is ${uiMode}` };
    }

    const info = await this.getModelInfo({ openMenu: false });
    const current = info.currentModel?.toLowerCase() || "";
    const targetLower = target.toLowerCase();

    if (current === targetLower || current.includes(targetLower) || targetLower.includes(current)) {
      return { changed: false, currentModel: info.currentModel, targetModel: target, skipped: "already selected" };
    }

    const result = await this.switchModel(target);
    return {
      changed: result.changed,
      currentModel: result.currentModel,
      targetModel: target,
    };
  }

  private async switchModel(modelName: string): Promise<{
    changed: boolean;
    currentModel: string | null;
    availableModels: string[];
    mode: CometMode;
    debug?: unknown;
  }> {
    await cometClient.ensureOnPerplexity();

    const target = (modelName || "").trim().toLowerCase();
    if (!target) {
      const { mode } = await this.detectMode();
      return { changed: false, currentModel: null, availableModels: [], mode, debug: "modelName is empty" };
    }

    const { mode } = await this.detectMode();
    
    if (mode === "agent") {
      return {
        changed: false,
        currentModel: null,
        availableModels: [],
        mode,
        debug: "Agent mode does not support model switching",
      };
    }

    const uiMode = await this.getPerplexityUIMode();
    if (uiMode && uiMode !== "search") {
      return {
        changed: false,
        currentModel: null,
        availableModels: [],
        mode,
        debug: `Model switching only available in search mode (current: ${uiMode})`,
      };
    }

    const infoBefore = await this.getModelInfo({ openMenu: false, includeRaw: true });
    
    const openMenuResult = await cometClient.safeEvaluate(`
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
    
    if (!(openMenuResult.result.value as any)?.clicked) {
      return {
        changed: false,
        currentModel: infoBefore.currentModel,
        availableModels: infoBefore.availableModels,
        mode,
        debug: { error: "Could not open model menu", openMenuResult: openMenuResult.result.value },
      };
    }
    
    await new Promise((r) => setTimeout(r, 400));

    let clickInfo: { clicked: boolean; matched: string | null; menuitemCount: number } = { 
      clicked: false, matched: null, menuitemCount: 0 
    };
    
    for (let attempt = 0; attempt < 15; attempt++) {
      const result = await cometClient.safeEvaluate(`
        (() => {
          const target = ${JSON.stringify(target)};
          ${JS_HELPERS.norm}
          const normalize = norm;
          ${JS_HELPERS.isVisible}

          let menuItems = document.querySelectorAll('[role="menu"] [role="menuitem"]');
          if (menuItems.length === 0) {
            menuItems = document.querySelectorAll('.shadow-overlay [role="menuitem"]');
          }
          if (menuItems.length === 0) {
            menuItems = document.querySelectorAll('div[style*="position: fixed"] [role="menuitem"]');
          }
          if (menuItems.length === 0) {
            menuItems = document.querySelectorAll('[role="menuitem"]');
          }
          const visibleItems = Array.from(menuItems).filter(isVisible);
          
          for (const item of visibleItems) {
            let text = '';
            const firstSpan = item.querySelector('[class*="flex-1"] span, .flex-1 span');
            if (firstSpan) {
              text = normalize(firstSpan.textContent || '');
            } else {
              text = normalize(item.innerText || '').split('\\n')[0].trim();
            }
            if (!text) continue;
            const lower = text.toLowerCase();
            if (lower === target || lower.includes(target) || target.includes(lower)) {
              item.click();
              return { clicked: true, matched: text, menuitemCount: visibleItems.length };
            }
          }
          
          return { clicked: false, matched: null, menuitemCount: visibleItems.length };
        })()
      `);
      
      clickInfo = result.result.value as typeof clickInfo;
      if (clickInfo?.clicked) break;
      if (clickInfo?.menuitemCount > 0 && attempt > 5) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    await cometClient.safeEvaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await new Promise((r) => setTimeout(r, 200));
    
    const infoAfter = await this.getModelInfo({ openMenu: false, includeRaw: true });

    return {
      changed: !!clickInfo?.clicked,
      currentModel: infoAfter.currentModel,
      availableModels: infoBefore.availableModels.length > 0 ? infoBefore.availableModels : infoAfter.availableModels,
      mode,
      debug: { before: infoBefore, clickInfo, after: infoAfter },
    };
  }

  async inspectTemporaryChat(options?: { includeRaw?: boolean }): Promise<{
    detected: boolean;
    enabled: boolean | null;
    candidates: Array<{
      kind: "toggle" | "button" | "menuitem";
      label: string;
      text: string;
      role: string | null;
      ariaLabel: string | null;
      title: string | null;
      checked: boolean | null;
      visible: boolean;
      disabled: boolean;
      selectorHint: string | null;
    }>;
    debug?: unknown;
  }> {
    await cometClient.ensureOnPerplexityMain();

    const includeRaw = options?.includeRaw === true;

    const open = await this.openAccountMenu();
    if (!open.ok) {
      return {
        detected: false,
        enabled: null,
        candidates: [],
        debug: includeRaw ? { open } : undefined,
      };
    }

    // Give the dropdown a moment to render (it uses portals).
    await new Promise((r) => setTimeout(r, 250));

    const item = await this.findIncognitoMenuItem();
    await this.closeOverlays();

    if (!item.found) {
      this.tempChatCache = { checkedAt: Date.now(), detected: false, enabled: null };
      return {
        detected: false,
        enabled: null,
        candidates: [],
        debug: includeRaw ? { open, item } : undefined,
      };
    }

    this.tempChatCache = {
      checkedAt: Date.now(),
      detected: true,
      enabled: item.enabled,
    };

    return {
      detected: true,
      enabled: item.enabled,
      candidates: [
        {
          kind: "menuitem",
          label: item.label,
          text: item.label,
          role: "menuitem",
          ariaLabel: null,
          title: null,
          checked: item.enabled,
          visible: true,
          disabled: item.disabled,
          selectorHint: item.selectorHint,
        },
      ],
      debug: includeRaw ? { open, item } : undefined,
    };
  }

  async ensureTemporaryChatEnabled(
    enabled: boolean,
    options?: { maxAgeMs?: number }
  ): Promise<{ checked: boolean; changed: boolean; enabled: boolean | null }> {
    const maxAgeMs = options?.maxAgeMs ?? 60000;
    const now = Date.now();

    if (
      this.tempChatCache &&
      now - this.tempChatCache.checkedAt <= maxAgeMs &&
      this.tempChatCache.detected &&
      this.tempChatCache.enabled === enabled
    ) {
      return { checked: false, changed: false, enabled: this.tempChatCache.enabled };
    }

    const info = await this.inspectTemporaryChat();
    if (!info.detected) {
      return { checked: true, changed: false, enabled: info.enabled };
    }
    if (info.enabled === enabled) {
      return { checked: true, changed: false, enabled: info.enabled };
    }

    const res = await this.setTemporaryChatEnabled(enabled);
    return { checked: true, changed: res.changed, enabled: res.after.enabled };
  }

  async setTemporaryChatEnabled(
    enabled: boolean,
    options?: { includeRaw?: boolean }
  ): Promise<{
    attempted: boolean;
    changed: boolean;
    before: Awaited<ReturnType<CometAI["inspectTemporaryChat"]>>;
    after: Awaited<ReturnType<CometAI["inspectTemporaryChat"]>>;
    debug?: unknown;
  }> {
    await cometClient.ensureOnPerplexityMain();

    const includeRaw = options?.includeRaw === true;
    const before = await this.inspectTemporaryChat({ includeRaw: true });

    if (before.enabled === enabled) {
      return {
        attempted: false,
        changed: false,
        before,
        after: before,
        debug: includeRaw ? { reason: "already in desired state" } : undefined,
      };
    }

    // Only attempt toggling if we can detect the current state reliably.
    if (before.enabled === null) {
      return {
        attempted: false,
        changed: false,
        before,
        after: before,
        debug: includeRaw ? { reason: "could not detect current state" } : undefined,
      };
    }

    const open = await this.openAccountMenu();
    if (!open.ok) {
      return {
        attempted: false,
        changed: false,
        before,
        after: before,
        debug: includeRaw ? { open } : undefined,
      };
    }
    await new Promise((r) => setTimeout(r, 250));

    const result = await cometClient.safeEvaluate(`
      (() => {
        const want = ${enabled} === true;
        ${JS_HELPERS.isVisible}
        ${JS_HELPERS.isCheckVisible}

        const menuItems = Array.from(document.querySelectorAll('[role="menuitem"]')).filter(isVisible);
        
        const tryClick = (item, isOn, label) => {
          const disabled = item.getAttribute('aria-disabled') === 'true';
          if (disabled) return { attempted: true, clicked: false, reason: 'disabled', label };
          if (want === isOn) return { attempted: false, clicked: false, reason: 'already', label, isOn };
          try {
            item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            item.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            item.click();
            return { attempted: true, clicked: true, label, before: isOn, want };
          } catch (e) {
            return { attempted: true, clicked: false, reason: String(e), label };
          }
        };
        
        // Strategy 1: Find menuitem with switch
        for (const item of menuItems) {
          const toggle = item.querySelector('[role="switch"], button[role="switch"]');
          if (toggle) {
            const checked = toggle.getAttribute('aria-checked') === 'true' ||
                           toggle.getAttribute('data-state') === 'checked';
            const label = (item.innerText || '').replace(/\\s+/g, ' ').trim();
            return tryClick(item, checked, label);
          }
        }
        
        // Strategy 2: Find menuitem with checkmark (enabled state)
        for (const item of menuItems) {
          if (isCheckVisible(item)) {
            const label = (item.innerText || '').replace(/\\s+/g, ' ').trim();
            return tryClick(item, true, label);
          }
        }
        
        // Strategy 3: Find menuitem with check icon structure (disabled state)
        for (const item of menuItems) {
          const uses = item.querySelectorAll('use');
          for (const u of uses) {
            const href = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
            if (href.includes('icon-check') || href === '#pplx-icon-check') {
              const label = (item.innerText || '').replace(/\\s+/g, ' ').trim();
              return tryClick(item, false, label);
            }
          }
        }

        return { attempted: false, clicked: false, reason: 'no toggle found', menuItemCount: menuItems.length };
      })()
    `);

    await new Promise((r) => setTimeout(r, 200));
    await this.closeOverlays();
    const after = await this.inspectTemporaryChat({ includeRaw: true });

    const changed = before.enabled !== null && after.enabled !== null && before.enabled !== after.enabled;
    this.tempChatCache = {
      checkedAt: Date.now(),
      detected: after.detected,
      enabled: after.enabled,
    };
    return {
      attempted: !!(result.result.value as any)?.attempted,
      changed,
      before,
      after,
      debug: includeRaw ? (result.result.value as any) : undefined,
    };
  }

  /**
   * Clear the current conversation/input
   */
  async clearConversation(): Promise<boolean> {
    await cometClient.ensureOnPerplexity();

    const result = await cometClient.safeEvaluate(`
      (function() {
        // Multi-language aria-label patterns for "new chat" / "clear" buttons
        const ariaPatterns = ['Clear', 'New', '清除', '新建', '清空', 'Nouveau', 'Neu', 'Nuevo'];
        const buttons = document.querySelectorAll('button[aria-label]');
        for (const btn of buttons) {
          const label = btn.getAttribute('aria-label') || '';
          if (ariaPatterns.some(p => label.includes(p))) {
            btn.click();
            return true;
          }
        }
        
        // Fallback: find button with plus icon (commonly used for new chat)
        const plusBtn = document.querySelector('button svg use[*|href*="plus"]')?.closest('button');
        if (plusBtn) {
          plusBtn.click();
          return true;
        }
        
        return false;
      })()
    `);
    return result.result.value as boolean;
  }

  /**
   * Get current agent status and progress (for polling)
   * Gets fresh data each time, extracts URL from actual browsing tab
   */
  async getAgentStatus(): Promise<{
    status: "idle" | "working" | "completed";
    steps: string[];
    currentStep: string;
    response: string;
    responseLength: number;
    hasStopButton: boolean;
    hasLoadingSpinner: boolean;
    latestResponse: string;
    latestResponseLength: number;
    latestResponseTail: string;
    evalError?: string;
    agentBrowsingUrl: string;
    pageUrl: string;
  }> {
    let agentBrowsingUrl = '';
    let hasSidecar = false;
    
    try {
      const tabs = await cometClient.listTabsCategorized();
      if (tabs.agentBrowsing) {
        agentBrowsingUrl = tabs.agentBrowsing.url;
      }
      hasSidecar = !!tabs.sidecar;
      if (!tabs.main && hasSidecar && tabs.agentBrowsing) {
        await cometClient.connectToSidecar();
      }
    } catch {}

    const result = await cometClient.safeEvaluate(`
      (() => {
        const body = document.body.innerText;

        ${JS_HELPERS.findStopButton}
        const hasActiveStopButton = findStopButton() !== null;

        // Check submit button state - key signal for sidecar mode
        // Working: submit button doesn't exist (null)
        // Completed: submit button exists and is disabled
        const submitButton = document.querySelector('button[aria-label="Submit"]');
        const submitExistsAndDisabled = submitButton !== null && submitButton.disabled === true;
        const submitMissing = submitButton === null;

        // Check for animated loading indicators (best-effort; UI varies)
        const hasLoadingSpinner =
          document.querySelector('[class*="animate-spin"], .spinner') !== null ||
          document.querySelector('[aria-label*="Loading"], [aria-label*="loading"]') !== null;

        ${JS_HELPERS.pickLatestResponse(JSON.stringify(SELECTORS.response))}
        const latestResponse = pickLatestResponse();

        // Check for completion indicators
        const stepsCompletedMatch = body.match(/(\\d+) steps? completed/i);
        const hasStepsCompleted = stepsCompletedMatch !== null;

        // Check for "Finished" or "Reviewed N sources"
        const hasFinishedMarker = body.includes('Finished') && !hasActiveStopButton;
        const hasReviewedSources = /Reviewed \\d+ sources?/i.test(body);

        // Structural working indicators (language-agnostic)
        // .shimmer class only appears during active thinking/processing
        const hasShimmer = document.querySelector('[role="tabpanel"] .shimmer') !== null;
        
        // Structural completed indicator - collapsed steps button with chevron icon
        const hasCompletedStepsButton = document.querySelector(
          '[role="tabpanel"] button.reset.interactable svg use[href*="chevron"], ' +
          '[role="tabpanel"] button.reset.interactable svg use[xlink\\\\:href*="chevron"]'
        ) !== null;

        let status = 'idle';
        
        if (submitExistsAndDisabled && latestResponse.length > 5) {
          status = 'completed';
        } else if (hasActiveStopButton || hasLoadingSpinner || hasShimmer) {
          status = 'working';
        } else if (hasCompletedStepsButton || hasStepsCompleted || hasFinishedMarker) {
          status = 'completed';
        } else if (hasReviewedSources) {
          status = 'completed';
        } else if (!hasActiveStopButton && !hasLoadingSpinner && latestResponse.length > 5) {
          status = 'completed';
        } else if (submitMissing) {
          status = 'idle';
        }

        // Extract agent steps
        const steps = [];
        const stepPatterns = [
          /Preparing to assist[^\\n]*/g,
          /Clicking[^\\n]*/g,
          /Typing:[^\\n]*/g,
          /Navigating[^\\n]*/g,
          /Reading[^\\n]*/g,
          /Searching[^\\n]*/g,
          /Found[^\\n]*/g
        ];
        for (const pattern of stepPatterns) {
          const matches = body.match(pattern);
          if (matches) {
            steps.push(...matches.map(s => s.trim().substring(0, 100)));
          }
        }

        const currentStep = steps.length > 0 ? steps[steps.length - 1] : '';

        // Extract response for completed status
        let response = '';
        if (status === 'completed') {
          // Strategy 1: Look for prose elements (main answer content)
          // Take the LAST one - most recent answer in conversation
          response = latestResponse;

          // Strategy 2: Look for answer section by structure
          if (!response) {
            // Find the main content area after "Reviewed X sources"
            const reviewedMatch = body.match(/Reviewed \\d+ sources?/);
            if (reviewedMatch) {
              const startIdx = body.indexOf(reviewedMatch[0]) + reviewedMatch[0].length;
              const endMarkers = ['Related', 'Ask a follow-up', 'Ask anything', 'Share', 'Copy'];
              let endIdx = body.length;
              for (const marker of endMarkers) {
                const idx = body.indexOf(marker, startIdx);
                if (idx > startIdx && idx < endIdx) endIdx = idx;
              }
              response = body.substring(startIdx, endIdx).trim();
            }
          }

          // Strategy 3: Fallback - extract after completion marker
          if (!response || response.length < 5) {
            const completionIdx = body.indexOf('steps completed');
            if (completionIdx > -1) {
              const afterCompletion = body.substring(completionIdx + 15);
              const endMarkers = ['Related', 'Ask a follow-up', 'Ask anything', 'Sources'];
              let endIdx = afterCompletion.length;
              for (const marker of endMarkers) {
                const idx = afterCompletion.indexOf(marker);
                if (idx > 0 && idx < endIdx) endIdx = idx;
              }
              response = afterCompletion.substring(0, endIdx).trim();
            }
          }
        }

        return {
          pageUrl: window.location.href,
          status,
          steps: [...new Set(steps)].slice(-5),
          currentStep,
          response: response.substring(0, ${MAX_EXTRACTED_RESPONSE_CHARS}),
          responseLength: response.length,
          hasStopButton: hasActiveStopButton,
          hasLoadingSpinner,
          latestResponse: latestResponse.substring(0, ${MAX_EXTRACTED_RESPONSE_CHARS}),
          latestResponseLength: latestResponse.length,
          latestResponseTail: latestResponse.slice(-${RESPONSE_TAIL_CHARS}),
        };
      })()
    `);

    if (result.exceptionDetails || result.result.value == null) {
      if (hasSidecar) {
        await cometClient.connectToMain().catch(() => {});
      }
      return {
        status: "idle",
        steps: [],
        currentStep: "",
        response: "",
        responseLength: 0,
        hasStopButton: false,
        hasLoadingSpinner: false,
        latestResponse: "",
        latestResponseLength: 0,
        latestResponseTail: "",
        evalError: result.exceptionDetails
          ? `${result.exceptionDetails.text}${result.exceptionDetails.exception?.description ? `: ${result.exceptionDetails.exception.description}` : ""}`
          : "No result returned from evaluate()",
        agentBrowsingUrl,
        pageUrl: "",
      };
    }

    const evalResult = result.result.value as {
      pageUrl: string;
      status: "idle" | "working" | "completed";
      steps: string[];
      currentStep: string;
      response: string;
      responseLength: number;
      hasStopButton: boolean;
      hasLoadingSpinner: boolean;
      latestResponse: string;
      latestResponseLength: number;
      latestResponseTail: string;
    };

    if (hasSidecar) {
      await cometClient.connectToMain().catch(() => {});
    }

    return {
      ...evalResult,
      agentBrowsingUrl,
    };
  }

  async stopAgent(): Promise<boolean> {
    const status = await this.getAgentStatus();
    if (!status.hasStopButton) {
      return false;
    }

    const result = await cometClient.safeEvaluate(`
      (() => {
        ${JS_HELPERS.findStopButton}
        const btn = findStopButton();
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      })()
    `);

    const clicked = result.result.value as boolean;

    if (clicked) {
      await cometClient.connectToMain().catch(() => {});
    }

    return clicked;
  }

  async exitAgentMode(): Promise<{ exited: boolean; reason?: string }> {
    const tabs = await cometClient.listTabsCategorized();
    if (!tabs.sidecar) {
      return { exited: false, reason: "not in agent mode" };
    }

    const newTab = await cometClient.newTab("https://www.perplexity.ai/");
    await cometClient.connect(newTab.id);

    await new Promise((r) => setTimeout(r, 1000));

    try {
      await cometClient.closeTab(tabs.sidecar.id);
    } catch {}

    if (tabs.agentBrowsing) {
      try {
        await cometClient.closeTab(tabs.agentBrowsing.id);
      } catch {}
    }

    return { exited: true };
  }

  async validateFile(filePath: string): Promise<FileValidationResult> {
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        return { valid: false, error: `Not a file: ${filePath}` };
      }
      if (stat.size > MAX_FILE_SIZE) {
        return {
          valid: false,
          error: `File too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max ${MAX_FILE_SIZE / 1024 / 1024}MB)`,
        };
      }
      if (stat.size === 0) {
        return { valid: false, error: `File is empty: ${filePath}` };
      }

      const ext = path.extname(filePath).toLowerCase().slice(1);
      const allExtensions = Object.values(SUPPORTED_FILE_EXTENSIONS).flat();
      if (!allExtensions.includes(ext)) {
        return {
          valid: false,
          error: `Unsupported file type: .${ext} (supported: ${allExtensions.join(", ")})`,
        };
      }

      return {
        valid: true,
        mimeType: EXTENSION_TO_MIME[ext],
        size: stat.size,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOENT")) {
        return { valid: false, error: `File not found: ${filePath}` };
      }
      return { valid: false, error: `Cannot access file: ${message}` };
    }
  }

  async uploadFiles(filePaths: string[]): Promise<FileUploadResult> {
    await cometClient.ensureOnPerplexity();

    const errors: string[] = [];
    const validFiles: string[] = [];

    for (const filePath of filePaths) {
      const validation = await this.validateFile(filePath);
      if (!validation.valid) {
        errors.push(validation.error!);
      } else {
        validFiles.push(filePath);
      }
    }

    if (validFiles.length === 0) {
      return { success: false, uploaded: 0, errors };
    }

    const backendNodeId = await cometClient.getBackendNodeId('input[type="file"]');
    if (!backendNodeId) {
      errors.push("Could not find file input element in Perplexity UI");
      return { success: false, uploaded: 0, errors };
    }

    try {
      await cometClient.setFileInputFiles(validFiles, { backendNodeId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to set files: ${message}`);
      return { success: false, uploaded: 0, errors };
    }

    let uploadConfirmed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const status = await cometClient.safeEvaluate(`
        (() => {
          const hasRemoveButton = document.querySelector('button[data-testid="remove-uploaded-file"]') !== null;
          const hasPreviewContainer = document.querySelector('.scroll-mx-md.px-sm.py-xs') !== null;
          return { hasRemoveButton, hasPreviewContainer };
        })()
      `);
      const val = status.result.value as { hasRemoveButton: boolean; hasPreviewContainer: boolean } | null;
      if (val?.hasRemoveButton || val?.hasPreviewContainer) {
        uploadConfirmed = true;
        break;
      }
    }

    if (!uploadConfirmed) {
      errors.push("Upload failed: UI confirmation not detected");
      return { success: false, uploaded: 0, errors };
    }

    return {
      success: true,
      uploaded: validFiles.length,
      errors,
    };
  }
}

export const cometAI = new CometAI();
