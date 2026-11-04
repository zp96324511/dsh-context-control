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

/** One stub Harness context wired for the plugin's injected services. */
function harness() {
  const listeners = new Map()
  const calls = { list: [] }
  const shadowed = new Set()
  const shadows = []

  /** Global layer: what an unscoped read can see (bundled/host registrations only). */
  const globalSkills = [
    { name: 'bundled-one', source: 'bundled', description: 'registered by the host' },
  ]
  /** Filesystem provider, mounted inside the agent preset: visible only with `scope`. */
  const presetSkills = [
    { name: 'probe-agents', source: 'user-agents', description: 'from ~/.agents/skills' },
    { name: 'probe-dsh', source: 'user-dsh', description: 'from ~/.dsh/skills' },
  ]

  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    storageDomain: { open: async () => { throw new Error('no storage domain in the harness') } },
    tools: { schemas: () => [], register: () => () => {}, restrict: () => () => {} },
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
    get: () => undefined,
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
   * a regression to that shape fails this test instead of warning in the log. */
  const agentCtx = {
    tools: { schemas: () => [] },
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

  const agent = {
    id: 'session-under-test',
    session: { header: { cwd: 'C:\\ws' } },
    ctx: agentCtx,
  }

  return { ctx, agent, listeners, calls, shadows, tool: () => tool }
}

/** Let the stubbed inject fibers run their callbacks. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('skill discovery reads through the agent scope, and preset skills are gated', { skip }, async () => {
  const { ctx, agent, listeners, calls, shadows, tool } = harness()
  const dispose = await apply(ctx, {
    defaultOn: [],
    defaultOff: [],
    officialServers: [],
    defaultOnSkills: [],
    defaultOffSkills: [],
    allowAgentToggle: true,
  })

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
    assert.equal(byName.get('probe-agents').enabled, false, 'user skills start gated off')
    assert.equal(byName.get('probe-agents').detail, 'user-agents')
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

    /* A catalog change re-reads through the scope and keeps the gated set stable. */
    await listeners.get('skills/change')()
    assert.ok(calls.list.at(-1).scope === agent, 'refresh also passes the scope')
    const afterRefresh = JSON.parse(await tool().execute({ action: 'list' }, { agent }))
    assert.deepEqual(
      afterRefresh.skills.filter((entry) => entry.enabled).map((entry) => entry.name),
      ['bundled-one'],
    )
  } finally {
    dispose()
  }
})
