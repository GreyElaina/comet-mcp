// CDP Client wrapper for Comet browser control

import CDP from "chrome-remote-interface";
import { spawn, ChildProcess } from "child_process";
import type {
  CDPTarget,
  CDPVersion,
  NavigateResult,
  ScreenshotResult,
  EvaluateResult,
  CometState,
} from "./types.js";

const COMET_PATH = "/Applications/Comet.app/Contents/MacOS/Comet";
const DEFAULT_PORT = 9222;

export class CometCDPClient {
  private client: CDP.Client | null = null;
  private cometProcess: ChildProcess | null = null;
  private state: CometState = {
    connected: false,
    port: DEFAULT_PORT,
  };
  private lastTargetId: string | undefined;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 3;

  get isConnected(): boolean {
    return this.state.connected && this.client !== null;
  }

  get currentState(): CometState {
    return { ...this.state };
  }

  /**
   * Auto-reconnect wrapper for operations
   */
  private async withAutoReconnect<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('WebSocket') || errorMessage.includes('CLOSED') || errorMessage.includes('not open')) {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          console.log(`Connection lost, attempting reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          await this.reconnect();
          return await operation();
        }
      }
      throw error;
    }
  }

  /**
   * Reconnect to the last connected tab
   */
  async reconnect(): Promise<string> {
    this.state.connected = false;
    this.client = null;

    // Try to reconnect to the last target or find a suitable one
    if (this.lastTargetId) {
      try {
        return await this.connect(this.lastTargetId);
      } catch {
        // Target might be gone, find a new one
      }
    }

    // Find the best target to connect to
    const targets = await this.listTargets();
    const perplexityTab = targets.find(t =>
      t.type === 'page' && t.url.includes('perplexity.ai') && !t.url.includes('sidecar')
    );
    const sidecarTab = targets.find(t =>
      t.type === 'page' && t.url.includes('sidecar')
    );

    const target = perplexityTab || sidecarTab || targets.find(t => t.type === 'page');
    if (target) {
      return await this.connect(target.id);
    }

    throw new Error('No suitable tab found for reconnection');
  }

  /**
   * Find and connect to the Perplexity sidecar tab (agent view)
   */
  async connectToSidecar(): Promise<string> {
    const targets = await this.listTargets();
    const sidecarTab = targets.find(t =>
      t.type === 'page' && t.url.includes('sidecar')
    );

    if (sidecarTab) {
      return await this.connect(sidecarTab.id);
    }

    throw new Error('No sidecar tab found. Agent mode may not be active.');
  }

  /**
   * Find and connect to the main Perplexity tab
   */
  async connectToMain(): Promise<string> {
    const targets = await this.listTargets();
    const mainTab = targets.find(t =>
      t.type === 'page' &&
      t.url.includes('perplexity.ai') &&
      !t.url.includes('sidecar') &&
      !t.url.includes('chrome-extension')
    );

    if (mainTab) {
      return await this.connect(mainTab.id);
    }

    throw new Error('No main Perplexity tab found.');
  }

  /**
   * Get the tab where the agent is currently browsing
   */
  async getAgentBrowsingTab(): Promise<CDPTarget | null> {
    const targets = await this.listTargets();
    // The agent overlay contains info about which tab it's controlling
    const agentTab = targets.find(t =>
      t.type === 'page' &&
      !t.url.includes('perplexity.ai') &&
      !t.url.includes('chrome-extension') &&
      !t.url.includes('chrome://') &&
      t.url !== 'about:blank'
    );
    return agentTab || null;
  }

  /**
   * List tabs with categorization
   */
  async listTabsCategorized(): Promise<{
    main: CDPTarget | null;
    sidecar: CDPTarget | null;
    agentBrowsing: CDPTarget | null;
    overlay: CDPTarget | null;
    others: CDPTarget[];
  }> {
    const targets = await this.listTargets();

    return {
      main: targets.find(t =>
        t.type === 'page' &&
        t.url.includes('perplexity.ai') &&
        !t.url.includes('sidecar')
      ) || null,
      sidecar: targets.find(t =>
        t.type === 'page' && t.url.includes('sidecar')
      ) || null,
      agentBrowsing: targets.find(t =>
        t.type === 'page' &&
        !t.url.includes('perplexity.ai') &&
        !t.url.includes('chrome-extension') &&
        !t.url.includes('chrome://') &&
        t.url !== 'about:blank'
      ) || null,
      overlay: targets.find(t =>
        t.url.includes('chrome-extension') && t.url.includes('overlay')
      ) || null,
      others: targets.filter(t =>
        t.type === 'page' &&
        !t.url.includes('perplexity.ai') &&
        !t.url.includes('chrome-extension')
      ),
    };
  }

  /**
   * Start Comet browser with remote debugging enabled
   */
  async startComet(port: number = DEFAULT_PORT): Promise<string> {
    this.state.port = port;

    // Check if Comet is already running with debugging
    try {
      const version = await this.getVersion();
      return `Comet already running: ${version.Browser}`;
    } catch {
      // Not running, start it
    }

    return new Promise((resolve, reject) => {
      this.cometProcess = spawn(COMET_PATH, [
        `--remote-debugging-port=${port}`,
      ], {
        detached: true,
        stdio: "ignore",
      });

      this.cometProcess.unref();

      // Wait for Comet to start
      const maxAttempts = 30;
      let attempts = 0;

      const checkReady = async () => {
        attempts++;
        try {
          const version = await this.getVersion();
          resolve(`Comet started: ${version.Browser}`);
        } catch {
          if (attempts < maxAttempts) {
            setTimeout(checkReady, 500);
          } else {
            reject(new Error("Timeout waiting for Comet to start"));
          }
        }
      };

      setTimeout(checkReady, 1000);
    });
  }

  /**
   * Get CDP version info
   */
  async getVersion(): Promise<CDPVersion> {
    const response = await fetch(`http://localhost:${this.state.port}/json/version`);
    if (!response.ok) {
      throw new Error(`Failed to get version: ${response.status}`);
    }
    return response.json() as Promise<CDPVersion>;
  }

  /**
   * List all available tabs/targets
   */
  async listTargets(): Promise<CDPTarget[]> {
    const response = await fetch(`http://localhost:${this.state.port}/json/list`);
    if (!response.ok) {
      throw new Error(`Failed to list targets: ${response.status}`);
    }
    return response.json() as Promise<CDPTarget[]>;
  }

  /**
   * Connect to a specific tab or the first available page
   */
  async connect(targetId?: string): Promise<string> {
    if (this.client) {
      await this.disconnect();
    }

    const options: CDP.Options = {
      port: this.state.port,
    };

    if (targetId) {
      options.target = targetId;
    }

    this.client = await CDP(options);

    // Enable necessary domains
    await Promise.all([
      this.client.Page.enable(),
      this.client.Runtime.enable(),
      this.client.DOM.enable(),
      this.client.Network.enable(),
    ]);

    this.state.connected = true;
    this.state.activeTabId = targetId;
    this.lastTargetId = targetId;
    this.reconnectAttempts = 0; // Reset on successful connect

    // Get current URL
    const { result } = await this.client.Runtime.evaluate({
      expression: "window.location.href",
    });
    this.state.currentUrl = result.value as string;

    return `Connected to tab: ${this.state.currentUrl}`;
  }

  /**
   * Disconnect from current tab
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.state.connected = false;
      this.state.activeTabId = undefined;
    }
  }

  /**
   * Navigate to a URL
   */
  async navigate(url: string, waitForLoad: boolean = true): Promise<NavigateResult> {
    this.ensureConnected();

    const result = await this.client!.Page.navigate({ url });

    if (waitForLoad) {
      await this.client!.Page.loadEventFired();
    }

    this.state.currentUrl = url;
    return result as NavigateResult;
  }

  /**
   * Capture screenshot
   */
  async screenshot(format: "png" | "jpeg" = "png", quality?: number): Promise<ScreenshotResult> {
    this.ensureConnected();

    const options: { format: "png" | "jpeg" | "webp"; quality?: number } = { format };
    if (quality !== undefined) {
      options.quality = quality;
    }

    return this.client!.Page.captureScreenshot(options) as Promise<ScreenshotResult>;
  }

  /**
   * Execute JavaScript in the page context
   */
  async evaluate(expression: string): Promise<EvaluateResult> {
    this.ensureConnected();

    return this.client!.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as Promise<EvaluateResult>;
  }

  /**
   * Execute JavaScript with auto-reconnect on connection loss
   */
  async safeEvaluate(expression: string): Promise<EvaluateResult> {
    return this.withAutoReconnect(async () => {
      this.ensureConnected();
      return this.client!.Runtime.evaluate({
        expression,
        awaitPromise: true,
        returnByValue: true,
      }) as Promise<EvaluateResult>;
    });
  }

  /**
   * Get page HTML content
   */
  async getPageContent(): Promise<string> {
    const result = await this.evaluate("document.documentElement.outerHTML");
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text);
    }
    return result.result.value as string;
  }

  /**
   * Get page text content
   */
  async getPageText(): Promise<string> {
    const result = await this.evaluate("document.body.innerText");
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text);
    }
    return result.result.value as string;
  }

  /**
   * Click on an element
   */
  async click(selector: string): Promise<boolean> {
    const result = await this.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.click();
          return true;
        }
        return false;
      })()
    `);
    return result.result.value as boolean;
  }

  /**
   * Type text into an element
   */
  async type(selector: string, text: string): Promise<boolean> {
    const result = await this.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.focus();
          el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      })()
    `);
    return result.result.value as boolean;
  }

  /**
   * Press a key
   */
  async pressKey(key: string, selector?: string): Promise<void> {
    this.ensureConnected();

    if (selector) {
      await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
    }

    // Use Input.dispatchKeyEvent for more reliable key events
    await this.client!.Input.dispatchKeyEvent({
      type: "keyDown",
      key,
    });
    await this.client!.Input.dispatchKeyEvent({
      type: "keyUp",
      key,
    });
  }

  /**
   * Wait for an element to appear
   */
  async waitForSelector(selector: string, timeout: number = 10000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const result = await this.evaluate(`
        document.querySelector(${JSON.stringify(selector)}) !== null
      `);

      if (result.result.value === true) {
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return false;
  }

  /**
   * Wait for page to be idle (no pending network requests)
   */
  async waitForNetworkIdle(timeout: number = 5000): Promise<void> {
    this.ensureConnected();

    return new Promise((resolve) => {
      let pendingRequests = 0;
      let idleTimer: NodeJS.Timeout;

      const checkIdle = () => {
        if (pendingRequests === 0) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(resolve, 500);
        }
      };

      this.client!.Network.requestWillBeSent(() => {
        pendingRequests++;
        clearTimeout(idleTimer);
      });

      this.client!.Network.loadingFinished(() => {
        pendingRequests = Math.max(0, pendingRequests - 1);
        checkIdle();
      });

      this.client!.Network.loadingFailed(() => {
        pendingRequests = Math.max(0, pendingRequests - 1);
        checkIdle();
      });

      // Timeout fallback
      setTimeout(resolve, timeout);

      // Initial check
      checkIdle();
    });
  }

  /**
   * Create a new tab
   */
  async newTab(url?: string): Promise<CDPTarget> {
    const response = await fetch(
      `http://localhost:${this.state.port}/json/new${url ? `?${url}` : ""}`
    );
    if (!response.ok) {
      throw new Error(`Failed to create new tab: ${response.status}`);
    }
    return response.json() as Promise<CDPTarget>;
  }

  /**
   * Close a tab
   */
  async closeTab(targetId: string): Promise<void> {
    const response = await fetch(
      `http://localhost:${this.state.port}/json/close/${targetId}`
    );
    if (!response.ok) {
      throw new Error(`Failed to close tab: ${response.status}`);
    }
  }

  /**
   * Close Comet browser
   */
  async closeComet(): Promise<void> {
    await this.disconnect();

    if (this.cometProcess) {
      this.cometProcess.kill();
      this.cometProcess = null;
    } else {
      // Try to close via pkill
      spawn("pkill", ["-f", "Comet"], { stdio: "ignore" });
    }
  }

  private ensureConnected(): void {
    if (!this.client) {
      throw new Error("Not connected to Comet. Call connect() first.");
    }
  }
}

// Singleton instance
export const cometClient = new CometCDPClient();
