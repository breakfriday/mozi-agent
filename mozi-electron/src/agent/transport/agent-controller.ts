import type { ResultOf, RuntimeMethod, RuntimeRequest } from "../../../../shared/agent";
import type { AgentApplication } from "../application/agent-application";

/** Routes validated shared requests. No SDK calls, SQL, scheduling or business state. */
export class AgentController {
  constructor(private readonly application: AgentApplication) {}
  async dispatch(request: RuntimeRequest): Promise<ResultOf<RuntimeMethod>> {
    this.application.assertAvailable();
    const { sessions, runs } = this.application;
    switch (request.method) {
      case "session.create": return sessions.create(request.params);
      case "session.list": return sessions.list(request.params);
      case "session.rename": return sessions.rename(request.params);
      case "session.delete": return sessions.delete(request.params);
      case "session.snapshot": return sessions.snapshot(request.params);
      case "run.start": return runs.start(request.params);
      case "run.get": return runs.get(request.params);
      case "run.cancel": return runs.cancel(request.params);
      case "approval.respond": return sessions.respondApproval(request.params);
    }
  }
}
