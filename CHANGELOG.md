# Changelog

Releases are cut from tags (`v*`), and the publish workflow attaches a
version-free copy of the tarball plus a `channel.json` to every release — which
is what an installed copy reads to discover the next version.

## 0.5.0 — 2026-11-04

- Built-in tools are now gated alongside MCP servers and skills. Tool schemas
  are the largest fixed cost in the tool table (they are re-sent on every
  request), so the panel lists every gateable tool with an estimated token
  cost — `ceil(JSON.stringify(schema).length / 4)` — and the pill/group
  headers sum the enabled rows (`~2.6k tok`). Disabled tools are removed from
  the model's view with the same `tools.restrict` call that hides MCP tools,
  and their `tool:<name>` system-prompt sections are dropped during
  `system-prompt/assemble` (a restriction hides the schema but not the
  section). Built-in tools start *enabled*, preserving existing behaviour;
  `defaultOffTools` opts specific tools out per install, and project-scoped
  choices persist like MCP/skill switches.
- `run_code`, `context_control` and `structured_output` are protected: they
  are the harness entry points themselves (hiding `context_control` would make
  the gate unrecoverable from inside the conversation), so they never appear
  in the list and a toggle request is refused with a reason.
- MCP tool rows and resource tools are never listed as individual tools; they
  still follow their server switch. MCP rows gained the same cost display,
  summing the schemas of the tools that server contributes.
- The `context_control` tool and the pane UI accept `kind: "tool"`, and the
  client descriptors/`listResultSchema` carry the new `tools` array plus a
  numeric `tokens` field per row.

## 0.4.6 — 2026-11-04

- Fix: skill gating missed every skill that came from a filesystem root. The
  plugin read `ctx.skills.list({ cwd })` without `scope`, and the skill registry
  merges only the global layer for an unscoped read — so `~/.agents/skills`,
  `~/.dsh/skills`, `<project>/.dsh/skills`, `<project>/.agents/skills` and
  `customSkillDirs`, all contributed by the agent preset's filesystem provider,
  were invisible. Those skills still reached the model's catalog (the `skill`
  tool passes `scope: agent`), stayed on in the prompt, and could not be
  toggled from the panel or `context_control` — while `list` reported only
  bundled skills. Discovery, refresh and the `list` operation now read through
  the viewing agent's scope, exactly like the catalog does.
- Gating shadows now carry their own `source` (`context-control-gated`) instead
  of `runtime`, so a shadowed user skill is not misreported as an official
  runtime skill; the panel keeps showing the origin learned before gating.
- Fix: skill shadows were registered as `agent.ctx.skills.register(...)`, but an
  agent context only reaches the services its loop declared (`tools`,
  `systemPrompt`, …), so that property access threw `cannot get property
  "skills" without inject` — the shadow was never installed, the failure only
  reached the log, and disabling a skill in the panel changed nothing in the
  model's catalog. Shadows are now registered from an injected child fiber of
  the agent context (`agent.ctx.inject(['skills'], …)`), which both reaches the
  service and owns the registration's lifetime: disposing the fiber lifts the
  shadow, and the entry still lands in the agent's own layer.
- Tests: a host-side regression test drives `apply` with a stub context whose
  scoped and unscoped reads differ and whose agent context refuses direct
  `skills` access, pinning discovery, toggling, shadow bookkeeping and the
  reported origin.

## 0.4.5 — 2026-11-04

- Fix: a 404 from the update routes (the new client bundle is served from disk
  while the process still runs the old host half) was parsed as an empty
  object and rendered as `v— · 已是最新` — the opposite of the truth. A
  non-OK response is now an error, and the 404 names its cause: the host must
  be restarted.
- Fix: a 200 whose body does not name a version is no longer accepted as a
  check result (a proxy page or an auth redirect could pass for "current").
- Tests: the client harness now reloads the module the way a page reload does
  (a distinct ES module instance) and covers both the stale-host click and the
  once-per-page auto check.
## 0.4.4 — 2026-11-01

- Docs: re-installing the same `releases/latest/download/...` URL is a pnpm
  no-op because the spec is unchanged; the in-panel upgrade is unaffected
  because it installs the tag named by `channel.json`.

## 0.4.3 — 2026-11-01

- Publish channel: GitHub Releases is now the documented default
  (`releases/latest/download/dsh-context-control.tgz`), alongside npm and
  self-hosted static channels.
- Docs: install/upgrade/publish/rollback are written out in both languages, and
  the profile patch carries a commented `update:` block for pinning a channel.

## 0.4.2 — 2026-11-01

- Fix: an upgrade rewrites the profile dependency to the *tagged* release asset,
  whose sibling `channel.json` is frozen at that tag. Release URLs now resolve
  to `releases/latest/download/channel.json`, so a GitHub-installed copy keeps
  following new releases instead of going quiet after the first upgrade.

## 0.4.1 — 2026-11-01

- Online install + self-update channel: version check against the channel the
  package was installed from, one-click upgrade through `dsh plugin add`, and a
  detached restart helper that brings the host back.
- Client: version row in the context popover with check/upgrade/restart/reload
  phases, install log, update badge, and a reload offer for tabs that outlived
  an upgrade.
- Publish guard (`scripts/check-manifest.mjs`), channel builder and local
  channel server; 20 host tests and 29 offline client tests.

