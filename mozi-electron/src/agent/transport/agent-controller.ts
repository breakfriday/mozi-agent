import type { ResultOf, RuntimeMethod, RuntimeRequest } from "../../../../shared/agent";
import type { AgentApplication } from "../agent";

/** Routes validated shared requests. No SDK calls, SQL, scheduling or business state. */
export class AgentController {
  constructor(private readonly application: AgentApplication) {}
  async dispatch(request: RuntimeRequest): Promise<ResultOf<RuntimeMethod>> {
    this.application.assertAvailable();
    const { sessions, runs, models } = this.application;
    switch (request.method) {
      case "provider.auth.start": return models.auth.start(request.params.providerId);
      case "provider.auth.status": return models.auth.status(request.params.providerId);
      case "provider.auth.submit": return models.auth.submit(request.params);
      case "provider.auth.cancel": return models.auth.cancel(request.params.providerId, request.params.loginId);
      case "provider.auth.open": return models.auth.open(request.params.providerId, request.params.loginId);
      case "provider.auth.logout": await models.auth.logout(request.params.providerId); return models.settings();
      case "provider.refreshModels": return models.refreshProviderModels(request.params.providerId);
      case "model.settings": return models.settings();
      case "provider.save": return models.save(request.params);
      case "provider.remove": return models.remove(request.params.providerId);
      case "model.setDefault": return models.setDefault(request.params.model);
      case "session.setModel": return sessions.setModel(request.params);
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
