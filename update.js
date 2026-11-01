/**
 * dsh-context-control — update channel (host half).
 *
 * Turns an installed copy into one that can tell you it is behind and move
 * itself forward: a version check against the channel it was installed from,
 * a one-click upgrade that runs the install the way a user would, and a
 * restart that brings the host back by itself.
 *
 * The three pieces are deliberately separate, because each has a different
 * failure mode:
 *
 * 1. **Check** — read-only. It asks the channel the *profile dependency was
 *    written by* (a registry tag, a GitHub release, or a `channel.json` next
 *    to the tarball) what the newest version is, caches the answer, and never
 *    touches the profile. A channel that is down degrades to "unknown", not to
 *    "up to date".
 * 2. **Upgrade** — runs `dsh plugin --profile <p> add <spec>` as a child
 *    process. That is the same path a user's shell uses, so it inherits the
 *    manager's manifest lock, its snapshot/restore on failure, and its
 *    compatibility check. Crucially it *replaces the version in place*
 *    (`pnpm add name@version`) instead of uninstalling first: a self-upgrade
 *    that removed the running plugin before installing the new one would go
 *    dark on any failure, and `pluginManager.installBundle` refuses an
 *    already-installed package for exactly that reason.
 * 3. **Restart** — the host exits; a detached helper waits for the old
 *    process to die and its port to be released, then starts the same command
 *    line again. Without a supervisor (systemd `Restart=always`, pm2, a
 *    Windows service) an exit would otherwise leave the user with a dead GUI,
 *    which is the one outcome an in-product upgrade button must never cause.
 *
 * Nothing here is allowed to break the gating feature: every route answers
 * JSON, and the whole module is mounted inside a try/catch by `index.js`.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_NAME = 'dsh-context-control'

/** Absolute path of this package's root (both files sit at the root). */
const HERE = dirname(fileURLToPath(import.meta.url))

/** The version this module was loaded from — the code that is actually running. */
export const LOADED_VERSION = readOwnManifest().version

function readOwnManifest() {
  const manifest = readJson(join(HERE, 'package.json'))
  return typeof manifest?.version === 'string' ? manifest : { version: '0.0.0' }
}

/** Bytes of pnpm output kept for the UI; the full log stays on disk. */
const LOG_LIMIT = 48 * 1024

const CHECK_TTL_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000
const UPGRADE_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_WEB_PORT = 10550

/* ------------------------------------------------------------------ *
 * versions
 * ------------------------------------------------------------------ */

/** Split a semver string into its parts; undefined when it is not one. */
export function parseVersion(value) {
  if (typeof value !== 'string') return undefined
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function comparePrereleaseIdentifiers(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b)
      if (difference !== 0) return difference < 0 ? -1 : 1
      continue
    }
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** SemVer precedence: -1 | 0 | 1. Unparsable input compares as equal. */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return 0
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  // A release outranks any prerelease of the same version.
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  return comparePrereleaseIdentifiers(a.prerelease, b.prerelease)
}

/** Whether `candidate` is a strictly newer version than `current`. */
export function isNewer(candidate, current) {
  if (parseVersion(candidate) === undefined) return false
  return compareVersions(candidate, current) > 0
}

/** Highest version in a list, ignoring versions that do not parse. */
export function pickHighest(versions) {
  let best
  for (const version of versions) {
    if (parseVersion(version) === undefined) continue
    if (best === undefined || compareVersions(version, best) > 0) best = version
  }
  return best
}

/**
 * Whether `version` satisfies a range such as `>=0.2.0-rc.2`, `^0.3.0`, `*`.
 *
 * This is display-only: it says whether the update we are offering declares
 * itself compatible with the running DSH. The authoritative check is the one
 * the plugin manager runs before pnpm starts; being slightly optimistic here
 * costs a failed install with a real diagnostic, while being pessimistic would
 * hide a legitimate update.
 *
 * `loosePrerelease` mirrors what a prerelease runtime needs. DSH ships as a
 * prerelease (0.2.1-rc.2) while plugin ranges are written for releases
 * (`>=0.2.0`), and strict npm semantics would call every such pair
 * incompatible. With the flag set, a prerelease version is compared by its
 * release triple, which is what those ranges mean in practice.
 */
export function satisfiesRange(range, version, { loosePrerelease = true } = {}) {
  if (typeof range !== 'string' || range.trim() === '') return true
  const parsed = parseVersion(version)
  if (parsed === undefined) return false
  const loose = loosePrerelease && parsed.prerelease.length > 0
  const effective = loose ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : version
  const triple = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  return range.split('||').some((alternative) => {
    const comparators = alternative.trim().split(/\s+/).filter((part) => part !== '')
    if (comparators.length === 0) return true
    /* node-semver's strict rule: a prerelease version only satisfies a set
     * that names a prerelease of the same release triple. Skipped when the
     * caller asked for the loose reading (a prerelease DSH runtime). */
    if (!loose && parsed.prerelease.length > 0) {
      const namesThisPrerelease = comparators.some((comparator) => {
        const wanted = expandComparatorVersion(comparator.replace(/^(?:>=|<=|>|<|=|\^|~)\s*/, ''))
        return wanted !== undefined && wanted.suffix !== '' && wanted.version === triple
      })
      if (!namesThisPrerelease) return false
    }
    return comparators.every((comparator) => matchesComparator(comparator, effective))
  })
}

/**
 * Expand a comparator's version into a floor (and, for wildcard or `=` forms,
 * an exclusive ceiling): `0.3` means `0.3.x`, `0.3.1` means exactly that.
 * A prerelease suffix is kept aside — it never participates in the wildcard
 * expansion but it does participate in the comparison.
 */
function expandComparatorVersion(value) {
  const match = /^v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return undefined
  const parts = [match[1], match[2], match[3]]
  let wildcardFrom = 3
  const numbers = parts.map((part, index) => {
    if (part === undefined) {
      if (wildcardFrom === 3) wildcardFrom = index
      return '0'
    }
    if (/^(?:x|X|\*)$/.test(part)) {
      if (wildcardFrom === 3) wildcardFrom = index
      return '0'
    }
    return String(Number(part))
  })
  const version = numbers.join('.')
  const suffix = match[4] ?? ''
  return { version, suffix, full: `${version}${suffix}`, wildcardFrom, parts: numbers.map(Number) }
}

function matchesComparator(comparator, version) {
  const operatorMatch = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator)
  if (operatorMatch === null) return false
  const operator = operatorMatch[1] ?? '='
  const wantedRaw = operatorMatch[2]
  if (/^(?:\*|x|X)$/.test(wantedRaw.trim())) return true

  const wanted = expandComparatorVersion(wantedRaw)
  if (wanted === undefined) return false
  const order = compareVersions(version, wanted.full)

  /** `major.minor.patch` with one field bumped past the specified prefix. */
  const ceiling = (fields) => {
    const [major, minor, patch] = wanted.parts
    if (fields === 1) return `${major + 1}.0.0`
    if (fields === 2) return `${major}.${minor + 1}.0`
    return `${major}.${minor}.${patch + 1}`
  }

  switch (operator) {
    case '>=': return order >= 0
    case '>': return order > 0
    case '<=': return order <= 0
    case '<': return order < 0
    case '=':
      // `=0.3` is the `0.3.x` band; `=0.3.1` is one version.
      return wanted.wildcardFrom === 3
        ? order === 0
        : order >= 0 && compareVersions(version, ceiling(wanted.wildcardFrom)) < 0
    case '^': {
      if (order < 0) return false
      const fields = wanted.parts[0] > 0 ? 1 : wanted.parts[1] > 0 ? 2 : 3
      return compareVersions(version, ceiling(fields)) < 0
    }
    case '~': {
      if (order < 0) return false
      return compareVersions(version, ceiling(2)) < 0
    }
    default: return false
  }
}

/* ------------------------------------------------------------------ *
 * small IO helpers
 * ------------------------------------------------------------------ */

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** Run `fetch` with a timeout; rejects with a readable message. */
async function fetchJson(url, { timeout = FETCH_TIMEOUT_MS, headers = {}, fetch: fetchImpl } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await (fetchImpl ?? fetch)(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': `${PACKAGE_NAME}-updater`, ...headers },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    return await response.json()
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`timed out after ${timeout}ms: ${url}`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * where the profile, the launcher and the channel are
 * ------------------------------------------------------------------ */

/** DSH home the way the launcher resolves it. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * Classify a profile dependency spec the way pnpm and the plugin manager do.
 * The kind decides which channel can answer "is there a newer version": only a
 * registry range has a tag to ask, and only a tarball URL has a sibling
 * `channel.json`.
 */
export function classifySpec(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return { kind: 'unknown' }
  const value = spec.trim()
  if (/^(?:link|portal):/i.test(value)) return { kind: 'link', path: value.replace(/^(?:link|portal):/i, '') }
  if (/^file:/i.test(value)) return { kind: 'file', path: value.replace(/^file:/i, '') }
  if (/^(?:https?):\/\//i.test(value)) {
    return /\.(?:tgz|tar\.gz)$/i.test(value.split(/[?#]/)[0])
      ? { kind: 'tarball', url: value }
      : { kind: 'git', url: value }
  }
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:)/i.test(value) || /\.git(?:#|$)/i.test(value)) {
    return { kind: 'git', url: value }
  }
  const at = value.lastIndexOf('@')
  // `@scope/name@^1.0.0` has two @s; a bare name has one or none.
  if (at > 0) return { kind: 'registry', name: value.slice(0, at), range: value.slice(at + 1) }
  return { kind: 'registry', name: value, range: '*' }
}

/** Read the profile's own dependency entry for this package. */
export function readProfileDependency(profileDir, name = PACKAGE_NAME) {
  const manifest = readJson(join(profileDir, 'package.json'))
  if (manifest === undefined) return { spec: undefined, kind: 'unknown', manifest: undefined }
  const spec = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]
  return { spec, ...classifySpec(spec), manifest }
}

/** The web port this process serves, for the restart port-release wait. */
function resolvePort(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--port' && index + 1 < argv.length) return Number(argv[index + 1]) || undefined
    const inline = /^--port=(.+)$/.exec(argument)
    if (inline !== null) return Number(inline[1]) || undefined
  }
  return undefined
}

/** Launcher script of the running DSH (`.../@deepseek-ai/dsh/lib/bin.js`). */
export function resolveLauncher() {
  const fromEnv = process.env.DSH_BIN
  if (typeof fromEnv === 'string' && fromEnv !== '' && existsSync(fromEnv)) return fromEnv
  const argvScript = process.argv[1]
  if (typeof argvScript === 'string' && /(?:^|[\\/])bin\.js$/.test(argvScript) && existsSync(argvScript)) {
    return argvScript
  }
  try {
    const require = createRequire(import.meta.url)
    const manifest = require.resolve('@deepseek-ai/dsh/package.json')
    const candidate = join(dirname(manifest), 'lib', 'bin.js')
    if (existsSync(candidate)) return candidate
  } catch { /* not resolvable from this install: rely on argv */ }
  return undefined
}

/** Running DSH version, read from the install the launcher belongs to. */
export function resolveRuntimeVersion(launcher) {
  if (typeof launcher === 'string') {
    const manifest = readJson(join(dirname(dirname(launcher)), 'package.json'))
    if (typeof manifest?.version === 'string') return manifest.version
  }
  return undefined
}

/**
 * The profile this host runs, its dependency spec, and the profile's name —
 * the three things the CLI needs. `profileContext` is the launcher's own
 * answer; the scan is the fallback for hosts that do not expose it.
 */
export function findProfile(ctx, name = PACKAGE_NAME) {
  try {
    const context = typeof ctx?.get === 'function' ? ctx.get('profileContext') : undefined
    if (context !== undefined && typeof context?.dir === 'string' && existsSync(join(context.dir, 'package.json'))) {
      return { dir: context.dir, name: basename(context.dir), ...readProfileDependency(context.dir, name), source: 'profileContext' }
    }
  } catch { /* fall through to the scan */ }
  const profilesDir = join(resolveDshHome(), 'profiles')
  let entries = []
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const dir = join(profilesDir, entry)
    const dependency = readProfileDependency(dir, name)
    if (dependency.spec !== undefined) return { dir, name: entry, ...dependency, source: 'scan' }
  }
  return undefined
}
/** Registry pnpm would use, as written in `.npmrc` / the environment. */
export function resolveRegistry(fallback = 'https://registry.npmjs.org/') {
  const fromEnv = process.env.npm_config_registry
  if (typeof fromEnv === 'string' && /^https?:\/\//.test(fromEnv)) return fromEnv
  const npmrc = readFileSync(join(homedir(), '.npmrc'), 'utf8')
  const match = /^\s*registry\s*=\s*(\S+)\s*$/m.exec(npmrc)
  if (match !== null && /^https?:\/\//.test(match[1])) return match[1]
  return fallback
}

/* ------------------------------------------------------------------ *
 * channels
 * ------------------------------------------------------------------ */

/**
 * Which channel answers for this profile's dependency.
 *
 * Explicit configuration wins (`update.registry`, `update.github`,
 * `update.manifestUrl`); otherwise the installed spec decides, so a machine
 * that was installed from a tarball also upgrades from that tarball's
 * directory and nothing needs configuring by hand.
 */
export function resolveChannel({ config, profile }) {
  const update = config?.update ?? {}
  const name = update.packageName ?? PACKAGE_NAME
  const kind = profile?.kind ?? 'unknown'

  if (typeof update.manifestUrl === 'string' && update.manifestUrl.trim() !== '') {
    return { kind: 'manifest', name, manifestUrl: update.manifestUrl.trim(), origin: 'config' }
  }
  if (typeof update.github === 'string' && /^[\w.-]+\/[\w.-]+$/.test(update.github.trim())) {
    const repo = update.github.trim()
    return { kind: 'github', name, repo, origin: 'config' }
  }
  if (kind === 'tarball') {
    // The channel document ships beside the tarballs: `<dir>/channel.json`.
    // That is what scripts/publish-channel.mjs writes, and it means a tarball
    // install upgrades from where it came from.
    const url = profile.url.split(/[?#]/)[0]
    // A GitHub Release URL is the one case where the sibling is wrong: an
    // upgrade rewrites the dependency to the *tagged* asset
    // (`releases/download/v0.4.1/…`), whose sibling channel.json is frozen at
    // that tag and would never see the next release. The repository-level
    // stable path always follows `latest`.
    const release = /^(https?:\/\/github\.com\/[^/]+\/[^/]+)\/releases\/(?:latest\/)?download\//i.exec(url)
    if (release !== null) {
      return { kind: 'manifest', name, manifestUrl: `${release[1]}/releases/latest/download/channel.json`, origin: 'spec' }
    }
    return { kind: 'manifest', name, manifestUrl: new URL('channel.json', url).href, origin: 'spec' }
  }
  if (kind === 'link' || kind === 'file') {
    // A checkout is not a release: replacing it would overwrite the author's
    // working tree, so an in-place upgrade is offered only when a channel was
    // configured explicitly (checked above).
    return { kind: 'local', name, path: profile.path, origin: 'spec' }
  }
  if (kind === 'git') {
    // A moving branch cannot be diffed against a version; a pinned release can
    // only be replaced by another URL from a channel document.
    return { kind: 'git', name, url: profile.url, origin: 'spec' }
  }
  const registry = typeof update.registry === 'string' && update.registry.trim() !== ''
    ? update.registry.trim()
    : resolveRegistry()
  return { kind: 'registry', name, registry, origin: kind === 'registry' ? 'spec' : 'config' }
}

/**
 * Ask a channel what the newest version is.
 * @returns {Promise<{version?: string, notes?: string, engines?: object, publishedAt?: string, url?: string, error?: string}>}
 */
export async function queryChannel(channel, { timeout = FETCH_TIMEOUT_MS, fetch: fetchImpl } = {}) {
  try {
    if (channel.kind === 'registry') {
      const document = await fetchJson(`${channel.registry.replace(/\/$/, '')}/${encodeURIComponent(channel.name).replace(/^%40/, '@')}/latest`, { timeout, fetch: fetchImpl })
      if (typeof document?.version !== 'string') return { error: 'registry answered without a version' }
      let engines
      try {
        engines = (await fetchJson(`${channel.registry.replace(/\/$/, '')}/${encodeURIComponent(channel.name).replace(/^%40/, '@')}/${document.version}`, { timeout, fetch: fetchImpl }))?.engines
      } catch { /* engines are advisory */ }
      return {
        version: document.version,
        notes: typeof document.description === 'string' ? document.description : undefined,
        engines,
        url: typeof document.homepage === 'string' ? document.homepage : undefined,
        installSpec: `${channel.name}@${document.version}`,
      }
    }
    if (channel.kind === 'github') {
      const release = await fetchJson(`https://api.github.com/repos/${channel.repo}/releases/latest`, {
        timeout,
        fetch: fetchImpl,
        headers: { 'X-GitHub-Api-Version': '2022-11-28' },
      })
      const tag = typeof release?.tag_name === 'string' ? release.tag_name : undefined
      if (tag === undefined) return { error: 'release has no tag_name' }
      const version = tag.replace(/^v/i, '')
      // The publish workflow attaches a version-free copy of the tarball so
      // this URL survives every release (see .github/workflows/publish.yml).
      const tarball = `https://github.com/${channel.repo}/releases/download/${tag}/${channel.name.replace(/^@[^/]+\//, '')}.tgz`
      return {
        version,
        notes: typeof release?.body === 'string' ? release.body.slice(0, 4000) : undefined,
        publishedAt: release?.published_at,
        htmlUrl: release?.html_url,
        installSpec: tarball,
      }
    }
    if (channel.kind === 'manifest') {
      const document = await fetchJson(channel.manifestUrl, { timeout, fetch: fetchImpl })
      const latest = typeof document?.latest === 'string' ? document.latest : undefined
      if (latest === undefined) return { error: 'channel document has no "latest"' }
      const entry = document?.versions?.[latest] ?? {}
      const raw = typeof entry.url === 'string' ? entry.url : undefined
      const absolute = raw === undefined ? undefined : (isAbsolute(raw) ? raw : new URL(raw, channel.manifestUrl).href)
      return {
        version: latest,
        notes: typeof entry.notes === 'string' ? entry.notes : (typeof document.notes === 'string' ? document.notes : undefined),
        engines: entry.engines ?? document.engines,
        publishedAt: entry.publishedAt ?? document.publishedAt,
        htmlUrl: typeof document.homepage === 'string' ? document.homepage : undefined,
        installSpec: absolute,
      }
    }
    if (channel.kind === 'local') {
      return { error: `installed from a local path (${channel.path}); an in-place upgrade would overwrite that checkout — set update.manifestUrl, update.github or update.registry to upgrade from a release` }
    }
    if (channel.kind === 'git') {
      return { error: `installed from a git spec (${channel.url}), which carries no version to compare — set update.manifestUrl or update.github to upgrade from a release` }
    }
    return { error: `channel "${channel.kind}" cannot be queried` }
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

/* ------------------------------------------------------------------ *
 * the updater
 * ------------------------------------------------------------------ */

/**
 * The argument `dsh plugin add` gets for a given channel — the same string a
 * user would type. `undefined` means this channel cannot upgrade in place
 * (a `link:` checkout, or a git branch with no release to point at).
 */
export function installSpecFor(channel, version, info = {}) {
  if (channel.kind === 'registry') return `${channel.name}@${version}`
  if (channel.kind === 'manifest' || channel.kind === 'github') {
    return typeof info.installSpec === 'string' && info.installSpec !== '' ? info.installSpec : undefined
  }
  return undefined
}

/**
 * Build the updater: a cached version check, a single in-flight upgrade job,
 * and the restart hand-off.
 *
 * @param options.ctx Host context (used only for `profileContext`).
 * @param options.config Plugin config; `config.update` is read on every call so
 *   a settings change takes effect without a reload.
 * @param options.logger Sink for warnings (`logger.warn`-shaped).
 */
export function createUpdater({ ctx, config, logger, spawn: spawnProcess = spawn, fetch: fetchImpl } = {}) {
  const warn = (message) => {
    try { logger?.(message) } catch { /* a broken logger must not break the route */ }
  }

  const state = {
    /** `{ at, result }` — the last successful or failed check, cached. */
    check: undefined,
    /** The one upgrade job (only one may run at a time). */
    job: undefined,
    /** Cached resolved profile; invalidated after an install rewrites it. */
    profile: undefined,
  }
  // A plugin reload (HMR re-composition after the install) starts a fresh
  // module instance; the outcome of the run that triggered it must survive.
  state.job = loadJobRecord()

  const updateConfig = () => (config?.update ?? {})

  /**
   * The version on disk right now.
   *
   * Deliberately read per call: after an install this file already names the
   * new version while the module in memory may still be the old one, and that
   * gap is exactly what `stale` below reports.
   */
  function version() {
    return readOwnManifest().version
  }

  /** Whether the running module is older than the files on disk. */
  function stale() {
    return LOADED_VERSION !== version()
  }

  function profile() {
    if (state.profile === undefined) state.profile = findProfile(ctx, updateConfig().packageName ?? PACKAGE_NAME)
    return state.profile
  }

  function channel() {
    return resolveChannel({ config: config ?? {}, profile: profile() })
  }

  function launcher() {
    const override = updateConfig().launcher
    if (typeof override === 'string' && override !== '') return override
    return resolveLauncher()
  }

  /**
   * Running DSH version. `update.runtimeVersion` overrides it for hosts where
   * the launcher cannot be located from inside the plugin (an embedded shell,
   * or a package installed under a different prefix).
   */
  function runtimeVersion() {
    const override = updateConfig().runtimeVersion
    if (typeof override === 'string' && override !== '') return override
    return resolveRuntimeVersion(launcher())
  }

  function hmr() {
    try {
      const service = typeof ctx?.get === 'function' ? ctx.get('hmr') : undefined
      return service !== undefined
    } catch {
      return false
    }
  }

  /** The check, cached for `update.checkIntervalMs`. */
  async function check({ force = false } = {}) {
    const ttl = Number(updateConfig().checkIntervalMs ?? CHECK_TTL_MS)
    const cached = state.check
    const fresh = cached !== undefined && !force && Date.now() - cached.at < ttl
    if (fresh) return cached.result

    const current = version()
    const resolved = channel()
    const profileInfo = profile()
    // Without a profile there is nothing to compare against unless the channel
    // was named explicitly: then the check is still a useful "is a release
    // out there" answer, and the upgrade reports `no-profile` instead.
    const answer = profileInfo === undefined && resolved.origin !== 'config'
      ? { error: 'profile not found: cannot tell which channel this copy came from; set update.manifestUrl or update.github' }
      : await queryChannel(resolved, { fetch: fetchImpl })

    const latest = typeof answer.version === 'string' ? answer.version : undefined
    const hasUpdate = latest !== undefined && isNewer(latest, current)
    const runtime = runtimeVersion()
    // Only claim (in)compatibility when both sides are known: an unknown
    // runtime must not turn into "incompatible" in the UI.
    const compatible = typeof answer.engines?.dsh === 'string' && typeof runtime === 'string'
      ? satisfiesRange(answer.engines.dsh, runtime)
      : undefined
    const result = {
      ok: answer.error === undefined,
      current,
      latest,
      hasUpdate,
      /** Whether a one-click upgrade can be performed from here. */
      canUpgrade: hasUpdate && typeof installSpecFor(resolved, latest, answer) === 'string' && profileInfo !== undefined,
      channel: { kind: resolved.kind, origin: resolved.origin, ...(resolved.registry ? { registry: resolved.registry } : {}), ...(resolved.repo ? { repo: resolved.repo } : {}), ...(resolved.manifestUrl ? { manifestUrl: resolved.manifestUrl } : {}) },
      installSpec: installSpecFor(resolved, latest ?? current, answer) ?? answer.installSpec,
      notes: answer.notes,
      publishedAt: answer.publishedAt,
      url: answer.htmlUrl ?? answer.url,
      installedSpec: profileInfo?.spec,
      profile: profileInfo === undefined ? undefined : { name: profileInfo.name, dir: profileInfo.dir, source: profileInfo.source },
      runtime,
      compatible,
      engines: answer.engines,
      checkedAt: Date.now(),
      error: answer.error,
      upgrading: state.job?.state === 'running',
      hmr: hmr(),
      /** The version whose code is running, which may lag the file on disk. */
      loaded: LOADED_VERSION,
      /**
       * A restart is needed unless the new code is provably live: HMR may have
       * swapped the plugin, but only the module itself can tell (its loaded
       * version), so an HMR host and a stale module still ask for a restart.
       */
      restartRequired: stale() || !hmr(),
      stale: stale(),
    }
    state.check = { at: Date.now(), result }
    return result
  }

  /** Push a line into the bounded job log. */
  function append(job, stream, text) {
    job.log += text
    if (job.log.length > LOG_LIMIT) job.log = job.log.slice(job.log.length - LOG_LIMIT)
    job.updatedAt = Date.now()
    for (const listener of job.listeners) {
      try { listener({ stream, text }) } catch { /* ignore one bad listener */ }
    }
  }

  function jobView(job) {
    if (job === undefined) return { state: 'idle' }
    return {
      id: job.id,
      state: job.state,
      phase: job.phase,
      from: job.from,
      to: job.to,
      spec: job.spec,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      installed: job.installed,
      restartRequired: job.restartRequired,
      error: job.error,
      log: job.log,
    }
  }

  /** The job record path: survives a plugin reload (HMR) the way the install does. */
  function jobRecordPath() {
    return join(resolveDshHome(), 'storages', `${PACKAGE_NAME.replace(/^@[^/]+\//, '')}-update.json`)
  }

  /** Persist the outcome, so a recomposed plugin still reports what happened. */
  function saveJobRecord(job) {
    try {
      const record = { savedAt: Date.now(), job: jobView(job) }
      mkdirSync(dirname(jobRecordPath()), { recursive: true })
      writeFileSync(jobRecordPath(), `${JSON.stringify(record, null, 2)}\n`)
    } catch { /* the record is a convenience, never a dependency */ }
  }

  /** Restore the last outcome if it is recent enough to still be the truth. */
  function loadJobRecord() {
    const record = readJson(jobRecordPath())
    if (record === undefined || typeof record?.savedAt !== 'number') return undefined
    if (Date.now() - record.savedAt > 24 * 60 * 60 * 1000) return undefined
    const restored = record.job
    if (restored === undefined || typeof restored !== 'object') return undefined
    return {
      ...restored,
      // A run that was "running" when the record was read has no process
      // behind it any more: report it as stopped rather than spinning forever.
      state: restored.state === 'running' ? 'failed' : restored.state,
      ...(restored.state === 'running' ? { error: 'the install was interrupted by a reload' } : {}),
      listeners: new Set(),
      child: undefined,
      timer: undefined,
    }
  }

  /**
   * The argument `dsh plugin add` gets for a given channel.
   *
   * A registry install is named as `name@version`; a tarball/git-channel
   * install carries its own URL, which the channel document or release
   * supplies. Both are exactly what a user would type, which is the point: the
   * upgrade runs the documented install path, not a private one.
   */
  function installSpec(to, info) {
    return installSpecFor(channel(), to, info)
  }

  /**
   * One-click upgrade.
   *
   * Runs the install the way the shell would: `dsh plugin add <spec>`. That
   * keeps the profile manifest lock, the snapshot/restore on failure and the
   * compatibility gate in one place, and — unlike uninstall-then-install —
   * never leaves the profile without the package.
   */
  async function upgrade({ version: target } = {}) {
    if (state.job?.state === 'running') return { ok: false, reason: 'busy', job: jobView(state.job) }

    const resolved = channel()
    if (resolved.kind === 'local' || resolved.kind === 'git') {
      return {
        ok: false,
        reason: 'unchanneled',
        channel: resolved.kind,
        error: resolved.kind === 'local'
          ? 'this copy is a local checkout; publish a release or set update.manifestUrl / update.github to upgrade in place'
          : 'this copy came from a git spec; set update.manifestUrl or update.github to upgrade in place',
      }
    }

    let info = await check({ force: false })
    const requested = typeof target === 'string' && target !== '' ? target : undefined
    /* The cached answer may predate the release the user just published: an
     * upgrade click is an explicit "look again", so a cached "nothing to do"
     * gets one fresh look before being believed. */
    if (requested === undefined && (info.latest === undefined || !isNewer(info.latest, info.current))) {
      info = await check({ force: true })
    }
    if (info.error !== undefined && info.hasUpdate !== true) {
      return { ok: false, reason: 'check-failed', error: info.error }
    }
    const to = requested ?? info.latest
    if (typeof to !== 'string') return { ok: false, reason: 'no-version', check: info }
    if (!isNewer(to, info.current)) return { ok: false, reason: 'up-to-date', check: info, current: info.current, latest: to }

    const profileInfo = profile()
    if (profileInfo === undefined) return { ok: false, reason: 'no-profile' }
    const spec = installSpecFor(resolved, to, info)
    if (spec === undefined) {
      return { ok: false, reason: 'unchanneled', channel: resolved.kind, error: 'this channel supplies no install target' }
    }

    const cli = launcher()
    if (cli === undefined) return { ok: false, reason: 'no-launcher', error: 'cannot locate the dsh launcher to run the install' }

    const job = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      state: 'running',
      phase: 'install',
      from: info.current,
      to,
      spec,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      log: '',
      listeners: new Set(),
      child: undefined,
      timer: undefined,
    }
    state.job = job
    append(job, 'system', `$ dsh plugin --profile ${profileInfo.name} add ${spec}\n`)

    const env = { ...process.env, DSH_HOME: resolveDshHome() }
    // The CLI prints to stdio; capture both streams and keep the same text in
    // the profile's own diagnostics directory for after-the-fact debugging.
    let child
    try {
      child = spawnProcess(process.execPath, [cli, 'plugin', '--profile', profileInfo.name, 'add', spec], {
        cwd: profileInfo.dir,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      job.state = 'failed'
      job.phase = 'install'
      job.error = String(error?.message ?? error)
      job.finishedAt = Date.now()
      append(job, 'system', `${job.error}\n`)
      return { ok: false, reason: 'spawn-failed', error: job.error, job: jobView(job) }
    }
    job.child = child

    const timeout = Number(updateConfig().upgradeTimeoutMs ?? UPGRADE_TIMEOUT_MS)
    job.timer = setTimeout(() => {
      append(job, 'system', `\n[timeout] install exceeded ${timeout}ms; stopping it\n`)
      try { child.kill() } catch { /* already gone */ }
    }, timeout)
    if (typeof job.timer.unref === 'function') job.timer.unref()

    const finish = async (exitCode, signal) => {
      clearTimeout(job.timer)
      job.exitCode = exitCode
      job.finishedAt = Date.now()
      if (signal !== undefined && exitCode === null) {
        job.state = 'failed'
        job.error = `install stopped (${signal})`
        return
      }
      if (exitCode !== 0) {
        job.state = 'failed'
        job.error = `dsh plugin add exited with ${exitCode}`
        const diagnostics = /diagnostics: (.+)$/m.exec(job.log)
        if (diagnostics !== null) job.error += ` — log: ${diagnostics[1]}`
        return
      }
      // pnpm's exit code is not proof of the version we asked for: a supply
      // chain delay (`minimumReleaseAge`) can install an older one.
      job.phase = 'verify'
      const installedManifest = readJson(join(profileInfo.dir, 'node_modules', updateConfig().packageName ?? PACKAGE_NAME, 'package.json'))
      job.installed = typeof installedManifest?.version === 'string' ? installedManifest.version : undefined
      job.state = 'done'
      // The install replaced files, so the running module is stale unless HMR
      // re-composed it before this point; `stale()` is the honest answer.
      job.restartRequired = stale() || !hmr()
      if (job.installed !== undefined && job.installed !== to) {
        job.error = `installed ${job.installed}, requested ${to}`
      }
      append(job, 'system', `\n[done] installed ${job.installed ?? 'unknown'}${job.restartRequired ? ' — restart required' : ''}\n`)
      // The cached check described the old install, and the profile manifest
      // now names the new spec: drop both.
      state.check = undefined
      state.profile = undefined
    }

    child.stdout?.on('data', (chunk) => append(job, 'stdout', String(chunk)))
    child.stderr?.on('data', (chunk) => append(job, 'stderr', String(chunk)))
    child.on('error', (error) => {
      clearTimeout(job.timer)
      job.state = 'failed'
      job.error = String(error?.message ?? error)
      job.finishedAt = Date.now()
      append(job, 'system', `${job.error}\n`)
    })
    child.on('close', (code, signal) => {
      void finish(code, signal).finally(() => { saveJobRecord(job) })
    })

    // The HTTP response returns the job id immediately; the install itself is
    // observed through GET /update/job.
    return { ok: true, job: jobView(job) }
  }

  /** Subscribe to a running job's output (used by the streaming route). */
  function subscribe(listener) {
    const job = state.job
    if (job === undefined) return () => {}
    job.listeners.add(listener)
    return () => { job.listeners.delete(listener) }
  }

  /**
   * Restart the host.
   *
   * `respawn` (the default) starts a detached helper that waits for this
   * process to exit and the port to be released, then re-executes the same
   * command line. `exit` is for hosts a supervisor already restarts. `none`
   * only reports what the user has to do.
   */
  function restart() {
    const restartConfig = updateConfig().restart ?? {}
    const mode = typeof restartConfig.mode === 'string' ? restartConfig.mode : 'respawn'
    if (mode === 'none') return { ok: true, mode, restarted: false }
    if (mode === 'exit') {
      setTimeout(() => process.exit(0), 150)
      return { ok: true, mode, restarted: true }
    }
    const cli = launcher()
    if (cli === undefined) {
      setTimeout(() => process.exit(0), 150)
      return { ok: true, mode: 'exit', restarted: true, warning: 'launcher not found: exited without a respawn helper' }
    }
    const helper = join(HERE, 'respawn.cjs')
    if (!existsSync(helper)) {
      setTimeout(() => process.exit(0), 150)
      return { ok: true, mode: 'exit', restarted: true, warning: 'respawn.cjs missing from the package: exited without a helper' }
    }
    const payload = {
      pid: process.pid,
      argv: [process.execPath, cli, ...process.argv.slice(2)],
      cwd: process.cwd(),
      env: { ...process.env },
      port: resolvePort(process.argv) ?? Number(restartConfig.port ?? DEFAULT_WEB_PORT) ?? DEFAULT_WEB_PORT,
      log: restartConfig.logFile ?? join(resolveDshHome(), 'logs', `${basename(process.argv[1] ?? 'dsh').replace(/\.js$/, '')}-respawn.log`),
    }
    try {
      const child = spawnProcess(process.execPath, [helper, Buffer.from(JSON.stringify(payload)).toString('base64')], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        cwd: payload.cwd,
        env: process.env,
      })
      child.unref()
    } catch (error) {
      warn(`dsh-context-control: respawn helper failed to start: ${String(error)}`)
      return { ok: false, mode: 'respawn', restarted: true, error: String(error?.message ?? error) }
    }
    setTimeout(() => process.exit(0), 250)
    return { ok: true, mode: 'respawn', restarted: true, log: payload.log }
  }

  /** Stop a running install (best effort; pnpm children are terminated by the CLI). */
  function cancel() {
    const job = state.job
    if (job?.state !== 'running' || job.child === undefined) return { ok: false, reason: 'not-running' }
    try { job.child.kill() } catch { /* already gone */ }
    job.state = 'cancelled'
    job.finishedAt = Date.now()
    return { ok: true }
  }

  /** Release anything still running when the plugin is disposed. */
  function dispose() {
    const job = state.job
    if (job?.state === 'running') {
      clearTimeout(job.timer)
      try { job.child?.kill() } catch { /* already gone */ }
    }
    if (state.job !== undefined) state.job.listeners.clear()
  }

  return { version, check, upgrade, restart, cancel, subscribe, jobView: () => jobView(state.job), dispose, profile, channel }
}

/* ------------------------------------------------------------------ *
 * HTTP surface
 * ------------------------------------------------------------------ */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function reply(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

function readBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > limit) req.destroy()
    })
    req.on('end', () => {
      if (body === '') return resolve({})
      try { resolve(JSON.parse(body)) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * Route table for the updater, mountable under one prefix.
 * @returns an async `(req, res, subPath) => boolean` that reports whether it
 *   handled the request.
 */
export function createUpdateRoutes(updater, { prefix = '/plugins/dsh-context-control' } = {}) {
  return async function handle(req, res, pathname) {
    if (typeof pathname !== 'string' || !pathname.startsWith(prefix)) return false
    const route = pathname.slice(prefix.length).replace(/\/+$/, '') || '/'

    if (route === '/ping' && req.method === 'GET') {
      reply(res, 200, { ok: true, version: updater.version() })
      return true
    }
    if (route === '/version' && req.method === 'GET') {
      reply(res, 200, { ok: true, version: updater.version(), package: PACKAGE_NAME })
      return true
    }
    if (route === '/update' && req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://x')
      const force = url.searchParams.get('force') === '1'
      reply(res, 200, await updater.check({ force }))
      return true
    }
    if (route === '/update/job' && req.method === 'GET') {
      reply(res, 200, { ok: true, ...updater.jobView() })
      return true
    }
    if (route === '/update/upgrade' && req.method === 'POST') {
      const body = await readBody(req)
      const result = await updater.upgrade({ version: typeof body?.version === 'string' ? body.version : undefined })
      reply(res, result.ok ? 202 : 409, result)
      return true
    }
    if (route === '/update/cancel' && req.method === 'POST') {
      reply(res, 200, updater.cancel())
      return true
    }
    if (route === '/update/restart' && req.method === 'POST') {
      const result = updater.restart()
      reply(res, result.ok ? 200 : 500, result)
      return true
    }
    reply(res, 404, { ok: false, error: `no route ${req.method} ${route}` })
    return true
  }
}
