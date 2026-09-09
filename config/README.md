Docker 用户可将项目根目录的 config.example.json 复制为本目录的 config.local.json，然后按需编辑。缺少该文件时使用内置默认配置。密钥写入项目根目录 .env，不写入 JSON。修改后执行 docker compose restart。
