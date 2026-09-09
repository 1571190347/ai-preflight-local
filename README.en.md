# AI Preflight · Local

**v0.3.0 · Runs on your computer · Chinese interface · MIT licensed**　[中文](README.md)

Check public IPs, routing differences, Claude / ChatGPT connectivity, IP profiles, DNS, WebRTC, and browser capabilities from your own computer. The interface and backend run locally. External checks start disabled and require a deliberate click after you enable them.

Results are observations with sources, useful for questions such as “Why does my browser work while the backend fails?” The app cannot read platform trust scores, account status, or suspension probabilities. Missing data stays unknown.

## Install and start with one command

**macOS / Linux**, in a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/1571190347/ai-preflight-local/main/install.sh | sh
```

**Windows**, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/1571190347/ai-preflight-local/main/install.ps1 | iex
```

The installer downloads the latest stable Release asset and verifies its SHA256. It reuses Node.js 22.13+ if available; otherwise it downloads an official Node.js 24 runtime, verifies its checksum, and keeps it inside the application's private directory. **No preinstalled Node.js, pnpm, or administrator privileges are required.** It starts the local service and tries to open your browser. You can also open [http://127.0.0.1:4173](http://127.0.0.1:4173).

Installation needs GitHub access; downloading a runtime also needs `nodejs.org`. The Unix installer uses standard tools including `curl` and `tar`, and supports x64 / ARM64 on macOS and Linux. Its Linux runtime requires compatible glibc; Alpine/musl is outside this installer's support. The Windows script targets PowerShell 5.1 / 7 and x64 / ARM64. See the [validation record](docs/VALIDATION.md) for actual platform testing.

You can inspect [install.sh](install.sh) or [install.ps1](install.ps1) and save the script before running it. Installers consume [Release assets](https://github.com/1571190347/ai-preflight-local/releases), which include the built interface.

### Start, stop, and update

macOS / Linux:

```sh
~/.local/share/ai-preflight-local/bin/ai-preflight start
~/.local/share/ai-preflight-local/bin/ai-preflight status
~/.local/share/ai-preflight-local/bin/ai-preflight open
~/.local/share/ai-preflight-local/bin/ai-preflight stop
```

Windows PowerShell:

```powershell
& "$env:LOCALAPPDATA\AI-Preflight-Local\bin\ai-preflight.cmd" start
& "$env:LOCALAPPDATA\AI-Preflight-Local\bin\ai-preflight.cmd" status
& "$env:LOCALAPPDATA\AI-Preflight-Local\bin\ai-preflight.cmd" open
& "$env:LOCALAPPDATA\AI-Preflight-Local\bin\ai-preflight.cmd" stop
```

`start` runs the service in the background and reuses an existing instance. `open` opens the running service. Run the installer again to update: it stops the old instance and preserves `config/.env` and `config/config.local.json`. The installer does not change your shell PATH, so use the full commands above.

| Environment variable | Effect |
| --- | --- |
| `PREFLIGHT_INSTALL_DIR` | Absolute installation directory; defaults to `~/.local/share/ai-preflight-local` on macOS / Linux or `%LOCALAPPDATA%\AI-Preflight-Local` on Windows |
| `PREFLIGHT_VERSION` | Stable release tag, such as `v0.3.0`; otherwise uses the latest Release |
| `PREFLIGHT_NO_START=1` | Install without starting |
| `PREFLIGHT_NO_OPEN=1` | Start without opening the browser |

Set these before running the relevant installer or launcher. In the Unix pipeline, place `PREFLIGHT_VERSION=v0.3.0` immediately before the final `sh`; in PowerShell, first run `$env:PREFLIGHT_VERSION = 'v0.3.0'`.

### Run a Release asset manually

Download `ai-preflight-local-v0.3.0.zip` or `.tar.gz` from [Releases](https://github.com/1571190347/ai-preflight-local/releases), check it against that release's `SHA256SUMS`, and extract it. This method requires your own Node.js 22.13+. From the extracted project directory:

```sh
node --env-file-if-exists=.env server/index.mjs
```

Stop with `Ctrl+C`. This method uses `.env` and `config.local.json` in the project root. **GitHub's “Code → Download ZIP” and automatic “Source code” archives require a build first.** Do not open `dist/index.html` directly: the interface needs its same-origin local API.

## Features

| Module | Available observations and operations |
| --- | --- |
| Overview / backend connection | Local browser checks; explicitly test Cloudflare HTTPS, ipwho.is, and IANA RDAP, with per-source DNS provenance, HTTP result, duration, or failure reason |
| IP and routing | Select sources and compare browser / backend IPv4, IPv6, HTTP exits, countries, and trace fields; IP masking is on by default |
| Claude | Its own exit and website-response results, with official region and login troubleshooting links |
| ChatGPT / Codex | Its own ChatGPT exit and website / OpenAI API response results; no access to login credentials or model permissions |
| IP profiles | Query a public IP using selected ipapi.is, ipwho.is, AbuseIPDB, or Shodan InternetDB sources; view geography, ASN, organization, provider flags, and historical records separately |
| Connectivity | Three browser HTTP rounds per selected site and a median; opaque responses explicitly have unreadable HTTP status |
| DNS | System DNS and network interfaces of the Node host; optional authoritative DNS collector with 3 / 10 random-name probes and resolver observations |
| WebRTC | Browser-visible ICE candidates from multiple STUN servers, compared with HTTP exits |
| Ping | Local ICMP, public Globalping with up to 20 probes per measurement, or your own remote agents |
| Service status | 31 built-in sources, categories and incidents; incompatible feeds retain their official links |
| WHOIS / RDAP | Domain, public IP, and ASN registration queries; TCP 43 WHOIS fallback and searchable RDAP suffixes |
| Device / fingerprint | Browser language, timezone, capabilities, WebGL / Canvas checks, and a local fingerprint demonstration |
| Local history | Optional redacted summaries in the current browser, with viewing and deletion; no automatic saving |
| AI news | Manually load configured RSS / Atom feeds, filter, paginate, and open originals |
| IP cards | 22 themes, 8 patterns × 8 stamps, and local SVG / PNG export; downloaded cards always mask IPs |
| Data and settings | Request destinations, data boundaries, and optional-service configuration status |

Claude and ChatGPT keep separate results. Region guidance only uses observations from the relevant platform; shared Cloudflare results do not stand in for a platform's country. Custom sources can declare `platform: "claude"`, `"gpt"`, or `"shared"`.

See [feature coverage](docs/FEATURE-COVERAGE.md) for prerequisites, provider notes, and excluded capabilities. The application interface and detailed reference documents are currently in Chinese.

## First use

1. Run the local basics from the overview to check the page and API.
2. Read the destinations, enable external checks, and click “检查后台连接” to test backend access.
3. Select IP sources and compare browser / backend exits, then run the relevant Claude or ChatGPT checks.
4. Use profiles, DNS, WebRTC, or Ping as needed. Keep error details and unknown results distinct from account conclusions.

## DNS and proxy behavior

`DNS_MODE` controls public-target resolution by the local backend. It does not change operating-system, browser, or proxy settings. The system DNS / interface inspection continues to report the system's own view.

| Mode | Behavior |
| --- | --- |
| `auto` — default | Try system DNS first. Fall back to fixed Cloudflare DoH only when answers include `198.18.0.0/15` Fake-IP addresses and no other non-public addresses. Ordinary private answers, mixed private answers, DNS errors, and timeouts do not trigger fallback |
| `system` | Use system DNS only; reject Fake-IP and other non-public answers without contacting DoH |
| `doh` | Resolve permitted public domains directly through the fixed DoH service; still reject private / reserved IPs, special local names, and invalid answers |

DoH uses `https://1.1.1.1/dns-query`, connects directly to `1.1.1.1`, and validates TLS. Cloudflare receives the queried domain and can observe the backend network exit; provider API credentials are not sent to the resolver. Validated public A / AAAA answers are pinned for the connection, and redirected targets are checked again. DoH failures remain failures and do not disable private-network restrictions.

Browser extensions, system proxies, TUN routing, and split routing can produce different exits. Backend HTTPS uses a direct connection to validated addresses; it does not inherit browser proxy settings or use a general proxy agent to resolve the name elsewhere. System TUN routing can still affect that connection. Backend success does not establish browser or platform access.

## Optional configuration

For installer-managed copies, edit **`config/.env`** and **`config/config.local.json`** inside the installation directory. For manually run source / Release copies, use the project root instead, starting from [.env.example](.env.example) and [config.example.json](config.example.json). Stop and restart after changes.

| Variable | Purpose |
| --- | --- |
| `PORT` | Production port, default `4173` |
| `BIND_ADDRESS` | Default `127.0.0.1`; keep loopback binding for personal use |
| `CONFIG_FILE` | Optional JSON file; relative paths resolve from the service working directory |
| `DNS_MODE` | `auto`, `system`, or `doh`; defaults to `auto` |
| `IPAPI_KEY` | Optional ipapi.is key for fuller profile fields |
| `ABUSEIPDB_KEY` | AbuseIPDB lookup key; this application does not submit reports |
| `GLOBALPING_TOKEN` | Optional account token; measurements must still be treated as public |
| `DNS_COLLECTOR_URL` | Standard HTTPS base URL of your collector's management API |
| `DNS_COLLECTOR_TOKEN` | Collector token read only by the backend |

Keep keys in private local configuration. Do not use `VITE_` variables or put keys in URLs / frontend code. Anonymous IP responses may omit VPN, proxy, and other security fields; missing fields are unknown.

The JSON configuration supports `exitSources`, `connectionSources`, `statusSources`, `stunServers`, `newsFeeds`, and `pingNodes`. **Each supplied list replaces its default; omitted lists retain defaults.** Lists have a maximum of 64 entries and source IDs must be unique. External URLs require standard HTTPS without credentials or secret-like query parameters. Loading configuration alone sends no external requests.

For example, configure only your remote Ping agent:

```json
{
  "pingNodes": [
    {
      "id": "my-node",
      "name": "My node",
      "url": "https://ping.example.com",
      "tokenEnv": "PING_NODE_MY_TOKEN"
    }
  ]
}
```

Replace the domain and set `PING_NODE_MY_TOKEN` in `.env` to the agent's token. Do not append `/ping`. STUN entries accept `stun:host:port` / `stuns:host:port`; actual transport support depends on the browser.

## Optional services and Docker

- [DNS collector](services/dns-collector/README.md): independent authoritative DNS and an HTTPS management API; requires your own domain delegation and public server.
- [Ping agent](services/ping-agent/README.md): fixed-count ICMP on a machine you control; requires system `ping` and a protected HTTPS API.

Both include source, tests, and Docker configuration. Deploy them separately; other app modules work without them.

The main application also includes a Dockerfile and Compose configuration. With Docker and Compose 2.24+:

```sh
docker compose up --build -d
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173); stop with `docker compose down`. Building requires image and dependency downloads. Put custom JSON in `config/config.local.json`; see the [configuration directory notes](config/README.md). Container networking is a separate observation point. Included deployment files do not establish that Docker has been tested on your system.

## Development and release builds

Use Node.js 22.13+ and **pnpm 11.19.0**:

```sh
git clone https://github.com/1571190347/ai-preflight-local.git
cd ai-preflight-local
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm dev
```

The development page is [http://127.0.0.1:5173](http://127.0.0.1:5173), with an API on `4174` proxied by Vite. `Ctrl+C` stops both.

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm test:services
pnpm release
```

Build `dist/` before the main tests. On macOS / Linux, also run `DNS_COLLECTOR_INTEGRATION=1 node --test services/dns-collector/test/*.test.mjs` for real loopback HTTP / UDP / TCP tests.

`pnpm release` writes ZIP, tar.gz, and `SHA256SUMS` to `release/`, including source and built UI while excluding private configuration, dependencies, and runtime data. GitHub Actions is configured to check Linux, macOS, and Windows on Node 22 / 24. Only Ubuntu / Node 24 uploads release build artifacts; **CI does not publish a Release automatically**. A workflow definition is not evidence that its runs have passed.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Browser works, backend fails | Run the backend connection check; inspect DNS provenance, errors, system routing, and `DNS_MODE` |
| Fake-IP / non-public answer | `auto` only falls back for the documented Fake-IP condition; ordinary private targets remain blocked |
| No IPv6 result | IPv6 may be absent, unreachable, or restricted; this alone does not prove a leak |
| 401 / 403 or unreadable cross-origin response | Distinguish request status, CORS, opaque responses, login challenges, and account permissions |
| Conflicting IP locations or labels | Provider coverage, update times, and definitions differ; preserve sources and do not combine them into a platform score |
| Missing status or Ping result | Possible incompatible feed, rate limit, blocked ICMP, or missing system `ping`; the website may still work |
| Port conflict | Check `status`, stop the conflicting service, or change `PORT` and restart using the new URL |
| Configuration has no effect | Check installed versus manual configuration paths, JSON syntax, list replacement, and restart |

## Privacy, validation, and license

Local operation includes optional external requests. IP providers receive queried IPs; STUN sees the exit on its path; Globalping targets and results may be public. Authoritative DNS observations need your own service. Results stay in page memory by default; explicitly saved history contains redacted summaries. See [PRIVACY.md](docs/PRIVACY.md) and [SECURITY.md](docs/SECURITY.md).

Tests, type checking, and builds establish only the behavior they cover. Consult [VALIDATION.md](docs/VALIDATION.md) and actual CI runs for live API, browser / STUN, public DNS delegation, Windows, and Docker testing. Do not interpret a successful build as verification of every online service.

Code is licensed under [MIT](LICENSE). Third-party dependencies and data retain their own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Feature categories reference the public [ip.net.coffee](https://ip.net.coffee/) site; this implementation does not use its private APIs, copy its assets, or reproduce proprietary scores.
