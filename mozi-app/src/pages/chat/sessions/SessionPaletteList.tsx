import {
  filterCommands,
  ariaKeymap,
  getAction,
  actionHint,
  formatKeymap,
  type ActionId,
} from "@/config/action-config";
import { Input } from "antd";
import { useEffect, useEffectEvent, useRef } from "react";
import type { ProjectNavigationEntry } from "./project-navigation";
import { revealSelection } from "./session-navigation";
import { PlusOutlined, SearchOutlined } from "@ant-design/icons";
import { SessionMenu } from "./SessionMenu";
import type { ProjectSummary } from "../../../../../shared/agent";
import { ProjectControls, MoveSessionButton } from "./ProjectControls";
import { type SessionListProps } from "./session-navigation";
import { SessionTitleHighlight } from "./SessionTitleHighlight";
import styles from "./session-palette-list.module.css";

function formatTokenCount(tokens: number): string {
  if (tokens >= 10_000) {
    const wan = tokens / 10_000;
    return `${Number.isInteger(wan) ? wan : wan.toFixed(1)} 万`;
  }
  return tokens.toLocaleString("zh-CN");
}

export function SessionPaletteList({
  activePane, onPaneChange, onClose,
  projects, groups, navigation, activeProjectKey, onSelectProject, onProjectsChanged, onNewProjectSession,
  items,
  query,
  setQuery,
  currentId,
  sessionActivity,
  disabled,
  loading,
  error,
  active,
  inputRef,
  resultsRef,
  listId,
  onOpen: switchTo,
  onAction: beginAction,
  selectedIds = [],
  onToggleSelect,
  onSelectGroup,
  onClearSelection,
  onCreateDerived,
  preview,
  activeIndex,
  setSelected,
  onExecute,
}: SessionListProps & {
  activePane: "projects" | "sessions";
  onPaneChange: (pane: "projects" | "sessions") => void;
  onClose: () => void;
  projects: ProjectSummary[];
  groups: { id: number; name: string }[];
  navigation: ProjectNavigationEntry[];
  activeProjectKey: string;
  onSelectProject: (key: string) => void;
  onProjectsChanged: () => void;
  onNewProjectSession: (id: string) => void;

  onExecute: (id: ActionId) => void;
  activeIndex: number;
  setSelected: (index: number) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const projectList = useRef<HTMLDivElement>(null);
  const projectIndex = navigation.findIndex(p => p.key === activeProjectKey);
  const activeProject = navigation[projectIndex];
  useEffect(() => { revealSelection(projectList.current); }, [activeProjectKey, query]);
  const search = query.trim();
  const commandMode = search.startsWith(">");
  const commands = filterCommands(search);
  const count = commandMode ? commands.length : items.length;
  const onNew = () => onExecute("session.create");
  const enterPane = (pane: "projects" | "sessions") => {
    // Like Chat reading mode: release the input, never focus the destination list.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
    onPaneChange(pane);
  };
  const handleNavigation = useEffectEvent((event: KeyboardEvent) => {
    if (!active || event.defaultPrevented || event.isComposing) return;
    const root = panel.current;
    const dialog = root?.closest('[role="dialog"]');
    if (!root || !dialog) return;
    // Portalled edit dialogs and menus own their keys, even if their input blurs.
    const overlays = document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], [role="listbox"]');
    if ([...overlays].some(el => el !== dialog && !root.contains(el) && el.getClientRects().length > 0)) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body && !dialog.contains(focused)) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault(); inputRef.current?.focus(); return;
    }
    if (event.key === "F6" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      enterPane(commandMode || activePane === "projects" ? "sessions" : "projects");
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const isSearch = focused === inputRef.current?.input;
    const isControl = focused instanceof HTMLElement && focused.matches('input, textarea, select, button, [contenteditable="true"], [role="combobox"]');
    if (isSearch && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault(); enterPane("sessions"); return;
    }
    if (isControl) return;
    const pane = commandMode ? "sessions" : activePane;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      if (!commandMode) enterPane(event.key === "ArrowLeft" ? "projects" : "sessions");
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (pane === "projects" && navigation.length)
        onSelectProject(navigation[(projectIndex + direction + navigation.length) % navigation.length].key);
      else if (pane === "sessions" && count) setSelected((activeIndex + direction + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (pane === "projects") enterPane("sessions");
      else if (commandMode) { if (commands[activeIndex]) onExecute(commands[activeIndex].action); }
      else if (items[activeIndex]) switchTo(items[activeIndex].sessionId);
    } else if (event.key === " " && pane === "sessions" && !commandMode) {
      event.preventDefault(); if (items[activeIndex]) onToggleSelect?.(items[activeIndex].sessionId);
    } else if (event.key === "Escape") {
      event.preventDefault(); onClose();
    }
  });
  useEffect(() => {
    if (!active) return;
    const listener = (event: KeyboardEvent) => handleNavigation(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [active]);

  const selectedSet = new Set(selectedIds);
  const allEmpty = Boolean(
    preview?.data &&
      preview.data.sources.length > 0 &&
      preview.data.sources.every((s) => s.empty),
  );
  const overBudget = Boolean(preview?.data?.overBudget);
  const truncatedCount =
    preview?.data?.sources.filter((s) => s.omittedTurns > 0).length ?? 0;
  const canCreateDerived =
    selectedIds.length > 0 &&
    !disabled &&
    !preview?.loading &&
    !preview?.error &&
    !allEmpty &&
    !overBudget;
  return (
    <div ref={panel} className={styles.panel} data-session-switcher data-session-switcher-open={active || undefined} data-active-pane={activePane}>
      <div className={styles.searchBar}>
        <Input
          ref={inputRef}
          value={query}
          prefix={<SearchOutlined />}
          placeholder="搜索项目或会话，或输入 > 执行命令"
          aria-label="搜索会话标题"
          role="combobox"
          aria-expanded={active}
          aria-controls={`${listId}`}
          aria-autocomplete="list"
          aria-keyshortcuts={ariaKeymap("session.delete")}
          aria-activedescendant={
            count
              ? `${listId}-${commandMode ? "command-" : ""}${activeIndex}`
              : undefined
          }
          onChange={(e) => {
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              enterPane("sessions");
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (commandMode) {
                if (commands[activeIndex])
                  onExecute(commands[activeIndex].action);
                return;
              }
              if (items[activeIndex]) switchTo(items[activeIndex].sessionId);
            }
          }}
        />
        <button
          type="button"
          className={styles.newButton}
          disabled={disabled}
          onClick={onNew}
          aria-label={getAction("session.create").desc}
          title={actionHint("session.create")}
        >
          <PlusOutlined />
        </button>
      </div>
      {error && (
        <p className={styles.status} role="alert">
          {error}
        </p>
      )}
      <div className={commandMode ? styles.commandLayout : styles.columns}>
        {!commandMode && <aside className={styles.projectPane} aria-label="项目导航">
          <div className={styles.paneHeading}>项目</div>
          <div ref={projectList} className={styles.projectList} tabIndex={0} role="listbox" aria-label="项目列表"
            aria-activedescendant={projectIndex >= 0 ? `${listId}-project-${projectIndex}` : undefined}
            data-active={activePane === "projects" || undefined}
            onFocus={() => onPaneChange("projects")}>
            {navigation.map((entry, index) => <div key={entry.key} id={`${listId}-project-${index}`} role="option"
              aria-selected={entry.key === activeProjectKey} className={styles.projectOption}
              onMouseDown={event => event.preventDefault()}
              onClick={() => { onSelectProject(entry.key); enterPane("projects"); }}>
              <span className={styles.projectName} title={entry.name}><SessionTitleHighlight text={entry.name} query={search} /></span>
              {entry.sessions.some(s => sessionActivity[s.sessionId]) && <span className={styles.running} aria-label="项目内有正在运行的会话">●</span>}
              <span className={styles.count}>{entry.sessions.length}</span>
            </div>)}
            {!navigation.length && <p className={styles.status}>没有匹配的项目或会话</p>}
          </div>
          <div className={styles.paneFooter}><ProjectControls disabled={disabled} onChanged={onProjectsChanged} /></div>
        </aside>}
        <section className={styles.sessionPane} aria-label="会话导航">
          {!commandMode && <div className={styles.paneHeading}>
            <span className={styles.projectName}>{activeProject?.name ?? "无匹配项目"}</span>
            {activeProject && (activeProject.project
              ? <ProjectControls project={activeProject.project} disabled={disabled} onChanged={onProjectsChanged}
                  onNew={() => onNewProjectSession(activeProjectKey)} />
              : <button type="button" className={styles.groupSelectBtn} disabled={disabled} onClick={() => onNewProjectSession("")}>＋ 新建会话</button>)}
          </div>}
      <div
        ref={resultsRef}
        className={styles.results}
        id={`${listId}`}
        role="listbox"
        tabIndex={0}
        aria-activedescendant={count ? `${listId}-${commandMode ? "command-" : ""}${activeIndex}` : undefined}
        data-active={activePane === "sessions" || undefined}
        onFocus={() => onPaneChange("sessions")}
        aria-label={commandMode ? "匹配的命令" : "匹配的会话"}
        aria-busy={loading}
      >
        {commandMode &&
          commands.map((command, index) => (
            <div
              role="option"
              key={command.action}
              id={`${listId}-command-${index}`}
              aria-selected={index === activeIndex}
              aria-disabled={command.action === "session.create" && disabled}
              className={styles.option}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onExecute(command.action);
              }}
            >
              <PlusOutlined />
              <span className={styles.title}>{command.desc}</span>
              {command.keymap && (
                <kbd className={styles.time}>
                  {formatKeymap(command.keymap)}
                </kbd>
              )}
            </div>
          ))}
        {!commandMode &&
          groups.map(({ name, id: group }) => {
            const grouped = items
              .map((session, index) => ({ session, index }))
              .filter((item) => item.session.group === group);
            if (!grouped.length) return null;
            const groupIds = grouped.map((g) => g.session.sessionId);
            const allGroupSelected =
              groupIds.length > 0 &&
              groupIds.every((id) => selectedSet.has(id));
            return (
              <div role="group" aria-label={name} key={name}>
                <div
                  className={styles.group}
                  data-session-group-heading
                >
                  <span>{name}</span>
                  <span className={styles.count}>{grouped.length}</span>
                  {onSelectGroup && grouped.length > 0 && (
                    <button
                      type="button"
                      className={styles.groupSelectBtn}
                      disabled={disabled}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onSelectGroup(groupIds)}
                    >
                      {allGroupSelected ? "取消本组" : "全选本组"}
                    </button>
                  )}
                </div>
                {grouped.map(({ session, index }) => {
                  const checked = selectedSet.has(session.sessionId);
                  return (
                  <div
                    key={session.sessionId}
                    className={styles.row}
                    data-current={session.sessionId === currentId || undefined}
                    data-checked={checked || undefined}
                  >
                    {onToggleSelect && (
                      <label
                        className={styles.checkboxWrap}
                        title="勾选以作为新会话的前置上下文"
                        onMouseDown={(e) => e.preventDefault()}
                      >
                        <input
                          type="checkbox"
                          className={styles.checkbox}
                          checked={checked}
                          disabled={disabled || (!checked && selectedIds.length >= 20)}
                          aria-label={`选择会话 ${session.title || "新会话"}`}
                          onChange={() => onToggleSelect(session.sessionId)}
                        />
                      </label>
                    )}
                    <div
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      aria-current={
                        session.sessionId === currentId ? "true" : undefined
                      }
                      aria-disabled={disabled}
                      className={styles.option}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => switchTo(session.sessionId)}
                    >
                      <span
                        className={styles.title}
                        title={session.title || "新会话"}
                      >
                        <SessionTitleHighlight
                          text={session.title || "新会话"}
                          query={search}
                        />
                      </span>
                      {sessionActivity[session.sessionId] && (
                        <span className={styles.running} aria-label="正在运行">running</span>
                      )}
                      {session.sessionId === currentId && (
                        <span className={styles.current}>当前</span>
                      )}
                      <time
                        className={styles.time}
                        dateTime={session.updatedAt}
                      >
                        {new Date(session.updatedAt).toLocaleDateString(
                          undefined,
                          { month: "short", day: "numeric" },
                        )}
                      </time>
                    </div>
                    <div className={styles.actions}>
                      <MoveSessionButton sessionId={session.sessionId} projectId={session.projectId} projects={projects}
                        disabled={disabled} onChanged={onProjectsChanged} />
                      <SessionMenu
                        className={styles.menuTrigger}
                        title={session.title || "新会话"}
                        disabled={disabled}
                        running={
                          !!sessionActivity[session.sessionId]
                        }
                        onAction={(kind) =>
                          beginAction(
                            kind,
                            session.sessionId,
                            session.title || "新会话",
                          )
                        }
                      />
                    </div>
                  </div>
                  );
                })}
              </div>
            );
          })}
      {!count && (
        <p className={styles.empty} role="status">
          {commandMode
            ? "没有匹配的命令，输入 > 查看全部命令"
            : loading
              ? "正在加载会话…"
              : search
                ? "没有匹配的会话"
                : "暂无历史会话"}
          {!commandMode && !loading && activeProject && (
            <button
              type="button"
              className={styles.emptyNew}
              disabled={disabled}
              onClick={() => onNewProjectSession(activeProjectKey)}
            >
              {getAction("session.create").desc}
            </button>
          )}
        </p>
      )}
      </div>
        </section>
      </div>
      {!commandMode && selectedIds.length > 0 && (
        <div className={styles.selectionBar} role="status" aria-live="polite">
          <div className={styles.selectionSummary}>
            <span>
              已选 {selectedIds.length} 个
              {preview?.loading && " · 正在计算预算…"}
              {!preview?.loading && preview?.error && ` · ${preview.error}`}
              {!preview?.loading && !preview?.error && preview?.data && (
                <>
                  {allEmpty
                    ? " · 所选会话无可用内容"
                    : ` · 约 ${formatTokenCount(preview.data.estimatedTokens)} token / 预算 ${formatTokenCount(preview.data.budgetTokens)}`}
                  {truncatedCount > 0 && ` · ${truncatedCount} 个会话有省略`}
                  {overBudget && " · 超出预算，请减少会话"}
                </>
              )}
            </span>
            {onClearSelection && (
              <button
                type="button"
                className={styles.clearSelectionBtn}
                disabled={disabled}
                onClick={onClearSelection}
              >
                清空
              </button>
            )}
          </div>
          {onCreateDerived && (
            <button
              type="button"
              className={styles.createDerivedBtn}
              disabled={!canCreateDerived}
              onClick={onCreateDerived}
            >
              基于选中会话新建对话
            </button>
          )}
        </div>
      )}
      <div className={styles.footer}>
        <span>↑ ↓ 选择 · ← → 切栏 · 空格 勾选 · ↵ 打开 · Ctrl/⌘ F 搜索 · Esc 关闭{!commandMode && ` · ${formatKeymap(getAction("session.delete").keymap)} 删除`}</span>
        <span>
          {disabled
            ? "连接就绪且当前操作完成后可切换"
            : `${count} 个${commandMode ? "命令" : "会话"}`}
        </span>
      </div>
    </div>
  );
}
