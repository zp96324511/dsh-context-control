/**
 * dsh-context-control — Client half.
 *
 * A compact panel in the composer dock: a pill showing how many MCP servers,
 * skills and built-in tools are enabled for the current session; expanded,
 * one row per entry with its origin badge (official / user-configured), a
 * one-line description and two switches — 会话 (this conversation only) and
 * 工作区 (this workspace's default, inherited by sessions started here later).
 * Toggling calls the Host service over the Typert Gateway
 * (`remote.contextControl`), the same operations the `context_control` agent
 * tool uses. The workspace switch is what the panel used to do always; the
 * session switch is the new per-conversation override, so two sessions in one
 * workspace no longer drag each other around.
 *
 * Each pill is session-scoped: the `conversation.input.left` slot hands it the
 * `sessionId` of the composer it sits in, so every composer on screen — the
 * regular view's, and every mixer channel's — reports and toggles its own
 * Session. The open flag is per pill instance, so clicking one composer's pill
 * never opens the popover in another pane.
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-control',
  factory(require) {
    const React = require('react');
    const { createPortal } = require('react-dom');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;
    const zod = require('zod');

    /* Client-side descriptor contribution for the Host's contextControl
     * service. The Gateway only creates `remote.<namespace>` services from
     * mounted contributions (`ctx.remote.$mount`), so a plugin's client half
     * must mount its own; without this the panel's inject on
     * `remote.contextControl` parks forever ("waiting for service"). Shape
     * mirrors the Host half's ContextControlRemote: list(sessionId) and
     * set(sessionId, kind, target, enabled, scope). `scope` is optional on the
     * wire (acceptsUndefined) so a client bundle older than this one — or a
     * newer host serving an older page — still speaks the same method.
     *
     * `workspace` on every listed entry is the workspace default, so the panel
     * can paint both switches; `enabled` stays the session's own state. A host
     * older than 0.7.0 does not send it: it predates the split, so its single
     * switch was the workspace one, and the panel mirrors `enabled` into the
     * workspace switch instead of failing the whole list. */
    const entrySchema = {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['mcp', 'skill', 'tool'] },
        name: { type: 'string' },
        enabled: { type: 'boolean' },
        workspace: { type: 'boolean' },
        official: { type: 'boolean' },
        detail: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['kind', 'name', 'enabled', 'official', 'detail'],
      additionalProperties: false,
    };
    const entryZod = (kind) => zod.object({
      kind: zod.literal(kind),
      name: zod.string(),
      enabled: zod.boolean(),
      workspace: zod.boolean().optional(),
      official: zod.boolean(),
      detail: zod.string(),
      description: zod.string().optional(),
    });
    const listResultSchema = () => zod.object({
      sessionId: zod.string(),
      cwd: zod.string(),
      mcp: zod.array(entryZod('mcp')),
      skills: zod.array(entryZod('skill')),
      tools: zod.array(entryZod('tool')),
    });
    const setResultSchema = () => zod.object({
      ok: zod.boolean(),
      reason: zod.string().optional(),
      kind: zod.string().optional(),
      name: zod.string().optional(),
      enabled: zod.boolean().optional(),
      scope: zod.enum(['session', 'workspace']).optional(),
      note: zod.string().optional(),
    });
    const stringParam = (description) => ({
      name: 'sessionId',
      description,
      source: 'json',
      wire: 'sessionId',
      codec: { mode: 'strict', typeSymbol: 'dsh-context-control#sessionId', create: () => zod.string(), jsonSchema: { type: 'string' } },
      strictCodec: { mode: 'strict', typeSymbol: 'dsh-context-control#sessionId', create: () => zod.string(), jsonSchema: { type: 'string' } },
    });
    const CONTEXT_CONTROL_CONTRIBUTION = {
      package: 'dsh-context-control',
      descriptors: [
        {
          id: 'dsh-context-control#contextControl/list',
          namespace: 'contextControl',
          method: 'list',
          service: 'contextControl',
          description: 'List this session\'s MCP servers, skills and built-in tools with origin and enabled state.',
          invocation: { kind: 'direct' },
          parameters: [stringParam('session to read the gating state for')],
          result: {
            mode: 'strict',
            typeSymbol: 'dsh-context-control#contextControl/list:result',
            create: listResultSchema,
            description: 'per-session gating state: enabled sets plus per-entry origin and detail.',
            jsonSchema: {
              type: 'object',
              properties: {
                sessionId: { type: 'string' },
                cwd: { type: 'string' },
                mcp: { type: 'array', items: entrySchema },
                skills: { type: 'array', items: entrySchema },
                tools: { type: 'array', items: entrySchema },
              },
              required: ['sessionId', 'cwd', 'mcp', 'skills', 'tools'],
              additionalProperties: false,
            },
          },
        },
        {
          id: 'dsh-context-control#contextControl/set',
          namespace: 'contextControl',
          method: 'set',
          service: 'contextControl',
          description: 'Enable or disable one MCP server, skill or built-in tool, for this session or as this workspace\'s default.',
          invocation: { kind: 'direct' },
          parameters: [
            stringParam('session to modify'),
            {
              name: 'kind',
              description: 'entry kind: mcp, skill or tool.',
              source: 'json',
              wire: 'kind',
              codec: { mode: 'strict', typeSymbol: 'dsh-context-control#kind', create: () => zod.enum(['mcp', 'skill', 'tool']), jsonSchema: { type: 'string', enum: ['mcp', 'skill', 'tool'] } },
              strictCodec: { mode: 'strict', typeSymbol: 'dsh-context-control#kind', create: () => zod.enum(['mcp', 'skill', 'tool']), jsonSchema: { type: 'string', enum: ['mcp', 'skill', 'tool'] } },
            },
            {
              name: 'target',
              description: 'MCP server, skill or tool name to toggle.',
              source: 'json',
              wire: 'target',
              codec: { mode: 'strict', typeSymbol: 'dsh-context-control#target', create: () => zod.string(), jsonSchema: { type: 'string' } },
              strictCodec: { mode: 'strict', typeSymbol: 'dsh-context-control#target', create: () => zod.string(), jsonSchema: { type: 'string' } },
            },
            {
              name: 'enabled',
              description: 'next state for the entry.',
              source: 'json',
              wire: 'enabled',
              codec: { mode: 'strict', typeSymbol: 'dsh-context-control#enabled', create: () => zod.boolean(), jsonSchema: { type: 'boolean' } },
              strictCodec: { mode: 'strict', typeSymbol: 'dsh-context-control#enabled', create: () => zod.boolean(), jsonSchema: { type: 'boolean' } },
            },
            {
              name: 'scope',
              description: 'where the choice applies: session (default) or workspace.',
              source: 'json',
              wire: 'scope',
              /* Optional on the wire: an older client bundle sends four
               * arguments and means session-only. */
              acceptsUndefined: true,
              codec: { mode: 'strict', typeSymbol: 'dsh-context-control#scope', create: () => zod.enum(['session', 'workspace']), jsonSchema: { type: 'string', enum: ['session', 'workspace'] } },
              strictCodec: { mode: 'strict', typeSymbol: 'dsh-context-control#scope', create: () => zod.enum(['session', 'workspace']), jsonSchema: { type: 'string', enum: ['session', 'workspace'] } },
            },
          ],
          result: {
            mode: 'strict',
            typeSymbol: 'dsh-context-control#contextControl/set:result',
            create: setResultSchema,
            description: 'ok plus the changed entry and its scope, or ok=false with a reason.',
            jsonSchema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                reason: { type: 'string' },
                kind: { type: 'string' },
                name: { type: 'string' },
                enabled: { type: 'boolean' },
                scope: { type: 'string', enum: ['session', 'workspace'] },
                note: { type: 'string' },
              },
              required: ['ok'],
              additionalProperties: false,
            },
          },
        },
      ],
    };

    const DICT = {
      zh: {
        panel: '组件上下文',
        none: '无 MCP 服务器、技能或工具',
        mcp: 'MCP',
        skill: 'Skill',
        tool: '工具',
        official: '官方',
        custom: '自配',
        scopeSession: '会话',
        scopeWorkspace: '工作区',
        scopeSessionTitle: '会话级：只影响本会话；重新打开本会话（含重启后）仍是这个状态，归档后恢复则重新继承工作区',
        scopeWorkspaceTitle: '工作区级：写入本项目默认值；本会话没有自己的选择时立即生效，新会话继承',
        hint: '每个条目两个开关，会话级优先：「会话」只影响本会话，重新打开本会话仍保留（归档后恢复重新继承工作区）；「工作区」写入项目默认值，新会话继承（下次请求生效）',
        on: '已启用：',
        busy: '…',
        checkUpdate: '检查更新',
        checking: '检查中…',
        upToDate: '已是最新',
        available: '可升级',
        upgrade: '一键升级',
        upgrading: '升级中…',
        upgraded: '已升级',
        upgradedHint: '已升级，重启 dsh web 后生效',
        reload: '刷新页面',
        failed: '升级失败',
        retry: '重试',
        details: '详情',
        hideDetails: '收起',
        updateUnavailable: '升级不可用',
        updateLocal: '本地安装，不提供在线升级',
        updateError: '检查失败',
        hostStale: '宿主仍在运行旧版插件（升级接口 404）——重启 dsh web 后可用',
        updateAvailableTip: '有新版本',
        reloadHint: '已升级，刷新后生效',
        compatible: '与当前 DSH 兼容',
        incompatible: '与当前 DSH 不兼容',
      },
      en: {
        panel: 'Components',
        none: 'No MCP servers, skills or tools',
        mcp: 'MCP',
        skill: 'Skill',
        tool: 'Tools',
        official: 'official',
        custom: 'custom',
        scopeSession: 'session',
        scopeWorkspace: 'workspace',
        scopeSessionTitle: 'session scope: this conversation only, kept when it is reopened (a conversation restored from the archive starts from the workspace again)',
        scopeWorkspaceTitle: 'workspace scope: saved as this workspace\u2019s default; applied here when this conversation has no choice of its own, inherited by new sessions',
        hint: 'Two switches per entry, session first: \u201csession\u201d affects this conversation only and survives reopening it (restoring it from the archive starts from the workspace); \u201cworkspace\u201d writes the project default that new sessions inherit (effective on the next request)',
        on: 'Enabled: ',
        busy: '…',
        checkUpdate: 'Check for updates',
        checking: 'Checking…',
        upToDate: 'Up to date',
        available: 'Update',
        upgrade: 'Upgrade',
        upgrading: 'Upgrading…',
        upgraded: 'Upgraded',
        upgradedHint: 'Upgraded — restart dsh web to apply',
        reload: 'Reload',
        failed: 'Upgrade failed',
        retry: 'Retry',
        details: 'Details',
        hideDetails: 'Hide',
        updateUnavailable: 'Updates unavailable',
        updateLocal: 'Local install — no online upgrade',
        updateError: 'Check failed',
        hostStale: 'the host still runs the old plugin (route 404) — restart dsh web',
        updateAvailableTip: 'update available',
        reloadHint: 'upgraded — reload to apply',
        compatible: 'compatible with this DSH',
        incompatible: 'incompatible with this DSH',
      },
    };

    const CSS = {
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: '4px',
        alignSelf: 'center', whiteSpace: 'nowrap',
        border: `1px solid var(--dsw-alias-border-l, rgba(128,128,128,.35))`,
        borderRadius: '999px', padding: '0 9px',
        fontSize: '12px', lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        background: 'transparent', cursor: 'pointer',
      },
      anchor: {
        position: 'relative', display: 'inline-flex', alignItems: 'center',
      },
      menu: {
        position: 'fixed', zIndex: 80,
        maxHeight: '320px', overflow: 'hidden',
        overscrollBehavior: 'contain',
        padding: '6px',
        display: 'flex', flexDirection: 'column', gap: '1px',
        background: 'var(--dsw-alias-bg-elevated, #232326)',
        border: `1px solid var(--dsw-alias-border-l, rgba(128,128,128,.35))`,
        borderRadius: '10px',
        boxShadow: '0 10px 28px rgba(0,0,0,.38), 0 2px 8px rgba(0,0,0,.28)',
      },
      /* One tab per kind instead of three stacked groups: with every kind
       * populated the list no longer fits above the composer, and the counts
       * stay readable at a glance. */
      tabBar: {
        display: 'flex', gap: '2px', flex: 'none',
        padding: '2px', marginBottom: '2px',
        background: 'rgba(128,128,128,.10)',
        borderRadius: '8px',
      },
      tab: {
        flex: '1 1 0', minWidth: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0',
        padding: '3px 4px', border: 'none', borderRadius: '6px',
        background: 'transparent', cursor: 'pointer',
        color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.6))',
      },
      tabOn: {
        background: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18))',
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      tabLabel: {
        fontSize: '11px', lineHeight: '15px', maxWidth: '100%',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      tabSub: {
        fontSize: '10px', lineHeight: '13px', maxWidth: '100%',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      tabBody: {
        display: 'flex', flexDirection: 'column', gap: '1px',
        flex: '1 1 auto', minHeight: 0, overflowY: 'auto',
        overscrollBehavior: 'contain',
      },
      menuRow: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '8px', width: '100%',
        padding: '5px 8px', borderRadius: '6px',
        fontSize: '12px', lineHeight: '18px', textAlign: 'left',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      menuRowOn: {
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      menuRowMain: {
        display: 'flex', flexDirection: 'column', alignItems: 'stretch',
        gap: '1px', flex: '1 1 auto', minWidth: 0,
      },
      menuTop: {
        display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0,
      },
      menuName: {
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      menuDesc: {
        fontSize: '10px', lineHeight: '13px', maxWidth: '100%',
        color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.6))',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      /* The two scope switches sit at the end of each row, side by side: a
       * filled one is on, a hollow one is off. Same pill shape at the same
       * height, so a row reads as one line whatever is on. */
      switches: {
        display: 'inline-flex', alignItems: 'center', gap: '3px', flex: 'none',
      },
      scopeSwitch: {
        minWidth: '38px', padding: '0 6px',
        border: `1px solid var(--dsw-alias-border-l, rgba(128,128,128,.35))`,
        borderRadius: '6px', background: 'transparent', cursor: 'pointer',
        fontSize: '10px', lineHeight: '17px', fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.6))',
        transition: 'background 80ms ease-out, border-color 80ms ease-out, color 80ms ease-out',
      },
      scopeSwitchOn: {
        borderColor: 'var(--dsw-alias-state-business-primary, #247bbf)',
        background: 'rgba(36,123,191,.14)',
        color: 'var(--dsw-alias-state-business-primary, #247bbf)',
      },
      badge: {
        fontSize: '10px', lineHeight: '12px', flex: 'none',
        color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.6))',
      },
      hint: {
        padding: '4px 8px 2px',
        fontSize: '11px', lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.6))',
      },
      error: {
        padding: '4px 8px',
        fontSize: '11px', lineHeight: '16px',
        color: 'var(--dsw-alias-state-error-primary, #d33)',
      },
      updateDot: {
        fontSize: '10px', lineHeight: '12px', flex: 'none',
        color: 'var(--dsw-alias-state-business-primary, #247bbf)',
      },
      footer: {
        display: 'flex', flexDirection: 'column', gap: '2px',
        marginTop: '2px', paddingTop: '4px',
        borderTop: `1px solid var(--dsw-alias-border-l, rgba(128,128,128,.25))`,
      },
      footerRow: {
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '2px 8px',
        fontSize: '11px', lineHeight: '16px',
      },
      version: {
        flex: 'none',
        color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.6))',
        fontVariantNumeric: 'tabular-nums',
      },
      footerNote: {
        flex: '1 1 auto', minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.6))',
      },
      footerNoteActive: {
        color: 'var(--dsw-alias-state-business-primary, #247bbf)',
      },
      footerNoteError: {
        color: 'var(--dsw-alias-state-error-primary, #d33)',
      },
      footerButton: {
        flex: 'none',
        border: `1px solid var(--dsw-alias-border-l, rgba(128,128,128,.35))`,
        borderRadius: '6px', padding: '0 6px',
        fontSize: '11px', lineHeight: '18px',
        background: 'transparent', cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      footerButtonBusy: {
        cursor: 'default',
        opacity: '.6',
      },
      log: {
        maxHeight: '96px', overflow: 'auto', margin: '0 8px 2px',
        padding: '4px 6px', borderRadius: '6px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '10px', lineHeight: '14px',
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: 'var(--dsw-alias-bg-sunken, rgba(128,128,128,.12))',
        color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.8))',
      },
    };

    /* No `remote.contextControl` in the static inject: this module itself
     * mounts that namespace, so waiting for it in inject would deadlock the
     * fiber (apply never runs until inject resolves, but the service only
     * exists once apply runs). `remote` alone is injected; the namespace is
     * reached through it after the mount below. */
    return {
      inject: ['slots', 'sessions', 'locale', 'remote'],
      async apply(ctx) {
        /* Mount the descriptor contribution: this is what creates the
         * remote.contextControl namespace service. */
        const unmount = await ctx.remote.$mount(CONTEXT_CONTROL_CONTRIBUTION);
        /* Read the service through ctx.get(): the property form
         * (ctx.remote.contextControl) is gated by static inject, and this
         * plugin creates the service itself, so it cannot list it statically. */
        const remoteContextControl = ctx.get('remote.contextControl');
        if (remoteContextControl === undefined) {
          throw new Error('dsh-context-control: remote.contextControl namespace did not materialize after $mount');
        }

        let t = (key) => DICT.zh[key] ?? key;
        try {
          ctx.locale.register('contextControl', 'zh', DICT.zh);
          ctx.locale.register('contextControl', 'en', DICT.en);
          const bound = ctx.locale.bind('contextControl');
          if (typeof bound === 'function') t = bound;
        } catch { /* locale service unavailable: bilingual fallback above */ }

        /* ---- Session-scoped state ----
         * The pill is mounted once per on-screen Session: the regular view has
         * one composer, the mixer puts several side by side. Its Session comes
         * from the `sessionId` prop the session-scoped `conversation.input.left`
         * slot injects (ui-session's builtin session source), so gating state is
         * keyed by Session and the open flag lives in the pill instance that was
         * clicked. One store shared by every composer — the earlier design —
         * made one click open the popover in every pane and made every pane
         * report the main-view Session. */
        function createSessionState() {
          let snapshot = { data: undefined, busy: false, error: undefined };
          const subscribers = new Set();
          return {
            get: () => snapshot,
            subscribe(fn) {
              subscribers.add(fn);
              return () => { subscribers.delete(fn); };
            },
            patch(part) {
              snapshot = { ...snapshot, ...part };
              for (const fn of [...subscribers]) fn();
            },
          };
        }
        /** sessionId -> gating state for that Session, shared by its pill instances. */
        const sessionStates = new Map();
        function stateFor(sessionId) {
          let state = sessionStates.get(sessionId);
          if (state === undefined) {
            state = createSessionState();
            sessionStates.set(sessionId, state);
          }
          return state;
        }

        /** Fetch one Session's gating state; skips only while another fetch is in flight. */
        async function loadState(state, sessionId) {
          if (state.get().busy) return;
          state.patch({ busy: true, error: undefined });
          try {
            /* Remote calls resolve to the gateway envelope {ok, value|error}. */
            const result = await remoteContextControl.list(sessionId);
            if (!result.ok) throw new Error(result.error?.message ?? 'contextControl/list failed');
            state.patch({ data: result.value, busy: false });
          } catch (cause) {
            state.patch({ error: String(cause?.message ?? cause), busy: false });
          }
        }

        /**
         * Toggle one entry for one Session, then refresh that Session's state.
         * `scope` is 'session' (this conversation only) or 'workspace' (write
         * the project default — the host also applies it to this session, so
         * the refetch shows both switches moved).
         */
        async function toggleState(state, sessionId, kind, name, next, scope) {
          if (state.get().busy) return;
          state.patch({ busy: true, error: undefined });
          try {
            const outcome = await remoteContextControl.set(sessionId, kind, name, next, scope);
            if (!outcome.ok) throw new Error(outcome.error?.message ?? 'contextControl/set failed');
            if (outcome.value?.ok === false) throw new Error(outcome.value.reason ?? 'contextControl/set refused');
            state.patch({ busy: false });
            await loadState(state, sessionId);
          } catch (cause) {
            state.patch({ error: String(cause?.message ?? cause), busy: false });
          }
        }

        /** Subscribe one pill to its Session's state and load it on mount. */
        function useSessionState(sessionId) {
          const state = stateFor(sessionId);
          const [snapshot, setSnapshot] = useState(state.get());
          useEffect(() => {
            setSnapshot(state.get());
            return state.subscribe(() => setSnapshot(state.get()));
          }, [state]);
          useEffect(() => {
            void loadState(state, sessionId);
          }, [state, sessionId]);
          return { state, snapshot };
        }

        /* ---- update channel ----
         * One row in the popover about this plugin itself: which version is
         * installed, whether the channel it was installed from has a newer
         * one, and one button that does whatever the current phase needs
         * (check → upgrade → reload). Restarting the host is deliberately not
         * offered: the plugin does not know how the user started it.
         *
         * This state is deliberately shared by every pane, unlike the gating
         * toggles: "which version is installed" is a property of the host, not
         * of a Session or of a composer instance, so a mixer with three panes
         * must show the same answer three times. The popover's `open` flag and
         * the log toggle stay component state, as everywhere else here. */
        const UPDATE_ROOT = (() => {
          try {
            const root = new URL('.', document.baseURI || location.href).pathname || '/'
            return `${root.charAt(root.length - 1) === '/' ? root.replace(/\/$/, '') : root}/plugins/dsh-context-control`
          } catch {
            return '/plugins/dsh-context-control'
          }
        })()
        const UPDATE_POLL_MS = 1200
        const UPDATE_POLL_LIMIT_MS = 20 * 60 * 1000
        const RECHECK_MS = 30 * 60 * 1000

        function createUpdateStore() {
          let snapshot = { phase: 'idle', info: undefined, job: undefined, error: undefined }
          const subscribers = new Set()
          return {
            get: () => snapshot,
            subscribe(fn) {
              subscribers.add(fn)
              return () => { subscribers.delete(fn) }
            },
            set(patch) {
              snapshot = { ...snapshot, ...patch }
              for (const fn of [...subscribers]) {
                try { fn(snapshot) } catch { /* one bad subscriber must not stop the rest */ }
              }
            },
          }
        }
        const updateStore = createUpdateStore()
        let updateInFlight = false
        let updatePollTimer = null
        let updatePollDeadline = 0
        let updateAutoStarted = false
        let updateRecheckTimer = null
        /* The version this page first saw. A tab left open across an upgrade —
         * the phone case — must not keep running yesterday's bundle: when the
         * host starts serving a different version, the row offers a reload
         * instead of pretending everything is current. */
        let bootVersion

        async function updateRequest(path, { method = 'GET', body } = {}) {
          if (typeof fetch !== 'function') throw new Error('fetch is unavailable in this page')
          const response = await fetch(`${UPDATE_ROOT}${path}`, {
            method,
            cache: 'no-store',
            credentials: 'same-origin',
            headers: body === undefined
              ? { accept: 'application/json' }
              : { accept: 'application/json', 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
          const text = await response.text()
          /* A non-OK response is not an answer. The one real case: the page
           * runs the new client bundle (the host serves it from disk) while
           * the process still runs the old host half, so every update route
           * answers 404 with an empty body — which parsed as {} and rendered
           * as "up to date" with no version, the exact opposite of the truth.
           * Name the situation instead of guessing. */
          if (!response.ok) {
            if (response.status === 404) throw new Error(t('hostStale'))
            throw new Error(`HTTP ${response.status}`)
          }
          let parsed
          try { parsed = text === '' ? {} : JSON.parse(text) } catch { throw new Error(`unexpected response: ${text.slice(0, 140)}`) }
          return parsed
        }

        /* Ask the host (which caches the channel answer) and fold the result
         * into the phase the button follows. A channel that cannot answer is
         * `unavailable`, not "up to date": the difference decides whether the
         * user keeps trusting the badge. */
        async function refreshUpdate({ force = false } = {}) {
          if (updateInFlight) return
          updateInFlight = true
          if (updateStore.get().info === undefined) updateStore.set({ phase: 'checking' })
          try {
            const info = await updateRequest(`/update${force ? '?force=1' : ''}`)
            /* A 200 whose body is not our check result (a proxy page, an
             * auth redirect) must never pass for "current": only a payload
             * that names its version is an answer. */
            if (typeof info?.current !== 'string') {
              updateStore.set({ phase: 'error', info: undefined, error: t('updateError'), job: undefined })
              return
            }
            if (bootVersion === undefined) bootVersion = info.current
            /* A page that outlived a restart of the host sees a different
             * version from the one it booted with. A page that outlived only
             * the *install* sees the same split while the module on disk is
             * not the module the host loaded (`stale`): that is a restart
             * hint, not a page reload. */
            const reloadNeeded = bootVersion !== undefined && info.current !== bootVersion && info.stale !== true
            if (reloadNeeded) {
              updateStore.set({ phase: 'reload', info, error: undefined, job: updateStore.get().job })
            } else if (info?.stale === true) {
              updateStore.set({ phase: 'upgraded', info, error: undefined, job: updateStore.get().job })
            } else if (info?.channel?.kind === 'local' || info?.channel?.kind === 'git') {
              updateStore.set({ phase: 'unavailable', info, error: info.error, job: undefined })
            } else if (info?.error !== undefined && info?.hasUpdate !== true) {
              updateStore.set({ phase: 'error', info, error: String(info.error), job: undefined })
            } else {
              updateStore.set({ phase: info?.hasUpdate === true ? 'available' : 'current', info, job: undefined })
            }
          } catch (cause) {
            updateStore.set({ phase: 'error', error: String(cause?.message ?? cause), job: undefined })
          } finally {
            updateInFlight = false
          }
        }

        function stopUpdatePolling() {
          if (updatePollTimer !== null) {
            clearTimeout(updatePollTimer)
            updatePollTimer = null
          }
        }

        /* Follow the install until it settles. The host keeps the job (and its
         * log) after it finishes, so a page that was reloaded mid-install can
         * still read the outcome with one GET. */
        function pollUpdateJob() {
          stopUpdatePolling()
          updatePollDeadline = Date.now() + UPDATE_POLL_LIMIT_MS
          const tick = async () => {
            try {
              const job = await updateRequest('/update/job')
              updateStore.set({ job })
              if (job?.state === 'running') {
                if (Date.now() > updatePollDeadline) {
                  updateStore.set({ phase: 'error', error: 'the install did not finish in time' })
                  return
                }
                updatePollTimer = setTimeout(() => { void tick() }, UPDATE_POLL_MS)
                return
              }
              if (job?.state === 'done') {
                updateStore.set({ phase: 'upgraded', error: job.error, info: { ...(updateStore.get().info ?? {}), current: job.installed ?? updateStore.get().info?.current } })
                return
              }
              updateStore.set({ phase: 'error', error: job?.error ?? 'the install stopped' })
            } catch (cause) {
              updateStore.set({ phase: 'error', error: String(cause?.message ?? cause) })
            }
          }
          void tick()
        }

        async function startUpgrade() {
          const info = updateStore.get().info
          updateStore.set({ phase: 'upgrading', error: undefined, job: undefined })
          try {
            const result = await updateRequest('/update/upgrade', {
              method: 'POST',
              body: { version: info?.latest },
            })
            if (result?.ok !== true) {
              updateStore.set({ phase: 'error', error: String(result?.error ?? result?.reason ?? 'upgrade refused') })
              return
            }
            updateStore.set({ job: result.job })
            pollUpdateJob()
          } catch (cause) {
            updateStore.set({ phase: 'error', error: String(cause?.message ?? cause) })
          }
        }

        /* The old page keeps running old code until the *user* restarts the
         * host; the row only says so. Reloading the page is a separate act
         * (only useful once the host is back with the new module). */
        function reloadPage() {
          if (typeof location !== 'undefined' && typeof location.reload === 'function') location.reload()
        }

        /* One check per page load, then one every half hour while visible —
         * the case this exists for is a phone tab left open for days. */
        function autoStartUpdateCheck() {
          if (updateAutoStarted || typeof fetch !== 'function') return
          updateAutoStarted = true
          void refreshUpdate({ force: false })
          try {
            updateRecheckTimer = setInterval(() => {
              if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
              const phase = updateStore.get().phase
              if (phase === 'idle' || phase === 'current' || phase === 'available') void refreshUpdate({ force: true })
            }, RECHECK_MS)
          } catch { /* no timers: the manual check still works */ }
        }

        function useUpdateState() {
          const [, bump] = useState(0)
          useEffect(() => {
            const unsubscribe = updateStore.subscribe(() => bump((count) => count + 1))
            return () => { unsubscribe() }
          }, [])
          return updateStore.get()
        }

        /* The footer's one button. What it does is decided by the phase, so a
         * user never has to know which step of an upgrade they are looking at:
         * the label names the step and the click takes it. */
        function updateAction(update) {
          const info = update.info
          switch (update.phase) {
            case 'checking':
              return { label: t('checking'), busy: true }
            case 'available':
              return { label: t('upgrade'), onClick: () => { void startUpgrade() } }
            case 'upgrading':
              return { label: t('upgrading'), busy: true }
            case 'upgraded': {
              /* Only the host knows whether the new code is already live (HMR)
               * or whether the user still has to restart `dsh web`. There is
               * no restart control here on purpose: the host may have been
               * started with arguments a plugin cannot reconstruct, so the
               * note carries the hint and the button is just a re-check. */
              const needsRestart = update.job !== undefined
                ? update.job.restartRequired !== false
                : info?.restartRequired !== false
              return needsRestart
                ? { label: t('checkUpdate'), onClick: () => { void refreshUpdate({ force: true }) } }
                : { label: t('reload'), onClick: reloadPage }
            }
            case 'reload':
              return { label: t('reload'), onClick: reloadPage }
            case 'unavailable':
              /* Clicking re-asks: a checkout that later gained a channel (or a
               * host that came back online) must not need a page reload. */
              return { label: t('updateUnavailable'), onClick: () => { void refreshUpdate({ force: true }) } }
            case 'error':
              return { label: t('retry'), onClick: () => { void refreshUpdate({ force: true }) } }
            case 'current':
              return { label: t('checkUpdate'), onClick: () => { void refreshUpdate({ force: true }) } }
            case 'idle':
            default:
              return { label: t('checkUpdate'), onClick: () => { void refreshUpdate({ force: true }) } }
          }
        }

        function updateNote(update) {
          const info = update.info
          if (update.phase === 'available') return `→ v${info?.latest ?? '?'}${info?.compatible === false ? ` · ${t('incompatible')}` : ''}`
          if (update.phase === 'upgraded') {
            const needsRestart = update.job !== undefined
              ? update.job.restartRequired !== false
              : info?.restartRequired !== false
            return needsRestart ? t('upgradedHint') : t('reloadHint')
          }
          if (update.phase === 'reload') return `v${info?.current ?? '?'} · ${t('reloadHint')}`
          if (update.phase === 'current') return t('upToDate')
          if (update.phase === 'unavailable') return t('updateLocal')
          if (update.phase === 'error') return update.error ?? t('updateError')
          if (update.phase === 'upgrading') return update.job?.phase === 'verify' ? t('upgraded') : ''
          return ''
        }

        function UpdateFooter() {
          const update = useUpdateState()
          const [showLog, setShowLog] = useState(false)
          const info = update.info
          const action = updateAction(update)
          const note = updateNote(update)
          const phase = update.phase
          /* In idle/current the action button below *is* the check request,
           * so a ⟳ beside it would be the same button twice. In every other
           * phase (busy, upgrade, upgrade hint, error) the ⟳ is the one re-ask
           * a stale tab cannot make through that button, so it stays there —
           * the row offers exactly one check action at a time. */
          const checkIsTheAction = action.busy !== true && action.label === t('checkUpdate')
          const noteStyle = phase === 'error'
            ? { ...CSS.footerNote, ...CSS.footerNoteError }
            : phase === 'available' || phase === 'upgraded' || phase === 'upgrading'
              ? { ...CSS.footerNote, ...CSS.footerNoteActive }
              : CSS.footerNote
          const log = update.job?.log
          const tail = typeof log === 'string' && log !== '' ? log.slice(-2400) : undefined
          return h('div', { style: CSS.footer, 'data-context-control': 'update' },
            h('div', { style: CSS.footerRow },
              h('span', { style: CSS.version }, `v${info?.current ?? '—'}`),
              h('span', { style: noteStyle, title: note }, note),
              tail === undefined ? null : h('button', {
                type: 'button',
                'data-context-control': 'update-log-toggle',
                style: CSS.footerButton,
                onClick: () => { setShowLog(!showLog) },
              }, showLog ? t('hideDetails') : t('details')),
              /* Kept in every phase where the action button cannot re-ask —
               * the one thing a stale tab cannot do otherwise. Hidden where
               * the action button already *is* the check request. */
              checkIsTheAction ? null : h('button', {
                type: 'button',
                title: t('checkUpdate'),
                'aria-label': t('checkUpdate'),
                'data-context-control': 'update-check',
                style: CSS.footerButton,
                onClick: () => { void refreshUpdate({ force: true }) },
              }, '⟳'),
              h('button', {
                type: 'button',
                'data-context-control': 'update-action',
                'data-context-control-phase': phase,
                'aria-disabled': action.busy === true ? 'true' : 'false',
                style: action.busy === true ? { ...CSS.footerButton, ...CSS.footerButtonBusy } : CSS.footerButton,
                /* Not `disabled`: a disabled focused button loses keyboard
                 * focus, and this row is keyboard-reachable. */
                onClick: () => {
                  if (action.busy === true) return
                  if (typeof action.onClick === 'function') action.onClick()
                },
              }, action.label),
            ),
            showLog && tail !== undefined
              ? h('div', { style: CSS.log, 'data-context-control': 'update-log' }, tail)
              : null,
          )
        }


        /* Tooltip for the collapsed pill: the usage hint plus what is on right
         * now, so the current surface is readable without opening the popover.
         * A pending update adds one line — the badge exists to be noticed from
         * the collapsed state, not only after a click. */
        function pillTitle(servers, skills, tools, data) {
          if (data === undefined) return t('hint');
          const on = [...servers, ...skills, ...tools]
            .filter((entry) => entry.enabled)
            .map((entry) => entry.name);
          return on.length === 0 ? t('hint') : `${t('hint')}\n${t('on')}${on.join('、')}`;
        }

        /* Collapsed pill in the composer tool row, right of the permission
         * seat. Clicking it opens a context-menu style popover anchored to
         * the pill (portal into body, fixed coordinates above the anchor).
         *
         * Every composer owns its own pill instance, so the popover belongs to
         * the instance that was clicked: `open` is component state, never the
         * shared Session state. The Session itself arrives as a prop from the
         * slot's `session` scope. */
        function ContextPill(props) {
          const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined;
          /* No Session, nothing to gate: the host only renders this slot for a
           * Session-backed composer, so this is a defensive branch. */
          if (sessionId === undefined) return null;
          /* Keyed by Session: a pane that switches Sessions remounts the pill
           * instead of briefly showing the previous Session's counts. */
          return h(SessionPill, { key: sessionId, sessionId });
        }

        function SessionPill(props) {
          const { sessionId } = props;
          const { state, snapshot } = useSessionState(sessionId);
          const update = useUpdateState();
          const [open, setOpen] = useState(false);
          const anchorRef = useRef(null);
          const servers = snapshot.data?.mcp ?? [];
          const skills = snapshot.data?.skills ?? [];
          const tools = snapshot.data?.tools ?? [];
          /* Mounted by whichever pill renders first; the store is shared, so
           * the other panes reuse the same answer instead of re-asking. */
          useEffect(() => { autoStartUpdateCheck() }, []);
          if (snapshot.data !== undefined && servers.length === 0 && skills.length === 0 && tools.length === 0) return null;
          const enabledOf = (entries) => entries.filter((entry) => entry.enabled).length;
          const all = [...servers, ...skills, ...tools];
          const countLabel = `${t('panel')}${snapshot.data === undefined ? '' : ` ${enabledOf(all)}/${all.length}`}${snapshot.busy ? t('busy') : ''}`;
          const close = (restoreFocus) => {
            setOpen(false);
            if (!restoreFocus) return;
            const pill = anchorRef.current?.firstElementChild;
            if (pill !== null && pill !== undefined && typeof pill.focus === 'function') pill.focus();
          };
          const title = update.phase === 'available'
            ? `${pillTitle(servers, skills, tools, snapshot.data)}\n${t('updateAvailableTip')} v${update.info?.latest ?? '?'}`
            : pillTitle(servers, skills, tools, snapshot.data);
          return h('span', { ref: anchorRef, style: CSS.anchor, 'data-context-control': 'anchor' },
            h('button', {
              type: 'button',
              style: CSS.pill,
              title,
              'data-context-control-update': update.phase === 'available' ? 'available' : undefined,
              onClick: () => {
                const next = !open;
                setOpen(next);
                if (next) void loadState(state, sessionId);
              },
              onMouseEnter: (event) => {
                event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))';
              },
              onMouseLeave: (event) => {
                event.currentTarget.style.background = 'transparent';
              },
            },
              countLabel,
              update.phase === 'available'
                ? h('span', { key: '__update', style: CSS.updateDot, 'data-context-control': 'update-dot' }, '↑')
                : null,
            ),
            open ? h(ContextMenu, { anchorRef, state, snapshot, sessionId, onClose: close }) : null,
          );
        }

        /* Context-menu popover: one row per entry, portaled to body so the
         * composer chrome cannot clip it. Closes on outside click / Escape.
         * `snapshot`/`state` are the owning Session's; `onClose` closes only
         * the pill that opened this popover. */
        function ContextMenu(props) {
          const { anchorRef, state, snapshot, sessionId, onClose } = props;
          const menuRef = useRef(null);
          const rowRefs = useRef([]);
          const tabRefs = useRef({});
          /* Which kind's rows are shown. `undefined` means the first non-empty
           * tab, so a session that only has MCP servers still opens useful. */
          const [activeKey, setActiveKey] = useState(undefined);
          /* The document listeners are bound once per anchor, so they reach the
           * current closer through a ref instead of capturing the first one. */
          const onCloseRef = useRef(onClose);
          onCloseRef.current = onClose;
          const [pos, setPos] = useState(undefined);

          useEffect(() => {
            const measure = () => {
              const anchor = anchorRef.current;
              if (anchor === null) return;
              const rect = anchor.getBoundingClientRect();
              /* Wide enough for two scope switches beside a name and a
               * description; capped by the viewport on a phone. */
              const width = Math.min(320, window.innerWidth - 16);
              const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
              /* The popover opens upward from the composer, so its height is capped
               * by the room above the anchor: a short viewport (phone, landscape, a
               * soft keyboard shrinking innerHeight) scrolls the rows instead of
               * pushing the menu off the top of the screen. */
              const maxHeight = Math.max(120, Math.min(320, rect.top - 14));
              setPos({ left, bottom: window.innerHeight - rect.top + 6, width, maxHeight });
            };
            measure();
            window.addEventListener('resize', measure);
            window.visualViewport?.addEventListener('resize', measure);
            window.visualViewport?.addEventListener('scroll', measure);
            document.addEventListener('scroll', measure, true);
            const onPointerDown = (event) => {
              if (menuRef.current !== null && menuRef.current.contains(event.target)) return;
              if (anchorRef.current !== null && anchorRef.current.contains(event.target)) return;
              onCloseRef.current(false);
            };
            /* Rows are groups of two scope switches: up/down walks rows and
             * keeps the column (session stays session), left/right moves
             * between the two switches of the focused row. */
            const onKeyDown = (event) => {
              if (event.key === 'Escape') {
                /* Escape hands focus back to the pill that owns this popover. */
                onCloseRef.current(true);
                return;
              }
              const rows = rowRefs.current.filter((row) => row != null);
              if (rows.length === 0) return;
              const active = document.activeElement;
              let rowIndex = -1;
              let column = 0;
              for (let index = 0; index < rows.length; index += 1) {
                const found = rows[index].switches.indexOf(active);
                if (found !== -1) {
                  rowIndex = index;
                  column = found;
                  break;
                }
              }
              if (rowIndex === -1) return;
              const focus = (index, targetColumn) => {
                const row = rows[(index + rows.length) % rows.length];
                const target = row.switches[targetColumn];
                if (target !== undefined && typeof target.focus === 'function') target.focus();
              };
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                focus(rowIndex + 1, column);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                focus(rowIndex - 1, column);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                focus(rowIndex, column + 1);
              } else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                focus(rowIndex, column - 1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                focus(0, column);
              } else if (event.key === 'End') {
                event.preventDefault();
                focus(rows.length - 1, column);
              }
            };
            document.addEventListener('pointerdown', onPointerDown, true);
            document.addEventListener('keydown', onKeyDown, true);
            return () => {
              window.removeEventListener('resize', measure);
              window.visualViewport?.removeEventListener('resize', measure);
              window.visualViewport?.removeEventListener('scroll', measure);
              document.removeEventListener('scroll', measure, true);
              document.removeEventListener('pointerdown', onPointerDown, true);
              document.removeEventListener('keydown', onKeyDown, true);
            };
          }, [anchorRef]);

          /* Keyboard entry: once the popover is placed, focus the first row's
           * session switch so arrows/Enter work without a click (mouse users
           * keep hover + click on either switch). */
          const opened = pos !== undefined;
          useEffect(() => {
            if (!opened) return;
            const rows = rowRefs.current.filter((row) => row != null);
            if (rows.length === 0) return;
            const active = document.activeElement;
            if (menuRef.current !== null && active !== null && menuRef.current.contains(active)) return;
            const first = rows[0].switches[0];
            if (first !== undefined && typeof first.focus === 'function') first.focus({ preventScroll: true });
          }, [opened]);

          const servers = snapshot.data?.mcp ?? [];
          const skills = snapshot.data?.skills ?? [];
          const tools = snapshot.data?.tools ?? [];
          /* One tab per kind, in display order; an empty kind has nothing to
           * show, so it gets no tab at all. */
          const groups = [
            { key: 'mcp', label: t('mcp'), entries: servers },
            { key: 'skill', label: t('skill'), entries: skills },
            { key: 'tool', label: t('tool'), entries: tools },
          ].filter((group) => group.entries.length > 0);
          const active = groups.find((group) => group.key === activeKey) ?? groups[0];

          if (pos === undefined || active === undefined) return null;
          let rowIndex = 0;
          rowRefs.current = [];
          const row = (entry) => {
            const index = rowIndex;
            rowIndex += 1;
            rowRefs.current[index] = { row: null, switches: [] };
            const description = entry.description ?? '';
            const entryKey = `${entry.kind}:${entry.name}`;
            /* Two switches per entry, at the end of the row: 会话 (this
             * conversation only, never saved) and 工作区 (this workspace's
             * default, which new sessions inherit). Either click sets that
             * switch to its opposite; the two are independent, so a session
             * can be off while the workspace default is on.
             *
             * Not `disabled` while busy: a disabled focused button drops
             * keyboard focus on every toggle, so busy is enforced in the
             * click handlers and announced through aria-disabled. */
            const specs = [
              { scope: 'session', label: t('scopeSession'), title: t('scopeSessionTitle'), checked: entry.enabled === true },
              /* A pre-0.7.0 host has no workspace state to report; its one
               * switch was the workspace default, so mirror `enabled` there. */
              { scope: 'workspace', label: t('scopeWorkspace'), title: t('scopeWorkspaceTitle'), checked: (entry.workspace ?? entry.enabled) === true },
            ];
            return h('div', {
              key: entryKey,
              ref: (element) => {
                const slot = rowRefs.current[index];
                if (slot !== undefined) slot.row = element ?? null;
              },
              role: 'group',
              'aria-label': entry.name,
              'aria-description': description === '' ? undefined : description,
              'data-context-control-row': entryKey,
              title: [description, entry.detail ?? ''].filter((part) => part !== '').join('\n'),
              style: entry.enabled ? { ...CSS.menuRow, ...CSS.menuRowOn } : CSS.menuRow,
              onMouseEnter: (event) => {
                event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))';
              },
              onMouseLeave: (event) => {
                event.currentTarget.style.background = 'transparent';
              },
            },
              h('span', { style: CSS.menuRowMain },
                h('span', { style: CSS.menuTop },
                  entry.kind === 'tool' ? null : h('span', { style: CSS.badge }, entry.official ? t('official') : t('custom')),
                  h('span', { style: CSS.menuName }, entry.name),
                ),
                description === '' ? null : h('span', { style: CSS.menuDesc }, description),
              ),
              h('span', { style: CSS.switches }, specs.map((spec, column) => h('button', {
                key: spec.scope,
                ref: (element) => {
                  const slot = rowRefs.current[index];
                  if (slot !== undefined) slot.switches[column] = element ?? null;
                },
                type: 'button',
                role: 'switch',
                'aria-checked': spec.checked ? 'true' : 'false',
                'aria-disabled': snapshot.busy ? 'true' : 'false',
                'aria-label': `${entry.name} · ${spec.label}`,
                title: spec.title,
                'data-context-control': 'scope',
                'data-context-control-scope': spec.scope,
                'data-context-control-entry': entryKey,
                'data-context-control-state': spec.checked ? 'on' : 'off',
                style: spec.checked ? { ...CSS.scopeSwitch, ...CSS.scopeSwitchOn } : CSS.scopeSwitch,
                onClick: () => {
                  if (snapshot.busy) return;
                  void toggleState(state, sessionId, entry.kind, entry.name, !spec.checked, spec.scope);
                },
              }, spec.label))),
            );
          };

          /* A tab carries its own count, so the picture stays readable while a
           * single kind is shown. */
          const tab = (group) => {
            const on = group.entries.filter((entry) => entry.enabled).length;
            const sub = `${on}/${group.entries.length}`;
            const selected = group === active;
            return h('button', {
              key: `tab:${group.key}`,
              ref: (element) => { tabRefs.current[group.key] = element ?? null; },
              type: 'button',
              role: 'tab',
              id: `context-control-tab-${group.key}`,
              'aria-selected': selected ? 'true' : 'false',
              'aria-controls': 'context-control-tabpanel',
              tabIndex: selected ? 0 : -1,
              'data-context-control-tab': group.key,
              title: `${group.label} · ${sub}`,
              style: selected ? { ...CSS.tab, ...CSS.tabOn } : CSS.tab,
              onClick: () => setActiveKey(group.key),
            },
              h('span', { style: CSS.tabLabel }, group.label),
              h('span', { style: CSS.tabSub }, sub),
            );
          };

          /* Keyboard on the tab strip: left/right moves between kinds (focus
           * follows, so Tab never falls out of the strip), down enters rows. */
          const onTabKeyDown = (event) => {
            const index = groups.indexOf(active);
            if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
              event.preventDefault();
              const delta = event.key === 'ArrowRight' ? 1 : -1;
              const next = groups[(index + delta + groups.length) % groups.length];
              setActiveKey(next.key);
              tabRefs.current[next.key]?.focus();
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              const first = rowRefs.current.find((row) => row != null);
              first?.switches[0]?.focus();
            } else if (event.key === 'Home') {
              event.preventDefault();
              const first = groups[0];
              setActiveKey(first.key);
              tabRefs.current[first.key]?.focus();
            } else if (event.key === 'End') {
              event.preventDefault();
              const last = groups[groups.length - 1];
              setActiveKey(last.key);
              tabRefs.current[last.key]?.focus();
            }
          };

          return createPortal(h('div', {
            ref: menuRef,
            role: 'menu',
            'data-context-control': 'menu',
            /* Which Session this popover gates; also what the multi-pane
             * regression test asserts on. */
            'data-context-control-session': sessionId,
            style: { ...CSS.menu, left: pos.left, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight },
          },
            /* A lone kind needs no switcher (and no wasted row above it). */
            groups.length > 1 ? h('div', {
              key: '__tabs',
              role: 'tablist',
              id: 'context-control-tablist',
              'aria-label': t('panel'),
              'aria-orientation': 'horizontal',
              onKeyDown: onTabKeyDown,
              style: CSS.tabBar,
            }, groups.map(tab)) : null,
            h('div', {
              key: '__body',
              role: 'tabpanel',
              id: 'context-control-tabpanel',
              'aria-labelledby': groups.length > 1 ? `context-control-tab-${active.key}` : undefined,
              'aria-label': groups.length > 1 ? undefined : active.label,
              style: CSS.tabBody,
            }, active.entries.map(row)),
            snapshot.error !== undefined ? h('div', { key: '__error', style: CSS.error }, snapshot.error) : null,
            h(UpdateFooter, { key: '__update' }),
            h('div', { key: '__hint', style: CSS.hint }, t('hint')),
          ), document.body);
        }

        ctx.slots.inject('conversation.input.left', () => {
          return ctx.slots.register({
            name: 'conversation.input.left',
            id: 'context-control',
            order: 0,
          }, ContextPill);
        });

        /* Unmount the descriptor contribution with the plugin. */
        return async () => { await unmount; };
      },
    };
  },
});
