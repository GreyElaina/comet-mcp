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
const DEFAULT_PORT = parseInt(process.env.COMET_PORT || "9222", 10);

export class CometCDPClient {
  private client: CDP.Client | null = null;
  private cometProcess: ChildProcess | null = null;
  private state: CometState = {
    connected: false,
    port: DEFAULT_PORT,
  };
  private lastTargetId: string | undefined;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectPromise: Promise<string> | null = null;

  get isConnected(): boolean {
    return this.state.connected && this.client !== null;
  }

  get currentState(): CometState {
    return { ...this.state };
  }

  /**
   * Auto-reconnect wrapper for operations with improved error handling
   */
  private async withAutoReconnect<T>(operation: () => Promise<T>): Promise<T> {
    if (this.reconnectPromise) {
      await this.reconnectPromise;
    }

    try {
      const result = await operation();
      this.reconnectAttempts = 0;
      return result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const connectionErrors = [
        'WebSocket',
        'CLOSED',
        'not open',
        'disconnected',
        'ECONNREFUSED',
        'ECONNRESET',
        'Protocol error',
        'Target closed',
        'Session closed'
      ];

      const isConnectionError = connectionErrors.some(e => errorMessage.includes(e));

      if (isConnectionError && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;

        if (!this.reconnectPromise) {
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 5000);
          this.reconnectPromise = (async () => {
            await new Promise(resolve => setTimeout(resolve, delay));
            return this.reconnect();
          })().finally(() => {
            this.reconnectPromise = null;
          });
        }

        await this.reconnectPromise;
        return await operation();
      }

      throw error;
    }
  }

  /**
   * Reconnect to the last connected tab with improved retry logic
   */
  async reconnect(): Promise<string> {
    // Cleanup old connection
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // Ignore close errors
      }
    }
    this.state.connected = false;
    this.client = null;

    // Verify Comet is still running
    try {
      await this.getVersion();
    } catch {
      // Comet might have crashed, try to restart
      try {
        await this.startComet(this.state.port);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch {
        throw new Error(`Cannot connect to Comet. Please ensure Comet is running with --remote-debugging-port=${this.state.port}`);
      }
    }

    // Try to reconnect to the last target
    if (this.lastTargetId) {
      try {
        const targets = await this.listTargets();
        const lastTarget = targets.find(t => t.id === this.lastTargetId);
        if (lastTarget) {
          return await this.connect(this.lastTargetId);
        }
      } catch {
        // Target might be gone, find a new one
      }
    }

    // Find the best target to connect to (prioritize main Perplexity tab)
    const targets = await this.listTargets();
    const perplexityTab = targets.find(t =>
      t.type === 'page' && t.url.includes('perplexity.ai') && !t.url.includes('sidecar')
    );
    const sidecarTab = targets.find(t =>
      t.type === 'page' && t.url.includes('sidecar')
    );
    const anyPage = targets.find(t => t.type === 'page' && t.url !== 'about:blank');

    const target = perplexityTab || sidecarTab || anyPage;
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
   * Get the current page URL of the connected tab
   */
  async getCurrentUrl(): Promise<string | null> {
    if (!this.client) return null;
    try {
      const { result } = await this.client.Runtime.evaluate({
        expression: 'location.href'
      });
      return result.value || null;
    } catch {
      return null;
    }
  }

  /**
   * Ensure we're connected to a Perplexity page (main or sidecar).
   * Tries main tab first, then sidecar as fallback.
   */
  async ensureOnPerplexity(): Promise<void> {
    const url = await this.getCurrentUrl();
    if (url?.includes('perplexity.ai')) return;

    try {
      await this.connectToMain();
      return;
    } catch {}

    try {
      await this.connectToSidecar();
      return;
    } catch {}

    throw new Error(
      `Not on Perplexity page (current: ${url || 'unknown'}). ` +
      `No Perplexity tab found. Please navigate to https://www.perplexity.ai/`
    );
  }

  /**
   * Ensure we're connected to the main Perplexity page (not sidecar).
   * Required for operations like account menu that only exist on main page.
   */
  async ensureOnPerplexityMain(): Promise<void> {
    const url = await this.getCurrentUrl();
    if (url?.includes('perplexity.ai') && !url.includes('sidecar')) return;

    try {
      await this.connectToMain();
    } catch {
      throw new Error(
        `Not on main Perplexity page (current: ${url || 'unknown'}). ` +
        `Account settings require the main Perplexity tab.`
      );
    }
  }

  /**
   * Check if Comet process is running (regardless of debug port)
   */
  private async isCometProcessRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const check = spawn('pgrep', ['-f', 'Comet.app']);
      check.on('close', (code) => {
        resolve(code === 0);
      });
    });
  }

  /**
   * Kill any running Comet process
   */
  private async killComet(): Promise<void> {
    return new Promise((resolve) => {
      const kill = spawn('pkill', ['-f', 'Comet.app']);
      kill.on('close', () => {
        // Wait a bit for process to fully terminate
        setTimeout(resolve, 1000);
      });
    });
  }

  /**
   * Start Comet browser with remote debugging enabled
   * Automatically restarts Comet if it's running without debug port
   */
  async startComet(port: number = DEFAULT_PORT): Promise<string> {
    this.state.port = port;

    // Check if Comet is already running WITH debugging enabled
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`http://localhost:${port}/json/version`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const version = await response.json() as CDPVersion;
        return `Comet already running with debug port: ${version.Browser}`;
      }
    } catch {
      // Debug port not available, check if Comet is running without it
      const isRunning = await this.isCometProcessRunning();
      if (isRunning) {
        // Comet is running but without debug port - restart it
        await this.killComet();
      }
    }

    // Start Comet with debugging enabled
    return new Promise((resolve, reject) => {
      this.cometProcess = spawn(COMET_PATH, [
        `--remote-debugging-port=${port}`,
      ], {
        detached: true,
        stdio: "ignore",
      });

      this.cometProcess.unref();

      // Wait for Comet to start
      const maxAttempts = 40; // 20 seconds total
      let attempts = 0;

      const checkReady = async () => {
        attempts++;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);

          const response = await fetch(`http://localhost:${port}/json/version`, {
            signal: controller.signal
          });
          clearTimeout(timeoutId);

          if (response.ok) {
            const version = await response.json() as CDPVersion;
            resolve(`Comet started with debug port ${port}: ${version.Browser}`);
            return;
          }
        } catch {
          // Keep trying
        }

        if (attempts < maxAttempts) {
          setTimeout(checkReady, 500);
        } else {
          reject(new Error(`Timeout waiting for Comet to start. Please try manually: /Applications/Comet.app/Contents/MacOS/Comet --remote-debugging-port=${port}`));
        }
      };

      setTimeout(checkReady, 1500);
    });
  }

  /**
   * Get CDP version info
   */
  async getVersion(): Promise<CDPVersion> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`http://localhost:${this.state.port}/json/version`, {
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Failed to get version: ${response.status}`);
      }
      return response.json() as Promise<CDPVersion>;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * List all available tabs/targets
   */
  async listTargets(): Promise<CDPTarget[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`http://localhost:${this.state.port}/json/list`, {
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Failed to list targets: ${response.status}`);
      }
      return response.json() as Promise<CDPTarget[]>;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Connect to a specific tab or the first available page
   */
  async connect(targetId?: string): Promise<string> {
    if (this.client) {
      await this.disconnect();
    }

    let resolvedTargetId = targetId;
    if (!resolvedTargetId) {
      const targets = await this.listTargets();
      const page = targets.find(t => t.type === 'page' && t.url !== 'about:blank');
      if (!page) {
        throw new Error('No suitable page target found to connect to');
      }
      resolvedTargetId = page.id;
    }

    const shouldForeground =
      process.env.COMET_FOREGROUND === "1" ||
      process.env.COMET_FOREGROUND === "true";

    const options: CDP.Options = {
      port: this.state.port,
      target: resolvedTargetId,
    };

    this.client = await CDP(options);

    // Enable necessary domains
    await Promise.all([
      this.client.Page.enable(),
      this.client.Runtime.enable(),
      this.client.DOM.enable(),
      this.client.Network.enable(),
    ]);

    if (shouldForeground) {
      try {
        await this.client.Page.bringToFront();
      } catch {
        // Not fatal
      }

      try {
        const { windowId } = await (this.client as any).Browser.getWindowForTarget({
          targetId: resolvedTargetId,
        });
        await (this.client as any).Browser.setWindowBounds({
          windowId,
          bounds: { width: 1440, height: 900, windowState: "normal" },
        });
      } catch {
        try {
          await (this.client as any).Emulation.setDeviceMetricsOverride({
            width: 1440,
            height: 900,
            deviceScaleFactor: 1,
            mobile: false,
          });
        } catch {
          // Continue anyway
        }
      }
    }

    this.state.connected = true;
    this.state.activeTabId = resolvedTargetId;
    this.lastTargetId = resolvedTargetId;
    this.reconnectAttempts = 0;

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
      const start = Date.now();
      // Avoid hanging forever on loadEventFired() for SPA / same-URL navigations.
      while (Date.now() - start < 15000) {
        try {
          const ready = await this.client!.Runtime.evaluate({
            expression: "document.readyState",
            returnByValue: true,
          });
          const state = (ready.result.value as string) || "";
          if (state === "complete" || state === "interactive") break;
        } catch {
          // Ignore transient evaluation errors during navigation
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
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
    if (quality !== undefined && format !== "png") {
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
   * Press a key with modifiers (CDP modifiers bitmask: alt=1, ctrl=2, meta=4, shift=8)
   */
  async pressKeyWithModifiers(
    key: string,
    modifiers: number,
    options?: { code?: string; selector?: string }
  ): Promise<void> {
    this.ensureConnected();

    if (options?.selector) {
      await this.evaluate(`document.querySelector(${JSON.stringify(options.selector)})?.focus()`);
    }

    const code = options?.code;

    await this.client!.Input.dispatchKeyEvent({
      type: "keyDown",
      key,
      code,
      modifiers,
    } as any);
    await this.client!.Input.dispatchKeyEvent({
      type: "keyUp",
      key,
      code,
      modifiers,
    } as any);
  }

  /**
   * Insert text into the currently focused element (more reliable than DOM assignment for React inputs)
   */
  async insertText(text: string): Promise<void> {
    this.ensureConnected();
    await (this.client!.Input as any).insertText({ text });
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
      let resolved = false;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(idleTimer);
        resolve();
      };

      const checkIdle = () => {
        if (resolved) return;
        if (pendingRequests === 0) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(finish, 500);
        }
      };

      this.client!.Network.requestWillBeSent(() => {
        if (resolved) return;
        pendingRequests++;
        clearTimeout(idleTimer);
      });

      this.client!.Network.loadingFinished(() => {
        if (resolved) return;
        pendingRequests = Math.max(0, pendingRequests - 1);
        checkIdle();
      });

      this.client!.Network.loadingFailed(() => {
        if (resolved) return;
        pendingRequests = Math.max(0, pendingRequests - 1);
        checkIdle();
      });

      setTimeout(finish, timeout);
      checkIdle();
    });
  }

  /**
   * Create a new tab
   */
  async newTab(url?: string): Promise<CDPTarget> {
    const endpoint = url
      ? `http://localhost:${this.state.port}/json/new?${encodeURIComponent(url)}`
      : `http://localhost:${this.state.port}/json/new`;
    const response = await fetch(endpoint, { method: 'PUT' });
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

  /**
   * Set files for a file input element
   * Uses CDP DOM.setFileInputFiles API
   */
  async setFileInputFiles(
    files: string[],
    options: { nodeId?: number; backendNodeId?: number; objectId?: string }
  ): Promise<void> {
    this.ensureConnected();
    await this.client!.DOM.setFileInputFiles({
      files,
      nodeId: options.nodeId,
      backendNodeId: options.backendNodeId,
      objectId: options.objectId,
    });
  }

  /**
   * Get the nodeId of an element by selector
   */
  async getNodeId(selector: string): Promise<number | null> {
    this.ensureConnected();
    const doc = await this.client!.DOM.getDocument();
    const result = await this.client!.DOM.querySelector({
      nodeId: doc.root.nodeId,
      selector,
    });
    return result.nodeId || null;
  }

  /**
   * Get the backendNodeId of an element by selector (more reliable for file inputs)
   */
  async getBackendNodeId(selector: string): Promise<number | null> {
    this.ensureConnected();
    const result = await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? true : false;
      })()
    `);
    if (!result.result.value) return null;

    const doc = await this.client!.DOM.getDocument();
    const queryResult = await this.client!.DOM.querySelector({
      nodeId: doc.root.nodeId,
      selector,
    });
    if (!queryResult.nodeId) return null;

    const nodeDesc = await this.client!.DOM.describeNode({ nodeId: queryResult.nodeId });
    return nodeDesc.node.backendNodeId || null;
  }
}

// Singleton instance
export const cometClient = new CometCDPClient();
