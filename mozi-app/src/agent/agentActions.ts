import { bridgeApi } from "../runtime/bridge";
import { rememberAgentSession, useAgentStore } from "./agentStore";
import { createAgentActions } from "./createAgentActions";

import { createParticleProjection } from "./particleProjection";

const projection = createParticleProjection(content => bridgeApi.projectParticles(content));
export const agentActions = createAgentActions(bridgeApi.agent, useAgentStore, rememberAgentSession, projection);

if (import.meta.hot) import.meta.hot.dispose(() => agentActions.dispose());
