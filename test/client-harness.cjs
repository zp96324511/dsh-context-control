/* Offline harness for dsh-context-control/client.js:
 * a ~150-line mini React runtime (hooks + function components + effects),
 * stubbed gateway/locale/slots, and a fake DOM — enough to exercise the pill
 * tooltip, the popover measurement, keyboard navigation, and the multi-pane
 * case (several composer pills, as in the mixer) without a browser or a host
 * restart. */

const path = require('node:path');

/* A relative path is resolved against the caller's cwd (the package root under
 * `npm run test`), not against this file — `require()` would otherwise look for
 * test/client.js. */
const CLIENT = process.argv[2] === undefined ? undefined : path.resolve(process.cwd(), process.argv[2]);
if (!CLIENT) throw new Error('usage: node test/client-harness.cjs <path-to-client.js>');

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(`PASS  ${name}`); }
  catch (error) { results.push(`FAIL  ${name}\n      ${error && error.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

/* ---------------- mini react ---------------- */

let instances = new Map();
let current = null;

function instanceFor(key) {
  let state = instances.get(key);
  if (state === undefined) {
    state = { hooks: [], hookIndex: 0, effects: [], dirty: false };
    instances.set(key, state);
  }
  return state;
}

function useState(initial) {
  const state = current;
  const index = state.hookIndex++;
  if (!(index in state.hooks)) state.hooks[index] = initial;
  const set = (value) => {
    const next = typeof value === 'function' ? value(state.hooks[index]) : value;
    if (Object.is(next, state.hooks[index])) return;
    state.hooks[index] = next;
    state.dirty = true;
  };
  return [state.hooks[index], set];
}

function useRef(initial) {
  const state = current;
  const index = state.hookIndex++;
  if (!(index in state.hooks)) state.hooks[index] = { current: initial };
  return state.hooks[index];
}

function useEffect(fn, deps) {
  const state = current;
  const index = state.hookIndex++;
  const previous = state.hooks[index];
  const changed = previous === undefined
    || deps === undefined
    || previous.deps === undefined
    || deps.length !== previous.deps.length
    || deps.some((value, position) => !Object.is(value, previous.deps[position]));
  if (!changed) return;
  state.hooks[index] = { deps };
  state.effects.push(fn);
}

function createElement(type, props, ...children) {
  const merged = { ...(props ?? {}) };
  const flat = children.flat();
  if (flat.length === 1) merged.children = flat[0];
  else if (flat.length > 1) merged.children = flat;
  return { type, props: merged };
}

const React = { createElement, useState, useEffect, useRef, Fragment: 'Fragment' };
const ReactDOM = { createPortal: (node, container) => ({ __portal: true, node, container }) };

/* ---------------- fake DOM ---------------- */

let activeElement = null;
const listeners = [];
const nodeCache = new Map();
let anchorTop = 600;

function makeNode(tag, props) {
  const node = {
    tag,
    props,
    style: { ...(props?.style ?? {}) },
    children: [],
    parent: null,
    focus(options) {
      activeElement = node;
      if (typeof props?.onFocus === 'function') props.onFocus({ currentTarget: node });
    },
    getBoundingClientRect() { return { left: 100, top: anchorTop, right: 180, bottom: anchorTop + 24, width: 80, height: 24 }; },
    get firstElementChild() { return node.children[0] ?? null; },
    contains(other) {
      let cursor = other;
      while (cursor !== null && cursor !== undefined) {
        if (cursor === node) return true;
        cursor = cursor.parent;
      }
      return false;
    },
  };
  return node;
}

const documentStub = {
  body: makeNode('body', {}),
  addEventListener(type, fn) { listeners.push({ type, fn }); },
  removeEventListener(type, fn) {
    const index = listeners.findIndex((entry) => entry.type === type && entry.fn === fn);
    if (index !== -1) listeners.splice(index, 1);
  },
  get activeElement() { return activeElement; },
};

let innerWidth = 1280;
let innerHeight = 800;
const windowStub = {
  addEventListener() {},
  removeEventListener() {},
  get innerWidth() { return innerWidth; },
  get innerHeight() { return innerHeight; },
  visualViewport: undefined,
};

global.document = documentStub;
global.window = windowStub;
global.HTMLElement = class HTMLElement {};

function render(node, parent, path = '') {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === 'string' || typeof node === 'number') {
    const key = `#text|${path}`;
    let text = nodeCache.get(key);
    if (text === undefined) {
      text = makeNode('#text', {});
      nodeCache.set(key, text);
    }
    text.text = String(node);
    text.parent = parent;
    return text;
  }
  if (node.__portal) return render(node.node, node.container, path);
  const { type, props } = node;
  if (typeof type === 'function') {
    /* Hook state is keyed by position in the tree, not by element identity:
     * a component re-creating its child element every render must still reuse
     * that child's hooks (this is the harness, not React). */
    const state = instanceFor(`${type.name || 'anonymous'}#${path}`);
    const previous = current;
    current = state;
    state.hookIndex = 0;
    let child;
    try { child = type(props); } finally { current = previous; }
    return render(child, parent, `${path}>`);
  }
  /* Host nodes are cached by tree position, so a re-render keeps the same node
   * object — otherwise keyboard focus and refs would point at stale elements. */
  const key = `${path}|${type}`;
  let element = nodeCache.get(key);
  if (element === undefined) {
    element = makeNode(type, props);
    nodeCache.set(key, element);
  } else {
    element.tag = type;
    element.props = props;
    element.style = { ...(props?.style ?? {}) };
  }
  element.parent = parent;
  if (typeof props?.children === 'string' || typeof props?.children === 'number') {
    element.children = [render(props.children, element, `${path}/0`)];
    return element;
  }
  const kids = props?.children === undefined ? [] : [].concat(props.children);
  element.children = kids.map((kid, index) => render(kid, element, `${path}/${index}`)).filter(Boolean);
  if (props?.ref !== undefined && props?.ref !== null) {
    if (typeof props.ref === 'function') props.ref(element);
    else if (typeof props.ref === 'object') props.ref.current = element;
  }
  return element;
}

function mount(node) {
  let tree = null;
  for (let pass = 0; pass < 12; pass += 1) {
    for (const state of instances.values()) { state.effects = []; state.dirty = false; }
    tree = render(node, null);
    let ran = 0;
    for (const state of instances.values()) {
      const pending = state.effects;
      state.effects = [];
      for (const fn of pending) { fn(); ran += 1; }
    }
    const dirty = [...instances.values()].some((state) => state.dirty);
    if (!dirty && ran === 0) break;
  }
  return tree;
}

function walk(node, visit) {
  if (node === null || node === undefined) return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function find(node, predicate) {
  const found = [];
  walk(node, (element) => { if (predicate(element)) found.push(element); });
  return found;
}

function keydown(key) {
  let prevented = false;
  const event = { key, preventDefault() { prevented = true; } };
  for (const entry of [...listeners]) if (entry.type === 'keydown') entry.fn(event);
  return prevented;
}

/* Outside-click simulation: the popover binds a capture-phase pointerdown on
 * document and closes unless the target is inside its menu or its pill. */
function pointerdown(target) {
  for (const entry of [...listeners]) if (entry.type === 'pointerdown') entry.fn({ target });
}

/* ---------------- stub services ---------------- */

const LIST = {
  sessionId: 's1',
  cwd: 'C:\\demo',
  mcp: [
    { kind: 'mcp', name: 'hivemem', enabled: true, official: false, detail: '8 tools · ~2.4k tok', tokens: 2400 },
    { kind: 'mcp', name: 'chrome-main', enabled: false, official: false, detail: '32 tools · ~8.0k tok', tokens: 8000 },
  ],
  skills: [
    { kind: 'skill', name: 'diagnose-windows-sandbox-acl', enabled: true, official: true, detail: 'bundled', tokens: 0 },
  ],
  tools: [
    { kind: 'tool', name: 'read', enabled: true, official: true, detail: '~180 tok', tokens: 180 },
    { kind: 'tool', name: 'bash', enabled: false, official: true, detail: '~300 tok', tokens: 300 },
  ],
};

/* A second Session with a different surface: the harness mounts both at once
 * to stand in for two mixer panes. */
const LIST_S2 = {
  sessionId: 's2',
  cwd: 'C:\\demo2',
  mcp: [{ kind: 'mcp', name: 'chrome-p2', enabled: false, official: false, detail: '5 tools · ~1.0k tok', tokens: 1000 }],
  skills: [{ kind: 'skill', name: 'office', enabled: true, official: false, detail: 'user', tokens: 0 }],
  tools: [],
};

const DICT_ZH = {
  panel: '上下文', none: '无', mcp: 'MCP', skill: 'Skill', tool: '工具', official: '官方', custom: '自配',
  hint: '点击开关本会话的 MCP 服务器、技能与内置工具（下次请求生效，按项目记忆）', on: '已启用：', busy: '…',
  checkUpdate: '检查更新', checking: '检查中…', upToDate: '已是最新', available: '可升级',
  upgrade: '一键升级', upgrading: '升级中…', upgraded: '已升级，需重启', restart: '重启服务',
  restarting: '重启中…', reload: '刷新页面', failed: '升级失败', retry: '重试', details: '详情',
  hideDetails: '收起', updateUnavailable: '升级不可用', updateLocal: '本地安装，不提供在线升级',
  updateError: '检查失败', updateAvailableTip: '有新版本', compatible: '与当前 DSH 兼容',
  reloadHint: '已升级，刷新后生效',
  hostStale: '宿主仍在运行旧版插件（升级接口 404）——重启 dsh web 后可用',
  incompatible: '与当前 DSH 不兼容',
};

/* ---------------- update channel stub ----------------
 * The client half talks to the host over `/plugins/dsh-context-control/...`.
 * `fetchMode` selects what the channel answers, so one mount can be driven
 * through every phase the footer has (current → unavailable → available →
 * upgrade → restart) without a host and without a network. */
const UPDATE_BASE = '/plugins/dsh-context-control';
let fetchMode = 'current';
const fetchCalls = [];
let updateJobCalls = 0;
const fetchStub = async (url, init) => {
  const target = String(url);
  const path = target.startsWith(UPDATE_BASE) ? target.slice(UPDATE_BASE.length) : target;
  const method = String(init?.method ?? 'GET').toUpperCase();
  fetchCalls.push([method, path, init?.body]);
  const answer = (body) => ({ ok: true, status: 200, async text() { return JSON.stringify(body); } });
  /* The real failure this guards against: the page runs the new client bundle
   * (the host serves it from disk) while the process still runs the old host
   * half, so every update route is a 404 with an empty body. */
  const notFound = () => ({ ok: false, status: 404, async text() { return ''; } });
  if (fetchMode === 'stale' && path.startsWith('/update')) return notFound();
  if (fetchMode === 'blank' && path.startsWith('/update/job')) return notFound();
  if (path.startsWith('/update/job')) {
    updateJobCalls += 1;
    return answer(updateJobCalls === 1
      ? { ok: true, state: 'running', phase: 'install', log: 'pnpm add dsh-context-control@0.3.0\n' }
      : {
        ok: true, state: 'done', phase: 'verify', restartRequired: true, installed: '0.3.0',
        log: 'pnpm add dsh-context-control@0.3.0\n[done] installed 0.3.0\n',
      });
  }
  if (path.startsWith('/update/upgrade')) return answer({ ok: true, job: { state: 'running', phase: 'install', log: '' } });
  if (path.startsWith('/update/restart')) return answer({ ok: true, mode: 'respawn' });
  if (path.startsWith('/update/cancel')) return answer({ ok: true });
  if (path.startsWith('/ping')) return answer({ ok: true, version: '0.3.0' });
  if (path.startsWith('/update')) {
    if (fetchMode === 'available') {
      return answer({
        ok: true, current: '0.2.1', latest: '0.3.0', hasUpdate: true, canUpgrade: true,
        channel: { kind: 'registry', origin: 'spec' }, restartRequired: true,
      });
    }
    if (fetchMode === 'local') {
      return answer({
        ok: false, current: '0.2.1', hasUpdate: false, channel: { kind: 'local', origin: 'spec' },
        error: 'installed from a local path (link:C:/demo)',
      });
    }
    if (fetchMode === 'bumped') {
      // The host was upgraded while this page stayed open.
      return answer({
        ok: true, current: '0.4.0', latest: '0.4.0', hasUpdate: false,
        channel: { kind: 'manifest', origin: 'spec' }, restartRequired: false,
      });
    }
    return answer({
      ok: true, current: '0.2.1', latest: '0.2.1', hasUpdate: false,
      channel: { kind: 'registry', origin: 'spec' }, restartRequired: true,
    });
  }
  throw new Error(`unexpected fetch: ${target}`);
};
global.fetch = fetchStub;

const textOf = (node) => {
  const parts = [];
  walk(node, (element) => { if (typeof element.text === 'string') parts.push(element.text); });
  return parts.join('');
};

const remoteCalls = [];
const remoteContextControl = {
  async list(sessionId) {
    remoteCalls.push(['list', sessionId]);
    return { ok: true, value: sessionId === 's2' ? LIST_S2 : LIST };
  },
  async set(sessionId, kind, target, enabled) {
    remoteCalls.push(['set', sessionId, kind, target, enabled]);
    return { ok: true, value: { ok: true } };
  },
};

const zod = new Proxy(function zodStub() {}, {
  get: (target, property) => (property === 'then' ? undefined : zod),
  apply: () => zod,
});

const captured = {};
global.window.__ModuleLoader__ = { load: (config) => { captured.config = config; } };

require(CLIENT);

const factory = captured.config.factory;
if (typeof factory !== 'function') throw new Error('factory not captured');

const requireStub = (name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return ReactDOM;
  if (name === 'zod') return zod;
  throw new Error(`unexpected require(${name})`);
};

const plugin = factory(requireStub);

let registered = null;
const fakeCtx = {
  remote: { $mount: async () => {} },
  get: (name) => {
    if (name === 'remote.contextControl') return remoteContextControl;
    return undefined;
  },
  locale: { register() {}, bind: () => (key) => DICT_ZH[key] ?? key },
  slots: {
    inject(name, cb) { cb(); },
    register(args, component) { registered = { args, component }; return () => {}; },
  },
  sessions: {
    list: {
      getSnapshot: () => ({ byId: { s1: { id: 's1', retainedBy: { mainView: 1 } } } }),
      subscribe: () => () => {},
    },
  },
};

(async () => {
  check('inject list has no self-mounted service', () => {
    assert(Array.isArray(plugin.inject), 'inject is not an array');
    assert(!plugin.inject.includes('remote.contextControl'), 'inject contains remote.contextControl (self-deadlock)');
    assert(plugin.inject.includes('remote'), 'inject is missing remote');
  });

  await plugin.apply(fakeCtx);

  /* A page reload starts the module over: a fresh update store with no
   * remembered version, and the once-per-page auto check runs again. The
   * package is `"type": "module"`, so the file is an ES module and
   * `require.cache` does not control it — a distinct query string is what
   * gives a genuinely new instance. */
  let reloadCount = 0;
  const reloadPage = async () => {
    const { pathToFileURL } = require('node:url');
    reloadCount += 1;
    captured.config = undefined;
    await import(`${pathToFileURL(CLIENT).href}?reload=${reloadCount}`);
    const freshFactory = captured.config?.factory;
    if (typeof freshFactory !== 'function') throw new Error('reload did not capture a factory');
    const freshPlugin = freshFactory(requireStub);
    await freshPlugin.apply(fakeCtx);
    return registered.component;
  };

  check('slot registration uses conversation.input.left', () => {
    assert(registered !== null, 'no slot registration');
    assert(registered.args.name === 'conversation.input.left', `slot is ${registered.args.name}`);
  });

  const Pill = registered.component;
  let tree = mount({ type: Pill, props: { sessionId: 's1' } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  tree = mount({ type: Pill, props: { sessionId: 's1' } });

  check('remote list was called for the pill\'s Session', () => {
    assert(remoteCalls.some((call) => call[0] === 'list' && call[1] === 's1'), JSON.stringify(remoteCalls));
  });

  check('pill text shows enabled/total and schema cost', () => {
    const button = find(tree, (element) => element.tag === 'button')[0];
    assert(button !== undefined, 'no pill button');
    const text = find(button, (element) => element.text !== undefined).map((element) => element.text).join('');
    assert(text.includes('上下文 3/5 · ~2.6k tok'), `pill text is "${text}"`);
  });

  check('pill tooltip lists enabled entries', () => {
    const button = find(tree, (element) => element.tag === 'button')[0];
    assert(typeof button.props.title === 'string', 'no title');
    assert(button.props.title.includes('hivemem'), `title is "${button.props.title}"`);
    assert(button.props.title.includes('diagnose-windows-sandbox-acl'), `title is "${button.props.title}"`);
    assert(button.props.title.includes('read'), `title is "${button.props.title}"`);
    assert(!button.props.title.includes('chrome-main'), `title leaks a disabled entry: "${button.props.title}"`);
    assert(!button.props.title.includes('bash'), `title leaks a disabled entry: "${button.props.title}"`);
  });

  /* Open the popover through the pill's click handler. */
  const pillButton = find(tree, (element) => element.tag === 'button')[0];
  pillButton.props.onClick();
  tree = mount({ type: Pill, props: { sessionId: 's1' } });

  if (process.env.DEBUG) {
    console.log('DEBUG keys:', [...instances.keys()]);
    console.log('DEBUG tags:', [...new Set(find(tree, () => true).map((element) => element.tag))]);
    console.log('DEBUG anchors:', find(tree, (element) => element.props?.['data-context-control'] !== undefined)
      .map((element) => element.props['data-context-control']));
    console.log('DEBUG pill hooks:', JSON.stringify(
      [...instances.entries()].find(([key]) => key.startsWith('SessionPill#'))?.[1].hooks?.[0],
    ));
  }

  const switches = find(tree, (element) => element.props?.['role'] === 'switch');
  check('the popover opens on the first non-empty tab', () => {
    assert(switches.length === 2, `got ${switches.length} switch rows`);
    assert(switches[0].props['aria-label'] === 'hivemem', `first row is ${switches[0].props['aria-label']}`);
  });

  check('tabs carry on/total and cost for every kind', () => {
    const tabs = find(tree, (element) => element.props?.['role'] === 'tab');
    assert(tabs.length === 3, `got ${tabs.length} tabs`);
    const textOf = (tab) => find(tab, (element) => element.text !== undefined)
      .map((element) => element.text).join(' ');
    assert(textOf(tabs[0]).includes('MCP') && textOf(tabs[0]).includes('1/2 · ~2.4k tok'),
      `first tab is ${textOf(tabs[0])}`);
    assert(textOf(tabs[1]).includes('Skill') && textOf(tabs[1]).includes('1/1'),
      `second tab is ${textOf(tabs[1])}`);
    assert(textOf(tabs[2]).includes('工具') && textOf(tabs[2]).includes('1/2 · ~180 tok'),
      `third tab is ${textOf(tabs[2])}`);
  });

  const menu = find(tree, (element) => element.props?.['data-context-control'] === 'menu')[0];
  check('popover is portaled and bounded by the room above the anchor', () => {
    assert(menu !== undefined, 'no menu element');
    assert(menu.parent === documentStub.body, 'menu is not portaled to body');
    assert(menu.style.maxHeight === 320, `maxHeight is ${menu.style.maxHeight}`);
    assert(typeof menu.style.left === 'number' && typeof menu.style.bottom === 'number', 'missing coordinates');
  });

  check('first row takes focus when the popover opens', () => {
    assert(activeElement === switches[0], `focus is on ${activeElement?.props?.['aria-label'] ?? activeElement?.tag}`);
  });

  check('ArrowDown moves focus to the next row', () => {
    const prevented = keydown('ArrowDown');
    assert(prevented, 'ArrowDown was not handled');
    assert(activeElement === switches[1], `focus is on ${activeElement?.props?.['aria-label'] ?? activeElement?.tag}`);
  });

  check('ArrowDown wraps from the last row to the first', () => {
    keydown('ArrowUp');
    keydown('ArrowUp');
    assert(activeElement === switches[switches.length - 1], 'ArrowUp did not wrap backwards');
    keydown('ArrowDown');
    assert(activeElement === switches[0], 'ArrowDown did not wrap forwards');
  });

  /* A toggle is refused while a request is in flight; let open-time load settle. */
  await new Promise((resolve) => setTimeout(resolve, 20));
  tree = mount({ type: Pill, props: { sessionId: 's1' } });
  check('row click reaches the host remote with the right arguments', () => {
    const rows = find(tree, (element) => element.props?.['role'] === 'switch');
    const before = remoteCalls.length;
    rows[1].props.onClick();
    const call = remoteCalls[before];
    assert(call !== undefined && call[0] === 'set', 'click did not reach the remote');
    assert(call[1] === 's1' && call[2] === 'mcp' && call[3] === 'chrome-main' && call[4] === true, JSON.stringify(call));
  });

  /* Tabs: each kind renders alone, and the strip is reachable with arrows. */
  check('a tab shows only its own kind', () => {
    const tabs = find(tree, (element) => element.props?.['role'] === 'tab');
    tabs[2].props.onClick();
    tree = mount({ type: Pill, props: { sessionId: 's1' } });
    const rows = find(tree, (element) => element.props?.['role'] === 'switch');
    assert(rows.length === 2, `tools tab rendered ${rows.length} rows`);
    assert(rows.map((row) => row.props['aria-label']).join(',') === 'read,bash',
      `tools tab rendered ${rows.map((row) => row.props['aria-label'])}`);
  });

  check('Left/Right on the tab strip switches kinds and takes focus', () => {
    const strip = find(tree, (element) => element.props?.['role'] === 'tablist')[0];
    let prevented = false;
    strip.props.onKeyDown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
    assert(prevented, 'ArrowRight on the strip was not handled');
    tree = mount({ type: Pill, props: { sessionId: 's1' } });
    const rows = find(tree, (element) => element.props?.['role'] === 'switch');
    assert(rows.length === 2 && rows[0].props['aria-label'] === 'hivemem',
      'ArrowRight from the last tab did not wrap to the first kind');
    const tabs = find(tree, (element) => element.props?.['role'] === 'tab');
    assert(activeElement === tabs[0], 'focus did not follow the tab switch');
  });

  check('Escape closes and returns focus to the pill', () => {
    keydown('Escape');
    tree = mount({ type: Pill, props: { sessionId: 's1' } });
    const menuAfter = find(tree, (element) => element.props?.['data-context-control'] === 'menu')[0];
    assert(menuAfter === undefined, 'menu still open');
    const pillAfter = find(tree, (element) => element.tag === 'button')[0];
    assert(activeElement === pillAfter, 'focus did not return to the pill');
  });

  /* ---- several composers on screen (the mixer case) ----
   * Regression: one click used to open the popover in every pane because the
   * open flag lived in a store shared by all pill instances, and every pane
   * reported the main-view Session instead of its own. */
  instances = new Map();
  nodeCache.clear();
  activeElement = null;
  innerHeight = 800;
  innerWidth = 1280;
  anchorTop = 600;
  remoteCalls.length = 0;

  const panes = () => ({
    type: 'div',
    props: {
      children: [
        { type: Pill, props: { sessionId: 's1' } },
        { type: Pill, props: { sessionId: 's2' } },
      ],
    },
  });
  const anchorsOf = (view) => find(view, (element) => element.props?.['data-context-control'] === 'anchor');
  const menusOf = (view) => find(view, (element) => element.props?.['data-context-control'] === 'menu');

  let panesTree = mount(panes());
  await new Promise((resolve) => setTimeout(resolve, 60));
  panesTree = mount(panes());

  check('each pane pill reports its own Session', () => {
    const anchors = anchorsOf(panesTree);
    assert(anchors.length === 2, `mounted ${anchors.length} pills`);
    const textOf = (anchor) => find(anchor, (element) => element.text !== undefined)
      .map((element) => element.text).join('');
    assert(remoteCalls.some((call) => call[0] === 'list' && call[1] === 's2'), JSON.stringify(remoteCalls));
    assert(textOf(anchors[0]).includes('上下文 3/5 · ~2.6k tok'), `pane 1 text is "${textOf(anchors[0])}"`);
    assert(textOf(anchors[1]).includes('上下文 1/2'), `pane 2 text is "${textOf(anchors[1])}"`);
  });

  anchorsOf(panesTree)[0].children[0].props.onClick();
  panesTree = mount(panes());

  check('clicking one pane opens exactly one popover, for that pane', () => {
    const open = menusOf(panesTree);
    assert(open.length === 1, `opened ${open.length} popovers`);
    assert(open[0].props['data-context-control-session'] === 's1',
      `popover is for ${open[0].props['data-context-control-session']}`);
    assert(open[0].style.left === 100 && open[0].style.bottom === 800 - 600 + 6,
      `popover is not anchored to the clicked pill: ${JSON.stringify(open[0].style)}`);
  });

  check('the untouched pane keeps its popover closed', () => {
    const anchors = anchorsOf(panesTree);
    const childMenus = anchors[1].children
      .filter((child) => child.props?.['data-context-control'] === 'menu');
    assert(childMenus.length === 0, 'the second pane opened its own popover');
  });

  /* Switching panes: the pointerdown outside pane 1 closes it first, exactly
   * as the document-level handler does in the browser. */
  const secondPill = anchorsOf(panesTree)[1];
  pointerdown(secondPill);
  panesTree = mount(panes());
  secondPill.children[0].props.onClick();
  panesTree = mount(panes());

  check('switching panes moves the popover instead of stacking one per pane', () => {
    const open = menusOf(panesTree);
    assert(open.length === 1, `opened ${open.length} popovers`);
    assert(open[0].props['data-context-control-session'] === 's2',
      `popover is for ${open[0].props['data-context-control-session']}`);
  });

  /* Opening refreshes the Session's state; rows stay inert until that settles
   * (aria-disabled plus the click guard), so let it finish first. */
  await new Promise((resolve) => setTimeout(resolve, 20));
  panesTree = mount(panes());

  check('a toggle from one pane addresses that pane Session', () => {
    const rows = find(panesTree, (element) => element.props?.['role'] === 'switch');
    const before = remoteCalls.length;
    rows[0].props.onClick();
    const call = remoteCalls[before];
    assert(call !== undefined && call[0] === 'set' && call[1] === 's2', JSON.stringify(call));
  });

  pointerdown(documentStub.body);
  panesTree = mount(panes());

  check('an outside pointerdown closes the pane popover', () => {
    assert(menusOf(panesTree).length === 0, 'popover survived an outside click');
  });

  /* Small viewport: the popover must shrink instead of running off the top. */
  innerHeight = 300;
  innerWidth = 360;
  anchorTop = 250;
  instances = new Map();
  nodeCache.clear();
  activeElement = null;

  const small = await (async () => {
    const pill = find(mount({ type: Pill, props: { sessionId: 's1' } }), (element) => element.tag === 'button')[0];
    pill.props.onClick();
    return mount({ type: Pill, props: { sessionId: 's1' } });
  })();
  const smallMenu = find(small, (element) => element.props?.['data-context-control'] === 'menu')[0];
  check('short viewport shrinks the popover height', () => {
    assert(smallMenu !== undefined, 'no menu on the small viewport');
    assert(smallMenu.style.maxHeight === 236, `maxHeight is ${smallMenu.style.maxHeight} on a 300px viewport`);
    assert(smallMenu.style.width === 280, `width is ${smallMenu.style.width}`);
  });

  /* ---------------- update channel ----------------
   * One popover driven through every phase the footer has. Each phase is a
   * click on the same button, which is the whole contract of that row: the
   * label names the step and the click takes it. */
  const footerOf = (view) => find(view, (element) => element.props?.['data-context-control'] === 'update')[0];
  const actionOf = (view) => find(view, (element) => element.props?.['data-context-control'] === 'update-action')[0];
  const openFreshPopover = async () => {
    instances = new Map();
    nodeCache.clear();
    activeElement = null;
    let view = mount({ type: Pill, props: { sessionId: 's1' } });
    const anchor = find(view, (element) => element.props?.['data-context-control'] === 'anchor')[0];
    anchor.children[0].props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    view = mount({ type: Pill, props: { sessionId: 's1' } });
    return view;
  };

  fetchMode = 'current';
  let updateTree = await openFreshPopover();

  check('update row reports the installed version and the channel answer', () => {
    const footer = footerOf(updateTree);
    assert(footer !== undefined, 'no update row in the popover');
    const text = textOf(footer);
    assert(text.includes('v0.2.1'), `version is missing: "${text}"`);
    assert(text.includes('已是最新'), `answer is missing: "${text}"`);
    assert(text.includes('检查更新'), `no check action: "${text}"`);
  });

  fetchMode = 'local';
  actionOf(updateTree).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  updateTree = mount({ type: Pill, props: { sessionId: 's1' } });

  check('a local checkout reports that it cannot be upgraded in place', () => {
    const action = actionOf(updateTree);
    assert(action.props['data-context-control-phase'] === 'unavailable',
      `phase is ${action.props['data-context-control-phase']}`);
    assert(textOf(action) === '升级不可用', `action reads ${textOf(action)}`);
    assert(textOf(updateTree).includes('本地安装'), 'the local-install note is missing');
  });

  fetchMode = 'available';
  actionOf(updateTree).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  updateTree = mount({ type: Pill, props: { sessionId: 's1' } });

  check('a pending update badges the pill without changing its text', () => {
    const badge = find(updateTree, (element) => element.props?.['data-context-control-update'] === 'available')[0];
    assert(badge !== undefined, 'no update badge on the pill');
    assert(textOf(badge).includes('上下文 3/5 · ~2.6k tok'), `pill text changed: "${textOf(badge)}"`);
    assert(textOf(badge).includes('↑'), 'the badge marker is missing');
    assert(badge.props.title.includes('有新版本'), 'the tooltip does not mention the update');
  });

  check('the footer offers one-click upgrade for the newer version', () => {
    const action = actionOf(updateTree);
    assert(textOf(action) === '一键升级', `action reads ${textOf(action)}`);
    assert(textOf(footerOf(updateTree)).includes('v0.3.0'), 'the target version is not shown');
  });

  updateJobCalls = 0;
  actionOf(updateTree).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 40));

  check('the upgrade posts the version the check reported', () => {
    const call = fetchCalls.find(([method, path]) => method === 'POST' && path.startsWith('/update/upgrade'));
    assert(call !== undefined, 'no upgrade POST');
    assert(JSON.parse(call[2]).version === '0.3.0', `body is ${call[2]}`);
  });

  /* The job is polled: running first, then done. */
  await new Promise((resolve) => setTimeout(resolve, 1500));
  updateTree = mount({ type: Pill, props: { sessionId: 's1' } });

  check('a finished install asks for the restart instead of claiming success', () => {
    const action = actionOf(updateTree);
    assert(textOf(action) === '重启服务', `action reads ${textOf(action)}`);
    const toggle = find(updateTree, (element) => element.props?.['data-context-control'] === 'update-log-toggle')[0];
    assert(toggle !== undefined, 'no log toggle after an install ran');
  });

  check('the log toggle shows the install output', () => {
    const toggle = find(updateTree, (element) => element.props?.['data-context-control'] === 'update-log-toggle')[0];
    toggle.props.onClick();
    updateTree = mount({ type: Pill, props: { sessionId: 's1' } });
    const log = find(updateTree, (element) => element.props?.['data-context-control'] === 'update-log')[0];
    assert(log !== undefined, 'no log block after toggling');
    assert(textOf(log).includes('installed 0.3.0'), `log reads "${textOf(log)}"`);
  });

  actionOf(updateTree).props.onClick();
  /* The liveness poll starts after a short grace period that lets the host
   * actually go down first — a ping answered by the process that is about to
   * exit would reload the page into a dying server. */
  await new Promise((resolve) => setTimeout(resolve, 1200));

  check('restart asks the host to come back and waits for it', () => {
    assert(fetchCalls.some(([method, path]) => method === 'POST' && path.startsWith('/update/restart')),
      'no restart POST');
    assert(fetchCalls.some(([method, path]) => method === 'GET' && path.startsWith('/ping')),
      'the page did not wait for the host to answer again');
  });

  fetchMode = 'current';
  let diagnostics = null;
  check('the auto check ran exactly once for the page', () => {
    diagnostics = fetchCalls.filter(([method, path]) => method === 'GET' && path.startsWith('/update?')).length;
    assert(diagnostics >= 1, 'the pill never asked the channel');
  });

  /* A tab left open across an upgrade: the host starts serving a different
   * version, so the row must offer a reload instead of "up to date". The page
   * remembers the version it first saw; a later check that disagrees wins. */
  fetchMode = 'bumped';
  instances = new Map();
  nodeCache.clear();
  let staleTree = mount({ type: Pill, props: { sessionId: 's1' } });
  const staleAnchor = find(staleTree, (element) => element.props?.['data-context-control'] === 'anchor')[0];
  staleAnchor.children[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  staleTree = mount({ type: Pill, props: { sessionId: 's1' } });
  /* The check button is always present, so a page in any phase can re-ask. */
  find(staleTree, (element) => element.props?.['data-context-control'] === 'update-check')[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  staleTree = mount({ type: Pill, props: { sessionId: 's1' } });

  check('a tab that outlived an upgrade offers a reload, not "up to date"', () => {
    const action = actionOf(staleTree);
    assert(action.props['data-context-control-phase'] === 'reload',
      `phase is ${action.props['data-context-control-phase']}`);
    assert(textOf(action) === '刷新页面', `action reads ${textOf(action)}`);
    assert(textOf(staleTree).includes('刷新后生效'), 'the reload hint is missing');
  });
  /* The stale host: the new client bundle is served from disk, but the process
   * still runs the old host half, so `/update` answers 404 with an empty body.
   * That used to parse as {} and render as "up to date" with `v—`, which is the
   * opposite of the truth. A reload is what a user actually does here. */
  fetchMode = 'stale';
  instances = new Map();
  nodeCache.clear();
  activeElement = null;
  const FreshPill = await reloadPage();
  let staleHostTree = mount({ type: FreshPill, props: { sessionId: 's1' } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  staleHostTree = mount({ type: FreshPill, props: { sessionId: 's1' } });
  const staleHostAnchor = find(staleHostTree, (element) => element.props?.['data-context-control'] === 'anchor')[0];
  staleHostAnchor.children[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  staleHostTree = mount({ type: FreshPill, props: { sessionId: 's1' } });

  check('a 404 from the host is an error, never "up to date"', () => {
    const action = actionOf(staleHostTree);
    assert(action.props['data-context-control-phase'] === 'error',
      `phase is ${action.props['data-context-control-phase']} (a 404 was read as an answer)`);
    const note = textOf(staleHostTree);
    assert(!note.includes('已是最新'), `a 404 rendered as up to date: "${note}"`);
    assert(note.includes('重启 dsh web'), `the stale-host hint is missing: "${note}"`);
    /* Nothing is known yet, so the label must not invent a version. */
    assert(note.includes('v—'), `unknown version should stay blank, got "${note}"`);
    assert(textOf(action) === '重试', `action reads ${textOf(action)}`);
  });

  /* The same stale host, seen by a page whose auto check is the only caller:
   * it must not leave the row stuck on "checking" either. */
  fetchMode = 'stale';
  instances = new Map();
  nodeCache.clear();
  const SecondPill = await reloadPage();
  let autoTree = mount({ type: SecondPill, props: { sessionId: 's1' } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  autoTree = mount({ type: SecondPill, props: { sessionId: 's1' } });
  const autoAnchor = find(autoTree, (element) => element.props?.['data-context-control'] === 'anchor')[0];
  autoAnchor.children[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  autoTree = mount({ type: SecondPill, props: { sessionId: 's1' } });

  check('the page auto check settles on the error, not on "checking"', () => {
    const action = actionOf(autoTree);
    assert(action !== undefined, 'no update row after the auto check');
    assert(action.props['data-context-control-phase'] === 'error',
      `auto check left the row at ${action.props['data-context-control-phase']}`);
    assert(textOf(action) === '重试', `action reads ${textOf(action)}`);
  });

  console.log(results.join('\n'));
  const failed = results.filter((line) => line.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error('HARNESS ERROR:', error);
  process.exit(2);
});
