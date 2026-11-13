# Changelog

Releases are cut from tags (`v*`), and the publish workflow attaches a
version-free copy of the tarball plus a `channel.json` to every release — which
is what an installed copy reads to discover the next version.

## 0.8.2 — 2026-11-13

- **The popover follows the light theme.** It did not before: three of its
  colours asked for CSS variables DSH never defined
  (`--dsw-alias-bg-elevated`, `--dsw-alias-bg-sunken`, `--dsw-alias-border-l`),
  so every one of them fell through to the hard-coded fallback — and the panel
  background fell back to `#232326`, near-black in both palettes. In the dark
  theme that matched by accident; in the light theme the panel stayed black
  under a white GUI. The surface now uses the theme's own menu material
  (`--dsw-specific-menu`, light `#fcfdfe` / dark `#303136`, both translucent
  over `--dsw-menu-backdrop-filter`), the borders use `--dsw-alias-border-l2`,
  and the popped shadow is `--dsw-elevation-prominent` instead of a fixed
  `rgba(0,0,0,.38)` pair that read as a smudge on a white page. The install
  log block borrows `--dsw-alias-markdown-code-block`. If even the tokens are
  missing (an older DSH), the fallback is now `Canvas`, which follows
  `color-scheme` rather than assuming dark.
- **The kind switcher uses the theme's segmented pair.** The track is
  `--dsw-alias-interactive-bg-hover` and the selected tab
  `--dsw-alias-interactive-bg-active`, so the thumb has a real step up from
  the track in both palettes.
- **A following dot is dimmer by one notch less:** the ring opacity went from
  0.3 to 0.4, which keeps "following the project" visible on the light theme's
  white card while staying clearly dimmer than a bright 1.0 ring.

## 0.8.1 — 2026-11-13

- **The following state is dimmer, so the two states separate at a glance.**
  The dim/bright step is a single `opacity` on the ring (it multiplies the
  border colour and the centre dot together, which is why one number moves both
  and why it needs no second palette for a dark theme); it went from 0.5 to 0.3,
  leaving a bright ring at 1.0. The ring keeps its 11px size in every state, so
  nothing shifts.

## 0.8.0 — 2026-11-13

- **A third state for the session dot: following the project.** Until now a
  session dot only said on or off, so "I turned this off here" and "the project
  turns it off and I never touched it" looked identical. An entry this
  conversation never set now keeps a dim ring and mirrors the workspace dot, and
  a real choice is the only thing that lights the ring up. The list reports the
  distinction as `pinned`, so the panel does not have to infer it.
- **Right-click or Alt+click unpins.** `scope: 'follow'` (and `action: 'follow'`
  on the `context_control` tool) drops this conversation's choice for that one
  entry, applies the project's value to the live session at once, and deletes the
  stored override — taking the whole session record with it when that was the
  last choice it held. Other choices the conversation made are untouched.
- An older client bundle still works: a four-argument `set` keeps meaning
  session-only, and a host without `pinned` is read as pinned, so the dots keep
  their pre-0.8.0 meaning.
- The usage note gained a line on the third state and the gesture; the dots
  still carry no hover card.

## 0.7.4 — 2026-11-13

- **Descriptions no longer wait for the first model request.** A server's
  `instructions` only existed in the plugin after a `system-prompt/assemble`
  had run in *this* host process, so a freshly restarted host listed every MCP
  server with nothing but its tool count until some conversation sent a
  message. The text is now read from the section the MCP client registered
  (`mcp:<server>`), whose provider returns the last successful handshake — so
  the panel describes servers as soon as they connect.
- **The `### MCP server: <name>` heading is stripped.** `dsh-mcp-client`
  prefixes the instructions with that markdown heading before registering the
  section, and the panel showed it verbatim in front of every description.
- Fixed literal `\uXXXX` escapes that had reached the English README.
## 0.7.3 — 2026-11-12

- **The update controls and the "?" swapped sides.** The version, the status
  text and the check button now sit flush left, and only the "?" is pushed to
  the far right by an auto margin, so the version and the button that acts on it
  stay together.
- **The dots lost their hover cards.** Two toggles sit two pixels apart, so a
  tooltip on one covered the row it was explaining; the colours are described
  once in the note behind the "?" instead. The accessible name still says
  `entry · session` / `entry · workspace`.
- **The usage note is written prose now.** Four lines: what each dot is, that a
  session choice survives reopening the conversation (including after a host
  restart) while a restored archive inherits the workspace again, how the
  workspace default is adopted, that the session scope wins when both exist, and
  that every change takes effect on the next model request. The lines are
  preserved (`white-space: pre-line`) instead of collapsing into one paragraph.
- The collapsed pill's tooltip is a single line again; the full note lives
  behind the "?".
## 0.7.2 — 2026-11-12

- **The row fits again.** Rows are divs now (they were buttons before 0.7.0,
  and a button is border-box while a div is not), so `width: 100%` plus 16px of
  padding made every row 16px wider than the popover: a horizontal scrollbar
  appeared and pushed the workspace dot off the right edge. Rows and the popover
  itself are border-box, and the list keeps `overflow-x: hidden`.
- **The "?" moved into the update row.** It used to sit alone on a row of its
  own with a wide empty line in front of it; it now shares the row with the
  version and the buttons, and the note unfolds under that row when asked.
- **The second line never disappears.** A row shows the resource's description
  when it has one, and the entry's own detail otherwise — an MCP server with no
  `instructions` still says how many tools it brings instead of collapsing into
  a half-empty row.
## 0.7.1 — 2026-11-12

- **The switches are dots again.** Each row ends in two radio dots instead of
  two labelled pills: a hollow ring when off, the same ring with a centre dot
  when on, so a toggle never changes the row's height or width. The session dot
  is blue, the workspace dot violet — same size, same shape, distinguishable at
  a glance and by tooltip. The accessible names still say 会话 / 工作区, so a
  screen reader and the hover title keep the meaning that the label used to
  carry. The panel is also a bit narrower again (each row lost ~70px of text).
- **The usage note is collapsed.** The three-line paragraph under the update
  row is now behind a small `?` button at the bottom right of the popover; it
  only takes room when opened, which matters most on a short viewport where the
  note used to squeeze the list.
- **Checking for updates shows that it is working.** A user-triggered check now
  enters the `checking` phase before the request leaves the page, and every busy
  action (check, one-click upgrade) shows a rotating ring beside its label. The
  channel answer often arrives from the host cache within milliseconds, so the
  old behaviour — a button that looked untouched until the row silently settled
  — read as a broken click. The automatic half-hourly re-check still runs
  silently so a background poll cannot make the row flicker.

## 0.7.0 — 2026-11-12

- **Two scopes per row.** Every entry (MCP server, skill, built-in tool) now
  ends in two switches instead of one: `session` and `workspace`. Before this
  release a single switch meant one thing — flipping it in one conversation
  rewrote the project record and therefore the default of every conversation
  after it, while conversations already open kept their own state anyway, so
  the one button could never accurately describe what it had just done. The
  panel now says which of the two it is doing, and the `context_control` tool
  takes `scope` (`session` by default, matching the old in-conversation
  intent; `workspace` to write the project default).
- **Both scopes persist, in separate tables.** A `session` click is stored per
  conversation (session id, together with the `cwd` it was made in) and comes
  back when that conversation is reopened — including after a host restart; a
  `workspace` click stores the project default and leaves this conversation's
  own choice untouched (the session switch outranks it, so one row may show two
  different answers — the session one is what the model runs with). Session records are pruned on write (older than 180
  days, or beyond the 1000-record cap, oldest first), because DSH exposes no
  "session deleted" event to hook; **archiving a conversation is the one
  signal it does expose**, so that drops the record at once — a conversation
  restored from the archive inherits the workspace again instead of reviving
  choices the user retired.
- The effective workspace state is the configured defaults overlaid with the
  record's explicit choices, so `defaultOn` / `defaultOff` / `defaultOffTools`
  still govern entries nobody has pinned, and toggling one entry no longer
  freezes the rest of the workspace at whatever the clicking session happened
  to look like.
- New tool servers and tools that appear while the host runs, and skills that
  are added later, now enter each session as the workspace says instead of as
  "default on" — a late-arriving entry follows the project, not an accident of
  discovery order.
- The row is a `role="group"` with a `role="switch"` button per scope; the
  popover grew to 320px, Left/Right move between the two switches of a row
  while Up/Down keep the column across rows. The remote `set` descriptor's
  `scope` parameter is optional, so an older client that never sends it keeps
  working with session semantics; `workspace` in a `list` response is optional
  too, so a client bundle that loads while the host still runs the previous
  module paints both switches from the one state that host knows instead of
  rejecting the whole list.

## 0.6.1 — 2026-11-10

- `resolveDshHome()` now resolves the home the way DSH itself does
  (`@deepseek-ai/dsh-home-paths`): a whitespace-only `$DSH_HOME` means unset, a
  leading `~`, `~/` or `~\` expands against the OS home, and the result is made
  absolute before anything is joined onto it. `DSH_HOME=~/data` used to become
  a literal directory named `~`; profile discovery, the update job record and
  the installer's `DSH_HOME` all go through this helper, so they follow the
  launcher instead of guessing.
- Reading the user's `~/.npmrc` for the registry no longer throws when the file
  is missing or unreadable: a failed read falls back to
  `https://registry.npmjs.org/`, so a machine without a user-level npm config
  keeps its registry channel instead of losing every version check. Precedence
  is unchanged (`npm_config_registry` > `~/.npmrc` > default), and the file
  stays user-level npm configuration — it does not follow `$DSH_HOME`.
- Comments and both READMEs describe DSH's user data as `$DSH_HOME/...`
  (default `~/.dsh`) instead of naming `~/.dsh` as the only location, so the
  next change does not re-learn the hardcoded path this release removes.

## 0.6.0 — 2026-11-09

- Remove the in-plugin host restart. A finished upgrade used to offer
  `[Restart]`, which asked the host to exit while a detached helper
  (`respawn.cjs`) re-ran a reconstructed command line. That is not a plugin's
  decision to make: the host may have been started with a profile, a port,
  environment variables or a supervisor wrapper that the plugin cannot
  reconstruct, so the guessed relaunch could come up wrong or not at all. The
  upgrade now stops after it verifies the installed version, and the row only
  says `已升级，重启 dsh web 后生效` / "Upgraded — restart dsh web to apply".
  The `/update/restart` route, the `restart` config block and `respawn.cjs`
  are gone.
- A check that finds files newer than the module this host loaded now reports
  the same restart hint instead of offering a page reload — a page reload
  cannot load host-side code. `[Reload]` is offered only when the host really
  restarted and serves a version the page did not boot with.

## 0.5.2 — 2026-11-07

- Fix: the popover's footer version row showed two check-for-updates buttons in
  a row in the idle and up-to-date states — the always-present ⟳ button and the
  text action button both forced the same re-check. The row now hides the ⟳
  whenever the action button *is* the check request, and keeps it in every
  other phase (busy, upgrading, restart, error), which are exactly the places
  a stale tab can only re-ask through it. The up-to-date row goes back to the
  documented single `[Check for updates]` / `[检查更新]` button.

## 0.5.1 — 2026-11-04

- Remove the token-cost estimate from the panel. The `~N tok` suffix is gone
  from the pill, the tab subtitles and the row details, and the host no longer
  emits a `tokens` field — the estimate was `JSON characters / 4`, which drifted
  too far from the real tokenizer to be worth showing. The panel now reports
  only what is on (`3/5`) and what each entry is.
- Rename the pill label from "上下文" to "组件上下文" (English: "Context" →
  "Components").

## 0.5.0 — 2026-11-04

- Every row now carries a one-line description, so the panel says what an
  entry does instead of only its name. Tools use their schema `description`,
  skills use the catalog description, and an MCP server uses its `instructions`
  prose (captured from the `mcp:<server>` system-prompt section during
  `system-prompt/assemble`; a server that publishes none keeps a single-line
  row). The row title carries the full description plus the origin/cost
  detail, and the text is exposed as `aria-description` for screen readers.
- The popover now switches between the three kinds with tabs instead of
  stacking three vertically scrolling groups; each tab carries its own
  `on/total · ~cost` so the count stays visible while a single list is shown.
  Tabs are a real `tablist` (roving tabindex, Left/Right/Home/End, Down into
  the rows), an empty kind gets no tab, and a kind that is the only one present
  renders without a strip at all. The tab strip stays pinned while the rows
  scroll under it.
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

