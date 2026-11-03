# Changelog

Releases are cut from tags (`v*`), and the publish workflow attaches a
version-free copy of the tarball plus a `channel.json` to every release — which
is what an installed copy reads to discover the next version.

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

