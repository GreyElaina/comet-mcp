import { cometClient } from "./cdp-client.js";
import {
  SessionState,
  SESSION_NAME_REGEX,
  INVALID_SESSION_NAME_ERROR,
  CDPTarget,
} from "./types.js";

export const PERPLEXITY_URL = "https://www.perplexity.ai/";
const MAX_RESPONSE_TEXT_SIZE = 50 * 1024; // 50KB

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

// ============================================================================
// SessionManager
// ============================================================================

class SessionManager {
  private sessions: Map<string, SessionState> = new Map();
  private focusedSessionName: string | null = null;
  private inFlightCreates: Map<string, Promise<SessionState>> = new Map();

  // --------------------------------------------------------------------------
  // Validation
  // --------------------------------------------------------------------------

  validateSessionName(name: string): boolean {
    return SESSION_NAME_REGEX.test(name);
  }

  // --------------------------------------------------------------------------
  // Session retrieval
  // --------------------------------------------------------------------------

  getSession(name: string): SessionState | undefined {
    return this.sessions.get(name);
  }

  async getOrCreateSession(name: string): Promise<SessionState> {
    if (!this.validateSessionName(name)) {
      throw new SessionError(INVALID_SESSION_NAME_ERROR + name);
    }

    let session = this.sessions.get(name);
    if (session) {
      this.updateSessionActivity(name);
      return session;
    }

    const inFlight = this.inFlightCreates.get(name);
    if (inFlight) {
      return inFlight;
    }

    const createPromise = (async () => {
      try {
        const tab: CDPTarget = await cometClient.newTab(PERPLEXITY_URL);
        const now = Date.now();
        const newSession: SessionState = {
          name,
          tabId: tab.id,
          createdAt: now,
          lastActivity: now,
          defaultModel: null,
          lastResponseText: "",
        };

        this.sessions.set(name, newSession);
        this.focusedSessionName = name;

        return newSession;
      } finally {
        this.inFlightCreates.delete(name);
      }
    })();

    this.inFlightCreates.set(name, createPromise);
    return createPromise;
  }

  resolveSession(name: string): SessionState {
    const session = this.sessions.get(name);
    if (!session) {
      throw new SessionError(
        `Session '${name}' not found.\n\nUse comet_session_list to see active sessions, or comet_ask({ session: "${name}" }) to create it.`
      );
    }
    return session;
  }

  async resolveFocusedOrDefault(): Promise<SessionState> {
    if (this.focusedSessionName) {
      const session = this.sessions.get(this.focusedSessionName);
      if (session) {
        return session;
      }
    }
    return this.getOrCreateSession("default");
  }

  // --------------------------------------------------------------------------
  // Focus management
  // --------------------------------------------------------------------------

  focusSession(name: string): void {
    if (!this.sessions.has(name)) {
      throw new SessionError(
        `Session '${name}' not found.\n\nUse comet_session_list to see active sessions, or comet_ask({ session: "${name}" }) to create it.`
      );
    }
    this.focusedSessionName = name;
  }

  // --------------------------------------------------------------------------
  // Session lifecycle
  // --------------------------------------------------------------------------

  async destroySession(name: string): Promise<{ wasFocused: boolean }> {
    const session = this.resolveSession(name);
    const wasFocused = this.focusedSessionName === name;

    try {
      await cometClient.closeTab(session.tabId);
    } catch (error) {
      // Tab might already be closed, continue cleanup
    }

    this.sessions.delete(name);

    if (wasFocused) {
      this.focusedSessionName = null;
    }

    return { wasFocused };
  }

  async destroyAllSessions(): Promise<void> {
    const sessionNames = Array.from(this.sessions.keys());
    for (const name of sessionNames) {
      await this.destroySession(name);
    }
  }

  listSessions(): SessionState[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.lastActivity - a.lastActivity
    );
  }

  // --------------------------------------------------------------------------
  // Tab validation and sync
  // --------------------------------------------------------------------------

  async ensureSessionTabValid(name: string): Promise<void> {
    const session = this.resolveSession(name);
    const targets = await cometClient.listTargets();
    const tabExists = targets.some((t) => t.id === session.tabId);

    if (!tabExists) {
      // Auto-cleanup the stale session
      this.sessions.delete(name);
      if (this.focusedSessionName === name) {
        this.focusedSessionName = null;
      }
      throw new SessionError(
        `Session '${name}' tab was closed externally (auto-cleaned).\n\nUse comet_session_list to see active sessions, or comet_ask({ session: "${name}" }) to recreate it.`
      );
    }
  }

  async connectToSession(name: string): Promise<void> {
    await this.ensureSessionTabValid(name);
    const session = this.resolveSession(name);
    await cometClient.connect(session.tabId);
  }

  async syncWithBrowser(): Promise<{ removed: string[] }> {
    const targets = await cometClient.listTargets();
    const validTabIds = new Set(targets.map((t) => t.id));
    const removed: string[] = [];

    for (const [name, session] of this.sessions.entries()) {
      if (!validTabIds.has(session.tabId)) {
        this.sessions.delete(name);
        removed.push(name);
        if (this.focusedSessionName === name) {
          this.focusedSessionName = null;
        }
      }
    }

    return { removed };
  }

  // --------------------------------------------------------------------------
  // Session state updates
  // --------------------------------------------------------------------------

  updateSessionActivity(name: string): void {
    const session = this.sessions.get(name);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  getSessionDefaultModel(name: string): string | null {
    const session = this.sessions.get(name);
    return session?.defaultModel ?? null;
  }

  setSessionDefaultModel(name: string, model: string | null): void {
    const session = this.sessions.get(name);
    if (session) {
      session.defaultModel = model;
    }
  }

  getSessionLastResponse(name: string): string {
    const session = this.sessions.get(name);
    return session?.lastResponseText ?? "";
  }

   setSessionLastResponse(name: string, text: string): void {
     const session = this.sessions.get(name);
     if (session) {
       session.lastResponseText = text.length > MAX_RESPONSE_TEXT_SIZE
         ? text.slice(0, MAX_RESPONSE_TEXT_SIZE)
         : text;
     }
   }

  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  getFocusedSessionName(): string | null {
    return this.focusedSessionName;
  }

  getSessionCount(): number {
    return this.sessions.size;
  }
}

// ============================================================================
// Singleton export
// ============================================================================

export const sessionManager = new SessionManager();
