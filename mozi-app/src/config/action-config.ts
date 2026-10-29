export type ActionConfig = {
  action: string;
  keymap?: string;
  scope?: "session-list" | "model-controls";
  command?: readonly string[];
  desc: string;
};

// `mod` accepts Ctrl or ⌘. Only actions with command aliases appear after `>`.
export const actionConfig = [
  {
    action: "session.create",
    keymap: "mod+n",
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
  { action: "session.delete", keymap: "mod+d", scope: "session-list", desc: "删除选中会话" },
  { action: "model.provider", keymap: "alt+p", scope: "model-controls", desc: "切换模型服务商" },
  { action: "model.select", keymap: "alt+m", scope: "model-controls", desc: "切换模型" },
  { action: "session.switcher", keymap: "mod+k", desc: "搜索和切换会话" },
] as const satisfies readonly ActionConfig[];

export type ActionId = (typeof actionConfig)[number]["action"];

export function getAction(id: ActionId): ActionConfig {
  return actionConfig.find((config) => config.action === id)!;
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
