import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const OSS = require('ali-oss');
const execFileAsync = promisify(execFile);

export const name = 'dsh-alioss-backup';
export const inject = ['tools', 'webServer'];

const CONFIG_PATH = '/plugins/alioss-backup/config';
const DEFAULT_CONFIG_FILE = '/madata/DSH-data/storages/alioss-backup/config.json';
const DEFAULT_CREDENTIALS_FILE = '/etc/dsh/alioss.env';
const BACKUP_FILE_RE = /^dsh-(data|plugins|workspace|configs)-\d{8}-\d{6}\.tar\.gz$/;
const SHA_FILE_RE = /^SHA256-\d{8}-\d{6}\.txt$/;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function readEnvFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function deriveRegion(endpoint) {
  const match = /^oss-([a-z0-9-]+)\.aliyuncs\.com$/i.exec(endpoint);
  return match === null ? '' : `oss-${match[1]}`;
}

function readSettings(config = {}) {
  const configFile = String(config.configFile ?? DEFAULT_CONFIG_FILE);
  const stored = readJson(configFile);
  const merged = { ...config, ...stored };
  const envFile = String(merged.credentialsFile ?? DEFAULT_CREDENTIALS_FILE);
  const env = { ...readEnvFile(envFile), ...process.env };
  let endpoint = String(merged.endpoint ?? env.ALIOSS_ENDPOINT ?? '').trim();
  endpoint = endpoint.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const region = String(merged.region ?? env.ALIOSS_REGION ?? deriveRegion(endpoint)).trim();
  const keepDays = Number(merged.keepDays ?? 30);
  const autoBackupHour = Number(merged.autoBackupHour ?? -1);
  return {
    endpoint,
    region,
    bucket: String(merged.bucket ?? env.ALIOSS_BUCKET ?? '').trim(),
    prefix: String(merged.prefix ?? 'dsh-backup').trim().replace(/^\/+|\/+$/g, ''),
    keepDays: Number.isFinite(keepDays) && keepDays >= 0 ? keepDays : 30,
    autoBackupHour: Number.isInteger(autoBackupHour) && autoBackupHour >= 0 && autoBackupHour <= 23 ? autoBackupHour : -1,
    credentialsFile: envFile,
    configFile,
    backupCommand: String(merged.backupCommand ?? '/usr/local/sbin/dsh-backup'),
    backupDir: String(merged.backupDir ?? '/maapp/backup'),
  };
}

function hasCredentials(settings) {
  const env = { ...readEnvFile(settings.credentialsFile), ...process.env };
  return Boolean((env.ALIOSS_ACCESS_KEY_ID ?? env.ALIBABA_CLOUD_ACCESS_KEY_ID) && (env.ALIOSS_ACCESS_KEY_SECRET ?? env.ALIBABA_CLOUD_ACCESS_KEY_SECRET));
}

function readCredentials(settings) {
  const env = { ...readEnvFile(settings.credentialsFile), ...process.env };
  const accessKeyId = env.ALIOSS_ACCESS_KEY_ID ?? env.ALIBABA_CLOUD_ACCESS_KEY_ID ?? '';
  const accessKeySecret = env.ALIOSS_ACCESS_KEY_SECRET ?? env.ALIBABA_CLOUD_ACCESS_KEY_SECRET ?? '';
  const securityToken = env.ALIOSS_SECURITY_TOKEN ?? env.ALIBABA_CLOUD_SECURITY_TOKEN ?? '';
  if (!accessKeyId || !accessKeySecret) {
    throw new Error(`OSS 凭证未配置：请在 ${settings.credentialsFile} 写入 ALIOSS_ACCESS_KEY_ID / ALIOSS_ACCESS_KEY_SECRET（chmod 600）`);
  }
  return { accessKeyId, accessKeySecret, ...(securityToken ? { securityToken } : {}) };
}

function requireConfiguration(settings) {
  if (!settings.bucket || !settings.region) {
    throw new Error('OSS 未配置：请填写 bucket、endpoint、region');
  }
}

function createClient(settings) {
  requireConfiguration(settings);
  const credentials = readCredentials(settings);
  return new OSS({
    region: settings.region,
    endpoint: settings.endpoint || undefined,
    bucket: settings.bucket,
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    ...(credentials.securityToken ? { stsToken: credentials.securityToken } : {}),
    secure: true,
    timeout: 120000,
  });
}

async function createBackup(settings) {
  if (!fs.existsSync(settings.backupCommand)) throw new Error(`备份脚本不存在：${settings.backupCommand}`);
  const startedAt = Date.now();
  const result = await execFileAsync('/bin/bash', ['-lc', settings.backupCommand], {
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  const files = fs.readdirSync(settings.backupDir)
    .filter((file) => BACKUP_FILE_RE.test(file) || SHA_FILE_RE.test(file))
    .map((file) => path.join(settings.backupDir, file))
    .filter((file) => {
      try { return fs.statSync(file).mtimeMs >= startedAt - 5000; } catch { return false; }
    })
    .sort();
  if (files.length === 0) {
    const hint = String(result.stdout ?? '').trim().split(/\r?\n/).slice(-3).join(' | ');
    throw new Error(`备份脚本已执行，但没有找到新生成的备份文件${hint ? `：${hint}` : ''}`);
  }
  return files;
}

function objectDay(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}`;
}

async function cleanupOldObjects(client, settings) {
  if (settings.keepDays <= 0) return 0;
  const cutoff = Date.now() - settings.keepDays * 24 * 60 * 60 * 1000;
  let marker;
  let deleted = 0;
  try {
    do {
      const page = await client.list({ prefix: `${settings.prefix}/`, 'max-keys': 1000, ...(marker ? { marker } : {}) });
      for (const object of page.objects ?? []) {
        const modified = new Date(object.lastModified).getTime();
        if (Number.isFinite(modified) && modified < cutoff) {
          await client.delete(object.name);
          deleted += 1;
        }
      }
      marker = page.isTruncated === true ? page.nextMarker : undefined;
    } while (marker);
  } catch {
    return -1;
  }
  return deleted;
}

async function uploadBackup(settings, files, dryRun) {
  const day = objectDay();
  const planned = files.map((file) => ({
    file,
    key: `${settings.prefix}/${day}/${path.basename(file)}`,
    bytes: fs.statSync(file).size,
  }));
  if (dryRun) return { uploaded: planned.map(({ key, bytes }) => ({ key, bytes })), deleted: 0, dryRun: true };
  const client = createClient(settings);
  const uploaded = [];
  for (const item of planned) {
    await client.put(item.key, item.file, {
      headers: {
        'x-oss-object-acl': 'private',
        'x-oss-server-side-encryption': 'AES256',
      },
    });
    uploaded.push({ key: item.key, bytes: item.bytes });
  }
  const deleted = await cleanupOldObjects(client, settings);
  return { uploaded, deleted, dryRun: false };
}

function backupTool(baseConfig) {
  return {
    name: 'alioss_backup',
    description: 'Back up DSH data, plugins, workspace and deployment configs, then upload the archives to Alibaba Cloud OSS. Use when the user asks to back up DSH to OSS.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dryRun: { type: 'boolean', description: 'Create the local backup and report the planned OSS object keys without uploading anything.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'message', 'uploaded'],
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          deleted: { type: 'number' },
          uploaded: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['key', 'bytes'],
              properties: { key: { type: 'string' }, bytes: { type: 'number' } },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args = {}) {
      const settings = readSettings(baseConfig);
      const files = await createBackup(settings);
      const result = await uploadBackup(settings, files, args.dryRun === true);
      const target = `${settings.bucket}/${settings.prefix}/`;
      const message = result.dryRun
        ? `本地备份完成（未上传）。计划上传 ${result.uploaded.length} 个文件到 ${target}`
        : `已上传 ${result.uploaded.length} 个文件到 ${target}；清理旧对象 ${result.deleted < 0 ? '失败（不影响本次上传）' : result.deleted} 个。`;
      return { ok: true, message, uploaded: result.uploaded, deleted: result.deleted };
    },
  };
}

function statusTool(baseConfig) {
  return {
    name: 'alioss_status',
    description: 'List the most recent DSH backup objects stored in Alibaba Cloud OSS.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { limit: { type: 'number', description: 'How many recent objects to return, 1-100. Defaults to 10.' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'message', 'objects'],
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          objects: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['key', 'bytes', 'lastModified'],
              properties: { key: { type: 'string' }, bytes: { type: 'number' }, lastModified: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args = {}) {
      const settings = readSettings(baseConfig);
      const limit = Math.max(1, Math.min(100, Number.isFinite(Number(args.limit)) ? Math.trunc(Number(args.limit)) : 10));
      const client = createClient(settings);
      const page = await client.list({ prefix: `${settings.prefix}/`, 'max-keys': limit });
      const objects = (page.objects ?? []).slice(0, limit).map((object) => ({
        key: object.name,
        bytes: Number(object.size ?? 0),
        lastModified: new Date(object.lastModified).toISOString(),
      }));
      const message = objects.length === 0
        ? `OSS 上没有找到 ${settings.prefix}/ 下的备份对象。`
        : `最近 ${objects.length} 个 OSS 备份对象：\n${objects.map((object) => `- ${object.key} (${object.bytes} bytes, ${object.lastModified})`).join('\n')}`;
      return { ok: true, message, objects };
    },
  };
}

function writeStoredConfig(settings, form) {
  const endpoint = String(form.get('endpoint') ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const region = String(form.get('region') ?? '').trim();
  const bucket = String(form.get('bucket') ?? '').trim();
  const prefix = String(form.get('prefix') ?? 'dsh-backup').trim().replace(/^\/+|\/+$/g, '');
  const keepDays = Number(form.get('keepDays') ?? 30);
  const autoBackupHour = Number(form.get('autoBackupHour') ?? -1);
  if (!bucket || !region) throw new Error('bucket 和 region 必填');
  if (!Number.isFinite(keepDays) || keepDays < 0 || keepDays > 3650) throw new Error('保留天数必须是 0-3650');
  if (!Number.isInteger(autoBackupHour) || autoBackupHour < -1 || autoBackupHour > 23) throw new Error('自动备份小时必须是 -1 或 0-23');
  const values = { endpoint, region, bucket, prefix, keepDays, autoBackupHour };
  fs.mkdirSync(path.dirname(settings.configFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settings.configFile, JSON.stringify(values, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(settings.configFile, 0o600);
  const accessKeyId = String(form.get('accessKeyId') ?? '').trim();
  const accessKeySecret = String(form.get('accessKeySecret') ?? '').trim();
  if (accessKeyId || accessKeySecret) {
    if (!accessKeyId || !accessKeySecret) throw new Error('AccessKey ID 与 Secret 必须同时填写');
    fs.mkdirSync(path.dirname(settings.credentialsFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(settings.credentialsFile, `ALIOSS_ACCESS_KEY_ID=${accessKeyId}\nALIOSS_ACCESS_KEY_SECRET=${accessKeySecret}\n`, { mode: 0o600 });
    fs.chmodSync(settings.credentialsFile, 0o600);
  }
  return values;
}

function renderPage(settings, csrf, message = '', error = '') {
  const status = hasCredentials(settings) ? '凭证已配置' : '凭证未配置';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH OSS 备份配置</title>
<style>
:root{color-scheme:light dark}body{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:760px;margin:40px auto;padding:0 20px;background:#f6f7f9;color:#1f2328}
@media(prefers-color-scheme:dark){body{background:#16181d;color:#e6e6e6}}
h1{font-size:22px;margin:0 0 6px}p.muted{color:#888;margin:0 0 24px}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:20px;margin-bottom:16px}
@media(prefers-color-scheme:dark){.card{background:#1f2228;border-color:#333}}
label{display:block;font-weight:600;margin:12px 0 4px}input,select{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #ccd0d5;border-radius:8px;background:transparent;color:inherit;font:inherit}
@media(prefers-color-scheme:dark){input,select{border-color:#3a3f47}}
.row{display:flex;gap:12px}.row>div{flex:1}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}
button{padding:8px 14px;border-radius:8px;border:1px solid #ccd0d5;background:#fff;color:inherit;font:inherit;cursor:pointer}
@media(prefers-color-scheme:dark){button{background:#262a31;border-color:#3a3f47}}
button.primary{background:#2563eb;border-color:#2563eb;color:#fff}
button.danger{color:#b91c1c}
.msg{padding:10px 12px;border-radius:8px;margin-bottom:12px;white-space:pre-wrap}.ok{background:#e8f5e9;color:#1b5e20}.err{background:#fdecea;color:#b71c1c}
@media(prefers-color-scheme:dark){.ok{background:#12351f;color:#a5d6a7}.err{background:#3a1717;color:#ef9a9a}}
small{color:#888}.mono{font-family:ui-monospace,Consolas,monospace}
</style></head><body>
<h1>DSH 阿里云 OSS 备份</h1>
<p class="muted">保存后手动备份 tool 立即生效；自动备份时间修改后需重启 DSH。</p>
${message ? `<div class="msg ok">${escapeHtml(message)}</div>` : ''}
${error ? `<div class="msg err">${escapeHtml(error)}</div>` : ''}
<form method="post" action="${CONFIG_PATH}">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<div class="card">
<div class="row"><div><label>Endpoint</label><input name="endpoint" value="${escapeHtml(settings.endpoint)}" placeholder="oss-cn-shanghai.aliyuncs.com"></div>
<div><label>Region</label><input name="region" value="${escapeHtml(settings.region)}" placeholder="oss-cn-shanghai"></div></div>
<div class="row"><div><label>Bucket</label><input name="bucket" value="${escapeHtml(settings.bucket)}" placeholder="moanoss"></div>
<div><label>Prefix</label><input name="prefix" value="${escapeHtml(settings.prefix)}" placeholder="dsh-backup"></div></div>
<div class="row"><div><label>保留天数</label><input name="keepDays" type="number" min="0" max="3650" value="${escapeHtml(settings.keepDays)}"></div>
<div><label>自动备份（-1 关闭，0-23 点）</label><input name="autoBackupHour" type="number" min="-1" max="23" value="${escapeHtml(settings.autoBackupHour)}"></div></div>
</div>
<div class="card">
<label>AccessKey ID <small>（${status}；留空不修改）</small></label>
<input name="accessKeyId" autocomplete="off" placeholder="留空保持不变">
<label>AccessKey Secret</label>
<input name="accessKeySecret" type="password" autocomplete="new-password" placeholder="留空保持不变">
<label>凭证文件</label><div class="mono">${escapeHtml(settings.credentialsFile)}</div>
<label>配置文件</label><div class="mono">${escapeHtml(settings.configFile)}</div>
</div>
<div class="actions">
<button class="primary" name="action" value="save">保存配置</button>
<button name="action" value="test">测试 OSS 连接</button>
<button name="action" value="backup">立即备份并上传</button>
</div>
</form>
<p><a href="/">返回 DSH</a></p>
</body></html>`;
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function createConfigHandler(baseConfig, csrf) {
  return async (req, res) => {
    try {
      if (req.method === 'GET') {
        const settings = readSettings(baseConfig);
        sendHtml(res, 200, renderPage(settings, csrf));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' });
        res.end();
        return;
      }
      const body = await readBody(req);
      const form = new URLSearchParams(body);
      if (form.get('csrf') !== csrf) {
        sendHtml(res, 403, renderPage(readSettings(baseConfig), csrf, '', 'CSRF 校验失败，请刷新页面重试'));
        return;
      }
      const action = form.get('action') ?? 'save';
      let settings = readSettings(baseConfig);
      let message = '';
      if (action === 'save') {
        writeStoredConfig(settings, form);
        settings = readSettings(baseConfig);
        message = `已保存：${settings.bucket}/${settings.prefix}/，保留 ${settings.keepDays} 天，自动备份 ${settings.autoBackupHour < 0 ? '关闭' : `${settings.autoBackupHour}:00`}。手动备份工具立即生效；自动备份需重启 DSH。`;
      } else if (action === 'test') {
        const client = createClient(settings);
        const page = await client.list({ prefix: `${settings.prefix}/`, 'max-keys': 1 });
        message = `OSS 连接成功：${settings.bucket}/${settings.prefix}/ 当前对象数约 ${(page.objects ?? []).length}${page.isTruncated ? '+' : ''}。`;
      } else if (action === 'backup') {
        const files = await createBackup(settings);
        const result = await uploadBackup(settings, files, false);
        message = `已上传 ${result.uploaded.length} 个文件到 ${settings.bucket}/${settings.prefix}/；清理旧对象 ${result.deleted < 0 ? '失败（不影响本次上传）' : result.deleted} 个。`;
      } else {
        throw new Error(`未知操作：${action}`);
      }
      sendHtml(res, 200, renderPage(settings, csrf, message));
    } catch (error) {
      sendHtml(res, 500, renderPage(readSettings(baseConfig), csrf, '', error instanceof Error ? error.message : String(error)));
    }
  };
}

function scheduleAutoBackup(ctx, settings) {
  if (settings.autoBackupHour < 0) return;
  ctx.effect(() => {
    let timer;
    const arm = () => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(settings.autoBackupHour, 0, 0, 0);
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
      timer = setTimeout(async () => {
        try {
          const current = readSettings({ ...settings, configFile: settings.configFile });
          const files = await createBackup(current);
          const result = await uploadBackup(current, files, false);
          ctx.logger?.info('alioss-backup: 自动备份完成，上传 %d 个文件', result.uploaded.length);
        } catch (error) {
          ctx.logger?.warn('alioss-backup: 自动备份失败：%s', error instanceof Error ? error.message : String(error));
        } finally {
          arm();
        }
      }, Math.max(1000, next.getTime() - now.getTime()));
      timer.unref?.();
    };
    arm();
    return () => clearTimeout(timer);
  }, 'alioss auto backup');
}

export function apply(ctx, config = {}) {
  const baseConfig = { ...config };
  const settings = readSettings(baseConfig);
  const csrf = randomBytes(24).toString('hex');
  console.log('[alioss-backup] loaded', settings.bucket, settings.prefix);
  ctx.effect(() => ctx.tools.register(backupTool(baseConfig)), 'alioss backup tool');
  ctx.effect(() => ctx.tools.register(statusTool(baseConfig)), 'alioss status tool');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: CONFIG_PATH, handler: createConfigHandler(baseConfig, csrf) }), 'alioss config page');
  scheduleAutoBackup(ctx, settings);
}
