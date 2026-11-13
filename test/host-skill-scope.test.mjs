/**
 * Regression: skill discovery must read the catalog through the viewing
 * agent's scope, and gating must work for skills that come from the filesystem
 * provider mounted inside the agent preset (project `.dsh/skills`,
 * `.agents/skills`, `~/.dsh/skills`, `~/.agents/skills`, custom roots).
 *
 * The bug this pins down: `ctx.skills.list({ cwd })` without `scope` merges
 * only the global layer, so the panel and `context_control list` showed just
 * bundled/host-registered skills while the model's catalog (which passes
 * `scope: agent`) showed everything — user skills stayed on in the prompt and
 * were impossible to toggle.
 *
 * The host half imports the Harness packages, which a bare checkout (CI) does
 * not have, so the suite skips there instead of failing on module resolution;
 * it runs wherever the plugin is actually developed, i.e. next to an install.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

let apply
let unavailable = false
try {
  ;({ apply } = await import('../index.js'))
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  unavailable = true
}

const skip = unavailable
  ? 'needs the Harness packages (@deepseek-ai/dsh-*), which a bare checkout does not install'
  : false

const SHADOW_SOURCE = 'context-control-gated'

/** One stub Harness context wired for the plugin's injected services.
 * `domain: true` backs the two domain tables with in-memory maps so both scopes
 * can be exercised; the default throws, like a host that mounted no storage
 * domain (the session scope in memory must not care). `records` and
 * `sessionRecords` may be passed in so a second harness can read what the first
 * one persisted — that is how a restart is simulated. */
function harness({
  domain: withDomain = false,
  records = new Map(),
  sessionRecords = new Map(),
  archived = [],
  promptSections = {},
} = {}) {
  const listeners = new Map()
  const calls = { list: [] }
  const shadowed = new Set()
  const shadows = []

  const tableFor = (name) => {
    const store = name === 'sessions' ? sessionRecords : records
    return {
      get: (key) => store.get(key),
      entries: () => [...store.entries()][Symbol.iterator](),
      put: async (key, value) => { store.set(key, value) },
      delete: async (key) => store.delete(key),
      deleteMany: async (keys) => {
        let deleted = 0
        for (const key of keys) if (store.delete(key)) deleted += 1
        return deleted
      },
      get size() { return store.size },
    }
  }

  /** Global layer: what an unscoped read can see (bundled/host registrations only). */
  const globalSkills = [
    { name: 'bundled-one', source: 'bundled', description: 'registered by the host' },
  ]
  /** Filesystem provider, mounted inside the agent preset: visible only with `scope`. */
  const presetSkills = [
    { name: 'probe-agents', source: 'user-agents', description: 'from ~/.agents/skills' },
    { name: 'probe-dsh', source: 'user-dsh', description: 'from ~/.dsh/skills' },
  ]

  /* Built-in tool view: two gateable tools, one protected entry point, one MCP
   * tool (gated through its server, never through the tool list). */
  const toolSchemas = [
    { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
    { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    { name: 'run_code', description: 'PTC entry point', parameters: { type: 'object', properties: {} } },
    { name: 'mcp__demo__thing', description: 'MCP tool', parameters: { type: 'object', properties: {} } },
  ]
  const restrictCalls = []

  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    storageDomain: {
      open: async () => {
        if (!withDomain) throw new Error('no storage domain in the harness')
        return { table: tableFor, close: async () => {} }
      },
    },
    tools: {
      schemas: () => toolSchemas,
      register: () => () => {},
      restrict: () => () => {},
    },
    agents: { list: () => [] },
    skills: {
      list: async (options = {}) => {
        calls.list.push(options)
        if (options.scope === undefined) return [...globalSkills]
        const merged = [...globalSkills, ...presetSkills]
          .filter((skill) => !shadowed.has(skill.name))
          .map((skill) => ({ ...skill }))
        for (const name of shadowed) {
          merged.push({ name, source: SHADOW_SOURCE, description: 'gated off' })
        }
        return merged
      },
      register: (skill) => {
        shadows.push(skill)
        shadowed.add(skill.name)
        return () => { shadowed.delete(skill.name) }
      },
    },
    on: (event, handler) => { listeners.set(event, handler); return () => {} },
    inject: () => {},
    effect: () => {},
    get: (name) => {
      if (name === 'workspaceRegistry') return { archivedSessionIds: archived }
      /* The prompt service exposes its registered sections; the MCP clients
       * keep their instruction text behind a lazy provider, as they do in the
       * host. Nothing here is assembled, which is the point of the test. */
      if (name === 'systemPrompt') {
        return {
          layers: {
            merge: (_scope, pick) => new Map(pick({ sections: new Map(Object.entries(promptSections)) }).entries()),
          },
        }
      }
      return undefined
    },
    set: () => {},
    provide: () => {},
    reflect: { provide: () => {}, get: () => undefined, set: () => {} },
  }

  let tool
  ctx.tools.register = (candidate) => { tool = candidate; return () => {} }

  /* An agent context reaches only the services its loop declared: `skills` is
   * not one of them, so it must be used through an injected child fiber — the
   * fiber also owns the registration and lifts it on dispose. Touching
   * `agent.ctx.skills` directly throws, exactly like a real agent context, so
   * a regression to that shape fails this test instead of warning in the log.
   *
   * Every agent gets its own tool-visible view (its own restriction), because
   * two sessions of one project must be able to disagree. */
  function makeAgent(id, cwd = 'C:\\ws') {
    const deniedHere = new Set()
    const agentCtx = {
      tools: {
        schemas: () => toolSchemas.filter((schema) => !deniedHere.has(schema.name)),
        restrict: (filter) => {
          restrictCalls.push(filter)
          const added = (filter.deny ?? []).filter((name) => !deniedHere.has(name))
          for (const name of added) deniedHere.add(name)
          return () => { for (const name of added) deniedHere.delete(name) }
        },
      },
      inject: (deps, callback) => {
        if (!deps.includes('skills')) throw new Error(`unexpected inject ${deps.join(',')}`)
        let lifted = false
        let unregister
        const fiber = {
          dispose: () => {
            lifted = true
            unregister?.()
            return Promise.resolve()
          },
        }
        /* cordis runs the callback on the next tick; the test settles on demand. */
        Promise.resolve().then(() => {
          if (lifted) return
          unregister = callback({ skills: ctx.skills })
        })
        return fiber
      },
    }
    Object.defineProperty(agentCtx, 'skills', {
      get() { throw new Error('cannot get property "skills" without inject') },
    })

    const agent = { id, session: { header: { cwd } }, ctx: agentCtx }
    return agent
  }

  const agent = makeAgent('session-under-test')

  return { ctx, agent, makeAgent, listeners, calls, shadows, records, sessionRecords, restrictCalls, toolSchemas, tool: () => tool }
}

/** Let the stubbed inject fibers run their callbacks. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** Config with no defaults of its own, so assertions read the mechanism, not the defaults. */
const PLAIN_CONFIG = {
  defaultOn: [],
  defaultOff: [],
  officialServers: [],
  defaultOnSkills: [],
  defaultOffSkills: [],
  defaultOffTools: [],
  allowAgentToggle: true,
}

test('skill discovery reads through the agent scope, and preset skills are gated', { skip }, async () => {
  const { ctx, agent, listeners, calls, shadows, restrictCalls, toolSchemas, tool } = harness()
  const dispose = await apply(ctx, PLAIN_CONFIG)

  try {
    await listeners.get('agent/created')({ agent })
    await tick()

    /* The read must carry the viewing agent, exactly like `skill` and the catalog. */
    assert.ok(calls.list.length > 0, 'skill discovery ran')
    assert.equal(calls.list[0].scope, agent, 'discovery passes the viewing agent as scope')
    assert.equal(calls.list[0].cwd, 'C:\\ws')

    const listed = JSON.parse(await tool().execute({ action: 'list' }, { agent }))
    const byName = new Map(listed.skills.map((entry) => [entry.name, entry]))
    assert.deepEqual([...byName.keys()].sort(), ['bundled-one', 'probe-agents', 'probe-dsh'])
    assert.equal(byName.get('bundled-one').enabled, true, 'bundled skills stay on by default')
    assert.equal(byName.get('bundled-one').workspace, true, 'the workspace default is reported next to the session state')
    assert.equal(byName.get('probe-agents').enabled, false, 'user skills start gated off')
    assert.equal(byName.get('probe-agents').workspace, false, 'the workspace default agrees with the fresh session')
    assert.equal(byName.get('probe-agents').detail, 'user-agents')
    assert.equal(byName.get('probe-agents').description, 'from ~/.agents/skills',
      'the catalog description reaches the panel')
    assert.equal(byName.get('probe-dsh').official, false)

    /* Both preset-provided skills arrived gated: one shadow each, properly marked. */
    assert.deepEqual(shadows.map((shadow) => shadow.name).sort(), ['probe-agents', 'probe-dsh'])
    for (const shadow of shadows) {
      assert.equal(shadow.source, SHADOW_SOURCE)
      assert.deepEqual(shadow.invocation, { modelInvocable: false, userInvocable: false })
    }

    /* Enabling a skill lifts its shadow without re-registering anything else. */
    const enabled = JSON.parse(await tool().execute(
      { action: 'enable', kind: 'skill', target: 'probe-agents' }, { agent },
    ))
    assert.equal(enabled.ok, true)
    await tick()
    assert.equal(shadows.length, 2, 'enabling only disposes shadows')
    const afterEnable = JSON.parse(await tool().execute({ action: 'list' }, { agent }))
    const ungated = afterEnable.skills.find((entry) => entry.name === 'probe-agents')
    assert.equal(ungated.enabled, true)
    assert.equal(ungated.detail, 'user-agents')

    /* Disabling again re-shadows it; the panel keeps reporting the real origin. */
    const disabled = JSON.parse(await tool().execute(
      { action: 'disable', kind: 'skill', target: 'probe-agents' }, { agent },
    ))
    assert.equal(disabled.ok, true)
    await tick()
    assert.equal(shadows.length, 3, 'disabling registers one shadow')
    assert.equal(shadows[2].name, 'probe-agents')
    assert.equal(shadows[2].source, SHADOW_SOURCE)

    /* Even while shadowed, the panel reports the real origin, not our marker. */
    const afterDisable = JSON.parse(await tool().execute({ action: 'list' }, { agent }))
    const gated = afterDisable.skills.find((entry) => entry.name === 'probe-agents')
    assert.equal(gated.enabled, false)
    assert.equal(gated.detail, 'user-agents')
    assert.equal(gated.official, false)
    assert.equal(gated.description, 'from ~/.agents/skills',
      'the shadow text must not replace the real description')

    /* A catalog change re-reads through the scope and keeps the gated set stable. */
    await listeners.get('skills/change')()
    assert.ok(calls.list.at(-1).scope === agent, 'refresh also passes the scope')
    const afterRefresh = JSON.parse(await tool().execute({ action: 'list' }, { agent }))
    assert.deepEqual(
      afterRefresh.skills.filter((entry) => entry.enabled).map((entry) => entry.name),
      ['bundled-one'],
    )

    /* ---- built-in tools ---- *
     * Gateable tools are listed with their description; MCP tools and the PTC
     * entry point never appear in that list. */
    const withTools = JSON.parse(await tool().execute({ action: 'list' }, { agent }))
    assert.deepEqual(withTools.tools.map((entry) => entry.name), ['bash', 'read'])
    for (const entry of withTools.tools) {
      assert.equal(entry.enabled, true, 'built-in tools start enabled')
      assert.equal(entry.detail, '', 'a tool row carries no cost detail')
      assert.equal(typeof entry.tokens, 'undefined', 'the panel no longer estimates tokens')
    }
    assert.equal(withTools.tools.find((entry) => entry.name === 'read').description, 'read a file',
      'the schema description reaches the panel')
    assert.ok(!withTools.tools.some((entry) => entry.name === 'run_code'), 'protected tools are not listed')
    assert.ok(!withTools.tools.some((entry) => entry.name.startsWith('mcp__')), 'MCP tools are gated via their server')

    /* MCP servers have no description field; their `instructions` prose arrives
     * in the `mcp:<server>` system-prompt section, captured at assembly. */
    const assemble = listeners.get('system-prompt/assemble')
    assemble({
      sections: [
        { name: 'mcp:demo', text: 'Demo server:  lists things.\nCall it sparingly.' },
        { name: 'mcp-resource-servers', text: 'Servers: ["demo"].' },
      ],
    }, { agent }, () => {})
    const listedMcp = JSON.parse(await tool().execute({ action: 'list' }, { agent }))
    const demo = listedMcp.mcp.find((entry) => entry.name === 'demo')
    assert.equal(demo.description, 'Demo server: lists things. Call it sparingly.')

    /* Disabling a tool re-applies the one restriction: the server's tools stay
     * denied and the disabled built-in joins them. */
    const toolOff = JSON.parse(await tool().execute(
      { action: 'disable', kind: 'tool', target: 'read' }, { agent },
    ))
    assert.equal(toolOff.ok, true)
    assert.deepEqual([...restrictCalls.at(-1).deny].sort(), ['mcp__demo__thing', 'read'])
    assert.ok(!agent.ctx.tools.schemas().some((schema) => schema.name === 'read'), 'read left the model tool table')
    const readOff = JSON.parse(await tool().execute({ action: 'list' }, { agent }))
    assert.equal(readOff.tools.find((entry) => entry.name === 'read').enabled, false)

    const toolOn = JSON.parse(await tool().execute(
      { action: 'enable', kind: 'tool', target: 'read' }, { agent },
    ))
    assert.equal(toolOn.ok, true)
    assert.deepEqual([...restrictCalls.at(-1).deny], ['mcp__demo__thing'])
    assert.ok(agent.ctx.tools.schemas().some((schema) => schema.name === 'read'), 'read returned to the tool table')

    /* Protected entries cannot be gated at all. */
    const protectedOff = JSON.parse(await tool().execute(
      { action: 'disable', kind: 'tool', target: 'run_code' }, { agent },
    ))
    assert.equal(protectedOff.ok, false)
    assert.match(protectedOff.reason, /protected/)

    /* A tool registered after attach shows up on the next change, enabled. */
    toolSchemas.push({ name: 'glob', description: 'find files', parameters: { type: 'object', properties: {} } })
    await listeners.get('tools/change')()
    const grown = JSON.parse(await tool().execute({ action: 'list' }, { agent }))
    const glob = grown.tools.find((entry) => entry.name === 'glob')
    assert.ok(glob !== undefined, 'a late-registered tool is discovered')
    assert.equal(glob.enabled, true)
  } finally {
    dispose()
  }
})

/**
 * The two scopes: `scope=session` (the default) changes one conversation and
 * writes nothing; `scope=workspace` writes the project record, applies to the
 * session that made the choice, and is inherited by sessions started in the
 * same project later — without dragging live sessions around.
 */
test('the workspace scope persists and a new session inherits it', { skip }, async () => {
  const { ctx, makeAgent, listeners, records, restrictCalls, tool } = harness({ domain: true })
  const dispose = await apply(ctx, PLAIN_CONFIG)

  try {
    const a = makeAgent('session-a')
    await listeners.get('agent/created')({ agent: a })
    await tick()

    /* A session choice changes this conversation and nothing else. */
    const sessionOff = JSON.parse(await tool().execute(
      { action: 'disable', kind: 'tool', target: 'read', scope: 'session' }, { agent: a },
    ))
    assert.equal(sessionOff.ok, true)
    assert.equal(sessionOff.scope, 'session')
    assert.equal(records.size, 0, 'a session-only choice writes no workspace record')

    /* A workspace choice writes the project record — explicit choices only. */
    const workspaceOff = JSON.parse(await tool().execute(
      { action: 'disable', kind: 'tool', target: 'bash', scope: 'workspace' }, { agent: a },
    ))
    assert.equal(workspaceOff.ok, true)
    assert.equal(workspaceOff.scope, 'workspace')
    assert.deepEqual(records.get('C:\\ws').tools, { bash: false },
      'only the entry that was toggled is stored, not the whole session state')

    await tool().execute({ action: 'enable', kind: 'skill', target: 'probe-agents', scope: 'workspace' }, { agent: a })
    assert.deepEqual(records.get('C:\\ws').skills, { 'probe-agents': true })

    /* The issuing session reflects both choices; the two scopes stay distinct. */
    const listedA = JSON.parse(await tool().execute({ action: 'list' }, { agent: a }))
    const aRead = listedA.tools.find((entry) => entry.name === 'read')
    assert.equal(aRead.enabled, false, 'the session override still applies')
    assert.equal(aRead.workspace, true, 'read is still on as a workspace default')
    const aBash = listedA.tools.find((entry) => entry.name === 'bash')
    assert.equal(aBash.enabled, false)
    assert.equal(aBash.workspace, false)
    assert.equal(listedA.skills.find((entry) => entry.name === 'probe-agents').enabled, true)

    /* A new session in the same project starts as a copy of the workspace. */
    const b = makeAgent('session-b')
    await listeners.get('agent/created')({ agent: b })
    await tick()
    const listedB = JSON.parse(await tool().execute({ action: 'list' }, { agent: b }))
    const bRead = listedB.tools.find((entry) => entry.name === 'read')
    assert.equal(bRead.enabled, true, 'a session-only choice never reaches the next session')
    assert.equal(bRead.workspace, true)
    assert.equal(listedB.tools.find((entry) => entry.name === 'bash').enabled, false,
      'a workspace-off tool starts off in the next session')
    assert.equal(listedB.skills.find((entry) => entry.name === 'probe-agents').enabled, true,
      'a workspace-on skill starts on in the next session')
    assert.ok(!restrictCalls.at(-1).deny.includes('read'), 'the new session may read')

    /* The first session keeps its own state: a workspace write elsewhere (and
     * a session write in the new session) does not reach it. */
    await tool().execute({ action: 'enable', kind: 'tool', target: 'bash', scope: 'session' }, { agent: b })
    const listedB2 = JSON.parse(await tool().execute({ action: 'list' }, { agent: b }))
    assert.equal(listedB2.tools.find((entry) => entry.name === 'bash').enabled, true)
    const listedA2 = JSON.parse(await tool().execute({ action: 'list' }, { agent: a }))
    assert.equal(listedA2.tools.find((entry) => entry.name === 'bash').enabled, false,
      'another session\'s toggle did not reach this one')
    assert.equal(listedA2.skills.find((entry) => entry.name === 'probe-agents').enabled, true,
      'workspace skills apply to every session in the project')

    /* A workspace disable of a skill takes effect in the issuing session and
     * is stored as that explicit choice. */
    await tool().execute({ action: 'disable', kind: 'skill', target: 'probe-agents', scope: 'workspace' }, { agent: b })
    const listedB3 = JSON.parse(await tool().execute({ action: 'list' }, { agent: b }))
    assert.equal(listedB3.skills.find((entry) => entry.name === 'probe-agents').enabled, false)
    assert.deepEqual(records.get('C:\\ws').skills, { 'probe-agents': false })
  } finally {
    dispose()
  }
})

/**
 * Records are keyed by the project directory, never shared between projects,
 * and a session whose working directory is unknown has nowhere to keep a
 * project default — it must refuse the workspace scope instead of inventing a
 * record key, while the session scope keeps working.
 */
test('workspace records stay per project, and a directoryless session degrades to the session scope', { skip }, async () => {
  const { ctx, makeAgent, listeners, records, tool } = harness({ domain: true })
  const dispose = await apply(ctx, PLAIN_CONFIG)

  try {
    const a = makeAgent('session-ws')
    await listeners.get('agent/created')({ agent: a })
    await tick()
    await tool().execute({ action: 'disable', kind: 'tool', target: 'bash', scope: 'workspace' }, { agent: a })
    assert.deepEqual([...records.keys()], ['C:\\ws'])

    /* A session in a different directory starts from the configuration, not
     * from the other project's record. */
    const other = makeAgent('session-other', 'C:\\other')
    await listeners.get('agent/created')({ agent: other })
    await tick()
    const listedOther = JSON.parse(await tool().execute({ action: 'list' }, { agent: other }))
    assert.equal(listedOther.cwd, 'C:\\other')
    assert.equal(listedOther.tools.find((entry) => entry.name === 'bash').enabled, true,
      'another project keeps its own defaults')

    await tool().execute({ action: 'enable', kind: 'tool', target: 'read', scope: 'workspace' }, { agent: other })
    assert.deepEqual(records.get('C:\\other').tools, { read: true })
    assert.deepEqual(records.get('C:\\ws').tools, { bash: false }, 'the first project record is untouched')

    const loose = makeAgent('session-loose', '')
    await listeners.get('agent/created')({ agent: loose })
    await tick()
    const refused = JSON.parse(await tool().execute(
      { action: 'disable', kind: 'tool', target: 'bash', scope: 'workspace' }, { agent: loose },
    ))
    assert.equal(refused.ok, false)
    assert.match(refused.reason, /no working directory/)
    assert.equal(records.has(''), false, 'no record is invented for a session without a directory')

    const kept = JSON.parse(await tool().execute(
      { action: 'disable', kind: 'tool', target: 'bash', scope: 'session' }, { agent: loose },
    ))
    assert.equal(kept.ok, true, 'the session scope still works without a directory')
    const listedLoose = JSON.parse(await tool().execute({ action: 'list' }, { agent: loose }))
    assert.equal(listedLoose.tools.find((entry) => entry.name === 'bash').enabled, false)
  } finally {
    dispose()
  }
})

/**
 * A session override is written to the session table, not to the project
 * record, and a second host reading the same tables starts that conversation
 * from the override instead of from the project default.
 */
test('a session override is stored per conversation and survives a restart', { skip }, async () => {
  const records = new Map()
  const sessionRecords = new Map()

  /* First host: one conversation turns a tool off for itself only. */
  const first = harness({ domain: true, records, sessionRecords })
  const disposeFirst = await apply(first.ctx, PLAIN_CONFIG)
  try {
    const a = first.makeAgent('keep-me')
    await first.listeners.get('agent/created')({ agent: a })
    await tick()
    const outcome = JSON.parse(await first.tool().execute(
      { action: 'disable', kind: 'tool', target: 'bash', scope: 'session' }, { agent: a },
    ))
    assert.equal(outcome.ok, true)
    assert.match(outcome.note, /reopened/, 'the result says the choice is kept')

    const stored = sessionRecords.get('keep-me')
    assert.ok(stored !== undefined, 'the session record was written')
    assert.equal(stored.cwd, 'C:\\ws')
    assert.deepEqual(stored.tools, { bash: false })
    assert.deepEqual(stored.mcp, {}, 'only the toggled entry is stored')
    assert.equal(typeof stored.at, 'number')
    assert.equal(records.size, 0, 'a session choice still writes no project record')
  } finally {
    disposeFirst()
  }

  /* Second host, same tables: the conversation comes back with its override. */
  const second = harness({ domain: true, records, sessionRecords })
  const disposeSecond = await apply(second.ctx, PLAIN_CONFIG)
  try {
    const again = second.makeAgent('keep-me')
    await second.listeners.get('agent/created')({ agent: again })
    await tick()
    const listed = JSON.parse(await second.tool().execute({ action: 'list' }, { agent: again }))
    const bash = listed.tools.find((entry) => entry.name === 'bash')
    assert.equal(bash.enabled, false, 'the stored override came back')
    assert.equal(bash.workspace, true, 'the workspace default is still on')
    assert.ok(second.restrictCalls.at(-1).deny.includes('bash'), 'the restored session really hides the tool')

    /* A different conversation in the same project starts from the project. */
    const fresh = second.makeAgent('fresh')
    await second.listeners.get('agent/created')({ agent: fresh })
    await tick()
    const listedFresh = JSON.parse(await second.tool().execute({ action: 'list' }, { agent: fresh }))
    assert.equal(listedFresh.tools.find((entry) => entry.name === 'bash').enabled, true,
      'one conversation\'s override never reaches the next one')
  } finally {
    disposeSecond()
  }
})

/**
 * The session switch outranks the workspace switch. A workspace write changes
 * the project default and, in a conversation that has its own choice for that
 * entry, leaves the conversation exactly as it is — the two switches are then
 * allowed to disagree, and the session one is what the model sees. Where the
 * conversation has no choice, there is nothing to outrank, so the new default
 * shows up here at once.
 */
test('a workspace choice leaves this conversation\'s own override in place', { skip }, async () => {
  const { ctx, makeAgent, listeners, records, sessionRecords, tool } = harness({ domain: true })
  const dispose = await apply(ctx, PLAIN_CONFIG)
  try {
    const a = makeAgent('keeps-its-own')
    await listeners.get('agent/created')({ agent: a })
    await tick()

    /* This conversation pins bash off for itself. */
    await tool().execute({ action: 'disable', kind: 'tool', target: 'bash', scope: 'session' }, { agent: a })
    assert.deepEqual(sessionRecords.get('keeps-its-own').tools, { bash: false })

    /* The project default turns bash on; the pin stays, because it outranks it. */
    const outcome = JSON.parse(await tool().execute(
      { action: 'enable', kind: 'tool', target: 'bash', scope: 'workspace' }, { agent: a },
    ))
    assert.equal(outcome.ok, true)
    assert.match(outcome.note, /keeps its own choice/)
    assert.deepEqual(records.get('C:\\ws').tools, { bash: true })
    assert.deepEqual(sessionRecords.get('keeps-its-own').tools, { bash: false },
      'the workspace write did not take this conversation\'s override away')
    const listedA = JSON.parse(await tool().execute({ action: 'list' }, { agent: a }))
    const bashA = listedA.tools.find((entry) => entry.name === 'bash')
    assert.equal(bashA.enabled, false, 'the session switch still wins here')
    assert.equal(bashA.workspace, true, 'the workspace switch shows the new default')
    assert.ok(!a.ctx.tools.schemas().some((schema) => schema.name === 'bash'),
      'the model still does not see the tool')

    /* A conversation with no pin follows every default change immediately. */
    const b = makeAgent('follows')
    await listeners.get('agent/created')({ agent: b })
    await tick()
    const listedB = JSON.parse(await tool().execute({ action: 'list' }, { agent: b }))
    assert.equal(listedB.tools.find((entry) => entry.name === 'bash').enabled, true)
    await tool().execute({ action: 'disable', kind: 'tool', target: 'bash', scope: 'workspace' }, { agent: b })
    const listedB2 = JSON.parse(await tool().execute({ action: 'list' }, { agent: b }))
    assert.equal(listedB2.tools.find((entry) => entry.name === 'bash').enabled, false, 'applied here at once')
    await tool().execute({ action: 'enable', kind: 'tool', target: 'bash', scope: 'workspace' }, { agent: b })
    assert.equal(sessionRecords.has('follows'), false, 'a workspace write never creates a session record')
    const listedStill = JSON.parse(await tool().execute({ action: 'list' }, { agent: a }))
    assert.equal(listedStill.tools.find((entry) => entry.name === 'bash').enabled, false,
      'the pinned conversation was not dragged along by either project change')

    /* The pin is what reopening restores — not the project default of the moment. */
    await listeners.get('agent/disposed')({ agent: a })
    const reopened = makeAgent('keeps-its-own')
    await listeners.get('agent/created')({ agent: reopened })
    await tick()
    const listedReopened = JSON.parse(await tool().execute({ action: 'list' }, { agent: reopened }))
    const bashReopened = listedReopened.tools.find((entry) => entry.name === 'bash')
    assert.equal(bashReopened.enabled, false, 'the pin outranks the current default when the conversation reopens')
    assert.equal(bashReopened.workspace, true, 'while the workspace switch still reports the new default')
  } finally {
    dispose()
  }
})

/**
 * The third state: an entry no conversation has set follows the project, and
 * the list says so with `pinned: false`. `follow` drops a conversation's own
 * choice so the entry lands back there — reporting the project's value rather
 * than the one the click implied, and cleaning the record up when that was the
 * last choice it held.
 */
test('a conversation unpins one entry and follows the project again', { skip }, async () => {
  const { ctx, makeAgent, listeners, records, sessionRecords, tool } = harness({ domain: true })
  const dispose = await apply(ctx, PLAIN_CONFIG)
  try {
    const a = makeAgent('unpins')
    await listeners.get('agent/created')({ agent: a })
    await tick()

    /* Nothing was chosen here, so the entry follows the project (bash on). */
    const baseline = JSON.parse(await tool().execute({ action: 'list' }, { agent: a }))
    const start = baseline.tools.find((entry) => entry.name === 'bash')
    assert.equal(start.pinned, false, 'a conversation with no choice reported a pin')
    assert.equal(start.enabled, true)

    /* Pin bash off for this conversation only, and read too — two choices, so
     * dropping one must not drop the other. */
    await tool().execute({ action: 'disable', kind: 'tool', target: 'bash', scope: 'session' }, { agent: a })
    await tool().execute({ action: 'disable', kind: 'tool', target: 'read', scope: 'session' }, { agent: a })
    const pinned = JSON.parse(await tool().execute({ action: 'list' }, { agent: a }))
    assert.equal(pinned.tools.find((entry) => entry.name === 'bash').pinned, true)
    assert.equal(pinned.tools.find((entry) => entry.name === 'bash').enabled, false)
    assert.deepEqual(sessionRecords.get('unpins').tools, { bash: false, read: false })

    /* Unpin bash: the project value comes back, and only that key is dropped. */
    const outcome = JSON.parse(await tool().execute(
      { action: 'follow', kind: 'tool', target: 'bash' }, { agent: a },
    ))
    assert.equal(outcome.ok, true)
    assert.equal(outcome.scope, 'follow')
    assert.equal(outcome.enabled, true, 'the result reports the project value, not the click')
    assert.deepEqual(sessionRecords.get('unpins').tools, { read: false },
      'unpinning bash must not drop the other choice')
    assert.ok(a.ctx.tools.schemas().some((schema) => schema.name === 'bash'),
      'the unpinned tool is not visible to the model')
    assert.ok(!a.ctx.tools.schemas().some((schema) => schema.name === 'read'),
      'the pinned tool came back with the unpin')

    const after = JSON.parse(await tool().execute({ action: 'list' }, { agent: a }))
    const bashAfter = after.tools.find((entry) => entry.name === 'bash')
    assert.equal(bashAfter.pinned, false, 'the entry is following again')
    assert.equal(bashAfter.enabled, true)
    assert.equal(after.tools.find((entry) => entry.name === 'read').pinned, true)

    /* The gesture is idempotent, and unpinning the last choice drops the whole
     * record instead of leaving an empty one behind. */
    await tool().execute({ action: 'follow', kind: 'tool', target: 'bash' }, { agent: a })
    assert.deepEqual(sessionRecords.get('unpins').tools, { read: false }, 'a no-op follow rewrote the record')
    await tool().execute({ action: 'follow', kind: 'tool', target: 'read' }, { agent: a })
    assert.equal(sessionRecords.has('unpins'), false, 'the empty record was left behind')
    assert.equal(records.size, 0, 'unpinning wrote a project record')

    /* A reopened conversation with no record starts from the project again. */
    await listeners.get('agent/disposed')({ agent: a })
    const reopened = makeAgent('unpins')
    await listeners.get('agent/created')({ agent: reopened })
    await tick()
    const listedAgain = JSON.parse(await tool().execute({ action: 'list' }, { agent: reopened }))
    assert.equal(listedAgain.tools.find((entry) => entry.name === 'read').enabled, true)
    assert.equal(listedAgain.tools.find((entry) => entry.name === 'read').pinned, false)
  } finally {
    dispose()
  }
})

/**
 * Archive records carry no choices for us to keep: the record is dropped and the
 * live agent falls back at once. A conversation restored from the archive is
 * therefore indistinguishable from one that never had overrides — it inherits
 * whatever the project says at that moment, rather than reviving retired
 * choices.
 */
test('archiving a conversation drops its overrides, and a restored one inherits the project', { skip }, async () => {
  const { ctx, makeAgent, listeners, records, sessionRecords, tool } = harness({ domain: true })
  const dispose = await apply(ctx, PLAIN_CONFIG)
  try {
    const a = makeAgent('archived-one')
    await listeners.get('agent/created')({ agent: a })
    await tick()
    await tool().execute({ action: 'disable', kind: 'tool', target: 'bash', scope: 'session' }, { agent: a })
    assert.deepEqual(sessionRecords.get('archived-one').tools, { bash: false })
    assert.ok(!a.ctx.tools.schemas().some((schema) => schema.name === 'bash'))

    /* The registry stores its archive set in the workspace root record, and the
     * host broadcasts every domain write; that write is the hook. */
    listeners.get('domain/changed')({
      domain: 'workspace',
      table: '',
      operation: 'put',
      value: { workspaceIds: [], archivedSessionIds: ['archived-one'], pinnedSessionIds: [] },
    })
    assert.equal(sessionRecords.has('archived-one'), false, 'the stored choices are gone')
    assert.ok(a.ctx.tools.schemas().some((schema) => schema.name === 'bash'),
      'the live agent fell back to the project choice, not to the old override')

    /* No project write happened: a reopened conversation must start from the
     * project default, so the vanished override cannot come back. */
    await listeners.get('agent/disposed')({ agent: a })
    const restored = makeAgent('archived-one')
    await listeners.get('agent/created')({ agent: restored })
    await tick()
    const listed = JSON.parse(await tool().execute({ action: 'list' }, { agent: restored }))
    assert.equal(listed.tools.find((entry) => entry.name === 'bash').enabled, true,
      'the restored conversation inherits the project default')
    assert.equal(records.size, 0, 'archiving wrote nothing to the project record')
    assert.equal(sessionRecords.has('archived-one'), false, 'no record came back for it')
  } finally {
    dispose()
  }
})

/**
 * The same cleanup must apply to archives this host never saw happen: reading
 * the session table for the first time consults the registry, so a host restart
 * does not resurrect choices from conversations archived while it was down.
 */
test('archives made before this host started are dropped when the table is read', { skip }, async () => {
  const now = Date.now()
  const sessionRecords = new Map([
    ['old-archived', { cwd: 'C:\\ws', at: now, mcp: {}, skills: {}, tools: { bash: false } }],
    ['still-live', { cwd: 'C:\\ws', at: now, mcp: {}, skills: {}, tools: { read: false } }],
  ])
  const { ctx, makeAgent, listeners, tool } = harness({ domain: true, sessionRecords, archived: ['old-archived'] })
  const dispose = await apply(ctx, PLAIN_CONFIG)
  try {
    const a = makeAgent('still-live')
    await listeners.get('agent/created')({ agent: a })
    await tick()
    assert.equal(sessionRecords.has('old-archived'), false, 'the archived record was dropped at load')
    assert.equal(sessionRecords.has('still-live'), true, 'an unarchived record is untouched')

    const listed = JSON.parse(await tool().execute({ action: 'list' }, { agent: a }))
    assert.equal(listed.tools.find((entry) => entry.name === 'read').enabled, false,
      'the surviving record still applies to its conversation')
  } finally {
    dispose()
  }
})

/**
 * DSH exposes no "session deleted" event, so the session table is pruned on
 * write: records older than the TTL go, and beyond the cap the oldest go first.
 * The record being written is never pruned.
 */
test('expired and excess session records are pruned when one is written', { skip }, async () => {
  const records = new Map()
  const sessionRecords = new Map()
  const now = Date.now()
  sessionRecords.set('ancient', {
    cwd: 'C:\\ws', at: now - 400 * 24 * 60 * 60 * 1000, mcp: {}, skills: {}, tools: { bash: false },
  })
  for (let index = 0; index <= 1005; index += 1) {
    sessionRecords.set(`bulk-${index}`, {
      cwd: 'C:\\ws', at: now - 1000000 + index, mcp: {}, skills: {}, tools: {},
    })
  }

  const { ctx, makeAgent, listeners, tool } = harness({ domain: true, records, sessionRecords })
  const dispose = await apply(ctx, PLAIN_CONFIG)
  try {
    const a = makeAgent('writer')
    await listeners.get('agent/created')({ agent: a })
    await tick()
    await tool().execute({ action: 'disable', kind: 'tool', target: 'read', scope: 'session' }, { agent: a })

    assert.equal(sessionRecords.has('ancient'), false, 'a record older than the TTL was dropped')
    assert.equal(sessionRecords.size, 1000, 'the table is back at its cap')
    assert.ok(sessionRecords.has('writer'), 'the record being written survives pruning')
    assert.equal(sessionRecords.has('bulk-0'), false, 'the oldest records went first')
    assert.ok(sessionRecords.has('bulk-1005'), 'the newest records are kept')
  } finally {
    dispose()
  }
})
/**
 * An MCP server's only prose is the `instructions` it returns from
 * `initialize`, and it reaches the host as a prompt section whose text is a
 * lazy provider. Reading that provider when the panel asks means a host that
 * has not served a model request since it started still shows descriptions;
 * waiting for an assembly left every row with nothing but its tool count.
 */
test('an MCP description is read from the section registry, not from an assembled prompt', { skip }, async () => {
  const { ctx, makeAgent, listeners, tool } = harness({
    promptSections: {
      'mcp:demo': { text: () => '### MCP server: demo\n\nDemo server instructions.\nSecond line.' },
      'harness:identity': { text: 'not an MCP section' },
    },
  })
  const dispose = await apply(ctx, PLAIN_CONFIG)
  try {
    const a = makeAgent('reader')
    await listeners.get('agent/created')({ agent: a })
    await tick()

    /* No `system-prompt/assemble` has run in this host. */
    const listed = JSON.parse(await tool().execute({ action: 'list' }, { agent: a }))
    const demo = listed.mcp.find((entry) => entry.name === 'demo')
    assert.equal(demo.description, 'Demo server instructions. Second line.',
      `description is "${demo.description}"`)
    assert.equal(demo.description.includes('### MCP server'), false,
      'the section heading must not reach the panel')
  } finally {
    dispose()
  }

  /* A server that publishes no instructions has nothing to describe: the
   * description stays empty so the client shows the tool count instead. */
  const quiet = harness({ promptSections: { 'mcp:demo': { text: () => '' } } })
  const disposeQuiet = await apply(quiet.ctx, PLAIN_CONFIG)
  try {
    const b = quiet.makeAgent('quiet-reader')
    await quiet.listeners.get('agent/created')({ agent: b })
    await tick()
    const listed = JSON.parse(await quiet.tool().execute({ action: 'list' }, { agent: b }))
    assert.equal(listed.mcp.find((entry) => entry.name === 'demo').description, '')
  } finally {
    disposeQuiet()
  }
})