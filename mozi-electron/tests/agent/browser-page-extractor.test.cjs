const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const load = require('../helpers/load-ts.cjs')();
const { extractPage } = load(path.resolve(__dirname, '../../src/main/services/browser-page-extractor.ts'));

// Minimal isolated DOM tree to exercise `extractPage.toString()` with zero external bindings.
function buildDom(spec, { url = 'https://example.com/doc', title = 'Doc Title', contentType = 'text/html', innerWidth = 1280 } = {}) {
  function makeNode(item, parent = null) {
    if (typeof item === 'string') {
      return { nodeType: 3, nodeValue: item, textContent: item, parentElement: parent };
    }
    const tag = (item.tag || 'div').toUpperCase();
    const attrs = new Map(Object.entries(item.attrs || {}));
    const style = {
      display: item.display || 'block',
      visibility: item.visibility || 'visible',
      opacity: item.opacity ?? '1',
      position: item.position || 'static',
      overflow: item.overflow || 'visible',
      ...(item.style || {}),
    };
    const rect = item.rect || { left: 20, top: 20, right: 900, bottom: 400, width: 880, height: 380 };
    const el = {
      _style: style,
      nodeType: 1,
      tagName: tag,
      id: attrs.get('id') || '',
      className: attrs.get('class') || '',
      parentElement: parent,
      childNodes: [],
      children: [],
      shadowRoot: null,
      hasAttribute: name => attrs.has(name),
      getAttribute: name => attrs.has(name) ? String(attrs.get(name)) : null,
      checkVisibility: item.checkVisibility ?? (() =>
        style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0),
      getBoundingClientRect: () => rect,
      getClientRects: () => style.display === 'none' || style.display === 'contents' ? [] : [rect],
      contains(target) {
        for (let cur = target; cur; cur = cur.parentElement) {
          if (cur === el) return true;
        }
        return false;
      },
      closest(selector) {
        const parts = selector.split(',').map(s => s.trim());
        for (let cur = el; cur; cur = cur.parentElement) {
          if (parts.some(p => matchesSimple(cur, p))) return cur;
        }
        return null;
      },
      querySelectorAll(selector) {
        const parts = selector.split(',').map(s => s.trim());
        const found = [];
        function walk(node) {
          for (const child of node.children) {
            if (parts.some(p => matchesSimple(child, p))) found.push(child);
            walk(child);
          }
        }
        walk(el);
        return found;
      },
      querySelector(selector) {
        return el.querySelectorAll(selector)[0] || null;
      },
    };
    el.childNodes = (item.children || []).map(c => makeNode(c, el));
    el.children = el.childNodes.filter(c => c.nodeType === 1);
    Object.defineProperty(el, 'textContent', {
      get: () => el.childNodes.map(c => c.textContent).join(''),
    });
    Object.defineProperty(el, 'innerText', {
      get: () => style.display === 'none' ? '' : el.textContent,
    });
    return el;
  }

  function matchesSimple(el, sel) {
    if (sel.startsWith('.')) return el.className.split(/\s+/).includes(sel.slice(1));
    if (sel.startsWith('#')) return el.id === sel.slice(1);
    const attrMatch = sel.match(/^([a-z0-9]*)\[([a-z-]+)(?:="([^"]*)")?\]$/i);
    if (attrMatch) {
      const [, t, attr, val] = attrMatch;
      if (t && el.tagName !== t.toUpperCase()) return false;
      if (!el.hasAttribute(attr)) return false;
      return val === undefined || el.getAttribute(attr) === val;
    }
    return el.tagName === sel.toUpperCase();
  }

  const body = makeNode({ tag: 'body', ...(spec || {}) }, null);
  const allOrder = [];
  (function indexOrder(n) {
    if (n.nodeType === 1) {
      allOrder.push(n);
      n.children.forEach(indexOrder);
    }
  })(body);
  for (const node of allOrder) {
    node.compareDocumentPosition = other => {
      const a = allOrder.indexOf(node);
      const b = allOrder.indexOf(other);
      if (a < 0 || b < 0 || a === b) return 0;
      return a < b ? 4 : 2;
    };
  }

  const document = {
    title,
    contentType,
    body,
    querySelectorAll: sel => body.querySelectorAll(sel),
    querySelector: sel => body.querySelector(sel),
  };

  return vm.runInNewContext(
    `(${extractPage.toString()})("read", 5, 24000, 0)`,
    {
      document,
      location: { href: url },
      innerWidth,
      scrollX: 0,
      scrollY: 0,
      getComputedStyle: el => el._style || { display: 'block', visibility: 'visible', opacity: '1', position: 'static', overflow: 'visible' },
      URL,
      Uint8Array,
      TextDecoder,
    },
  );
}

test('serialized extractPage runs in an isolated VM and converts headings, tables, code, lists and time without URL bloat', () => {
  const res = buildDom({
    children: [
      { tag: 'nav', children: [{ tag: 'a', attrs: { href: '/home' }, children: ['Top Nav'] }] },
      {
        tag: 'article',
        children: [
          {
            tag: 'header',
            children: [
              { tag: 'h1', children: [{ tag: 'a', attrs: { href: '#intro' }, children: ['#'] }, ' Architecture Guide'] },
              { tag: 'time', attrs: { datetime: '2026-11-10T09:00:00Z' }, children: ['2 days ago'] },
            ],
          },
          {
            tag: 'p',
            children: [
              'Read the ',
              { tag: 'a', attrs: { href: 'https://example.com/very/long/tracking?utm=123456789' }, children: ['official specification'] },
              ' using ',
              { tag: 'code', children: ['mozi_browser'] },
              '.',
            ],
          },
          {
            tag: 'blockquote',
            children: [{ tag: 'p', children: ['Note: isolated world never executes model scripts.'] }],
          },
          {
            tag: 'pre',
            attrs: { class: 'language-python' },
            children: [{ tag: 'code', children: ['def greet():\n    if True:\n        return "ok"\n'] }],
          },
          {
            tag: 'table',
            children: [
              {
                tag: 'tr',
                children: [
                  { tag: 'th', children: ['Metric'] },
                  { tag: 'th', children: ['2026 Value'] },
                ],
              },
              {
                tag: 'tr',
                children: [
                  { tag: 'td', children: ['Latency'] },
                  { tag: 'td', children: ['4ms'] },
                ],
              },
            ],
          },
        ],
      },
      { tag: 'footer', children: ['Site copyright'] },
    ],
  });

  assert.match(res.content, /^# Architecture Guide\n\n2 days ago \(2026-11-10\)/);
  assert.match(res.content, /Read the official specification using `mozi_browser`\./);
  assert.doesNotMatch(res.content, /utm=123456789/);
  assert.doesNotMatch(res.content, /Top Nav|Site copyright/);
  assert.match(res.content, /> Note: isolated world never executes model scripts\./);
  assert.match(res.content, /```python\ndef greet\(\):\n    if True:\n        return "ok"\n```/);
  assert.match(res.content, /\| Metric \| 2026 Value \|\n\| --- \| --- \|\n\| Latency \| 4ms \|/);
});

test('peels single README article away from noisy repository file-tree shell inside <main>', () => {
  const res = buildDom({
    children: [
      {
        tag: 'main',
        children: [
          { tag: 'h1', children: ['storytold / wordcraft'] },
          {
            tag: 'div',
            attrs: { class: 'file-tree' },
            children: [
              { tag: 'span', children: ['94'] },
              { tag: 'span', children: ['Branches'] },
              { tag: 'p', children: ['.cargo .github Cargo.toml src/main.rs last commit yesterday'] },
            ],
          },
          {
            tag: 'article',
            attrs: { class: 'markdown-body' },
            children: [
              { tag: 'h2', children: ['Overview'] },
              { tag: 'p', children: ['WordCraft is a fast clean-room word processor written in pure Rust. '.repeat(5)] },
            ],
          },
        ],
      },
    ],
  });

  assert.match(res.content, /^# storytold \/ wordcraft/);
  assert.match(res.content, /## Overview/);
  assert.doesNotMatch(res.content, /Cargo\.toml|Branches/);
});

test('aggregates multiple substantive <article> posts in Q&A / issue threads instead of keeping only the longest one', () => {
  const res = buildDom({
    children: [
      {
        tag: 'main',
        children: [
          { tag: 'h1', children: ['Issue #42: Memory leak on reconnect'] },
          {
            tag: 'article',
            children: [{ tag: 'p', children: ['Question post describing the original reproduction steps in detail. '.repeat(3)] }],
          },
          {
            tag: 'article',
            children: [{ tag: 'p', children: ['First answer explaining the root cause in event listener cleanup and proposing a concrete patch. '.repeat(4)] }],
          },
          {
            tag: 'article',
            children: [{ tag: 'p', children: ['Second answer confirming the fix works on Linux Wayland and Windows 11 builds. '.repeat(2)] }],
          },
        ],
      },
    ],
  });

  assert.match(res.content, /# Issue #42: Memory leak on reconnect/);
  assert.match(res.content, /Question post describing/);
  assert.match(res.content, /First answer explaining/);
  assert.match(res.content, /Second answer confirming/);
  assert.match(res.content, /\n\n---\n\n/);
});

test('preserves body wrapped inside top-level <form> and detects PDF / plain JSON documents immediately', () => {
  const formWrapped = buildDom({
    children: [
      {
        tag: 'form',
        attrs: { id: 'aspnetForm' },
        children: [
          { tag: 'input', attrs: { value: 'hidden-control' }, children: ['control'] },
          { tag: 'h1', children: ['Official Notice'] },
          { tag: 'p', children: ['Full announcement body inside a legacy top-level form wrapper. '.repeat(8)] },
        ],
      },
    ],
  });
  assert.match(formWrapped.content, /# Official Notice/);
  assert.match(formWrapped.content, /Full announcement body/);

  const pdf = buildDom({}, { contentType: 'application/pdf' });
  assert.equal(pdf.unsupportedType, 'pdf');

  const jsonDoc = buildDom({ children: ['{"status":"ok","items":[1,2,3]}'] }, { contentType: 'application/json' });
  assert.equal(jsonDoc.unsupportedType, undefined);
  assert.equal(jsonDoc.content, '{"status":"ok","items":[1,2,3]}');
});

test('preserves main header, warning aside, inert and aria-hidden visible text', () => {
  const res = buildDom({ children: [{ tag: 'main', children: [
    { tag: 'header', children: [{ tag: 'h1', children: ['Important title'] }] },
    { tag: 'aside', children: ['Enterprise only restriction'] },
    { tag: 'p', attrs: { inert: '', 'aria-hidden': 'true' }, children: ['Visible inert content '.repeat(20)] },
  ] }] });
  assert.match(res.content, /Important title/);
  assert.match(res.content, /Enterprise only restriction/);
  assert.match(res.content, /Visible inert content/);
});

test('keeps long non-article question and short answers in a discussion', () => {
  const res = buildDom({ children: [{ tag: 'main', children: [
    { tag: 'div', children: ['Main question '.repeat(200)] },
    { tag: 'article', children: ['Long answer '.repeat(20)] },
    { tag: 'article', children: ['Fixed in v2.3 only.'] },
  ] }] });
  assert.match(res.content, /Main question/);
  assert.match(res.content, /Fixed in v2.3 only/);
});

test('single 200-character answer cannot discard a much longer question', () => {
  const res = buildDom({ children: [{ tag: 'main', children: [
    { tag: 'p', children: ['Question evidence '.repeat(200)] },
    { tag: 'article', children: ['Answer evidence '.repeat(20)] },
  ] }] });
  assert.match(res.content, /Question evidence/);
  assert.match(res.content, /Answer evidence/);
});

test('code preserves blank lines and uses a fence longer than embedded backticks', () => {
  const code = 'a\n\n\n\n    b\n````\nend\n';
  const res = buildDom({ children: [{ tag: 'pre', children: [code] }] });
  assert.ok(res.content.includes(code));
  assert.ok(res.content.startsWith('`````\n'));
});

test('merged tables expose span relationships rather than inventing column alignment', () => {
  const res = buildDom({ children: [{ tag: 'table', children: [
    { tag: 'tr', children: [{ tag: 'td', attrs: { rowspan: '2' }, children: ['Product A'] }, { tag: 'td', children: ['Basic'] }] },
    { tag: 'tr', children: [{ tag: 'td', children: ['Professional'] }] },
  ] }] });
  assert.match(res.content, /rowspan=2/);
  assert.match(res.content, /Professional/);
  assert.ok(res.warnings.includes('complex_table_linearized'));
});

test('visibility-hidden wrapper traverses explicitly visible descendants', () => {
  const res = buildDom({ children: [{ tag: 'div', visibility: 'hidden', children: [
    'Invisible parent text', { tag: 'p', visibility: 'visible', children: ['Visible descendant'] },
  ] }] });
  assert.doesNotMatch(res.content, /Invisible parent text/);
  assert.match(res.content, /Visible descendant/);
});

test('display contents and auto-skipped layout do not discard DOM text', () => {
  const res = buildDom({ children: [{ tag: 'div', display: 'contents', checkVisibility: () => false, children: [
    { tag: 'p', style: { contentVisibility: 'auto' }, checkVisibility: () => false, children: ['Offscreen loaded evidence'] },
  ] }] });
  assert.match(res.content, /Offscreen loaded evidence/);
});

test('attribute-aware decoration filtering preserves substantial locked body content', () => {
  const res = buildDom({ children: [{ tag: 'main', attrs: { inert: '' }, children: [
    { tag: 'span', attrs: { 'aria-hidden': 'true', class: 'icon' }, children: ['ICON_NOISE'] },
    { tag: 'span', attrs: { 'aria-hidden': 'true', class: 'line-number' }, children: ['LINE_NOISE'] },
    { tag: 'div', attrs: { 'aria-hidden': 'true', class: 'icon' }, children: [{ tag: 'p', children: ['Substantial visible paragraph '.repeat(20)] }] },
  ] }] });
  assert.doesNotMatch(res.content, /ICON_NOISE|LINE_NOISE/);
  assert.match(res.content, /Substantial visible paragraph/);
  assert.equal(res.fullContent, res.content);
});
