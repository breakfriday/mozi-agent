import { create } from "zustand";
import type { AgentState } from "./types";

// One application-wide store. Page lifecycles do not own Agent state.
export const useAgentStore = create<AgentState>(() => ({
  messages: [],
  activeMessageId: null,
}));
