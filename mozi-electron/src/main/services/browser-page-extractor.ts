export type ExtractedPage = {
  url: string;
  title: string;
  content: string;
  truncated: boolean;
  totalLength: number;
  warnings?: string[];
  /** Host-only; never forwarded to model output. Bounded to two million UTF-16 units. */
  fullContent?: string;
  unsupportedType?: "pdf" | "binary";
  empty: boolean;
  results: { title: string; url: string; snippet: string }[];
};

/**
 * Runs inside Electron's Isolated World (1001) via `extractPage.toString()`.
 * Keep all helpers inside `extractPage` with zero module-level runtime dependencies,
 * and never mutate the live page DOM observed by the user.
 */
export function extractPage(
  kind: "search" | "read",
  limit: number,
  maxText: number,
  offset = 0,
): ExtractedPage {
  const collapseInline = (s: string) =>
    s.replace(/\u00a0/g, " ").replace(/[ \t\r\n\f\v]+/g, " ");
  const tidyTitle = (s: string) => collapseInline(s).trim().slice(0, 1000);

  const safeSlice = (text: string, start: number, length: number): string => {
    let end = Math.min(text.length, start + length);
    const last = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    return text.slice(start, end);
  };

  const url = location.href;
  const title = tidyTitle(document.title ?? "");
  const results: ExtractedPage["results"] = [];

  const win = globalThis as unknown as Window;
  const viewportW =
    typeof win.innerWidth === "number" && win.innerWidth > 0
      ? win.innerWidth
      : 1200;

  const warnings = new Set<string>();
  const started = Date.now();
  let visits = 0;
  const budget = (depth = 0): boolean => {
    if (depth > 200 || ++visits > 200_000 || Date.now() - started > 2000) {
      warnings.add("extraction_budget_exceeded");
      return false;
    }
    return true;
  };
  const styleCache = new WeakMap<Element, CSSStyleDeclaration>();
  const styleOf = (el: Element) => {
    let value = styleCache.get(el);
    if (!value && typeof getComputedStyle === "function") {
      value = getComputedStyle(el);
      styleCache.set(el, value);
    }
    return value;
  };
  // Subtree exclusion is deliberately different from element/interaction visibility.
  // visibility:hidden may have visible descendants; display:contents has no box.
  const visibilityCache = new WeakMap<Element, boolean>();
  const isVisible = (el: Element): boolean => {
    const cached = visibilityCache.get(el);
    if (cached !== undefined) return cached;
    const style = styleOf(el);
    const visible = !(style?.display === "none" ||
      style?.contentVisibility === "hidden" ||
      (style?.opacity !== undefined && style.opacity !== "" && Number(style.opacity) === 0));
    visibilityCache.set(el, visible);
    return visible;
  };
  const textVisible = (el: Element): boolean => {
    const style = styleOf(el);
    return style?.visibility !== "hidden" && style?.visibility !== "collapse";
  };

  if (kind === "search") {
    const tidySearch = (s: string) =>
      s
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    const bodyText = document.body?.innerText ?? "";
    for (const item of document.querySelectorAll("#b_results .b_algo")) {
      if (!isVisible(item) || !textVisible(item)) continue;
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
        const heading = tidySearch(link.innerText).slice(0, 1000);
        if (
          !heading ||
          target.href.length > 4096 ||
          !["http:", "https:"].includes(target.protocol) ||
          target.username ||
          target.password ||
          results.some((r) => r.url === target.href)
        ) {
          continue;
        }
        results.push({
          title: heading,
          url: target.href,
          snippet: tidySearch(
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
      totalLength: 0,
      empty,
      results,
    };
  }

  // Fast-path non-HTML MIME types before DOM distillation.
  const contentType = (document.contentType ?? "").toLowerCase();
  const hasPdfPlugin =
    !!document.querySelector?.(
      'embed[type="application/pdf"], object[type="application/pdf"]',
    );
  if (
    contentType === "application/pdf" ||
    (hasPdfPlugin && !(document.body?.innerText ?? "").trim())
  ) {
    return {
      url,
      title: title || "PDF",
      content: "",
      truncated: false,
      totalLength: 0,
      unsupportedType: "pdf",
      empty: false,
      results,
    };
  }
  if (
    /^(?:image|audio|video)\/|^application\/octet-stream\b/.test(contentType)
  ) {
    return {
      url,
      title: title || "Binary",
      content: "",
      truncated: false,
      totalLength: 0,
      unsupportedType: "binary",
      empty: false,
      results,
    };
  }
  if (
    /^text\/(?:plain|markdown|csv|tab-separated-values|xml)\b|^application\/(?:json|xml)\b/.test(
      contentType,
    )
  ) {
    const raw = (document.body?.innerText ?? document.body?.textContent ?? "")
      .replace(/\r\n?/g, "\n")
      .trim();
    const start = Math.max(0, offset);
    return {
      url,
      title: title || url.slice(0, 1000),
      fullContent: raw.length <= 2_000_000 ? raw : undefined,
      content: safeSlice(raw, start, maxText),
      truncated: start + maxText < raw.length,
      totalLength: raw.length,
      empty: false,
      results,
    };
  }

  if (!document.body) {
    return {
      url,
      title,
      content: "",
      truncated: false,
      totalLength: 0,
      empty: false,
      results,
    };
  }

  if (document.querySelector("iframe, canvas, svg, object, embed")) warnings.add("embedded_content_not_extracted");

  const ALWAYS_SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "CANVAS",
    "IFRAME",
    "OBJECT",
    "EMBED",
    "AUDIO",
    "VIDEO",
    "SOURCE",
    "TRACK",
    "MAP",
    "AREA",
    "BUTTON",
    "INPUT",
    "SELECT",
    "OPTION",
    "TEXTAREA",
  ]);

  const SHELL_ROLES = new Set([
    "navigation",
    "search",
    "menubar",
    "toolbar",
  ]);

  const BLOCK_COUNT_TAGS = new Set([
    "P",
    "PRE",
    "TABLE",
    "BLOCKQUOTE",
    "LI",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "DT",
    "DD",
  ]);

  const childNodesOf = (node: Node): Node[] => {
    if (node.nodeType === 1) {
      const el = node as HTMLElement;
      if (el.tagName === "SLOT" && typeof (el as HTMLSlotElement).assignedNodes === "function") {
        const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
        if (assigned.length > 0) return [...assigned];
      }
      if (el.shadowRoot) return [...el.shadowRoot.childNodes];
    }
    return [...node.childNodes];
  };

  const isInsideArticle = (el: Element): boolean =>
    !!el.closest?.('article, main, [role="main"], [itemprop="articleBody"], .markdown-body, #js_content');

  type CleanStats = { textLen: number; linkTextLen: number; blockCount: number };
  const statsCache = new WeakMap<Element, CleanStats>();

  const isBaseNoise = (el: Element): boolean => {
    const tag = el.tagName?.toUpperCase() ?? "";
    if (ALWAYS_SKIP_TAGS.has(tag)) return true;
    // Accessibility exclusion is evidence, not a blanket subtree deletion rule.
    // Only known small decorative wrappers are removed; text-rich locked backgrounds survive.
    if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("inert")) {
      const identity = `${el.id ?? ""} ${typeof el.className === "string" ? el.className : ""}`;
      const decorative = /(?:^|[-_\s])(?:icon|icons|gutter|line-number|line-numbers|linenumber|hljs-ln-numbers|blob-num)(?:$|[-_\s])/i.test(identity);
      const hasContent = !!el.querySelector("p, pre, table, article, main, h1, h2, h3");
      if (decorative && !hasContent && (el.textContent ?? "").trim().length <= 80) return true;
    }
    if (tag === "DIALOG" && !el.hasAttribute("open")) return true;
    if ((tag === "NAV" || tag === "MENU") && !isInsideArticle(el)) return true;
    const role = (el.getAttribute?.("role") ?? "").toLowerCase();
    if (SHELL_ROLES.has(role)) return true;
    if ((tag === "HEADER" || tag === "FOOTER") && !isInsideArticle(el)) {
      return true;
    }

    return false;
  };

  const measureStats = (root: Element, depth = 0): CleanStats => {
    const cached = statsCache.get(root);
    if (cached) return cached;
    const stats = { textLen: 0, linkTextLen: 0, blockCount: 0 };
    if (!budget(depth) || !isVisible(root) || isBaseNoise(root)) return stats;
    if (BLOCK_COUNT_TAGS.has(root.tagName)) stats.blockCount++;
    for (const child of childNodesOf(root)) {
      if (child.nodeType === 3 && textVisible(root)) {
        stats.textLen += collapseInline(child.nodeValue ?? "").trim().length;
      } else if (child.nodeType === 1) {
        const sub = measureStats(child as Element, depth + 1);
        stats.textLen += sub.textLen;
        stats.linkTextLen += sub.linkTextLen;
        stats.blockCount += sub.blockCount;
      }
    }
    if (root.tagName === "A") stats.linkTextLen = stats.textLen;
    statsCache.set(root, stats);
    return stats;
  };

  const isSkippableForm = (formEl: Element, activeRoot: Element): boolean => {
    if (formEl === activeRoot || formEl.contains(activeRoot)) return false;
    if (
      formEl.querySelector?.(
        'article, main, [role="main"], [itemprop="articleBody"], .markdown-body',
      )
    ) {
      return false;
    }
    const stats = measureStats(formEl);
    return stats.textLen < 300;
  };

  const isShellAncestor = (el: Element): boolean =>
    !!el.closest?.(
      'nav, [role="navigation"], [role="banner"], [role="contentinfo"]',
    );

  const findPrecedingMainHeading = (selected: Element[]): Element | undefined => {
    if (
      selected.some(
        (el) =>
          el.tagName?.toUpperCase() === "H1" || !!el.querySelector?.("h1"),
      )
    ) {
      return undefined;
    }
    const first = selected[0];
    if (!first || typeof document.querySelectorAll !== "function") return undefined;
    for (const h1 of document.querySelectorAll("h1")) {
      if (!isVisible(h1) || isShellAncestor(h1)) continue;
      if (selected.some((root) => root.contains(h1))) return undefined;
      if (
        typeof h1.compareDocumentPosition === "function" &&
        !(h1.compareDocumentPosition(first) & 4)
      ) {
        continue;
      }
      const stats = measureStats(h1);
      if (stats.textLen > 0) return h1;
    }
    return undefined;
  };

  const withOptionalHeading = (roots: Element[]): Element[] => {
    const h1 = findPrecedingMainHeading(roots);
    return h1 ? [h1, ...roots] : roots;
  };

  // Three-tier content root selection:
  // 1) Explicit article / markdown-body units (single article peel OR multi-article thread aggregation)
  // 2) Semantic <main> / [role="main"]
  // 3) Chromium geometry + link-density scoring fallback for div-soup pages
  const selectRoots = (): Element[] => {
    const body = document.body;
    const bodyStats = measureStats(body);
    if (bodyStats.textLen === 0) return [body];

    const mains = [...document.querySelectorAll('main, [role="main"]')]
      .filter((el) => isVisible(el) && measureStats(el).textLen > 0)
      .sort((a, b) => measureStats(b).textLen - measureStats(a).textLen);
    const primaryMain = mains[0];
    const mainLen = primaryMain ? measureStats(primaryMain).textLen : 0;

    const rawUnits = [
      ...document.querySelectorAll(
        'article, [itemprop="articleBody"], .markdown-body, #js_content',
      ),
    ].filter((el) => isVisible(el) && !isShellAncestor(el));
    const topUnits = rawUnits.filter(
      (u) => !rawUnits.some((other) => other !== u && other.contains(u)),
    );
    const nonEmptyUnits = topUnits.filter((u) => measureStats(u).textLen > 0);

    if (nonEmptyUnits.length === 1) {
      const unit = nonEmptyUnits[0];
      const uLen = measureStats(unit).textLen;
      const baseline = mainLen > 0 ? mainLen : bodyStats.textLen;
      if (uLen >= baseline * 0.5 || baseline - uLen < 180) {
        return withOptionalHeading([unit]);
      }
    } else if (nonEmptyUnits.length > 1) {
      const substantive = nonEmptyUnits.filter((u) => {
        const s = measureStats(u);
        const linkRatio = s.textLen > 0 ? s.linkTextLen / s.textLen : 1;
        return (
          (s.textLen > 0 && linkRatio <= 0.55) ||
          (bodyStats.textLen < 300 && s.textLen >= 20)
        );
      });
      if (substantive.length >= 1) {
        const sumLen = substantive.reduce(
          (acc, u) => acc + measureStats(u).textLen,
          0,
        );
        // If an enclosing <main> has substantial non-article lead content (e.g. Q&A question in a <div>), keep <main>.
        if (primaryMain && (substantive.some((u) => !primaryMain.contains(u)) || mainLen - sumLen >= 180)) {
          return withOptionalHeading([primaryMain]);
        }
        return withOptionalHeading(substantive);
      }
    }

    if (primaryMain) {
      if (mainLen >= 80 || mainLen >= bodyStats.textLen * 0.5) {
        return withOptionalHeading([primaryMain]);
      }
    }

    if (bodyStats.textLen < 350) return [body];

    let bestNode: Element | undefined;
    let bestScore = 0;
    const PositiveHint =
      /(?:^|[-_\s])(?:article|content|post|entry|markdown|main|detail|story|doc|body|text)(?:$|[-_\s])/i;
    const NegativeHint =
      /(?:^|[-_\s])(?:sidebar|side|comment-form|footer|nav|menu|recommend|related|promo|banner|breadcrumb)(?:$|[-_\s])/i;

    for (const candidate of body.querySelectorAll("div, section, td")) {
      if (!isVisible(candidate) || isBaseNoise(candidate) || isShellAncestor(candidate)) {
        continue;
      }
      if (typeof candidate.getBoundingClientRect === "function") {
        const rect = candidate.getBoundingClientRect();
        if (rect.width > 0 && rect.width < Math.min(260, viewportW * 0.3)) {
          continue;
        }
      }
      const s = measureStats(candidate);
      if (s.textLen < Math.min(200, bodyStats.textLen * 0.35)) continue;
      const linkRatio = s.linkTextLen / s.textLen;
      if (linkRatio > 0.5) continue;

      const nonLinkChars = s.textLen - s.linkTextLen;
      let score =
        nonLinkChars * (1 - linkRatio * 1.1) +
        Math.min(s.blockCount, 25) * 30 -
        s.linkTextLen * 1.2;

      const identity = `${candidate.id ?? ""} ${typeof candidate.className === "string" ? candidate.className : ""}`;
      if (PositiveHint.test(identity)) score *= 1.2;
      if (NegativeHint.test(identity)) score *= 0.35;

      if (score > bestScore) {
        bestScore = score;
        bestNode = candidate;
      }
    }

    return bestNode ? withOptionalHeading([bestNode]) : [body];
  };

  // Streaming read-only DOM -> clean lightweight Markdown serializer.
  const isOpenPunct = (ch: string) => /[([{"'“‘（【《「『]/.test(ch);
  const isClosePunct = (ch: string) =>
    /[.,;:!?)\]}"'”’）】》，。；：！？、·—…]/.test(ch);

  const joinFragments = (
    left: string,
    right: string,
    forceSeparate = false,
  ): string => {
    if (!left) return right;
    if (!right) return left;
    const last = left[left.length - 1];
    const first = right[0];
    if (/\s/.test(last) || /\s/.test(first)) {
      if (last === " " && first === " ") return left + right.slice(1);
      return left + right;
    }
    if (isOpenPunct(last) || isClosePunct(first)) return left + right;
    if (forceSeparate) {
      return `${left} ${right}`;
    }
    return left + right;
  };

  const INLINE_FORMATTING_TAGS = new Set([
    "B",
    "STRONG",
    "I",
    "EM",
    "U",
    "S",
    "DEL",
    "INS",
    "MARK",
    "SMALL",
    "SUB",
    "SUP",
    "ABBR",
    "CITE",
    "DFN",
    "KBD",
    "SAMP",
    "VAR",
    "Q",
  ]);

  const BLOCK_TAGS = new Set([
    "ADDRESS",
    "ARTICLE",
    "ASIDE",
    "BLOCKQUOTE",
    "BODY",
    "DETAILS",
    "DIALOG",
    "DD",
    "DIV",
    "DL",
    "DT",
    "FIELDSET",
    "FIGCAPTION",
    "FIGURE",
    "FOOTER",
    "FORM",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HEADER",
    "HGROUP",
    "HR",
    "HTML",
    "LI",
    "MAIN",
    "NAV",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "SUMMARY",
    "TABLE",
    "TR",
    "UL",
  ]);

  const detectCodeLang = (pre: Element): string => {
    const candidates = [pre, pre.querySelector?.("code")].filter(
      Boolean,
    ) as Element[];
    for (const el of candidates) {
      const explicit =
        el.getAttribute?.("data-lang") ?? el.getAttribute?.("data-language");
      if (explicit && /^[a-z0-9_+#.-]{1,24}$/i.test(explicit.trim())) {
        return explicit.trim().toLowerCase();
      }
      const cls = typeof el.className === "string" ? el.className : "";
      const match = cls.match(
        /(?:^|\s)(?:language-|lang-|highlight-source-)([a-z0-9_+#.-]{1,24})(?=$|\s)/i,
      );
      if (match) return match[1].toLowerCase();
    }
    return "";
  };

  const isLineNumberDecoration = (el: Element): boolean => {
    const cls = typeof el.className === "string" ? el.className : "";
    if (
      /(?:^|[-_\s])(?:line-number|line-numbers|linenumber|hljs-ln-numbers|blob-num|react-syntax-highlighter-line-number|gutter)(?:$|[-_\s])/i.test(
        cls,
      )
    ) {
      return true;
    }
    return false;
  };

  const extractCodeText = (root: Element): string => {
    let out = "";
    const walkCode = (node: Node, depth = 0) => {
      if (!budget(depth)) return;
      if (node.nodeType === 3) {
        if (!node.parentElement || textVisible(node.parentElement)) out += node.nodeValue ?? "";
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as Element;
      if (!isVisible(el) || isLineNumberDecoration(el)) return;
      const tag = el.tagName?.toUpperCase() ?? "";
      if (ALWAYS_SKIP_TAGS.has(tag)) return;
      if (tag === "BR") {
        out += "\n";
        return;
      }
      const beforeLen = out.length;
      for (const child of childNodesOf(el)) walkCode(child, depth + 1);
      if (
        (tag === "DIV" || tag === "P" || tag === "LI" || tag === "TR") &&
        out.length > beforeLen &&
        !out.endsWith("\n")
      ) {
        out += "\n";
      }
    };
    walkCode(root);
    return out.replace(/\r\n?/g, "\n");
  };

  const formatTimeElement = (el: Element, innerText: string): string => {
    const trimmed = innerText.trim();
    const dt = (el.getAttribute?.("datetime") ?? "").trim();
    if (!dt) return trimmed;
    const dateMatch = dt.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) return trimmed;
    const isoDate = dateMatch[1];
    const year = isoDate.slice(0, 4);
    if (!trimmed) return isoDate;
    if (trimmed.includes(year)) return trimmed;
    return `${trimmed} (${isoDate})`;
  };

  const inlineCode = (code: string): string => {
    if (!code) return "";
    const fence = "`".repeat(Math.max(1, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
    return `${fence}${pad}${code}${pad}${fence}`;
  };

  const serializeRoot = (activeRoot: Element): string => {
    const shouldSkip = (el: Element): boolean => {
      if (!isVisible(el)) return true;
      if (el === activeRoot) return false;
      if (isBaseNoise(el)) return true;
      if (el.tagName?.toUpperCase() === "FORM" && isSkippableForm(el, activeRoot)) {
        return true;
      }
      return false;
    };

    const renderInline = (
      container: Element,
      inHeading = false,
      domDepth = 0,
    ): string => {
      if (!budget(domDepth)) return "";
      let acc = "";
      let prevWasSeparateElement = false;
      for (const child of childNodesOf(container)) {
        if (child.nodeType === 3) {
          const raw = textVisible(container) ? collapseInline(child.nodeValue ?? "") : "";
          if (!raw.trim()) {
            if (raw.includes(" ") && acc && !/\s$/.test(acc)) acc += " ";
            continue;
          }
          acc = joinFragments(acc, raw, false);
          prevWasSeparateElement = false;
          continue;
        }
        if (child.nodeType !== 1) continue;
        const el = child as Element;
        if (shouldSkip(el)) continue;
        const tag = el.tagName?.toUpperCase() ?? "";
        if (tag === "BR") {
          acc = acc.replace(/[ \t]+$/, "") + "\n";
          prevWasSeparateElement = false;
          continue;
        }
        if (inHeading && tag === "A") {
          const href = el.getAttribute?.("href") ?? "";
          const anchorText = collapseInline(renderInline(el, true, domDepth + 1)).trim();
          if (href.startsWith("#") && (anchorText === "#" || anchorText === "¶" || anchorText === "§")) {
            continue;
          }
        }
        let piece = "";
        if (tag === "CODE") {
          const code = collapseInline(el.textContent ?? "").trim();
          if (code) {
            piece = inlineCode(code);
          }
        } else if (tag === "TIME") {
          piece = formatTimeElement(el, renderInline(el, inHeading, domDepth + 1));
        } else if (tag === "IMG") {
          piece = "";
        } else {
          piece = renderInline(el, inHeading, domDepth + 1);
        }
        if (!piece.trim()) continue;
        const isPureStyle = INLINE_FORMATTING_TAGS.has(tag);
        const forceSpace =
          !isPureStyle && (prevWasSeparateElement || tag === "A" || tag === "TD" || tag === "TH");
        acc = joinFragments(acc, piece, forceSpace);
        prevWasSeparateElement = !isPureStyle;
      }
      return acc;
    };

    const renderTable = (tableEl: Element, listDepth: number, domDepth = 0): string => {
      if (!budget(domDepth)) return "";
      const role = (tableEl.getAttribute?.("role") ?? "").toLowerCase();
      if (
        role === "presentation" ||
        role === "none" ||
        tableEl.querySelector?.("table, pre, article")
      ) {
        return renderBlocks(tableEl, listDepth, domDepth + 1);
      }

      if ([...tableEl.querySelectorAll("td, th")].some((cell) =>
        Number(cell.getAttribute("rowspan") ?? 1) !== 1 || Number(cell.getAttribute("colspan") ?? 1) !== 1)) {
        warnings.add("complex_table_linearized");
        const lines = [...tableEl.querySelectorAll("tr")]
          .filter((tr) => tr.closest("table") === tableEl && !shouldSkip(tr))
          .map((tr, i) => `Row ${i + 1}: ` + [...tr.children].filter((cell) => !shouldSkip(cell)).map((cell) => {
            const span = `rowspan=${cell.getAttribute("rowspan") ?? "1"}, colspan=${cell.getAttribute("colspan") ?? "1"}`;
            return `${collapseInline(renderBlocks(cell, 0, domDepth + 1)).trim()} (${span})`;
          }).join(" ; "));
        return `\n\n[Complex table: cells listed in DOM order; spans preserved]\n${lines.join("\n")}\n\n`;
      }
      const rows: { cells: string[]; hasHeader: boolean }[] = [];
      for (const tr of tableEl.querySelectorAll("tr")) {
        if (tr.closest("table") !== tableEl || shouldSkip(tr)) continue;
        const cells: string[] = [];
        let hasHeader = false;
        for (const cell of tr.children) {
          const cTag = cell.tagName?.toUpperCase() ?? "";
          if ((cTag !== "TD" && cTag !== "TH") || shouldSkip(cell)) continue;
          if (cTag === "TH") hasHeader = true;
          const cellText = collapseInline(renderBlocks(cell, 0, domDepth + 1))
            .trim()
            .replace(/\|/g, "\\|");
          cells.push(cellText);
          const colspan = Number(cell.getAttribute?.("colspan") ?? 1);
          if (Number.isInteger(colspan) && colspan > 1) {
            const extra = Math.min(colspan - 1, 8);
            for (let i = 0; i < extra; i++) cells.push("");
          }
        }
        if (cells.some((c) => c.length > 0)) {
          rows.push({ cells, hasHeader });
        }
      }

      if (rows.length === 0) return "";
      const colCount = rows.reduce((max, r) => Math.max(max, r.cells.length), 0);
      if (colCount <= 1 && !rows.some((r) => r.hasHeader)) {
        return rows.map((r) => r.cells[0] ?? "").join("\n\n");
      }

      const padRow = (cells: string[]) => {
        const padded = [...cells];
        while (padded.length < colCount) padded.push("");
        return `| ${padded.join(" | ")} |`;
      };

      if (!rows[0].hasHeader) rows.unshift({ cells: Array(colCount).fill(""), hasHeader: true });
      const lines: string[] = [
        padRow(rows[0].cells),
        `| ${Array(colCount).fill("---").join(" | ")} |`,
      ];
      for (let i = 1; i < rows.length; i++) {
        lines.push(padRow(rows[i].cells));
      }
      return `\n\n${lines.join("\n")}\n\n`;
    };

    const renderList = (listEl: Element, depth: number, domDepth = 0): string => {
      if (!budget(domDepth)) return "";
      const ordered = listEl.tagName?.toUpperCase() === "OL";
      const startAttr = Number(listEl.getAttribute?.("start") ?? 1);
      let index = Number.isInteger(startAttr) && startAttr > 0 ? startAttr : 1;
      const items: string[] = [];
      const indent = "  ".repeat(depth);

      for (const child of childNodesOf(listEl)) {
        if (child.nodeType !== 1) continue;
        const li = child as Element;
        if (shouldSkip(li)) continue;
        const tag = li.tagName?.toUpperCase() ?? "";
        if (tag !== "LI") {
          const misc = renderNode(li, depth).trim();
          if (misc) items.push(`${indent}${misc}`);
          continue;
        }
        const marker = ordered ? `${index++}. ` : "- ";
        const bodyParts: string[] = [];
        const nestedLists: string[] = [];
        let inlineBuf = "";
        let prevSeparate = false;

        const flushInline = () => {
          const clean = inlineBuf
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .join(" ");
          if (clean) bodyParts.push(clean);
          inlineBuf = "";
          prevSeparate = false;
        };

        for (const liChild of childNodesOf(li)) {
          if (liChild.nodeType === 3) {
            const raw = collapseInline(liChild.nodeValue ?? "");
            if (!raw.trim()) {
              if (raw.includes(" ") && inlineBuf && !/\s$/.test(inlineBuf)) {
                inlineBuf += " ";
              }
              continue;
            }
            inlineBuf = joinFragments(inlineBuf, raw, false);
            prevSeparate = false;
            continue;
          }
          if (liChild.nodeType !== 1) continue;
          const sub = liChild as Element;
          if (shouldSkip(sub)) continue;
          const subTag = sub.tagName?.toUpperCase() ?? "";
          if (subTag === "UL" || subTag === "OL") {
            flushInline();
            const nested = renderList(sub, depth + 1).replace(/^\n+|\n+$/g, "");
            if (nested) nestedLists.push(nested);
          } else if (subTag === "PRE" || subTag === "TABLE" || subTag === "BLOCKQUOTE") {
            flushInline();
            const block = renderNode(sub, depth + 1).trim();
            if (block) {
              nestedLists.push(
                block
                  .split("\n")
                  .map((l) => `${indent}  ${l}`)
                  .join("\n"),
              );
            }
          } else if (BLOCK_TAGS.has(subTag)) {
            flushInline();
            const text = renderBlocks(sub, depth + 1).trim();
            if (text) bodyParts.push(text.replace(/\n+/g, " "));
          } else {
            const piece =
              subTag === "CODE"
                ? (() => {
                    const c = collapseInline(sub.textContent ?? "").trim();
                    return c ? (c.includes("`") ? `\`\` ${c} \`\`` : `\`${c}\``) : "";
                  })()
                : subTag === "TIME"
                  ? formatTimeElement(sub, renderInline(sub, false))
                  : renderInline(sub, false);
            if (piece.trim()) {
              const isPure = INLINE_FORMATTING_TAGS.has(subTag);
              inlineBuf = joinFragments(
                inlineBuf,
                piece,
                !isPure && (prevSeparate || subTag === "A"),
              );
              prevSeparate = !isPure;
            }
          }
        }
        flushInline();

        const head = bodyParts.join(" ").trim();
        if (!head && nestedLists.length === 0) continue;
        const firstLine = `${indent}${marker}${head}`.trimEnd();
        items.push(
          nestedLists.length > 0
            ? `${firstLine}\n${nestedLists.join("\n")}`
            : firstLine,
        );
      }

      if (items.length === 0) return "";
      return depth === 0 ? `\n\n${items.join("\n")}\n\n` : `\n${items.join("\n")}`;
    };

    const renderNode = (el: Element, listDepth: number, domDepth = 0): string => {
      if (!budget(domDepth) || shouldSkip(el)) return "";
      const tag = el.tagName?.toUpperCase() ?? "";
      const role = (el.getAttribute?.("role") ?? "").toLowerCase();

      if (/^H[1-6]$/.test(tag) || role === "heading") {
        const level = /^H[1-6]$/.test(tag)
          ? Number(tag[1])
          : Math.min(6, Math.max(1, Number(el.getAttribute?.("aria-level") ?? 2) || 2));
        const headingText = collapseInline(renderInline(el, true, domDepth + 1)).trim();
        return headingText ? `\n\n${"#".repeat(level)} ${headingText}\n\n` : "";
      }

      if (tag === "PRE") {
        const code = extractCodeText(el);
        if (!code) return "";
        const lang = detectCodeLang(el);
        const fence = "`".repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)));
        return `\n\n${fence}${lang}\n${code}${code.endsWith("\n") ? "" : "\n"}${fence}\n\n`;
      }

      if (tag === "TABLE") {
        return renderTable(el, listDepth, domDepth + 1);
      }

      if (tag === "UL" || tag === "OL") {
        return renderList(el, listDepth, domDepth + 1);
      }

      if (tag === "BLOCKQUOTE") {
        const inner = finalizeMarkdown(renderBlocks(el, listDepth, domDepth + 1));
        if (!inner) return "";
        const quoted = inner
          .split("\n")
          .map((line) => (line ? `> ${line}` : ">"))
          .join("\n");
        return `\n\n${quoted}\n\n`;
      }

      if (tag === "HR") {
        return "\n\n---\n\n";
      }

      if (tag === "BR") {
        return "\n";
      }

      if (tag === "DT") {
        const term = collapseInline(renderInline(el, false, domDepth + 1)).trim();
        return term ? `\n\n**${term}**\n` : "";
      }

      if (tag === "DD") {
        const def = renderBlocks(el, listDepth, domDepth + 1).trim();
        return def ? `${def}\n\n` : "";
      }

      if (tag === "TR") {
        const cells: string[] = [];
        for (const child of el.children) {
          if (shouldSkip(child)) continue;
          const text = collapseInline(renderBlocks(child, listDepth, domDepth + 1)).trim();
          if (text) cells.push(text);
        }
        return cells.length > 0 ? `\n${cells.join(" | ")}\n` : "";
      }

      if (BLOCK_TAGS.has(tag)) {
        const content = renderBlocks(el, listDepth, domDepth + 1);
        if (!content.trim()) return "";
        return tag === "P" ? `\n\n${content.trim()}\n\n` : `\n${content.trim()}\n`;
      }

      if (tag === "CODE") {
        const code = collapseInline(el.textContent ?? "").trim();
        return inlineCode(code);
      }

      if (tag === "TIME") {
        return formatTimeElement(el, renderInline(el, false, domDepth + 1));
      }

      return renderInline(el, false, domDepth + 1);
    };

    const renderBlocks = (container: Element, listDepth: number, domDepth = 0): string => {
      if (!budget(domDepth)) return "";
      let out = "";
      let inlineRun = "";
      let prevSeparate = false;

      const flushInlineRun = () => {
        const cleaned = inlineRun
          .split("\n")
          .map((line) => line.replace(/[ \t]+/g, " ").trim())
          .join("\n")
          .trim();
        if (cleaned) {
          out = out ? `${out}\n${cleaned}` : cleaned;
        }
        inlineRun = "";
        prevSeparate = false;
      };

      for (const child of childNodesOf(container)) {
        if (child.nodeType === 3) {
          const raw = textVisible(container) ? collapseInline(child.nodeValue ?? "") : "";
          if (!raw.trim()) {
            if (raw.includes(" ") && inlineRun && !/\s$/.test(inlineRun)) {
              inlineRun += " ";
            }
            continue;
          }
          inlineRun = joinFragments(inlineRun, raw, false);
          prevSeparate = false;
          continue;
        }
        if (child.nodeType !== 1) continue;
        const el = child as Element;
        if (shouldSkip(el)) continue;
        const tag = el.tagName?.toUpperCase() ?? "";
        const role = (el.getAttribute?.("role") ?? "").toLowerCase();

        if (tag === "BR") {
          inlineRun = inlineRun.replace(/[ \t]+$/, "") + "\n";
          prevSeparate = false;
          continue;
        }

        if (BLOCK_TAGS.has(tag) || role === "heading") {
          flushInlineRun();
          const blockText = renderNode(el, listDepth, domDepth + 1);
          if (blockText) out += blockText;
        } else {
          const piece = renderNode(el, listDepth, domDepth + 1);
          if (piece.trim()) {
            const isPure = INLINE_FORMATTING_TAGS.has(tag);
            const forceSpace =
              !isPure && (prevSeparate || tag === "A" || tag === "TD" || tag === "TH");
            inlineRun = joinFragments(inlineRun, piece, forceSpace);
            prevSeparate = !isPure;
          }
        }
      }
      flushInlineRun();
      return out;
    };

    return renderNode(activeRoot, 0, 0);
  };

  // Normalize blank lines outside fenced code blocks while keeping code and list indentation intact.
  const finalizeMarkdown = (raw: string): string => {
    let fenceLength = 0;
    let blankCount = 0;
    const lines: string[] = [];
    for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
      const fence = line.match(/^\s*(?:>\s*)?(`{3,})(.*)$/);
      if (fenceLength) {
        lines.push(line);
        if (fence && fence[1].length >= fenceLength && !fence[2].trim()) fenceLength = 0;
        blankCount = 0;
        continue;
      }
      if (fence) { fenceLength = fence[1].length; lines.push(line); blankCount = 0; continue; }
      const cleaned = line.replace(/[ \t]+$/, "");
      blankCount = cleaned ? 0 : blankCount + 1;
      if (blankCount <= 1) lines.push(cleaned);
    }
    return lines.join("\n").trim();
  };

  const roots = selectRoots();
  const renderedParts: string[] = [];
  for (let i = 0; i < roots.length; i++) {
    const part = finalizeMarkdown(serializeRoot(roots[i]));
    if (!part) continue;
    const afterLeadingH1 =
      i === 1 &&
      renderedParts.length === 1 &&
      roots[0].tagName?.toUpperCase() === "H1";
    if (renderedParts.length > 0 && !afterLeadingH1) {
      renderedParts.push("---");
    }
    renderedParts.push(part);
  }

  let fullContent = finalizeMarkdown(renderedParts.join("\n\n"));
  // Safety fallback if custom root selection yielded nothing while body actually has visible text.
  if (!fullContent && !(roots.length === 1 && roots[0] === document.body)) {
    fullContent = finalizeMarkdown(serializeRoot(document.body));
  }

  const totalLength = fullContent.length;
  const start = Math.max(0, offset);
  const sliced = safeSlice(fullContent, start, maxText);

  return {
    url,
    title,
    fullContent: fullContent.length <= 2_000_000 ? fullContent : undefined,
    content: sliced,
    truncated: start + maxText < totalLength,
    totalLength,
    warnings: [...warnings],
    empty: false,
    results,
  };
}
