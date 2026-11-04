# dsh-context-control

Session-scoped visibility gating for MCP servers and skills in the DeepSeek Harness web profile: new sessions start lean (official entries on, user-configured ones off) and the model or the composer panel turns entries on for that session; the choice is remembered per project. The plugin also **carries its own update channel**: it can tell you it is behind, upgrade itself in one click, and bring the host back.

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

Restart `dsh web` once after installing; upgrades after that are handled by the plugin itself.

> To pin a specific version, install the tagged asset
> (`.../releases/download/v0.4.3/dsh-context-control.tgz`). Re-installing the *same*
> `releases/latest/download/...` URL is a pnpm no-op — the spec did not change. The
> in-panel upgrade is unaffected: it always installs the tag named by `channel.json`.

## Upgrade

### Where

Open the "Context" pill left of any composer: the popover's footer shows the installed version and one button that does whatever the current phase needs.

- idle: `v0.4.0 · up to date · [Check for updates]`
- behind: an `↑` badge on the pill, `v0.4.0 → v0.4.1 · [Upgrade]`
- running: `[Upgrading…]` plus `[Details]` with pnpm's live output
- finished: `[Restart]` (the host does not use HMR) or `[Reload]` (the new code is already live)

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
4. **Restart**: the host exits, a detached helper waits for the old process to die and its port to be released, then starts the same command line again (`respawn.cjs`). Without systemd, pm2 or a Windows service, that is the difference between "one click" and a dead GUI.

With HMR the restart can be unnecessary: the plugin compares the version its module was loaded from with the version on disk and asks for a restart only when the code really changed; otherwise it offers a page reload.

### The outcome survives a reload

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
| `~/.dsh/skills` | `user-dsh` |
| `~/.agents/skills` | `user-agents` |
| `customSkillDirs` from the preset | `custom` |

If a skill is in the model's catalog but not in the panel, check that it lives
in one of those roots, then look for `skill discovery failed` in the host log.

In `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: context-control
  name: dsh-context-control
  config:
    defaultOn: [hivemem]
    update:
      manifestUrl: https://<host>/dsh-context-control/channel.json
      # github: zp96324511/dsh-context-control
      # registry: https://registry.npmmirror.com/
      # packageName: dsh-context-control
      # checkIntervalMs: 21600000
      # upgradeTimeoutMs: 900000
      # launcher: <path to the dsh entry point, discovered by default>
      # runtimeVersion: 0.2.1-rc.2   # used for the engines.dsh check when discovery fails
      restart:
        mode: respawn      # respawn | exit (a supervisor restarts) | none
        port: 10550        # defaults to the --port on the command line
        logFile: C:\Users\you\.dsh\logs\dsh-web-respawn.log
```

A `link:` / `file:` install is **not** upgraded in place (that would overwrite the checkout); the panel says "Updates unavailable" unless `manifestUrl`, `github` or `registry` is configured explicitly.

## Rollback and troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Check failed` / `cannot tell which channel` | The channel is unreachable, or the install came from a git spec. Configure `update.manifestUrl`. |
| `Updates unavailable` | `link:` / `file:` install. Publish and install a tarball URL, or configure a channel. |
| Upgraded but the version did not change | Read pnpm's output under `[Details]`; `minimumReleaseAge` defers a fresh release. |
| The host did not come back | Check `restart.logFile`; use `restart.mode: exit` with your own supervisor. |
| Pin an older version | `dsh plugin --profile web add http://<host>/…/dsh-context-control-0.3.5.tgz` — `channel.json` keeps old versions for this. |
| Back to a local checkout | `dsh plugin --profile web add link:C:/path/to/dsh-context-control`, then recreate the `node_modules` junction (below). |

## Local development

The workspace root is the package root and the profile links to it. A `link:` install resolves to the real path and leaves DSH's `@deepseek-ai/*` resolution route, so the checkout needs a junction into the DSH installation:

```pwsh
mklink /J "C:\path\to\dsh-context-control\node_modules" "C:\Users\<you>\AppData\Local\Author Software\nvm\installs\v26.10.0\node_modules\@deepseek-ai\dsh\node_modules"
```

(Recreate it after `nvm use` switches Node.)

```pwsh
npm run check        # manifest guard + node --check + 20 host tests + 28 client regression tests
npm test             # the two test suites only
```

The client suite is offline: `test/client-harness.cjs` ships a mini React runtime, a stub gateway and a fake DOM, and drives the panel, keyboard navigation, multi-pane isolation and every phase of the update button (current → unavailable → available → upgrading → restart → waiting for the host).
