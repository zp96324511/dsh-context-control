/**
 * The one contract the read-only rows stand on, checked against the real
 * `ToolsService` instead of a hand-written fake: a registration made with
 * `when` is reachable through `tools.view(undefined).registrations`, carries
 * that `when`, and is exactly the registration `executable()` refuses without a
 * step's tool set.
 *
 * The fake host in `host-skill-scope.test.mjs` encodes what this file proves;
 * if DSH ever changes the shape, this test is where it shows up as a failure
 * with a DSH version attached rather than as an empty `auto` chip in the panel.
 *
 * Skips (does not fail) when no DSH installation is reachable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CANDIDATES = [
  process.env.DSH_CONTEXT_CONTROL_DSH,
  'C:/Users/win10/AppData/Local/Author Software/nvm/installs/v26.10.0/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  join(process.env.APPDATA ?? '', 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
].filter((path) => typeof path === 'string' && path !== '')

const internals = CANDIDATES.find((path) => existsSync(join(path, 'dsh-tools/lib/index.js')))
const skip = internals === undefined ? 'no DSH installation found (set DSH_CONTEXT_CONTROL_DSH)' : false

test('a `when` registration is readable through the unscoped view, and only that', { skip }, async () => {
  const root = pathToFileURL(internals).href
  const { Context } = await import(`${root}/cordis/lib/index.js`)
  const { ToolsService } = await import(`${root}/dsh-tools/lib/index.js`)

  const ctx = new Context()
  /* ToolsService injects this; a real host provides it before the plugin. */
  ctx.provide('systemPrompt', { tools: () => () => {} })
  await ctx.plugin(ToolsService)

  const plain = { name: 'plain_tool', description: 'always', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: () => [] } }
  const conditional = { name: 'conditional_tool', description: 'someday', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: () => [] } }
  const when = ({ modelSelection }) => modelSelection?.model === 'chosen'

  ctx.tools.register(plain)
  ctx.tools.register(conditional, { when })

  /* Both are in the schema list: that is why the scan has to ask further. */
  const names = ctx.tools.schemas().map((schema) => schema.name)
  assert.ok(names.includes('plain_tool'), `plain is missing from ${names}`)
  assert.ok(names.includes('conditional_tool'), `conditional is missing from ${names}`)

  /* Without a step's tool set, `executable` answers exactly one of them. */
  assert.notEqual(ctx.tools.executable('plain_tool'), undefined, 'a plain registration is executable')
  assert.equal(ctx.tools.executable('conditional_tool'), undefined,
    'a conditional registration is not executable without a step')

  /* The panel's read: the same unscoped view, and the `when` itself. */
  const view = ctx.tools.view(undefined)
  assert.ok(view !== undefined && view.registrations instanceof Map, 'no unscoped registration view')
  assert.equal(view.registrations.get('conditional_tool')?.when, when,
    'the view does not carry the registration that `when` came with')
  assert.equal(view.registrations.get('plain_tool')?.when, undefined,
    'a plain registration has no `when`')
})

test('evaluating that `when` out of band leaves the executor untouched', { skip }, async () => {
  const root = pathToFileURL(internals).href
  const { Context } = await import(`${root}/cordis/lib/index.js`)
  const { ToolsService } = await import(`${root}/dsh-tools/lib/index.js`)

  const ctx = new Context()
  /* ToolsService injects this; a real host provides it before the plugin. */
  ctx.provide('systemPrompt', { tools: () => () => {} })
  await ctx.plugin(ToolsService)

  const conditional = { name: 'conditional_tool', description: 'someday', parameters: { type: 'object', properties: {} }, output: { schema: { type: 'string' }, render: () => [] } }
  const when = ({ modelSelection }) => modelSelection?.model === 'chosen'
  ctx.tools.register(conditional, { when })

  const view = ctx.tools.view(undefined)
  const probe = view.registrations.get('conditional_tool').when
  assert.equal(await probe({ modelSelection: { model: 'chosen' } }), true)
  assert.equal(await probe({ modelSelection: { model: 'other' } }), false)

  /* Still gated afterwards: the probe is a read, not a registration change. */
  assert.equal(ctx.tools.executable('conditional_tool'), undefined,
    'probing the `when` changed the registration')
  assert.ok(ctx.tools.definitions().some((entry) => entry.name === 'conditional_tool'),
    'the definition vanished after the probe')
})
