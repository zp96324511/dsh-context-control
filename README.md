# dsh-context-control

Visibility gating for MCP servers, skills and built-in tools in the DeepSeek Harness web profile: new sessions start lean (official entries on, user-configured ones off), the model or the composer panel turns entries on, and each row shows what the resource does. **Each entry has two radio dots** (blue = session, violet = workspace; the note behind the "?" at the bottom explains both) — `session` changes this conversation only, `workspace` stores a project default that this session adopts at once and every later session in the same project inherits (a session's own choice still wins). The plugin also **carries its own update channel**: it can tell you it is behind and upgrade itself in one click. After an upgrade it only tells you to restart `dsh web` — how the host was started is the user's business, not the plugin's.

English | [中文](README.zh.md)

## Table of contents

- [Install](#install)
- [Upgrade](#upgrade)
- [Publish (turn dist/ into a channel)](#publish-turn-dist-into-a-channel)
- [Configuration](#configuration)
- [Rollback and troubleshooting](#rollback-and-troubleshooting)
- [Local development](#local-development)

-----

## Install

Three online forms; all of them end up as one profile dependency, and they differ only in where future versions are looked up.

### 1. npm registry

```pwsh
dsh plugin --profile web add dsh-context-control
```

Checks `dist-tags.latest` on the registry pnpm is configured against.

### 2. GitHub Release tarball (no npm account needed)

```pwsh
dsh plugin --profile web add https://github.com/zp96324511/dsh-context-control/releases/latest/download/dsh-context-control.tgz
```

The publish workflow attaches a version-free copy to every release, so this URL always points at the newest one. The update check reads the release's `tag_name`.

### 3. Your own static channel (intranet, object store, any static host)

```pwsh
npm run channel                 # dist/: one tarball per version + channel.json
npm run channel:serve           # try it locally at http://127.0.0.1:10600/channel.json
dsh plugin --profile web add http://<host>/dsh-context-control/dsh-context-control-0.4.0.tgz
```

No configuration is needed to find the channel: the plugin takes the directory of the tarball it was installed from and reads `channel.json` beside it. Publish `dist/` anywhere and both install and upgrade work.

Restart `dsh web` once after installing. Later upgrades install the files themselves; the panel then tells you to restart the host.

> To pin a specific version, install the tagged asset
> (`.../releases/download/v0.4.3/dsh-context-control.tgz`). Re-installing the *same*
> `releases/latest/download/...` URL is a pnpm no-op — the spec did not change. The
> in-panel upgrade is unaffected: it always installs the tag named by `channel.json`.

## Upgrade

### Where

Open the "Components" pill left of any composer: the popover's footer shows the installed version and one button that does whatever the current phase needs.

- idle: `v0.4.0 · up to date · [Check for updates]`
- behind: an `↑` badge on the pill, `v0.4.0 → v0.4.1 · [Upgrade]`
- running: `[Upgrading…]` plus `[Details]` with pnpm's live output
- finished: `Upgraded — restart dsh web to apply` (or `[Reload]` when HMR already picked the new code up)

There is deliberately **no restart control**: the host may have been started with arguments or a supervisor the plugin cannot reconstruct, so re-executing a guessed command line could bring up the wrong host or none at all. Restarting stays with whoever started it.

Every pane on the machine shares this state: which version is installed is a fact about the host, not about a session.

### What the button does

It never uninstalls first — that leaves a profile without the plugin the moment anything fails, and failure is exactly when it happens. Instead:

1. **Check** the channel (cached 6 h on the host; clicking Upgrade forces a fresh look so a just-published release is not hidden by the cache).
2. **Install** by running the command you would type yourself, in the profile directory:

   ```pwsh
   dsh plugin --profile web add <spec>
   ```

   `<spec>` is `name@version` for a registry or the new tarball URL for a tarball channel. That inherits everything the manager already guarantees: the profile write lock, the `engines.dsh` pre-check, and a snapshot/restore of `package.json` and `pnpm-lock.yaml` on failure.

3. **Verify** by reading the installed `node_modules/<name>/package.json`. A zero exit code is not proof of the version you asked for — supply-chain policies such as `minimumReleaseAge` can install an older one — so a mismatch is reported.
4. **Tell the user to restart**: the upgrade stops here. The host is not exited and not relaunched; the row says "Upgraded — restart dsh web to apply", and you restart it the way you started it.

With HMR the restart is usually unnecessary: the plugin compares the version its module was loaded from with the version on disk and, when the new code is already live, offers a page reload instead.

### The outcome survives a plugin reload

An upgrade often replaces the plugin itself. The job record lives in `$DSH_HOME/storages/dsh-context-control-update.json` and is read back by the new instance; a record still marked `running` (the install was interrupted by the reload) is reported as failed instead of spinning forever.

## Publish (turn dist/ into a channel)

```pwsh
npm run check                    # manifest guard + both test suites
npm run channel                  # dist/: tarballs + channel.json (versions accumulate)
npm run channel -- --prune 5     # keep only the newest five versions
```

- **npm**: push a `v*` tag; `.github/workflows/publish.yml` publishes when `NPM_TOKEN` is set and always produces the release.
- **GitHub Release**: the same run attaches `dsh-context-control.tgz` (stable name), `dsh-context-control-0.4.0.tgz` (versioned) and `channel.json`.
- **Your own host**: upload `dist/`. `channel.json` beside the tarballs is all an installed machine needs.

`scripts/check-manifest.mjs` is the guard that runs before a publish: a file missing from `files`, an `exports` target outside it, the two halves disagreeing about the route prefix or the plugin id, a missing `engines.dsh` — all fail before `npm publish` rather than on someone else's machine.

### Push to GitHub and cut a release (how this repository is published)

```pwsh
# Push with the dedicated deploy key (no PAT on this machine; the public half is
# registered under GitHub → Settings → SSH keys, the private one lives at
# ~/.ssh/id_ed25519_dsh).
$key = ($env:USERPROFILE -replace '\\','/') + '/.ssh/id_ed25519_dsh'
$env:GIT_SSH_COMMAND = "ssh -i $key -o IdentitiesOnly=yes -o BatchMode=yes"

npm run check                                  # guard + both test suites
# bump package.json version and CHANGELOG.md
git add -A
git commit -m "0.4.5: …"
git tag -a v0.4.5 -m "dsh-context-control 0.4.5"   # the tag must equal the version
git push origin main
git push origin v0.4.5
```

The `Publish` workflow runs on the tag: it checks `tag == version`, runs `npm run check`, publishes to npm only when `NPM_TOKEN` exists, packs the tarball, builds `channel.json`, and creates the release with `dsh-context-control.tgz` (stable name), `dsh-context-control-<version>.tgz` and `channel.json` attached — about ten seconds. Installed copies notice it on their next check at `https://github.com/<owner>/<repo>/releases/latest/download/channel.json`.

## Configuration

### Session scope vs workspace scope

Every row in the panel ends in two radio dots (hollow ring = off, ring with a centre dot = on; blue = session, violet = workspace), and the `context_control` tool
takes the same choice as a `scope` argument:

| `scope` | What it writes | What it reaches |
|---|---|---|
| `session` (default) | the `sessions` table of the `context_control` domain, keyed by session id (with the `cwd` it was made in) | this session alone; reopening that conversation — even after a host restart — brings the choice back (an archived one starts from the workspace again) |
| `workspace` | an explicit choice in the project record (the `projects` table of the same domain, keyed by `cwd`) | this session immediately, and every session started in that directory afterwards |
| `follow` (`action=follow` on the tool) | removes that entry from the `sessions` record | the entry follows the workspace default again; in the panel this is a right-click or Alt+click on the session dot |

- A workspace's effective state is the configuration defaults (`defaultOn`,
  `defaultOff`, `officialServers`, `defaultOnSkills`, `defaultOffTools`, …)
  **overlaid** with the record's explicit choices. Entries the record does not
  mention keep following the configuration, so editing the config still moves
  everything nobody has pinned.
- A new session copies the workspace state when it opens, then overlays its own
  session record if that conversation was adjusted before. Sessions that are
  already open are never dragged around by somebody else's `workspace` write —
  that separation is the point of the two switches.
- A **branch** (fork) starts from the session-scoped choices the source
  conversation had pinned: those entries are copied onto the child before the
  branch opens, so its first request already runs with the same switches. It is
  a snapshot — changing either side afterwards leaves the other alone; the
  workspace default needs no copy, since a branch keeps its source's `cwd`.
  DSH's ordinary fork records no source session, so the copy happens in the
  client, between `ctx.sessions.fork` returning the child id and the UI opening
  the branch.
- A `workspace` write stores **the entry that was toggled**, not the whole
  session state: turning `read` off does not silently pin `bash`'s default too.
- The two switches may legitimately disagree: **the session switch outranks the
  workspace one**. A `workspace` write changes the project default only and
  never removes this conversation's own choice; the new default shows up here
  immediately only when this conversation has no choice for that entry. The
  `session` switch shows what this conversation actually runs with, the
  `workspace` switch shows the project default.
- A dot has three looks: **bright blue ring + centre dot** = this conversation
  turned the entry on itself, **bright blue ring, hollow** = it turned it off
  itself, **dim blue ring** = nothing was chosen here and the entry follows the
  project (its centre then matches the violet workspace dot). A right-click or an
  Alt+click on the blue dot unpins it back to following; a plain click pins it
  again with the opposite state.
- The workspace record is keyed by the project directory; a session record is
  keyed by session id and remembers the `cwd` it was made in, so a conversation
  that moves to another directory does not carry its old overrides along. A
  session without a working directory can only use the `session` switch.
- Archiving a conversation **drops its record at once**: DSH exposes no
  "session deleted" event, and archiving is the one "this conversation is
  finished" signal it does give (the `archivedSessionIds` of the workspace
  domain's root record, delivered as a `domain/changed` event). Archiving is
  reversible, so a restored conversation starts from the workspace defaults of
  that moment instead of reviving retired choices.
- Records of conversations that were never archived are pruned on every write
  — older than 180 days, or beyond 1000 records, oldest first.
- Both tables live in the `context_control` domain (with the JSON backend that
  is `$DSH_HOME/storages/context_control.json`, tables `projects` and
  `sessions`): deleting that file clears the workspace defaults and every
  session choice at once.

### Which skill roots are gated

DSH skills are layered: `bundled` skills shipped with DSH and host-registered
`runtime` skills live in the global layer, everything else comes from the
filesystem provider mounted inside the agent preset. This plugin reads the
catalog from **the current session's agent**, so skills in every root below
show up in the panel and can be toggled (off by default):

| Root | `source` |
|---|---|
| DSH's bundled skill directory | `bundled` (on by default) |
| `<project>/.dsh/skills` | `project-dsh` |
| `<project>/.agents/skills` | `project-agents` |
| `$DSH_HOME/skills` (default `~/.dsh/skills`) | `user-dsh` |
| `~/.agents/skills` | `user-agents` |
| `customSkillDirs` from the preset | `custom` |

The `user-dsh` root follows `$DSH_HOME` and only defaults to `~/.dsh`; the
`~/.agents` root is shared agent configuration and does not move with it.

If a skill is in the model's catalog but not in the panel, check that it lives
in one of those roots, then look for `skill discovery failed` in the host log.

### Which tools are gated

The panel lists each **gateable built-in tool** as its own row, alongside MCP
servers and skills — with two radio dots per row (blue = session, violet = workspace, see
above). The three kinds (MCP / skills / tools) are switched with
tabs instead of stacking three groups; each tab shows its own `on/total`, and
the pill sums the three: `Components 3/5`. Every row also carries a one-line
description taken from the resource itself: tools use their schema
`description`, skills use the catalog description, and an MCP server uses its
`instructions` prose (read from the text provider registered as the `mcp:<server>` system-prompt section, so it is available before the host has assembled a single prompt; a server that publishes none shows its tool count). Hover
for the full description plus origin, and screen readers get the same text
through `aria-description`.

- A disabled tool leaves the model's view through the same `tools.restrict`
  call that hides MCP tools, and its `tool:<name>` guidance section is dropped
  during `system-prompt/assemble`; restricting alone is not enough because that
  text is not part of the schema.
- Built-in tools start **on**, so upgrading does not change existing behaviour.
  Use `defaultOffTools` (below) to opt specific tools out by default.
- `run_code`, `context_control` and `structured_output` are protected: they are
  never listed and cannot be turned off — `context_control` is the entry point
  that opens the gate, and hiding it would lock the gate from the inside.
- MCP tools are not listed individually (they follow their server switch), and
  `list_mcp_resources` and friends follow the server switch too.
- The footer row reads left to right as version, status text (`checking…`,
  `up to date`), then the check button — all flush left — with the `?` alone at the
  far right. The usage note is collapsed behind that `?` and only takes room when
  opened. The check button switches to a spinning “checking” state immediately, so an
  answer the host serves from its cache in milliseconds does not look like a click
  that did nothing.
- A row's second line is never empty: it shows the resource's description when it
  publishes one, and the entry's own detail otherwise (tool count for an MCP server,
  origin for a skill). An MCP server can only be described from the `instructions` it returns from `initialize` (the `### MCP server: <name>` heading that `dsh-mcp-client` prepends is stripped) — `chrome-devtools-mcp` has none, so its row shows the
  tool count.

In `$DSH_HOME/profiles/web/cordis.patch.yml` (default
`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: context-control
  name: dsh-context-control
  config:
    defaultOn: [hivemem]
    defaultOffTools: []       # e.g. [bash]; built-in tools are on by default
    update:
      manifestUrl: https://<host>/dsh-context-control/channel.json
      # github: zp96324511/dsh-context-control
      # registry: https://registry.npmmirror.com/
      # packageName: dsh-context-control
      # checkIntervalMs: 21600000
      # upgradeTimeoutMs: 900000
      # launcher: <path to the dsh entry point, discovered by default>
      # runtimeVersion: 0.2.1-rc.2   # used for the engines.dsh check when discovery fails
```

A `link:` / `file:` install is **not** upgraded in place (that would overwrite the checkout); the panel says "Updates unavailable" unless `manifestUrl`, `github` or `registry` is configured explicitly.

## Rollback and troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Check failed` / `cannot tell which channel` | The channel is unreachable, or the install came from a git spec. Configure `update.manifestUrl`. |
| `Updates unavailable` | `link:` / `file:` install. Publish and install a tarball URL, or configure a channel. |
| Upgraded but the version did not change | Read pnpm's output under `[Details]`; `minimumReleaseAge` defers a fresh release. |
| The row still says to restart | The host still runs the old code: restart `dsh web` **the way you started it**. The plugin deliberately does not do it — a guessed command line could miss your `--profile`, `--port` or environment. |
| Pin an older version | `dsh plugin --profile web add http://<host>/…/dsh-context-control-0.3.5.tgz` — `channel.json` keeps old versions for this. |
| Back to a local checkout | `dsh plugin --profile web add link:C:/path/to/dsh-context-control`, then recreate the `node_modules` junction (below). |

## Local development

The workspace root is the package root and the profile links to it. A `link:` install resolves to the real path and leaves DSH's `@deepseek-ai/*` resolution route, so the checkout needs a junction into the DSH installation:

```pwsh
mklink /J "C:\path\to\dsh-context-control\node_modules" "C:\Users\<you>\AppData\Local\Author Software\nvm\installs\v26.10.0\node_modules\@deepseek-ai\dsh\node_modules"
```

(Recreate it after `nvm use` switches Node.)

```pwsh
npm run check        # manifest guard + node --check + 25 update tests + 9 host gating tests + 46 client regression tests
npm test             # the two test suites only
```

The client suite is offline: `test/client-harness.cjs` ships a mini React runtime, a stub gateway and a fake DOM, and drives the panel (including the two scope switches per row and their independent states), keyboard navigation, multi-pane isolation and every phase of the update button (current → unavailable → available → upgrading → restart hint).
