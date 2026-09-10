# AI 体检站 · 本地版

**v0.4.0 · 打开即出报告 · 本地运行 · MIT 开源**　[English](README.en.md)

在自己的电脑上检查公网 IP、分流出口、Claude / ChatGPT 连接、IP 画像、DNS、WebRTC 和浏览器环境。界面和后端都运行在本机。打开首页会自动生成一份网络体检报告，直接列出代理/VPN/Tor/滥用标签、机房属性、地区差异和 AI 入口连通问题；其他深度检测仍由用户手动运行。

报告优先给出通俗结论，再保留每条判断的来源与建议。完成后可一键复制或下载一份自动隐藏公网 IP 的 Markdown 报告，直接交给 AI 按证据分析并生成合规的环境优化步骤。它无法读取平台内部信任分、账号状态或封号概率，也不把缺失数据当作“IP 干净”。

## 一行安装并启动

**macOS / Linux**：在终端运行：

```sh
curl -fsSL https://raw.githubusercontent.com/1571190347/ai-preflight-local/main/install.sh | sh
```

**Windows**：在 PowerShell 运行：

```powershell
irm https://raw.githubusercontent.com/1571190347/ai-preflight-local/main/install.ps1 | iex
```

安装器下载最新稳定版的 Release 文件并校验 SHA256。已有 Node.js 22.13+ 时复用；没有时下载并校验官方 Node.js 24，放在应用私有目录。**无需预装 Node.js、pnpm，也不需要管理员权限。** 安装完成后启动本地服务并尝试打开浏览器；没有自动打开时访问 [http://127.0.0.1:4173](http://127.0.0.1:4173)。

安装需要连接 GitHub，下载私有运行时还需连接 `nodejs.org`。macOS / Linux 使用系统 `curl`、`tar` 等常规命令，支持 x64 / ARM64；私有 Linux 运行时需要兼容的 glibc，Alpine/musl 不在安装器支持范围。Windows 脚本面向 PowerShell 5.1 / 7、x64 / ARM64。实际跨平台验证进度见 [验证记录](docs/VALIDATION.md)。

可先阅读 [macOS / Linux 安装脚本](install.sh) 或 [Windows 安装脚本](install.ps1)，再保存到本地执行。脚本下载的是 [Releases 中的发行附件](https://github.com/1571190347/ai-preflight-local/releases)，不是 GitHub 自动生成的源码 ZIP。

### 启动、停止、更新

macOS / Linux：

```sh
~/.local/share/ai-preflight-local/bin/ai-preflight start
~/.local/share/ai-preflight-local/bin/ai-preflight status
~/.local/share/ai-preflight-local/bin/ai-preflight open
~/.local/share/ai-preflight-local/bin/ai-preflight stop
```

Windows PowerShell：

```powershell
& "$env:LOCALAPPDATA\AI-Preflight-Local\bin\ai-preflight.cmd" start
& "$env:LOCALAPPDATA\AI-Preflight-Local\bin\ai-preflight.cmd" status
& "$env:LOCALAPPDATA\AI-Preflight-Local\bin\ai-preflight.cmd" open
& "$env:LOCALAPPDATA\AI-Preflight-Local\bin\ai-preflight.cmd" stop
```

`start` 在后台运行，重复启动会复用已有实例；`open` 打开正在运行的服务页面。重复运行安装命令即可更新，安装目录下的 `config/.env` 和 `config/config.local.json` 会保留。更新先停止旧实例。安装器不修改 shell 的 PATH，上面的完整路径可以直接使用。

### 干净卸载

卸载会删除程序、安装器下载的私有 Node.js、配置和本地日志。需要保留自定义配置时，请先备份安装目录中的 `config/`。

macOS / Linux 默认安装：

```sh
install_dir="$HOME/.local/share/ai-preflight-local"
if [ -x "$install_dir/bin/ai-preflight" ]; then "$install_dir/bin/ai-preflight" stop; fi
rm -rf -- "$install_dir"
```

Windows PowerShell 默认安装：

```powershell
$installDir = Join-Path $env:LOCALAPPDATA 'AI-Preflight-Local'
$command = Join-Path $installDir 'bin\ai-preflight.cmd'
if (Test-Path -LiteralPath $command) { & $command stop }
Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
```

使用过 `PREFLIGHT_INSTALL_DIR` 时，把上面的 `$install_dir` 或 `$installDir` 改成当时选择的专用目录。为了同时清除浏览器内保存的脱敏历史，先在页面“数据与设置”中点击清空；如果页面已经删掉，可在浏览器的站点数据设置中删除 `http://127.0.0.1:4173` 的数据和权限。

安装器没有注册系统服务、开机启动项，也没有修改 PATH，因此不需要再清理这些项目。手动下载的 ZIP、TAR.GZ、导出卡片和报告位于你选择的下载位置，不在安装目录中，需要自行删除。手动解压运行的版本在停止前台 Node 进程后，直接删除解压目录即可。

| 安装选项                | 作用                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `PREFLIGHT_INSTALL_DIR` | 自定义绝对安装路径；默认 macOS / Linux 为 `~/.local/share/ai-preflight-local`，Windows 为 `%LOCALAPPDATA%\AI-Preflight-Local` |
| `PREFLIGHT_VERSION`     | 指定稳定版，例如 `v0.4.0`；默认读取最新 Release                                                                               |
| `PREFLIGHT_NO_START=1`  | 安装后暂不启动                                                                                                                |
| `PREFLIGHT_NO_OPEN=1`   | 启动时不自动打开浏览器                                                                                                        |

这些是运行安装器或启动器之前设置的环境变量。例如 macOS / Linux 可把 `PREFLIGHT_VERSION=v0.4.0` 放在管道末端的 `sh` 前；Windows 可先执行 `$env:PREFLIGHT_VERSION = 'v0.4.0'`。

### 手动运行发行包

从 [Releases](https://github.com/1571190347/ai-preflight-local/releases) 下载 `ai-preflight-local-v0.4.0.zip` 或 `.tar.gz`，对照同一版本的 `SHA256SUMS` 校验后解压。发行附件包含构建后的 `dist/`，手动方式需自行准备 Node.js 22.13+。在解压后的项目目录运行：

```sh
node --env-file-if-exists=.env server/index.mjs
```

用 `Ctrl+C` 停止。此方式使用项目根目录的 `.env` 和 `config.local.json`。**GitHub 的 “Code → Download ZIP” 与 “Source code” 附件只有源码，需要先构建。** 不要直接双击 `dist/index.html`，页面需要同源本地 API。

## 可以检查什么

| 模块               | 提供的操作与结果                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 总览 / AI 易读报告 | 打开页面自动检查出口、IP 属性和 Claude / ChatGPT 连接；按风险、需留意、未知和未见明显风险展示证据，可复制或下载脱敏 Markdown 交给 AI 分析 |
| IP 与分流          | 自选出口源，对比浏览器与本地服务的 IPv4 / IPv6、HTTP 出口、国家和 trace 字段；可随时隐藏 IP                                               |
| Claude             | 独立的 Claude 出口、网页响应结果和官方支持地区 / 登录排查入口                                                                             |
| ChatGPT / Codex    | 独立的 ChatGPT 出口、网页 / OpenAI API 响应结果和官方资料入口；不读取登录凭据或模型权限                                                   |
| IP 画像            | 查询任意公网 IP，选择 ipapi.is、ipwho.is、AbuseIPDB、Shodan InternetDB，分别显示地理、ASN、组织、提供方标记与历史记录                     |
| 网络连通           | 对所选站点执行三轮浏览器 HTTP 请求，显示单次结果和中位数；不透明响应保留“HTTP 状态不可读”                                                 |
| DNS 检测           | 读取本地 Node 服务所在机器的系统 DNS 与网卡；可选自建权威 DNS 收集器，运行 3 / 10 个随机域名探测并查看解析器观测                          |
| WebRTC             | 从多个 STUN 收集浏览器可见 ICE 候选，与 HTTP 出口对比                                                                                     |
| 全球 Ping          | 本机 ICMP、公共 Globalping（每次最多 20 个探针）、可选自建远程 Ping 节点                                                                  |
| 服务状态           | 内置 31 个状态源，按分类查看状态和事件；不兼容的状态接口提供官方链接                                                                      |
| WHOIS / RDAP       | 域名、公网 IP、ASN 的 RDAP 查询，TCP 43 WHOIS 回退，以及 RDAP 顶级域名列表筛选                                                            |
| 设备与指纹         | 浏览器语言、时区、能力、WebGL / Canvas 等主动检查与本地指纹演示                                                                           |
| 本地历史           | 自愿保存脱敏摘要到当前浏览器，查看和清空；默认不保存                                                                                      |
| AI 资讯            | 手动加载配置的 RSS / Atom，筛选、分页并打开原文                                                                                           |
| IP 卡片            | 22 种主题、8 种纹样 × 8 种印章组合，本地导出 SVG / PNG，下载时强制遮罩 IP                                                                 |
| 数据与设置         | 查看请求目的地、数据边界和可选服务配置状态                                                                                                |

Claude 与 ChatGPT 使用各自的结果状态；地区提示只引用相应平台的地区观测。共享 Cloudflare 结果不会被当作平台自身的国家信息。自定义来源可用 `platform: "claude"`、`"gpt"` 或 `"shared"` 明确归属。

完整条件、数据源说明与未实现的类别见 [功能覆盖](docs/FEATURE-COVERAGE.md)。

## 建议第一次这样使用

1. 打开页面后等待自动报告完成，先看结论，再看每项证据和“资料不完整”提示。
2. 点击“复制给 AI”或“下载 AI 报告”，把脱敏 Markdown 发给自己的 AI，获取按优先级排列的合规排查步骤。
3. 如果需要核对路径，在“IP 与分流”分别观察浏览器和后台出口，再查看 Claude 或 ChatGPT 的独立结果。
4. 按需运行 DNS、WebRTC、Ping 等深度检测。出现“无法确认”时保留具体原因，不把它转换成账号风险结论。

## DNS 与代理怎么工作

`DNS_MODE` 控制本地后端的公网目标解析，不修改操作系统、浏览器或代理设置；“本机 DNS 与网卡”仍报告系统本身的观察。

| 模式           | 行为                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`（默认） | 优先系统 DNS。只有结果出现 `198.18.0.0/15` Fake-IP、且没有其他非公网地址时，才改用固定 Cloudflare DoH。普通内网地址、混合内网结果、解析错误和超时不会触发回退 |
| `system`       | 只使用系统 DNS；Fake-IP 与其他非公网结果会被拒绝，不调用 DoH                                                                                                  |
| `doh`          | 对允许的公网域名直接查询固定 Cloudflare DoH；仍拒绝私网 / 保留 IP、特殊本地域名与不合法结果                                                                   |

DoH 固定为 `https://1.1.1.1/dns-query`，直接连接 `1.1.1.1` 并校验 TLS。它向 Cloudflare 发送所查询的域名，Cloudflare 也能观察后台请求的网络出口；不发送第三方 API 密钥。A / AAAA 结果经公网校验后用于实际连接，重定向也会重新校验。DoH 不可达时显示失败，不会放宽内网限制。

浏览器扩展、系统代理、TUN 和分流规则可能造成不同出口。后台 HTTPS 使用校验并固定地址的直接连接，不自动继承浏览器代理，也不通过通用代理 Agent 重新解析域名；系统 TUN 仍可能影响其路径。后台连接成功不能代替浏览器或目标平台实际访问。

## 可选配置

一行安装后，编辑安装目录下的 **`config/.env`** 和 **`config/config.local.json`**。手动运行源码 / 发行包时，使用项目根目录的同名文件；可从 [.env.example](.env.example) 和 [config.example.json](config.example.json) 复制。修改后停止并重新启动服务。

| 环境变量              | 用途                                           |
| --------------------- | ---------------------------------------------- |
| `PORT`                | 正式运行端口，默认 `4173`                      |
| `BIND_ADDRESS`        | 默认 `127.0.0.1`，个人使用保留环回监听         |
| `CONFIG_FILE`         | 可选 JSON 配置路径；相对路径按服务工作目录解析 |
| `DNS_MODE`            | `auto`、`system` 或 `doh`，默认 `auto`         |
| `IPAPI_KEY`           | ipapi.is 完整画像字段的可选密钥                |
| `ABUSEIPDB_KEY`       | AbuseIPDB 查询密钥，本工具不提交举报           |
| `GLOBALPING_TOKEN`    | 可选账户令牌，公共测量仍应按公开信息处理       |
| `DNS_COLLECTOR_URL`   | 自建 DNS 管理 API 的标准 HTTPS 基础地址        |
| `DNS_COLLECTOR_TOKEN` | 自建 DNS 收集器令牌，仅后端读取                |

密钥只存于本机私有配置，不使用 `VITE_` 前缀，不填入 URL 或前端代码。匿名 IP 数据源可能缺少 VPN、代理等安全字段；未知字段不代表未命中。

JSON 支持 `exitSources`、`connectionSources`、`statusSources`、`stunServers`、`newsFeeds`、`pingNodes`。**每个写入的列表替换该列表的默认值；未写入的列表保留默认值。** 每个列表最多 64 项，来源 ID 必须唯一。外部 URL 必须是无凭据的标准 HTTPS 地址，不允许密钥类查询参数。配置本身不会触发外部请求。

例如，仅配置自己的远程 Ping 节点：

```json
{
  "pingNodes": [
    {
      "id": "my-node",
      "name": "我的节点",
      "url": "https://ping.example.com",
      "tokenEnv": "PING_NODE_MY_TOKEN"
    }
  ]
}
```

替换为自己的域名，在 `.env` 设置与节点一致的 `PING_NODE_MY_TOKEN`。URL 不需要 `/ping` 后缀。STUN 来源接受 `stun:主机:端口` / `stuns:主机:端口`，实际支持由浏览器决定。

## 自建组件与 Docker

- [DNS 收集器](services/dns-collector/README.md)：独立权威 DNS 与 HTTPS 管理 API，需要自己的域名委派和公网服务器。
- [远程 Ping 节点](services/ping-agent/README.md)：在自己控制的机器上运行固定次数 ICMP，需要系统 `ping` 和受保护的 HTTPS API。

两者均附源码、测试和 Docker 配置，由使用者单独部署；未配置时主工具的其他模块仍可运行。

主工具也提供 Dockerfile / Compose。需要 Docker 和 Compose 2.24+：

```sh
docker compose up --build -d
```

访问 [http://127.0.0.1:4173](http://127.0.0.1:4173)，使用 `docker compose down` 停止。镜像构建需要下载基础镜像和依赖。自定义 JSON 请放在 `config/config.local.json`，详见 [配置目录说明](config/README.md)。容器的 DNS 与网络是另一个观察点；提供部署文件不代表已验证你所在系统的 Docker 运行。

## 源码开发与发行

准备 Node.js 22.13+ 和 **pnpm 11.19.0**：

```sh
git clone https://github.com/1571190347/ai-preflight-local.git
cd ai-preflight-local
npm install --global pnpm@11.19.0
pnpm install --frozen-lockfile
pnpm dev
```

开发页面位于 [http://127.0.0.1:5173](http://127.0.0.1:5173)；脚本同时启动 `4174` 的本机 API，通过 Vite 代理。`Ctrl+C` 一起停止。

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm test:services
pnpm release
```

主测试需要先构建 `dist/`。macOS / Linux 可额外执行 `DNS_COLLECTOR_INTEGRATION=1 node --test services/dns-collector/test/*.test.mjs`，检查真实环回 HTTP / UDP / TCP。

`pnpm release` 在 `release/` 生成 ZIP、tar.gz 和 `SHA256SUMS`，包含源码与已构建页面，排除私有配置、依赖目录和运行数据。GitHub Actions 配置在 Linux、macOS、Windows 上使用 Node 22 / 24 进行检查，只有 Ubuntu / Node 24 上传发行构建产物；**CI 不自动发布 Release**。工作流定义不等于已通过的运行记录。

参与开发请看 [CONTRIBUTING.md](CONTRIBUTING.md)，代码结构与安全边界见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 常见问题

| 现象                       | 解释与处理                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| 浏览器有结果，后台失败     | 先运行后台连接检查，查看 DNS 来源与原因；核对系统代理 / TUN 路径和 `DNS_MODE`              |
| Fake-IP / 非公网地址       | `auto` 仅对指定 Fake-IP 条件回退；普通私网仍拒绝。核对系统解析结果，不要关闭校验来访问内网 |
| IPv6 无结果                | 可能没有 IPv6、网络不可达或服务受限，不能单独判定泄露                                      |
| 401 / 403 或跨站响应不可读 | 只说明该请求的结果；CORS、不透明响应、登录挑战与账号权限是不同问题                         |
| IP 城市、类型或标记不一致  | 数据库刷新时间和定义不同，保留来源分别核对，不合成为平台风控分                             |
| 服务状态 / Ping 未取得数据 | 接口不兼容、限流、ICMP 被禁或系统缺少 `ping` 均有可能；不代表网站一定不可用                |
| 端口占用                   | 用 `status` 检查实例；停止冲突服务或修改 `PORT` 后重启，使用对应 URL                       |
| 配置未生效                 | 核对安装版与手动运行版的配置位置、JSON 格式、列表替换规则，并重启                          |

## 隐私、验证与许可

本地运行仍有按需外部请求：IP 数据源接收查询 IP，STUN 接收其路径的网络出口，Globalping 目标与结果可能公开。DNS 权威观测需要自己的服务，普通网页无法直接获得完整递归路径。结果默认在页面内存；历史只在主动保存时写入脱敏摘要。详见 [PRIVACY.md](docs/PRIVACY.md) 与 [SECURITY.md](docs/SECURITY.md)。

自动化测试、类型检查与构建只能证明所覆盖的行为。真实第三方 API、浏览器跨站 / STUN、公网 DNS 委派、Windows 和 Docker 的执行情况应以 [验证记录](docs/VALIDATION.md) 和具体 CI 运行结果为准；不能据此宣称所有在线服务全部实测通过。

本项目代码采用 [MIT License](LICENSE)。第三方依赖与数据遵循各自条款，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。功能类别参考公开的 [ip.net.coffee](https://ip.net.coffee/)，本实现不使用其私有接口，不复制其素材或专有分数。
