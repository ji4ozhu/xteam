#!/usr/bin/env node
// xteam — cross-session file coordination + group chat for Claude Code sessions
// (and Codex delegates). Works on Windows / macOS / Linux. Pure Node builtins.
//
// State lives under <repo>/.claude/xteam/:
//   locks/<sha1-of-path>/meta.json   one dir per lock (fs.mkdirSync = atomic)
//   presence/<sha1-of-owner>/meta.json  one dir per session (auto-registered)
//   chat.log                          append-only group chat (auto-rotated)
//
// A lock covers its own path and everything beneath it (lock "src/auth" also
// covers "src/auth/login.ts"). Staleness = lastSeenAt/heartbeat age > TTL.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.1.0';
const REPO_RAW = 'https://raw.githubusercontent.com/ji4ozhu/xteam/main';
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));   // ~/.claude/skills/xteam
const SKILL_DIR = SELF_DIR;
const COMMAND_DIR = path.join(os.homedir(), '.claude', 'commands');

const TTL = Number(process.env.XTEAM_TTL || 2700);               // seconds
const LOG_MAX = Number(process.env.XTEAM_LOG_MAX || 200);        // chat log rotation
const STATUS_CHAT = Number(process.env.XTEAM_STATUS_CHAT || 5);  // chat lines in `status`
const WAIT_POLL = Number(process.env.XTEAM_WAIT_POLL || 5);      // seconds between wait polls
const WAIT_MAX = Number(process.env.XTEAM_WAIT_MAX || 900);      // max seconds for `wait`

function nowSec() { return Math.floor(Date.now() / 1000); }

function repoRoot() {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim();
  } catch {
    return process.cwd();
  }
}

const ROOT = repoRoot();
const COORD = process.env.XTEAM_DIR || path.join(ROOT, '.claude', 'xteam');
const LOCKS = path.join(COORD, 'locks');
const PRESENCE = path.join(COORD, 'presence');
const WAITERS = path.join(COORD, 'waiters');
const CHAT = path.join(COORD, 'chat.log');

function owner() {
  if (process.env.XTEAM_OWNER) return process.env.XTEAM_OWNER;
  const sid = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
  if (sid) return sid.replace(/-/g, '').slice(0, 8);
  try {
    const n = execSync('git config user.name', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (n) return n;
  } catch {}
  return 'unknown';
}

function normalize(p) {
  p = String(p).replace(/\\/g, '/');
  if (path.isAbsolute(p)) {
    const rel = path.relative(ROOT, p).replace(/\\/g, '/');
    if (!rel.startsWith('..')) p = rel;
  }
  while (p.startsWith('./')) p = p.slice(2);
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  if (p === '' || p === '.') p = '.';
  return p;
}

function lockDir(p) {
  const h = createHash('sha1').update(p).digest('hex');
  return path.join(LOCKS, h);
}

function presenceDir(who) {
  const h = createHash('sha1').update(who).digest('hex');
  return path.join(PRESENCE, h);
}

function readMeta(key) {
  try {
    return JSON.parse(fs.readFileSync(path.join(key, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writeMetaAtomic(key, meta) {
  fs.mkdirSync(key, { recursive: true });
  const tmp = path.join(key, 'meta.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n');
  fs.renameSync(tmp, path.join(key, 'meta.json'));
}

// Human-readable session name shown as <id>-<label>. Explicit label wins;
// otherwise fall back to the note on the session's first held lock.
function labelOf(who) {
  const m = readMeta(presenceDir(who));
  if (m && m.label) return m.label;
  for (const lock of listLocks()) {
    if (lock.owner === who && lock.note) return lock.note;
  }
  return '';
}

function displayName(who) {
  const l = labelOf(who);
  return l ? `${who}-${l}` : who;
}

function applyLabel(who, text) {
  const key = presenceDir(who);
  const m = readMeta(key) || { owner: who, startedAt: nowSec() };
  m.label = text;
  writeMetaAtomic(key, m);
}

function registerPresence() {
  const who = owner();
  fs.mkdirSync(PRESENCE, { recursive: true });
  const key = presenceDir(who);
  const t = nowSec();
  let m = readMeta(key);
  if (!m) m = { owner: who, startedAt: t };
  if (!m.label && process.env.XTEAM_LABEL) m.label = process.env.XTEAM_LABEL;
  m.lastSeenAt = t;
  writeMetaAtomic(key, m);
  return who;
}

function report(p, key, via) {
  const m = readMeta(key);
  const who = m && m.owner ? m.owner : '?';
  const hb = m && m.heartbeatAt ? m.heartbeatAt : 0;
  const idle = nowSec() - hb;
  const stale = idle > TTL ? ' (STALE)' : '';
  const viaStr = via && via !== p ? ` [via ${via}]` : '';
  const note = m && m.note ? ` — ${m.note}` : '';
  console.log(`HELD: ${p}${viaStr} — owner=${displayName(who)}, idle=${idle}s${stale}${note}`);
  const queue = listWaiters(p);
  if (queue.length) {
    console.log(`  队列/waiting: ${queue.map((w) => displayName(w.owner)).join(', ')}`);
  }
  if (idle > TTL) console.log(`  已过期，可 xteam takeover ${p} 接管 / stale, run xteam takeover ${p}`);
  else console.log(`  别硬改。xteam wait ${p} 会等到放锁并自动接手 / don't edit anyway; xteam wait ${p} blocks until free, then auto-acquires`);
}

function findHeld(p) {
  let cur = p;
  for (;;) {
    const key = lockDir(cur);
    if (fs.existsSync(key)) return { via: cur, key };
    const idx = cur.lastIndexOf('/');
    if (idx <= 0) break;
    cur = cur.slice(0, idx);
  }
  return null;
}

function check(p) {
  p = normalize(p);
  const h = findHeld(p);
  if (h) report(p, h.key, h.via);
  else console.log(`FREE: ${p}   (可编辑 / safe to edit)`);
}

function preedit() {
  if (process.stdin.isTTY) return;
  let data;
  try { data = fs.readFileSync(0, 'utf8'); } catch { return; }
  let evt;
  try { evt = JSON.parse(data); } catch { return; }
  if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(evt.tool_name)) return;
  const input = evt.tool_input || {};
  const fp = input.file_path || input.notebook_path;
  if (!fp) return;
  const p = normalize(fp);
  const h = findHeld(p);
  if (!h) return;
  const m = readMeta(h.key);
  const who = m && m.owner ? m.owner : '?';
  if (who === owner()) return;
  const note = m && m.note ? ` — ${m.note}` : '';
  console.error(`[xteam] 冲突/conflict: ${p} 正被 held by ${displayName(who)}${note}。请勿修改此文件——去改别的文件，或先协调（xteam status 看锁/群聊）。Do NOT edit — switch to another file or coordinate first (xteam status).`);
}

function acquire(p, opts) {
  p = normalize(p);
  registerPresence();
  if (opts.label) applyLabel(owner(), opts.label);
  const key = lockDir(p);
  fs.mkdirSync(LOCKS, { recursive: true });
  try {
    fs.mkdirSync(key);
  } catch (e) {
    if (e.code === 'EEXIST') {
      report(p, key);
      return;
    }
    throw e;
  }
  const t = nowSec();
  const meta = { path: p, owner: opts.owner || owner(), note: opts.note || '', acquiredAt: t, heartbeatAt: t };
  writeMetaAtomic(key, meta);
  console.log(`ACQUIRED: ${p} (owner=${displayName(meta.owner)})  / 已加锁`);
}

function release(p) {
  p = normalize(p);
  const key = lockDir(p);
  if (fs.existsSync(key)) {
    fs.rmSync(key, { recursive: true, force: true });
    console.log(`RELEASED: ${p}  / 已放锁`);
    const queue = listWaiters(p).filter((w) => w.owner !== owner());
    if (queue.length) {
      const names = queue.map((w) => displayName(w.owner));
      console.log(`  -> ${queue.length} 个会话在等这把锁 / ${queue.length} session(s) waiting: ${names.join(', ')}`);
      say(`${p} 已放锁，${names.map((n) => `@${n}`).join(' ')} 可以上了 / released ${p}, you're clear to go`, {});
      console.log(`  已在群聊 @ 通知 / notified them in chat`);
    }
  } else {
    console.log(`NOT HELD: ${p}  / 未占用`);
  }
}

function heartbeat(p) {
  p = normalize(p);
  const key = lockDir(p);
  const m = readMeta(key);
  if (!m) {
    console.log(`NOT HELD: ${p}`);
    return;
  }
  m.heartbeatAt = nowSec();
  writeMetaAtomic(key, m);
  console.log(`HEARTBEAT: ${p}  / 已续期`);
}

function waiterDir(p, who) {
  const h = createHash('sha1').update(`${p} ${who}`).digest('hex');
  return path.join(WAITERS, h);
}
function addWaiter(p, who, note) {
  const key = waiterDir(p, who);
  const t = nowSec();
  writeMetaAtomic(key, { path: p, owner: who, note: note || '', since: t, heartbeatAt: t });
}
function dropWaiter(p, who) {
  fs.rmSync(waiterDir(p, who), { recursive: true, force: true });
}
function listWaiters(p) {
  if (!fs.existsSync(WAITERS)) return [];
  const now = nowSec();
  return fs.readdirSync(WAITERS)
    .map((d) => readMeta(path.join(WAITERS, d)))
    .filter(Boolean)
    .filter((w) => now - (w.heartbeatAt || 0) <= TTL)
    .filter((w) => !p || w.path === p || p.startsWith(`${w.path}/`) || w.path.startsWith(`${p}/`));
}

function sleepSync(sec) {
  // Block without a busy loop: Atomics.wait on a throwaway SharedArrayBuffer.
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, sec * 1000);
}

function wait(p, opts) {
  p = normalize(p);
  const me = opts.owner || owner();
  registerPresence();
  if (opts.label) applyLabel(me, opts.label);

  const held = findHeld(p);
  if (!held) {
    console.log(`FREE: ${p}   (无需等待 / no wait needed)`);
    return acquire(p, opts);
  }

  addWaiter(p, me, opts.note);
  const m = readMeta(held.key);
  const blocker = m && m.owner ? m.owner : '?';
  console.log(`WAITING: ${p} — 被 ${displayName(blocker)} 锁着 / held by ${displayName(blocker)}`);
  say(`@${displayName(blocker)} 我在等 ${p} 的锁${opts.note ? `（${opts.note}）` : ''}，你放锁后我立刻接手 / waiting on ${p}, will take it the moment you release`, { owner: me });
  console.log(`  轮询中，每 ${WAIT_POLL}s 一次，最多 ${WAIT_MAX}s / polling every ${WAIT_POLL}s, up to ${WAIT_MAX}s`);

  const deadline = nowSec() + WAIT_MAX;
  for (;;) {
    sleepSync(WAIT_POLL);
    const cur = findHeld(p);
    if (!cur) {
      dropWaiter(p, me);
      console.log(`FREED: ${p} — 锁已释放，正在接手 / released, acquiring now`);
      return acquire(p, opts);
    }
    const cm = readMeta(cur.key);
    const idle = nowSec() - ((cm && cm.heartbeatAt) || 0);
    if (idle > TTL) {
      dropWaiter(p, me);
      console.log(`STALE: ${p} — 持有者 ${displayName((cm && cm.owner) || '?')} 已过期 (idle=${idle}s) / holder went stale`);
      console.log(`  用 xteam takeover ${p} 接管 / run xteam takeover ${p} to take it over`);
      return;
    }
    addWaiter(p, me, opts.note);   // keep our waiter entry fresh
    if (nowSec() >= deadline) {
      console.log(`TIMEOUT: ${p} 仍被 ${displayName((cm && cm.owner) || '?')} 锁着 (等了 ${WAIT_MAX}s) / still held after ${WAIT_MAX}s`);
      console.log(`  等待登记已保留，可再次 xteam wait ${p} / waiter entry kept; run xteam wait again`);
      return;
    }
  }
}

function takeover(p, opts) {
  p = normalize(p);
  const key = lockDir(p);
  const m = readMeta(key);
  if (m) {
    const idle = nowSec() - (m.heartbeatAt || 0);
    if (idle <= TTL) {
      report(p, key);
      console.log(`takeover refused: lock still active (idle=${idle}s). Release it or wait for it to go stale.`);
      return;
    }
    fs.rmSync(key, { recursive: true, force: true });
    console.log(`takeover: cleared stale lock on ${p}  / 已清除过期锁`);
  }
  acquire(p, opts);
}

function listLocks() {
  if (!fs.existsSync(LOCKS)) return [];
  return fs.readdirSync(LOCKS)
    .map((d) => readMeta(path.join(LOCKS, d)))
    .filter(Boolean);
}

function listPresence() {
  if (!fs.existsSync(PRESENCE)) return [];
  return fs.readdirSync(PRESENCE)
    .map((d) => readMeta(path.join(PRESENCE, d)))
    .filter(Boolean);
}

function chatTail(n) {
  if (!fs.existsSync(CHAT)) return [];
  const lines = fs.readFileSync(CHAT, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-n);
}

function fmtIdle(idle) {
  if (idle < 60) return `${idle}s`;
  if (idle < 3600) return `${Math.floor(idle / 60)}m${idle % 60}s`;
  return `${Math.floor(idle / 3600)}h${Math.floor((idle % 3600) / 60)}m`;
}

function status() {
  const me = registerPresence();
  const locks = listLocks();
  const pres = listPresence();
  const chat = chatTail(STATUS_CHAT);
  const now = nowSec();

  const heldBy = {};
  for (const m of locks) {
    const o = m.owner || '?';
    (heldBy[o] = heldBy[o] || []).push(m.path);
  }
  const active = pres.filter((p) => now - (p.lastSeenAt || 0) <= TTL);

  console.log(`xteam: ${active.length} session(s) · ${locks.length} lock(s) · chat ${chat.length}  (${active.length} 会话 · ${locks.length} 锁 · 聊天 ${chat.length})`);
  console.log(`  【铁律/MUST】编辑任何文件前先 xteam acquire <path> 加锁；改完 xteam release；进度 xteam say。没锁就编辑 = 裸奔，别人分不清是谁改的。`);
  console.log(`  [MUST] Lock before editing: xteam acquire <path>; release when done; post progress via xteam say.`);

  for (const p of active) {
    const o = p.owner;
    const idle = now - (p.lastSeenAt || 0);
    const isMe = o === me;
    const held = heldBy[o] || [];
    const heldStr = held.length ? held.join(', ') : '-';
    console.log(`  [session] ${displayName(o)}${isMe ? ' [you/你]' : ''}  idle ${fmtIdle(idle)}  holding/占用: ${heldStr}`);
  }
  for (const m of locks) {
    if (active.some((p) => p.owner === m.owner)) continue; // already shown under its session
    const idle = now - (m.heartbeatAt || 0);
    const stale = idle > TTL ? ' (STALE)' : '';
    console.log(`  [lock] ${m.path}  owner=${displayName(m.owner)}  idle=${fmtIdle(idle)}${stale}${m.note ? ` (${m.note})` : ''}`);
  }
  for (const l of chat) console.log(`  [xteam#chat] ${l}`);

  const queue = listWaiters(null);
  for (const w of queue) {
    console.log(`  [waiting] ${displayName(w.owner)} 在等 ${w.path}${w.note ? ` (${w.note})` : ''}  / waiting on ${w.path}`);
  }
  const mine = queue.filter((w) => w.owner === me);
  if (mine.length) {
    console.log(`  -> 你在等 ${mine.map((w) => w.path).join(', ')}；用 xteam wait <path> 阻塞等待并自动接手 / you're queued; xteam wait auto-acquires on release`);
  }

  const others = active.filter((p) => p.owner !== me);
  if (others.length) {
    console.log(`  -> 现场还有 ${others.length} 个会话 / ${others.length} other session(s): ${others.map((p) => displayName(p.owner)).join(', ')}`);
    console.log(`    相关就 xteam say 接洽，别重复做 / if related, reach out via xteam say rather than duplicating.`);
  }
  if (locks.length === 0) {
    console.log(`  -> 无锁，可自由编辑 / no locks, safe to edit. 协议/protocol: check -> acquire -> edit -> release`);
  }
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function say(msg, opts) {
  const who = (opts && opts.owner) || owner();
  registerPresence();
  if (opts && opts.label) applyLabel(who, opts.label);
  const name = displayName(who);
  const line = `[${ts()}] ${name}: ${msg}`;
  fs.mkdirSync(COORD, { recursive: true });
  fs.appendFileSync(CHAT, line + '\n');
  rotate();
  console.log(`SAID: ${line}`);
}

function rotate() {
  if (!fs.existsSync(CHAT)) return;
  const all = fs.readFileSync(CHAT, 'utf8').split('\n').filter(Boolean);
  if (all.length > LOG_MAX) {
    fs.writeFileSync(CHAT, all.slice(-LOG_MAX).join('\n') + '\n');
  }
}

function tailCmd(n) {
  const k = Number(n) || 20;
  const lines = chatTail(k);
  if (lines.length === 0) {
    console.log('xteam#chat: no messages yet  / 暂无消息');
    return;
  }
  console.log(`xteam#chat: last ${lines.length} message(s)  / 最近 ${lines.length} 条`);
  for (const l of lines) console.log(`  ${l}`);
}

function setLabel(text) {
  const who = owner();
  registerPresence();
  applyLabel(who, text);
  console.log(`LABEL: ${who}-${text}  / 已命名`);
}

// ——— version & self-update ———
async function download(rel) {
  const res = await fetch(`${REPO_RAW}/${rel}`);
  if (!res.ok) throw new Error(`download ${rel} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function extractVersion(src) {
  const m = src.match(/const VERSION = '([^']+)'/);
  return m ? m[1] : null;
}

function versionCmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function showVersion() {
  console.log(`xteam v${VERSION}`);
}

async function update() {
  console.log(`xteam: 当前 / current v${VERSION}，检查 GitHub 最新版本 / checking...`);
  let remoteSrc;
  let remoteVer;
  try {
    remoteSrc = (await download('xteam.mjs')).toString('utf8');
    remoteVer = extractVersion(remoteSrc);
  } catch (e) {
    console.log(`xteam: 检查失败 / check failed: ${e.message}`);
    return;
  }
  if (!remoteVer) {
    console.log('xteam: 无法识别远程版本 / cannot read remote version.');
    return;
  }
  const targets = [
    ['SKILL.md', path.join(SKILL_DIR, 'SKILL.md')],
    ['xteam.mjs', path.join(SKILL_DIR, 'xteam.mjs')],
    ['commands/xteam.md', path.join(COMMAND_DIR, 'xteam.md')],
  ];

  const newer = versionCmp(remoteVer, VERSION) > 0;
  const changed = [];
  for (const [rel, dst] of targets) {
    const data = rel === 'xteam.mjs' ? Buffer.from(remoteSrc, 'utf8') : await download(rel);
    let local = null;
    try { local = fs.readFileSync(dst); } catch {}
    if (!local || !local.equals(data)) changed.push([rel, dst, data]);
  }

  if (!changed.length) {
    console.log(`xteam: 已是最新 / up to date (v${VERSION}).`);
    return;
  }
  if (!newer) {
    // Same version number, but docs//script drifted (e.g. a docs-only release).
    console.log(`xteam: 版本号相同 (v${VERSION})，但有 ${changed.length} 个文件有更新 / same version, ${changed.length} file(s) changed.`);
  }
  for (const [rel, dst, data] of changed) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, data);
    console.log(`  更新 / updated: ${rel}`);
  }
  console.log(newer
    ? `xteam: 已更新到 / updated to v${remoteVer} (from v${VERSION}).`
    : `xteam: 已同步最新文件 / synced latest files (v${VERSION}).`);
  console.log('       钩子/status 立即生效；SKILL.md 指令请新开对话加载。');
}

function help() {
  console.log(`xteam v${VERSION} — cross-session file coordination + group chat
        跨会话文件协调 + 群聊

Commands / 子命令:
  xteam status                       查看所有会话+锁+聊天 / show all sessions, locks & chat
  xteam check <path>                 路径是否被占用 / is the path locked?
  xteam acquire <path> [--note N] [--owner O] [--label L]   加锁(含子目录) / lock file or dir (+subtree)
  xteam release <path>               放锁(并 @ 通知等待者) / release (+ notify waiters)
  xteam wait <path> [--note N]       阻塞等锁，一放开自动接手 / block until free, then auto-acquire
  xteam heartbeat <path>             续期 / refresh a lock
  xteam takeover <path>              接管过期锁 / clear & re-acquire a stale lock
  xteam label <名称>                 给本会话起名(显示为 <id>-<名称>) / name this session
  xteam say <message> [--label L]    发到群聊 / post to group chat
  xteam tail [N]                     最近 N 条聊天 / last N chat lines (default 20)
  xteam update                       更新到最新 GitHub 版本 / update to latest GitHub release
  xteam version                      版本号 / version
  xteam help                         本帮助 / this help

State / 状态目录: <repo>/.claude/xteam/  (locks/ + presence/ + waiters/ + chat.log; gitignored)
Owner / 身份:     自动取自当前会话 (auto-detected from session); --owner 或 XTEAM_OWNER 覆盖
Label / 名字:     用 \`xteam label\` 或 \`--label\` 或 XTEAM_LABEL 设置，显示为 <id>-<名字>
TTL / 过期:       ${TTL}s (XTEAM_TTL); 日志上限 ${LOG_MAX} 条 (XTEAM_LOG_MAX)
Wait / 等锁:      轮询 ${WAIT_POLL}s (XTEAM_WAIT_POLL)，上限 ${WAIT_MAX}s (XTEAM_WAIT_MAX)

默认已启用 / enabled by default: 会话启动时自动运行 \`xteam status\` 输出所有会话状态。
Default: the SessionStart hook auto-runs \`xteam status\` to show every session's state.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const opts = { owner: null, note: null, label: null };
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--owner' && rest[i + 1]) { opts.owner = rest[i + 1]; i++; }
    else if (rest[i] === '--note' && rest[i + 1]) { opts.note = rest[i + 1]; i++; }
    else if (rest[i] === '--label' && rest[i + 1]) { opts.label = rest[i + 1]; i++; }
    else pos.push(rest[i]);
  }
  switch (cmd) {
    case 'check': return check(pos[0] || '');
    case 'acquire': return acquire(pos[0] || '', opts);
    case 'release': return release(pos[0] || '');
    case 'wait': return wait(pos[0] || '', opts);
    case 'heartbeat': return heartbeat(pos[0] || '');
    case 'takeover': return takeover(pos[0] || '', opts);
    case 'list':
    case 'status': return status();
    case 'label': return setLabel(pos.join(' '));
    case 'say':
    case 'log':
    case 'chat': return say(pos.join(' '), opts);
    case 'tail': return tailCmd(pos[0]);
    case 'preedit': return preedit();
    case 'update':
    case 'upgrade': return await update();
    case 'version':
    case '-v':
    case '--version': return showVersion();
    case 'help':
    case '-h':
    case '--help':
    default: return help();
  }
}

main().catch((e) => console.log(`xteam: error: ${e.message}`));
