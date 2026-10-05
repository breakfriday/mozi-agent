// Application-owned state, shared by chat and other Agent views.
export type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "streaming" | "completed" | "cancelled";
};

export type AgentState = {
  messages: AgentMessage[];
  activeMessageId: string | null;
};
