#!/bin/sh
# User-local installer. No sudo, npm install, account token, or global runtime changes.
set -eu
umask 077
say() { printf '%s\n' "$*"; }
fail() { say "安装失败：$*" >&2; exit 1; }
repo=${PREFLIGHT_REPOSITORY:-1571190347/ai-preflight-local}
printf '%s\n' "$repo" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$' || fail '请设置 PREFLIGHT_REPOSITORY=GitHub用户名/仓库名'
install_dir=${PREFLIGHT_INSTALL_DIR:-"${HOME:?HOME is required}/.local/share/ai-preflight-local"}
case "$install_dir" in /*) ;; *) fail 'PREFLIGHT_INSTALL_DIR 必须是绝对路径' ;; esac
case "$install_dir" in /|"$HOME"|*/../*|*/..) fail '安装目录不能是根目录、家目录或含 .. 的路径' ;; esac
for command in curl tar awk grep sed mktemp; do command -v "$command" >/dev/null 2>&1 || fail "缺少系统工具：$command"; done
if command -v sha256sum >/dev/null 2>&1; then hash_file() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then hash_file() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v openssl >/dev/null 2>&1; then hash_file() { openssl dgst -sha256 "$1" | awk '{print $NF}'; }
else fail '需要 sha256sum、shasum 或 openssl 校验下载'; fi
download() { curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 600 --silent --show-error "$1" --output "$2"; }
verify() {
  expected=$(awk -v name="$2" '$2 == name || $2 == "*" name {print $1}' "$3")
  printf '%s\n' "$expected" | LC_ALL=C grep -Eq '^[a-fA-F0-9]{64}$' || fail "校验表中缺少唯一文件：$2"
  actual=$(hash_file "$1")
  [ "$(printf '%s' "$expected" | tr 'A-F' 'a-f')" = "$actual" ] || fail "SHA256 不匹配：$2"
}
if [ -e "$install_dir" ] && [ ! -f "$install_dir/.preflight-install" ]; then
  [ -d "$install_dir" ] && [ -z "$(ls -A "$install_dir")" ] || fail '安装目录已有其他文件，请选择空目录'
fi
[ ! -L "$install_dir" ] || fail '安装目录不能是符号链接'
mkdir -p "$install_dir"
# Mark only a directory we just accepted, so a failed first download can be retried.
if [ ! -f "$install_dir/.preflight-install" ]; then
  printf '%s\n' '{"format":1,"pending":true}' > "$install_dir/.preflight-install"
fi
stage=$(mktemp -d "$install_dir/.install.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
for item in app config state runtime bin; do [ ! -L "$install_dir/$item" ] || fail "拒绝符号链接目录：$item"; done
node_path=''
suitable_node() { "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' >/dev/null 2>&1; }
if command -v node >/dev/null 2>&1 && suitable_node "$(command -v node)"; then node_path=$(command -v node)
elif [ -x "$install_dir/runtime/bin/node" ] && suitable_node "$install_dir/runtime/bin/node"; then node_path="$install_dir/runtime/bin/node"
else
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail '仅支持 macOS / Linux；Windows 请使用 install.ps1' ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) fail '目前只支持 x64 和 arm64' ;; esac
  say '正在下载私有 Node.js 24 运行时并校验官方 SHA256…'
  download 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' "$stage/NODE-SHASUMS256.txt"
  node_asset=$(awk -v suffix="-$os-$arch.tar.gz" '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-/ && substr($2,length($2)-length(suffix)+1)==suffix {print $2}' "$stage/NODE-SHASUMS256.txt")
  printf '%s\n' "$node_asset" | LC_ALL=C grep -Eq "^node-v24\.[0-9]+\.[0-9]+-$os-$arch\.tar\.gz$" || fail '无法确定官方 Node.js 24 下载文件'
  node_version=${node_asset#node-}; node_version=${node_version%-$os-$arch.tar.gz}
  download "https://nodejs.org/dist/$node_version/$node_asset" "$stage/node.tar.gz"
  verify "$stage/node.tar.gz" "$node_asset" "$stage/NODE-SHASUMS256.txt"
  node_folder=${node_asset%.tar.gz}
  mkdir -p "$stage/runtime/bin"
  # Extract exactly one official binary to stdout; archive paths cannot select a destination.
  tar -xOzf "$stage/node.tar.gz" "$node_folder/bin/node" > "$stage/runtime/bin/node"
  tar -xOzf "$stage/node.tar.gz" "$node_folder/LICENSE" > "$stage/runtime/LICENSE"
  chmod 700 "$stage/runtime/bin/node"
  suitable_node "$stage/runtime/bin/node" || fail 'Node.js 无法运行；Linux 需要受支持的 glibc，Alpine/musl 不受此安装器支持'
  mkdir -p "$install_dir/runtime/bin"
  mv "$stage/runtime/bin/node" "$install_dir/runtime/bin/node"
  mv "$stage/runtime/LICENSE" "$install_dir/runtime/LICENSE"
  cp "$stage/NODE-SHASUMS256.txt" "$install_dir/runtime/SHASUMS256.txt"
  node_path="$install_dir/runtime/bin/node"
fi
version=${PREFLIGHT_VERSION:-}
if [ -z "$version" ]; then
  download "https://api.github.com/repos/$repo/releases/latest" "$stage/release.json"
  version=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$stage/release.json")
fi
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' || fail 'GitHub 没有可用的稳定版 Release；也可设置 PREFLIGHT_VERSION=v0.3.0'
asset="ai-preflight-local-$version.tar.gz"
base="https://github.com/$repo/releases/download/$version"
say "正在下载 AI 体检站 $version 并校验 SHA256…"
download "$base/SHA256SUMS" "$stage/SHA256SUMS"
download "$base/$asset" "$stage/$asset"
verify "$stage/$asset" "$asset" "$stage/SHA256SUMS"
"$node_path" --input-type=module - "$stage/$asset" "$stage/app" "$version" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
const [archive, destination, version] = process.argv.slice(2);
const compressed = fs.readFileSync(archive);
if (compressed.length > 128 * 1024 * 1024) throw new Error('压缩包过大');
const tar = gunzipSync(compressed, { maxOutputLength: 300 * 1024 * 1024 });
const allowed = new Set(['app','components','config','docs','hooks','lib','public','scripts','server','services','src','tests','dist','.dockerignore','.env.example','.gitignore','Dockerfile','compose.yaml','config.example.json','components.json','index.html','LICENSE','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','README.md','README.en.md','THIRD_PARTY_NOTICES.md','CONTRIBUTING.md','tsconfig.json','vite.config.ts','start.bat','start.command','install.sh','install.ps1']);
const forbidden = /^(?:\.git|\.env(?:\.(?!example$)[^/]+)?|config\.local\.json|node_modules|\.local|state|runtime|release|coverage|\.DS_Store)$|\.(?:pem|key|p12|pfx)$/i;
const seen = new Set(); let total = 0, count = 0;
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
const string = (header, start, size) => header.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '');
for (let at = 0; at + 512 <= tar.length;) {
  const h = tar.subarray(at, at + 512); if (h.every(byte => byte === 0)) break;
  const check = string(h, 148, 8).trim();
  const sum = h.reduce((n, byte, i) => n + (i >= 148 && i < 156 ? 32 : byte), 0);
  if (!/^[0-7]+$/.test(check) || parseInt(check, 8) !== sum) throw new Error('TAR 头校验失败');
  const prefix = string(h, 345, 155), name = (prefix ? prefix + '/' : '') + string(h, 0, 100), type = h[156];
  const sizeText = string(h, 124, 12).trim();
  if (!/^[0-7]+$/.test(sizeText)) throw new Error('TAR 长度无效');
  const size = parseInt(sizeText, 8), parts = name.split('/');
  if (parts[0] !== 'ai-preflight-local' || parts.length < 2 || parts.some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f]/.test(p)) || !allowed.has(parts[1]) || parts.slice(1).some(p => forbidden.test(p)) || ![0,48].includes(type) || seen.has(name)) throw new Error('拒绝不安全或未知的归档路径：' + name);
  if (size > 64 * 1024 * 1024 || (total += size) > 256 * 1024 * 1024 || ++count > 5000 || at + 512 + size > tar.length) throw new Error('归档超过限制或已损坏');
  seen.add(name); const output = path.join(destination, ...parts.slice(1));
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, tar.subarray(at + 512, at + 512 + size), { flag: 'wx', mode: /\.(?:sh|command)$/.test(output) ? 0o700 : 0o600 });
  at += 512 + Math.ceil(size / 512) * 512;
}
for (const required of ['package.json','LICENSE','dist/index.html','server/index.mjs','scripts/launcher.mjs']) if (!seen.has('ai-preflight-local/' + required)) throw new Error('归档缺少必要文件：' + required);
const pkg = JSON.parse(fs.readFileSync(path.join(destination, 'package.json')));
if ('v' + pkg.version !== version || pkg.name !== 'ai-preflight-local') throw new Error('发行版本与包内容不符');
NODE
if [ -f "$install_dir/app/scripts/launcher.mjs" ]; then
  "$node_path" "$install_dir/app/scripts/launcher.mjs" stop --install-dir "$install_dir" || fail '无法安全停止旧实例；没有替换文件，请先查看 status'
fi
if [ -e "$install_dir/app.previous" ]; then
  [ ! -L "$install_dir/app.previous" ] && [ -f "$install_dir/.preflight-install" ] || fail '旧备份目录不安全'
  rm -rf "$install_dir/app.previous"
fi
[ ! -d "$install_dir/app" ] || mv "$install_dir/app" "$install_dir/app.previous"
mv "$stage/app" "$install_dir/app"
"$node_path" --input-type=module - "$install_dir" "$node_path" "$version" <<'NODE'
import fs from 'node:fs'; import path from 'node:path';
const [root, node, version] = process.argv.slice(2);
for (const name of ['bin','config','state']) fs.mkdirSync(path.join(root,name), {recursive:true,mode:0o700});
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const wrapper = '#!/bin/sh\nPREFLIGHT_INSTALL_DIR=' + quote(root) + '\nexport PREFLIGHT_INSTALL_DIR\nexec ' + quote(node) + ' ' + quote(path.join(root,'app/scripts/launcher.mjs')) + ' "$@"\n';
fs.writeFileSync(path.join(root,'bin/ai-preflight'), wrapper, {mode:0o700}); fs.chmodSync(path.join(root,'bin/ai-preflight'),0o700);
fs.writeFileSync(path.join(root,'.preflight-install'),JSON.stringify({version,node,format:1})+'\n',{mode:0o600});
for (const [file,content] of [['.env','# 本地私有设置；升级保留此文件。\n'],['config.local.json','{}\n']]) {
  try {fs.writeFileSync(path.join(root,'config',file),content,{flag:'wx',mode:0o600});} catch(error) {if(error.code!=='EEXIST')throw error;}
}
NODE
say "安装完成：$install_dir"
say "启动 / 停止 / 状态：\"$install_dir/bin/ai-preflight\" start|stop|status"
if [ "${PREFLIGHT_NO_START:-0}" != 1 ]; then "$install_dir/bin/ai-preflight" start; fi
