# Baby Name Matcher

A self-hosted app for two people choosing a baby name. Swipe through 2,849 male and gender-neutral names, keep individual choices private in the app, and discover mutual likes and a shared shortlist. Install it as a PWA to keep choosing names while your server is offline.

Run it on Windows, macOS, or Linux with Docker or Node.js. **Tailscale is optional.** There are no external accounts, analytics, ads, or runtime name API calls.

## Quick start with Docker

Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows/macOS) or Docker Engine with the Compose plugin (Linux), and start Docker. Windows Docker Desktop must use Linux containers.

```sh
git clone https://github.com/Pbdekeijzer/BabyNameMatcher.git
cd BabyNameMatcher
mkdir runtime
docker compose up -d --build
```

Open **http://localhost:3000** on that computer. No environment file or credentials are needed to start. Compose binds to loopback by default. Data persists in `runtime/` outside the container.

On Linux, the mounted `runtime` directory must be writable by UID 1000. If your user has another UID, run `sudo chown 1000:1000 runtime` after creating the directory and before starting Compose. Windows/macOS Docker Desktop manages bind-mount access.

```sh
docker compose logs --tail=50 app
docker compose stop
docker compose start
```

To change settings, copy `.env.example` to `.env`, edit it, and run `docker compose up -d` again. Use `cp .env.example .env` on macOS/Linux or `Copy-Item .env.example .env` in PowerShell. Environment files and runtime data are excluded from Git and the Docker build context.

## Run with Node.js

Install **Node.js 24.x** and npm 11.x, then run these commands from the repository root:

```sh
npm ci --ignore-scripts
npm rebuild esbuild
npm run build
npm start
```

Open **http://localhost:3000**. The server reads an optional root `.env` file. It defaults to loopback, HTTP cookies for localhost, and the root `runtime/` directory. Shell environment variables take precedence over `.env`.

Installation scripts are initially disabled; the rebuild runs the reviewed esbuild installation step. SQLite uses bundled native binaries for supported platforms. If SQLite cannot load, check your Node version and architecture; Docker provides a consistent Linux environment.

For development, run `npm run dev`. This builds the shared package, then starts the API on port 3000 and Vite at **http://127.0.0.1:5173**. Vite proxies `/api` to port 3000. Use the root commands so database and build paths stay consistent. If you change the API port, update the Vite proxy target in `apps/web/vite.config.ts`. Stop with Ctrl+C.

## Create a room and use the app

1. Open the app and choose **Create our room**. Enter a display name.
2. Save the room code and your personal recovery code somewhere private. Recovery codes are shown once.
3. Send your partner the invitation link and six-digit PIN privately. They open it, join the room, and save their own recovery code. Each room has exactly two seats.
4. Like or pass on names, undo your last decision, or change choices in History. You each have a stable personal catalogue order. Matches appear after you both like a name and synchronize.
5. Add your own names, and add mutual matches to the shared shortlist.

Use **separate devices or separate browser profiles** for the participants. Tabs in one browser profile share a session and offline storage. Incognito is useful for a quick test, but closing it can discard unsynchronized choices.

To move devices or recover an expired session, use your room code and personal recovery code. Recovery invalidates the previous session for that participant. Synchronize the old device first if possible; recovery cannot restore choices that never left it. Keep the same server address to retain access to the same browser storage.

## Use phones or another computer

`localhost` refers to the device opening the page. A phone needs a shared address for the server. Use an **HTTPS reverse proxy with a valid certificate**, on your network or through a private VPN/tunnel. Away from localhost, HTTPS is needed for service workers, installation, offline caching, and APIs such as `crypto.randomUUID()`. Plain HTTP to a LAN IP is not a supported phone setup.

Serve the frontend and API at one origin, at the domain root (`/`). GitHub Pages cannot run this application: it needs the Node server, SQLite, and persistent storage. Publish the source on GitHub and run it on your own machine or host with a persistent disk.

### Any HTTPS reverse proxy

Use Caddy, nginx, an existing reverse proxy, or an HTTPS tunnel. For example, run Caddy on the same host with this Caddyfile, substituting your own domain:

```caddyfile
names.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Set these values in root `.env`, then recreate the container or restart Node:

```dotenv
COOKIE_SECURE=true
PUBLIC_ORIGIN=https://names.example.com
```

`PUBLIC_ORIGIN` must match the browser origin exactly, including a nonstandard port if used, without a path or trailing slash. Configure DNS, certificates, and firewall for your chosen proxy. Forward `/api/events` without buffering; it uses server-sent events. Leave the backend on loopback for a host proxy.

Forwarded headers are ignored by default to prevent forged IPs bypassing rate limits. To distinguish multiple users behind a trusted proxy, set `TRUST_PROXY` to **only that proxy's connecting IP or CIDR**. For native Node with a host proxy this may be `loopback`; a Docker backend may see a Docker gateway IP instead. Your proxy must replace untrusted forwarded headers, and clients must not connect directly as a trusted proxy. With proxy trust disabled, users behind a proxy share authentication rate limits.

For a proxy in another container or machine, adjust its upstream and the backend bind address/network. Do not expose an HTTP backend directly to the internet. Anyone who can reach this app can create a room; restrict access at your VPN/proxy for an invitation-only server. Run one server process per SQLite database: rate limits and event notifications are process-local.

### Optional: Windows with Tailscale

Install Tailscale on the host and both phones, connect them to the same tailnet, and enable MagicDNS and HTTPS certificates. With Docker Desktop running:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-host.ps1
```

The script builds the app, enables Secure cookies, checks health, and runs persistent `tailscale serve --bg 3000`. It displays your private HTTPS address and does not enable Funnel. The first Serve command may guide you through HTTPS setup. Open the same HTTPS address on both phones. Use `-Port 3100` to choose another port.

Docker uses `restart: unless-stopped`, and Serve uses background mode. After a Windows restart, sign in so Docker Desktop starts. If you later run Compose manually, keep `COOKIE_SECURE=true` in `.env`. To stop the private proxy, run `tailscale serve reset`.

## Installation and offline use

Open online once, then use **Install app** / **Add to Home Screen**, or the Settings install button when offered. Installation/background sync vary by browser; Chrome/Edge are covered by the browser test.

Choices are saved in IndexedDB before the screen updates. After the first successful cache, the installed app can reopen with its catalogue, history, and last synchronized matches while the server is off. New matches require both participants to synchronize.

Sync retries on launch, focus, reconnect, every 15 seconds while open, and through browser background sync when available. **Do not clear storage, uninstall, or switch addresses while changes are waiting.** Background sync is best effort; reopen online to confirm everything is saved.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Native server port; published host port in Compose. |
| `HOST` | `127.0.0.1` | Native listen address. Compose uses `0.0.0.0` inside the container. |
| `BIND_ADDRESS` | `127.0.0.1` | Compose's published host address. Change only for a deliberate proxy/network setup. |
| `RUNTIME_DIR` | `./runtime` | Native data directory. Compose mounts host `./runtime` at `/app/runtime`. |
| `WEB_DIST` | `./apps/web/dist` | Native built frontend directory. |
| `COOKIE_SECURE` | `false` locally | Set `true` for HTTPS. Native `NODE_ENV=production` and the standalone Docker image default to `true`; Compose explicitly defaults to localhost HTTP. |
| `PUBLIC_ORIGIN` | unset | Exact external browser origin for proxy hosting. |
| `TRUST_PROXY` | unset | Trusted proxy IP/CIDR or `loopback`. Unset/`false` ignores forwarding; blanket `true` is rejected. |
| `LOG_LEVEL` | `info` | Server log level; `silent` disables logs. |

Changing `COOKIE_SECURE` changes the cookie name; recover your session after switching HTTP/HTTPS. Relative native paths resolve from the repository root with the root npm scripts.

## Backups and restore

The live database is `runtime/baby-name-matcher.sqlite`. The server backs up on startup if due, then checks hourly and creates a backup once the previous one is 24 hours old. It retains the newest **14 scheduled backups** under `runtime/backups/`. These contain every room on the server.

The room creator can download a **room-only** SQLite backup from Settings. **Backups include both partners' individual votes and credential hashes.** App-level vote privacy does not protect against the creator inspecting a backup or the operator reading the database. Keep databases, backups, invitations, PINs, and recovery codes private. Backups are not encrypted by the app; store important copies securely on another device.

To restore a server backup, or a room download into a dedicated fresh instance:

1. Synchronize devices if possible, then stop the server (`docker compose stop` or stop Node).
2. Move the existing `runtime` directory to a dated private archive outside the repository and create an empty `runtime` directory. Archiving the whole directory keeps the database and its `-wal`/`-shm` files together; never combine old sidecars with a restored database.
3. Copy your backup to `runtime/baby-name-matcher.sqlite`. On Linux Docker hosts, ensure UID 1000 (the container's `node` user) can write the directory.
4. Run `docker compose start` or `npm start`, check `/api/health`, and recover sessions if needed.

A room download replaces the destination database; it does not merge rooms. Changes after the backup are not guaranteed recoverable. Keep archives and restored data out of Git.

## Updating

Synchronize both devices and save a separate backup. Run `git pull`, then `docker compose up -d --build`. For Node, stop the server and repeat the install/build/start commands. Database migrations run at startup; built-in name IDs stay stable. Open each device online and accept an offered app update after pending changes synchronize.

## Tests and development checks

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
npm audit
```

Build before the browser test. It needs Chrome, Edge, or Chromium; set `BROWSER_PATH` for a nonstandard executable location. It uses isolated browser profiles/databases under ignored `runtime/`, starts/stops its own server on port 3010, and verifies two-person matching plus a real 1,000-choice offline/reload/reconnect cycle. `SMOKE_BASE_URL` targets a dedicated disposable test deployment; never use a personal instance because tests create rooms and votes.

CI checks types, tests, production builds, browser behavior, dependency advisories, Docker health, and source secrets. The patched build dependency in `vendor/deepmerge` fixes an advisory without an upstream patch. Its provenance, license, tests, and removal criteria are documented there.

## Troubleshooting

- **Cannot connect to Docker:** start Docker Desktop/the daemon and check `docker info`.
- **Port in use:** change `PORT` in `.env` and use the new address.
- **Healthy API but no web app:** run `npm run build` before native `npm start`.
- **Repeated recovery requests after login:** match `COOKIE_SECURE` to HTTP/HTTPS and use one consistent address.
- **403:** match `PUBLIC_ORIGIN` to the browser scheme, host, and port. Development must not use a production origin.
- **429:** wait for the retry window; configure trusted proxy IPs if proxy users share one rate limit.
- **Phone install/offline features fail:** use HTTPS with a trusted certificate and open online once.
- **Linux Docker `runtime` permission denied:** make the directory writable by UID 1000; for a new directory, use `sudo chown 1000:1000 runtime`. Avoid world-writable permissions.

## Catalogue and licenses

The catalogue contains **2,699 male and 150 gender-neutral names**, combining reviewed regional and historical lists from Western Europe, North America, Australia, and New Zealand. Spelling/accent variants remain separate. Custom names are supported; the bundled list does not cover every gender or language.

Running/building uses the checked-in catalogue. Maintainers can regenerate it with `npm run catalogue:generate`. Optional `catalogue:refresh-netherlands` and `catalogue:refresh-western-europe` commands download official source data; review their output before committing.

Application code is [MIT licensed](LICENSE). Catalogue data and third-party code retain their own terms and attribution; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `packages/shared/src/catalogue.json`.
