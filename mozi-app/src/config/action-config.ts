import { useEffect, useEffectEvent } from "react";

export type ActionWhen =
  | "!dialog"
  | "!other-dialog"
  | "session-switcher"
  | "!dialog && !editable";

export type ActionConfig = {
  action: string;
  keymap?: string;
  when?: ActionWhen;
  repeat?: boolean;
  command?: readonly string[];
  desc: string;
};

// `mod` accepts Ctrl or ⌘. Only actions with command aliases appear after `>`.
export const actionConfig = [
  {
    action: "session.create",
    keymap: "mod+n",
    when: "!other-dialog",
    command: ["new", "session"],
    desc: "新建会话",
  },
  {
    action: "dsh.open",
    command: ["new dsh -w"],
    desc: "打开 dsh",
  },
  {
    action: "gmail.open",
    command: ["new gmail"],
    desc: "打开 Gmail",
  },
  {
    action: "gpt.open",
    command: ["new gpt"],
    desc: "打开 ChatGPT",
  },
  { action: "session.delete", keymap: "mod+d", when: "session-switcher", desc: "删除选中会话" },
  { action: "model.provider", keymap: "alt+p", when: "!dialog", desc: "切换模型服务商" },
  { action: "model.select", keymap: "alt+m", when: "!dialog", desc: "切换模型" },
  { action: "session.switcher", keymap: "mod+k", when: "!other-dialog", desc: "搜索和切换会话" },
  { action: "chat.focus-next", keymap: "F6", when: "!dialog", desc: "切换到下一个聊天区域" },
  { action: "chat.focus-previous", keymap: "shift+F6", when: "!dialog", desc: "切换到上一个聊天区域" },
  { action: "chat.page-up", keymap: "PageUp", when: "!dialog && !editable", repeat: true, desc: "消息区向上翻页" },
  { action: "chat.page-down", keymap: "PageDown", when: "!dialog && !editable", repeat: true, desc: "消息区向下翻页" },
] as const satisfies readonly ActionConfig[];

export type ActionId = (typeof actionConfig)[number]["action"];
export type ActionHandler = () => boolean | void | Promise<void>;
export type ActionMap = Partial<Record<ActionId, ActionHandler>>;

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [role="listbox"], [role="combobox"], [role="slider"], [role="spinbutton"]';

type RegistryEntry = (id: ActionId) => ActionHandler | undefined;
const registry = new Set<RegistryEntry>();

export function getAction(id: ActionId): ActionConfig {
  return actionConfig.find((config) => config.action === id)!;
}

export function matchesWhen(when?: ActionWhen): boolean {
  if (!when) return true;
  const active = document.activeElement;
  const dialog = active?.closest('[role="dialog"]') ?? null;
  const inSessionSwitcher = Boolean(dialog?.querySelector("[data-session-switcher]"));
  switch (when) {
    case "!dialog":
      return !dialog;
    case "!other-dialog":
      return !dialog || inSessionSwitcher;
    case "session-switcher":
      return inSessionSwitcher;
    case "!dialog && !editable":
      return (
        !dialog &&
        !(active instanceof HTMLElement && active.closest(EDITABLE_SELECTOR))
      );
  }
}

export function dispatchAction(id: ActionId): boolean {
  for (const getHandler of Array.from(registry).reverse()) {
    const handler = getHandler(id);
    if (handler) {
      return handler() !== false;
    }
  }
  return false;
}

function hasActionHandler(id: ActionId): boolean {
  for (const getHandler of Array.from(registry).reverse()) {
    if (getHandler(id)) return true;
  }
  return false;
}

export function handleActionKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return;
  const config = (
    actionConfig as readonly (ActionConfig & { action: ActionId })[]
  ).find(
    (item) => matchesKeymap(event, item.keymap) && matchesWhen(item.when),
  );
  if (!config || !hasActionHandler(config.action)) return;
  if (event.repeat && !config.repeat) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (dispatchAction(config.action)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

export function useAction(
  handlers: ActionMap,
  options?: { enabled?: boolean },
): void {
  const enabled = options?.enabled ?? true;
  const getHandler = useEffectEvent((id: ActionId) => handlers[id]);

  useEffect(() => {
    if (!enabled) return;
    const entry: RegistryEntry = (id) => getHandler(id);
    registry.add(entry);
    return () => {
      registry.delete(entry);
    };
  }, [enabled]);
}

export function filterCommands(
  query: string,
): (ActionConfig & { action: ActionId })[] {
  const search = query.trim().replace(/^>/, "").trim().toLocaleLowerCase();
  return actionConfig.filter(
    (config: ActionConfig) =>
      config.command?.length &&
      [...config.command, config.desc].some((text) =>
        text.toLocaleLowerCase().includes(search),
      ),
  );
}

export function matchesKeymap(event: KeyboardEvent, keymap?: string): boolean {
  if (!keymap || event.isComposing) return false;
  const keys = keymap.toLowerCase().split("+");
  const key = keys.pop();
  return (
    event.key.toLowerCase() === key &&
    event.shiftKey === keys.includes("shift") &&
    event.altKey === keys.includes("alt") &&
    (keys.includes("mod")
      ? (event.ctrlKey || event.metaKey) && !(event.ctrlKey && event.metaKey)
      : event.ctrlKey === keys.includes("ctrl") &&
        event.metaKey === keys.includes("meta"))
  );
}

export function formatKeymap(keymap?: string): string {
  return (
    keymap
      ?.split("+")
      .map(
        (key) =>
          ({
            mod: "Ctrl / ⌘",
            shift: "Shift",
            alt: "Alt",
            ctrl: "Ctrl",
            meta: "⌘",
          })[key] ?? key.toUpperCase(),
      )
      .join(" + ") ?? ""
  );
}

export function actionHint(id: ActionId): string {
  const config = getAction(id);
  return config.keymap
    ? `${config.desc}（${formatKeymap(config.keymap)}）`
    : config.desc;
}

export function ariaKeymap(id: ActionId): string | undefined {
  const keymap = getAction(id).keymap;
  if (!keymap) return undefined;
  const format = (value: string) =>
    value
      .split("+")
      .map(
        (key) =>
          ({ ctrl: "Control", meta: "Meta", shift: "Shift", alt: "Alt" })[
            key
          ] ?? key,
      )
      .join("+");
  return keymap.includes("mod")
    ? ["ctrl", "meta"]
        .map((mod) => format(keymap.replace("mod", mod)))
        .join(" ")
    : format(keymap);
}
