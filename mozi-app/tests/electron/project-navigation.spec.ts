import { test, expect } from "@playwright/test";
import { buildProjectNavigation } from "../../src/pages/chat/sessions/project-navigation";
import type { ProjectSummary, SessionSummary } from "../../../shared/agent";

const at = "2026-11-11T00:00:00.000Z";
const projects: ProjectSummary[] = [
  { id: "a", name: "Alpha", createdAt: at, updatedAt: at },
  { id: "b", name: "Empty", createdAt: at, updatedAt: at },
];
const sessions: SessionSummary[] = [
  { sessionId: "unassigned", title: "SQLite root", createdAt: at, updatedAt: at },
  { sessionId: "old", title: "SQLite old", projectId: "a", createdAt: at, updatedAt: at },
  { sessionId: "new", title: "Other recent", projectId: "a", createdAt: at, updatedAt: "2026-11-11T01:00:00.000Z" },
];

test("project navigation has exclusive membership, recent ordering and selectable empty projects", () => {
  const result = buildProjectNavigation(projects, sessions, "");
  expect(result.map(p => p.key)).toEqual(["", "a", "b"]);
  expect(result.map(p => p.sessions.map(s => s.sessionId))).toEqual([["unassigned"], ["new", "old"], []]);
  expect(new Set(result.flatMap(p => p.sessions.map(s => s.sessionId))).size).toBe(sessions.length);
});

test("project search matches titles or project names, preserves empty name matches and handles no results", () => {
  expect(buildProjectNavigation(projects, sessions, " sqlite ").map(p => p.sessions.map(s => s.sessionId)))
    .toEqual([["unassigned"], ["old"]]);
  expect(buildProjectNavigation(projects, sessions, "ALPHA")[0].sessions.map(s => s.sessionId)).toEqual(["new", "old"]);
  expect(buildProjectNavigation(projects, sessions, "Empty").map(p => p.key)).toEqual(["b"]);
  expect(buildProjectNavigation(projects, sessions, "no match")).toEqual([]);
  expect(buildProjectNavigation(projects, sessions, ">new").length).toBe(3);
});
