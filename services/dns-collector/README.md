# 可选：自托管 DNS 观察服务

这是本地环境检测工具的一个独立、可选组件。它给一次检测签发随机域名，记录哪些递归 DNS 解析器向自己的权威 DNS 服务查询了这些域名。代码使用 Node.js 内置模块，没有 npm 运行时依赖，采用 MIT 许可证。

本地网页可以在自己的电脑上运行；这项检测额外需要一台能从公网访问的权威 DNS 服务器和一个可委派的子域名。只在 `localhost` 启动收集器无法观察公网递归解析器。无需发布检测网站；如果不想运行公网 DNS 服务，保持该检测未配置即可。

## 工作方式与结果边界

1. 本地检测工具的后端通过带 Bearer Token 的 HTTPS API 创建一个 120 秒会话，申请 3 或 10 个随机主机名。
2. 前端尝试加载这些主机名，让浏览器发起解析。主机名没有网站，DNS 预期返回 `NXDOMAIN`；页面加载失败本身是正常现象。
3. 权威服务器根据 UDP/TCP 连接的来源记录 `{ resolverIp, qtype, seenAt }`。只记录当前会话实际签发的完整域名；其他名称不会生成观察记录。
4. 本地后端读取结果，完成后调用 DELETE；会话会在 120 秒后失效并定时从内存清理。重启也会清空全部数据。

这里看到的是访问本权威服务的递归解析器出口，不一定是电脑配置的第一跳 DNS。浏览器安全 DNS、递归转发、VPN、分流规则、缓存和拦截均可能影响结果。观察到不同地区的 DNS 不能单独证明泄漏；空结果也不能证明没有泄漏。它不测量目标 AI 平台看到的完整环境，不预测账号封禁，也不能证明来源 IP 一定属于某个 DNS 品牌。

采用每次独立随机主机名、SOA TTL 0 和 negative TTL 0，尽量避免负缓存影响。实际解析器仍可能采用自己的缓存策略。UDP 源地址本身不是经过身份认证的证据。EDNS Client Subnet 数据会被忽略，不会替代连接来源地址。

## 一、准备域名和服务器

示例配置：

- 委派区域：`probe.example.com`
- 权威名称服务器：`ns1.probe.example.com`
- API：`dns-api.example.com`
- 公网 IPv4：`203.0.113.10`（文档保留地址，必须替换）

在 **父区域 `example.com` 的 DNS 服务商** 设置：

| 名称 | 类型 | 值 |
|---|---|---|
| `probe` | NS | `ns1.probe.example.com.` |
| `ns1.probe` | A | 你的服务器公网 IPv4 |
| `dns-api` | A | 你的服务器公网 IPv4 |

`ns1.probe` 位于被委派的子区域之内，父区域必须能提供对应 glue 地址；不同控制台可能称为 glue、子域名服务器或主机记录。若服务商不支持这种委派，可以在父区域使用其支持的设置方式后再验证。不要为 `probe` 添加通配 A 记录来代替 NS 委派。

放行公网 **UDP 53、TCP 53**；Caddy 自动申请 HTTPS 证书的常规部署还需放行 **TCP 80、TCP 443**。权威 DNS 必须真正使用公网端口 53；只改成高端口无法供普通递归解析器访问。API 的 8053 端口保持仅回环地址可访问。确认服务器上已有的 DNS 服务没有占用同一地址的 53 端口。

这里的名称服务器只有一个，适合个人检测实验；需要高可用时应另行设计共享会话的多权威部署，不能简单增加一个不了解这些会话的 NS。

## 二、Docker 启动

需要 Docker Compose。先复制配置并生成随机 Token：

```sh
cp .env.example .env
openssl rand -hex 32
```

编辑 `.env`，填写真实的 `DNS_ZONE`、`PUBLIC_IPV4`，把生成的随机字符串填入 `DNS_COLLECTOR_TOKEN`。不要使用示例占位值；不要把真实 `.env` 加进代码仓库或截图。

```sh
docker compose up --build -d
```

容器以普通用户运行，内部 DNS 监听 5353，映射到主机 UDP/TCP 53；API 在容器网络内监听 8053，但只映射到主机 `127.0.0.1:8053`。根文件系统只读，无持久化会话卷。

复制 `Caddyfile.example` 的站点块到**主机上的 Caddy 配置**，把域名改成 `dns-api.example.com` 对应的实际域名，再按自己的 Caddy 安装方式验证和重载。这个示例的 `127.0.0.1` 指主机，因此不要直接把 Caddy 放进另一个容器并原样使用。Caddy 负责 HTTPS，转发到本机 API。示例没有开启请求访问日志。

本地检测工具的后端配置 API 基础地址 `https://dns-api.example.com` 和同一个 Token；Token 不应发送到网页 JavaScript 或作为 URL 查询参数。

停止并清除内存会话：

```sh
docker compose down
```

## 三、直接运行 Node.js

要求 Node.js 22 或以上。不需要 `npm install`。

```sh
node --env-file=.env src/server.mjs
```

默认 API 绑定 `127.0.0.1:8053`、DNS 绑定 `0.0.0.0:53`。直接绑定低端口需要操作系统赋予相应权限；Docker 的高端口映射是更简单的方式。开发时可在 `.env` 设置 `DNS_PORT=5353`，仅用于直接指定端口的本机测试。

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DNS_ZONE` | 必填 | ASCII 子域名，最多 180 字符；可带尾部点 |
| `PUBLIC_IPV4` | 必填 | `ns1` 权威记录公布的 IPv4 |
| `DNS_COLLECTOR_TOKEN` | 必填 | 32–256 个 URL-safe 字符；建议 32 字节随机值的十六进制形式 |
| `API_BIND` | `127.0.0.1` | HTTP API 监听 IP；直接运行时保留回环绑定 |
| `API_PORT` | `8053` | HTTP API 端口 |
| `DNS_BIND` | `0.0.0.0` | DNS UDP/TCP 监听 IP |
| `DNS_PORT` | `53` | DNS UDP/TCP 端口 |
| `MAX_SESSIONS` | `1000` | 同时存活会话上限，可配置 1–10000 |

## API 契约

所有接口（包括 `/health`）都必须携带：

```http
Authorization: Bearer <DNS_COLLECTOR_TOKEN>
```

API 仅供服务器间访问，拒绝带 `Origin` 的请求，不开放 CORS。不信任 `X-Forwarded-For`；限流使用直接连接来源，反向代理后的请求因此共享其来源限额。所有 JSON 响应含 `Cache-Control: no-store`。

### `POST /sessions`

```http
Content-Type: application/json

{"count":3}
```

`count` 只能是数字 `3` 或 `10`；不接受其他字段，正文最多 1024 字节。

`201 Created`：

```json
{
  "id": "0123456789abcdef0123456789abcdef",
  "hostnames": [
    "0123456789abcdef01234567-0123456789abcdef0123456789abcdef.probe.example.com",
    "89abcdef0123456789abcdef-0123456789abcdef0123456789abcdef.probe.example.com",
    "fedcba9876543210fedcba98-0123456789abcdef0123456789abcdef.probe.example.com"
  ],
  "expiresAt": "2026-09-07T12:02:00.000Z"
}
```

单个随机标签避免 QNAME minimization 因中间层 NXDOMAIN 影响后续探测。调用方应直接使用返回的 `hostnames`，不要自行生成或推断它们。

### `GET /sessions/:id`

`200 OK`：

```json
{
  "id": "0123456789abcdef0123456789abcdef",
  "observations": [
    {"resolverIp":"198.51.100.7","qtype":"A","seenAt":"2026-09-07T12:00:03.123Z"},
    {"resolverIp":"198.51.100.7","qtype":"AAAA","seenAt":"2026-09-07T12:00:03.200Z"}
  ],
  "expiresAt": "2026-09-07T12:02:00.000Z"
}
```

同一来源 IP 与查询类型组合只保存第一次观察；每会话最多 256 条。`observations` 可以为空。不会在 GET 中返回原始 DNS 包、完整查询日志或 EDNS 数据。

### `DELETE /sessions/:id`

存在时返回 `204 No Content`，立即清除会话和主机名映射。不存在或已过期时返回 `404`。

### `GET /health`

认证通过后返回 `200` 和 `{"ok":true}`。这只证明 API 可访问，不能证明公网 NS 委派正确。

### 错误响应

统一为 `{"error":"说明"}`：`400` 请求格式错误；`401` Token 缺失或不符；`403` 请求携带 Origin；`404` 路径不存在或会话已过期；`429` 请求频率过高；`503` 会话数量达上限。

## 验证

无需联网或监听端口的测试：

```sh
npm test
```

包括会话过期与容量、Bearer 认证、HTTP 生命周期、正文校验、速率限制、DNS 编解码、NXDOMAIN/SOA、NS/A、拒绝递归、畸形包和 EDNS 来源处理。真实 UDP/TCP 测试默认明确跳过，以便在禁用网络监听的沙箱运行。

在允许绑定回环端口的机器运行完整集成测试：

```sh
DNS_COLLECTOR_INTEGRATION=1 npm test
```

集成测试自动申请临时高端口，不需要 root、不访问公网，覆盖 HTTP 创建/读取/删除、UDP 与 TCP 解析，以及大响应的 UDP 截断和完整 TCP 返回。

配置公网后，在另一台机器验证委派和权威服务（替换域名/IP）：

```sh
dig +trace NS probe.example.com
dig @203.0.113.10 probe.example.com NS +norecurse
dig @203.0.113.10 ns1.probe.example.com A +tcp +norecurse
```

测试已签发主机名时，从前端实际发起解析，然后读取 API 的 `observations`。直接 `dig @服务器IP 随机主机名` 只能测到 `dig` 所在机器，不能用于判断正常递归路径。

## 隐私与运行限制

- 无分析 SDK、外部数据库、第三方 IP 查询、遥测或出站抓取；服务只响应 DNS 和已认证的 API 请求。
- 会话仅存内存；120 秒过期时有独立删除定时器，另有清理扫描；读取与记录前也检查有效期。JavaScript 事件循环调度可能让物理清理稍晚于时限，但过期会话不可读取或继续记录。
- 应用不记录查询域名、解析器 IP、Token 或会话内容；只输出启动状态和不带请求数据的运行错误。操作系统、云平台、抓包、Docker 或自行添加的代理日志由部署者控制。
- DNS 每来源每分钟最多 600 个查询，整体每分钟最多 10000 个；API 每直接连接来源每分钟 120 次。DNS TCP 最多 128 个连接、每连接 32 个查询、5 秒空闲超时。内存映射和请求大小均有上限。
- 权威服务只回答自己的区域，不进行递归。DNS 响应不提供 DNSSEC 签名。本组件不是通用 DNS 托管服务，也未提供多用户隔离：知道共享 Token 的客户端可读取其知道 ID 的会话。
- API 暴露公网时应使用 HTTPS，并保留 Token 认证；本地前端只能经自己的后端访问它。不要在反向代理中关闭认证或向浏览器公开 Token。

本项目不调用、不代理也不复制第三方检测网站的私有接口。
