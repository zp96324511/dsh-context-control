#!/usr/bin/env node
/**
 * Build a static update channel from this checkout.
 *
 * The channel is the whole distribution story for a self-hosted plugin: one
 * tarball per version, plus a `channel.json` beside them naming the newest one.
 * Any static file host will do (nginx, GitHub Pages, an object store); the
 * plugin derives `<dir>/channel.json` from the tarball URL it was installed
 * from, so nothing has to be configured on the machine that upgrades.
 *
 * `channel.json` accumulates versions instead of replacing them, so an
 * installation pinned to an older release keeps a tarball to fall back to, and
 * `--prune <n>` is the explicit way to drop them.
 *
 * Usage:
 *   node scripts/publish-channel.mjs                 # pack the current version
 *   node scripts/publish-channel.mjs --prune 5       # keep the last 5 versions
 *   node scripts/publish-channel.mjs --dist D:/www   # publish into another root
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
  return value
}

const dist = resolve(flag('dist', join(root, 'dist')))
const prune = Number(flag('prune', '0')) || 0
const homepage = typeof pkg.homepage === 'string' ? pkg.homepage : undefined

mkdirSync(dist, { recursive: true })

/* `npm pack` honours `files`, so the tarball is exactly what an install gets. */
process.stdout.write(`packing ${pkg.name}@${pkg.version} … `)
const packOutput = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dist], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
}))
const packed = packOutput[0]
if (packed === undefined) throw new Error('npm pack produced no tarball')
const tarballName = packed.filename
process.stdout.write(`${tarballName} (${packed.size} bytes)\n`)

const tarballPath = join(dist, tarballName)
const bytes = readFileSync(tarballPath)
const sha256 = createHash('sha256').update(bytes).digest('hex')

const channelPath = join(dist, 'channel.json')
const channel = existsSync(channelPath)
  ? JSON.parse(readFileSync(channelPath, 'utf8'))
  : { name: pkg.name, channel: 'stable', versions: {} }
channel.name = pkg.name
channel.channel = channel.channel ?? 'stable'
channel.versions = channel.versions ?? {}
if (homepage !== undefined) channel.homepage = homepage

const previousLatest = channel.latest
channel.versions[pkg.version] = {
  url: tarballName,
  sha256,
  size: packed.size,
  engines: pkg.engines ?? {},
  publishedAt: new Date().toISOString(),
  ...(typeof pkg.description === 'string' ? { notes: pkg.description } : {}),
}
channel.latest = pickLatest(Object.keys(channel.versions))
channel.updatedAt = new Date().toISOString()
writeFileSync(channelPath, `${JSON.stringify(channel, null, 2)}\n`)

process.stdout.write(`channel.json: latest ${channel.latest}${previousLatest === channel.latest ? ' (unchanged)' : ` (was ${previousLatest ?? 'none'})`}\n`)

if (prune > 0) {
  const versions = Object.keys(channel.versions).sort(compareVersions)
  const dropped = versions.slice(0, Math.max(0, versions.length - prune))
  for (const version of dropped) {
    const entry = channel.versions[version]
    if (typeof entry?.url === 'string') {
      const path = join(dist, entry.url)
      if (existsSync(path)) rmSync(path)
    }
    delete channel.versions[version]
  }
  writeFileSync(channelPath, `${JSON.stringify(channel, null, 2)}\n`)
  if (dropped.length > 0) process.stdout.write(`pruned: ${dropped.join(', ')}\n`)
}

/* Report what the channel now serves, so the next step (upload) is obvious. */
const listing = readdirSync(dist).filter((name) => name.endsWith('.tgz') || name === 'channel.json')
process.stdout.write(`\n${dist}\n`)
for (const name of listing) process.stdout.write(`  ${name}\n`)
process.stdout.write(`\ninstall with:\n  dsh plugin --profile web add ${new URL(`file://${join(dist, tarballName).replace(/\\/g, '/')}`).href.replace('file://', 'file:')}\n`)
process.stdout.write(`or, once this directory is served over HTTP:\n  dsh plugin --profile web add https://<host>/<path>/${tarballName}\n`)

function pickLatest(versions) {
  return versions.sort(compareVersions)[versions.length - 1]
}

function compareVersions(left, right) {
  const parse = (value) => value.split('-')[0].split('.').map(Number)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0)
  }
  // A release outranks its prereleases; otherwise fall back to string order.
  const aPre = left.includes('-')
  const bPre = right.includes('-')
  if (aPre !== bPre) return aPre ? -1 : 1
  return left.localeCompare(right)
}
