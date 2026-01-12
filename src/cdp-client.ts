// CDP Client wrapper for Comet browser control using puppeteer-core

import puppeteer, { Browser, CDPSession } from "puppeteer-core";
import * as PuppeteerErrors from "puppeteer-core";
import { spawn, ChildProcess } from "child_process";
import type {
  CDPTarget,
  CDPVersion,
  NavigateResult,
  ScreenshotResult,
  EvaluateResult,
  CometState,
} from "./types.js";
import { PERPLEXITY_URL } from "./session-manager.js";

const COMET_PATH = "/Applications/Comet.app/Contents/MacOS/Comet";
const DEFAULT_PORT = parseInt(process.env.COMET_PORT || "9222", 10);

const {
  TargetCloseError,
  ProtocolError,
  TimeoutError,
  isErrnoException,
} = PuppeteerErrors as any;

const RECOVERABLE_ERRNO = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"]);

function isRecoverableError(error: unknown): boolean {
  if (error instanceof TargetCloseError) return true;
  if (error instanceof TimeoutError) return true;
  if (error instanceof ProtocolError) {
    const msg = (error as Error).message;
    return msg.includes("Target closed") || msg.includes("Session closed");
  }
  if (isErrnoException(error) && (error as any).code && RECOVERABLE_ERRNO.has((error as any).code)) {
    return true;
  }
  return false;
}

export class CometCDPClient {
  private browser: Browser | null = null;
  private browserSession: CDPSession | null = null;
  private sessions: Map<string, CDPSession> = new Map();
  private cometProcess: ChildProcess | null = null;
  private state: CometState = {
    connected: false,
    port: DEFAULT_PORT,
  };
  private lastTargetId: string | undefined;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private reconnectPromise: Promise<string> | null = null;
  private connectPromises: Map<string, Promise<string>> = new Map();

  get isConnected(): boolean {
    return this.state.connected && this.sessions.size > 0;
  }

  get currentState(): CometState {
    return { ...this.state };
  }

  getSession(targetId: string): CDPSession | null {
    return this.sessions.get(targetId) || null;
  }

  hasSession(targetId: string): boolean {
    return this.sessions.has(targetId);
  }

  // ============================================================
  // Connection Management
  // ============================================================

  /**
   * Get WebSocket endpoint from CDP HTTP API
   */
  private async getWebSocketEndpoint(): Promise<string> {
    const version = await this.getVersion();
    return version.webSocketDebuggerUrl;
  }

  private async connectBrowser(timeoutMs: number = 10000): Promise<void> {
    if (this.browser?.connected) return;

    const wsEndpoint = await this.getWebSocketEndpoint();

    const connectPromise = puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: null,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Browser connection timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    this.browser = await Promise.race([connectPromise, timeoutPromise]);
    this.browserSession = await this.browser.target().createCDPSession();

    this.browser.on("disconnected", () => {
      this.handleBrowserDisconnect();
    });
  }

  private resetConnectionState(targetId?: string): void {
    if (targetId) {
      this.sessions.delete(targetId);
      this.connectPromises.delete(targetId);
      if (this.state.activeTabId === targetId) {
        this.state.activeTabId = undefined;
        this.state.currentUrl = undefined;
      }
    } else {
      this.sessions.clear();
      this.connectPromises.clear();
      this.state.activeTabId = undefined;
      this.state.currentUrl = undefined;
    }
    this.state.connected = this.sessions.size > 0;
  }

  private handleBrowserDisconnect(): void {
    this.resetConnectionState();
    this.browserSession = null;
    this.browser = null;
  }

  /**
   * Schedule a reconnect with deduplication and exponential backoff
   */
  private async scheduleReconnect(): Promise<string> {
    if (this.reconnectPromise) {
      return this.reconnectPromise;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 5000);
    this.reconnectAttempts++;

    this.reconnectPromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.reconnect();
    })().finally(() => {
      this.reconnectPromise = null;
    });

    return this.reconnectPromise;
  }

  /**
   * Auto-reconnect wrapper for operations
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
      if (isRecoverableError(error) && this.reconnectAttempts < this.maxReconnectAttempts) {
        await this.scheduleReconnect();
        return await operation();
      }
      throw error;
    }
  }

  async reconnect(): Promise<string> {
    await this.cleanupConnection();

    try {
      await this.getVersion();
    } catch {
      try {
        await this.startComet(this.state.port);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } catch {
        throw new Error(
          `Cannot connect to Comet. Please ensure Comet is running with --remote-debugging-port=${this.state.port}`
        );
      }
    }

    await this.connectBrowser();

    const targets = await this.listTargets();

    const lastTarget = this.lastTargetId ? targets.find((t) => t.id === this.lastTargetId) : null;
    if (lastTarget && this.lastTargetId) {
      return await this.connect(this.lastTargetId);
    }

    const perplexityTab = targets.find(
      (t) => t.type === "page" && t.url.includes("perplexity.ai") && !t.url.includes("sidecar")
    );
    const sidecarTab = targets.find((t) => t.type === "page" && t.url.includes("sidecar"));
    const anyPage = targets.find((t) => t.type === "page" && t.url !== "about:blank");

    const target = perplexityTab || sidecarTab || anyPage;
    if (target) {
      return await this.connect(target.id);
    }

    throw new Error("No suitable tab found for reconnection");
  }

  private async cleanupConnection(targetId?: string): Promise<void> {
    if (targetId) {
      const session = this.sessions.get(targetId);
      if (session) {
        try {
          await session.detach();
        } catch {
          // Ignore detach errors
        }
      }
      this.resetConnectionState(targetId);
    } else {
      const detachPromises = Array.from(this.sessions.values()).map((session) =>
        session.detach().catch(() => {})
      );
      await Promise.all(detachPromises);
      this.resetConnectionState();
    }
  }

  // ============================================================
  // Target Management
  // ============================================================

  /**
   * List all available tabs/targets
   */
  async listTargets(): Promise<CDPTarget[]> {
    // Use HTTP API for listing (more reliable, works without browser connection)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`http://localhost:${this.state.port}/json/list`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Failed to list targets: ${response.status}`);
      }
      return (await response.json()) as Promise<CDPTarget[]>;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async createSessionForTarget(targetId: string): Promise<CDPSession> {
    if (!this.browserSession) {
      throw new Error("Browser not connected");
    }
    const connection = this.browserSession.connection();
    if (!connection) {
      throw new Error("Browser connection lost");
    }
    return connection.createSession({
      targetId,
      type: "page",
      title: "",
      url: "",
      attached: false,
      canAccessOpener: false,
    });
  }

  async connect(targetId: string): Promise<string> {
    const existingPromise = this.connectPromises.get(targetId);
    if (existingPromise) {
      return existingPromise;
    }

    const connectPromise = this.doConnect(targetId).finally(() => {
      this.connectPromises.delete(targetId);
    });
    this.connectPromises.set(targetId, connectPromise);

    return connectPromise;
  }

  private async doConnect(targetId: string): Promise<string> {
    await this.connectBrowser();
    await this.cleanupConnection(targetId);

    const session = await this.createSessionForTarget(targetId);
    this.sessions.set(targetId, session);

    session.once("sessiondetached", () => {
      this.resetConnectionState(targetId);
    });

    await Promise.all([
      session.send("Page.enable"),
      session.send("Runtime.enable"),
      session.send("DOM.enable"),
      session.send("Network.enable"),
    ]);

    const shouldForeground =
      process.env.COMET_FOREGROUND === "1" || process.env.COMET_FOREGROUND === "true";

    if (shouldForeground) {
      try {
        await session.send("Page.bringToFront");
      } catch {
        // Not fatal
      }

      try {
        const { windowId } = await session.send("Browser.getWindowForTarget", {
          targetId,
        });
        await session.send("Browser.setWindowBounds", {
          windowId,
          bounds: { width: 1440, height: 900, windowState: "normal" },
        });
      } catch {
        try {
          await session.send("Emulation.setDeviceMetricsOverride", {
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
    this.state.activeTabId = targetId;
    this.lastTargetId = targetId;
    this.reconnectAttempts = 0;

    const { result } = (await session.send("Runtime.evaluate", {
      expression: "window.location.href",
    })) as EvaluateResult;
    this.state.currentUrl = result.value as string;

    return `Connected to tab: ${this.state.currentUrl}`;
  }

  /**
   * Disconnect from current tab
   */
  async disconnect(): Promise<void> {
    await this.cleanupConnection();
    this.browserSession = null;
    if (this.browser) {
      await this.browser.disconnect();
      this.browser = null;
    }
  }

  // ============================================================
  // Tab Navigation Helpers
  // ============================================================

  /**
   * Find and connect to the Perplexity sidecar tab (agent view)
   */
  async connectToSidecar(): Promise<string> {
    const targets = await this.listTargets();
    const sidecarTab = targets.find((t) => t.type === "page" && t.url.includes("sidecar"));

    if (sidecarTab) {
      return await this.connect(sidecarTab.id);
    }

    throw new Error("No sidecar tab found. Agent mode may not be active.");
  }

  /**
   * Find and connect to the main Perplexity tab
   */
  async connectToMain(): Promise<string> {
    const targets = await this.listTargets();
    const mainTab = targets.find(
      (t) =>
        t.type === "page" &&
        t.url.includes("perplexity.ai") &&
        !t.url.includes("sidecar") &&
        !t.url.includes("chrome-extension")
    );

    if (mainTab) {
      return await this.connect(mainTab.id);
    }

    throw new Error("No main Perplexity tab found.");
  }

  /**
   * Get the tab where the agent is currently browsing
   */
  async getAgentBrowsingTab(): Promise<CDPTarget | null> {
    const targets = await this.listTargets();
    const agentTab = targets.find(
      (t) =>
        t.type === "page" &&
        !t.url.includes("perplexity.ai") &&
        !t.url.includes("chrome-extension") &&
        !t.url.includes("chrome://") &&
        t.url !== "about:blank"
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
      main:
        targets.find(
          (t) => t.type === "page" && t.url.includes("perplexity.ai") && !t.url.includes("sidecar")
        ) || null,
      sidecar: targets.find((t) => t.type === "page" && t.url.includes("sidecar")) || null,
      agentBrowsing:
        targets.find(
          (t) =>
            t.type === "page" &&
            !t.url.includes("perplexity.ai") &&
            !t.url.includes("chrome-extension") &&
            !t.url.includes("chrome://") &&
            t.url !== "about:blank"
        ) || null,
      overlay:
        targets.find((t) => t.url.includes("chrome-extension") && t.url.includes("overlay")) ||
        null,
      others: targets.filter(
        (t) =>
          t.type === "page" &&
          !t.url.includes("perplexity.ai") &&
          !t.url.includes("chrome-extension")
      ),
    };
  }

  async getCurrentUrl(targetId: string): Promise<string | null> {
    try {
      const session = this.getSessionOrThrow(targetId);
      const { result } = (await session.send("Runtime.evaluate", {
        expression: "location.href",
      })) as EvaluateResult;
      return (result.value as string) || null;
    } catch {
      return null;
    }
  }

  /**
   * Ensure we're connected to a Perplexity page (main or sidecar).
   */
  async ensureOnPerplexity(targetId: string): Promise<void> {
    const url = await this.getCurrentUrl(targetId);
    if (url?.includes("perplexity.ai")) return;

    try {
      await this.connectToMain();
      return;
    } catch {
      // Continue
    }

    try {
      await this.connectToSidecar();
      return;
    } catch {
      // Continue
    }

    throw new Error(
      `Not on Perplexity page (current: ${url || "unknown"}). ` +
        `No Perplexity tab found. Please navigate to ${PERPLEXITY_URL}`
    );
  }

  /**
   * Ensure we're connected to the main Perplexity page (not sidecar).
   */
  async ensureOnPerplexityMain(targetId: string): Promise<void> {
    const url = await this.getCurrentUrl(targetId);
    if (url?.includes("perplexity.ai") && !url.includes("sidecar")) return;

    try {
      await this.connectToMain();
    } catch {
      throw new Error(
        `Not on main Perplexity page (current: ${url || "unknown"}). ` +
          `Account settings require the main Perplexity tab.`
      );
    }
  }

  // ============================================================
  // Comet Process Management
  // ============================================================

  /**
   * Check if Comet process is running
   */
  private async isCometProcessRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const check = spawn("pgrep", ["-f", "Comet.app"]);
      check.on("close", (code) => {
        resolve(code === 0);
      });
    });
  }

  /**
   * Kill any running Comet process
   */
  private async killComet(): Promise<void> {
    return new Promise((resolve) => {
      const kill = spawn("pkill", ["-f", "Comet.app"]);
      kill.on("close", () => {
        setTimeout(resolve, 1000);
      });
    });
  }

  /**
   * Start Comet browser with remote debugging enabled
   */
  async startComet(port: number = DEFAULT_PORT): Promise<string> {
    this.state.port = port;

    // Check if Comet is already running WITH debugging enabled
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);

      const response = await fetch(`http://localhost:${port}/json/version`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const version = (await response.json()) as CDPVersion;
        return `Comet already running with debug port: ${version.Browser}`;
      }
    } catch {
      // Debug port not available, check if Comet is running without it
      const isRunning = await this.isCometProcessRunning();
      if (isRunning) {
        await this.killComet();
      }
    }

    // Start Comet with debugging enabled
    return new Promise((resolve, reject) => {
      this.cometProcess = spawn(COMET_PATH, [`--remote-debugging-port=${port}`], {
        detached: true,
        stdio: "ignore",
      });

      this.cometProcess.unref();

      const maxAttempts = 40;
      let attempts = 0;

      const checkReady = async () => {
        attempts++;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);

          const response = await fetch(`http://localhost:${port}/json/version`, {
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (response.ok) {
            const version = (await response.json()) as CDPVersion;
            resolve(`Comet started with debug port ${port}: ${version.Browser}`);
            return;
          }
        } catch {
          // Keep trying
        }

        if (attempts < maxAttempts) {
          setTimeout(checkReady, 500);
        } else {
          reject(
            new Error(
              `Timeout waiting for Comet to start. Please try manually: ${COMET_PATH} --remote-debugging-port=${port}`
            )
          );
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
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Failed to get version: ${response.status}`);
      }
      return response.json() as Promise<CDPVersion>;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ============================================================
  // Page Operations
  // ============================================================

  /**
   * Navigate to a URL
   */
  async navigate(url: string, waitForLoad: boolean, targetId: string): Promise<NavigateResult> {
    const session = this.getSessionOrThrow(targetId);
    const result = (await session.send("Page.navigate", { url })) as NavigateResult;

    if (waitForLoad) {
      const start = Date.now();
      while (Date.now() - start < 15000) {
        try {
          const ready = (await session.send("Runtime.evaluate", {
            expression: "document.readyState",
            returnByValue: true,
          })) as EvaluateResult;
          const state = (ready.result.value as string) || "";
          if (state === "complete" || state === "interactive") break;
        } catch {
          // Ignore transient evaluation errors during navigation
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    this.state.currentUrl = url;
    return result;
  }

  /**
   * Capture screenshot
   */
  async screenshot(format: "png" | "jpeg", quality: number | undefined, targetId: string): Promise<ScreenshotResult> {
    const session = this.getSessionOrThrow(targetId);

    const options: { format: "png" | "jpeg" | "webp"; quality?: number } = { format };
    if (quality !== undefined && format !== "png") {
      options.quality = quality;
    }

    return session.send("Page.captureScreenshot", options) as Promise<ScreenshotResult>;
  }

  /**
   * Execute JavaScript in the page context
   */
  async evaluate(expression: string, targetId: string): Promise<EvaluateResult> {
    const session = this.getSessionOrThrow(targetId);

    return session.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as Promise<EvaluateResult>;
  }

  /**
   * Execute JavaScript with auto-reconnect on connection loss
   */
  async safeEvaluate(expression: string, targetId: string): Promise<EvaluateResult> {
    return this.withAutoReconnect(async () => {
      const session = this.getSessionOrThrow(targetId);
      return session.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }) as Promise<EvaluateResult>;
    });
  }

  /**
   * Get page HTML content
   */
  async getPageContent(targetId: string): Promise<string> {
    const result = await this.evaluate("document.documentElement.outerHTML", targetId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text);
    }
    return result.result.value as string;
  }

  /**
   * Get page text content
   */
  async getPageText(targetId: string): Promise<string> {
    const result = await this.evaluate("document.body.innerText", targetId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text);
    }
    return result.result.value as string;
  }

  // ============================================================
  // DOM Interaction
  // ============================================================

  /**
   * Click on an element
   */
  async click(selector: string, targetId: string): Promise<boolean> {
    const result = await this.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) {
          el.click();
          return true;
        }
        return false;
      })()
    `, targetId);
    return result.result.value as boolean;
  }

  /**
   * Type text into an element
   */
  async type(selector: string, text: string, targetId: string): Promise<boolean> {
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
    `, targetId);
    return result.result.value as boolean;
  }

  /**
   * Press a key
   */
  async pressKey(key: string, selector: string | undefined, targetId: string): Promise<void> {
    const session = this.getSessionOrThrow(targetId);

    if (selector) {
      await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.focus()`, targetId);
    }

    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
    });
  }

  async pressKeyWithModifiers(
    key: string,
    modifiers: number,
    options: { code?: string; selector?: string; targetId: string }
  ): Promise<void> {
    const session = this.getSessionOrThrow(options.targetId);

    if (options.selector) {
      await this.evaluate(`document.querySelector(${JSON.stringify(options.selector)})?.focus()`, options.targetId);
    }

    const code = options.code;

    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      modifiers,
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      modifiers,
    });
  }

  async insertText(text: string, targetId: string): Promise<void> {
    const session = this.getSessionOrThrow(targetId);
    await session.send("Input.insertText", { text });
  }

  /**
   * Wait for an element to appear
   */
  async waitForSelector(selector: string, timeout: number, targetId: string): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const result = await this.evaluate(`
        document.querySelector(${JSON.stringify(selector)}) !== null
      `, targetId);

      if (result.result.value === true) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return false;
  }

  /**
   * Wait for page to be idle (no pending network requests)
   */
  async waitForNetworkIdle(timeout: number, targetId: string): Promise<void> {
    const session = this.getSessionOrThrow(targetId);

    return new Promise((resolve) => {
      let pendingRequests = 0;
      let idleTimer: NodeJS.Timeout;
      let resolved = false;

      const isStale = () => this.sessions.get(targetId) !== session;

      const cleanup = () => {
        session.off("Network.requestWillBeSent", onRequest);
        session.off("Network.loadingFinished", onFinished);
        session.off("Network.loadingFailed", onFailed);
        session.off("sessiondetached", onDetached);
      };

      const finish = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(idleTimer);
        cleanup();
        resolve();
      };

      const onDetached = () => finish();

      const checkIdle = () => {
        if (resolved || isStale()) return;
        if (pendingRequests === 0) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(finish, 500);
        }
      };

      const onRequest = () => {
        if (resolved || isStale()) return;
        pendingRequests++;
        clearTimeout(idleTimer);
      };

      const onFinished = () => {
        if (resolved || isStale()) return;
        pendingRequests = Math.max(0, pendingRequests - 1);
        checkIdle();
      };

      const onFailed = () => {
        if (resolved || isStale()) return;
        pendingRequests = Math.max(0, pendingRequests - 1);
        checkIdle();
      };

      session.on("Network.requestWillBeSent", onRequest);
      session.on("Network.loadingFinished", onFinished);
      session.on("Network.loadingFailed", onFailed);
      session.once("sessiondetached", onDetached);

      setTimeout(finish, timeout);
      checkIdle();
    });
  }

  // ============================================================
  // Tab Management
  // ============================================================

  /**
   * Create a new tab
   */
  async newTab(url?: string): Promise<CDPTarget> {
    const endpoint = url
      ? `http://localhost:${this.state.port}/json/new?${encodeURIComponent(url)}`
      : `http://localhost:${this.state.port}/json/new`;
    const response = await fetch(endpoint, { method: "PUT" });
    if (!response.ok) {
      throw new Error(`Failed to create new tab: ${response.status}`);
    }
    return response.json() as Promise<CDPTarget>;
  }

  /**
   * Close a tab
   */
  async closeTab(targetId: string): Promise<void> {
    const response = await fetch(`http://localhost:${this.state.port}/json/close/${targetId}`);
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
      spawn("pkill", ["-f", "Comet"], { stdio: "ignore" });
    }
  }

  // ============================================================
  // File Input
  // ============================================================

  /**
   * Set files for a file input element
   */
  async setFileInputFiles(
    files: string[],
    options: { nodeId?: number; backendNodeId?: number; objectId?: string; targetId: string }
  ): Promise<void> {
    const session = this.getSessionOrThrow(options.targetId);
    await session.send("DOM.setFileInputFiles", {
      files,
      nodeId: options.nodeId,
      backendNodeId: options.backendNodeId,
      objectId: options.objectId,
    });
  }

  async getNodeId(selector: string, targetId: string): Promise<number | null> {
    const session = this.getSessionOrThrow(targetId);
    const doc = await session.send("DOM.getDocument");
    const result = await session.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector,
    });
    return result.nodeId || null;
  }

  async getBackendNodeId(selector: string, targetId: string): Promise<number | null> {
    const session = this.getSessionOrThrow(targetId);
    const result = await this.evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? true : false;
      })()
    `, targetId);
    if (!result.result.value) return null;

    const doc = await session.send("DOM.getDocument");
    const queryResult = await session.send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector,
    });
    if (!queryResult.nodeId) return null;

    const nodeDesc = await session.send("DOM.describeNode", {
      nodeId: queryResult.nodeId,
    });
    return nodeDesc.node.backendNodeId || null;
  }

  // ============================================================
  // Utility
  // ============================================================

  private getSessionOrThrow(targetId: string): CDPSession {
    const session = this.sessions.get(targetId);
    if (!session) {
      throw new Error(`No CDP session for targetId: ${targetId}. Call connect(targetId) first.`);
    }
    return session;
  }
}

// Singleton instance
export const cometClient = new CometCDPClient();
