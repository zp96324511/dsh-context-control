/**
 * dsh-context-control — Client half.
 *
 * A compact panel in the composer dock: a pill showing how many MCP servers
 * and skills are enabled for the current session; expanded, one chip per
 * entry with its origin badge (official / user-configured) and on/off state,
 * grouped by kind. Toggling calls the Host service over the Typert Gateway
 * (`remote.contextControl`), the same operations the `context_control` agent
 * tool uses.
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
     * set(sessionId, kind, target, enabled), both direct invocations. */
    const entrySchema = {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['mcp', 'skill'] },
        name: { type: 'string' },
        enabled: { type: 'boolean' },
        official: { type: 'boolean' },
        detail: { type: 'string' },
      },
      required: ['kind', 'name', 'enabled', 'official', 'detail'],
      additionalProperties: false,
    };
    const listResultSchema = () => zod.object({
      sessionId: zod.string(),
      cwd: zod.string(),
      mcp: zod.array(zod.object({
        kind: zod.literal('mcp'),
        name: zod.string(),
        enabled: zod.boolean(),
        official: zod.boolean(),
        detail: zod.string(),
      })),
      skills: zod.array(zod.object({
        kind: zod.literal('skill'),
        name: zod.string(),
        enabled: zod.boolean(),
        official: zod.boolean(),
        detail: zod.string(),
      })),
    });
    const setResultSchema = () => zod.object({
      ok: zod.boolean(),
      reason: zod.string().optional(),
      kind: zod.string().optional(),
      name: zod.string().optional(),
      enabled: zod.boolean().optional(),
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
          description: 'List this session\'s MCP servers and skills with origin and enabled state.',
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
              },
              required: ['sessionId', 'cwd', 'mcp', 'skills'],
              additionalProperties: false,
            },
          },
        },
        {
          id: 'dsh-context-control#contextControl/set',
          namespace: 'contextControl',
          method: 'set',
          service: 'contextControl',
          description: 'Enable or disable one MCP server or skill for one session.',
          invocation: { kind: 'direct' },
          parameters: [
            stringParam('session to modify'),
            {
              name: 'kind',
              description: 'entry kind: mcp or skill.',
              source: 'json',
              wire: 'kind',
              codec: { mode: 'strict', typeSymbol: 'dsh-context-control#kind', create: () => zod.enum(['mcp', 'skill']), jsonSchema: { type: 'string', enum: ['mcp', 'skill'] } },
              strictCodec: { mode: 'strict', typeSymbol: 'dsh-context-control#kind', create: () => zod.enum(['mcp', 'skill']), jsonSchema: { type: 'string', enum: ['mcp', 'skill'] } },
            },
            {
              name: 'target',
              description: 'MCP server or skill name to toggle.',
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
          ],
          result: {
            mode: 'strict',
            typeSymbol: 'dsh-context-control#contextControl/set:result',
            create: setResultSchema,
            description: 'ok plus the changed entry, or ok=false with a reason.',
            jsonSchema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                reason: { type: 'string' },
                kind: { type: 'string' },
                name: { type: 'string' },
                enabled: { type: 'boolean' },
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
        panel: '上下文',
        none: '无 MCP 服务器或技能',
        mcp: 'MCP',
        skill: 'Skill',
        official: '官方',
        custom: '自配',
        hint: '点击开关本会话的 MCP 服务器与技能（下次请求生效，按项目记忆）',
        on: '已启用：',
        busy: '…',
        checkUpdate: '检查更新',
        checking: '检查中…',
        upToDate: '已是最新',
        available: '可升级',
        upgrade: '一键升级',
        upgrading: '升级中…',
        upgraded: '已升级，需重启',
        restart: '重启服务',
        restarting: '重启中…',
        reload: '刷新页面',
        failed: '升级失败',
        retry: '重试',
        details: '详情',
        hideDetails: '收起',
        updateUnavailable: '升级不可用',
        updateLocal: '本地安装，不提供在线升级',
        updateError: '检查失败',
        updateAvailableTip: '有新版本',
        reloadHint: '已升级，刷新后生效',
        compatible: '与当前 DSH 兼容',
        incompatible: '与当前 DSH 不兼容',
      },
      en: {
        panel: 'Context',
        none: 'No MCP servers or skills',
        mcp: 'MCP',
        skill: 'Skill',
        official: 'official',
        custom: 'custom',
        hint: 'Click to toggle this session\u2019s MCP servers and skills (effective on the next request, remembered per project)',
        on: 'Enabled: ',
        busy: '…',
        checkUpdate: 'Check for updates',
        checking: 'Checking…',
        upToDate: 'Up to date',
        available: 'Update',
        upgrade: 'Upgrade',
        upgrading: 'Upgrading…',
        upgraded: 'Upgraded — restart',
        restart: 'Restart',
        restarting: 'Restarting…',
        reload: 'Reload',
        failed: 'Upgrade failed',
        retry: 'Retry',
        details: 'Details',
        hideDetails: 'Hide',
        updateUnavailable: 'Updates unavailable',
        updateLocal: 'Local install — no online upgrade',
        updateError: 'Check failed',
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
        maxHeight: '320px', overflowY: 'auto',
        overscrollBehavior: 'contain',
        padding: '6px',
        display: 'flex', flexDirection: 'column', gap: '1px',
        background: 'var(--dsw-alias-bg-elevated, #232326)',
        border: `1px solid var(--dsw-alias-border-l, rgba(128,128,128,.35))`,
        borderRadius: '10px',
        boxShadow: '0 10px 28px rgba(0,0,0,.38), 0 2px 8px rgba(0,0,0,.28)',
      },
      menuGroup: {
        padding: '5px 8px 3px',
        fontSize: '11px', lineHeight: '16px',
        color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,.6))',
      },
      menuRow: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '10px', width: '100%',
        padding: '5px 8px', border: 'none', borderRadius: '6px',
        fontSize: '12px', lineHeight: '18px', textAlign: 'left',
        background: 'transparent', cursor: 'pointer',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      menuRowOn: {
        color: 'var(--dsw-alias-label-primary, inherit)',
      },
      menuRowMain: {
        display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0,
      },
      menuName: {
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      stateMark: {
        fontSize: '11px', lineHeight: '16px', flex: 'none',
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

        /** Toggle one entry for one Session, then refresh that Session's state. */
        async function toggleState(state, sessionId, kind, name, next) {
          if (state.get().busy) return;
          state.patch({ busy: true, error: undefined });
          try {
            const outcome = await remoteContextControl.set(sessionId, kind, name, next);
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
         * (check → upgrade → restart → reload).
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
        const REOPEN_POLL_MS = 1000
        const REOPEN_LIMIT_MS = 120 * 1000
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
            if (bootVersion === undefined && typeof info?.current === 'string') bootVersion = info.current
            const reloadNeeded = bootVersion !== undefined
              && typeof info?.current === 'string'
              && info.current !== bootVersion
            if (reloadNeeded) {
              updateStore.set({ phase: 'reload', info, error: undefined, job: updateStore.get().job })
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
                const needsRestart = job.restartRequired !== false
                updateStore.set({ phase: 'upgraded', error: job.error, info: { ...(updateStore.get().info ?? {}), current: job.installed ?? updateStore.get().info?.current } })
                void needsRestart
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

        /* After a restart the old page is still running old code; poll the
         * liveness route until the host answers again, then reload. Polling a
         * route of this very plugin is also the proof the new build mounted. */
        async function restartHost() {
          updateStore.set({ phase: 'restarting', error: undefined })
          try {
            await updateRequest('/update/restart', { method: 'POST' })
          } catch (cause) {
            /* The connection dying is the expected outcome here. */
            void cause
          }
          const deadline = Date.now() + REOPEN_LIMIT_MS
          const tick = async () => {
            try {
              const pong = await updateRequest('/ping')
              if (pong?.ok === true) {
                if (typeof location !== 'undefined' && typeof location.reload === 'function') location.reload()
                else updateStore.set({ phase: 'upgraded' })
                return
              }
            } catch { /* still down: keep waiting */ }
            if (Date.now() > deadline) {
              updateStore.set({ phase: 'error', error: 'the host did not come back; restart it from the terminal' })
              return
            }
            setTimeout(() => { void tick() }, REOPEN_POLL_MS)
          }
          setTimeout(() => { void tick() }, REOPEN_POLL_MS)
        }

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
              /* The job's own verdict wins: only the host knows whether the new
               * code is already live (HMR) or still needs the restart. */
              const needsRestart = update.job !== undefined
                ? update.job.restartRequired !== false
                : info?.restartRequired !== false
              return needsRestart
                ? { label: t('restart'), onClick: () => { void restartHost() } }
                : { label: t('reload'), onClick: reloadPage }
            }
            case 'restarting':
              return { label: t('restarting'), busy: true }
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
          if (update.phase === 'upgraded') return `v${info?.current ?? '?'}`
          if (update.phase === 'reload') return `v${info?.current ?? '?'} · ${t('reloadHint')}`
          if (update.phase === 'current') return t('upToDate')
          if (update.phase === 'unavailable') return t('updateLocal')
          if (update.phase === 'error') return update.error ?? t('updateError')
          if (update.phase === 'upgrading' || update.phase === 'restarting') return update.job?.phase === 'verify' ? t('upgraded') : ''
          return ''
        }

        function UpdateFooter() {
          const update = useUpdateState()
          const [showLog, setShowLog] = useState(false)
          const info = update.info
          const action = updateAction(update)
          const note = updateNote(update)
          const phase = update.phase
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
              /* Always available: whatever phase the row is in, the user can
               * ask again — the one thing a stale tab cannot do otherwise. */
              h('button', {
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
        function pillTitle(servers, skills, data) {
          if (data === undefined) return t('hint');
          const on = [...servers, ...skills]
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
          /* Mounted by whichever pill renders first; the store is shared, so
           * the other panes reuse the same answer instead of re-asking. */
          useEffect(() => { autoStartUpdateCheck() }, []);
          if (snapshot.data !== undefined && servers.length === 0 && skills.length === 0) return null;
          const enabledOf = (entries) => entries.filter((entry) => entry.enabled).length;
          const close = (restoreFocus) => {
            setOpen(false);
            if (!restoreFocus) return;
            const pill = anchorRef.current?.firstElementChild;
            if (pill !== null && pill !== undefined && typeof pill.focus === 'function') pill.focus();
          };
          const title = update.phase === 'available'
            ? `${pillTitle(servers, skills, snapshot.data)}\n${t('updateAvailableTip')} v${update.info?.latest ?? '?'}`
            : pillTitle(servers, skills, snapshot.data);
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
              `${t('panel')}${snapshot.data === undefined ? '' : ` ${enabledOf(servers)}/${servers.length}·${enabledOf(skills)}/${skills.length}`}${snapshot.busy ? t('busy') : ''}`,
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
              const width = Math.min(280, window.innerWidth - 16);
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
            const onKeyDown = (event) => {
              if (event.key === 'Escape') {
                /* Escape hands focus back to the pill that owns this popover. */
                onCloseRef.current(true);
                return;
              }
              const rows = rowRefs.current.filter((row) => row != null);
              const index = rows.indexOf(document.activeElement);
              if (index === -1) return;
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                rows[(index + 1) % rows.length].focus();
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                rows[(index - 1 + rows.length) % rows.length].focus();
              } else if (event.key === 'Home') {
                event.preventDefault();
                rows[0].focus();
              } else if (event.key === 'End') {
                event.preventDefault();
                rows[rows.length - 1].focus();
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

          /* Keyboard entry: once the popover is placed, focus the first row so
           * arrows/Enter work without a click (mouse users keep hover + click). */
          const opened = pos !== undefined;
          useEffect(() => {
            if (!opened) return;
            const rows = rowRefs.current.filter((row) => row != null);
            if (rows.length === 0) return;
            const active = document.activeElement;
            if (menuRef.current !== null && active !== null && menuRef.current.contains(active)) return;
            rows[0].focus({ preventScroll: true });
          }, [opened]);

          if (pos === undefined) return null;
          const servers = snapshot.data?.mcp ?? [];
          const skills = snapshot.data?.skills ?? [];
          let rowIndex = 0;
          rowRefs.current = [];
          const row = (entry) => {
            const index = rowIndex;
            rowIndex += 1;
            return h('button', {
              key: `${entry.kind}:${entry.name}`,
              ref: (element) => { rowRefs.current[index] = element ?? null; },
              type: 'button',
              role: 'switch',
              'aria-checked': entry.enabled ? 'true' : 'false',
              'aria-disabled': snapshot.busy ? 'true' : 'false',
              'aria-label': entry.name,
              title: entry.detail ?? '',
              style: entry.enabled ? { ...CSS.menuRow, ...CSS.menuRowOn } : CSS.menuRow,
              onMouseEnter: (event) => {
                event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))';
              },
              onMouseLeave: (event) => {
                event.currentTarget.style.background = 'transparent';
              },
              onFocus: (event) => {
                event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))';
              },
              onBlur: (event) => {
                event.currentTarget.style.background = 'transparent';
              },
              /* Deliberately not `disabled`: a disabled focused button drops keyboard
               * focus on every toggle. Busy is enforced in the click handler. */
              onClick: () => {
                if (snapshot.busy) return;
                void toggleState(state, sessionId, entry.kind, entry.name, !entry.enabled);
              },
            },
              h('span', { style: CSS.menuRowMain },
                h('span', { style: CSS.badge }, entry.official ? t('official') : t('custom')),
                h('span', { style: CSS.menuName }, entry.name),
              ),
              h('span', { style: CSS.stateMark }, entry.enabled ? '●' : '○'),
            );
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
            servers.length > 0 ? h('div', { key: '__mcp', style: CSS.menuGroup }, t('mcp')) : null,
            servers.map(row),
            skills.length > 0 ? h('div', { key: '__skill', style: CSS.menuGroup }, t('skill')) : null,
            skills.map(row),
            snapshot.error !== undefined ? h('div', { style: CSS.error }, snapshot.error) : null,
            h(UpdateFooter, { key: '__update' }),
            h('div', { style: CSS.hint }, t('hint')),
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
