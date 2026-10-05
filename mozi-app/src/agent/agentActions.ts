import { bridgeApi } from "../runtime/bridge";
import { rememberAgentSession, useAgentStore } from "./agentStore";
import { createAgentActions } from "./createAgentActions";

export const agentActions = createAgentActions(bridgeApi.agent, useAgentStore, rememberAgentSession);

if (import.meta.hot) import.meta.hot.dispose(() => agentActions.dispose());
