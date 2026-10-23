import {
  filterCommands,
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

export function SessionPaletteList({
  items,
  query,
  setQuery,
  currentId,
  activeRunId,
  disabled,
  loading,
  error,
  active,
  inputRef,
  resultsRef,
  listId,
  onOpen: switchTo,
  onAction: beginAction,
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
          aria-activedescendant={
            count
              ? `${listId}-${commandMode ? "command-" : ""}${activeIndex}`
              : undefined
          }
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
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
            return (
              <div role="group" aria-label={name} key={name}>
                <div
                  className={styles.group}
                  data-session-group-heading
                  aria-hidden="true"
                >
                  <span>{name}</span>
                  <span className={styles.count}>{grouped.length}</span>
                </div>
                {grouped.map(({ session, index }) => (
                  <div key={session.sessionId} className={styles.row}>
                    <div
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={index === activeIndex}
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
                          session.sessionId === currentId &&
                          activeRunId !== null
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
                ))}
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
      <div className={styles.footer}>
        <span>↑ ↓ 选择 · ↵ 确认 · Esc 关闭</span>
        <span>
          {disabled
            ? "连接就绪且当前操作完成后可切换"
            : `${count} 个${commandMode ? "命令" : "会话"}`}
        </span>
      </div>
    </div>
  );
}
