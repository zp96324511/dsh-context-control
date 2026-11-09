#!/usr/bin/env node
/**
 * Publish guard: fail before npm does.
 *
 * Two failure modes this exists for, both of which only surface *after* a
 * publish, when the version number is already spent:
 *
 * 1. **A missing file.** `files` decides what lands in the tarball, while
 *    `exports`, `dsh.bundle.patch` and `dsh.client` decide what DSH loads.
 *    A target outside `files` installs cleanly and then fails to activate.
 * 2. **Halves that disagree.** The host half mounts routes under one prefix
 *    and the client half fetches under another; a rename that touches only one
 *    of them produces an update popover that never answers.
 *
 * Every expectation is derived from package.json or from the sources
 * themselves, so the next rename is one edit plus whatever this prints.
 *
 * Dependency-free by design: it runs in CI before any install.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const checked = []

const fail = (where, message) => problems.push(`${where}: ${message}`)
const ok = (message) => checked.push(message)

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/* --- identity ------------------------------------------------------------ */

if (typeof pkg.name !== 'string' || pkg.name === '') throw new Error('package.json has no name')
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(pkg.version))) {
  fail('package.json', `version ${JSON.stringify(pkg.version)} is not a semver release`)
} else {
  ok(`version ${pkg.version}`)
}

/* --- installability ------------------------------------------------------ */

const bundlePatch = pkg.dsh?.bundle?.patch
if (typeof bundlePatch !== 'string' || bundlePatch === '') {
  fail('package.json', 'dsh.bundle.patch is missing — the package is not installable as a profile layer')
} else if (!exists(bundlePatch)) {
  fail('package.json', `dsh.bundle.patch points at ${bundlePatch}, which does not exist`)
} else {
  ok(`dsh.bundle.patch = ${bundlePatch}`)
}

const clientEntry = pkg.dsh?.client
if (clientEntry === undefined) {
  fail('package.json', 'dsh.client is missing — the composer panel would not load')
} else {
  if (clientEntry.platform !== 'web') fail('package.json', `dsh.client.platform is ${clientEntry.platform}, expected web`)
  const clientTarget = pkg.exports?.['./client']
  if (typeof clientTarget !== 'string') fail('package.json', 'exports["./client"] is missing')
  else if (!exists(clientTarget)) fail('package.json', `exports["./client"] points at ${clientTarget}, which does not exist`)
  else ok(`client half: ${clientTarget}`)
}

if (typeof pkg.engines?.dsh !== 'string' || pkg.engines.dsh === '') {
  fail('package.json', 'engines.dsh is missing — a marketplace cannot judge host compatibility without it')
} else {
  ok(`engines.dsh = ${pkg.engines.dsh}`)
}

/* --- published surface --------------------------------------------------- */

const published = Array.isArray(pkg.files) ? pkg.files : []
if (published.length === 0) fail('package.json', 'files is empty — npm would publish the whole checkout')

const matchesPublished = (path) => published.some((entry) => {
  if (entry === path) return true
  if (entry.endsWith('/*.json')) return path.startsWith(entry.slice(0, -'*.json'.length))
  if (entry.endsWith('/*')) return path.startsWith(entry.slice(0, -1))
  return false
})

function exists(relativePath) {
  try {
    return statSync(join(root, relativePath)).isFile()
  } catch {
    return false
  }
}

for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
  if (typeof target !== 'string' || target.includes('*')) continue
  const path = target.replace(/^\.\//, '')
  // npm always ships the manifest and the readme/licence, whatever `files` says.
  const alwaysShipped = path === 'package.json' || /^(?:README|LICENSE|CHANGELOG)/i.test(path)
  if (!exists(path)) fail('package.json', `exports["${subpath}"].${path} does not exist`)
  else if (!alwaysShipped && !matchesPublished(path)) fail('package.json', `exports["${subpath}"].${path} is not covered by files — the published tarball would not contain it`)
  else ok(`exports["${subpath}"] published`)
}

/* Every top-level file that must ship, beyond what exports mentions. */
for (const required of ['update.js']) {
  if (!exists(required)) fail('package.json', `${required} is missing — the update channel cannot work without it`)
  else if (!matchesPublished(required)) fail('package.json', `${required} is not in files — an installed copy could not upgrade itself`)
  else ok(`${required} published`)
}

/* --- the two halves must agree about identity and routes ----------------- */

const hostSource = readFileSync(join(root, 'index.js'), 'utf8')
const clientSource = readFileSync(join(root, 'client.js'), 'utf8')
const hostRoute = /const prefix = '([^']+)'/.exec(hostSource)
const clientRoute = /plugins\/dsh-context-control/.test(clientSource)

if (hostRoute === null) fail('index.js', 'the update route prefix is not declared')
else {
  if (hostRoute[1] !== '/plugins/dsh-context-control') {
    fail('index.js', `route prefix is ${hostRoute[1]}, expected /plugins/dsh-context-control`)
  }
  if (!clientRoute) fail('client.js', `the client does not fetch ${hostRoute[1]}`)
  else ok(`both halves use ${hostRoute[1]}`)
}

const pluginIdHost = /export const name = '([^']+)'/.exec(hostSource)
const pluginIdClient = /id: '([^']+)'/.exec(clientSource)
if (pluginIdHost === null || pluginIdClient === null) {
  fail('source', 'a plugin id could not be read from one of the halves')
} else if (pluginIdHost[1] !== pluginIdClient[1]) {
  fail('source', `host id ${pluginIdHost[1]} != client id ${pluginIdClient[1]}`)
} else if (pluginIdHost[1] !== pkg.name) {
  fail('package.json', `plugin id ${pluginIdHost[1]} does not match the package name ${pkg.name}`)
} else {
  ok(`plugin id ${pluginIdHost[1]} matches the package name in both halves`)
}

/* --- the update channel's own contracts ---------------------------------- */

if (!/createUpdateRoutes|createUpdater/.test(hostSource)) {
  fail('index.js', 'the update channel is not mounted')
}
for (const asset of ['update.js']) {
  const source = exists(asset) ? readFileSync(join(root, asset), 'utf8') : ''
  if (!/export function installSpecFor/.test(source)) {
    fail('update.js', 'installSpecFor is not exported — the tests and the host rely on it')
  }
}

/* --- repo hygiene -------------------------------------------------------- */

const stray = walk(root).filter((path) => /(^|\/)node_modules(\/|$)/.test(path) === false
  && /\.(?:orig|rej|bak)$/.test(path)
  && !path.startsWith('test/'))
if (stray.length > 0) fail('tree', `stray backup files would be published: ${stray.join(', ')}`)

/* Every .mjs/.cjs/.js under test/ and scripts/ must parse. `node --check`
 * runs in `npm run check`; this only asserts they are listed there. */
const checkScript = String(pkg.scripts?.check ?? '')
const testScript = String(pkg.scripts?.test ?? '')
for (const script of ['index.js', 'update.js', 'client.js']) {
  if (!checkScript.includes(`node --check ${script}`)) fail('package.json', `scripts.check does not syntax-check ${script}`)
}
if (!/test\/update\.test\.mjs/.test(testScript)) fail('package.json', 'scripts.test does not run the host tests')
if (!/client-harness\.cjs/.test(testScript)) fail('package.json', 'scripts.test does not run the client harness')
if (!/npm run test/.test(checkScript)) fail('package.json', 'scripts.check does not delegate to scripts.test')

/* --- report -------------------------------------------------------------- */

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(relative(root, full).split(sep).join('/'))
  }
  return out
}

if (problems.length > 0) {
  console.error(`check-manifest: ${problems.length} problem(s)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`check-manifest: ok (${checked.length} checks)`)
for (const line of checked) console.log(`  · ${line}`)
