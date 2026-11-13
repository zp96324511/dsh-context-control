/* Offline harness for dsh-context-control/client.js:
 * a ~150-line mini React runtime (hooks + function components + effects),
 * stubbed gateway/locale/slots, and a fake DOM — enough to exercise the pill
 * tooltip, the popover measurement, keyboard navigation, and the multi-pane
 * case (several composer pills, as in the mixer) without a browser or a host
 * restart. */

const path = require('node:path');
const fs = require('node:fs');

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
    appendChild(child) {
      node.children.push(child);
      child.parent = node;
      return child;
    },
  };
  return node;
}

const documentStub = {
  body: makeNode('body', {}),
  head: makeNode('head', {}),
  /* The client injects one stylesheet for the update spinner's @keyframes, so
   * the stub needs the three calls that injection makes. */
  createElement(tag) {
    const node = makeNode(tag, {});
    node.id = '';
    node.textContent = '';
    return node;
  },
  getElementById(id) {
    return documentStub.head.children.find((child) => child.id === id) ?? null;
  },
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

/* React invokes refs on every committed element, whatever its children are;
 * this harness must too, or a button whose label is a plain string would never
 * publish itself to a ref (and focus/keyboard navigation would silently die). */
function attachRef(props, element) {
  if (props?.ref === undefined || props?.ref === null) return;
  if (typeof props.ref === 'function') props.ref(element);
  else if (typeof props.ref === 'object') props.ref.current = element;
}

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
    attachRef(props, element);
    return element;
  }
  const kids = props?.children === undefined ? [] : [].concat(props.children);
  element.children = kids.map((kid, index) => render(kid, element, `${path}/${index}`)).filter(Boolean);
  attachRef(props, element);
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

/* `pinned: false` is the third state: nothing was chosen in this conversation,
 * so the entry follows the project and its dot only mirrors the workspace
 * switch. `pinned: true` means the dot is the conversation's own answer. */
const LIST = {
  sessionId: 's1',
  cwd: 'C:\\demo',
  mcp: [
    { kind: 'mcp', name: 'hivemem', enabled: true, workspace: true, pinned: false, official: false, detail: '8 tools', description: '跨会话记忆：检索、写入与归档' },
    { kind: 'mcp', name: 'chrome-main', enabled: false, workspace: false, pinned: false, official: false, detail: '32 tools', description: '' },
  ],
  skills: [
    { kind: 'skill', name: 'diagnose-windows-sandbox-acl', enabled: true, workspace: true, pinned: false, official: true, detail: 'bundled', description: '诊断 Windows 沙箱 ACL 拒绝' },
  ],
  tools: [
    { kind: 'tool', name: 'read', enabled: true, workspace: true, pinned: true, official: true, detail: '', description: '读取文件内容' },
    { kind: 'tool', name: 'bash', enabled: false, workspace: false, pinned: true, official: true, detail: '', description: '' },
  ],
};

/* A second Session with a different surface: the harness mounts both at once
 * to stand in for two mixer panes. `chrome-p2` is off in this session but on
 * in the workspace — the pair of switches must show exactly that. */
const LIST_S2 = {
  sessionId: 's2',
  cwd: 'C:\\demo2',
  mcp: [{ kind: 'mcp', name: 'chrome-p2', enabled: false, workspace: true, pinned: true, official: false, detail: '5 tools' }],
  skills: [{ kind: 'skill', name: 'office', enabled: true, workspace: true, pinned: false, official: false, detail: 'user' }],
  tools: [],
};

/* A host older than 0.7.0 (files upgraded, host still running the previous
 * module) has no workspace state to report — its single switch was the
 * workspace default. The panel must keep working and mirror that state; with
 * no `pinned` either, the dots keep their pre-0.8.0 meaning. */
const LIST_OLD = {
  sessionId: 's3',
  cwd: 'C:\\old',
  mcp: [{ kind: 'mcp', name: 'hivemem', enabled: true, official: false, detail: '8 tools' }],
  skills: [],
  tools: [{ kind: 'tool', name: 'read', enabled: true, official: true, detail: '' }],
};

const FIXTURES = { s1: LIST, s2: LIST_S2, s3: LIST_OLD };

const DICT_ZH = {
  panel: '组件上下文', none: '无', mcp: 'MCP', skill: 'Skill', tool: '工具', official: '官方', custom: '自配',
  scopeSession: '会话', scopeSessionFollowing: '会话（跟随项目）', scopeWorkspace: '工作区',
  hint: '使用说明：每个条目右侧设有两个开关，分别为会话级（蓝色圆点）与工作区级（紫色圆点）。\n'
    + '会话级仅作用于当前会话，重新打开该会话时（含宿主重启后）仍保留；会话归档后恢复，则重新继承工作区级设置。\n'
    + '会话未对该条目单独设置时处于跟随状态：圆环保持暗色，圆心与工作区级开关一致。右键或按住 Alt 点击会话级开关可取消钉住，恢复跟随。\n'
    + '工作区级写入本项目的默认值：本会话未对该条目单独设置时立即采用，此后在本项目新建的会话继承该值。\n'
    + '两者同时存在时，会话级设置优先。所有变更在下次模型请求时生效。',
  pillHint: '组件上下文：点击可开关 MCP 服务器、技能与内置工具', hintToggle: '使用说明',
  on: '已启用：', busy: '…',
  checkUpdate: '检查更新', checking: '检查中…', upToDate: '已是最新', available: '可升级',
  upgrade: '一键升级', upgrading: '升级中…', upgraded: '已升级',
  upgradedHint: '已升级，重启 dsh web 后生效', reload: '刷新页面', failed: '升级失败', retry: '重试', details: '详情',
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
 * upgrade → restart hint) without a host and without a network. */
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
  if (path.startsWith('/update/cancel')) return answer({ ok: true });
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
    if (fetchMode === 'stale-install') {
      // Files on disk are 0.3.0, but this host still runs the 0.2.1 module.
      return answer({
        ok: true, current: '0.3.0', latest: '0.3.0', hasUpdate: false, loaded: '0.2.1',
        channel: { kind: 'registry', origin: 'spec' }, restartRequired: true, stale: true, hmr: false,
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
    return { ok: true, value: FIXTURES[sessionId] ?? LIST };
  },
  async set(sessionId, kind, target, enabled, scope) {
    remoteCalls.push(['set', sessionId, kind, target, enabled, scope]);
    return { ok: true, value: { ok: true, scope: scope ?? 'session' } };
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

  check('pill text shows enabled/total', () => {
    const button = find(tree, (element) => element.tag === 'button')[0];
    assert(button !== undefined, 'no pill button');
    const text = find(button, (element) => element.text !== undefined).map((element) => element.text).join('');
    assert(text.includes('组件上下文 3/5'), `pill text is "${text}"`);
    assert(!text.includes('tok') && !text.includes('~'), `pill must not estimate tokens: "${text}"`);
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

  /* Rows are groups of two scope switches (会话 / 工作区), so every query goes
   * through the row element, never through a bare list of switches. */
  const rowList = (view) => find(view, (element) => element.props?.['data-context-control-row'] !== undefined);
  const rowOf = (view, name) => rowList(view).find((row) => row.props['aria-label'] === name);
  const switchesIn = (row) => find(row, (element) => element.props?.['role'] === 'switch');
  /* The ring is the border-box circle inside a switch; the dot is the filled
   * circle inside the ring, present only when the switch is on. */
  const ringOf = (sw) => sw.children.find((child) => child?.props?.style?.border === '1.5px solid currentColor');
  const dotIn = (sw) => ringOf(sw)?.children?.find((child) => child?.props?.style?.background === 'currentColor');
  const textOfNode = (node) => find(node, (element) => element.text !== undefined)
    .map((element) => element.text).join('');

  check('the popover opens on the first non-empty tab, one row per entry', () => {
    const rows = rowList(tree);
    assert(rows.length === 2, `got ${rows.length} rows`);
    assert(rows[0].props['aria-label'] === 'hivemem', `first row is ${rows[0].props['aria-label']}`);
  });

  check('every row carries one session switch and one workspace switch', () => {
    for (const row of rowList(tree)) {
      const pair = switchesIn(row);
      assert(pair.length === 2, `${row.props['aria-label']} has ${pair.length} switches`);
      assert(pair.map((sw) => sw.props['data-context-control-scope']).join(',') === 'session,workspace',
        `${row.props['aria-label']} switches are ${pair.map((sw) => sw.props['data-context-control-scope'])}`);
      /* No visible text any more: the name is in the accessible label, and the
       * colours are explained in the usage note. A hover card on a control
       * that sits two pixels from its twin would cover the row it explains. */
      assert(pair[0].props['aria-label'].startsWith(`${row.props['aria-label']} · 会话`)
        && pair[1].props['aria-label'] === `${row.props['aria-label']} · 工作区`,
        `${row.props['aria-label']} names are ${pair.map((sw) => sw.props['aria-label'])}`);
      assert(textOfNode(pair[0]) === '' && textOfNode(pair[1]) === '',
        `${row.props['aria-label']} still prints a label: ${pair.map(textOfNode)}`);
      assert(!('title' in pair[0].props) && !('title' in pair[1].props),
        `${row.props['aria-label']} still has a hover title: ${pair.map((sw) => sw.props.title)}`);
      assert(pair[0].props.style.color.includes('--dsw-alias-state-business-primary'),
        `session colour is ${pair[0].props.style.color}`);
      assert(pair[1].props.style.color === '#8b5cf6', `workspace colour is ${pair[1].props.style.color}`);
    }
  });

  check('a following session dot stays dim and mirrors the project', () => {
    /* hivemem has no choice here and the project says on: dim ring, dot from
     * the workspace switch. chrome-main follows and the project says off.
     * Brightness is the pin, so "off because I said so" and "off because the
     * project says so" cannot look alike. */
    const on = switchesIn(rowOf(tree, 'hivemem'));
    const off = switchesIn(rowOf(tree, 'chrome-main'));
    assert(ringOf(on[0]) !== undefined && ringOf(off[0]) !== undefined, 'a switch has no ring');
    assert(ringOf(on[0]).props.style.opacity === '.4',
      `a following dot is ${ringOf(on[0]).props.style.opacity}`);
    assert(ringOf(off[0]).props.style.opacity === '.4',
      `a following dot is ${ringOf(off[0]).props.style.opacity}`);
    assert(dotIn(on[0]) !== undefined, 'a following dot lost the project state');
    assert(dotIn(off[0]) === undefined, 'a following dot shows a dot the project does not have');
    /* The workspace switch is always the deciding one, so it stays bright — and
     * the gap to the dim state has to be wide enough to read at a glance. */
    assert(ringOf(on[1]).props.style.opacity === '1' && ringOf(off[1]).props.style.opacity === '1',
      'the workspace ring is dim');
    assert(Number(ringOf(on[1]).props.style.opacity) - Number(ringOf(on[0]).props.style.opacity) >= 0.55,
      'a following ring is too close to a bright one to tell apart');
    assert(on[0].props['data-context-control-pinned'] === 'false'
      && off[0].props['data-context-control-pinned'] === 'false', 'a following switch claims to be pinned');
    assert(on[1].props['data-context-control-pinned'] === undefined, 'the workspace switch claims a pin');
    /* Brightness has no accessible equivalent, so the name says it instead. */
    assert(on[0].props['aria-label'].endsWith('会话（跟随项目）'),
      `a following switch is named "${on[0].props['aria-label']}"`);
    assert(ringOf(on[0]).props.style.width === '11px' && ringOf(off[0]).props.style.width === '11px',
      'the ring changes size between states');
  });

  check('the two switches report independent states', () => {
    /* hivemem: on here and on in the workspace. */
    const hivemem = switchesIn(rowOf(tree, 'hivemem'));
    assert(hivemem[0].props['aria-checked'] === 'true' && hivemem[1].props['aria-checked'] === 'true',
      `hivemem is ${hivemem.map((sw) => sw.props['aria-checked'])}`);
    /* chrome-main: off here and off as a default — the pair must not be
     * derived from one another. */
    const chrome = switchesIn(rowOf(tree, 'chrome-main'));
    assert(chrome[0].props['aria-checked'] === 'false' && chrome[1].props['aria-checked'] === 'false',
      `chrome-main is ${chrome.map((sw) => sw.props['aria-checked'])}`);
    assert(chrome[0].props['data-context-control-entry'] === 'mcp:chrome-main'
      && chrome[1].props['data-context-control-entry'] === 'mcp:chrome-main', 'switches do not name their entry');
  });

  check('rows show a one-line description from the host', () => {
    const first = rowOf(tree, 'hivemem');
    const second = rowOf(tree, 'chrome-main');
    assert(textOfNode(first).includes('跨会话记忆：检索、写入与归档'), `first row is ${textOfNode(first)}`);
    assert(first.props['aria-description'] === '跨会话记忆：检索、写入与归档', 'aria-description missing');
    assert(first.props.title.includes('跨会话记忆'), `title is ${first.props.title}`);
    assert(!textOfNode(second).includes('跨会话'), `second row picked up a foreign description: ${textOfNode(second)}`);
    assert(second.props['aria-description'] === undefined, 'empty description should stay absent');
    /* An MCP server that publishes no `instructions` has no description, but
     * the second line still says what the entry is rather than collapsing the
     * row — that blank half-row was the bug being fixed. */
    assert(textOfNode(second).includes('32 tools'), `a descriptionless row lost its second line: ${textOfNode(second)}`);
  });

  check('rows fit the popover instead of forcing a horizontal scrollbar', () => {
    for (const row of rowList(tree)) {
      const style = row.props.style;
      assert(style.boxSizing === 'border-box',
        `${row.props['aria-label']} is ${style.boxSizing}: width 100% plus padding overflows the popover`);
    }
    const body = find(tree, (element) => element.props?.['role'] === 'tabpanel')[0];
    assert(body.style.overflowX === 'hidden', 'the scroller would enable a horizontal bar');
  });

  check('tabs carry on/total for every kind, with no cost estimate', () => {
    const tabs = find(tree, (element) => element.props?.['role'] === 'tab');
    assert(tabs.length === 3, `got ${tabs.length} tabs`);
    const textOf = (tab) => find(tab, (element) => element.text !== undefined)
      .map((element) => element.text).join(' ');
    assert(textOf(tabs[0]).includes('MCP') && textOf(tabs[0]).includes('1/2'),
      `first tab is ${textOf(tabs[0])}`);
    assert(textOf(tabs[1]).includes('Skill') && textOf(tabs[1]).includes('1/1'),
      `second tab is ${textOf(tabs[1])}`);
    assert(textOf(tabs[2]).includes('工具') && textOf(tabs[2]).includes('1/2'),
      `third tab is ${textOf(tabs[2])}`);
    assert(!textOf(tabs[0]).includes('tok') && !textOf(tabs[0]).includes('~'),
      `the tab must not carry a token estimate: ${textOf(tabs[0])}`);
  });

  const menu = find(tree, (element) => element.props?.['data-context-control'] === 'menu')[0];
  check('popover is portaled and bounded by the room above the anchor', () => {
    assert(menu !== undefined, 'no menu element');
    assert(menu.parent === documentStub.body, 'menu is not portaled to body');
    assert(menu.style.maxHeight === 320, `maxHeight is ${menu.style.maxHeight}`);
    assert(menu.style.width === 320, `width is ${menu.style.width} (two switches need room)`);
    assert(typeof menu.style.left === 'number' && typeof menu.style.bottom === 'number', 'missing coordinates');
  });

  check('the popover surface comes from the theme, not a dark constant', () => {
    /* DSH defines `--dsw-alias-bg-layer-1..4`, `--dsw-alias-border-l1..l4` and
     * the menu material; it never defined `--dsw-alias-bg-elevated`,
     * `--dsw-alias-bg-sunken` or `--dsw-alias-border-l`. Those fell straight
     * through to their fallbacks, which is why the popover stayed near-black
     * after the GUI switched to the light theme. The harness has no stylesheet,
     * so the source is the only place this can be caught offline. The comments
     * name the dead tokens on purpose; only real `var()` references count. */
    const source = fs.readFileSync(CLIENT, 'utf8');
    assert(!/var\(--dsw-alias-(?:bg-elevated|bg-sunken)/.test(source),
      'client.js still asks the theme for a token DSH does not define');
    assert(!/var\(--dsw-alias-border-l\b/.test(source),
      'client.js still asks for --dsw-alias-border-l (only l1..l4 exist)');
    assert(menu.style.background.includes('--dsw-specific-menu'),
      `the popover surface is ${menu.style.background}`);
    assert(menu.style.boxShadow.includes('--dsw-elevation-prominent'),
      `the popover shadow is ${menu.style.boxShadow}`);
    assert(menu.style.backdropFilter.includes('--dsw-menu-backdrop-filter'),
      `the popover backdrop is ${menu.style.backdropFilter}`);
  });

  check('the usage hint is collapsed behind a "?" button', () => {
    const hintNodes = (view) => find(view, (element) => element.props?.['data-context-control'] === 'hint');
    const toggleIn = (view) => find(view, (element) => element.props?.['data-context-control'] === 'hint-toggle')[0];
    tree = mount({ type: Pill, props: { sessionId: 's1' } });
    const toggle = toggleIn(tree);
    assert(toggle !== undefined, 'no hint toggle in the popover');
    assert(hintNodes(tree).length === 0, 'the hint paragraph is printed before the button is pressed');
    assert(toggle.props['aria-expanded'] === 'false', `aria-expanded is ${toggle.props['aria-expanded']}`);
    /* It sits in the update row, not on a row of its own with empty space. */
    const footer = find(tree, (element) => element.props?.['data-context-control'] === 'update')[0];
    assert(find(footer, (element) => element === toggle).length === 1,
      'the "?" button is not part of the update row');
    /* The update controls read left to right from the version outwards, and
     * only the "?" is pushed to the far right: an auto margin on anything else
     * would tear the version away from the button that acts on it. */
    const updateRow = find(tree, (element) => element.props?.['data-context-control'] === 'update-row')[0];
    assert(textOfNode(updateRow.children[0]).startsWith('v'),
      `the update row starts with ${textOfNode(updateRow.children[0])}`);
    assert(updateRow.children.at(-1) === toggle, 'the "?" is not the last control in the row');
    assert(toggle.props.style.marginLeft === 'auto', `the "?" margin is ${toggle.props.style.marginLeft}`);

    toggle.props.onClick();
    tree = mount({ type: Pill, props: { sessionId: 's1' } });
    const opened = hintNodes(tree)[0];
    assert(opened !== undefined, 'pressing "?" did not reveal the hint');
    const hintText = textOfNode(opened);
    /* Written prose, not shorthand: it has to state when a change lands. */
    assert(hintText.includes('会话级设置优先'), `hint reads "${hintText}"`);
    assert(hintText.includes('下次模型请求时生效'), `hint does not say when a change lands: "${hintText}"`);
    /* The third state and the gesture that reaches it are explained here or
     * nowhere: the dots carry no hover card. */
    assert(hintText.includes('跟随状态') && hintText.includes('取消钉住'), `hint does not explain unpinning: "${hintText}"`);
    assert(hintText.split('\n').length === 5, `hint is ${hintText.split('\n').length} lines`);
    assert(opened.props.style.whiteSpace === 'pre-line', 'the note would collapse into one paragraph');
    assert(toggleIn(tree).props['aria-expanded'] === 'true', 'aria-expanded did not follow the toggle');

    toggleIn(tree).props.onClick();
    tree = mount({ type: Pill, props: { sessionId: 's1' } });
    assert(hintNodes(tree).length === 0, 'pressing "?" again did not collapse the hint');
  });

  check('first row takes focus when the popover opens', () => {
    assert(activeElement === switchesIn(rowOf(tree, 'hivemem'))[0],
      `focus is on ${activeElement?.props?.['aria-label'] ?? activeElement?.tag}`);
  });

  check('ArrowDown moves focus to the same column in the next row', () => {
    const prevented = keydown('ArrowDown');
    assert(prevented, 'ArrowDown was not handled');
    assert(activeElement === switchesIn(rowOf(tree, 'chrome-main'))[0],
      `focus is on ${activeElement?.props?.['aria-label'] ?? activeElement?.tag}`);
  });

  check('ArrowRight and ArrowLeft move between the two switches of one row', () => {
    keydown('ArrowRight');
    assert(activeElement === switchesIn(rowOf(tree, 'chrome-main'))[1], 'ArrowRight did not reach the workspace switch');
    keydown('ArrowLeft');
    assert(activeElement === switchesIn(rowOf(tree, 'chrome-main'))[0], 'ArrowLeft did not return to the session switch');
  });

  check('ArrowDown wraps between rows and keeps the column', () => {
    keydown('ArrowRight');
    keydown('ArrowDown');
    assert(activeElement === switchesIn(rowOf(tree, 'hivemem'))[1],
      `focus is on ${activeElement?.props?.['aria-label'] ?? activeElement?.tag}`);
    keydown('ArrowDown');
    assert(activeElement === switchesIn(rowOf(tree, 'chrome-main'))[1], 'ArrowDown did not wrap forward');
    keydown('ArrowUp');
    assert(activeElement === switchesIn(rowOf(tree, 'hivemem'))[1], 'ArrowUp did not wrap backward');
  });

  /* A toggle is refused while a request is in flight; let open-time load settle. */
  await new Promise((resolve) => setTimeout(resolve, 20));
  tree = mount({ type: Pill, props: { sessionId: 's1' } });
  check('a session switch reaches the host with scope=session', () => {
    const before = remoteCalls.length;
    switchesIn(rowOf(tree, 'chrome-main'))[0].props.onClick();
    const call = remoteCalls[before];
    assert(call !== undefined && call[0] === 'set', 'click did not reach the remote');
    assert(call[1] === 's1' && call[2] === 'mcp' && call[3] === 'chrome-main' && call[4] === true,
      JSON.stringify(call));
    assert(call[5] === 'session', `scope is ${call[5]}`);
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  tree = mount({ type: Pill, props: { sessionId: 's1' } });
  check('a workspace switch reaches the host with scope=workspace', () => {
    const before = remoteCalls.length;
    switchesIn(rowOf(tree, 'chrome-main'))[1].props.onClick();
    const call = remoteCalls[before];
    assert(call !== undefined && call[0] === 'set', 'click did not reach the remote');
    assert(call[1] === 's1' && call[2] === 'mcp' && call[3] === 'chrome-main' && call[4] === true,
      JSON.stringify(call));
    assert(call[5] === 'workspace', `scope is ${call[5]}`);
  });

  /* Unpin: the session switch's third state is entered with the secondary
   * button (or Alt+click), and the host is told scope=follow. */
  await new Promise((resolve) => setTimeout(resolve, 20));
  tree = mount({ type: Pill, props: { sessionId: 's1' } });
  check('right-click unpins a session switch back to the project default', () => {
    const before = remoteCalls.length;
    const session = switchesIn(rowOf(tree, 'hivemem'))[0];
    let prevented = false;
    session.props.onContextMenu({ preventDefault() { prevented = true; } });
    assert(prevented, 'the browser menu was not suppressed');
    const call = remoteCalls[before];
    assert(call !== undefined && call[0] === 'set', 'unpin did not reach the remote');
    assert(call[1] === 's1' && call[2] === 'mcp' && call[3] === 'hivemem', JSON.stringify(call));
    assert(call[5] === 'follow', `scope is ${call[5]}`);
    assert(switchesIn(rowOf(tree, 'hivemem'))[1].props.onContextMenu === undefined,
      'the workspace switch answers the unpin gesture too');
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  tree = mount({ type: Pill, props: { sessionId: 's1' } });
  check('Alt+click unpins instead of toggling', () => {
    const before = remoteCalls.length;
    switchesIn(rowOf(tree, 'hivemem'))[0].props.onClick({ altKey: true });
    const call = remoteCalls[before];
    assert(call !== undefined && call[0] === 'set', 'Alt+click did not reach the remote');
    assert(call[5] === 'follow', `scope is ${call[5]}`);
    /* A plain click on the same dot still pins: toggling is unaffected. */
    assert(switchesIn(rowOf(tree, 'hivemem'))[0].props.onClick.length === 1, 'the click handler lost its event');
  });

  /* Tabs: each kind renders alone, and the strip is reachable with arrows. */
  check('a tab shows only its own kind', () => {
    const tabs = find(tree, (element) => element.props?.['role'] === 'tab');
    tabs[2].props.onClick();
    tree = mount({ type: Pill, props: { sessionId: 's1' } });
    const rows = rowList(tree);
    assert(rows.length === 2, `tools tab rendered ${rows.length} rows`);
    assert(rows.map((row) => row.props['aria-label']).join(',') === 'read,bash',
      `tools tab rendered ${rows.map((row) => row.props['aria-label'])}`);
    assert(switchesIn(rows[0]).length === 2, 'a tools row lost its two switches');
  });

  check('a pinned session dot is bright whether it is on or off', () => {
    const on = switchesIn(rowOf(tree, 'read'));
    const off = switchesIn(rowOf(tree, 'bash'));
    assert(on[0].props['data-context-control-pinned'] === 'true', 'the pinned switch is not marked');
    assert(on[0].props['aria-label'].endsWith('· 会话'), `a pinned switch is named "${on[0].props['aria-label']}"`);
    assert(ringOf(on[0]).props.style.opacity === '1' && ringOf(off[0]).props.style.opacity === '1',
      'a pinned ring is dim');
    assert(dotIn(on[0]) !== undefined && dotIn(off[0]) === undefined, 'the dot does not follow the state');
    assert(ringOf(on[0]).props.style.width === '11px' && ringOf(off[0]).props.style.width === '11px',
      'the ring changes size between states');
  });

  check('Left/Right on the tab strip switches kinds and takes focus', () => {
    const strip = find(tree, (element) => element.props?.['role'] === 'tablist')[0];
    let prevented = false;
    strip.props.onKeyDown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
    assert(prevented, 'ArrowRight on the strip was not handled');
    tree = mount({ type: Pill, props: { sessionId: 's1' } });
    const rows = rowList(tree);
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
    assert(textOf(anchors[0]).includes('组件上下文 3/5'), `pane 1 text is "${textOf(anchors[0])}"`);
    assert(textOf(anchors[1]).includes('组件上下文 1/2'), `pane 2 text is "${textOf(anchors[1])}"`);
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
    const before = remoteCalls.length;
    switchesIn(rowOf(panesTree, 'chrome-p2'))[0].props.onClick();
    const call = remoteCalls[before];
    assert(call !== undefined && call[0] === 'set' && call[1] === 's2', JSON.stringify(call));
    assert(call[5] === 'session', `scope is ${call[5]}`);
  });

  /* The requirement this change exists for: one conversation can override an
   * entry without touching the workspace default, and the pair shows both. */
  await new Promise((resolve) => setTimeout(resolve, 20));
  panesTree = mount(panes());
  check('an entry can be off in this session and on in the workspace', () => {
    const pair = switchesIn(rowOf(panesTree, 'chrome-p2'));
    assert(pair[0].props['aria-checked'] === 'false', `session switch is ${pair[0].props['aria-checked']}`);
    assert(pair[1].props['aria-checked'] === 'true', `workspace switch is ${pair[1].props['aria-checked']}`);
  });

  pointerdown(documentStub.body);
  panesTree = mount(panes());

  check('an outside pointerdown closes the pane popover', () => {
    assert(menusOf(panesTree).length === 0, 'popover survived an outside click');
  });

  /* A host older than 0.7.0 sends no `workspace`; the panel paints both
   * switches from the single state it knows instead of failing the list. */
  innerHeight = 800;
  innerWidth = 1000;
  anchorTop = 120;
  instances = new Map();
  nodeCache.clear();
  activeElement = null;

  const staleMenu = await (async () => {
    const view = mount({ type: Pill, props: { sessionId: 's3' } });
    const anchor = find(view, (element) => element.props?.['data-context-control'] === 'anchor')[0];
    anchor.children[0].props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 40));
    return mount({ type: Pill, props: { sessionId: 's3' } });
  })();

  check('a pre-0.7.0 host still paints both switches', () => {
    /* The popover opens on the first non-empty tab (mcp), which this host
     * fills with one row; the tool row is checked by the same schema path. */
    const rows = rowList(staleMenu);
    assert(rows.length === 1, `got ${rows.length} rows`);
    const pair = switchesIn(rows[0]);
    assert(pair.length === 2, `got ${pair.length} switches`);
    assert(pair[0].props['aria-checked'] === 'true' && pair[1].props['aria-checked'] === 'true',
      `switches are ${pair.map((sw) => sw.props['aria-checked'])}`);
    const rejected = find(staleMenu, (element) => typeof element.text === 'string'
      && (element.text.includes('Expected') || element.text.includes('invalid')));
    assert(rejected.length === 0, `the list was rejected by the client schema: ${rejected.map((element) => element.text)}`);
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
    assert(smallMenu.style.width === 320, `width is ${smallMenu.style.width}`);
    assert(rowList(small).length > 0, 'the shrunken popover lost its rows');
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

  /* The text check button and the ⟳ button would do the same thing in this
   * phase, so the row must show exactly one of them — the text one, which
   * is what the README documents for the up-to-date state. */
  check('an up-to-date row offers one check button, not two', () => {
    const footer = footerOf(updateTree);
    const extra = find(footer, (element) => element.props?.['data-context-control'] === 'update-check');
    assert(extra.length === 0, `the ⟳ button repeats the check action (${extra.length} extra)`);
    assert(textOf(actionOf(footer)) === '检查更新', 'the text check button is missing');
  });

  /* A check that the host answers from its cache takes milliseconds; without
   * an immediate busy state the click looks like it did nothing. */
  check('clicking check enters the checking phase before the answer lands', () => {
    actionOf(updateTree).props.onClick();
    updateTree = mount({ type: Pill, props: { sessionId: 's1' } });
    const action = actionOf(updateTree);
    assert(action.props['data-context-control-phase'] === 'checking',
      `phase right after the click is ${action.props['data-context-control-phase']}`);
    assert(textOf(action).includes('检查中'), `action reads "${textOf(action)}"`);
    const spinner = find(action, (element) => element.props?.style?.animation !== undefined);
    assert(spinner.length === 1, `the busy button shows ${spinner.length} spinners`);
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  updateTree = mount({ type: Pill, props: { sessionId: 's1' } });

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
    assert(textOf(badge).includes('组件上下文 3/5'), `pill text changed: "${textOf(badge)}"`);
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

  check('a finished install tells the user to restart dsh web, without offering to do it', () => {
    const action = actionOf(updateTree);
    assert(textOf(action) === '检查更新', `action reads ${textOf(action)}`);
    assert(textOf(updateTree).includes('重启 dsh web'), 'the restart hint is missing');
    assert(!textOf(updateTree).includes('重启服务'), 'the old restart button is still rendered');
    assert(!fetchCalls.some(([method, path]) => method === 'POST' && path.startsWith('/update/restart')),
      'the client asked the host to restart itself');
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
  /* After a finished install the action button is the check request (and the
   * ⟳ is hidden to avoid a duplicate), so re-ask through it. */
  actionOf(staleTree).props.onClick();
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

  /* A page opened after the install but before the host restart: the files
   * name 0.3.0 while the running module is still 0.2.1. That is a restart
   * hint, not "up to date", and not a page reload — a reload cannot load
   * host-side code. */
  fetchMode = 'stale-install';
  instances = new Map();
  nodeCache.clear();
  const InstalledPill = await reloadPage();
  let installedTree = mount({ type: InstalledPill, props: { sessionId: 's1' } });
  await new Promise((resolve) => setTimeout(resolve, 80));
  installedTree = mount({ type: InstalledPill, props: { sessionId: 's1' } });
  const installedAnchor = find(installedTree, (element) => element.props?.['data-context-control'] === 'anchor')[0];
  installedAnchor.children[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 40));
  installedTree = mount({ type: InstalledPill, props: { sessionId: 's1' } });

  check('an install the host has not loaded yet reads as a restart hint, not as current', () => {
    const action = actionOf(installedTree);
    assert(action.props['data-context-control-phase'] === 'upgraded',
      `phase is ${action.props['data-context-control-phase']}`);
    assert(textOf(installedTree).includes('重启 dsh web'), 'the restart hint is missing');
    assert(!textOf(installedTree).includes('已是最新'), 'a stale module rendered as up to date');
    assert(textOf(action) === '检查更新', `action reads ${textOf(action)} (a reload cannot load host code)`);
    assert(!fetchCalls.some(([method, path]) => method === 'POST' && path.startsWith('/update/restart')),
      'the client asked the host to restart itself');
  });

  console.log(results.join('\n'));
  const failed = results.filter((line) => line.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error('HARNESS ERROR:', error);
  process.exit(2);
});
