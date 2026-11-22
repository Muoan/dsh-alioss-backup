# dsh-alioss-backup

把 DSH 的本地备份包上传到阿里云 OSS 的 DeepSeek Harness 插件。

## 提供的能力

安装后新增：

| 能力 | 作用 |
|---|---|
| `alioss_backup` 工具 | 执行 `/usr/local/sbin/dsh-backup`，把新生成的 data / plugins / workspace / configs 包和 SHA256 文件上传到 OSS；支持 `dryRun: true` 只演练 |
| `alioss_status` 工具 | 列出 OSS 上最近的备份对象 |
| Web 配置页 | 在浏览器里修改 OSS 配置、测试连接、立即备份 |

备份内容就是现有 `dsh-backup` 的四份产物：

- `dsh-data-*.tar.gz`：DSH 数据（会话、storages、凭证、日志）
- `dsh-plugins-*.tar.gz`：插件代码与配置
- `dsh-workspace-*.tar.gz`：工作区文件
- `dsh-configs-*.tar.gz`：PM2 / nginx / SSH / token
- `SHA256-*.txt`

上传默认给对象加 `private` ACL 和 `AES256` 服务端加密。

## Web 配置

插件在 DSH 的「插件」页里直接提供配置卡片（和 dsh-access-gate 一样）：

1. 侧边栏点「插件」；
2. 点开「阿里云 OSS 备份」；
3. 详情页的配置区可以直接修改 endpoint / region / bucket / prefix / 保留天数 / 自动备份小时；
4. 填写或更新 AccessKey（留空则不修改）；
5. 点「保存配置」「测试连接」「立即备份」。

也保留一个独立配置页作为备用：

```text
http://<你的DSH地址>:<端口>/plugins/alioss-backup/config
```

两种入口读写同一份配置。保存后的配置写在：

```text
/madata/DSH-data/storages/alioss-backup/config.json   # 600
```

凭证写在：

```text
/etc/dsh/alioss.env                                   # 600
```

> AccessKey 不会写进插件配置、不会写进 Git 仓库；页面里也只显示“已配置/未配置”。

## 配置项

配置文件 `config.json` 或 profile 的 `cordis.patch.yml` 中 `alioss-backup` 行支持：

| 键 | 说明 |
|---|---|
| `endpoint` | 例如 `oss-cn-shanghai.aliyuncs.com` |
| `region` | 例如 `oss-cn-shanghai`；只填 endpoint 时会自动推导 |
| `bucket` | 必填 |
| `prefix` | 默认 `dsh-backup` |
| `keepDays` | 保留天数，0 表示不清理，默认 30 |
| `autoBackupHour` | -1 关闭；0-23 表示每天几点自动备份 |
| `credentialsFile` | 默认 `/etc/dsh/alioss.env` |
| `backupCommand` | 默认 `/usr/local/sbin/dsh-backup` |
| `backupDir` | 默认 `/maapp/backup` |

## 凭证

不要把 AccessKey 写进 YAML 或 Git。在服务器上创建：

```bash
install -d -m 700 /etc/dsh
cat > /etc/dsh/alioss.env <<'EOF'
ALIOSS_ACCESS_KEY_ID=LTAI...
ALIOSS_ACCESS_KEY_SECRET=...
# 如果使用 STS，再填：
# ALIOSS_SECURITY_TOKEN=...
EOF
chmod 600 /etc/dsh/alioss.env
```

建议使用单独的 RAM 用户，只授予该 bucket/prefix 的：

- `oss:PutObject`
- `oss:ListObjects`
- `oss:DeleteObject`（启用 `keepDays` 清理时需要）

## 使用

- Web 配置页：修改配置 / 测试连接 / 立即备份
- 在 DSH 会话里说“备份到 OSS”，模型会调用 `alioss_backup`
- 演练：`alioss_backup` 传 `dryRun: true`

每天自动备份：把 `autoBackupHour` 改成 `4`，然后重启 DSH。自动定时器运行在 DSH 进程内；DSH 停止时不会触发。

## 注意

- 本地打包是“运行中备份”，会话文件可能正在追加；要求严格一致时先停 DSH 再备份。
- 清理旧对象只覆盖 `prefix/` 下的对象，每页最多 1000 个。
- 上传使用 `ali-oss` SDK；这是插件唯一的运行时依赖。
- 服务端加密（SSE）不是客户端加密；需要客户端加密可在 `backupCommand` 外包一层 `age`/`gpg`。
- `/etc/dsh/alioss.env` 不在 `dsh-backup` 的备份包里，迁移新机器时需要重新创建。
