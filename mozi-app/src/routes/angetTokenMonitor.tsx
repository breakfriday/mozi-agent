import { createFileRoute, lazyRouteComponent } from "@tanstack/react-router";

export const Route = createFileRoute("/angetTokenMonitor")({
  validateSearch: (search: Record<string, unknown>) => ({
    sessionId: typeof search.sessionId === "string" ? search.sessionId : "",
    runId: typeof search.runId === "string" ? search.runId : undefined,
  }),
  component: lazyRouteComponent(() => import("@/pages/angetTokenMonitor/TokenMonitorPage"), "TokenMonitorPage"),
});
