# Contributing

欢迎中文或英文 Issue / Pull Request。请先阅读 [README](README.md)、[架构说明](docs/ARCHITECTURE.md) 与 [安全模型](docs/SECURITY.md)。本项目的目标是在本机提供可复核的网络观察，不提供平台内部风控分或账号处罚预测。

Chinese and English contributions are welcome. Keep observations attributable to their source and preserve unknown or unavailable results.

## 本地开发 / Local development

Use Node.js 22.13+ and pnpm 11.19.0:

```sh
git clone https://github.com/1571190347/ai-preflight-local.git
cd ai-preflight-local
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm dev
```

The development page runs on `http://127.0.0.1:5173` with the local API on `4174`. The development script stops both with `Ctrl+C`. Do not commit `.env`, `config.local.json`, downloaded reports, runtime state, or logs.

## 验证 / Validation

Run checks relevant to your change. The full local sequence is:

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm test:services
```

Build before `pnpm test`: the HTTP integration test serves actual files from `dist/`. The main tests compile browser helpers into `.test-build/` and use Node's test runner. The service command covers the DNS collector and Ping agent without external account keys.

On macOS / Linux, enable real loopback DNS integration tests:

```sh
DNS_COLLECTOR_INTEGRATION=1 node --test services/dns-collector/test/*.test.mjs
```

These need permission to listen on loopback HTTP, UDP, and TCP ports. Tests use fixtures, mocks, and local sockets; they do not establish live third-party reachability. Test a changed online adapter separately when practical, recording the source, time, observed result, and any missing configuration. Do not submit public Globalping measurements as an incidental part of automated tests.

For UI changes, also operate the affected controls in a browser: confirm the initial external-check state, loading / cancellation behavior, per-source errors, and any downloads or history changes. A component render or successful build is not a browser interaction test. Add focused regression tests for changed security boundaries and nontrivial behavior, rather than tests that merely repeat the implementation.

The [CI workflow](.github/workflows/ci.yml) defines Node 22 / 24 checks on Ubuntu, macOS, and Windows. Unix jobs additionally enable DNS socket integration tests. Consult actual runs before describing a platform as verified.

## 修改时保留的行为 / Invariants

- External requests require explicit action. Loading the page or a configuration file must not start provider lookups, STUN, measurements, or feed fetching.
- Keep browser, backend, and remote-probe observations distinct. Keep Claude and ChatGPT results separate; generic Cloudflare geography must not become platform geography.
- Preserve `unknown`, `unconfigured`, provider `false`, missing fields, and zero values as distinct cases. A received HTTP response does not imply login, model access, or a safe account.
- Keep public-IP validation and connection pinning on backend HTTPS, WHOIS, and Ping paths. Validate redirected targets and never forward provider secrets across origins.
- Preserve the DNS modes: automatic DoH fallback is only for the documented Fake-IP condition. Do not silently send failed internal names to a public resolver or accept private answers.
- Keep service credentials in the backend. Do not add `VITE_` secrets, URL credentials, raw HTML from providers, or analytics / tracking requests.
- Preserve masked exports, optional redacted history, cancellation cleanup, and bounded requests / sessions.
- For installer or launcher changes, preserve user configuration and process identity checks. A stale PID alone is not authorization to stop a process.

When adding a data source, document its destination, fields, key requirements, and failure behavior. Update the configuration example, both READMEs where applicable, and the [feature coverage](docs/FEATURE-COVERAGE.md) / [privacy](docs/PRIVACY.md) documents. Use primary provider documentation for current API facts, and distinguish provider terms from this project's code license.

## Pull requests

Describe the concrete problem and resulting behavior. Include a short reproduction when useful, the checks actually run, and any remaining platform or live-service limits. UI changes benefit from a redacted screenshot. Keep unrelated formatting and dependency updates separate where practical.

For security-sensitive changes, explain how the affected boundary is preserved and which regression tests cover it. Report vulnerabilities using the process in [SECURITY.md](docs/SECURITY.md), without posting credentials or private reports in a public Issue.

## 发行 / Release artifacts

After validation:

```sh
pnpm release
```

This invokes `scripts/package-release.mjs` and writes versioned `.zip`, `.tar.gz`, and `SHA256SUMS` files to `release/`. Build the UI first. The package includes source, runtime server code, and `dist/`; runtime dependencies do not require `node_modules`.

Before publishing, extract the generated archive into a fresh directory and start it without `node_modules`. Check the local health endpoint and static assets, verify the archive excludes private configuration and runtime state, and ensure version strings and installation URLs agree. Keep actual validation results in [VALIDATION.md](docs/VALIDATION.md).

CI uploads these files only from Ubuntu / Node 24. It does not create tags, publish a GitHub Release, or deploy the website. Publishing is a separate maintainer action. GitHub's automatic source archives do not contain `dist/` and must not be described as ready-to-run Release assets.

Contributions are distributed under the project's [MIT License](LICENSE); third-party material must retain applicable notices and permissions.
