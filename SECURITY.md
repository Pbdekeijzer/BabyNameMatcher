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

Database files and backups contain both participants' individual votes and
credential hashes. The server operator can access them; room creators can download
their own room's database. See the README for deployment, proxy trust, recovery,
and backup limitations.
