import type { ProjectSummary, SessionSummary } from "../../../../../shared/agent";

export type ProjectNavigationEntry = {
  key: string;
  name: string;
  project?: ProjectSummary;
  sessions: SessionSummary[];
};

/** Empty key is the virtual unassigned entry, never a persisted project. */
export function buildProjectNavigation(projects: ProjectSummary[], sessions: SessionSummary[], query: string): ProjectNavigationEntry[] {
  const search = query.trim().startsWith(">") ? "" : query.trim().toLocaleLowerCase();
  const entries: Omit<ProjectNavigationEntry, "sessions">[] = [
    { key: "", name: "未归类" },
    ...projects.map(project => ({ key: project.id, name: project.name, project })),
  ];
  return entries.map(entry => {
    const nameMatches = entry.name.toLocaleLowerCase().includes(search);
    return { ...entry, sessions: sessions
      .filter(s => (s.projectId ?? "") === entry.key && (nameMatches || (s.title || "新会话").toLocaleLowerCase().includes(search)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId)) };
  }).filter(entry => !search || entry.sessions.length > 0 || entry.name.toLocaleLowerCase().includes(search));
}
