# v0.3.0 验证记录

日期：2026-09-08。本机环境：macOS arm64、Node.js v24.19.0。最低声明版本为 Node.js 22.13。跨系统运行以仓库 Actions 的实际结果为准，不能由本机测试推断。

## 已完成的本机检查

- TypeScript 类型检查与 Vite 生产构建通过，`dist/` 可由本地 Node 服务直接提供。
- 主测试 **75 项通过**；另有 3 项 Windows PowerShell 专用测试在 macOS 跳过，交由 Windows CI 执行。覆盖输入及响应解析、缺失值、IP/域名与 SSRF、重定向和密钥边界、Host/Origin/会话令牌、真实环回 HTTP、CSP、脱敏、历史保留、WebRTC 模拟生命周期、平台独立结果与可配置数据源。
- 主测试包含 12 项 DNS 传输回归：系统解析、仅限 Fake-IP 的自动 DoH 回退、混合私网拒绝、私有名称保护、DoH 响应验证，以及固定连接地址。
- 主测试包含 8 项启动器生命周期测试：后台启动、私有配置、控制端鉴权、重复启动、端口冲突、过期状态、启动失败、停止自有子进程和日志限额。
- 主测试在 macOS 执行并通过 11 项安装与打包测试：确定性 TAR/ZIP、CRC/SHA256、中文路径、配置排除、符号链接拒绝、带空格和引号的路径、升级保留配置、停止/启动顺序、校验失败后重试、归档越界和版本不匹配。下载使用本地模拟响应，不等于已经验证公网安装。
- DNS 收集器与 Ping 节点服务测试 **27 项通过**，没有跳过。包含真实环回 HTTP、UDP、TCP；探针进程和远端请求使用模拟对象。
- 上述合计 **102 项自动化测试通过**。模拟 WebRTC、Ping 和安装下载不能替代真实浏览器、公网测量或各操作系统实测。
- 发布脚本只收集允许的源码、文档与构建文件；排除个人 `.env` 及其变体、`config.local.json`、`.git`、`.openai`、`node_modules`、运行状态、日志和密钥文件，仅保留 `.env.example`。

## 已取得真实响应的在线适配器

本机代理使用 `198.18.0.0/15` Fake-IP。默认 `DNS_MODE=auto` 在公开域名只返回该地址段时，使用固定 Cloudflare DoH 解析，再连接经校验的公网地址。它不会修改主机 DNS/代理，也不会放行私网地址；`DNS_MODE=system` 可关闭自动回退。

本次已实际取得 Cloudflare trace、ipwho.is、IANA RDAP 引导表、公开测试 IP 的 ipapi.is/ipwho.is 归属信息、example.com RDAP、OpenAI News RSS 和 OpenAI 服务状态响应。状态响应包含需注意状态，不应描述为所有服务正常。此记录只证明测试时收到相应响应，不代表未来可用性，也不代表完整安全字段或所有数据源已验证。

## 公开发行包安装验证

v0.3.0 发布后，[公开安装工作流](https://github.com/1571190347/ai-preflight-local/actions/runs/34313530579) 的 macOS、Ubuntu 和 Windows 三个任务全部通过。实际从 GitHub 下载发行包，验证 SHA256，在没有可用 Node 的路径下安装私有 Node.js，再检查页面与健康接口、更新保留配置、状态和停止。Windows 使用真实 Windows PowerShell 5.1。

本机另外在空目录运行 README 中的公开安装命令；不安装 `node_modules`，启动、健康接口、页面和停止均通过。测试时设置 `PREFLIGHT_NO_OPEN=1`，没有验证系统自动打开浏览器的行为。

## 复现

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm test:services
# macOS / Linux：启用真实 DNS 环回集成测试
DNS_COLLECTOR_INTEGRATION=1 node --test services/dns-collector/test/*.test.mjs
pnpm release
```

主测试需要允许本机套接字；DNS 集成测试还需要环回 UDP/TCP。测试不需要数据源密钥，不主动提交公共 Globalping 测量。CI 配置见 `.github/workflows/`；每个运行的日志和结论公开可查。

## 尚未覆盖的条件

本机没有 PowerShell 或 Docker，不能声称本机验证过 Windows 安装或 Docker 构建。真实浏览器 UI、跨站读取/无痕设置/下载、真实 STUN、全部 31 个状态源、带密钥数据源、公网 DNS 域名委派、公共 Globalping、远程自建 Ping，均需分别验证。未进行独立渗透测试或安全认证。

工具对无法确认的结果保留原因，不以测试通过推导账号安全或封禁概率。
