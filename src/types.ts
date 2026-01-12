// Type definitions for CDP client and Comet MCP Server

import type { CometAI } from "./comet-ai.js";

export interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
}

export interface CDPVersion {
  Browser: string;
  "Protocol-Version": string;
  "User-Agent": string;
  "V8-Version": string;
  "WebKit-Version": string;
  webSocketDebuggerUrl: string;
}

export interface NavigateResult {
  frameId: string;
  loaderId?: string;
  errorText?: string;
}

export interface ScreenshotResult {
  data: string; // Base64 encoded
}

export interface EvaluateResult {
  result: {
    type: string;
    value?: unknown;
    description?: string;
    objectId?: string;
  };
  exceptionDetails?: {
    text: string;
    exception?: {
      description?: string;
    };
  };
}

export interface CometState {
  connected: boolean;
  port: number;
  currentUrl?: string;
  activeTabId?: string;
}

export interface CometAIResponse {
  text: string;
  complete: boolean;
  timestamp: number;
}

// Session management types
export const SESSION_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
export const INVALID_SESSION_NAME_ERROR = "Session name must contain only letters, numbers, underscores, and hyphens (1-64 chars). Got: ";

export interface SessionState {
  name: string;
  tabId: string;
  createdAt: number;
  lastActivity: number;
  lastResponseText: string;
  ai: CometAI;
}
