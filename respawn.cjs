#!/usr/bin/env node
/**
 * dsh-context-control — restart helper.
 *
 * The one-click upgrade ends with "the host must restart", and on a plain
 * `dsh web` install nothing restarts it: the process is the user's terminal.
 * Exiting would leave a dead GUI behind, so the host writes its own command
 * line here before it exits, and this detached helper starts that same command
 * line again as soon as the old process is gone.
 *
 * Three waits, in order, because each of them can otherwise produce a restart
 * that looks successful and serves nothing:
 *
 * 1. **The old process** — the port is still held until it exits; polling its
 *    PID is the only wait that does not race the shutdown.
 * 2. **The port** — a process that exited still leaves the listening socket in
 *    TIME_WAIT for a moment, and binding eagerly fails with EADDRINUSE.
 * 3. **A short settle** — pnpm may still be finishing a file operation the old
 *    process started.
 *
 * The child gets its own console-less process, logs to a file, and is
 * unref'd; this helper then exits, so nothing here outlives the restart.
 *
 * Usage: node respawn.cjs <base64(JSON{p_id, argv, cwd, env, port, log})>
 */
'use strict'

const { spawn } = require('node:child_process')
const { appendFileSync, mkdirSync, openSync, closeSync } = require('node:fs')
const { dirname } = require('node:path')
const net = require('node:net')

const payloadArgument = process.argv[2]
if (typeof payloadArgument !== 'string' || payloadArgument === '') {
  process.stderr.write('respawn.cjs: missing payload\n')
  process.exit(2)
}

let payload
try {
  payload = JSON.parse(Buffer.from(payloadArgument, 'base64').toString('utf8'))
} catch (error) {
  process.stderr.write(`respawn.cjs: unreadable payload: ${String(error)}\n`)
  process.exit(2)
}

const { pid, argv, cwd, env, port, log } = payload
if (!Array.isArray(argv) || argv.length === 0) {
  process.stderr.write('respawn.cjs: payload has no argv\n')
  process.exit(2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function logLine(text) {
  if (typeof log !== 'string' || log === '') return
  try {
    mkdirSync(dirname(log), { recursive: true })
    appendFileSync(log, `${new Date().toISOString()} respawn: ${text}\n`)
  } catch { /* logging must never break the restart */ }
}

/** Whether a PID is still alive on this platform. */
function alive(candidate) {
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) return false
  try {
    process.kill(candidate, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else — still alive.
    return error?.code === 'EPERM'
  }
}

async function waitForExit(candidate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(candidate)) return true
    await sleep(150)
  }
  return !alive(candidate)
}

/** Resolves true when nothing is listening on the port any more. */
function portFree(candidate) {
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) return Promise.resolve(true)
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: candidate })
    const done = (free) => {
      socket.destroy()
      resolve(free)
    }
    socket.setTimeout(600)
    socket.once('connect', () => done(false))
    socket.once('timeout', () => done(true))
    socket.once('error', () => done(true))
  })
}

async function waitForPort(candidate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portFree(candidate)) return true
    await sleep(200)
  }
  return false
}

async function main() {
  const exited = await waitForExit(pid, 30000)
  logLine(exited ? `old process ${pid} exited` : `old process ${pid} still alive after 30s; starting anyway`)
  const freed = await waitForPort(port, 20000)
  logLine(freed ? `port ${port} released` : `port ${port} still busy after 20s; starting anyway`)
  await sleep(400)

  /* The child's output goes to the log file through an inherited descriptor.
   * Opening it here and closing it after `spawn` returns is deliberate: a
   * closed descriptor still passed to `spawn` is EBADF, which is how the first
   * version of this helper died silently with the server down. */
  let fd
  if (typeof log === 'string' && log !== '') {
    try {
      mkdirSync(dirname(log), { recursive: true })
      fd = openSync(log, 'a')
    } catch {
      fd = undefined
    }
  }

  const [command, ...args] = argv
  let child
  try {
    child = spawn(command, args, {
      cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined,
      env: env && typeof env === 'object' ? env : process.env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
    })
  } catch (error) {
    logLine(`failed to start ${command}: ${String(error)}`)
    process.exit(1)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* the child holds its own copy */ }
    }
  }

  child.on('error', (error) => { logLine(`child error: ${String(error)}`); })
  child.unref()
  logLine(`started pid ${child.pid ?? '?'}: ${argv.join(' ')}`)

  /* A child that dies immediately (port still bound, bad argument) is the one
   * failure the log would otherwise not explain: it would look started. */
  await sleep(1500)
  if (child.exitCode !== null && child.exitCode !== undefined) {
    logLine(`the new process exited immediately with ${child.exitCode}`)
    process.exit(1)
  }
  // Give the write side a moment before this helper goes away.
  await sleep(200)
  process.exit(0)
}

void main()
