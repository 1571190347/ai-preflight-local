# 本地安装与升级

安装器下载 [GitHub 正式发行包](https://github.com/1571190347/ai-preflight-local/releases/latest)，校验 SHA256，安装后启动服务并打开 `http://127.0.0.1:4173`。发行包含已构建的网页和全部源码，运行时不需要安装 npm 依赖。未安装合适的 Node.js 时，安装器会从 Node.js 官方下载私有 Node.js 24 运行时。

## 一行安装

macOS 或 Linux，在终端执行：

```sh
curl -fsSL https://raw.githubusercontent.com/1571190347/ai-preflight-local/main/install.sh | sh
```

Windows，在 PowerShell 执行：

```powershell
irm https://raw.githubusercontent.com/1571190347/ai-preflight-local/main/install.ps1 | iex
```

默认安装到当前用户的目录，不需要管理员权限，不修改全局 Node.js、PATH、系统代理或系统执行策略。不会注册开机启动；关闭浏览器后服务仍可运行，可用下面的 `stop` 命令停止。安装器代码可以直接查看：[macOS / Linux](../install.sh)、[Windows](../install.ps1)。

| 系统 | 默认目录 | 要求 |
| --- | --- | --- |
| macOS | `~/.local/share/ai-preflight-local` | x64 / Apple Silicon；系统自带 curl、tar 和 SHA256 工具 |
| Linux | `~/.local/share/ai-preflight-local` | x64 / arm64；curl、tar、awk、grep、sed、mktemp 和 SHA256 工具；官方 Node.js 所需的 glibc 环境 |
| Windows | `%LOCALAPPDATA%\AI-Preflight-Local` | x64 / arm64；Windows PowerShell 5.1 或 PowerShell 7；可运行 Node.js 24 的系统 |

如果 PATH 中已有 Node.js 22.13 或更高版本，会直接使用它。Linux Alpine / musl 不适用私有运行时的自动下载方式，可使用项目的 Docker 方案或自行准备兼容的 Node.js。

## 启动、停止与查看状态

macOS / Linux：

```sh
"$HOME/.local/share/ai-preflight-local/bin/ai-preflight" start
"$HOME/.local/share/ai-preflight-local/bin/ai-preflight" status
"$HOME/.local/share/ai-preflight-local/bin/ai-preflight" open
"$HOME/.local/share/ai-preflight-local/bin/ai-preflight" stop
```

Windows PowerShell：

```powershell
& "$env:LOCALAPPDATA\AI-Preflight-Local\bin\ai-preflight.cmd" start
& "$env:LOCALAPPDATA\AI-Preflight-Local\bin\ai-preflight.cmd" status
& "$env:LOCALAPPDATA\AI-Preflight-Local\bin\ai-preflight.cmd" open
& "$env:LOCALAPPDATA\AI-Preflight-Local\bin\ai-preflight.cmd" stop
```

`start` 会启动后台服务并打开浏览器；已经运行时重复执行不会再启动第二份。`open` 只打开正在运行的服务。`status` 显示是否运行，未运行时退出码为 1。`stop` 通过本机认证通道通知该安装的启动器停止它自己的服务，不根据状态文件中的 PID 直接结束其他进程。

## 私有配置与目录

```text
安装目录/
├── app/                 发行包中的应用、网页和源码
├── app.previous/        上一次升级前的应用（升级后存在）
├── bin/                 本地启动命令
├── config/
│   ├── .env             端口、可选令牌等私有设置
│   └── config.local.json 自定义检测源和节点
├── runtime/             私有 Node.js（需要自动下载时存在）
└── state/               启动状态和有大小限制的本地日志
```

设置示例见 [`.env.example`](../.env.example) 和 [`config.example.json`](../config.example.json)。一行安装后，应修改安装目录内的 `config/.env` 与 `config/config.local.json`；修改后先 `stop` 再 `start`。例如端口冲突时可在 `config/.env` 写入 `PORT=4174`，然后访问启动器显示的地址。安装版始终只监听 `127.0.0.1`。

普通检测无需填写密钥。付费数据源、自建 DNS 收集器和自建 Ping 节点等扩展需要另行配置；这不会影响其他可用检测项目。启动网页不会自动执行第三方检测，实际请求由页面中明确的检测操作触发。具体数据流见 [隐私说明](PRIVACY.md)。

## 升级与指定版本

再次运行同一条安装命令即可升级。安装器会先下载并验证新包，然后停止旧实例、替换 `app` 并重新启动；`config` 中的私有配置保留。旧应用保留为 `app.previous`，下次成功替换时更新这份备份。

如果只想安装，不立即启动，或想选择安装位置、固定版本，可以使用环境变量：

| 变量 | 作用 |
| --- | --- |
| `PREFLIGHT_INSTALL_DIR` | 专用的绝对安装路径；不能使用家目录、磁盘根目录、符号链接或含其他文件的目录 |
| `PREFLIGHT_VERSION` | 固定 GitHub Release，例如 `v0.3.0`；未设置时使用最新正式版 |
| `PREFLIGHT_NO_START=1` | 安装或升级完成后不启动服务 |
| `PREFLIGHT_NO_OPEN=1` | 启动服务但不打开浏览器，适合无桌面的机器 |
| `PREFLIGHT_REPOSITORY` | 使用自己的兼容 fork，格式为 `GitHub用户名/仓库名`；需要有相同命名规则的发行包 |

macOS / Linux 示例（变量需要传给管道右侧的安装进程）：

```sh
curl -fsSL https://raw.githubusercontent.com/1571190347/ai-preflight-local/main/install.sh | PREFLIGHT_INSTALL_DIR="$HOME/Tools/ai-preflight-local" PREFLIGHT_VERSION=v0.3.0 PREFLIGHT_NO_OPEN=1 sh
```

Windows PowerShell 示例：

```powershell
$env:PREFLIGHT_INSTALL_DIR = 'D:\Tools\AI-Preflight-Local'
$env:PREFLIGHT_VERSION = 'v0.3.0'
$env:PREFLIGHT_NO_OPEN = '1'
irm https://raw.githubusercontent.com/1571190347/ai-preflight-local/main/install.ps1 | iex
```

自定义目录后，启动命令也使用该目录内的 `bin/ai-preflight` 或 `bin\ai-preflight.cmd`。环境变量在当前终端中仍然生效，后续想恢复跟随最新版时应取消 `PREFLIGHT_VERSION`。

## 下载失败与手动使用

安装需要访问 GitHub、GitHub 发行包下载地址；下载私有运行时时还需要访问 `nodejs.org`。下载失败或校验失败会中止安装，不会运行未通过校验的包。可以在恢复网络后重试原命令。SHA256 用于校验下载内容，不能代替对仓库及安装脚本的信任。

也可以从 [Releases](https://github.com/1571190347/ai-preflight-local/releases) 下载 ZIP / TAR.GZ 和 `SHA256SUMS`，校验并解压。在已有 Node.js 22.13 或更新版本的电脑上，进入解压后的 `ai-preflight-local` 目录执行：

```sh
node --env-file-if-exists=.env server/index.mjs
```

这种直接运行方式使用当前目录中的 `.env` 与 `config.local.json`，在前台运行，按 `Ctrl+C` 停止。它不使用安装版的后台启动器或 `config/` 私有目录。离线拷贝时必须连同预构建的 `dist/` 一起拷贝；GitHub 的自动生成 “Source code” 压缩包不包含 `dist/`。

卸载时先运行 `stop`，再删除专用安装目录；这也会删除其中的私有配置及本地日志，需保留的文件应先备份。网页检测记录保存在浏览器本地存储中，可以在页面中清除。

## 验证范围

自动化测试覆盖安装包格式与校验、隐私文件排除、失败重试、升级保留配置、危险归档路径拒绝、安装器与启动器生命周期。POSIX 安装器使用离线下载夹具测试；Windows CI 使用真实 PowerShell 执行安装与升级流程，仅将下载函数替换为本地夹具传输。当前开发机没有 PowerShell，Windows 结果以 [GitHub Actions](https://github.com/1571190347/ai-preflight-local/actions) 中对应运行和 [验证记录](VALIDATION.md) 为准。
