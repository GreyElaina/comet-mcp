// Comet AI interaction module
// Handles sending prompts to Comet's AI assistant and reading responses

import { cometClient } from "./cdp-client.js";
import type { CometAIResponse } from "./types.js";

const MAX_EXTRACTED_RESPONSE_CHARS = 24000;
const RESPONSE_TAIL_CHARS = 4000;

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
  private lastInputHint:
    | { kind: "contenteditable" | "textarea" | "input"; selector: string }
    | null = null;
  private tempChatCache:
    | { checkedAt: number; detected: boolean; enabled: boolean | null }
    | null = null;

  private async closeOverlays(): Promise<void> {
    await cometClient.safeEvaluate(`
      (() => {
        try {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        } catch {}
        return true;
      })()
    `);
  }

  private async openAccountMenu(): Promise<{ ok: boolean; reason?: string }> {
    await this.closeOverlays();
    const result = await cometClient.safeEvaluate(`
      (() => {
        const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const isVisible = (el) => {
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

        const h = window.innerHeight;
        const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);

        const candidates = [];
        for (const btn of buttons) {
          const r = btn.getBoundingClientRect();
          if (r.left > 260) continue;
          if (r.top < h - 340) continue;

          const text = norm(btn.innerText || btn.textContent || '');
          const aria = norm(btn.getAttribute('aria-label') || '');
          const title = norm(btn.getAttribute('title') || '');
          const combined = (text + ' ' + aria + ' ' + title).toLowerCase();

          let score = 0;
          if (text === '帐户' || text === '账户') score += 10;
          if (combined.includes('account') || combined.includes('profile') || combined.includes('user')) score += 6;
          if (combined.includes('帐户') || combined.includes('账户') || combined.includes('账号') || combined.includes('用户')) score += 6;
          if (btn.getAttribute('aria-haspopup') === 'menu') score += 2;
          if (r.left < 120) score += 2;
          if (r.top > h - 220) score += 2;
          candidates.push({ btn, score, text, aria, title });
        }

        candidates.sort((a, b) => b.score - a.score);
        const target = candidates[0]?.btn || null;
        if (!target) return { ok: false, reason: 'Account menu trigger not found' };

        try {
          target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          target.click();
          return { ok: true };
        } catch (e) {
          return { ok: false, reason: String(e) };
        }
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
    const result = await cometClient.safeEvaluate(`
      (() => {
        const LABELS = ['隐身', '无痕', 'Incognito', 'Private', 'Temporary'];
        const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const isVisible = (el) => {
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
        const isCheckVisible = (root) => {
          try {
            const uses = Array.from(root.querySelectorAll('use'));
            const findHref = (u) =>
              u.getAttribute('href') ||
              u.getAttribute('xlink:href') ||
              u.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ||
              '';

            const checkUse =
              uses.find((u) => {
                const href = findHref(u);
                return href === '#pplx-icon-check' || href.endsWith('icon-check');
              }) || null;

            if (!checkUse) return false;
            const container = checkUse.closest('span') || checkUse.closest('svg') || checkUse;
            return isVisible(container);
          } catch {
            return false;
          }
        };

        const items = Array.from(
          document.querySelectorAll('[role=\"menuitem\"], [data-radix-collection-item]')
        );
        const visibleItems = items.filter(isVisible);

        for (const el of visibleItems) {
          const text = norm(el.innerText || el.textContent || '');
          if (!text) continue;
          const matched = LABELS.find((l) => text === l || text.includes(l));
          if (!matched) continue;

          const disabled = !!(
            el.getAttribute('aria-disabled') === 'true' ||
            ('disabled' in el && el.disabled === true)
          );
          const enabled = isCheckVisible(el);
          return {
            found: true,
            label: text,
            enabled,
            disabled,
            selectorHint: 'account-dropdown:' + matched,
          };
        }

        return { found: false, reason: 'Incognito menu item not found (menu may not be open)' };
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
    // Wait for a visible input, focus it, and clear any existing text.
    let focused: any = null;
    for (let i = 0; i < 30; i++) {
      const probe = await cometClient.safeEvaluate(`
        (() => {
          const isVisible = (el) => {
            try {
              const r = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              if (!style) return false;
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              if (Number(style.opacity) === 0) return false;
              return r.width > 8 && r.height > 8;
            } catch {
              return false;
            }
          };
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
      const result = await cometClient.safeEvaluate(`
        (() => {
          const norm = (s) => (s || '').replace(/\\s+/g,' ').trim();
          const isVisible = (el) => {
            try {
              const r = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              if (!style) return false;
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              if (Number(style.opacity) === 0) return false;
              return r.width > 8 && r.height > 8;
            } catch { return false; }
          };

          const buttons = Array.from(document.querySelectorAll('button')).filter(isVisible);

          const exact = buttons.find(b => {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
            return norm(b.getAttribute('aria-label') || '') === 'Submit';
          }) || null;

          const fallback = buttons.find(b => {
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
            const aria = norm(b.getAttribute('aria-label') || '');
            const text = norm(b.innerText || b.textContent || '');
            const combined = (aria + ' ' + text).toLowerCase();
            return combined.includes('submit') || combined.includes('send') || combined.includes('ask');
          }) || null;

          const target = exact || fallback;
          if (!target) return { ok: false, reason: 'no enabled submit button' };
          try { target.click(); } catch (e) { return { ok: false, reason: String(e) }; }
          return { ok: true };
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
      const submitted = await cometClient.evaluate(`
        (() => {
          const hasLoading =
            document.querySelector('[class*=\"animate\"], [class*=\"loading\"], [class*=\"thinking\"], .spinner') !== null;
          return hasLoading || window.location.href.includes('/search/');
        })()
      `);
      if (submitted.result.value) return;
    } catch {}

    // Strategy 2: Try clicking the submit button with various selectors
    const clickResult = await cometClient.evaluate(`
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

  async getLatestResponseSlice(
    offset: number = 0,
    limit: number = 24000
  ): Promise<{ total: number; slice: string }> {
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? Math.trunc(offset) : 0;
    const safeLimit =
      Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 24000;

    const result = await cometClient.safeEvaluate(`
      (() => {
        const responseSelectors = ${JSON.stringify(SELECTORS.response)};
        const pickLatestResponse = () => {
          for (const sel of responseSelectors) {
            try {
              const els = document.querySelectorAll(sel);
              for (let i = els.length - 1; i >= 0; i--) {
                const text = (els[i].innerText || '').trim();
                if (text.length > 5 && !text.startsWith('Related')) return text;
              }
            } catch {}
          }
          return '';
        };
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
    debug?: unknown;
  }> {
    const openMenu = options?.openMenu === true;
    const includeRaw = options?.includeRaw === true;

    const base = await cometClient.safeEvaluate(`
      (() => {
        const EXCLUDED = new Set(['search', 'research', 'labs', 'learn']);
        const MODEL_WORDS = [
          'gpt', 'openai', 'claude', 'anthropic', 'sonar', 'llama', 'gemini',
          'mistral', 'deepseek', 'qwen', 'o1', 'o3', 'opus', 'sonnet', 'haiku'
        ];
        const looksLikeModel = (text) => {
          const t = (text || '').trim();
          if (!t) return false;
          const lower = t.toLowerCase();
          if (EXCLUDED.has(lower)) return false;
          if (lower.length < 2) return false;
          return MODEL_WORDS.some(w => lower.includes(w));
        };

        const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();

        const candidates = [];
        const buttons = Array.from(document.querySelectorAll('button, [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"]'));
        for (const el of buttons) {
          const text = normalize(el.innerText || el.textContent || '');
          const aria = normalize(el.getAttribute('aria-label') || '');
          const title = normalize(el.getAttribute('title') || '');

          const combined = [text, aria, title].filter(Boolean).join(' | ');
          if (!combined) continue;

          // Heuristic: model selector triggers often mention "model" or show model name.
          const combinedLower = combined.toLowerCase();
          const isModeButton = EXCLUDED.has(text.toLowerCase());
          if (isModeButton) continue;

          const mentionsModel = combinedLower.includes('model');
          const showsModelName = looksLikeModel(text) || looksLikeModel(aria) || looksLikeModel(title);

          if (!mentionsModel && !showsModelName) continue;

          // Prefer visible elements near the input area if possible.
          const rect = (el instanceof Element) ? el.getBoundingClientRect() : null;
          const visible = !!rect && rect.width > 0 && rect.height > 0;
          if (!visible) continue;

          candidates.push({ el, text, aria, title, mentionsModel, showsModelName });
        }

        // Pick a trigger: prefer one that mentions "model", otherwise a visible one that shows model name.
        const trigger = candidates.find(c => c.mentionsModel) || candidates.find(c => c.showsModelName) || null;

        // Try to infer current model from trigger text if it looks like a model.
        let currentModel = null;
        if (trigger) {
          const maybe = trigger.text || trigger.aria || trigger.title;
          if (looksLikeModel(maybe)) currentModel = normalize(maybe);
        }

        const debug = { triggerText: trigger?.text || null, triggerAria: trigger?.aria || null, triggerTitle: trigger?.title || null, triggerCandidates: candidates.length };

        let opened = false;
        if (${openMenu} && trigger) {
          try {
            trigger.el.click();
            opened = true;
          } catch {}
        }

        return {
          currentModel,
          opened,
          debug: ${includeRaw} ? debug : undefined,
        };
      })()
    `);

    if (base.exceptionDetails || base.result.value == null) {
      return {
        currentModel: null,
        availableModels: [],
        supportsModelSwitching: false,
        debug: includeRaw
          ? (base.exceptionDetails?.exception?.description || base.exceptionDetails?.text || "evaluate failed")
          : undefined,
      };
    }

    const baseValue = base.result.value as {
      currentModel: string | null;
      opened: boolean;
      debug?: unknown;
    };

    const readMenuItems = async (onlyVisible: boolean): Promise<string[]> => {
      const res = await cometClient.safeEvaluate(`
        (() => {
          const EXCLUDED = new Set(['search', 'research', 'labs', 'learn']);
          const MODEL_WORDS = [
            'gpt', 'openai', 'claude', 'anthropic', 'sonar', 'llama', 'gemini',
            'mistral', 'deepseek', 'qwen', 'o1', 'o3', 'opus', 'sonnet', 'haiku'
          ];
          const looksLikeModel = (text) => {
            const t = (text || '').trim();
            if (!t) return false;
            const lower = t.toLowerCase();
            if (EXCLUDED.has(lower)) return false;
            if (lower.length < 2) return false;
            return MODEL_WORDS.some(w => lower.includes(w));
          };
          const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();
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
          const items = new Set();
          const nodes = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"], [role="listbox"] button, [data-radix-collection-item]'));
          for (const n of nodes) {
            if (!isVisible(n)) continue;
            const t = normalize((n.innerText || n.textContent || ''));
            if (!t) continue;
            if (EXCLUDED.has(t.toLowerCase())) continue;
            if (looksLikeModel(t) || t.toLowerCase().includes('model')) items.add(t);
          }
          return Array.from(items);
        })()
      `);
      if (res.exceptionDetails || res.result.value == null) return [];
      return res.result.value as string[];
    };

    let availableModels = await readMenuItems(openMenu);
    if (openMenu && baseValue.opened && availableModels.length === 0) {
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 80));
        availableModels = await readMenuItems(true);
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
      debug: includeRaw ? baseValue.debug : undefined,
    };
  }

  async setModel(modelName: string): Promise<{
    changed: boolean;
    currentModel: string | null;
    availableModels: string[];
    debug?: unknown;
  }> {
    const target = (modelName || "").trim();
    if (!target) {
      return { changed: false, currentModel: null, availableModels: [], debug: "modelName is empty" };
    }

    const infoBefore = await this.getModelInfo({ openMenu: true, includeRaw: true });

    const openResult = await cometClient.safeEvaluate(`
      (() => {
        const EXCLUDED = new Set(['search', 'research', 'labs', 'learn']);
        const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();
        const triggers = Array.from(document.querySelectorAll('button, [role="combobox"], [aria-haspopup="listbox"], [aria-haspopup="menu"]'));
        const candidates = [];
        for (const el of triggers) {
          const text = normalize(el.innerText || el.textContent || '');
          const aria = normalize(el.getAttribute('aria-label') || '');
          const title = normalize(el.getAttribute('title') || '');
          const combined = [text, aria, title].filter(Boolean).join(' | ').toLowerCase();
          if (!combined) continue;
          if (EXCLUDED.has(text.toLowerCase())) continue;
          const visible = (() => {
            try {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            } catch {
              return false;
            }
          })();
          if (!visible) continue;
          if (combined.includes('model')) candidates.push({ el, score: 3 });
          else if (combined.includes('gpt') || combined.includes('claude') || combined.includes('sonar') || combined.includes('gemini')) candidates.push({ el, score: 2 });
          else candidates.push({ el, score: 1 });
        }
        candidates.sort((a,b) => b.score - a.score);
        const trigger = candidates[0]?.el || null;
        if (!trigger) return { ok: false, error: 'No model selector trigger found' };
        try {
          trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          trigger.click();
        } catch {}
        // Best-effort check: see if any visible option-like nodes appear.
        const isVisible = (el) => {
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
        const optionNodes = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="radio"], [role="listbox"] button, [data-radix-collection-item]')).filter(isVisible);
        const sample = optionNodes.slice(0, 5).map(n => normalize((n.innerText || n.textContent || ''))).filter(Boolean);
        return { ok: true, visibleOptionCount: optionNodes.length, sample };
      })()
    `);

    const openInfo = openResult.result.value as any;
    let clickInfo: any = { ok: false, clicked: false, matched: null };
    if (openInfo?.ok) {
      for (let i = 0; i < 10; i++) {
        const attempt = await cometClient.safeEvaluate(`
          (() => {
            const target = ${JSON.stringify(target)}.toLowerCase();
            const EXCLUDED = new Set(['search', 'research', 'labs', 'learn']);
            const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();
            const isVisible = (el) => {
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

            const selectorGroups = [
              '[role="option"], [role="menuitemradio"], [role="menuitem"], [role="radio"], [role="listbox"] button, [data-radix-collection-item]',
              'button',
              '[tabindex="0"], [tabindex="-1"]',
            ];

            let matched = null;
            let matchedSelector = null;
            for (const sel of selectorGroups) {
              const options = Array.from(document.querySelectorAll(sel));
              for (const opt of options) {
                if (!isVisible(opt)) continue;
                const text = normalize((opt.innerText || opt.textContent || ''));
                if (!text) continue;
                if (EXCLUDED.has(text.toLowerCase())) continue;
                const lower = text.toLowerCase();
                if (lower === target || lower.includes(target) || target.includes(lower)) {
                  matched = text;
                  matchedSelector = sel;
                  try { opt.click(); } catch {}
                  break;
                }
              }
              if (matched) break;
            }

            return { clicked: !!matched, matched, matchedSelector };
          })()
        `);
        clickInfo = attempt.result.value as any;
        if (clickInfo?.clicked) break;
        await new Promise((r) => setTimeout(r, 80));
      }
    }

    await cometClient.safeEvaluate(`
      (() => {
        try {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        } catch {}
        return true;
      })()
    `);

    await new Promise((r) => setTimeout(r, 150));
    const infoAfter = await this.getModelInfo({ openMenu: false, includeRaw: true });

    return {
      changed: !!clickInfo?.clicked,
      currentModel: infoAfter.currentModel,
      availableModels:
        infoAfter.availableModels.length > 0
          ? infoAfter.availableModels
          : infoBefore.availableModels,
      debug: { before: infoBefore, openInfo, clickInfo, after: infoAfter },
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
        const LABELS = ['隐身', '无痕', 'Incognito', 'Private', 'Temporary'];
        const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const isVisible = (el) => {
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
        const isCheckVisible = (root) => {
          try {
            const uses = Array.from(root.querySelectorAll('use'));
            const findHref = (u) =>
              u.getAttribute('href') ||
              u.getAttribute('xlink:href') ||
              u.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ||
              '';

            const checkUse =
              uses.find((u) => {
                const href = findHref(u);
                return href === '#pplx-icon-check' || href.endsWith('icon-check');
              }) || null;

            if (!checkUse) return false;
            const container = checkUse.closest('span') || checkUse.closest('svg') || checkUse;
            return isVisible(container);
          } catch {
            return false;
          }
        };

        const items = Array.from(
          document.querySelectorAll('[role=\"menuitem\"], [data-radix-collection-item]')
        );
        const visibleItems = items.filter(isVisible);

        for (const el of visibleItems) {
          const text = norm(el.innerText || el.textContent || '');
          if (!text) continue;
          const matched = LABELS.find((l) => text === l || text.includes(l));
          if (!matched) continue;
          const disabled =
            el.getAttribute('aria-disabled') === 'true' ||
            ('disabled' in el && el.disabled === true);
          if (disabled) return { attempted: true, clicked: false, reason: 'disabled', label: text };

          const isOn = isCheckVisible(el);
          if (want === isOn)
            return { attempted: false, clicked: false, reason: 'already', label: text, isOn };

          try {
            el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            el.click();
            return { attempted: true, clicked: true, label: text, before: isOn, want };
          } catch (e) {
            return { attempted: true, clicked: false, reason: String(e), label: text };
          }
        }

        return { attempted: false, clicked: false, reason: 'not found' };
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
    // Get the actual browsing URL from the agent's tab (not from text parsing)
    let agentBrowsingUrl = '';
    try {
      const tabs = await cometClient.listTabsCategorized();
      if (tabs.agentBrowsing) {
        agentBrowsingUrl = tabs.agentBrowsing.url;
      }
    } catch {
      // Continue without URL
    }

    // Get status from the current Perplexity page
    const result = await cometClient.safeEvaluate(`
      (() => {
        // Force fresh read
        const body = document.body.innerText;

        // Check for ACTIVE stop button - multiple detection methods
        let hasActiveStopButton = false;
        const stopButtons = document.querySelectorAll('button');
        for (const btn of stopButtons) {
          if (btn.offsetParent === null || btn.disabled) continue;

          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          const title = (btn.getAttribute('title') || '').toLowerCase();
          const stopish =
            ariaLabel.includes('stop') ||
            ariaLabel.includes('cancel') ||
            ariaLabel.includes('pause') ||
            title.includes('stop') ||
            title.includes('cancel') ||
            title.includes('pause');

          if (stopish) {
            hasActiveStopButton = true;
            break;
          }
        }

        // Check for animated loading indicators (best-effort; UI varies)
        const hasLoadingSpinner =
          document.querySelector('[class*="animate-spin"], .spinner') !== null ||
          document.querySelector('[aria-label*="Loading"], [aria-label*="loading"]') !== null;

        // Always extract the latest visible response text (even if status detection is wrong).
        // Prefer the latest assistant "answer block" over broad page text so comparisons stay stable.
        const responseSelectors = ${JSON.stringify(SELECTORS.response)};
        const pickLatestResponse = () => {
          for (const sel of responseSelectors) {
            try {
              const els = document.querySelectorAll(sel);
              for (let i = els.length - 1; i >= 0; i--) {
                const text = (els[i].innerText || '').trim();
                if (text.length > 5 && !text.startsWith('Related')) return text;
              }
            } catch {
              // ignore invalid selectors
            }
          }
          return '';
        };
        const latestResponse = pickLatestResponse();

        // Check for completion indicators
        const stepsCompletedMatch = body.match(/(\\d+) steps? completed/i);
        const hasStepsCompleted = stepsCompletedMatch !== null;

        // Check for "Finished" or "Reviewed N sources"
        const hasFinishedMarker = body.includes('Finished') && !hasActiveStopButton;
        const hasReviewedSources = /Reviewed \\d+ sources?/i.test(body);

        // Working indicators
        const workingPatterns = [
          'Working…', 'Working...', 'Searching', 'Reviewing sources',
          'Preparing to assist', 'Clicking', 'Typing:', 'Navigating to',
          'Reading', 'Analyzing', 'Generating', 'Thinking', 'Writing'
        ];
        const hasWorkingText = workingPatterns.some(p => body.includes(p));

        // Status determination
        let status = 'idle';
        if (hasActiveStopButton || hasLoadingSpinner) {
          status = 'working';
        } else if (hasStepsCompleted || hasFinishedMarker) {
          status = 'completed';
        } else if (hasReviewedSources && !hasWorkingText) {
          status = 'completed';
        } else if (hasWorkingText) {
          status = 'working';
        }

        // Additional completion hint: if a response is visible and nothing looks in-flight.
        if (!hasActiveStopButton && !hasLoadingSpinner && !hasWorkingText && latestResponse.length > 5) {
          status = 'completed';
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

    return {
      ...evalResult,
      agentBrowsingUrl, // From actual tab, not text parsing
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
