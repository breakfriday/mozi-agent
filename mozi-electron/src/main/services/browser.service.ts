import { BrowserWindow, Menu, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { BROWSER_MAX_ELEMENTS, BROWSER_MAX_PENDING, BROWSER_MAX_TEXT, BROWSER_TIMEOUT_MS, BrowserFailure, isBrowserOperation, isBrowserResult, isBrowserUrl,
  type BrowserCallContext, type BrowserInputExpectation, type BrowserOperation, type BrowserProgress, type BrowserResult } from "../../../../shared/browser";

type Task = {
  operation: BrowserOperation;
  context: BrowserCallContext;
  controller: AbortController;
  cleanup(): void;
  resolve(result: BrowserResult): void;
  reject(error: unknown): void;
  stage?: BrowserProgress["stage"];
  resume?: () => void;
  interactionDispatched?: boolean;
};
type Page = { url: string; title: string; content: string; truncated: boolean; blocked: boolean; empty: boolean;
  results: { title: string; url: string; snippet: string }[] };

/** Runs in the isolated page world. All inputs are application-owned, never model JavaScript. */
function extractPage(kind: "search" | "read", limit: number, maxText: number): Page {
  const tidy = (s: string) => s.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const bodyText = document.body?.innerText ?? "";
  const challenge = [...document.querySelectorAll('iframe[src*="captcha"], iframe[src*="challenge"], #challenge-running, #b_captcha, input[name="captcha"]')].some(visible);
  const login = bodyText.length < 2000 && [...document.querySelectorAll('input[type="password"]')].some(visible);
  const blocked = challenge || login || /verify (?:that )?you are human|checking your browser|unusual traffic from your computer|完成验证|请输入验证码|验证您是人类/i.test(bodyText.slice(0, 6000));
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
        if (/(^|\.)bing\.com$/.test(target.hostname) && target.pathname === "/ck/a" && encoded?.startsWith("a1")) {
          const base64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
          const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), c => c.charCodeAt(0));
          target = new URL(new TextDecoder().decode(bytes));
        }
        const heading = tidy(link.innerText).slice(0, 1000);
        if (!heading || target.href.length > 4096 || !["http:", "https:"].includes(target.protocol) || target.username || target.password || results.some(r => r.url === target.href)) continue;
        results.push({ title: heading, url: target.href, snippet: tidy((item.querySelector<HTMLElement>(".b_caption p, .b_snippet, p")?.innerText ?? "")).slice(0, 2000) });
        if (results.length >= limit) break;
      } catch { /* Ignore malformed result links. */ }
    }
    const empty = !!document.querySelector("#b_results .b_no") || /there are no results for|没有找到与.*相关的结果|找不到.*结果/i.test(bodyText);
    return { url, title, content: "", truncated: false, blocked, empty, results };
  }
  // Work on a clone: extraction must not alter what the user sees.
  const candidates = [...document.querySelectorAll<HTMLElement>('article, main, [role="main"]')].filter(visible)
    .sort((a, b) => b.innerText.length - a.innerText.length);
  const root = candidates.find(el => el.innerText.trim().length >= 100) ?? document.body;
  if (!root) return { url, title, content: "", truncated: false, blocked, empty: false, results };
  const clone = root.cloneNode(true) as HTMLElement;
  const originals = [root, ...root.querySelectorAll("*")];
  const copies = [clone, ...clone.querySelectorAll("*")];
  for (let i = originals.length - 1; i > 0; i--) {
    if (!visible(originals[i]) || originals[i].matches('script, style, noscript, nav, header, footer, aside, form, button, svg, [aria-hidden="true"]')) copies[i].remove();
  }
  for (const el of clone.querySelectorAll("p, div, section, article, li, h1, h2, h3, h4, pre, tr, blockquote, br")) el.append(document.createTextNode("\n"));
  const content = tidy(clone.textContent ?? "");
  return { url, title, content: content.slice(0, maxText), truncated: content.length > maxText, blocked, empty: false, results };
}

type ElementResponse = Extract<BrowserResult, { kind: "inspect" }>
  | { kind: "point"; x: number; y: number }
  | { kind: "ready" }
  | { kind: "error"; code: "STALE_ELEMENT" | "ELEMENT_NOT_INTERACTABLE" | "INPUT_MISMATCH" };

/** Element references stay in an isolated world, never in page attributes or model-provided selectors. */
type ElementMode = "inspect" | "locate" | "focus" | "select" | "ready" | "verify" | "guard";
function pageElements(mode: ElementMode, token: string, value: string, maximum: number, intent: string, expected: string, options: { filter?: "inputs"; expect?: BrowserInputExpectation }): ElementResponse {
  type Entry = { node: HTMLElement; signature: string };
  const world = globalThis as typeof globalThis & { __moziElements?: { token: string; entries: Map<string, Entry> } };
  const tidy = (text: string) => text.replace(/\s+/g, " ").trim();
  const visible = (el: HTMLElement) => {
    if (!el.isConnected || !el.getClientRects().length || el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const disabled = (el: HTMLElement) => el.matches(":disabled") || !!el.closest('[aria-disabled="true"], [inert]');
  const inputValue = (el: HTMLElement) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.innerText;
  const normalized = (value: string) => value.replace(/\r\n?/g, "\n");
  const describe = (el: HTMLElement) => {
    const labelled = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ").trim();
    const input = el instanceof HTMLInputElement;
    const textarea = el instanceof HTMLTextAreaElement;
    const field = input || textarea || el.isContentEditable;
    const inputType = input ? el.type : textarea ? "textarea" : el.isContentEditable ? "contenteditable" : undefined;
    const textControl = textarea || input && ["text", "search", "email", "url", "tel", "password"].includes(el.type) || el.isContentEditable;
    const readOnly = (input || textarea) && el.readOnly || el.getAttribute("aria-readonly") === "true";
    const placeholder = (el.getAttribute("placeholder") ?? el.getAttribute("aria-placeholder") ?? "").slice(0, 400);
    const labels = input || textarea ? [...(el.labels ?? [])].map(label => label.textContent ?? "").join(" ") : "";
    const name = [labelled, el.getAttribute("aria-label"), labels, field ? "" : el.innerText,
      el.getAttribute("title"), el.querySelector("img[alt]")?.getAttribute("alt"), placeholder,
      input && ["button", "submit", "reset"].includes(el.type) ? el.value : "", el.getAttribute("name")]
      .map(candidate => tidy(candidate ?? "")).find(Boolean)?.slice(0, 400) ?? "";
    const role = (el.getAttribute("role") || (el.tagName === "A" ? "link" : el.tagName === "SUMMARY" ? "button"
      : input && el.type === "search" ? "searchbox" : textControl ? "textbox" : el.tagName.toLowerCase())).slice(0, 100);
    const rawHref = el.getAttribute("href");
    let href: string | undefined;
    try {
      const url = rawHref === null ? undefined : new URL(rawHref, location.href);
      if (url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 4096) href = url.href;
    } catch { /* JavaScript-driven controls need no destination URL. */ }
    const signature = JSON.stringify([role, name, el.tagName, rawHref, inputType, placeholder, readOnly,
      textControl ? undefined : el.getAttribute("aria-expanded"), el.getAttribute("aria-checked"), el.closest("form")?.getAttribute("action")]);
    return { name, role, href, signature, editable: !!textControl && !readOnly && !disabled(el), readOnly: !!readOnly,
      inputType, placeholder, hasValue: textControl ? inputValue(el).length > 0 : undefined, focused: document.activeElement === el || el.contains(document.activeElement) };
  };
  if (mode === "inspect") {
    const entries = new Map<string, Entry>();
    const elements: Extract<BrowserResult, { kind: "inspect" }>["elements"] = [];
    let truncated = false;
    const query = value.toLocaleLowerCase();
    for (const node of document.querySelectorAll<HTMLElement>('a[href], button, summary, input:not([type="hidden"]), textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [onclick]')) {
      if (!visible(node)) continue;
      const info = describe(node);
      if (options.filter === "inputs" && !info.inputType && !["textbox", "searchbox", "combobox"].includes(info.role)) continue;
      if (options.filter === "inputs" && ["button", "submit", "reset", "checkbox", "radio"].includes(info.inputType ?? "")) continue;
      if (query && !`${info.name} ${info.placeholder}`.toLocaleLowerCase().includes(query)) continue;
      if (elements.length >= maximum) { truncated = true; break; }
      const elementId = `${token}:${elements.length + 1}`;
      entries.set(elementId, { node, signature: info.signature });
      elements.push({ elementId, name: info.name, role: info.role, disabled: disabled(node), editable: info.editable, readOnly: info.readOnly, focused: info.focused, ...(info.hasValue === undefined ? {} : { hasValue: info.hasValue }),
        ...(info.inputType ? { inputType: info.inputType, placeholder: info.placeholder } : {}), ...(info.href ? { href: info.href } : {}) });
    }
    world.__moziElements = { token, entries };
    return { kind: "inspect", url: location.href, title: document.title.slice(0, 1000), elements, truncated };
  }
  const entry = world.__moziElements?.token === token ? world.__moziElements.entries.get(value) : undefined;
  if (!entry || !entry.node.isConnected || describe(entry.node).signature !== entry.signature) return { kind: "error", code: "STALE_ELEMENT" };
  const node = entry.node;
  if (!visible(node) || disabled(node) || getComputedStyle(node).pointerEvents === "none") return { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
  if (options.expect) {
    const expectedEntry = world.__moziElements?.entries.get(options.expect.elementId);
    if (!expectedEntry || !expectedEntry.node.isConnected || describe(expectedEntry.node).signature !== expectedEntry.signature) {
      return { kind: "error", code: "STALE_ELEMENT" };
    }
    const field = expectedEntry.node;
    if (!visible(field) || disabled(field) || describe(field).hasValue === undefined) return { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
    // Placeholder text is deliberately excluded: only the actual DOM value can satisfy this precondition.
    if (normalized(inputValue(field)) !== normalized(options.expect.text)) return { kind: "error", code: "INPUT_MISMATCH" };
  }
  if (mode === "guard") return { kind: "ready" };
  if (intent === "fill") {
    if (!describe(node).editable || node instanceof HTMLInputElement && /[\r\n]/.test(expected)
      || (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) && node.maxLength >= 0 && expected.length > node.maxLength) {
      return { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
    }
  }
  if (mode === "verify") {
    return normalized(inputValue(node)) === normalized(expected)
      ? { kind: "ready" } : { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
  }
  if (mode === "ready") {
    return document.hasFocus() && (document.activeElement === node || node.contains(document.activeElement))
      ? { kind: "ready" } : { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
  }
  if (mode === "focus" || mode === "select") {
    if (!document.hasFocus()) return { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
    node.focus({ preventScroll: true });
    // Focus handlers may replace the node or move focus to another control.
    if (!node.isConnected || describe(node).signature !== entry.signature) return { kind: "error", code: "STALE_ELEMENT" };
    if (document.activeElement !== node && !node.contains(document.activeElement)) return { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
    if (mode === "select") {
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) node.select();
      else {
        const range = document.createRange(); range.selectNodeContents(node);
        const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      }
    }
    return { kind: "ready" };
  }
  node.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  if (!node.isConnected || describe(node).signature !== entry.signature) return { kind: "error", code: "STALE_ELEMENT" };
  for (const rect of node.getClientRects()) {
    const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    if (right - left < 2 || bottom - top < 2) continue;
    const x = Math.floor((left + right) / 2), y = Math.floor((top + bottom) / 2);
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit === node || node.contains(hit))) return { kind: "point", x, y };
  }
  return { kind: "error", code: "ELEMENT_NOT_INTERACTABLE" };
}

/** Owns the window and every page task. Callers never manage navigation or DOM state. */
export class MoziBrowser {
  private window?: BrowserWindow;
  private readonly tasks = new Map<string, Task>();
  private readonly queue: Task[] = [];
  private active?: Task;
  private disposed = false;
  private closing = false;
  private navigation = 0;
  private responseStatus?: number;
  private inspected?: { token: string; sessionId: string; url: string; navigation: number };
  constructor(private readonly timeoutMs = BROWSER_TIMEOUT_MS) {}

  cancel(requestId: string): void {
    this.tasks.get(requestId)?.controller.abort(new BrowserFailure("CANCELLED", "浏览器任务已取消。"));
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inspected = undefined;
    this.cancelAll(new BrowserFailure("UNAVAILABLE", "Mozi 浏览器已关闭。"));
    this.window?.destroy();
    this.window = undefined;
  }

  execute(operation: BrowserOperation, context: BrowserCallContext): Promise<BrowserResult> {
    if (this.disposed) return Promise.reject(new BrowserFailure("UNAVAILABLE", "Mozi 浏览器已关闭。"));
    if (!isBrowserOperation(operation)) return Promise.reject(new BrowserFailure("INVALID_ARGUMENT", "浏览器操作参数无效，请按工具定义提供 action 及其对应参数。"));
    if (this.tasks.has(context.requestId) || this.tasks.size >= BROWSER_MAX_PENDING) return Promise.reject(new BrowserFailure("CAPACITY_EXCEEDED", "浏览器任务重复或队列已满。"));
    const abortReason = () => context.signal.reason instanceof BrowserFailure ? context.signal.reason : new BrowserFailure("CANCELLED", "浏览器任务已取消。");
    if (context.signal.aborted) return Promise.reject(abortReason());
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const abort = () => controller.abort(abortReason());
      const timer = setTimeout(() => controller.abort(new BrowserFailure("TIMEOUT", "浏览器任务超时，请重试；若出现验证页面，请处理后选择“继续读取”。")), this.timeoutMs);
      const task: Task = { operation, context, controller, resolve, reject, cleanup: () => {
        clearTimeout(timer); context.signal.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", cancelled);
        this.tasks.delete(context.requestId);
      } };
      const cancelled = () => {
        if (this.active === task) {
          if (this.window && !this.window.webContents.isDestroyed()) this.window.webContents.stop();
        }
        else {
          const index = this.queue.indexOf(task);
          if (index >= 0) this.queue.splice(index, 1);
          task.cleanup(); reject(controller.signal.reason);
        }
      };
      this.tasks.set(context.requestId, task);
      this.queue.push(task);
      context.signal.addEventListener("abort", abort, { once: true });
      controller.signal.addEventListener("abort", cancelled, { once: true });
      try { this.progress(task, "queued", "等待 Mozi 浏览器执行任务…"); }
      catch (error) { controller.abort(error); }
      this.pump();
    });
  }
  private pump(): void {
    if (this.active || this.disposed) return;
    const task = this.queue.shift();
    if (!task) return;
    this.active = task;
    void this.runTask(task).then(task.resolve, task.reject).finally(() => {
      task.cleanup();
      this.active = undefined;
      if (this.window && !this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
        this.window.setTitle(`Mozi 浏览器 · ${task.controller.signal.aborted ? "已停止" : "就绪"} · ${this.window.webContents.getURL()}`);
      }
      this.pump();
    });
  }
  private cancelAll(error: BrowserFailure): void {
    for (const task of [...this.tasks.values()]) task.controller.abort(error);
  }
  private progress(task: Task, stage: BrowserProgress["stage"], message: string): void {
    message = message.slice(0, 1000);
    task.stage = stage;
    task.context.onProgress({ stage, message });
    if (task === this.active && this.window && !this.window.isDestroyed()) {
      this.window.setTitle(`Mozi 浏览器 · ${message} · 会话 ${task.context.sessionId.slice(0, 8)}`);
    }
  }
  private ensureWindow(): BrowserWindow {
    if (this.closing) throw new BrowserFailure("WINDOW_CLOSED", "Mozi 浏览器正在关闭，请稍后重试。");
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = new BrowserWindow({ title: "Mozi 浏览器", width: 1200, height: 850, minWidth: 700, minHeight: 450,
      autoHideMenuBar: false, webPreferences: { partition: "persist:mozi-browser", sandbox: true, contextIsolation: true,
        nodeIntegration: false, webSecurity: true } });
    this.window = win;
    const contents = win.webContents;
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    contents.on("page-title-updated", event => event.preventDefault());
    contents.setWindowOpenHandler(({ url, referrer, postBody }) => {
      // Keep ordinary target=_blank/window.open links usable in our owned window.
      // POST forms need their original submission semantics; never turn them into GETs.
      if (isBrowserUrl(url) && !postBody) {
        const task = this.active;
        if (task && !task.resume && !task.interactionDispatched) {
          task.controller.abort(new BrowserFailure("NAVIGATION_CHANGED", "页面已切换，本次读取已停止。"));
        }
        void contents.loadURL(url, { httpReferrer: referrer }).catch(() => {
          // Superseded navigations reject too; only report an idle, failed navigation.
          if (!win.isDestroyed() && !contents.isDestroyed() && !contents.isLoading() && contents.getURL() === url && !this.active) {
            win.setTitle("Mozi 浏览器 · 链接加载失败，可刷新重试");
          }
        });
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", event => {
      if (!isBrowserUrl(event.url)) { event.preventDefault(); return; }
      const task = this.active;
      if (task && !task.resume && !task.interactionDispatched && task.stage !== "loading" && !this.isSearchPage(task, event.url)) {
        task.controller.abort(new BrowserFailure("NAVIGATION_CHANGED", "页面已切换，本次读取已停止。"));
      }
    });
    contents.on("will-redirect", event => {
      if (!isBrowserUrl(event.url)) {
        event.preventDefault();
        this.active?.controller.abort(new BrowserFailure("LOAD_FAILED", "网页跳转到不支持的地址。"));
      }
    });
    contents.on("did-start-navigation", event => { if (event.isMainFrame) { this.navigation++; this.responseStatus = undefined; this.inspected = undefined; } });
    contents.on("did-navigate", (_event, _url, status) => { this.responseStatus = status; });
    contents.on("render-process-gone", () => this.cancelAll(new BrowserFailure("LOAD_FAILED", "浏览器页面进程已退出，请重试。")));
    win.on("close", () => { this.closing = true; this.cancelAll(new BrowserFailure("WINDOW_CLOSED", "用户关闭了 Mozi 浏览器。")); });
    win.on("closed", () => {
      if (this.window !== win) return;
      this.window = undefined;
      this.inspected = undefined;
      this.closing = false;
      this.cancelAll(new BrowserFailure("WINDOW_CLOSED", "用户关闭了 Mozi 浏览器。"));
    });
    const manual = (action: () => void) => {
      if (this.active && !this.active.resume) this.cancel(this.active.context.requestId);
      action();
    };
    win.setMenu(Menu.buildFromTemplate([{ label: "Mozi 浏览器", submenu: [
      { label: "后退", accelerator: "Alt+Left", click: () => manual(() => { if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); }) },
      { label: "前进", accelerator: "Alt+Right", click: () => manual(() => { if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); }) },
      { label: "刷新", accelerator: "CmdOrCtrl+R", click: () => manual(() => contents.reload()) },
      { type: "separator" },
      { label: "停止任务", accelerator: "Escape", click: () => { this.cancelAll(new BrowserFailure("CANCELLED", "用户停止了浏览器任务。")); contents.stop(); } },
      { label: "继续读取（完成验证后）", accelerator: "CmdOrCtrl+Enter", click: () => this.active?.resume?.() },
      { type: "separator" }, { role: "copy", label: "复制" }, { role: "selectAll", label: "全选" },
      { label: "关闭", accelerator: "CmdOrCtrl+W", click: () => win.close() },
    ] }]));
    return win;
  }

  private isSearchPage(task: Task, url: string): boolean {
    if (task.operation.action !== "search" || !isBrowserUrl(url)) return false;
    const parsed = new URL(url);
    return /(^|\.)bing\.com$/.test(parsed.hostname) && parsed.pathname === "/search" && parsed.searchParams.get("q") === task.operation.query;
  }

  /** Await a host operation without allowing cancellation to strand the task queue. */
  private wait<T>(task: Task, work: Promise<T>): Promise<T> {
    const signal = task.controller.signal;
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      work.then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(signal.reason); else resolve(value); },
        error => { signal.removeEventListener("abort", abort); reject(signal.aborted ? signal.reason : error); });
      if (signal.aborted) { signal.removeEventListener("abort", abort); reject(signal.reason); }
    });
  }
  private pause(task: Task, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = task.controller.signal;
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
    });
  }
  private async waitForUser(task: Task): Promise<void> {
    let resume!: () => void;
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    task.resume = resume;
    try {
      this.progress(task, "waiting_user", "页面需要验证或登录；处理后选择菜单“继续读取”，也可停止任务。");
      await this.wait(task, resumed);
    } finally { task.resume = undefined; }
  }
  private async snapshot(task: Task, contents: WebContents): Promise<Page> {
    const navigation = this.navigation;
    const before = contents.getURL();
    const source = `(${extractPage.toString()})(${JSON.stringify(task.operation.action === "search" ? "search" : "read")}, ${task.operation.action === "search" ? task.operation.limit ?? 5 : 5}, ${BROWSER_MAX_TEXT})`;
    const page: Page = await this.wait(task, contents.executeJavaScriptInIsolatedWorld(1001, [{ code: source }]));
    if (navigation !== this.navigation || before !== contents.getURL() || page.url !== contents.getURL()) {
      throw new BrowserFailure("NAVIGATION_CHANGED", "提取期间页面发生变化，请重新读取目标网址。");
    }
    return page;
  }
  private async settledPage(task: Task, contents: WebContents): Promise<{ url: string; navigation: number }> {
    while (contents.isLoadingMainFrame()) await this.pause(task, 100);
    task.controller.signal.throwIfAborted();
    const url = contents.getURL();
    if (!isBrowserUrl(url)) throw new BrowserFailure("UNAVAILABLE", "Mozi 浏览器没有可读取的当前网页，请先打开网页或搜索。");
    return { url, navigation: this.navigation };
  }
  private async interact(task: Task, win: BrowserWindow): Promise<BrowserResult> {
    const operation = task.operation;
    if (operation.action === "search" || operation.action === "read") throw new BrowserFailure("INVALID_ARGUMENT", "无效页面操作。");
    const contents = win.webContents;
    this.progress(task, "loading", "正在获取当前页面状态…");
    const page = await this.settledPage(task, contents);
    const options = operation.action === "inspect" ? { filter: operation.filter }
      : operation.action === "click" || operation.action === "press" ? { expect: operation.expect } : {};
    const evaluate = (mode: ElementMode, token: string, value: string): Promise<ElementResponse> => this.wait(task,
      contents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${pageElements.toString()})(${JSON.stringify(mode)}, ${JSON.stringify(token)}, ${JSON.stringify(value)}, ${BROWSER_MAX_ELEMENTS}, ${JSON.stringify(operation.action)}, ${JSON.stringify(operation.action === "fill" ? operation.text : "")}, ${JSON.stringify(options)})` }]));
    const unchanged = () => {
      task.controller.signal.throwIfAborted();
      if (page.navigation !== this.navigation || page.url !== contents.getURL()) {
        throw new BrowserFailure("STALE_ELEMENT", "页面已经变化，请重新 inspect 后再操作。");
      }
    };
    if (operation.action === "inspect") {
      this.inspected = undefined;
      this.progress(task, "extracting", "正在查看当前页面可交互元素…");
      const token = randomUUID();
      const result = await evaluate("inspect", token, operation.query ?? "");
      unchanged();
      if (result.kind !== "inspect" || !isBrowserResult(result)) throw new BrowserFailure("EXTRACTION_FAILED", "无法提取页面元素。");
      this.inspected = { token, sessionId: task.context.sessionId, ...page };
      return result;
    }
    const inspected = this.inspected;
    if (!inspected || inspected.sessionId !== task.context.sessionId || inspected.navigation !== page.navigation || inspected.url !== page.url
      || !operation.elementId.startsWith(`${inspected.token}:`)) {
      throw new BrowserFailure("STALE_ELEMENT", "元素编号不属于当前会话和页面，请先 inspect 获取新编号。");
    }
    // Each inspected set permits one interaction attempt, including uncertain/failed outcomes.
    this.inspected = undefined;
    this.progress(task, "interacting", operation.action === "fill" ? "正在输入文本…" : operation.action === "press" ? "正在向页面发送按键…" : "正在定位并点击页面元素…");
    const perform = async (mode: ElementMode) => {
      const result = await evaluate(mode, inspected.token, operation.elementId);
      unchanged();
      if (result.kind === "error") throw new BrowserFailure(result.code, result.code === "STALE_ELEMENT"
        ? "元素已消失或内容发生变化，请重新 inspect。" : result.code === "INPUT_MISMATCH"
          ? "未提交：输入框实际内容与预期关键词不一致；占位提示不算输入。请重新 inspect、fill 正确关键词，再带 expect 提交。不要构造搜索 URL 绕过失败。" : "元素无法操作：可能被遮挡、禁用、只读、输入类型不支持或未保留输入内容。请检查页面并重新 inspect。");
      return result;
    };
    const locate = async () => {
      const result = await perform("locate");
      if (result.kind !== "point" || !Number.isFinite(result.x) || !Number.isFinite(result.y)) throw new BrowserFailure("EXTRACTION_FAILED", "无法定位元素。");
      return result;
    };
    const first = await locate();
    win.show(); win.focus(); contents.focus();
    contents.sendInputEvent({ type: "mouseMove", x: first.x, y: first.y });
    // Hover/scroll handlers may replace or cover the target. Recheck before sending input.
    await this.pause(task, 100);
    const point = await locate();
    unchanged();
    if (operation.action === "click") {
      await perform("guard");
      task.interactionDispatched = true;
      contents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
      contents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
    } else {
      await perform(operation.action === "fill" ? "select" : "focus");
      // Let focus/selection handlers run before dispatching to the focused control.
      await this.pause(task, 50);
      await perform("ready");
      unchanged();
      task.interactionDispatched = true;
      if (operation.action === "fill" && operation.text) {
        // Chromium performs the edit and emits trusted input events (including for controlled inputs).
        await this.wait(task, contents.insertText(operation.text));
      } else {
        const keyCode = operation.action === "fill" ? "Backspace" : operation.key.replace("Arrow", "");
        contents.sendInputEvent({ type: "keyDown", keyCode });
        if (keyCode === "Enter") contents.sendInputEvent({ type: "char", keyCode: "\r" });
        contents.sendInputEvent({ type: "keyUp", keyCode });
      }
      if (operation.action === "fill") {
        await this.pause(task, 100);
        await perform("verify");
      }
    }
    await this.pause(task, 400);
    const destination = await this.settledPage(task, contents);
    return { kind: operation.action, elementId: operation.elementId, dispatched: true, ...(operation.action === "fill" || options.expect ? { inputVerified: true as const } : {}), url: destination.url, title: contents.getTitle().slice(0, 1000) };
  }
  private async runTask(task: Task): Promise<BrowserResult> {
    const { operation } = task;
    task.controller.signal.throwIfAborted();
    const current = operation.action !== "search" && (operation.action !== "read" || operation.target === "current");
    const win = current ? this.window : this.ensureWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
      throw new BrowserFailure("UNAVAILABLE", "Mozi 浏览器没有可读取的当前页面，请先打开网页或搜索。");
    }
    const contents = win.webContents;
    // Reuse the window without repeatedly stealing the user's keyboard focus.
    if (!win.isVisible()) win.showInactive();
    if (operation.action !== "search" && operation.action !== "read") return this.interact(task, win);
    let currentPage: { url: string; navigation: number } | undefined;
    if (current) {
      // Resolve current state when this queued operation starts, never from model history.
      this.progress(task, "loading", "正在获取 Mozi 浏览器当前页面，等待页面加载完成…");
      currentPage = await this.settledPage(task, contents);
    } else {
      const target = operation.action === "search" ? `https://www.bing.com/search?q=${encodeURIComponent(operation.query)}` : operation.url;
      if (!target) throw new BrowserFailure("INVALID_ARGUMENT", "打开网页需要提供网址。");
      this.progress(task, "loading", operation.action === "search" ? `正在搜索：${operation.query}` : `正在打开：${target.slice(0, 300)}`);
      try { await this.wait(task, contents.loadURL(target)); }
      catch (error) {
        if (task.controller.signal.aborted) throw task.controller.signal.reason;
        throw new BrowserFailure("LOAD_FAILED", `网页加载失败：${error instanceof Error ? error.message.slice(0, 500) : "未知错误"}`);
      }
    }
    this.progress(task, "extracting", "正在读取页面内容…");
    let previous = "";
    let stable = 0;
    let deadline = Date.now() + 15_000;
    for (;;) {
      task.controller.signal.throwIfAborted();
      if (currentPage && (currentPage.navigation !== this.navigation || currentPage.url !== contents.getURL())) {
        throw new BrowserFailure("NAVIGATION_CHANGED", "读取期间当前页面发生变化，请重新读取当前页面。");
      }
      let page: Page;
      try { page = await this.snapshot(task, contents); }
      catch (error) {
        // Bing performs region/client redirects. Read only a settled page for the same query.
        task.controller.signal.throwIfAborted();
        if (!this.isSearchPage(task, contents.getURL()) || Date.now() >= deadline) throw error;
        previous = ""; stable = 0;
        await this.pause(task, 400);
        continue;
      }
      if (!isBrowserUrl(page.url)) throw new BrowserFailure("LOAD_FAILED", "网页地址不受支持。");
      if (page.blocked) {
        await this.waitForUser(task);
        // Explicit continuation after login/verification permits its resulting page.
        if (current) currentPage = await this.settledPage(task, contents);
        deadline = Date.now() + 15_000;
        previous = ""; stable = 0;
        this.progress(task, "extracting", "正在重新读取页面…");
        continue;
      }
      if (this.responseStatus !== undefined && this.responseStatus >= 400) {
        throw new BrowserFailure("LOAD_FAILED", `网页返回 HTTP ${this.responseStatus}，无法读取有效内容。`);
      }
      if (operation.action === "search" && !this.isSearchPage(task, page.url)) {
        throw new BrowserFailure("NAVIGATION_CHANGED", "搜索页面已跳转，请重新搜索或使用网页阅读工具。");
      }
      const result: BrowserResult = operation.action === "search"
        ? { kind: "search", query: operation.query, url: page.url, results: page.results }
        : { kind: "read", title: page.title, url: page.url, content: page.content, truncated: page.truncated };
      const usable = operation.action === "search" ? page.results.length > 0 || page.empty : page.content.trim().length > 0;
      const fingerprint = JSON.stringify(result);
      stable = usable && fingerprint === previous ? stable + 1 : 0;
      previous = fingerprint;
      if (usable && stable >= 2) {
        if (!isBrowserResult(result)) throw new BrowserFailure("EXTRACTION_FAILED", "提取结果无效或超过容量。");
        return result;
      }
      if (Date.now() >= deadline) throw new BrowserFailure("EXTRACTION_FAILED", "未能提取稳定的页面内容；页面可能需要登录、仍在加载或布局不受支持。");
      await this.pause(task, 400);
    }
  }
}
