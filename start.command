#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo '请先安装 Node.js 22.13 或更新版本，然后重新打开本文件。'
  read -r reply
  exit 1
fi
node --env-file-if-exists=.env server/index.mjs
