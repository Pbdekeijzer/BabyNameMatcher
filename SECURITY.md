# Security

This application is intended for small self-hosted deployments. Use HTTPS for
remote access and restrict access through a VPN or reverse proxy when appropriate.
Anyone who can reach the application can create a room.

To report a vulnerability privately, use this repository's **Security → Report a
vulnerability** option when available. Do not post credentials, recovery codes,
database files, or details of an unpatched exploit in a public issue. If private
reporting is unavailable, open an issue asking for a private reporting channel
without disclosing exploit details.

The latest `main` branch receives security fixes. Dependency updates and CI audit
checks help identify known advisories; they do not guarantee the absence of bugs.

The root npm overrides keep Workbox's build-time `glob` dependency on the patched
14.x line (including minimatch 11) for GHSA-3g3m-2fjr-6pw4 and
GHSA-g3hv-75wg-m249. Workbox 7.4.1 still requests glob 11. Review this override
when Workbox adopts a patched version upstream; verify the production PWA build
and offline browser smoke test before removing it. Keep Docker on Node 24 to
match the package engine constraint and CI; a runtime major upgrade needs a
coordinated change to those constraints, native SQLite support, and documentation.

Database files and backups contain both participants' individual votes and
credential hashes. The server operator can access them; room creators can download
their own room's database. See the README for deployment, proxy trust, recovery,
and backup limitations.
