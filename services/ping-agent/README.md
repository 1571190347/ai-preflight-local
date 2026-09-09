# 自建 Ping 节点

这是一份可选的独立服务。在你自己的远程机器上运行它，主工具的「自建节点」会通过 HTTPS 请求它。结果代表该机器的 ICMP 路径，不代表浏览器连接质量。每次固定发送 3 个包；无响应记为未知，不能据此判断网站不可用或账号风险。

需要 Node.js 22.13+ 和系统 `ping` 命令，或 Docker Compose。服务使用 Node 内置模块，没有 npm 依赖。未部署、未填入主工具配置时不会使用此节点。

## 本机启动

1. 复制 `.env.example` 为 `.env`。
2. 用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` 生成随机令牌，替换 `PING_AGENT_TOKEN`；不要使用示例占位值。
3. 运行 `node --env-file-if-exists=.env src/server.mjs`。默认只监听 `127.0.0.1:8060`。

也可运行 `docker compose up --build -d`。Compose 只映射宿主机回环端口，容器以非 root 用户运行并移除 capabilities。Linux 使用允许 ping socket 的 `ping_group_range`；内核或托管环境若禁用 ICMP，结果可能未知。构建镜像需要下载 Node 镜像和操作系统网络工具；服务启动本身不访问第三方接口。

## 作为远程节点

把域名指向节点机器，按 `Caddyfile.example` 在宿主机设置 Caddy。只向外开放 HTTPS 443；HTTP 后端保留回环监听。Caddy 的自动证书签发会联系证书颁发机构。主工具仅连接标准 HTTPS 443 的公网地址，所以不会接受纯 HTTP 或直接填写 localhost 的节点。

在主工具的 `config.local.json` 合并以下字段：

```json
{
  "pingNodes": [
    {
      "id": "my-node",
      "name": "我的节点 · 城市",
      "url": "https://ping.example.com",
      "tokenEnv": "PING_NODE_MY_TOKEN"
    }
  ]
}
```

在主工具 `.env` 添加 `PING_NODE_MY_TOKEN=<与节点一致的随机令牌>`，重启主工具。令牌由本机后端读取，不应写入 URL、前端代码或公开仓库。可配置多台节点；主工具最多请求 20 台，每台独立鉴权和限流。

## 接口与数据

- `GET /health`：健康信息，无外部请求。
- `POST /ping`：`Content-Type: application/json`，请求体 `{"target":"example.com"}`。
- 两个接口都需要 `Authorization: Bearer <token>`。带 `Origin` 或 `Sec-Fetch-Site` 的浏览器请求被拒绝，不提供 CORS。
- 成功结果包括 `target`、实际测量的 `address`、`family`、`state`、`min/avg/max`（毫秒）、`loss`（百分比）、`timedOut` 和截断的原始输出。缺失数值为 `null`。
- 节点接收访问者服务器 IP、目标、令牌，并向系统 DNS 和目标发包。本服务不保存历史，不记录访问日志或目标；宿主机、DNS 服务商、反向代理及网络仍可能产生各自日志。

只接受公网域名或 IP，拒绝私网、回环、链路本地、文档地址、IPv4 映射或转换 IPv6 等特殊地址。域名解析得到的全部地址都必须通过检查，然后只把其中一个 IP 交给 `ping`，避免再次解析及命令注入。IPv6 采取保守规则，仅允许排除特殊前缀后的 `2000::/3`；少数合法特殊地址可能被拒绝。

请求体上限 1 KB；默认同时 2 次、每分钟 6 次，无等待队列；环境变量可分别调到最多 4 次和 60 次。DNS 最多等待 4 秒，系统 ping 最多 8 秒，输出最多 16 KB。收到断开事件会终止子进程。不要把令牌公开分享；发现泄露时更换节点与主工具里的同一令牌。

## 验证

运行 `node --test test/*.test.mjs`。测试使用内存请求与模拟进程，覆盖公网地址过滤、混合 DNS 记录拒绝、固定命令参数、输出解析、鉴权、请求限制、并发限制和限流；不会发出实际 ICMP、DNS 或互联网请求。实际节点延迟与系统权限需由部署者启动后检查。

代码采用 MIT License；Docker 镜像中的操作系统组件遵循各自许可证。
