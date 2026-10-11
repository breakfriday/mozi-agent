import { create } from "zustand";
import type { AgentState } from "./types";
import { initialAgentState } from "./agentState";

export function rememberAgentSession(sessionId: string | null): void {
  try {
    if (sessionId) sessionStorage.setItem("mozi.agent.sessionId", sessionId);
    else sessionStorage.removeItem("mozi.agent.sessionId");
  } catch { /* Storage may be disabled. */ }
}

function savedSession(): string | null {
  // Each monitor renderer owns its subscription; never inherit another window's selected chat.
  const url = new URL(window.location.href);
  const route = url.protocol === "file:" ? url.hash.slice(1) : url.pathname + url.search;
  const [pathname, query] = route.split("?");
  if (pathname.endsWith("/angetTokenMonitor")) return new URLSearchParams(query).get("sessionId");
  try { return sessionStorage.getItem("mozi.agent.sessionId"); } catch { return null; }
}

// One application-wide store. Page lifecycles do not own Agent state.
export const useAgentStore = create<AgentState>(() => initialAgentState(savedSession()));
