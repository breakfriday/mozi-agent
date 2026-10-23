import type { RefObject } from "react";
import type { InputRef } from "antd";
import type { AgentState } from "@/agent/types";

export type SessionListProps = {
  items: (AgentState["sessions"][number] & { group: number })[];
  query: string;
  setQuery: (query: string) => void;
  currentId: string | null;
  activeRunId: string | null;
  disabled: boolean;
  loading: boolean;
  error: string | undefined;
  active: boolean;
  inputRef: RefObject<InputRef | null>;
  resultsRef: RefObject<HTMLDivElement | null>;
  listId: string;
  onOpen: (id: string) => void;
  onAction: (kind: "rename" | "delete", id: string, title: string) => void;
};

export const groupNames = ["今天", "昨天", "本周", "更早"];

export function dateGroup(timestamp: string, now: Date) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const week = new Date(today);
  week.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const time = Date.parse(timestamp);
  if (time >= +today) return 0;
  if (time >= +yesterday) return 1;
  if (time >= +week) return 2;
  return 3;
}

export function revealSelection(container: HTMLDivElement | null) {
  if (!container) return;
  const option = container.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!option) return;
  const group = option.closest('[role="group"]');
  const firstInGroup = group?.querySelector('[role="option"]') === option;
  const heading = firstInGroup
    ? group?.querySelector("[data-session-group-heading]")
    : null;
  // Include the heading for the first row, and scroll only the results pane.
  // scrollIntoView on the option alone leaves the heading above the viewport.
  const bounds = container.getBoundingClientRect();
  const stickyHeading = group?.querySelector<HTMLElement>(
    "[data-session-group-heading]",
  );
  const stickyHeight =
    stickyHeading && getComputedStyle(stickyHeading).position === "sticky"
      ? stickyHeading.offsetHeight
      : 0;
  const top = stickyHeight
    ? option.getBoundingClientRect().top - stickyHeight
    : (heading ?? option).getBoundingClientRect().top;
  const bottom = option.getBoundingClientRect().bottom;
  if (container.querySelector('[role="option"]') === option)
    container.scrollTop = 0;
  else if (top < bounds.top + 2)
    container.scrollTop += Math.floor(top - bounds.top) - 2;
  else if (bottom > bounds.bottom - 2)
    container.scrollTop += Math.ceil(bottom - bounds.bottom) + 2;
}
