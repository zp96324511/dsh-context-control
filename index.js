/**
 * dsh-context-control — Host half.
 *
 * Per-session visibility gating for MCP servers, skills and built-in tools,
 * with durable per-project state. New sessions start with a lean model
 * surface: official entries (config-declared MCP servers; bundled/runtime
 * skills; the Harness's own tools) stay enabled, everything else starts gated
 * off. Gated entries contribute no tool schemas, no prompt sections, and no
 * catalog lines until enabled for that session — through the
 * `context_control` agent tool (the model, on the user's request) or the
 * composer panel (Client half, over the Typert Gateway as
 * `remote.contextControl`).
 *
 * Every visible tool costs context on every request (its schema, and for many
 * tools a `tool:<name>` guidance section), so the built-in tool set is a
 * first-class gating dimension too. Unlike MCP servers and user skills, tools
 * start enabled: disabling `read`, `bash` or `edit` by default would leave the
 * model unable to work. `defaultOffTools` opts specific tools out for new
 * projects; the panel and the tool both toggle them per session.
 *
 * Mechanism, per Harness plugin practices:
 * - MCP tool schemas: one per-agent `tools.restrict({ deny })` applied through
 *   `agent.ctx` (schema presentation, lookup, and execution stay aligned).
 *   Re-applied whenever the global tool inventory changes, so asynchronously
 *   registering MCP tools are caught by the `tools/change` listener.
 * - Built-in tool schemas: the same `tools.restrict` filter carries disabled
 *   tool names. Three names are never gateable: `run_code` (PTC's entry
 *   point, which the runtime refuses to restrict), this plugin's own
 *   `context_control`, and `structured_output` (the structured subagent
 *   contract). The tool schema is only half the cost: many tools also
 *   contribute a `tool:<name>` system-prompt section, which `restrict` does
 *   not remove, so the assembly waterfall drops those sections for disabled
 *   tools as well.
 * - MCP prompt sections: the `system-prompt/assemble` waterfall removes the
 *   gated servers' `mcp:<server>` instruction sections and rewrites the
 *   `mcp-resource-servers` list to the enabled subset. Sections have no
 *   weaker per-scope removal mechanism; the mutation is surgical (only those
 *   two names) and every other contribution is preserved.
 * - Skills: a per-agent scoped shadow registration — an injected child fiber of
 *   `agent.ctx` (`agent.ctx.inject(['skills'], …)`, since an agent context only
 *   reaches the services its loop declared) calling `skills.register` with
 *   `invocation: { modelInvocable: false, userInvocable: false }`. The
 *   skills registry's nearest-layer-wins rule shadows the real entry for that
 *   agent, and the invocation policy removes it from the catalog, the `skill`
 *   tool, and user invocation at once — the designed mechanism, no message
 *   rewriting. Disposing the fiber lifts the shadow. Discovery must read the
 *   catalog through the same `scope` the catalog and the `skill` tool use:
 *   project, user (`$DSH_HOME/skills` — `~/.dsh/skills` by default — and
 *   `~/.agents/skills`) and custom roots are contributed by the filesystem
 *   provider mounted inside the agent preset, so an unscoped read sees only
 *   the global layer (bundled and host-registered skills).
 * - Both take effect on the next model request: the agent loop detects the
 *   changed tool surface and starts a new request series.
 *
 * Two scopes, both exposed per entry:
 * - session — what this conversation's model surface is. It starts as a copy of
 *   the workspace choice, changes independently afterwards, and its overrides
 *   are stored per conversation id, so reopening the conversation (after a host
 *   restart too) starts from where the user left it.
 * - workspace — the project default stored in the domain record, which every
 *   new session in that project inherits. A workspace toggle writes the record
 *   and applies the same value to the session that issued it only when that
 *   session has no override for the entry: an explicit session choice outranks
 *   the default, so the two switches may legitimately disagree, and the session
 *   one is what this conversation's model sees. Other live sessions keep their
 *   own state (an explicit workspace action is not a reason to change another
 *   conversation's model surface under it).
 * A session toggle never writes the project record, which is the point: turning
 * something on in one conversation must not leak into the next one. It does
 * write that conversation's own record, otherwise a restart would silently
 * undo it.
 *
 * Durable state: one `context_control` storage domain (json backend under
 * `$DSH_HOME/storages/`, `~/.dsh/storages/` by default) with two tables — one
 * record per project (the session's cwd) holding the workspace choices, and one
 * record per conversation holding its overrides. A new session in the same
 * project starts from the project record; a reopened one from the project
 * record overlaid with its own; entries neither mentions fall back to the
 * configured defaults. Archiving a conversation drops its record (the workspace
 * registry's archive set arrives as a `domain/changed` write), so a restored
 * conversation inherits the project's current defaults; records left behind are
 * also pruned by age and count on write, because DSH exposes no "session
 * deleted" event a plugin could hook. MCP connections themselves stay connected
 * — this plugin controls model context, not processes.
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { createUpdateRoutes, createUpdater } from './update.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'dsh-context-control'

/** Services required by this plugin. */
export const inject = ['tools', 'agents', 'skills', 'storageDomain']

/** Tunable values; users edit these in the profile patch layer. */
export const Config = z.object({
  /** MCP server names enabled by default for new sessions (overrides origin classification). */
  defaultOn: z.array(z.string()).default([]),
  /** MCP server names disabled by default regardless of origin classification. */
  defaultOff: z.array(z.string()).default([]),
  /**
   * MCP server names treated as official (default on). DSH itself ships no
   * MCP servers today, so this list is empty unless a shipped preset starts
   * declaring `@deepseek-ai/dsh-mcp-client` rows.
   */
  officialServers: z.array(z.string()).default([]),
  /** Skill names enabled by default (overrides the source-based rule). */
  defaultOnSkills: z.array(z.string()).default([]),
  /** Skill names disabled by default (overrides the source-based rule). */
  defaultOffSkills: z.array(z.string()).default([]),
  /**
   * Built-in tool names disabled by default for new projects. Every other
   * tool starts enabled: a default-off `read` or `bash` would break a fresh
   * session. Use this to trim optional context cost (e.g. `workflow`,
   * `subagent`, `web_search`). Per-session toggles override it.
   */
  defaultOffTools: z.array(z.string()).default([]),
  /** Whether the model may enable/disable entries through the context_control tool. */
  allowAgentToggle: z.boolean().default(true),
  /**
   * Self-update channel (see update.js). The defaults describe a package
   * installed from a registry: the check asks the registry pnpm is configured
   * against. A tarball install needs nothing here — its channel is the
   * `channel.json` next to the tarball — and a `link:`/`file:` checkout is
   * never upgraded in place unless `manifestUrl`, `github` or `registry` is
   * set explicitly.
   */
  update: z.object({
    /** Package name to look up and install; defaults to this package. */
    packageName: z.string(),
    /** Channel document (`channel.json`) with `latest` and per-version URLs. */
    manifestUrl: z.string(),
    /** `owner/repo` of a GitHub repository whose releases carry the tarball. */
    github: z.string(),
    /** Registry to ask; defaults to the one pnpm is configured with. */
    registry: z.string(),
    /** Path to the `dsh` launcher; discovered from the running process by default. */
    launcher: z.string(),
    /** Running DSH version; read from the launcher's install by default. */
    runtimeVersion: z.string(),
    /** How long one check result is reused, in milliseconds. */
    checkIntervalMs: z.number(),
    /** Upper bound for one upgrade install, in milliseconds. */
    upgradeTimeoutMs: z.number(),
  }).default({}),
}).default({
  defaultOn: [], defaultOff: [], officialServers: [],
  defaultOnSkills: [], defaultOffSkills: [], defaultOffTools: [],
  allowAgentToggle: true, update: {},
})

/** Prototype marker the Typert Gateway reads for remotely callable methods. */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'
/** Public MCP tool-name shape: mcp__<serverName>__<rawName>. */
const MCP_TOOL_NAME = /^mcp__([A-Za-z0-9_-]{1,32})__/
/** Shared MCP resource tools, hidden while no server is enabled for the session. */
const RESOURCE_TOOL_NAMES = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
/** Section listing resource server names; rewritten to the enabled subset. */
const RESOURCE_SECTION_NAME = 'mcp-resource-servers'
/**
 * Tools that stay visible no matter what: `run_code` is PTC's entry point and
 * the runtime refuses to restrict it, `context_control` is the model's only
 * way back, and `structured_output` is the structured-subagent contract.
 */
const PROTECTED_TOOL_NAMES = new Set(['run_code', 'context_control', 'structured_output'])
/** Guidance sections owned by one tool are named `tool:<toolName>`. */
const TOOL_SECTION_PREFIX = 'tool:'
/** Skill sources shipped with DSH itself: default on. Everything else defaults off. */
const OFFICIAL_SKILL_SOURCES = new Set(['bundled', 'runtime'])
/**
 * Source label of this plugin's own gating shadows. The skills registry keeps a
 * runtime registration's `source` verbatim, so the shadow is distinguishable
 * from a real skill and never mistaken for a discovered origin.
 */
const SHADOW_SKILL_SOURCE = 'context-control-gated'

/**
 * Session records are pruned on every write: DSH has no "session deleted"
 * event a plugin can observe (sessions are files, and an archive or a delete
 * happens outside the agent lifecycle), so age and count are what keeps the
 * table bounded. A pruned record only costs a reopened session its override.
 */
const SESSION_RECORD_TTL_MS = 180 * 24 * 60 * 60 * 1000
const SESSION_RECORD_LIMIT = 1000

/**
 * Durable layout, two tables:
 * - `projects` — one record per project cwd holding the workspace (project
 *   default) choices.
 * - `sessions` — one record per conversation holding its own overrides, so
 *   reopening it (after a restart too) starts where the user left it.
 * A table addition is additive for the json backend: a stored unit without
 * `sessions` opens with an empty one, so no version bump or migration.
 */
const PROJECT_DOMAIN = defineDomain({
  name: 'context_control',
  version: 1,
  layout: 'single',
  tables: {
    projects: domainTable(zod.object({
      mcp: zod.record(zod.string(), zod.boolean()),
      skills: zod.record(zod.string(), zod.boolean()),
      /** Built-in tool overrides; absent in records written before 0.5.0. */
      tools: zod.record(zod.string(), zod.boolean()).optional(),
    })),
    sessions: domainTable(zod.object({
      /** Project the overrides were made in; a session that moves ignores the record. */
      cwd: zod.string(),
      /** Epoch ms of the last write, the pruning clock. */
      at: zod.number(),
      mcp: zod.record(zod.string(), zod.boolean()),
      skills: zod.record(zod.string(), zod.boolean()),
      tools: zod.record(zod.string(), zod.boolean()).optional(),
    })),
  },
})

function warn(ctx, message) {
  try {
    (ctx.logger?.warn ?? console.warn)('[dsh-context-control]', message)
  } catch { /* logging must never break gating */ }
}

/**
 * Client-callable Host service exposing the same operations the agent tool
 * uses, so the UI action and the tool share one implementation.
 */
class ContextControlRemote extends TypertRemoteService {
  constructor(ctx, ops) {
    super(ctx, 'contextControl')
    this.ops = ops
  }
  /** Remote `list`: MCP servers and skills with origin, enabled state, and counts. */
  async remoteList(sessionId) {
    return this.ops.list(String(sessionId))
  }
  /**
   * Remote `set`: enable or disable one MCP server, skill or tool for one
   * session, or write that choice as the project's workspace default.
   * `scope` is optional on the wire so an older client bundle keeps working;
   * it means session-only.
   */
  async remoteSet(sessionId, kind, target, enabled, scope) {
    return this.ops.set(
      String(sessionId), String(kind), String(target), Boolean(enabled),
      scope === 'workspace' ? 'workspace' : 'session',
    )
  }
}
/* Plain-JS equivalent of @Remote('list') / @Remote('set') decorators: the
 * versioned prototype descriptor the Gateway's source-mode discovery reads. */
Object.defineProperty(ContextControlRemote.prototype, REMOTE_METHOD_DESCRIPTOR, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({ method: 'remoteList', exportName: 'list', invocation: Object.freeze({ kind: 'direct' }) }),
      Object.freeze({ method: 'remoteSet', exportName: 'set', invocation: Object.freeze({ kind: 'direct' }) }),
    ]),
  }),
})

/**
 * Host plugin body.
 * @param ctx - plugin context carrying the required services.
 * @param config - schema-validated plain config object (Cordis injects it at
 *   load time; config changes reload the plugin via HMR, so no live handle).
 * @returns cleanup that unregisters every contribution.
 */
export async function apply(ctx, config) {
  const cfg = () => config

  /** sessionId -> live gating state for that agent. */
  const sessions = new Map()
  /** server -> Set<toolName>, accumulated from the global tool view. */
  const inventory = new Map()
  /** Names of the shared MCP resource tools that are registered. */
  const resourceTools = new Set()
  /** Names seen on agent views (preset-scoped mounts); never pruned by global scans. */
  const scopedSeen = new Set()
  /** Names visible in the last global scan; the restrict fallback subset. */
  let globalSeen = new Set()
  /** toolName -> model-facing description, the panel's second line. */
  const toolDescriptions = new Map()
  /** server -> MCP `instructions` text captured while assembling the system prompt. */
  const serverDescriptions = new Map()
  /** Re-entrancy guard: reconcile's own dispose/apply fire tools/change. */
  let reconciling = false
  /** Re-entrancy guard: shadow registration/disposal fires skills/change. */
  let shadowing = false

  let domain = null
  try {
    domain = await ctx.storageDomain.open(PROJECT_DOMAIN)
  } catch (error) {
    warn(ctx, `storage domain unavailable, state stays in-memory: ${String(error)}`)
  }

  /* ---------- durable per-project state ---------- */

  /** cwd -> workspace record, kept in memory so a burst of toggles cannot lose one. */
  const workspaceRecords = new Map()

  /** Read the stored record for one project; undefined when none is stored. */
  function storedFor(cwd) {
    if (domain === null || cwd === '') return undefined
    try {
      return domain.table('projects').get(cwd)
    } catch (error) {
      warn(ctx, `reading stored state failed: ${String(error)}`)
      return undefined
    }
  }

  /**
   * The workspace record for one project: the user's explicit per-entry
   * choices, nothing else (untouched entries keep following config defaults).
   * Cached because a workspace toggle is a read-modify-write: the domain only
   * publishes a put to memory after the backend accepted it, so re-reading the
   * table between two quick toggles could still see the older record and drop
   * the first one.
   */
  function workspaceRecord(cwd) {
    if (cwd === '') return undefined
    let record = workspaceRecords.get(cwd)
    if (record === undefined) {
      const stored = storedFor(cwd)
      record = {
        mcp: { ...(stored?.mcp ?? {}) },
        skills: { ...(stored?.skills ?? {}) },
        tools: { ...(stored?.tools ?? {}) },
      }
      workspaceRecords.set(cwd, record)
    }
    return record
  }

  /** Persist one project's workspace record; the stored value is a copy of the cache. */
  function persistWorkspace(cwd) {
    if (domain === null) return
    const record = workspaceRecord(cwd)
    if (record === undefined) return
    domain.table('projects').put(cwd, {
      mcp: { ...record.mcp },
      skills: { ...record.skills },
      tools: { ...record.tools },
    }).catch((error) => warn(ctx, `persisting state failed: ${String(error)}`))
  }

  /* ---------- durable per-session state ---------- */

  /** Entry kind (the tool/remote vocabulary) -> record field name. */
  const SESSION_FIELDS = { mcp: 'mcp', skill: 'skills', tool: 'tools' }

  /** sessionId -> { cwd, at, mcp, skills, tools }, the stored overrides for one conversation. */
  const sessionRecords = new Map()
  let sessionRecordsLoaded = false

  /** Read the session table once; later writes update the cache, not the table snapshot. */
  function loadSessionRecords() {
    if (sessionRecordsLoaded) return
    sessionRecordsLoaded = true
    if (domain === null) return
    try {
      for (const [sessionId, value] of domain.table('sessions').entries()) {
        sessionRecords.set(sessionId, {
          cwd: typeof value.cwd === 'string' ? value.cwd : '',
          at: Number.isFinite(value.at) ? value.at : 0,
          mcp: { ...(value.mcp ?? {}) },
          skills: { ...(value.skills ?? {}) },
          tools: { ...(value.tools ?? {}) },
        })
      }
    } catch (error) {
      warn(ctx, `reading stored session state failed: ${String(error)}`)
    }
    dropRegistryArchivedSessions()
  }

  /**
   * The stored overrides for one conversation, or undefined when it has none
   * (or its last choices were made in another project: a session that moved
   * starts from the new project's defaults rather than from a foreign record).
   * @param sessionId - Conversation id (the agent id).
   * @param cwd - Current project, or undefined to accept whatever the record holds.
   */
  function sessionRecordFor(sessionId, cwd = undefined) {
    loadSessionRecords()
    const record = sessionRecords.get(sessionId)
    if (record === undefined) return undefined
    if (cwd !== undefined && record.cwd !== cwd) return undefined
    return record
  }

  /** Effective session sets: the workspace choice overlaid with this session's own overrides. */
  function sessionMcp(sessionId, cwd) {
    return overlay(workspaceMcp(cwd), sessionRecordFor(sessionId, cwd)?.mcp)
  }

  function sessionSkills(sessionId, cwd, known) {
    return overlay(workspaceSkills(cwd, known), sessionRecordFor(sessionId, cwd)?.skills)
  }

  function sessionTools(sessionId, cwd, known) {
    return overlay(workspaceTools(cwd, known), sessionRecordFor(sessionId, cwd)?.tools, known)
  }

  /**
   * Write one session override and persist the record. The cache is the source
   * of truth while the host runs: the domain publishes a put to memory only
   * after the backend accepted it, so reading back between two quick toggles
   * could see the older record and drop the first one.
   * @param keepId - the record being written; pruning never touches it.
   */
  function persistSession(sessionId, cwd, apply) {
    const table = domain === null ? undefined : domain.table('sessions')
    let record = sessionRecords.get(sessionId)
    if (record === undefined || record.cwd !== cwd) {
      /* First overrides for this conversation, or it moved to another project:
       * the old choices do not carry over. */
      record = { cwd, at: 0, mcp: {}, skills: {}, tools: {} }
    }
    apply(record)
    record.at = Date.now()
    sessionRecords.set(sessionId, record)
    if (table === undefined) return
    table.put(sessionId, {
      cwd: record.cwd,
      at: record.at,
      mcp: { ...record.mcp },
      skills: { ...record.skills },
      tools: { ...record.tools },
    }).catch((error) => warn(ctx, `persisting session state failed: ${String(error)}`))
    pruneSessionRecords(table, sessionId)
  }

  /**
   * Put one live session back on the workspace choice: its own overrides are
   * gone, so every entry it tracks returns to what the project says right now.
   * Both surfaces are re-applied through the normal reconcile paths, which is
   * what makes the change land on the next model request.
   */
  function resetEntryToWorkspace(entry) {
    entry.mcp = workspaceMcp(entry.cwd)
    entry.tools = workspaceTools(entry.cwd, entry.knownTools)
    entry.skills = workspaceSkills(entry.cwd, entry.knownSkills)
    reconcile(entry)
    reconcileSkills(entry)
  }

  /** Drop one conversation's stored overrides entirely: the next time it opens it
   * starts from the workspace choice, exactly like a conversation that never had
   * any. A live agent falls back immediately, so a request in flight cannot keep
   * the vanished choices alive. */
  function forgetSessionRecord(sessionId) {
    const stored = sessionRecords.delete(sessionId)
    if (!stored) return
    const entry = sessions.get(sessionId)
    if (entry !== undefined) resetEntryToWorkspace(entry)
    if (domain === null) return
    try {
      domain.table('sessions').delete(sessionId)
        .catch((error) => warn(ctx, `dropping session state failed: ${String(error)}`))
    } catch (error) {
      warn(ctx, `dropping session state failed: ${String(error)}`)
    }
  }

  /**
   * Drop the stored choices of the sessions an archive set names. Archiving is
   * the host's only "this conversation is finished" signal (there is no
   * session/delete event), and it is deliberately reversible — so forgetting the
   * record here is what makes a restored conversation inherit the project's
   * current defaults instead of silently keeping choices the user retired.
   */
  function forgetArchivedSessions(archived) {
    if (!Array.isArray(archived)) return
    for (const sessionId of archived) forgetSessionRecord(String(sessionId))
  }

  /** Apply the archive set the workspace registry already holds (used once, when
   * the session table is first read, for archives made before this host ran). */
  function dropRegistryArchivedSessions() {
    try {
      forgetArchivedSessions(ctx.get('workspaceRegistry')?.archivedSessionIds)
    } catch (error) {
      warn(ctx, `reading the archive set failed: ${String(error)}`)
    }
  }

  /**
   * Drop expired records and keep the table bounded. `keepId` is the record the
   * caller is writing right now; age never prunes it. Never throws: losing a
   * cleanup must not fail the toggle that triggered it.
   */
  function pruneSessionRecords(table, keepId) {
    const now = Date.now()
    const doomed = []
    for (const [sessionId, record] of sessionRecords) {
      if (sessionId === keepId) continue
      if (record.at !== 0 && now - record.at > SESSION_RECORD_TTL_MS) doomed.push(sessionId)
    }
    if (sessionRecords.size - doomed.length > SESSION_RECORD_LIMIT) {
      const survivors = [...sessionRecords.entries()]
        .filter(([sessionId]) => sessionId !== keepId && !doomed.includes(sessionId))
        .sort((a, b) => a[1].at - b[1].at)
      const excess = sessionRecords.size - doomed.length - SESSION_RECORD_LIMIT
      for (const [sessionId] of survivors.slice(0, excess)) doomed.push(sessionId)
    }
    if (doomed.length === 0) return
    const gone = new Set(doomed)
    for (const sessionId of gone) sessionRecords.delete(sessionId)
    try {
      table.deleteMany(doomed).catch((error) => warn(ctx, `pruning session state failed: ${String(error)}`))
    } catch (error) {
      warn(ctx, `pruning session state failed: ${String(error)}`)
    }
  }

  /* ---------- inventory scans ---------- */

  /** Record one schema's model-facing description, the panel's second line. */
  function rememberSchema(schema) {
    if (typeof schema.description === 'string') toolDescriptions.set(schema.name, schema.description)
  }

  /** Collapse a description to one line and cap it for the panel's popover. */
  function oneLine(text, max = 400) {
    const line = String(text ?? '').replace(/\s+/g, ' ').trim()
    return line.length > max ? `${line.slice(0, max - 1)}…` : line
  }

  /* `dsh-mcp-client` wraps a server's `instructions` in this heading before
   * registering it as one prompt section, so the raw text starts with the
   * server's own name in markdown. The panel already shows the name in the
   * row, and the heading carried no information. */
  const MCP_SECTION_HEADING = /^\s*###\s*MCP server:[^\n]*\n+/

  /** The prose an MCP server published, without the repeated heading. */
  function serverDescription(text) {
    return oneLine(String(text ?? '').replace(MCP_SECTION_HEADING, ''))
  }

  /**
   * Read `instructions` straight from the sections the MCP clients registered,
   * instead of waiting for one of them to appear in an assembled prompt.
   *
   * A prompt section's text is evaluated during assembly, so a host that has
   * not served a model request yet holds no observable instruction text — and
   * the panel listed every server with only its tool count, on a host where the
   * model had simply never been asked anything. The registry is available as
   * soon as a server connects: the text provider is a getter over the last
   * successful connection, so asking it here is cheap and side-effect free.
   */
  function describeRegisteredServers() {
    let prompt
    try {
      prompt = ctx.get('systemPrompt')
    } catch {
      return
    }
    const layers = prompt?.layers
    if (layers === undefined || typeof layers.merge !== 'function') return
    let sections
    try {
      sections = layers.merge(undefined, (layer) => layer.sections)
    } catch {
      return
    }
    for (const [name, section] of sections) {
      if (!name.startsWith('mcp:')) continue
      let text
      try {
        text = typeof section.text === 'function' ? section.text({}) : section.text
      } catch {
        continue
      }
      const description = serverDescription(text)
      if (description !== '') serverDescriptions.set(name.slice(4), description)
    }
  }

  /** Scan the global tool view (immune to per-agent restrictions). @returns whether the inventory changed. */
  function scanGlobal() {
    const seen = new Set()
    for (const schema of ctx.tools.schemas()) {
      seen.add(schema.name)
      rememberSchema(schema)
    }
    let changed = false
    for (const name of seen) {
      const match = MCP_TOOL_NAME.exec(name)
      if (match === null) {
        if (RESOURCE_TOOL_NAMES.has(name) && !resourceTools.has(name)) {
          resourceTools.add(name)
          changed = true
        }
        continue
      }
      const server = match[1]
      let tools = inventory.get(server)
      if (tools === undefined) {
        tools = new Set()
        inventory.set(server, tools)
        changed = true
      }
      if (!tools.has(name)) {
        tools.add(name)
        changed = true
      }
    }
    for (const [server, tools] of [...inventory]) {
      for (const name of tools) {
        if (!seen.has(name) && !scopedSeen.has(name)) {
          tools.delete(name)
          changed = true
        }
      }
      if (tools.size === 0) {
        inventory.delete(server)
        changed = true
      }
    }
    for (const name of [...resourceTools]) {
      if (!seen.has(name) && !scopedSeen.has(name)) resourceTools.delete(name)
    }
    globalSeen = seen
    return changed
  }

  /** Scan one agent's inherited view before any restriction exists (catches preset-scoped servers). */
  function scanAgentTools(agent) {
    let changed = false
    try {
      for (const schema of agent.ctx.tools.schemas()) {
        rememberSchema(schema)
        const match = MCP_TOOL_NAME.exec(schema.name)
        if (match !== null) {
          scopedSeen.add(schema.name)
          const server = match[1]
          let tools = inventory.get(server)
          if (tools === undefined) {
            tools = new Set()
            inventory.set(server, tools)
            changed = true
          }
          if (!tools.has(schema.name)) {
            tools.add(schema.name)
            changed = true
          }
        } else if (RESOURCE_TOOL_NAMES.has(schema.name) && !resourceTools.has(schema.name)) {
          resourceTools.add(schema.name)
          scopedSeen.add(schema.name)
          changed = true
        }
      }
    } catch (error) {
      warn(ctx, `agent tool scan failed: ${String(error)}`)
    }
    return changed
  }

  /**
   * Built-in tools this agent can see, minus the MCP names (grouped by server
   * elsewhere), the shared resource tools, and the protected ones. Reads the
   * agent's unrestricted view, so call it while this plugin's own restriction
   * is lifted.
   * @param scopeCtx - an agent context, or the plugin context for the global view.
   */
  function builtinToolInventory(scopeCtx) {
    const known = new Set()
    let schemas
    try {
      schemas = scopeCtx.tools.schemas()
    } catch (error) {
      warn(ctx, `built-in tool scan failed: ${String(error)}`)
      return known
    }
    for (const schema of schemas) {
      const toolName = schema.name
      if (typeof toolName !== 'string' || toolName === '') continue
      if (MCP_TOOL_NAME.test(toolName)) continue
      if (RESOURCE_TOOL_NAMES.has(toolName) || PROTECTED_TOOL_NAMES.has(toolName)) continue
      known.add(toolName)
      rememberSchema(schema)
    }
    return known
  }

  /** Visible tool names in one agent's current (possibly restricted) view. */
  function visibleToolNames(agent) {
    try {
      return new Set(agent.ctx.tools.schemas().map((schema) => schema.name))
    } catch (error) {
      warn(ctx, `reading the agent tool view failed: ${String(error)}`)
      return new Set()
    }
  }

  /**
   * Discover the skills one agent can actually see. Skills are a layered
   * registry: project, user and custom roots are contributed by the filesystem
   * provider mounted inside the agent preset, so a read without `scope` sees
   * only the global layer (bundled and host-registered skills) and every
   * `~/.agents/skills`, `$DSH_HOME/skills` (default `~/.dsh/skills`),
   * `<project>/.agents/skills` entry stays invisible. Pass the viewing agent,
   * exactly as the `skill` tool and the catalog do.
   * @param cwd - project working directory; '' asks for the default view.
   * @param agent - viewing agent whose scope chain contributes preset skills; omitted for the global view.
   * @param into - optional name -> description sink, filled from the same read.
   * @returns name -> source map; this plugin's own shadows report SHADOW_SKILL_SOURCE.
   */
  async function skillInventory(cwd, agent, into) {
    try {
      const options = cwd === '' ? {} : { cwd }
      if (agent !== undefined) options.scope = agent
      const summaries = await ctx.skills.list(options)
      const known = new Map()
      for (const summary of summaries) {
        known.set(summary.name, summary.source)
        if (into !== undefined) into.set(summary.name, summary.description ?? '')
      }
      return known
    } catch (error) {
      warn(ctx, `skill discovery failed: ${String(error)}`)
      return new Map()
    }
  }

  /** Keep only real discovery origins from an inventory result (shadows carry no origin). */
  function realSkillSources(known) {
    const sources = new Map()
    for (const [name, source] of known) {
      if (source !== SHADOW_SKILL_SOURCE) sources.set(name, source)
    }
    return sources
  }

  /* ---------- defaults and deny computation ---------- */

  /** Default enabled MCP set for a fresh project: official on, others off, config lists override. */
  function defaultsForMcp() {
    const c = cfg()
    const enabled = new Set()
    for (const server of inventory.keys()) {
      if (c.defaultOff.includes(server)) continue
      if (c.defaultOn.includes(server) || c.officialServers.includes(server)) enabled.add(server)
    }
    return enabled
  }

  /** Default enabled skill set for a fresh project: bundled/runtime on, others off, config lists override. */
  function defaultsForSkills(known) {
    const c = cfg()
    const enabled = new Set()
    for (const [name, source] of known) {
      if (c.defaultOffSkills.includes(name)) continue
      if (c.defaultOnSkills.includes(name) || OFFICIAL_SKILL_SOURCES.has(source)) enabled.add(name)
    }
    return enabled
  }

  /**
   * Default enabled tool set for a fresh project. Tools start enabled — a
   * session without `read`/`bash` cannot work — and `defaultOffTools` opts
   * individual optional tools out (scoped by tool name, not by origin, since
   * the Harness exposes no per-tool source).
   */
  function defaultsForTools(known) {
    const c = cfg()
    const enabled = new Set()
    for (const name of known) {
      if (!c.defaultOffTools.includes(name)) enabled.add(name)
    }
    return enabled
  }

  /** Apply explicit `name -> enabled` choices on top of a default set. */
  function overlay(set, choices, known) {
    if (choices === undefined) return set
    for (const [name, on] of Object.entries(choices)) {
      if (known !== undefined && !known.has(name)) continue
      if (on) set.add(name)
      else set.delete(name)
    }
    return set
  }

  /**
   * The workspace (project-default) enabled sets: config defaults over the
   * stored choices. A session copies these when it attaches, which is what
   * "the session follows the project" means — and what a workspace toggle
   * changes for the next session.
   */
  function workspaceMcp(cwd) {
    return overlay(defaultsForMcp(), workspaceRecord(cwd)?.mcp)
  }

  function workspaceSkills(cwd, known) {
    return overlay(defaultsForSkills(known), workspaceRecord(cwd)?.skills)
  }

  function workspaceTools(cwd, known) {
    return overlay(defaultsForTools(known), workspaceRecord(cwd)?.tools, known)
  }

  /** Tool names to deny for one entry: gated servers' tools, shared resource tools, disabled built-ins. */
  function denyFor(entry) {
    const deny = new Set()
    let anyEnabled = false
    for (const [server, tools] of inventory) {
      if (entry.mcp.has(server)) {
        anyEnabled = true
        continue
      }
      for (const name of tools) deny.add(name)
    }
    if (!anyEnabled) for (const name of resourceTools) deny.add(name)
    for (const name of entry.knownTools) {
      if (!entry.tools.has(name)) deny.add(name)
    }
    return deny
  }

  /* ---------- per-agent reconciliation ---------- */

  /** Lift one agent's restriction (its own dispose/apply fires tools/change, hence the guard). */
  function liftRestriction(entry) {
    if (entry.disposer === undefined) return
    const lift = entry.disposer
    entry.disposer = undefined
    try { lift() } catch (error) { warn(ctx, `lifting restriction failed: ${String(error)}`) }
  }

  /**
   * Re-scan the unrestricted built-in view: add tools that appeared, drop ones
   * that vanished. Called while the restriction is lifted, so nothing this
   * plugin hides is mistaken for gone. A tool this session has never had a
   * choice for follows the workspace, exactly like a fresh attach.
   */
  function refreshBuiltinTools(entry) {
    const known = builtinToolInventory(entry.agent.ctx)
    const enabled = sessionTools(entry.agent.id, entry.cwd, known)
    for (const name of known) {
      if (entry.knownTools.has(name)) continue
      entry.knownTools.add(name)
      if (enabled.has(name)) entry.tools.add(name)
    }
    for (const name of [...entry.knownTools]) {
      if (known.has(name)) continue
      entry.knownTools.delete(name)
      entry.tools.delete(name)
    }
  }

  /** Admit MCP servers that appeared after attach; each follows this session's effective choice. */
  function refreshMcp(entry) {
    const enabled = sessionMcp(entry.agent.id, entry.cwd)
    for (const server of inventory.keys()) {
      if (entry.knownMcp.has(server)) continue
      entry.knownMcp.add(server)
      if (enabled.has(server)) entry.mcp.add(server)
    }
  }

  /**
   * Lift and re-apply one agent's tool restriction for its current sets: MCP
   * servers and built-in tools share one `restrict` call, so the agent's view
   * is computed once per change. `rescan` refreshes both inventories first
   * (used from `tools/change`); a set operation already knows them.
   */
  function reconcile(entry, rescan = false) {
    reconciling = true
    try {
      liftRestriction(entry)
      if (rescan) {
        refreshMcp(entry)
        refreshBuiltinTools(entry)
      }
      const deny = denyFor(entry)
      if (deny.size === 0) return
      /* After the lift the full view is visible again. Filter to names this
       * agent can actually see: a name hidden by another restriction is
       * already off, and `restrict` rejects names outside the inherited set. */
      const visible = visibleToolNames(entry.agent)
      const candidate = [...deny].filter((name) => visible.has(name))
      if (candidate.length === 0) return
      try {
        entry.disposer = entry.agent.ctx.tools.restrict({ deny: candidate })
      } catch (error) {
        /* Stale names (a tool vanished mid-run) fail restrict's validation;
         * retry with the global-view subset, which every agent inherits. */
        const fallback = candidate.filter((name) => globalSeen.has(name))
        if (fallback.length > 0 && fallback.length < candidate.length) {
          try {
            entry.disposer = entry.agent.ctx.tools.restrict({ deny: fallback })
          } catch (retryError) {
            warn(ctx, `restrict fallback failed: ${String(retryError)}`)
          }
        } else {
          warn(ctx, `restrict failed: ${String(error)}`)
        }
      }
    } finally {
      reconciling = false
    }
  }

  /**
   * Shadow one skill off for one agent: nearest layer wins, invocation policy
   * hides it everywhere. The registration must go through an injected child
   * fiber of the agent context: an agent context only reaches the services its
   * loop declared (`tools`, `systemPrompt`, …), so reading `agent.ctx.skills`
   * directly throws and every shadow would silently fail. The fiber is also the
   * registration's owner — disposing it lifts the shadow — and registering from
   * inside it files the entry in the agent's own layer, not the global one.
   */
  function gateSkill(entry, skillName) {
    if (entry.skillShadows.has(skillName)) return
    shadowing = true
    try {
      const fiber = entry.agent.ctx.inject(['skills'], (scoped) => scoped.skills.register({
        name: skillName,
        description: 'Gated off for this session by dsh-context-control.',
        source: SHADOW_SKILL_SOURCE,
        content: 'This skill is gated off for this session. Enable it via the context_control tool or the composer panel.',
        invocation: { modelInvocable: false, userInvocable: false },
      }))
      entry.skillShadows.set(skillName, () => { void fiber.dispose() })
    } catch (error) {
      warn(ctx, `gating skill "${skillName}" failed: ${String(error)}`)
    } finally {
      shadowing = false
    }
  }

  /** Lift one skill's shadow; the real registration reappears. */
  function ungateSkill(entry, skillName) {
    const dispose = entry.skillShadows.get(skillName)
    if (dispose === undefined) return
    shadowing = true
    try {
      entry.skillShadows.delete(skillName)
      try { dispose() } catch (error) { warn(ctx, `ungating skill "${skillName}" failed: ${String(error)}`) }
    } finally {
      shadowing = false
    }
  }

  /** Apply the enabled set to the shadows: gate everything not enabled, lift the rest. */
  function reconcileSkills(entry) {
    for (const name of entry.knownSkills) {
      if (entry.skills.has(name)) ungateSkill(entry, name)
      else gateSkill(entry, name)
    }
    for (const [name, dispose] of [...entry.skillShadows]) {
      if (!entry.knownSkills.has(name)) {
        shadowing = true
        try { entry.skillShadows.delete(name); dispose() } finally { shadowing = false }
      }
    }
  }

  /** Refresh one agent's skill knowledge (new skills follow this session's effective choice,
   * vanished ones drop) and re-apply shadows. */
  async function refreshSkills(entry) {
    const descriptions = new Map()
    const known = await skillInventory(entry.cwd, entry.agent, descriptions)
    const enabled = sessionSkills(entry.agent.id, entry.cwd, known)
    for (const [name, source] of known) {
      /* A shadow masks the real origin and description; keep the ones learned before gating. */
      if (source !== SHADOW_SKILL_SOURCE) {
        entry.sources.set(name, source)
        const description = descriptions.get(name)
        if (typeof description === 'string' && description !== '') {
          entry.skillDescriptions.set(name, description)
        }
      }
      if (!entry.knownSkills.has(name)) {
        entry.knownSkills.add(name)
        if (enabled.has(name)) entry.skills.add(name)
      }
    }
    for (const name of [...entry.knownSkills]) {
      if (!known.has(name)) {
        entry.knownSkills.delete(name)
        entry.skills.delete(name)
        entry.sources.delete(name)
        entry.skillDescriptions.delete(name)
      }
    }
    reconcileSkills(entry)
  }

  /** Attach gating state to one agent: the session starts from the workspace choice
   * overlaid with its own stored overrides, then the tool restriction and skill shadows are
   * applied. Tool gating lands synchronously before the first await, so a new agent's first
   * assembly cannot slip past it; skill shadows follow discovery. The agent/created
   * listener awaits this whole call. */
  async function attach(agent) {
    if (sessions.has(agent.id)) return
    scanGlobal()
    scanAgentTools(agent)
    const cwd = agent.session.header.cwd ?? ''
    /* Read the built-in view before this plugin's own restriction exists. */
    const knownTools = builtinToolInventory(agent.ctx)
    const entry = {
      agent, cwd,
      mcp: sessionMcp(agent.id, cwd),
      tools: sessionTools(agent.id, cwd, knownTools),
      knownTools,
      knownMcp: new Set(inventory.keys()),
      skills: new Set(), knownSkills: new Set(), sources: new Map(),
      skillDescriptions: new Map(),
      disposer: undefined,
      skillShadows: new Map(),
    }
    sessions.set(agent.id, entry)
    reconcile(entry)
    const descriptions = new Map()
    const known = await skillInventory(cwd, agent, descriptions)
    entry.skillDescriptions = descriptions
    entry.skills = sessionSkills(agent.id, cwd, known)
    entry.knownSkills = new Set(known.keys())
    entry.sources = realSkillSources(known)
    reconcileSkills(entry)
  }

  /* ---------- lifecycle listeners ---------- */

  const offAgentCreated = ctx.on('agent/created', ({ agent }) => attach(agent))

  /* A disposed agent unwinds its own agent.ctx registrations; the project record already holds the choice. */
  const offAgentDisposed = ctx.on('agent/disposed', ({ agent }) => {
    sessions.delete(agent.id)
  })

  /* Catch asynchronously registering tools, vanished ones, and new built-ins.
   * The restriction's own dispose/apply fires this event; `reconciling` keeps
   * that from recursing. */
  const offToolsChange = ctx.on('tools/change', () => {
    if (reconciling) return
    scanGlobal()
    for (const entry of sessions.values()) reconcile(entry, true)
  })

  /* Catch skill catalog changes (new or removed skills) for every live agent. */
  const offSkillsChange = ctx.on('skills/change', () => {
    if (shadowing) return
    for (const entry of sessions.values()) void refreshSkills(entry)
  })

  /* Archiving a session is the only "this conversation is finished" signal the
   * host offers; it is stored in the workspace registry's single root record,
   * and every domain write is broadcast as `domain/changed`. Archiving keeps the
   * conversation (unarchiving restores it), so the hook drops its stored choices
   * rather than the conversation: a restored session then starts from the
   * project's current defaults. */
  const offDomainChanged = ctx.on('domain/changed', (change) => {
    if (change?.domain !== 'workspace' || change.table !== '' || change.operation !== 'put') return
    forgetArchivedSessions(change.value?.archivedSessionIds)
  })

  /* Remove gated servers' and disabled tools' prompt sections; keep every other
   * contribution. `tools.restrict` hides a tool's schema but not the static
   * `tool:<name>` guidance section some tool plugins register (the web tools
   * self-check, most do not), so both costs are dropped here. */
  const offAssemble = ctx.on('system-prompt/assemble', (assembly, context, next) => {
    const agent = context.agent
    const entry = agent === undefined ? undefined : sessions.get(agent.id)
    if (entry === undefined) return next()
    const enabled = entry.mcp
    const disabledSections = new Set()
    for (const name of entry.knownTools) {
      if (!entry.tools.has(name)) disabledSections.add(TOOL_SECTION_PREFIX + name)
    }
    /* An MCP server has no description field of its own; its `instructions`
     * text is the only prose it publishes, and this section carries it. Keep a
     * collapsed copy for the panel's second line before filtering. */
    for (const section of assembly.sections) {
      if (!section.name.startsWith('mcp:')) continue
      const description = serverDescription(typeof section.text === 'string' ? section.text : '')
      if (description !== '') serverDescriptions.set(section.name.slice(4), description)
    }
    const hasMcpSections = assembly.sections.some((section) => section.name.startsWith('mcp:'))
    if (hasMcpSections || disabledSections.size > 0) {
      assembly.sections = assembly.sections.filter((section) => {
        if (section.name.startsWith('mcp:')) return enabled.has(section.name.slice(4))
        return !disabledSections.has(section.name)
      })
    }
    const index = assembly.sections.findIndex((section) => section.name === RESOURCE_SECTION_NAME)
    if (index !== -1) {
      const visible = [...enabled].filter((server) => inventory.has(server)).sort()
      if (visible.length === 0) {
        assembly.sections.splice(index, 1)
      } else {
        const section = assembly.sections[index]
        const rewritten = section.text.replace(/\[[^\[\]]*\]\.$/, `${JSON.stringify(visible)}.`)
        if (rewritten !== section.text) section.text = rewritten
      }
    }
    return next()
  })

  /* ---------- shared operations (agent tool + Client remote) ---------- */

  const ops = {
    async list(sessionId) {
      scanGlobal()
      /* Fill in instruction text even on a host that has not run a model
       * request since it started. */
      describeRegisteredServers()
      const entry = sessions.get(sessionId)
      /* A session with no live agent (closed, or never attached in this host)
       * reports the project default overlaid with its own stored overrides —
       * exactly what reopening it would start from. */
      const stored = entry === undefined ? sessionRecordFor(sessionId) : undefined
      const cwd = entry !== undefined ? entry.cwd : (stored?.cwd ?? '')
      const c = cfg()
      /* A session reports its own state; either way each entry also carries the
       * workspace state, so the panel can show both switches. */
      const workspaceMcpSet = workspaceMcp(cwd)
      const mcpEnabled = entry !== undefined
        ? entry.mcp
        : overlay(workspaceMcp(cwd), stored?.mcp)
      const descriptions = new Map()
      const known = await skillInventory(cwd, entry?.agent, descriptions)
      const workspaceSkillSet = workspaceSkills(cwd, known)
      const skillsEnabled = entry !== undefined
        ? entry.skills
        : overlay(workspaceSkills(cwd, known), stored?.skills)
      const servers = [...inventory.keys()].sort().map((server) => {
        const names = [...inventory.get(server)]
        return {
          kind: 'mcp',
          name: server,
          enabled: mcpEnabled.has(server),
          workspace: workspaceMcpSet.has(server),
          official: c.officialServers.includes(server),
          detail: `${names.length} tools`,
          description: serverDescriptions.get(server) ?? '',
        }
      })
      const skills = [...known.keys()].sort().map((skillName) => {
        /* A gated skill is reported through its shadow; show the origin learned before gating. */
        const reported = known.get(skillName)
        const source = reported === SHADOW_SKILL_SOURCE
          ? (entry?.sources.get(skillName) ?? SHADOW_SKILL_SOURCE)
          : reported
        const description = entry?.skillDescriptions.get(skillName)
          ?? (reported === SHADOW_SKILL_SOURCE ? '' : descriptions.get(skillName))
        return {
          kind: 'skill',
          name: skillName,
          enabled: skillsEnabled.has(skillName),
          workspace: workspaceSkillSet.has(skillName),
          official: OFFICIAL_SKILL_SOURCES.has(source),
          detail: String(source),
          description: oneLine(description ?? ''),
        }
      })
      const knownTools = entry !== undefined ? entry.knownTools : builtinToolInventory(ctx)
      const workspaceToolSet = workspaceTools(cwd, knownTools)
      const toolsEnabled = entry !== undefined
        ? entry.tools
        : overlay(workspaceTools(cwd, knownTools), stored?.tools, knownTools)
      const tools = [...knownTools].sort().map((toolName) => ({
        kind: 'tool',
        name: toolName,
        enabled: toolsEnabled.has(toolName),
        workspace: workspaceToolSet.has(toolName),
        official: true,
        detail: '',
        description: oneLine(toolDescriptions.get(toolName) ?? ''),
      }))
      return { sessionId, cwd, mcp: servers, skills, tools }
    },
    async set(sessionId, kind, target, enabled, scope) {
      const where = scope === 'workspace' ? 'workspace' : 'session'
      const entry = sessions.get(sessionId)
      if (entry === undefined) {
        return { ok: false, reason: 'no live agent for this session; open the session first' }
      }
      /* A workspace choice lands in the project record (explicit choices only).
       * This conversation's own switch outranks the project default: when it has
       * an override for the entry, the workspace write changes the default only
       * and leaves the session alone — the two switches may legitimately
       * disagree, and the session one is what the model sees here. Without an
       * override there is nothing to outrank, so the write shows up here at once
       * (that is what "workspace, applied here" means) and later sessions in
       * this project inherit it. Other live sessions keep their own state. */
      let record
      if (where === 'workspace') {
        record = workspaceRecord(entry.cwd)
        if (record === undefined) {
          return { ok: false, reason: 'this session has no working directory, so it cannot own a workspace record' }
        }
      }
      const pinned = where === 'workspace'
        && sessionRecordFor(sessionId, entry.cwd)?.[SESSION_FIELDS[kind]]?.[target] !== undefined
      const applyHere = !pinned
      if (kind === 'mcp') {
        scanGlobal()
        if (!inventory.has(target)) {
          return { ok: false, reason: `unknown MCP server "${target}"; call list first` }
        }
        if (applyHere) {
          if (enabled) entry.mcp.add(target)
          else entry.mcp.delete(target)
          reconcile(entry)
        }
        if (record !== undefined) record.mcp[target] = enabled
      } else if (kind === 'skill') {
        if (!entry.knownSkills.has(target)) {
          return { ok: false, reason: `unknown skill "${target}"; call list first` }
        }
        if (applyHere) {
          if (enabled) entry.skills.add(target)
          else entry.skills.delete(target)
          reconcileSkills(entry)
        }
        if (record !== undefined) record.skills[target] = enabled
      } else if (kind === 'tool') {
        if (PROTECTED_TOOL_NAMES.has(target)) {
          return { ok: false, reason: `"${target}" is protected and cannot be gated` }
        }
        if (!entry.knownTools.has(target)) {
          return { ok: false, reason: `unknown tool "${target}"; call list first` }
        }
        if (applyHere) {
          if (enabled) entry.tools.add(target)
          else entry.tools.delete(target)
          reconcile(entry)
        }
        if (record !== undefined) record.tools[target] = enabled
      } else {
        return { ok: false, reason: `unknown kind "${kind}"; use mcp, skill or tool` }
      }
      if (where === 'session') {
        /* The conversation keeps this choice: reopening it, even after a host
         * restart, starts from here instead of from the project default. */
        persistSession(sessionId, entry.cwd, (next) => { next[SESSION_FIELDS[kind]][target] = enabled })
      }
      if (record !== undefined) persistWorkspace(entry.cwd)
      return {
        ok: true,
        kind,
        name: target,
        enabled,
        scope: where,
        note: where === 'workspace'
          ? pinned
            ? 'saved as this workspace\'s default; this conversation keeps its own choice for this entry'
            : 'applied here; sessions started in this workspace later inherit it'
          : 'takes effect on the next model request; this conversation keeps the choice when it is reopened',
      }
    },
  }

  /* ---------- the model-facing control surface ---------- */

  const offTool = ctx.tools.register(defineTool({
    name: 'context_control',
    description:
      'List this session\'s gated MCP servers, skills and built-in tools, or enable/disable one. '
      + 'Gated entries contribute no tool schemas, no prompt sections, and no catalog lines until enabled; changes take effect on the next model request. '
      + 'Official entries start enabled; user-configured MCP servers and skills start disabled; built-in tools start enabled. '
      + 'Protected tools (run_code, context_control, structured_output) cannot be gated. Call list first for exact names. '
      + 'scope=session (default) changes this conversation only and is kept for it when it is reopened, even after a host restart; scope=workspace records the choice as this workspace\'s default, applies it here, and is inherited by sessions started here later. '
      + 'The user can also toggle either scope from the composer panel.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'enable', 'disable'],
        description: 'Operation: list gated entries, or enable/disable one.',
      },
      kind: {
        type: 'string',
        enum: ['mcp', 'skill', 'tool'],
        description: 'Toggle target kind; defaults to mcp.',
      },
      target: {
        type: 'string',
        description: 'MCP server, skill or built-in tool name from the list; required for enable and disable.',
      },
      scope: {
        type: 'string',
        enum: ['session', 'workspace'],
        description: 'Where the choice applies: session (default) = this conversation only, remembered for it when it is reopened; workspace = this workspace\'s default for sessions started here later too.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      if (args.action !== 'list' && !cfg().allowAgentToggle) {
        return 'Agent toggling is disabled in this plugin\'s configuration; ask the user to toggle from the composer panel.'
      }
      const agent = exec.agent
      if (agent === undefined) return 'No live session context for this call.'
      if (args.action === 'list') return JSON.stringify(await ops.list(agent.id))
      if (args.target === undefined) return 'target is required for enable and disable.'
      return JSON.stringify(await ops.set(agent.id, args.kind ?? 'mcp', args.target, args.action === 'enable', args.scope))
    },
  }))

  /* The Client half reaches the same operations through the Typert Gateway. */
  const service = new ContextControlRemote(ctx, ops)

  /* Cover agents that already exist (startup races in other deployments). */
  for (const agent of ctx.agents.list()) void attach(agent)

  /* ---- Update channel (optional, never fatal) ----
   * An HTTP surface for the popover's version row: check and upgrade. The
   * plugin never restarts the host — the UI only tells the user to do it.
   * `webServer` is injected separately because a non-web host has no such
   * service, and everything here is wrapped because a broken update channel
   * must not take the gating feature down with it — that failure mode (a
   * plugin whose `apply` throws) makes the whole host unbootable. */
  let updater
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (webServer === undefined) return
    try {
      updater = createUpdater({ ctx, config: cfg() })
      const handle = createUpdateRoutes(updater)
      const disposers = []
      const prefix = '/plugins/dsh-context-control'
      const handler = (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        handle(req, res, pathname).catch((error) => {
          warn(ctx, `update route failed: ${String(error)}`)
          try {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: String(error) }))
          } catch { /* the response may already be gone */ }
        })
      }
      try {
        disposers.push(webServer.register({ kind: 'prefix', path: prefix, handler }))
      } finally {
        scoped.effect(() => () => {
          for (const dispose of disposers) {
            try { dispose() } catch { /* already removed */ }
          }
          try { updater?.dispose() } catch { /* nothing left to stop */ }
        })
      }
    } catch (error) {
      warn(ctx, `update channel unavailable: ${String(error)}`)
    }
  })

  return () => {
    offTool()
    offAgentCreated()
    offAgentDisposed()
    offToolsChange()
    offSkillsChange()
    offDomainChanged()
    offAssemble()
    for (const entry of sessions.values()) {
      try { entry.disposer?.() } catch { /* agent.ctx unwind owns these too */ }
      for (const dispose of entry.skillShadows.values()) {
        try { dispose() } catch { /* agent.ctx unwind owns these too */ }
      }
    }
    sessions.clear()
    void service
    if (domain !== null) void domain.close().catch(() => { /* closing on unload is best-effort */ })
  }
}
