# 阿里云 OSS 备份

`dsh-alioss-backup` 把现有的 `dsh-backup` 产物上传到阿里云 OSS。

## Web 配置

在 DSH 侧边栏「插件」中点开「阿里云 OSS 备份」，详情页配置区可直接修改 OSS 设置、填写 AccessKey、测试连接、立即备份。

独立配置页（备用）：

```text
http://<DSH地址>:<端口>/plugins/alioss-backup/config
```

两个入口读写同一份配置：`/madata/DSH-data/storages/alioss-backup/config.json`（600）；凭证在 `/etc/dsh/alioss.env`（600），不会写入 Git。

## 工具

- `alioss_backup`：生成并上传备份；`dryRun: true` 只生成本地包并列出计划上传的对象键。
- `alioss_status`：列出 OSS 上最近的备份对象。

## 备份内容

- `dsh-data-*.tar.gz`：DSH 数据（会话、storages、凭证、日志）
- `dsh-plugins-*.tar.gz`：插件代码与配置
- `dsh-workspace-*.tar.gz`：工作区文件
- `dsh-configs-*.tar.gz`：PM2、nginx、SSH、token 脚本
- `SHA256-*.txt`：校验值

## 限制

- 使用阿里云 OSS 的 `ali-oss` SDK。
- 服务端加密 `AES256` + 对象私有，不含客户端加密。
- 备份在 DSH 运行中执行；严格一致性请先停 DSH。
- `/etc/dsh/alioss.env` 不在备份包里，迁移时重新创建。
