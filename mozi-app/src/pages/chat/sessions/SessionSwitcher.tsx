import {
  actionConfig,
  getAction,
  filterCommands,
  matchesKeymap,
  formatKeymap,
  actionHint,
  ariaKeymap,
  type ActionId,
  type ActionConfig,
} from "@/config/action-config";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { Modal, Input, type InputRef } from "antd";
import { PlusOutlined, SearchOutlined } from "@ant-design/icons";
import { useAgentStore } from "@/agent/agentStore";
import { agentActions } from "@/agent/agentActions";
import { bridgeApi } from "@/runtime/bridge";
import { Dialog as DialogPrimitive } from "radix-ui";
import { dateGroup, revealSelection } from "./session-navigation";
import { SessionPaletteList } from "./SessionPaletteList";
import styles from "./session-switcher.module.css";

export function SessionSwitcher({
  getContainer,
}: {
  getContainer: () => HTMLElement;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [action, setAction] = useState<{
    kind: "rename" | "delete";
    id: string;
    title: string;
    typedConfirmation?: boolean;
  } | null>(null);
  const [name, setName] = useState("");
  const [deleteAnswer, setDeleteAnswer] = useState("");
  const deleteInput = useRef<InputRef>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const focusComposer = useRef(false);
  const creating = useRef(false);
  const nameInput = useRef<InputRef>(null);
  const input = useRef<InputRef>(null);
  const results = useRef<HTMLDivElement>(null);
  const listId = useId();
  const sessions = useAgentStore((s) => s.sessions);
  const currentId = useAgentStore((s) => s.sessionId);
  const sessionActivity = useAgentStore((s) => s.sessionActivity);
  const loading = useAgentStore((s) => s.sessionsLoading);
  const error = useAgentStore((s) => s.sessionsError);
  const disabled = useAgentStore(
    (s) =>
      s.sessionOperation !== null ||
      s.inFlightSubmissionId !== null ||
      s.runtime.state !== "ready",
  );
  const search = query.trim();
  const now = new Date();
  const items = sessions
    .filter((s) =>
      (s.title || "新会话")
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
    )
    .map((s) => ({ ...s, group: dateGroup(s.updatedAt, now) }))
    .sort(
      (a, b) =>
        a.group - b.group ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
        a.sessionId.localeCompare(b.sessionId),
    );
  const resultCount = search.startsWith(">")
    ? filterCommands(search).length
    : items.length;
  const activeIndex = Math.min(selected, Math.max(0, resultCount - 1));

  const show = () => {
    // Opening a panel must not leave a background chat control focused.
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && !focused.closest('[role="dialog"]'))
      focused.blur();
    focusComposer.current = false;
    setQuery("");
    setSelected(0);
    setOpen(true);
  };

  const createSession = async () => {
    if (disabled || action || creating.current) return;
    creating.current = true;
    try {
      await agentActions.newSession();
      if (!useAgentStore.getState().sessionsError) {
        focusComposer.current = true;
        setOpen(false);
        requestAnimationFrame(() => {
          getContainer()
            .querySelector<HTMLElement>('[aria-label="消息内容"]')
            ?.focus({ preventScroll: true });
        });
      } else if (!open) {
        show();
      }
    } finally {
      creating.current = false;
    }
  };

  const handlers: Partial<Record<ActionId, () => void | Promise<void>>> = {
    "session.create": createSession,
    "dsh.open": async () => {
      const opened = await bridgeApi.window.openWindow({
        channelId: "dsh",
        url: "http://127.0.0.1:3080/",
        options: { title: "dsh", frame: true },
      });
      if (opened) setOpen(false);
    },
    "gmail.open": async () => {
      const opened = await bridgeApi.window.openWindow({
        channelId: "gmail",
        url: "https://www.google.com/gmail",
        options: { title: "Gmail", frame: true },
      });
      if (opened) setOpen(false);
    },
    "gpt.open": async () => {
      const opened = await bridgeApi.window.openWindow({
        channelId: "gpt",
        url: "https://chatgpt.com/",
        options: { title: "ChatGPT", frame: true },
      });
      if (opened) setOpen(false);
    },
    "session.delete": () => {
      const session = items[activeIndex];
      if (!open || search.startsWith(">") || disabled || loading || !session || sessionActivity[session.sessionId]) return;
      beginAction("delete", session.sessionId, session.title || "新会话", true);
    },
    "session.switcher": () => {
      if (open) setOpen(false);
      else show();
    },
  };
  const executeAction = (id: ActionId) => {
    if (action) return;
    void handlers[id]?.();
  };
  const executeShortcut = useEffectEvent(executeAction);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const config = actionConfig.find((item: ActionConfig) =>
        !item.scope && matchesKeymap(event, item.keymap),
      );
      if (!config) return;
      // Only the dialog holding focus owns the keyboard. Hidden/closing modal
      // nodes must not block reopening this switcher.
      const focusedDialog = document.activeElement?.closest('[role="dialog"]');
      if (
        focusedDialog &&
        !focusedDialog.querySelector("[data-session-switcher]")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      executeShortcut(config.action);
    };
    // Capture before inputs or nested widgets can consume the shortcut.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (open) revealSelection(results.current);
  }, [open, activeIndex, query]);

  const switchTo = (id: string) => {
    if (action || disabled) return;
    setOpen(false);
    void agentActions.activateSession(id);
  };

  const deletingRunning =
    action?.kind === "delete" &&
    !!sessionActivity[action.id];
  const beginAction = (
    kind: "rename" | "delete",
    id: string,
    title: string,
    typedConfirmation = false,
  ) => {
    setAction({ kind, id, title, typedConfirmation });
    setDeleteAnswer("");
    setName(title);
    setActionError(null);
  };
  const confirmAction = async () => {
    if (
      !action ||
      saving ||
      disabled ||
      deletingRunning ||
      (action.typedConfirmation && deleteAnswer.trim().toLowerCase() !== "yes") ||
      (action.kind === "rename" && !name.trim())
    )
      return;
    setSaving(true);
    setActionError(null);
    try {
      if (action.kind === "rename")
        await agentActions.renameSession(action.id, name.trim());
      else await agentActions.deleteSession(action.id);
      setAction(null);
    } catch {
      setActionError(
        useAgentStore.getState().sessionsError?.message ?? "操作失败，请重试。",
      );
    } finally {
      setSaving(false);
    }
  };

  const afterOpen = (visible: boolean) => {
    if (action) return;
    if (!open) {
      // Restore a neutral keyboard starting point, not a button/input with a
      // focus ring, and never focus the retained content of a hidden overlay.
      const target = focusComposer.current
        ? (getContainer().querySelector<HTMLElement>(
            '[aria-label="消息内容"]',
          ) ?? getContainer())
        : getContainer();
      target.focus({ preventScroll: true });
      return;
    }
    input.current?.focus({ preventScroll: true });
    if (visible) revealSelection(results.current);
  };
  const listProps = {
    items,
    query,
    setQuery,
    currentId,
    sessionActivity,
    disabled,
    loading,
    error: error?.message,
    onOpen: switchTo,
    onAction: beginAction,
  };
  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => executeAction("session.switcher")}
        aria-label="切换会话"
        title={actionHint("session.switcher")}
        aria-expanded={open}
        aria-keyshortcuts={ariaKeymap("session.switcher")}
      >
        <SearchOutlined />
        <span className={styles.triggerLabel}>会话</span>
        <kbd>{formatKeymap(getAction("session.switcher").keymap)}</kbd>
      </button>
      <button
        type="button"
        className={styles.trigger}
        disabled={disabled}
        onClick={() => executeAction("session.create")}
        aria-label={getAction("session.create").desc}
        title={actionHint("session.create")}
        aria-keyshortcuts={ariaKeymap("session.create")}
      >
        <PlusOutlined />
      </button>
      <Modal
        focusable={{
          focusTriggerAfterClose: false,
          trap: open && !action,
        }}
        title="切换会话"
        open={open}
        centered
        width={600}
        footer={null}
        onCancel={() => {
          if (!action) setOpen(false);
        }}
        keyboard={!action}
        mask={{ closable: !action }}
        afterOpenChange={afterOpen}
      >
        <span hidden data-session-switcher />
        <SessionPaletteList
          {...listProps}
          active={open}
          inputRef={input}
          resultsRef={results}
          listId={`${listId}-palette`}
          activeIndex={activeIndex}
          setSelected={setSelected}
          onExecute={executeAction}
        />
      </Modal>
      <DialogPrimitive.Root
        open={action !== null}
        onOpenChange={(visible) => {
          if (!visible && !saving) setAction(null);
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className={styles.actionOverlay} />
          <DialogPrimitive.Content
            className={styles.actionDialog}
            aria-describedby={
              action?.kind === "delete"
                ? `${listId}-delete-description`
                : undefined
            }
            onOpenAutoFocus={(event) => {
              if (action?.typedConfirmation) {
                event.preventDefault();
                deleteInput.current?.focus();
              } else if (action?.kind === "rename") {
                event.preventDefault();
                nameInput.current?.focus({ cursor: "all" });
              }
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              input.current?.focus({ preventScroll: true });
            }}
            onEscapeKeyDown={(event) => {
              // Keep Escape in the top dialog; the palette must stay open.
              event.preventDefault();
              event.stopImmediatePropagation();
              if (!saving) setAction(null);
            }}
            onInteractOutside={(event) => {
              if (saving) event.preventDefault();
            }}
          >
            <DialogPrimitive.Title className={styles.actionTitle}>
              {action?.kind === "rename" ? "重命名会话" : "永久删除会话"}
            </DialogPrimitive.Title>
            {action?.kind === "rename" ? (
              <Input
                ref={nameInput}
                aria-label="会话名称"
                value={name}
                maxLength={200}
                showCount
                onChange={(e) => setName(e.target.value)}
                onPressEnter={(e) => {
                  if (!e.nativeEvent.isComposing) void confirmAction();
                }}
              />
            ) : (
              <DialogPrimitive.Description id={`${listId}-delete-description`}>
                永久删除「{action?.title}」将清除聊天历史、Pi 会话文件和 Token
                用量记录，无法恢复。
              </DialogPrimitive.Description>
            )}
            {action?.typedConfirmation && (
              <Input
                ref={deleteInput}
                aria-label="删除确认"
                placeholder="输入 yes 删除 / no 取消，按 Enter 确认"
                value={deleteAnswer}
                readOnly={saving}
                autoComplete="off"
                onChange={(event) => setDeleteAnswer(event.target.value)}
                onPressEnter={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat || saving) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const answer = deleteAnswer.trim().toLowerCase();
                  if (answer === "no") setAction(null);
                  else if (answer === "yes") void confirmAction();
                }}
              />
            )}
            {actionError && <p role="alert">{actionError}</p>}
            <div className={styles.actionFooter}>
              <DialogPrimitive.Close asChild>
                <button
                  type="button"
                  className={styles.trigger}
                  disabled={saving}
                >
                  取消
                </button>
              </DialogPrimitive.Close>
              <button
                type="button"
                className={`${styles.trigger} ${action?.kind === "delete" ? styles.danger : styles.confirm}`}
                disabled={
                  saving ||
                  disabled ||
                  deletingRunning ||
                  (action?.typedConfirmation && deleteAnswer.trim().toLowerCase() !== "yes") ||
                  (action?.kind === "rename" && !name.trim())
                }
                onClick={() => void confirmAction()}
              >
                {saving
                  ? "处理中…"
                  : action?.kind === "rename"
                    ? "保存"
                    : "永久删除"}
              </button>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
