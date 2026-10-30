# Public release review — 2026-10-30

Scope: server routes and authorization, SQLite persistence and backups, offline
client/sync, configuration, dependencies, source packaging, installation, and CI.
An independent review checked the privacy/recovery paths and the fixes.

## Findings resolved

- Room creators could download the whole server database. Downloads are now
  scoped to their room, cascade-remove other rooms, and vacuum discarded pages.
  Temporary exports are removed after sending; export access remains creator-only.
- Arbitrary forwarded IP/host headers were trusted. Default proxy trust is now
  disabled, with an explicit proxy IP/CIDR setting. Origin checks validate the
  complete origin and reject malformed/opaque origins.
- Framework 400/413/429 errors were incorrectly returned as 500. HTTP status codes
  are preserved, internal errors remain generic, and API responses use no-store.
- Backup downloads sent an empty body marked as JSON. The client now sends a
  bodyless POST without the JSON content type.
- Fresh-browser recovery restarted sequence numbers, silently losing subsequent
  vote edits. Bootstrap now includes the participant's server sequence floor,
  including tombstones; local counters never move backwards.
- Stale tabs could queue/upload choices under a different participant. New clients
  validate the stored participant before enqueueing and bind sync to that identity.
  Legacy sync requests remain accepted for existing installed clients.
- Malformed invitation fragments could crash onboarding. They now fall back to
  ordinary onboarding.
- Open event streams could prevent graceful server shutdown. Streams close before
  the server stops, and subscriptions follow response lifetimes.
- npm commands resolved data/build paths relative to the server workspace. Root
  commands and workspace shortcuts now run the server from the repository root
  and load its optional .env file.
- Dependency audit findings were resolved through compatible updates, a Vitest 5
  upgrade, and a small local deepmerge security patch. Upstream has no patched
  version for that advisory; provenance/license and regression tests are included.
- Docker/local defaults and documentation assumed Tailscale/HTTPS. Loopback HTTP
  is supported directly; HTTPS proxy and optional Tailscale setups are documented.

## Verification

- 53 unit/integration tests pass, including new security, recovery, offline-store,
  backup integrity/retention, participant isolation, and shutdown regressions.
- Type checks, production builds, and the isolated Chrome/Edge browser smoke test
  pass. The browser checks matching, custom names, history search, malformed invites,
  and a 1,000-rating offline/reload/reconnect cycle.
- A fresh clone passed dependency installation, type checks, tests, and build.
- npm audit reports zero known advisories in the full dependency graph and runtime
  dependencies. This is a point-in-time result, not a guarantee of vulnerability-free code.
- Gitleaks 8.30.1 reports no detected secrets in the staged public source and new
  Git history. The original folder had no Git metadata/history to inspect.
- Local runtime databases, backups, browser profiles, environment files, build
  output, dependencies, and key files are excluded from publication. The runtime
  directory contains private local artifacts and must remain private.
- CI runs on Linux and Windows and includes a Docker build/health check,
  dependency auditing, and full-history secret scanning.

## Deployment and privacy boundaries

This is a small self-hosted application, not a public multi-tenant service. Anyone
who can reach it can create a room. Run one process per database and protect the
entry point with HTTPS and any desired VPN/proxy access policy. Each participant
should use a separate browser profile/device.

Votes are private through normal app views. The server operator can inspect the
database; a room creator's database download includes both partners' votes.
Backups are not encrypted by this app. Browser storage can be lost if cleared, and
unsynchronized choices cannot be recovered from server backups. Recovery revokes
the previous session. These limitations are described in the README and backup UI.
