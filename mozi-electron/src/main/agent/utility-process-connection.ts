import type { UtilityProcess } from "electron";
import type { AgentConnection } from "./transport";

/** Call transport.connect() immediately after fork; readiness comes from the child. */
export function utilityProcessConnection(child: UtilityProcess): AgentConnection {
  return {
    postMessage: (request) => child.postMessage(request),
    onMessage(listener) {
      child.on("message", listener);
      return () => { child.removeListener("message", listener); };
    },
    onDisconnect(listener) {
      const onExit = (code: number) => listener(`Agent process exited (${code}).`);
      child.on("exit", onExit);
      return () => { child.removeListener("exit", onExit); };
    },
  };
}
