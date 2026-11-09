/* Host-side tests for update.js: version math, channel resolution, the check
 * against a real local HTTP channel, and the route surface.
 *
 * Runs with `node --test`. No network: the channel is a throwaway
 * `http.createServer` on 127.0.0.1, and every profile is a temp directory, so
 * the suite never reads or writes the user's ~/.dsh. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import {
  compareVersions,
  isNewer,
  installSpecFor,
  classifySpec,
  createUpdater,
  createUpdateRoutes,
  findProfile,
  parseVersion,
  resolveChannel,
  resolveDshHome,
  resolveRegistry,
  satisfiesRange,
} from '../update.js'

const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const CURRENT = MANIFEST.version
/** A version that is newer than whatever this checkout claims to be. */
const NEXT = '99.0.0'

/* ------------------------------------------------------------------ */

test('parseVersion accepts releases and prereleases, rejects junk', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] })
  assert.deepEqual(parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] })
  assert.deepEqual(parseVersion('1.2.3-rc.2').prerelease, ['rc', '2'])
  assert.deepEqual(parseVersion('1.2.3+build.5').prerelease, [])
  assert.equal(parseVersion('1.2'), undefined)
  assert.equal(parseVersion('latest'), undefined)
  assert.equal(parseVersion(undefined), undefined)
})

test('a release outranks its prerelease, and prereleases order by identifier', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1)
  assert.equal(compareVersions('1.0.0-rc.2', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-1'), 1, 'numeric identifiers sort before alphanumeric')
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0)
})

test('isNewer is strict and ignores unparsable versions', () => {
  assert.equal(isNewer('0.2.2', '0.2.1'), true)
  assert.equal(isNewer('0.2.1', '0.2.1'), false)
  assert.equal(isNewer('0.2.1', '0.2.2'), false)
  assert.equal(isNewer('nightly', '0.2.1'), false)
})

test('satisfiesRange covers the shapes a plugin declares in engines.dsh', () => {
  assert.equal(satisfiesRange('>=0.2.0', '0.2.1'), true)
  assert.equal(satisfiesRange('>=0.2.0', '0.1.9'), false)
  assert.equal(satisfiesRange('^0.3.0', '0.3.4'), true)
  assert.equal(satisfiesRange('^0.3.0', '0.4.0'), false)
  assert.equal(satisfiesRange('^0.0.3', '0.0.9'), false)
  assert.equal(satisfiesRange('~0.3.1', '0.3.9'), true)
  assert.equal(satisfiesRange('~0.3.1', '0.4.0'), false)
  assert.equal(satisfiesRange('0.3', '0.3.7'), true, 'a partial version is a band')
  assert.equal(satisfiesRange('0.3', '0.4.0'), false)
  assert.equal(satisfiesRange('*', '0.0.1'), true)
  assert.equal(satisfiesRange('>=0.2.0 <1.0.0', '0.9.0'), true)
  assert.equal(satisfiesRange('>=0.2.0 <1.0.0', '1.0.0'), false)
  assert.equal(satisfiesRange('>=1.0.0 || ^0.2.0', '0.2.5'), true)
  assert.equal(satisfiesRange('', '0.0.0'), true, 'an empty range accepts everything')
})

test('a prerelease runtime is judged by its release triple when asked to be loose', () => {
  // DSH ships as 0.2.1-rc.2 while plugin ranges are written for releases.
  assert.equal(satisfiesRange('>=0.2.0', '0.2.1-rc.2', { loosePrerelease: false }), false,
    'strict npm semantics reject a prerelease outside the range triple')
  assert.equal(satisfiesRange('>=0.2.0', '0.2.1-rc.2'), true)
  assert.equal(satisfiesRange('>=0.2.0-rc.2', '0.2.1-rc.2', { loosePrerelease: false }), false)
})

test('classifySpec reads every dependency form pnpm accepts', () => {
  assert.equal(classifySpec('link:C:/work/plugin').kind, 'link')
  assert.equal(classifySpec('file:../plugin').kind, 'file')
  assert.equal(classifySpec('dsh-context-control').kind, 'registry')
  assert.equal(classifySpec('dsh-context-control').range, '*')
  assert.equal(classifySpec('dsh-context-control@^0.2.1').range, '^0.2.1')
  assert.equal(classifySpec('@scope/name@1.0.0').name, '@scope/name')
  assert.equal(classifySpec('https://host/a/dsh-context-control-0.2.1.tgz').kind, 'tarball')
  assert.equal(classifySpec('https://host/a/dsh-context-control-0.2.1.tar.gz').kind, 'tarball')
  assert.equal(classifySpec('https://host/repo/archive/master.tar.gz').kind, 'tarball')
  assert.equal(classifySpec('github:owner/repo#v1.0.0').kind, 'git')
  assert.equal(classifySpec('git+https://github.com/owner/repo.git').kind, 'git')
  assert.equal(classifySpec('').kind, 'unknown')
})

test('the channel follows the install spec unless one is configured', () => {
  const tarball = resolveChannel({
    config: { update: {} },
    profile: { kind: 'tarball', url: 'https://host/dl/dsh-context-control-0.2.1.tgz' },
  })
  assert.equal(tarball.kind, 'manifest')
  assert.equal(tarball.manifestUrl, 'https://host/dl/channel.json')
  assert.equal(tarball.origin, 'spec')

  /* A GitHub Release install: an upgrade rewrites the dependency to the tagged
   * asset, so the sibling channel.json would be frozen at that tag. The
   * repository-level stable path is the one that keeps following `latest`. */
  for (const spec of [
    'https://github.com/owner/repo/releases/latest/download/dsh-context-control.tgz',
    'https://github.com/owner/repo/releases/download/v0.4.1/dsh-context-control.tgz',
  ]) {
    const githubRelease = resolveChannel({ config: { update: {} }, profile: { kind: 'tarball', url: spec } })
    assert.equal(githubRelease.kind, 'manifest')
    assert.equal(githubRelease.manifestUrl, 'https://github.com/owner/repo/releases/latest/download/channel.json', spec)
  }

  const registry = resolveChannel({
    config: { update: { registry: 'https://registry.example/' } },
    profile: { kind: 'registry', range: '^0.2.0' },
  })
  assert.equal(registry.kind, 'registry')
  assert.equal(registry.registry, 'https://registry.example/')

  const local = resolveChannel({ config: { update: {} }, profile: { kind: 'link', path: 'C:/work' } })
  assert.equal(local.kind, 'local', 'a checkout is never replaced in place')

  const pinned = resolveChannel({
    config: { update: { manifestUrl: 'https://host/channel.json' } },
    profile: { kind: 'link', path: 'C:/work' },
  })
  assert.equal(pinned.kind, 'manifest', 'an explicit channel wins over the spec')
  assert.equal(pinned.origin, 'config')

  const github = resolveChannel({
    config: { update: { github: 'owner/dsh-context-control' } },
    profile: { kind: 'registry', range: '^0.2.0' },
  })
  assert.equal(github.kind, 'github')
  assert.equal(github.repo, 'owner/dsh-context-control')
})

test('installSpecFor produces the argument a user would type', () => {
  assert.equal(installSpecFor({ kind: 'registry', name: 'pkg' }, '1.2.3'), 'pkg@1.2.3')
  assert.equal(
    installSpecFor({ kind: 'manifest', name: 'pkg' }, '1.2.3', { installSpec: 'https://host/pkg.tgz' }),
    'https://host/pkg.tgz',
  )
  assert.equal(installSpecFor({ kind: 'local', name: 'pkg' }, '1.2.3'), undefined)
  assert.equal(installSpecFor({ kind: 'git', name: 'pkg' }, '1.2.3'), undefined)
})

/* ------------------------------------------------------------------ *
 * a throwaway channel over real HTTP
 * ------------------------------------------------------------------ */

/** Serve `routes` (path → JSON) and hand back its base URL and a closer. */
async function withChannel(routes, run) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://x').pathname
    const body = routes[path]
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await run(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** A temp DSH home whose `web` profile declares `spec` for this package. */
function profileHome(spec, name = 'web') {
  const home = mkdtempSync(join(tmpdir(), 'dcc-home-'))
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: { 'dsh-context-control': spec },
  }, null, 2))
  return { home, dir }
}

const channelDocument = (base, latest) => ({
  name: 'dsh-context-control',
  latest,
  channel: 'stable',
  versions: {
    [latest]: {
      url: `dsh-context-control-${latest}.tgz`,
      engines: { dsh: '>=0.2.0-rc.2' },
    },
  },
  homepage: 'https://example.invalid/dsh-context-control',
})

/* ------------------------------------------------------------------ *
 * DSH home resolution and user-level npm configuration
 * ------------------------------------------------------------------ */

test('a DSH_HOME with a trailing separator still finds the profile', () => {
  const { home, dir } = profileHome('^0.6.0')
  const previous = process.env.DSH_HOME
  try {
    // Both separators are separators to Node on Windows; only `/` elsewhere.
    const forms = process.platform === 'win32' ? [home + '\\', home + '/'] : [home + '/']
    for (const value of forms) {
      process.env.DSH_HOME = value
      assert.equal(resolveDshHome(), resolve(home), `a trailing separator survived: ${value}`)
      const profile = findProfile(undefined, 'dsh-context-control')
      assert.equal(profile?.dir, dir, `profile scan missed the profile for ${value}`)
      assert.equal(profile?.source, 'scan')
      assert.ok(!profile.dir.includes(`${sep}${sep}`) && !profile.dir.includes('//'), `duplicate separators in ${profile.dir}`)
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a DSH_HOME with surrounding whitespace resolves to the trimmed value', () => {
  const { home, dir } = profileHome('^0.6.0')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = `  \t${home}  \n`
  try {
    assert.equal(resolveDshHome(), resolve(home), 'the untrimmed value was used')
    assert.equal(findProfile(undefined, 'dsh-context-control')?.dir, dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a tilde DSH_HOME expands against the OS home', () => {
  const previous = process.env.DSH_HOME
  const expected = join(homedir(), 'dcc-tilde-probe')
  try {
    for (const value of ['~/dcc-tilde-probe', '~\\dcc-tilde-probe']) {
      process.env.DSH_HOME = value
      const resolved = resolveDshHome()
      assert.equal(resolved, expected, `${value} resolved to ${resolved}`)
      assert.ok(!resolved.includes('~'), `a literal ~ leaked into ${resolved}`)
    }
    process.env.DSH_HOME = '~'
    assert.equal(resolveDshHome(), resolve(homedir()))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a blank DSH_HOME falls back to <home>/.dsh', () => {
  const previous = process.env.DSH_HOME
  const expected = resolve(join(homedir(), '.dsh'))
  try {
    process.env.DSH_HOME = '   \t\n'
    assert.equal(resolveDshHome(), expected, 'whitespace was treated as a path')
    delete process.env.DSH_HOME
    assert.equal(resolveDshHome(), expected, 'an unset DSH_HOME did not fall back')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('resolveRegistry survives a missing ~/.npmrc and keeps its precedence', () => {
  const npmHome = mkdtempSync(join(tmpdir(), 'dcc-npmrc-'))
  const fallback = 'https://fallback.invalid/'
  const previous = process.env.npm_config_registry
  delete process.env.npm_config_registry
  try {
    // No ~/.npmrc at all: the old read threw ENOENT and failed the whole channel.
    assert.equal(resolveRegistry(fallback, { home: npmHome }), fallback)

    writeFileSync(join(npmHome, '.npmrc'), 'registry=https://registry.example/\n')
    assert.equal(resolveRegistry(fallback, { home: npmHome }), 'https://registry.example/')

    process.env.npm_config_registry = 'https://env.example/'
    assert.equal(resolveRegistry(fallback, { home: npmHome }), 'https://env.example/', 'the environment variable wins')
  } finally {
    if (previous === undefined) delete process.env.npm_config_registry
    else process.env.npm_config_registry = previous
  }
})


test('a tarball install checks its own channel.json and finds an update', async () => {
  await withChannel({
    '/dl/channel.json': channelDocument('', NEXT),
  }, async (base) => {
    const { home, dir } = profileHome(`${base}/dl/dsh-context-control-${CURRENT}.tgz`)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const updater = createUpdater({
        ctx: { get: () => undefined },
        // The launcher is not locatable under `node --test`, so the runtime
        // version — what `engines.dsh` is judged against — is given explicitly.
        config: { update: { runtimeVersion: '0.2.1-rc.2' } },
      })
      const info = await updater.check({ force: true })
      assert.equal(info.ok, true, info.error)
      assert.equal(info.current, CURRENT)
      assert.equal(info.runtime, '0.2.1-rc.2')
      assert.equal(info.latest, NEXT)
      assert.equal(info.hasUpdate, true)
      assert.equal(info.canUpgrade, true)
      assert.equal(info.channel.kind, 'manifest')
      assert.equal(info.installSpec, `${base}/dl/dsh-context-control-${NEXT}.tgz`)
      assert.equal(info.profile.dir, dir)
      assert.equal(info.profile.name, 'web')
      assert.equal(info.compatible, true, 'engines.dsh is judged against the running DSH')

      // The second call is served from the cache, not the channel.
      const again = await updater.check()
      assert.equal(again.checkedAt, info.checkedAt, 'a cached check was re-fetched')

      updater.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

test('an up-to-date channel reports no update and nothing to install', async () => {
  await withChannel({
    '/dl/channel.json': channelDocument('', CURRENT),
  }, async (base) => {
    const { home } = profileHome(`${base}/dl/dsh-context-control-${CURRENT}.tgz`)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const updater = createUpdater({ ctx: { get: () => undefined }, config: { update: {} } })
      const info = await updater.check({ force: true })
      assert.equal(info.hasUpdate, false)
      assert.equal(info.canUpgrade, false)
      assert.equal(info.ok, true)
      const refusal = await updater.upgrade()
      assert.equal(refusal.ok, false)
      assert.equal(refusal.reason, 'up-to-date')
      updater.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

test('a registry channel asks the tag endpoint and upgrades by name@version', async () => {
  await withChannel({
    '/dsh-context-control/latest': { version: NEXT, description: 'gating', homepage: 'https://example.invalid' },
    [`/dsh-context-control/${NEXT}`]: { version: NEXT, engines: { dsh: '>=0.2.0-rc.2' } },
  }, async (base) => {
    const { home } = profileHome('^0.2.0')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const updater = createUpdater({ ctx: { get: () => undefined }, config: { update: { registry: base } } })
      const info = await updater.check({ force: true })
      assert.equal(info.ok, true, info.error)
      assert.equal(info.latest, NEXT)
      assert.equal(info.hasUpdate, true)
      assert.equal(info.installSpec, `dsh-context-control@${NEXT}`, 'a registry update is named, not linked')

      // A local checkout is refused with its own reason, not as a failed check.
      const localHome = profileHome('link:C:/work/dsh-context-control')
      process.env.DSH_HOME = localHome.home
      const local = createUpdater({ ctx: { get: () => undefined }, config: { update: {} } })
      const refusal = await local.upgrade()
      assert.equal(refusal.ok, false)
      assert.equal(refusal.reason, 'unchanneled')
      assert.match(refusal.error, /local checkout/i)
      local.dispose()
      updater.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

test('a dead channel is an error, never "up to date"', async () => {
  const { home } = profileHome('https://127.0.0.1:9/dl/dsh-context-control-0.0.1.tgz')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const updater = createUpdater({ ctx: { get: () => undefined }, config: { update: {} } })
    const info = await updater.check({ force: true })
    assert.equal(info.ok, false)
    assert.equal(typeof info.error, 'string')
    assert.equal(info.hasUpdate, false)
    const refusal = await updater.upgrade()
    assert.equal(refusal.ok, false)
    assert.equal(refusal.reason, 'check-failed')
    updater.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

/* ------------------------------------------------------------------ *
 * routes
 * ------------------------------------------------------------------ */

function fakeUpdater(overrides = {}) {
  return {
    version: () => CURRENT,
    check: async () => ({ ok: true, current: CURRENT, latest: NEXT, hasUpdate: true, canUpgrade: true }),
    upgrade: async ({ version } = {}) => ({ ok: true, job: { id: 'job-1', state: 'running', to: version ?? NEXT } }),
    cancel: () => ({ ok: true }),
    jobView: () => ({ state: 'idle' }),
    ...overrides,
  }
}

/** Minimal req/res doubles: the route layer only reads `url`, `method`, events. */
function call(handle, method, path, body) {
  const request = {
    method,
    url: path,
    on(event, listener) {
      if (event === 'end') listener()
      if (event === 'data' && body !== undefined) listener(JSON.stringify(body))
      return request
    },
    destroy() {},
  }
  const state = { status: 0, body: undefined, headers: undefined }
  const response = {
    writeHead(status, headers) { state.status = status; state.headers = headers },
    end(payload) { state.body = payload === undefined ? undefined : JSON.parse(payload) },
  }
  return Promise.resolve(handle(request, response, new URL(path, 'http://x').pathname)).then((handled) => ({
    handled,
    status: state.status,
    body: state.body,
    headers: state.headers,
  }))
}

test('the update route table answers JSON and 404s anything else', async () => {
  const handle = createUpdateRoutes(fakeUpdater())
  const prefix = '/plugins/dsh-context-control'

  const ping = await call(handle, 'GET', `${prefix}/ping`)
  assert.equal(ping.handled, true)
  assert.deepEqual(ping.body, { ok: true, version: CURRENT })

  const status = await call(handle, 'GET', `${prefix}/update?force=1`)
  assert.equal(status.status, 200)
  assert.equal(status.body.hasUpdate, true)
  assert.equal(status.headers['cache-control'], 'no-store', 'a check must never be cached by the browser')

  const upgrade = await call(handle, 'POST', `${prefix}/update/upgrade`, { version: NEXT })
  assert.equal(upgrade.status, 202)
  assert.equal(upgrade.body.job.id, 'job-1')

  const job = await call(handle, 'GET', `${prefix}/update/job`)
  assert.equal(job.body.state, 'idle')

  /* Restarting the host is not the plugin's job: the route does not exist. */
  const restart = await call(handle, 'POST', `${prefix}/update/restart`)
  assert.equal(restart.status, 404)

  const missing = await call(handle, 'GET', `${prefix}/nope`)
  assert.equal(missing.status, 404)

  const outside = await call(handle, 'GET', '/plugins/other/ping')
  assert.equal(outside.handled, false, 'an unrelated prefix is not claimed')
})

test('a refused upgrade is 409 with the reason intact', async () => {
  const handle = createUpdateRoutes(fakeUpdater({
    upgrade: async () => ({ ok: false, reason: 'up-to-date', current: CURRENT, latest: CURRENT }),
  }))
  const response = await call(handle, 'POST', '/plugins/dsh-context-control/update/upgrade', {})
  assert.equal(response.status, 409)
  assert.equal(response.body.reason, 'up-to-date')
})

/* ------------------------------------------------------------------ *
 * the upgrade itself, with a stubbed installer
 * ------------------------------------------------------------------ */

/** A ChildProcess stand-in: emits output, then closes with `code`. */
function fakeChild({ code = 0, output = '', onSpawn } = {}) {
  const listeners = new Map()
  const child = {
    pid: 4242,
    stdout: { on: (event, fn) => { listeners.set(`stdout:${event}`, fn) } },
    stderr: { on: (event, fn) => { listeners.set(`stderr:${event}`, fn) } },
    on(event, fn) { listeners.set(`child:${event}`, fn); return child },
    kill() { listeners.get('child:close')?.(null, 'SIGTERM') },
  }
  setTimeout(() => {
    onSpawn?.(listeners)
    if (output !== '') listeners.get('stdout:data')?.(output)
    listeners.get('child:close')?.(code, null)
  }, 5)
  return child
}

test('an upgrade runs the documented install and reports what landed', async () => {
  await withChannel({ '/dl/channel.json': channelDocument('', NEXT) }, async (base) => {
    const { home, dir } = profileHome(`${base}/dl/dsh-context-control-${CURRENT}.tgz`)
    // The installer is stubbed; what it would have written is placed by hand.
    mkdirSync(join(dir, 'node_modules', 'dsh-context-control'), { recursive: true })
    writeFileSync(
      join(dir, 'node_modules', 'dsh-context-control', 'package.json'),
      JSON.stringify({ name: 'dsh-context-control', version: NEXT }),
    )

    const spawned = []
    const updater = createUpdater({
      ctx: { get: () => undefined },
      config: { update: { launcher: process.execPath } },
      spawn: (command, args, options) => {
        spawned.push({ command, args, options })
        return fakeChild({ output: `+ dsh-context-control ${NEXT}\n` })
      },
    })
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const started = await updater.upgrade()
      assert.equal(started.ok, true, JSON.stringify(started))
      assert.equal(started.job.state, 'running')

      await new Promise((resolve) => setTimeout(resolve, 60))
      const view = updater.jobView()
      assert.equal(view.state, 'done', view.error)
      assert.equal(view.from, CURRENT)
      assert.equal(view.to, NEXT)
      assert.equal(view.installed, NEXT)
      assert.equal(view.exitCode, 0)
      assert.match(view.log, /dsh plugin --profile web add/, 'the log does not show the command it ran')
      assert.match(view.log, /installed 99\.0\.0/)
      assert.match(view.log, /restart dsh web to apply/, 'the log must tell the user to restart the host')
      assert.equal(view.restartRequired, true)

      // The command is the one a user would type, in the profile directory.
      assert.equal(spawned.length, 1)
      assert.match(spawned[0].args[1], /plugin$/)
      assert.deepEqual(spawned[0].args.slice(2), ['--profile', 'web', 'add', `${base}/dl/dsh-context-control-${NEXT}.tgz`])
      assert.equal(spawned[0].options.cwd, dir)
      assert.equal(spawned[0].command, process.execPath)

      // The outcome is on disk for the plugin instance the install replaces.
      const record = JSON.parse(readFileSync(join(home, 'storages', 'dsh-context-control-update.json'), 'utf8'))
      assert.equal(record.job.state, 'done')
      assert.equal(record.job.installed, NEXT)
      updater.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

test('a failed install is reported as failed and does not claim a version', async () => {
  await withChannel({ '/dl/channel.json': channelDocument('', NEXT) }, async (base) => {
    const { home } = profileHome(`${base}/dl/dsh-context-control-${CURRENT}.tgz`)
    const updater = createUpdater({
      ctx: { get: () => undefined },
      config: { update: { launcher: process.execPath } },
      spawn: () => fakeChild({ code: 1, output: 'ERR_PNPM_FETCH_404\n' }),
    })
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      assert.equal((await updater.upgrade()).ok, true)
      await new Promise((resolve) => setTimeout(resolve, 60))
      const view = updater.jobView()
      assert.equal(view.state, 'failed')
      assert.equal(view.exitCode, 1)
      assert.match(view.error, /1/)
      assert.equal(view.installed, undefined)
      updater.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})

test('an upgrade click re-checks a cached "nothing to do" answer', async () => {
  let latest = CURRENT
  await withChannel({ '/dl/channel.json': channelDocument('', CURRENT) }, async (base) => {
    const { home } = profileHome(`${base}/dl/dsh-context-control-${CURRENT}.tgz`)
    mkdirSync(join(home, 'profiles', 'web', 'node_modules', 'dsh-context-control'), { recursive: true })
    writeFileSync(
      join(home, 'profiles', 'web', 'node_modules', 'dsh-context-control', 'package.json'),
      JSON.stringify({ name: 'dsh-context-control', version: NEXT }),
    )
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/channel.json')) {
        return { ok: true, status: 200, async json() { return channelDocument('', latest) } }
      }
      throw new Error(`unexpected fetch ${url}`)
    }
    const updater = createUpdater({
      ctx: { get: () => undefined },
      config: { update: { checkIntervalMs: 60 * 60 * 1000, launcher: process.execPath } },
      fetch: fetchImpl,
      spawn: () => fakeChild({ output: 'installed\n' }),
    })
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      // First check: nothing to do, and it is cached for an hour.
      const first = await updater.check()
      assert.equal(first.hasUpdate, false)
      // A release appears; the cached answer still says "nothing to do".
      latest = NEXT
      const again = await updater.check()
      assert.equal(again.hasUpdate, false, 'the cache was expected to answer')
      // Clicking upgrade must not be defeated by that cache.
      const started = await updater.upgrade()
      assert.equal(started.ok, true, JSON.stringify(started))
      assert.equal(started.job.to, NEXT)
      updater.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})



test('the outcome of an install survives the plugin reload it caused', () => {
  const home = mkdtempSync(join(tmpdir(), 'dcc-home-'))
  mkdirSync(join(home, 'storages'), { recursive: true })
  const recordPath = join(home, 'storages', 'dsh-context-control-update.json')
  const banner = {
    id: 'job-1', state: 'done', phase: 'verify', from: '0.3.0', to: '0.3.1',
    installed: '0.3.1', restartRequired: true, exitCode: 0, log: '[done] installed 0.3.1\n',
  }
  writeFileSync(recordPath, JSON.stringify({ savedAt: Date.now(), job: banner }))

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const updater = createUpdater({ ctx: { get: () => undefined }, config: { update: {} } })
    const view = updater.jobView()
    assert.equal(view.state, 'done', 'the finished job was lost across the reload')
    assert.equal(view.installed, '0.3.1')
    assert.equal(view.to, '0.3.1')
    assert.match(view.log, /installed 0\.3\.1/)
    updater.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a job recorded as running is reported as interrupted, not as still running', () => {
  const home = mkdtempSync(join(tmpdir(), 'dcc-home-'))
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(
    join(home, 'storages', 'dsh-context-control-update.json'),
    JSON.stringify({ savedAt: Date.now(), job: { id: 'job-2', state: 'running', from: '0.3.0', to: '0.3.1', log: '' } }),
  )
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const updater = createUpdater({ ctx: { get: () => undefined }, config: { update: {} } })
    const view = updater.jobView()
    assert.equal(view.state, 'failed')
    assert.match(view.error, /interrupted/)
    updater.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a stale record is ignored rather than replayed', () => {
  const home = mkdtempSync(join(tmpdir(), 'dcc-home-'))
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(
    join(home, 'storages', 'dsh-context-control-update.json'),
    JSON.stringify({ savedAt: Date.now() - 48 * 60 * 60 * 1000, job: { id: 'old', state: 'done' } }),
  )
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const updater = createUpdater({ ctx: { get: () => undefined }, config: { update: {} } })
    assert.equal(updater.jobView().state, 'idle')
    updater.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
