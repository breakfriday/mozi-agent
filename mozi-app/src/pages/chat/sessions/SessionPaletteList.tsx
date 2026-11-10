import {
  filterCommands,
  ariaKeymap,
  getAction,
  actionHint,
  formatKeymap,
  type ActionId,
} from "@/config/action-config";
import { Input } from "antd";
import { PlusOutlined, SearchOutlined } from "@ant-design/icons";
import { SessionMenu } from "./SessionMenu";
import { groupNames, type SessionListProps } from "./session-navigation";
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
  onExecute: (id: ActionId) => void;
  activeIndex: number;
  setSelected: (index: number) => void;
}) {
  const search = query.trim();
  const commandMode = search.startsWith(">");
  const commands = filterCommands(search);
  const count = commandMode ? commands.length : items.length;
  const onNew = () => onExecute("session.create");
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
    <div className={styles.panel} data-session-switcher>
      <div className={styles.searchBar}>
        <Input
          ref={inputRef}
          value={query}
          prefix={<SearchOutlined />}
          placeholder="搜索会话，或输入 > 执行命令"
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
              if (count)
                setSelected(
                  (activeIndex + (e.key === "ArrowDown" ? 1 : -1) + count) %
                    count,
                );
            } else if (
              e.key === " " &&
              !commandMode &&
              onToggleSelect &&
              (e.ctrlKey || e.metaKey || e.shiftKey || !query)
            ) {
              e.preventDefault();
              if (items[activeIndex])
                onToggleSelect(items[activeIndex].sessionId);
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
      <div
        ref={resultsRef}
        className={styles.results}
        id={`${listId}`}
        role="listbox"
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
          groupNames.map((name, group) => {
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
                  aria-hidden="true"
                >
                  <span>{name}</span>
                  <span className={styles.count}>{grouped.length}</span>
                  {onSelectGroup && (
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
      </div>
      {!count && (
        <p className={styles.empty} role="status">
          {commandMode
            ? "没有匹配的命令，输入 > 查看全部命令"
            : loading
              ? "正在加载会话…"
              : search
                ? "没有匹配的会话"
                : "暂无历史会话"}
          {!commandMode && !loading && (
            <button
              type="button"
              className={styles.emptyNew}
              disabled={disabled}
              onClick={onNew}
            >
              {getAction("session.create").desc}
            </button>
          )}
        </p>
      )}
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
        <span>↑ ↓ 选择 · 空格 勾选 · ↵ 确认 · Esc 关闭{!commandMode && ` · ${formatKeymap(getAction("session.delete").keymap)} 删除`}</span>
        <span>
          {disabled
            ? "连接就绪且当前操作完成后可切换"
            : `${count} 个${commandMode ? "命令" : "会话"}`}
        </span>
      </div>
    </div>
  );
}
