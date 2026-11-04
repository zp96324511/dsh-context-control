/**
 * dsh-context-control — Host half.
 *
 * Per-session visibility gating for MCP servers and skills, with durable
 * per-project state. New sessions start with a lean model surface: official
 * entries (config-declared MCP servers; bundled/runtime skills) stay enabled,
 * everything else starts gated off. Gated entries contribute no tool schemas,
 * no prompt sections, and no catalog lines until enabled for that session —
 * through the `context_control` agent tool (the model, on the user's request)
 * or the composer panel (Client half, over the Typert Gateway as
 * `remote.contextControl`).
 *
 * Mechanism, per Harness plugin practices:
 * - MCP tool schemas: one per-agent `tools.restrict({ deny })` applied through
 *   `agent.ctx` (schema presentation, lookup, and execution stay aligned).
 *   Re-applied whenever the global tool inventory changes, so asynchronously
 *   registering MCP tools are caught by the `tools/change` listener.
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
 *   project, user (`~/.dsh/skills`, `~/.agents/skills`) and custom roots are
 *   contributed by the filesystem provider mounted inside the agent preset, so
 *   an unscoped read sees only the global layer (bundled and host-registered
 *   skills).
 * - Both take effect on the next model request: the agent loop detects the
 *   changed tool surface and starts a new request series.
 *
 * Durable state: one `context-control` storage domain (json backend under
 * ~/.dsh/storages/), one record per project (the session's cwd) holding the
 * last chosen enabled sets. A new or resumed session in the same project
 * starts from that record; entries it does not mention fall back to the
 * configured defaults. MCP connections themselves stay connected — this
 * plugin controls model context, not processes.
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
    /** How the host comes back after an upgrade. */
    restart: z.object({
      /** `respawn` (a detached helper re-runs the same command), `exit`, `none`. */
      mode: z.string(),
      /** Port to wait on before the helper starts the new process. */
      port: z.number(),
      /** Where the respawned host writes its own output. */
      logFile: z.string(),
    }).default({}),
  }).default({}),
}).default({
  defaultOn: [], defaultOff: [], officialServers: [],
  defaultOnSkills: [], defaultOffSkills: [],
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
/** Skill sources shipped with DSH itself: default on. Everything else defaults off. */
const OFFICIAL_SKILL_SOURCES = new Set(['bundled', 'runtime'])
/**
 * Source label of this plugin's own gating shadows. The skills registry keeps a
 * runtime registration's `source` verbatim, so the shadow is distinguishable
 * from a real skill and never mistaken for a discovered origin.
 */
const SHADOW_SKILL_SOURCE = 'context-control-gated'

/** Durable layout: one record per project cwd with the last chosen sets. */
const PROJECT_DOMAIN = defineDomain({
  name: 'context_control',
  version: 1,
  layout: 'single',
  tables: {
    projects: domainTable(zod.object({
      mcp: zod.record(zod.string(), zod.boolean()),
      skills: zod.record(zod.string(), zod.boolean()),
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
  /** Remote `set`: enable or disable one MCP server or skill for one session. */
  async remoteSet(sessionId, kind, target, enabled) {
    return this.ops.set(String(sessionId), String(kind), String(target), Boolean(enabled))
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

  /** Persist one session's current sets as its project's record. */
  function persist(entry) {
    if (domain === null || entry.cwd === '') return
    const mcp = {}
    for (const server of inventory.keys()) mcp[server] = entry.mcp.has(server)
    const record = { mcp, skills: {} }
    for (const name of entry.knownSkills) record.skills[name] = entry.skills.has(name)
    domain.table('projects').put(entry.cwd, record).catch(
      (error) => warn(ctx, `persisting state failed: ${String(error)}`),
    )
  }

  /* ---------- inventory scans ---------- */

  /** Scan the global tool view (immune to per-agent restrictions). @returns whether the inventory changed. */
  function scanGlobal() {
    const seen = new Set()
    for (const schema of ctx.tools.schemas()) seen.add(schema.name)
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
   * Discover the skills one agent can actually see. Skills are a layered
   * registry: project, user and custom roots are contributed by the filesystem
   * provider mounted inside the agent preset, so a read without `scope` sees
   * only the global layer (bundled and host-registered skills) and every
   * `~/.agents/skills`, `~/.dsh/skills`, `<project>/.agents/skills` entry stays
   * invisible. Pass the viewing agent, exactly as the `skill` tool and the
   * catalog do.
   * @param cwd - project working directory; '' asks for the default view.
   * @param agent - viewing agent whose scope chain contributes preset skills; omitted for the global view.
   * @returns name -> source map; this plugin's own shadows report SHADOW_SKILL_SOURCE.
   */
  async function skillInventory(cwd, agent) {
    try {
      const options = cwd === '' ? {} : { cwd }
      if (agent !== undefined) options.scope = agent
      const summaries = await ctx.skills.list(options)
      const known = new Map()
      for (const summary of summaries) known.set(summary.name, summary.source)
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

  /** Tool names to deny for one enabled set: gated servers' tools, plus resource tools while no server is enabled. */
  function denyFor(enabled) {
    const deny = new Set()
    let anyEnabled = false
    for (const [server, tools] of inventory) {
      if (enabled.has(server)) {
        anyEnabled = true
        continue
      }
      for (const name of tools) deny.add(name)
    }
    if (!anyEnabled) for (const name of resourceTools) deny.add(name)
    return deny
  }

  /* ---------- per-agent reconciliation ---------- */

  /** Lift and re-apply one agent's MCP restriction for its current enabled set. */
  function reconcileMcp(entry) {
    reconciling = true
    try {
      if (entry.disposer !== undefined) {
        const lift = entry.disposer
        entry.disposer = undefined
        try { lift() } catch (error) { warn(ctx, `lifting restriction failed: ${String(error)}`) }
      }
      const deny = denyFor(entry.mcp)
      entry.deny = deny
      if (deny.size === 0) return
      try {
        entry.disposer = entry.agent.ctx.tools.restrict({ deny: [...deny] })
      } catch (error) {
        /* Stale names (a server vanished mid-run) fail restrict's validation;
         * retry with the global-view subset, which every agent inherits. */
        const fallback = [...deny].filter((name) => globalSeen.has(name))
        if (fallback.length > 0 && fallback.length < deny.size) {
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

  /** Refresh one agent's skill knowledge (new skills default, vanished ones drop) and re-apply shadows. */
  async function refreshSkills(entry) {
    const known = await skillInventory(entry.cwd, entry.agent)
    for (const [name, source] of known) {
      /* A shadow masks the real origin; keep the one learned before gating. */
      if (source !== SHADOW_SKILL_SOURCE) entry.sources.set(name, source)
      if (!entry.knownSkills.has(name)) {
        entry.knownSkills.add(name)
        const c = cfg()
        if (!c.defaultOffSkills.includes(name)
          && (c.defaultOnSkills.includes(name) || OFFICIAL_SKILL_SOURCES.has(source))) {
          entry.skills.add(name)
        }
      }
    }
    for (const name of [...entry.knownSkills]) {
      if (!known.has(name)) {
        entry.knownSkills.delete(name)
        entry.skills.delete(name)
        entry.sources.delete(name)
      }
    }
    reconcileSkills(entry)
  }

  /** Attach gating state to one agent: init from the project record, apply MCP restriction and skill shadows.
   * MCP gating lands synchronously before the first await, so a new agent's first assembly cannot slip past it;
   * skill shadows follow discovery. The agent/created listener awaits this whole call. */
  async function attach(agent) {
    if (sessions.has(agent.id)) return
    scanGlobal()
    scanAgentTools(agent)
    const cwd = agent.session.header.cwd ?? ''
    const stored = storedFor(cwd)
    const mcp = defaultsForMcp()
    if (stored !== undefined) {
      for (const [server, on] of Object.entries(stored.mcp ?? {})) {
        if (on) mcp.add(server)
        else mcp.delete(server)
      }
    }
    const entry = {
      agent, cwd,
      mcp, skills: new Set(), knownSkills: new Set(), sources: new Map(),
      deny: new Set(),
      disposer: undefined,
      skillShadows: new Map(),
    }
    sessions.set(agent.id, entry)
    reconcileMcp(entry)
    const known = await skillInventory(cwd, agent)
    const skills = defaultsForSkills(known)
    if (stored !== undefined) {
      for (const [name, on] of Object.entries(stored.skills ?? {})) {
        if (on) skills.add(name)
        else skills.delete(name)
      }
    }
    entry.skills = skills
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

  /* Catch asynchronously registering MCP tools and vanished ones. */
  const offToolsChange = ctx.on('tools/change', () => {
    if (reconciling) return
    if (scanGlobal()) {
      for (const entry of sessions.values()) reconcileMcp(entry)
    }
  })

  /* Catch skill catalog changes (new or removed skills) for every live agent. */
  const offSkillsChange = ctx.on('skills/change', () => {
    if (shadowing) return
    for (const entry of sessions.values()) void refreshSkills(entry)
  })

  /* Remove gated servers' prompt sections; keep every other contribution. */
  const offAssemble = ctx.on('system-prompt/assemble', (assembly, context, next) => {
    const agent = context.agent
    const entry = agent === undefined ? undefined : sessions.get(agent.id)
    if (entry === undefined) return next()
    const enabled = entry.mcp
    if (assembly.sections.some((section) => section.name.startsWith('mcp:'))) {
      assembly.sections = assembly.sections.filter(
        (section) => !section.name.startsWith('mcp:') || enabled.has(section.name.slice(4)),
      )
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
      const entry = sessions.get(sessionId)
      const cwd = entry !== undefined ? entry.cwd : ''
      const c = cfg()
      const mcpEnabled = entry !== undefined ? entry.mcp : mcpEnabledForStored(sessionId, cwd)
      const known = await skillInventory(cwd, entry?.agent)
      const skillsEnabled = entry !== undefined ? entry.skills : skillsEnabledForStored(cwd, known)
      const servers = [...inventory.keys()].sort().map((server) => ({
        kind: 'mcp',
        name: server,
        enabled: mcpEnabled.has(server),
        official: c.officialServers.includes(server),
        detail: `${inventory.get(server).size} tools`,
      }))
      const skills = [...known.keys()].sort().map((skillName) => {
        /* A gated skill is reported through its shadow; show the origin learned before gating. */
        const reported = known.get(skillName)
        const source = reported === SHADOW_SKILL_SOURCE
          ? (entry?.sources.get(skillName) ?? SHADOW_SKILL_SOURCE)
          : reported
        return {
          kind: 'skill',
          name: skillName,
          enabled: skillsEnabled.has(skillName),
          official: OFFICIAL_SKILL_SOURCES.has(source),
          detail: String(source),
        }
      })
      return { sessionId, cwd, mcp: servers, skills }
    },
    async set(sessionId, kind, target, enabled) {
      const entry = sessions.get(sessionId)
      if (entry === undefined) {
        return { ok: false, reason: 'no live agent for this session; open the session first' }
      }
      if (kind === 'mcp') {
        scanGlobal()
        if (!inventory.has(target)) {
          return { ok: false, reason: `unknown MCP server "${target}"; call list first` }
        }
        if (enabled) entry.mcp.add(target)
        else entry.mcp.delete(target)
        reconcileMcp(entry)
      } else if (kind === 'skill') {
        if (!entry.knownSkills.has(target)) {
          return { ok: false, reason: `unknown skill "${target}"; call list first` }
        }
        if (enabled) entry.skills.add(target)
        else entry.skills.delete(target)
        reconcileSkills(entry)
      } else {
        return { ok: false, reason: `unknown kind "${kind}"; use mcp or skill` }
      }
      persist(entry)
      return { ok: true, kind, name: target, enabled, note: 'takes effect on the next model request' }
    },
  }

  /** Enabled MCP set for a session with no live agent: stored record over defaults. */
  function mcpEnabledForStored(_sessionId, cwd) {
    const enabled = defaultsForMcp()
    const stored = storedFor(cwd)
    if (stored !== undefined) {
      for (const [server, on] of Object.entries(stored.mcp ?? {})) {
        if (on) enabled.add(server)
        else enabled.delete(server)
      }
    }
    return enabled
  }

  /** Enabled skill set for a session with no live agent: stored record over defaults. */
  function skillsEnabledForStored(cwd, known) {
    const enabled = defaultsForSkills(known)
    const stored = storedFor(cwd)
    if (stored !== undefined) {
      for (const [name, on] of Object.entries(stored.skills ?? {})) {
        if (on) enabled.add(name)
        else enabled.delete(name)
      }
    }
    return enabled
  }

  /* ---------- the model-facing control surface ---------- */

  const offTool = ctx.tools.register(defineTool({
    name: 'context_control',
    description:
      'List this session\'s gated MCP servers and skills, or enable/disable one for this session only. '
      + 'Gated entries contribute no tools, no prompt sections, and no catalog lines until enabled; changes take effect on the next model request. '
      + 'Official entries start enabled; user-configured ones start disabled. Call list first for exact names. '
      + 'The user can also toggle entries from the composer panel.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'enable', 'disable'],
        description: 'Operation: list gated entries, or enable/disable one for this session.',
      },
      kind: {
        type: 'string',
        enum: ['mcp', 'skill'],
        description: 'Toggle target kind; defaults to mcp.',
      },
      target: {
        type: 'string',
        description: 'MCP server name or skill name from the list; required for enable and disable.',
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
      return JSON.stringify(await ops.set(agent.id, args.kind ?? 'mcp', args.target, args.action === 'enable'))
    },
  }))

  /* The Client half reaches the same operations through the Typert Gateway. */
  const service = new ContextControlRemote(ctx, ops)

  /* Cover agents that already exist (startup races in other deployments). */
  for (const agent of ctx.agents.list()) void attach(agent)

  /* ---- Update channel (optional, never fatal) ----
   * An HTTP surface for the popover's version row: check, upgrade, restart.
   * `webServer` is injected separately because a non-web host has no such
   * service, and everything here is wrapped because a broken update channel
   * must not take the gating feature down with it — that failure mode (a
   * plugin whose `apply` throws) makes the whole host unbootable. */
  let updater
  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    if (webServer === undefined) return
    try {
      updater = createUpdater({ ctx, config: cfg(), logger: (message) => warn(ctx, message) })
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
