#!/usr/bin/env node
/**
 * Serve `dist/` as an update channel — the local stand-in for whatever static
 * host the tarballs end up on (nginx, GitHub Pages, an object store).
 *
 * It exists so the whole install → check → upgrade → restart path can be
 * exercised without publishing anything: point a profile dependency at
 * `http://127.0.0.1:<port>/dsh-context-control-<version>.tgz`, and the plugin
 * derives `http://127.0.0.1:<port>/channel.json` from it by itself.
 *
 * Usage: node scripts/serve-channel.cjs [--port 10600] [--dir dist]
 */
'use strict'

const { createServer } = require('node:http')
const { createReadStream, readdirSync, statSync } = require('node:fs')
const { join, resolve, extname, normalize } = require('node:path')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  if (index === -1) return fallback
  return args[index + 1] ?? fallback
}

const port = Number(argOf('port', process.env.PORT ?? 10600))
const root = resolve(argOf('dir', join(__dirname, '..', 'dist')))

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.tgz': 'application/gzip',
  '.gz': 'application/gzip',
  '.md': 'text/markdown; charset=utf-8',
}

createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://x')
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'GET only' }))
    return
  }
  if (url.pathname === '/') {
    // A directory listing is the one place a human looks first.
    const files = readdirSync(root)
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`dsh-context-control channel\n${files.join('\n')}\n`)
    return
  }
  // Traversal guard: resolve inside the root, or 404.
  const path = normalize(join(root, decodeURIComponent(url.pathname)))
  if (!path.startsWith(root)) {
    response.writeHead(403, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'forbidden' }))
    return
  }
  let stat
  try {
    stat = statSync(path)
  } catch {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not found', path: url.pathname }))
    return
  }
  if (!stat.isFile()) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'not a file', path: url.pathname }))
    return
  }
  const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  response.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    // A channel must never be cached: the whole point is to notice a release.
    'cache-control': 'no-store',
  })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  createReadStream(path).pipe(response)
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`channel served from ${root}\n  http://127.0.0.1:${port}/channel.json\n`)
})
