import { BrowserWindow, Menu, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  BROWSER_MAX_ELEMENTS,
  BROWSER_MAX_TEXT,
  BROWSER_TIMEOUT_MS,
  BrowserFailure,
  isBrowserOperation,
  isBrowserResult,
  isBrowserUrl,
  type BrowserCallContext,
  type BrowserInputExpectation,
  type BrowserOperation,
  type BrowserProgress,
  type BrowserResult,
} from "../../../../shared/browser";

import { checkPageAccess, type PageAccessCheck } from "./browser-page-access";
import { BrowserTask } from "./browser-task";
import { BrowserTaskScheduler } from "./browser-task-scheduler";

type Operation<A extends BrowserOperation["action"]> = Extract<
  BrowserOperation,
  { action: A }
>;
type InteractionOperation = Operation<"click" | "fill" | "press">;
type PageLocation = { url: string; navigation: number };

type Page = {
  url: string;
  title: string;
  content: string;
  truncated: boolean;
  empty: boolean;
  results: { title: string; url: string; snippet: string }[];
};

/** Runs in the isolated page world. All inputs are application-owned, never model JavaScript. */
function extractPage(
  kind: "search" | "read",
  limit: number,
  maxText: number,
): Page {
  const tidy = (s: string) =>
    s
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const visible = (el: Element) =>
    el.getClientRects().length > 0 &&
    getComputedStyle(el).visibility !== "hidden";
  const bodyText = document.body?.innerText ?? "";
  const url = location.href;
  const title = tidy(document.title).slice(0, 1000);
  const results: Page["results"] = [];
  if (kind === "search") {
    for (const item of document.querySelectorAll("#b_results .b_algo")) {
      if (!visible(item)) continue;
      const link = item.querySelector<HTMLAnchorElement>("h2 a[href]");
      if (!link) continue;
      try {
        let target = new URL(link.href, url);
        // Bing may wrap destination URLs in an a1-prefixed base64url parameter.
        const encoded = target.searchParams.get("u");
        if (
          /(^|\.)bing\.com$/.test(target.hostname) &&
          target.pathname === "/ck/a" &&
          encoded?.startsWith("a1")
        ) {
          const base64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
          const bytes = Uint8Array.from(
            atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
            (c) => c.charCodeAt(0),
          );
          target = new URL(new TextDecoder().decode(bytes));
        }
        const heading = tidy(link.innerText).slice(0, 1000);
        if (
          !heading ||
          target.href.length > 4096 ||
          !["http:", "https:"].includes(target.protocol) ||
          target.username ||
          target.password ||
          results.some((r) => r.url === target.href)
        )
          continue;
        results.push({
          title: heading,
          url: target.href,
          snippet: tidy(
            item.querySelector<HTMLElement>(".b_caption p, .b_snippet, p")
              ?.innerText ?? "",
          ).slice(0, 2000),
        });
        if (results.length >= limit) break;
      } catch {
        /* Ignore malformed result links. */
      }
    }
    const empty =
      !!document.querySelector("#b_results .b_no") ||
      /there are no results for|没有找到与.*相关的结果|找不到.*结果/i.test(
        bodyText,
      );
    return {
      url,
      title,
      content: "",
      truncated: false,
      empty,
      results,
    };
  }
  // Work on a clone: extraction must not alter what the user sees.
  const candidates = [
    ...document.querySelectorAll<HTMLElement>('article, main, [role="main"]'),
  ]
    .filter(visible)
    .sort((a, b) => b.innerText.length - a.innerText.length);
  const root =
    candidates.find((el) => el.innerText.trim().length >= 100) ?? document.body;
  if (!root)
    return {
      url,
      title,
      content: "",
      truncated: false,
      empty: false,
      results,
    };
  const clone = root.cloneNode(true) as HTMLElement;
  const originals = [root, ...root.querySelectorAll("*")];
  const copies = [clone, ...clone.querySelectorAll("*")];
  for (let i = originals.length - 1; i > 0; i--) {
    if (
      !visible(originals[i]) ||
      originals[i].matches(
        'script, style, noscript, nav, header, footer, aside, form, button, svg, [aria-hidden="true"]',
      )
    )
      copies[i].remove();
  }
  for (const el of clone.querySelectorAll(
    "p, div, section, article, li, h1, h2, h3, h4, pre, tr, blockquote, br",
  ))
    el.append(document.createTextNode("\n"));
  const content = tidy(clone.textContent ?? "");
  return {
    url,
    title,
    content: content.slice(0, maxText),
    truncated: content.length > maxText,
    empty: false,
    results,
  };
}

type ElementResponse =
  | Extract<BrowserResult, { kind: "inspect" }>
  | { kind: "point"; x: number; y: number }
  | { kind: "ready" }
  | {
      kind: "error";
      code: "STALE_ELEMENT" | "ELEMENT_NOT_INTERACTABLE" | "INPUT_MISMATCH";
    };

/** Element references stay in an isolated world, never in page attributes or model-provided selectors. */
type ElementMode =
  "inspect" | "locate" | "focus" | "select" | "ready" | "verify" | "guard";
function pageElements(
  mode: ElementMode,
  token: string,
  value: string,
  maximum: number,
  intent: string,
  expected: string,
  options: { filter?: "inputs"; expect?: BrowserInputExpectation },
): ElementResponse {
  type Entry = { node: HTMLElement; signature: string };
  const world = globalThis as typeof globalThis & {
    __moziElements?: { token: string; entries: Map<string, Entry> };
  };
  const tidy = (text: string) => text.replace(/\s+/g, " ").trim();
  const visible = (el: HTMLElement) => {
    if (
      !el.isConnected ||
      !el.getClientRects().length ||
      el.closest('[hidden], [inert], [aria-hidden="true"]')
    )
      return false;
    for (
      let parent: HTMLElement | null = el;
      parent;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      if (
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      )
        return false;
    }
    return true;
  };
  const disabled = (el: HTMLElement) =>
    el.matches(":disabled") || !!el.closest('[aria-disabled="true"], [inert]');
  const inputValue = (el: HTMLElement) =>
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : el.innerText;
  const normalized = (value: string) => value.replace(/\r\n?/g, "\n");
  const describe = (el: HTMLElement) => {
    const labelled = (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    const input = el instanceof HTMLInputElement;
    const textarea = el instanceof HTMLTextAreaElement;
    const field = input || textarea || el.isContentEditable;
    const inputType = input
      ? el.type
      : textarea
        ? "textarea"
        : el.isContentEditable
          ? "contenteditable"
          : undefined;
    const textControl =
      textarea ||
      (input &&
        ["text", "search", "email", "url", "tel", "password"].includes(
          el.type,
        )) ||
      el.isContentEditable;
    const readOnly =
      ((input || textarea) && el.readOnly) ||
      el.getAttribute("aria-readonly") === "true";
    const placeholder = (
      el.getAttribute("placeholder") ??
      el.getAttribute("aria-placeholder") ??
      ""
    ).slice(0, 400);
    const labels =
      input || textarea
        ? [...(el.labels ?? [])]
            .map((label) => label.textContent ?? "")
            .join(" ")
        : "";
    const name =
      [
        labelled,
        el.getAttribute("aria-label"),
        labels,
        field ? "" : el.innerText,
        el.getAttribute("title"),
        el.querySelector("img[alt]")?.getAttribute("alt"),
        placeholder,
        input && ["button", "submit", "reset"].includes(el.type)
          ? el.value
          : "",
        el.getAttribute("name"),
      ]
        .map((candidate) => tidy(candidate ?? ""))
        .find(Boolean)
        ?.slice(0, 400) ?? "";
    const role = (
      el.getAttribute("role") ||
      (el.tagName === "A"
        ? "link"
        : el.tagName === "SUMMARY"
          ? "button"
          : input && el.type === "search"
            ? "searchbox"
            : textControl
              ? "textbox"
              : el.tagName.toLowerCase())
    ).slice(0, 100);
    const rawHref = el.getAttribute("href");
    let href: string | undefined;
    try {
      const url =
        rawHref === null ? undefined : new URL(rawHref, location.href);
      if (
        url &&
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.href.length <= 4096
      )
        href = url.href;
    } catch {
      /* JavaScript-driven controls need no destination URL. */
    }
    const signature = JSON.stringify([
      role,
      name,
      el.tagName,
      rawHref,
      inputType,
      placeholder,
      readOnly,
      textControl ? undefined : el.getAttribute("aria-expanded"),
      el.getAttribute("aria-checked"),
      el.closest("form")?.getAttribute("action"),
    ]);
    return {
      name,
      role,
      href,
      signature,
      editable: !!textControl && !readOnly && !disabled(el),
      readOnly: !!readOnly,
      inputType,
      placeholder,
      hasValue: textControl ? inputValue(el).length > 0 : undefined,
      focused:
        document.activeElement === el || el.contains(document.activeElement),
    };
  };
  if (mode === "inspect") {
    const entries = new Map<string, Entry>();
    const elements: Extract<BrowserResult, { kind: "inspect" }>["elements"] =
      [];
    let truncated = false;
    const query = value.toLocaleLowerCase();
    for (const node of document.querySelectorAll<HTMLElement>(
      'a[href], button, summary, input:not([type="hidden"]), textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [onclick]',
    )) {
      if (!visible(node)) continue;
      const info = describe(node);
      if (
        options.filter === "inputs" &&
        !info.inputType &&
        !["textbox", "searchbox", "combobox"].includes(info.role)
      )
        continue;
      if (
        options.filter === "inputs" &&
        ["button", "submit", "reset", "checkbox", "radio"].includes(
          info.inputType ?? "",
        )
      )
        continue;
      if (
        query &&
        !`${info.name} ${info.placeholder}`.toLocaleLowerCase().includes(query)
      )
        continue;
      if (elements.length >= maximum) {
        truncated = true;
        break;
      }
      const elementId = `${token}:${elements.length + 1}`;
      entries.set(elementId, { node, signature: info.signature });
      elements.push({
        elementId,
        name: info.name,
        role: info.role,
        disabled: disabled(node),
        editable: info.editable,
        readOnly: info.readOnly,
        focused: info.focused,
        ...(info.hasValue === undefined ? {} : { hasValue: info.hasValue }),
        ...(info.inputType
          ? { inputType: info.inputType, placeholder: info.placeholder }
          : {}),
        ...(info.href ? { href: info.href } : {}),
      });
    }
    world.__moziElements = { token, entries };
    return {
      kind: "inspect",
      url: location.href,
      title: document.title.slice(0, 1000),
      elements,
      truncated,
    };
  }
  const entry =
    world.__moziElements?.token === token
      ? world.__moziElements.entries.get(value)
      : undefined;
  if (
    !entry ||
    !entry.node.isConnected ||
    describe(entry.node).signature !== entry.signature
  )
    return { kind: "error", code: "STALE_ELEMENT" };
  const node = entry.node;
  if (
    !visible(node) ||
    disabled(node) ||
    getComputedStyle(node).pointerEvents === "none"
  )
    return { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
  if (options.expect) {
    const expectedEntry = world.__moziElements?.entries.get(
      options.expect.elementId,
    );
    if (
      !expectedEntry ||
      !expectedEntry.node.isConnected ||
      describe(expectedEntry.node).signature !== expectedEntry.signature
    ) {
      return { kind: "error", code: "STALE_ELEMENT" };
    }
    const field = expectedEntry.node;
    if (
      !visible(field) ||
      disabled(field) ||
      describe(field).hasValue === undefined
    )
      return { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
    // Placeholder text is deliberately excluded: only the actual DOM value can satisfy this precondition.
    if (normalized(inputValue(field)) !== normalized(options.expect.text))
      return { kind: "error", code: "INPUT_MISMATCH" };
  }
  if (mode === "guard") return { kind: "ready" };
  if (intent === "fill") {
    if (
      !describe(node).editable ||
      (node instanceof HTMLInputElement && /[\r\n]/.test(expected)) ||
      ((node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement) &&
        node.maxLength >= 0 &&
        expected.length > node.maxLength)
    ) {
      return { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
    }
  }
  if (mode === "verify") {
    return normalized(inputValue(node)) === normalized(expected)
      ? { kind: "ready" }
      : { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
  }
  if (mode === "ready") {
    return document.activeElement === node ||
      node.contains(document.activeElement)
      ? { kind: "ready" }
      : { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
  }
  if (mode === "focus" || mode === "select") {
    // DOM input focus is required; desktop/window focus is not a precondition.
    node.focus({ preventScroll: true });
    // Focus handlers may replace the node or move focus to another control.
    if (!node.isConnected || describe(node).signature !== entry.signature)
      return { kind: "error", code: "STALE_ELEMENT" };
    if (
      document.activeElement !== node &&
      !node.contains(document.activeElement)
    )
      return { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
    if (mode === "select") {
      if (
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement
      )
        node.select();
      else {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    return { kind: "ready" };
  }
  node.scrollIntoView({
    block: "center",
    inline: "center",
    behavior: "instant",
  });
  if (!node.isConnected || describe(node).signature !== entry.signature)
    return { kind: "error", code: "STALE_ELEMENT" };
  for (const rect of node.getClientRects()) {
    const left = Math.max(0, rect.left),
      right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top),
      bottom = Math.min(innerHeight, rect.bottom);
    if (right - left < 2 || bottom - top < 2) continue;
    const x = Math.floor((left + right) / 2),
      y = Math.floor((top + bottom) / 2);
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit === node || node.contains(hit)))
      return { kind: "point", x, y };
  }
  return { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
}

/** Owns the window and every page task. Callers never manage navigation or DOM state. */
export class MoziBrowser {
  private window?: BrowserWindow;
  private readonly scheduler: BrowserTaskScheduler;
  private get active(): BrowserTask | undefined {
    return this.scheduler.active;
  }
  private disposed = false;
  private closing = false;
  private navigation = 0;
  private responseStatus?: number;
  private inspected?: {
    token: string;
    sessionId: string;
    url: string;
    navigation: number;
  };
  constructor(timeoutMs = BROWSER_TIMEOUT_MS) {
    this.scheduler = new BrowserTaskScheduler(
      (task) => this.runTask(task),
      () => {
        if (this.window && !this.window.webContents.isDestroyed())
          this.window.webContents.stop();
      },
      (task) => {
        if (
          this.window &&
          !this.window.isDestroyed() &&
          !this.window.webContents.isDestroyed()
        ) {
          this.window.setTitle(
            `Mozi 浏览器 · ${task.cancellationRequested ? "已停止" : "就绪"} · ${this.window.webContents.getURL()}`,
          );
        }
      },
      timeoutMs,
    );
  }

  cancel(requestId: string): void {
    this.scheduler.cancel(
      requestId,
      new BrowserFailure("CANCELLED", "浏览器任务已取消。"),
    );
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inspected = undefined;
    this.scheduler.dispose(
      new BrowserFailure("UNAVAILABLE", "Mozi 浏览器已关闭。"),
    );
    this.window?.destroy();
    this.window = undefined;
  }

  /** Compatibility entry point for callers that consume progress callbacks and a final result. */
  execute(
    operation: BrowserOperation,
    context: BrowserCallContext,
  ): Promise<BrowserResult> {
    try {
      return this.submit(operation, context).result;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Returns a task handle for state, result and resume/cancel controls. */
  submit(
    operation: BrowserOperation,
    context: BrowserCallContext,
  ): BrowserTask {
    if (this.disposed)
      throw new BrowserFailure("UNAVAILABLE", "Mozi 浏览器已关闭。");
    if (!isBrowserOperation(operation))
      throw new BrowserFailure(
        "INVALID_ARGUMENT",
        "浏览器操作参数无效，请按工具定义提供 action 及其对应参数。",
      );
    const task = new BrowserTask(operation, context);
    this.scheduler.enqueue(task);
    return task;
  }
  private cancelAll(error: BrowserFailure): void {
    this.scheduler.cancelAll(error);
  }
  private progress(
    task: BrowserTask,
    stage: BrowserProgress["stage"],
    message: string,
  ): void {
    message = message.slice(0, 1000);
    task.report({ stage, message });
    if (task === this.active && this.window && !this.window.isDestroyed()) {
      this.window.setTitle(
        `Mozi 浏览器 · ${message} · 会话 ${task.context.sessionId.slice(0, 8)}`,
      );
    }
  }
  private ensureWindow(): BrowserWindow {
    if (this.closing)
      throw new BrowserFailure(
        "WINDOW_CLOSED",
        "Mozi 浏览器正在关闭，请稍后重试。",
      );
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = new BrowserWindow({
      title: "Mozi 浏览器",
      width: 1200,
      height: 850,
      minWidth: 700,
      minHeight: 450,
      show: false,
      autoHideMenuBar: false,
      webPreferences: {
        partition: "persist:mozi-browser",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    this.window = win;
    const contents = win.webContents;
    contents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    contents.session.setPermissionCheckHandler(() => false);
    contents.on("page-title-updated", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url, referrer, postBody }) => {
      // Keep ordinary target=_blank/window.open links usable in our owned window.
      // POST forms need their original submission semantics; never turn them into GETs.
      if (isBrowserUrl(url) && !postBody) {
        const task = this.active;
        if (task && !task.waitingForUser && !task.interactionDispatched) {
          task.cancel(
            new BrowserFailure(
              "NAVIGATION_CHANGED",
              "页面已切换，本次读取已停止。",
            ),
          );
        }
        void contents.loadURL(url, { httpReferrer: referrer }).catch(() => {
          // Superseded navigations reject too; only report an idle, failed navigation.
          if (
            !win.isDestroyed() &&
            !contents.isDestroyed() &&
            !contents.isLoading() &&
            contents.getURL() === url &&
            !this.active
          ) {
            win.setTitle("Mozi 浏览器 · 链接加载失败，可刷新重试");
          }
        });
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event) => {
      if (!isBrowserUrl(event.url)) {
        event.preventDefault();
        return;
      }
      const task = this.active;
      if (
        task &&
        !task.waitingForUser &&
        !task.interactionDispatched &&
        task.stage !== "loading" &&
        !this.isSearchPage(task, event.url)
      ) {
        task.cancel(
          new BrowserFailure(
            "NAVIGATION_CHANGED",
            "页面已切换，本次读取已停止。",
          ),
        );
      }
    });
    contents.on("will-redirect", (event) => {
      if (!isBrowserUrl(event.url)) {
        event.preventDefault();
        this.active?.cancel(
          new BrowserFailure("LOAD_FAILED", "网页跳转到不支持的地址。"),
        );
      }
    });
    contents.on("did-start-navigation", (event) => {
      if (event.isMainFrame) {
        this.navigation++;
        this.responseStatus = undefined;
        this.inspected = undefined;
      }
    });
    contents.on("did-navigate", (_event, _url, status) => {
      this.responseStatus = status;
    });
    contents.on("render-process-gone", () =>
      this.cancelAll(
        new BrowserFailure("LOAD_FAILED", "浏览器页面进程已退出，请重试。"),
      ),
    );
    win.on("close", () => {
      this.closing = true;
      this.cancelAll(
        new BrowserFailure("WINDOW_CLOSED", "用户关闭了 Mozi 浏览器。"),
      );
    });
    win.on("closed", () => {
      if (this.window !== win) return;
      this.window = undefined;
      this.inspected = undefined;
      this.closing = false;
      this.cancelAll(
        new BrowserFailure("WINDOW_CLOSED", "用户关闭了 Mozi 浏览器。"),
      );
    });
    const manual = (action: () => void) => {
      if (this.active && !this.active.waitingForUser)
        this.cancel(this.active.context.requestId);
      action();
    };
    win.setMenu(
      Menu.buildFromTemplate([
        {
          label: "Mozi 浏览器",
          submenu: [
            {
              label: "后退",
              accelerator: "Alt+Left",
              click: () =>
                manual(() => {
                  if (contents.navigationHistory.canGoBack())
                    contents.navigationHistory.goBack();
                }),
            },
            {
              label: "前进",
              accelerator: "Alt+Right",
              click: () =>
                manual(() => {
                  if (contents.navigationHistory.canGoForward())
                    contents.navigationHistory.goForward();
                }),
            },
            {
              label: "刷新",
              accelerator: "CmdOrCtrl+R",
              click: () => manual(() => contents.reload()),
            },
            { type: "separator" },
            {
              label: "停止任务",
              accelerator: "Escape",
              click: () => {
                this.cancelAll(
                  new BrowserFailure("CANCELLED", "用户停止了浏览器任务。"),
                );
                contents.stop();
              },
            },
            {
              label: "继续读取（完成验证后）",
              accelerator: "CmdOrCtrl+Enter",
              click: () => this.active?.resume(),
            },
            { type: "separator" },
            { role: "copy", label: "复制" },
            { role: "selectAll", label: "全选" },
            {
              label: "关闭",
              accelerator: "CmdOrCtrl+W",
              click: () => win.close(),
            },
          ],
        },
      ]),
    );
    // Make a newly created browser discoverable without taking keyboard focus.
    win.showInactive();
    return win;
  }

  private isSearchPage(task: BrowserTask, url: string): boolean {
    if (task.operation.action !== "search" || !isBrowserUrl(url)) return false;
    const parsed = new URL(url);
    return (
      /(^|\.)bing\.com$/.test(parsed.hostname) &&
      parsed.pathname === "/search" &&
      parsed.searchParams.get("q") === task.operation.query
    );
  }

  private wait<T>(task: BrowserTask, work: Promise<T>): Promise<T> {
    return task.wait(work);
  }
  private pause(task: BrowserTask, ms: number): Promise<void> {
    return task.pause(ms);
  }
  private waitForUser(task: BrowserTask): Promise<void> {
    return task.waitForResume(() =>
      this.progress(
        task,
        "waiting_user",
        "当前页面可能需要登录或验证，请检查页面；处理后选择菜单“继续读取”，也可停止任务。",
      ),
    );
  }
  private async snapshot(
    task: BrowserTask,
    contents: WebContents,
  ): Promise<Page & { access: PageAccessCheck }> {
    const navigation = this.navigation;
    const before = contents.getURL();
    const source = `({ ...(${extractPage.toString()})(${JSON.stringify(task.operation.action === "search" ? "search" : "read")}, ${task.operation.action === "search" ? (task.operation.limit ?? 5) : 5}, ${BROWSER_MAX_TEXT}), access: (${checkPageAccess.toString()})() })`;
    const page: Page & { access: PageAccessCheck } = await this.wait(
      task,
      contents.executeJavaScriptInIsolatedWorld(1001, [{ code: source }]),
    );
    if (
      navigation !== this.navigation ||
      before !== contents.getURL() ||
      page.url !== contents.getURL()
    ) {
      throw new BrowserFailure(
        "NAVIGATION_CHANGED",
        "提取期间页面发生变化，请重新读取目标网址。",
      );
    }
    return page;
  }
  private async settledPage(
    task: BrowserTask,
    contents: WebContents,
  ): Promise<{ url: string; navigation: number }> {
    while (contents.isLoadingMainFrame()) await this.pause(task, 100);
    task.throwIfCancelled();
    const url = contents.getURL();
    if (!isBrowserUrl(url))
      throw new BrowserFailure(
        "UNAVAILABLE",
        "Mozi 浏览器没有可读取的当前网页，请先打开网页或搜索。",
      );
    return { url, navigation: this.navigation };
  }
  private async elementContext(
    task: BrowserTask,
    win: BrowserWindow,
    operation: Operation<"inspect"> | InteractionOperation,
  ) {
    const contents = win.webContents;
    this.progress(task, "loading", "正在获取当前页面状态…");
    const page = await this.settledPage(task, contents);
    const options =
      operation.action === "inspect"
        ? { filter: operation.filter }
        : operation.action === "click" || operation.action === "press"
          ? { expect: operation.expect }
          : {};
    const evaluate = (
      mode: ElementMode,
      token: string,
      value: string,
    ): Promise<ElementResponse> =>
      this.wait(
        task,
        contents.executeJavaScriptInIsolatedWorld(1001, [
          {
            code: `(${pageElements.toString()})(${JSON.stringify(mode)}, ${JSON.stringify(token)}, ${JSON.stringify(value)}, ${BROWSER_MAX_ELEMENTS}, ${JSON.stringify(operation.action)}, ${JSON.stringify(operation.action === "fill" ? operation.text : "")}, ${JSON.stringify(options)})`,
          },
        ]),
      );
    const unchanged = () => {
      task.throwIfCancelled();
      if (
        page.navigation !== this.navigation ||
        page.url !== contents.getURL()
      ) {
        throw new BrowserFailure(
          "STALE_ELEMENT",
          "页面已经变化，请重新 inspect 后再操作。",
        );
      }
    };
    return { contents, page, evaluate, unchanged };
  }

  private async inspect(
    task: BrowserTask,
    win: BrowserWindow,
    operation: Operation<"inspect">,
  ): Promise<BrowserResult> {
    const { page, evaluate, unchanged } = await this.elementContext(
      task,
      win,
      operation,
    );
    this.inspected = undefined;
    this.progress(task, "extracting", "正在查看当前页面可交互元素…");
    const token = randomUUID();
    const result = await evaluate("inspect", token, operation.query ?? "");
    unchanged();
    if (result.kind !== "inspect" || !isBrowserResult(result))
      throw new BrowserFailure("EXTRACTION_FAILED", "无法提取页面元素。");
    this.inspected = { token, sessionId: task.context.sessionId, ...page };
    return result;
  }

  private async prepareInteraction(
    task: BrowserTask,
    win: BrowserWindow,
    operation: InteractionOperation,
  ) {
    const { contents, page, evaluate, unchanged } = await this.elementContext(
      task,
      win,
      operation,
    );
    const inspected = this.inspected;
    if (
      !inspected ||
      inspected.sessionId !== task.context.sessionId ||
      inspected.navigation !== page.navigation ||
      inspected.url !== page.url ||
      !operation.elementId.startsWith(`${inspected.token}:`)
    ) {
      throw new BrowserFailure(
        "STALE_ELEMENT",
        "元素编号不属于当前会话和页面，请先 inspect 获取新编号。",
      );
    }
    // Each inspected set permits one interaction attempt, including uncertain/failed outcomes.
    this.inspected = undefined;
    this.progress(
      task,
      "interacting",
      operation.action === "fill"
        ? "正在输入文本…"
        : operation.action === "press"
          ? "正在向页面发送按键…"
          : "正在定位并点击页面元素…",
    );
    const perform = async (mode: ElementMode) => {
      const result = await evaluate(mode, inspected.token, operation.elementId);
      unchanged();
      if (result.kind === "error")
        throw new BrowserFailure(
          result.code,
          result.code === "STALE_ELEMENT"
            ? "元素已消失或内容发生变化，请重新 inspect。"
            : result.code === "INPUT_MISMATCH"
              ? "未提交：输入框实际内容与预期关键词不一致；占位提示不算输入。请重新 inspect、fill 正确关键词，再带 expect 提交。不要构造搜索 URL 绕过失败。"
              : "元素无法操作：可能被遮挡、禁用、只读、输入类型不支持或未保留输入内容。请检查页面并重新 inspect。",
        );
      return result;
    };
    const locate = async () => {
      const result = await perform("locate");
      if (
        result.kind !== "point" ||
        !Number.isFinite(result.x) ||
        !Number.isFinite(result.y)
      )
        throw new BrowserFailure("EXTRACTION_FAILED", "无法定位元素。");
      return result;
    };
    const first = await locate();
    await this.cdp(task, contents, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: first.x,
      y: first.y,
    });
    // Hover/scroll handlers may replace or cover the target. Recheck before sending input.
    await this.pause(task, 100);
    const point = await locate();
    unchanged();
    return { contents, point, perform, unchanged };
  }

  private async click(
    task: BrowserTask,
    win: BrowserWindow,
    operation: Operation<"click">,
  ): Promise<BrowserResult> {
    const { contents, point, perform } = await this.prepareInteraction(
      task,
      win,
      operation,
    );
    await perform("guard");
    task.interactionDispatched = true;
    await this.cdp(task, contents, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await this.cdp(task, contents, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    return this.finishInteraction(task, contents, operation);
  }

  private async prepareTextInput(
    task: BrowserTask,
    win: BrowserWindow,
    operation: Operation<"fill" | "press">,
  ) {
    const context = await this.prepareInteraction(task, win, operation);
    await context.perform(operation.action === "fill" ? "select" : "focus");
    // Let focus/selection handlers run before dispatching to the focused control.
    await this.pause(task, 50);
    await context.perform("ready");
    context.unchanged();
    return context;
  }

  private async fill(
    task: BrowserTask,
    win: BrowserWindow,
    operation: Operation<"fill">,
  ): Promise<BrowserResult> {
    const { contents, perform } = await this.prepareTextInput(
      task,
      win,
      operation,
    );
    task.interactionDispatched = true;
    if (operation.text) {
      // Chromium performs the edit and emits trusted input events (including for controlled inputs).
      await this.cdp(task, contents, "Input.insertText", {
        text: operation.text,
      });
    } else {
      await this.sendKey(task, contents, "Backspace");
    }
    await this.pause(task, 100);
    await perform("verify");
    return this.finishInteraction(task, contents, operation);
  }

  private async press(
    task: BrowserTask,
    win: BrowserWindow,
    operation: Operation<"press">,
  ): Promise<BrowserResult> {
    const { contents } = await this.prepareTextInput(task, win, operation);
    task.interactionDispatched = true;
    await this.sendKey(task, contents, operation.key);
    return this.finishInteraction(task, contents, operation);
  }

  private async cdp(
    task: BrowserTask,
    contents: WebContents,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    task.throwIfCancelled();
    try {
      await this.wait(task, contents.debugger.sendCommand(method, params));
    } catch (error) {
      task.throwIfCancelled();
      throw new BrowserFailure(
        "UNAVAILABLE",
        `后台浏览器操作失败：${error instanceof Error ? error.message : "调试连接不可用"}`,
      );
    }
  }

  private async sendKey(
    task: BrowserTask,
    contents: WebContents,
    key: string,
  ): Promise<void> {
    const codes: Record<string, number> = {
      Backspace: 8,
      Tab: 9,
      Enter: 13,
      Escape: 27,
      ArrowLeft: 37,
      ArrowUp: 38,
      ArrowRight: 39,
      ArrowDown: 40,
    };
    const params = { key, code: key, windowsVirtualKeyCode: codes[key] };
    await this.cdp(task, contents, "Input.dispatchKeyEvent", {
      ...params,
      type: "rawKeyDown",
    });
    if (key === "Enter")
      await this.cdp(task, contents, "Input.dispatchKeyEvent", {
        ...params,
        type: "char",
        text: "\r",
        unmodifiedText: "\r",
      });
    await this.cdp(task, contents, "Input.dispatchKeyEvent", {
      ...params,
      type: "keyUp",
    });
  }

  /** Each interaction owns its debugger session and explicitly restores focus emulation. */
  private async withBackgroundInput(
    task: BrowserTask,
    contents: WebContents,
    action: () => Promise<BrowserResult>,
  ): Promise<BrowserResult> {
    task.throwIfCancelled();
    if (contents.debugger.isAttached())
      throw new BrowserFailure(
        "UNAVAILABLE",
        "浏览器已有调试连接，请关闭调试后重试后台操作。",
      );
    try {
      contents.debugger.attach("1.3");
    } catch {
      throw new BrowserFailure("UNAVAILABLE", "无法建立后台浏览器调试连接。");
    }
    let detached = false;
    const onDetach = () => {
      detached = true;
      task.cancel(
        new BrowserFailure(
          "UNAVAILABLE",
          "后台浏览器调试连接已断开，请重新观察页面后重试。",
        ),
      );
    };
    contents.debugger.on("detach", onDetach);
    try {
      await this.cdp(task, contents, "Emulation.setFocusEmulationEnabled", {
        enabled: true,
      });
      return await action();
    } finally {
      if (
        !detached &&
        !contents.isDestroyed() &&
        contents.debugger.isAttached()
      ) {
        // Cleanup must run even when the task was cancelled.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            contents.debugger.sendCommand(
              "Emulation.setFocusEmulationEnabled",
              { enabled: false },
            ),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 1000);
            }),
          ]);
        } catch {
          /* The target may close while restoring its state. */
        } finally {
          clearTimeout(timer);
        }
      }
      contents.debugger.removeListener("detach", onDetach);
      // Never detach a replacement session established after an external disconnect.
      if (
        !detached &&
        !contents.isDestroyed() &&
        contents.debugger.isAttached()
      )
        contents.debugger.detach();
    }
  }

  private async finishInteraction(
    task: BrowserTask,
    contents: WebContents,
    operation: InteractionOperation,
  ): Promise<BrowserResult> {
    await this.pause(task, 400);
    const destination = await this.settledPage(task, contents);
    return {
      kind: operation.action,
      elementId: operation.elementId,
      dispatched: true,
      ...(operation.action === "fill" || operation.expect
        ? { inputVerified: true as const }
        : {}),
      url: destination.url,
      title: contents.getTitle().slice(0, 1000),
    };
  }

  private async runTask(task: BrowserTask): Promise<BrowserResult> {
    const { operation } = task;
    task.throwIfCancelled();
    const current =
      operation.action !== "search" &&
      (operation.action !== "read" || operation.target === "current");
    const win = current ? this.window : this.ensureWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new BrowserFailure(
        "UNAVAILABLE",
        "Mozi 浏览器没有可读取的当前页面，请先打开网页或搜索。",
      );
    }
    const contents = win.webContents;
    // Preserve the user's hidden/minimized/background window state between tasks.
    switch (operation.action) {
      case "search":
        return this.search(task, contents, operation);
      case "read":
        return this.read(task, contents, operation);
      case "inspect":
        return this.inspect(task, win, operation);
      case "click":
        return this.withBackgroundInput(task, contents, () =>
          this.click(task, win, operation),
        );
      case "fill":
        return this.withBackgroundInput(task, contents, () =>
          this.fill(task, win, operation),
        );
      case "press":
        return this.withBackgroundInput(task, contents, () =>
          this.press(task, win, operation),
        );
    }
  }

  private async search(
    task: BrowserTask,
    contents: WebContents,
    operation: Operation<"search">,
  ): Promise<BrowserResult> {
    const target = `https://www.bing.com/search?q=${encodeURIComponent(operation.query)}`;
    this.progress(task, "loading", `正在搜索：${operation.query}`);
    await this.navigate(task, contents, target);
    return this.collectPage(task, contents, operation);
  }

  private async read(
    task: BrowserTask,
    contents: WebContents,
    operation: Operation<"read">,
  ): Promise<BrowserResult> {
    let currentPage: PageLocation | undefined;
    if (operation.target === "current") {
      // Resolve current state when this queued operation starts, never from model history.
      this.progress(
        task,
        "loading",
        "正在获取 Mozi 浏览器当前页面，等待页面加载完成…",
      );
      currentPage = await this.settledPage(task, contents);
    } else {
      if (!operation.url)
        throw new BrowserFailure("INVALID_ARGUMENT", "打开网页需要提供网址。");
      this.progress(
        task,
        "loading",
        `正在打开：${operation.url.slice(0, 300)}`,
      );
      await this.navigate(task, contents, operation.url);
    }
    return this.collectPage(task, contents, operation, currentPage);
  }

  private async navigate(
    task: BrowserTask,
    contents: WebContents,
    url: string,
  ): Promise<void> {
    try {
      await this.wait(task, contents.loadURL(url));
    } catch (error) {
      if (task.cancellationRequested) throw task.reason;
      throw new BrowserFailure(
        "LOAD_FAILED",
        `网页加载失败：${error instanceof Error ? error.message.slice(0, 500) : "未知错误"}`,
      );
    }
  }

  private async collectPage(
    task: BrowserTask,
    contents: WebContents,
    operation: Operation<"search" | "read">,
    currentPage?: PageLocation,
  ): Promise<BrowserResult> {
    this.progress(task, "extracting", "正在读取页面内容…");
    let previous = "";
    let stable = 0;
    let deadline = Date.now() + 15_000;
    for (;;) {
      task.throwIfCancelled();
      if (
        currentPage &&
        (currentPage.navigation !== this.navigation ||
          currentPage.url !== contents.getURL())
      ) {
        throw new BrowserFailure(
          "NAVIGATION_CHANGED",
          "读取期间当前页面发生变化，请重新读取当前页面。",
        );
      }
      let page: Page & { access: PageAccessCheck };
      try {
        page = await this.snapshot(task, contents);
      } catch (error) {
        // Bing performs region/client redirects. Read only a settled page for the same query.
        task.throwIfCancelled();
        if (
          !this.isSearchPage(task, contents.getURL()) ||
          Date.now() >= deadline
        )
          throw error;
        previous = "";
        stable = 0;
        await this.pause(task, 400);
        continue;
      }
      if (!isBrowserUrl(page.url))
        throw new BrowserFailure("LOAD_FAILED", "网页地址不受支持。");
      // The helper reports suspected barriers; this flow owns the decision to pause.
      if (page.access.suspectedBlock !== null) {
        await this.waitForUser(task);
        // Explicit continuation after login/verification permits its resulting page.
        if (currentPage) currentPage = await this.settledPage(task, contents);
        deadline = Date.now() + 15_000;
        previous = "";
        stable = 0;
        this.progress(task, "extracting", "正在重新读取页面…");
        continue;
      }
      if (this.responseStatus !== undefined && this.responseStatus >= 400) {
        throw new BrowserFailure(
          "LOAD_FAILED",
          `网页返回 HTTP ${this.responseStatus}，无法读取有效内容。`,
        );
      }
      if (operation.action === "search" && !this.isSearchPage(task, page.url)) {
        throw new BrowserFailure(
          "NAVIGATION_CHANGED",
          "搜索页面已跳转，请重新搜索或使用网页阅读工具。",
        );
      }
      const result: BrowserResult =
        operation.action === "search"
          ? {
              kind: "search",
              query: operation.query,
              url: page.url,
              results: page.results,
            }
          : {
              kind: "read",
              title: page.title,
              url: page.url,
              content: page.content,
              truncated: page.truncated,
            };
      const usable =
        operation.action === "search"
          ? page.results.length > 0 || page.empty
          : page.content.trim().length > 0;
      const fingerprint = JSON.stringify(result);
      stable = usable && fingerprint === previous ? stable + 1 : 0;
      previous = fingerprint;
      if (usable && stable >= 2) {
        if (!isBrowserResult(result))
          throw new BrowserFailure(
            "EXTRACTION_FAILED",
            "提取结果无效或超过容量。",
          );
        return result;
      }
      if (Date.now() >= deadline)
        throw new BrowserFailure(
          "EXTRACTION_FAILED",
          "未能提取稳定的页面内容；页面可能需要登录、仍在加载或布局不受支持。",
        );
      await this.pause(task, 400);
    }
  }
}
