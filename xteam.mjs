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

import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.4.0';
const REPO_RAW = 'https://raw.githubusercontent.com/ji4ozhu/xteam/main';
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));   // ~/.claude/skills/xteam
const SKILL_DIR = SELF_DIR;
const COMMAND_DIR = path.join(os.homedir(), '.claude', 'commands');

const TTL = Number(process.env.XTEAM_TTL || 2700);               // seconds
const LOG_MAX = Number(process.env.XTEAM_LOG_MAX || 200);        // chat log rotation
const STATUS_CHAT = Number(process.env.XTEAM_STATUS_CHAT || 5);  // chat lines in `status`
const WAIT_POLL = Number(process.env.XTEAM_WAIT_POLL || 5);      // seconds between wait polls
const WAIT_MAX = Number(process.env.XTEAM_WAIT_MAX || 900);      // max seconds for `wait`

// ——— i18n：按系统语言渲染输出 ———
// 内置中英默认模板（无 AI 也完整可用）；其他语言首次使用时调 LLM 翻译一次，
// 结果带 sourceHash 落盘 i18n/<lang>.json —— 源模板不变就永不再翻（省 token）。
// XTEAM_LANG 显式覆盖；help 文档与群聊消息内容不翻译（命令名翻坏会出事）。
const MSG = {
  acquired: ['已加锁', 'acquired'],
  released: ['已放锁', 'released'],
  not_held: ['未占用', 'not held'],
  already_held_by_you: ['这把锁就是你自己的，无需重复加锁', 'already held by you, no need to re-acquire'],
  refused_not_yours: ['REFUSED: {path} — 这把锁属于 {owner}，你无权释放', 'REFUSED: {path} — this lock belongs to {owner}, not yours to release'],
  refused_force_hint: ['  确需强制释放用 xteam release <path> --force（先在群聊协调）', '  force with: xteam release <path> --force (coordinate in chat first)'],
  free: ['FREE: {path}   (可编辑)', 'FREE: {path}   (safe to edit)'],
  free_no_wait: ['FREE: {path}   (无需等待)', 'FREE: {path}   (no wait needed)'],
  held_head: ['HELD: {via}', 'HELD: {via}'],
  held_owner: ['owner={owner}, idle={idle}s', 'owner={owner}, idle={idle}s'],
  held_tag_orphaned: [' (无主/ORPHANED)', ' (ORPHANED)'],
  held_tag_gone: [' (会话已退出/session gone)', ' (session gone)'],
  held_note: [' — {note}', ' — {note}'],
  queue_waiting: ['  队列: {names}', '  waiting: {names}'],
  hint_takeover_safe: ['  持有者会话已消失，可安全接管：', '  owner session is gone — safe to take over:'],
  hint_owner_alive: ['  持有者仍在线（可能正在长时间落盘）。别抢 —— 后台 xteam wait {path} 排队', '  owner is ALIVE (maybe a long write). Don\'t take it; queue with: xteam wait {path}'],
  hint_gone_wait: ['  持有者会话已退出但锁未过期，{in} 后可接管；或后台 xteam wait {path} 自动接手', '  session gone; takeover in {in}, or queue with: xteam wait {path}'],
  warn_git_identity: ['  [warn] 当前身份来自 git user.name（非会话唯一），同名多进程会撞车——建议设 XTEAM_OWNER', '  [warn] identity from git user.name (not session-unique); set XTEAM_OWNER to stay unique'],
  waiting_on: ['WAITING: {path} — 被 {owner} 锁着', 'WAITING: {path} — held by {owner}'],
  polling: ['  轮询中，每 {poll}s 一次，最多 {max}s', '  polling every {poll}s, up to {max}s'],
  freed: ['FREED: {path} — 锁已释放，正在接手', 'FREED: {path} — released, acquiring now'],
  orphaned_notice: ['ORPHANED: {path} — 持有者 {owner} 的会话已消失 (idle={idle}s)', 'ORPHANED: {path} — owner {owner} session is gone (idle={idle}s)'],
  safe_takeover_cmd: ['  可安全接管：xteam takeover {path}', '  safe to take over: xteam takeover {path}'],
  timeout_still_held: ['TIMEOUT: {path} 仍被 {owner} 锁着 (等了 {max}s)', 'TIMEOUT: {path} still held by {owner} after {max}s'],
  waiter_kept: ['  等待登记已保留，可再次 xteam wait {path}', '  waiter entry kept; run xteam wait {path} again'],
  takeover_alive: ['takeover 拒绝：持有者会话仍在线（idle={idle}s）。长时间落盘也会这样——别抢。', 'takeover refused: owner session is still ALIVE. A long write looks like this too — don\'t steal it.'],
  takeover_alive_hint: ['  先 xteam say 问一句，或后台 xteam wait {path} 排队', '  ask via xteam say, or queue with: xteam wait {path}'],
  takeover_notyet: ['takeover 拒绝：持有者会话已退出，但锁还有 {in} 才过期', 'takeover refused: owner gone but lock not expired for {in}'],
  takeover_notyet_hint: ['  后台 xteam wait {path} 会在到期后自动提示接管', '  background xteam wait {path} will tell you when it\'s takeable'],
  takeover_cleared: ['takeover: 持有者会话已消失，清除无主锁 {path}', 'takeover: cleared orphaned lock {path} (owner session gone)'],
  release_all_none: ['NOT HELD: 本会话没有持有任何锁', 'NOT HELD: you hold no locks'],
  released_all: ['RELEASED ALL: {n} 个锁已放', 'RELEASED ALL: released {n} lock(s)'],
  waiting_count: ['  -> {n} 个会话在等这把锁: {names}', '  -> {n} session(s) waiting: {names}'],
  notified_chat: ['  已在群聊 @ 通知', '  notified them in chat'],
  heartbeated: ['HEARTBEAT: {path}  / 已续期', 'HEARTBEAT: {path}  / refreshed'],
  preedit_conflict: ['[xteam] 冲突/conflict: {path} 正被 {owner} 持有{note}。请勿修改此文件——去改别的文件，或先协调（xteam status 看锁/群聊）。', '[xteam] CONFLICT: {path} is held by {owner}{note}. Do NOT edit — switch to another file or coordinate first (xteam status).'],
  st_sessions: ['会话', 'sessions'],
  st_locks: ['锁', 'locks'],
  st_chat: ['聊天', 'chat'],
  st_you: ['[you]', '[you]'],
  st_holding: ['占用', 'holding'],
  st_waiting_on: ['在等', 'waiting on'],
  st_none: ['-', '-'],
  st_orphaned_tag: [' (无主，可接管)', ' (ORPHANED, safe to take over)'],
  st_gone_tag: [' (会话已退出)', ' (session gone)'],
  st_must_lock: ['  【铁律】编辑任何文件前先 xteam acquire <path> 加锁；改完 xteam release；进度 xteam say。没锁就编辑 = 裸奔。', '  [MUST] Lock before editing: xteam acquire <path>; release when done; post progress via xteam say.'],
  st_orphans_hint: ['  -> {n} 个无主锁（持有者会话已消失），可 xteam takeover 接管', '  -> {n} orphaned lock(s), safe to take over:'],
  st_released_you: ['已放锁，{names} 可以上了', 'released, {names} you\'re clear to go'],
  st_waiting_you: ['我在等 {path} 的锁{note}，你放锁后我立刻接手', 'waiting on {path}{note}, will take it the moment you release'],
  st_other_sessions: ['  -> 现场还有 {n} 个会话: {names}', '  -> {n} other session(s) here: {names}'],
  st_reach_out: ['    相关就 xteam say 接洽，别重复做', '    if related, reach out via xteam say rather than duplicating'],
  st_no_locks: ['  -> 无锁，可自由编辑。协议: check -> acquire -> edit -> release', '  -> no locks, safe to edit. protocol: check -> acquire -> edit -> release'],
  st_waiting_you_queued: ['  -> 你在等 {paths}；用 xteam wait <path> 阻塞等待并自动接手', '  -> you\'re queued for {paths}; xteam wait <path> auto-acquires on release'],
  bridge_parked: ['[bridge] @{me} 驻场（跨模型桥，@{me} 或 @{name} 提问必回，模型 {model}）', '[bridge] @{me} parked (cross-model bridge; @{me} or @{name} mentions get replies; model {model})'],
  sl_head: ['xteam {a}会话·{l}锁·聊{c}', 'xteam {a}sessions·{l}locks·chat{c}'],
  sl_mine_locks: ['我锁{n}', 'I hold {n}'],
  sl_no_locks: ['我无锁', 'I hold none'],
  sl_orphans: ['无主{n}', '{n} orphaned'],
  sl_others: ['{n}会话在跑', '{n} sessions running'],
  wake_all: ['@全体 进展检查（第{n}次）：请各会话 xteam say 一句当前进展（在做什么 / 还差多久 / 是否卡住）', '@all progress check #{n}: please xteam say your status (doing / ETA / stuck?)'],
  wake_online: ['在线：{names}', 'online: {names}'],
  wake_idle: ['长时间无响应：{names}', 'unresponsive: {names}'],
  wake_none: ['（暂无其他在线会话）', '(no other sessions online)'],
  models_cli: ['CLI 路由（XTEAM_CLI_*）', 'CLI routes (XTEAM_CLI_*)'],
  models_api: ['API 模型（{base}）', 'API models ({base})'],
  models_default: ['默认 spec: {spec}', 'default spec: {spec}'],
  models_none: ['（无）', '(none)'],
  models_api_fail: ['API 枚举失败: {reason}', 'API listing failed: {reason}'],
  models_hint: ['cli 后端的模型由各 CLI 自己决定（codex：模板里 -m <model> 指定）', 'cli backend models depend on the CLI itself (codex: -m <model> in the template)'],
};
const MSG_KEYS = Object.keys(MSG);
function msgEnTable() {
  const o = {};
  for (const k of MSG_KEYS) o[k] = MSG[k][1];
  return o;
}

let _lang = null;
function detectLang() {
  if (_lang) return _lang;
  const raw = (process.env.XTEAM_LANG || Intl.DateTimeFormat().resolvedOptions().locale || 'en').toLowerCase();
  _lang = raw.split(/[-_]/)[0] || 'en';
  return _lang;
}

function fmtMsg(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m));
}

function i18nPackPath(lang) {
  return path.join(SELF_DIR, 'i18n', `${lang}.json`);
}

// 缓存命中则零成本；未命中同步派生子进程翻译（子进程内可 async 调 api/cli 后端）。
// sourceHash 锁定源模板：模板不变永不重翻；翻译不可用时回退英文（ASCII 安全）。
function ensurePack(lang) {
  const file = i18nPackPath(lang);
  const srcHash = createHash('sha1').update(JSON.stringify(msgEnTable())).digest('hex').slice(0, 16);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.sourceHash === srcHash && j.strings && typeof j.strings === 'object') return j.strings;
  } catch {}
  try {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'i18n-gen', lang], {
      encoding: 'utf8', timeout: 180 * 1000, stdio: ['ignore', 'ignore', 'ignore'],
    });
    if (r.status === 0) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && j.sourceHash === srcHash && j.strings) return j.strings;
    }
  } catch {}
  return null; // 回退英文
}

function t(key, vars) {
  const lang = detectLang();
  const entry = MSG[key];
  if (!entry) return fmtMsg(key, vars);
  if (lang === 'zh') return fmtMsg(entry[0], vars);
  if (lang === 'en') return fmtMsg(entry[1], vars);
  const pack = ensurePack(lang);
  return fmtMsg((pack && pack[key]) || entry[1], vars);
}

// 内部命令：翻译 MSG 英文源到目标语言并落盘（ask/bridge 同一套 LLM 后端）。
// 要求 XTEAM_LLM_MODEL 或 XTEAM_CLI_<NAME> 任一可用；都不配则 exit 1（父进程回退英文）。
async function i18nGen(lang) {
  const en = msgEnTable();
  const prompt = `You are a software localization expert. Translate the JSON values into ${lang}. ` +
    `Keep keys and {placeholders} unchanged. Output ONLY a JSON object (same keys). ` +
    `Style: terse CLI status lines. Input:\n${JSON.stringify(en)}`;
  let spec = process.env.XTEAM_LLM_MODEL || null;
  if (!spec) {
    const cliKey = Object.keys(process.env).find((k) => k.startsWith('XTEAM_CLI_'));
    if (cliKey) spec = 'cli:' + cliKey.slice('XTEAM_CLI_'.length).toLowerCase();
  }
  if (!spec && process.env.XTEAM_LLM_API_KEY) spec = 'api:gpt-4o-mini';
  if (!spec) {
    console.error('i18n-gen: 需要 XTEAM_LLM_MODEL 或 XTEAM_CLI_* 配置才能翻译');
    process.exit(1);
  }
  const out = await llmCall(spec, prompt, 150);
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) { console.error('i18n-gen: 翻译输出不是 JSON'); process.exit(1); }
  const strings = JSON.parse(m[0]);
  const srcHash = createHash('sha1').update(JSON.stringify(en)).digest('hex').slice(0, 16);
  const file = i18nPackPath(lang);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ lang, sourceHash: srcHash, model: spec, strings }, null, 2) + '\n');
  console.log(`i18n-gen: ${lang} -> ${file} (${MSG_KEYS.length} strings)`);
}

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

// 身份来源：'env'/'session' 唯一可信；'git' fallback 可能被多个无 session 进程共享（撞车）。
function ownerSource() {
  if (process.env.XTEAM_OWNER) return 'env';
  if (process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID) return 'session';
  try {
    const n = execSync('git config user.name', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (n) return 'git';
  } catch {}
  return 'none';
}

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

// Windows 路径不区分大小写：做 key 时归一，避免 "A.txt"/"a.txt" 被算成两把锁。
function lockKey(p) {
  return process.platform === 'win32' ? String(p).toLowerCase() : String(p);
}

function lockDir(p) {
  const h = createHash('sha1').update(lockKey(p)).digest('hex');
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
  const t0 = nowSec();
  let m = readMeta(key);
  if (!m) m = { owner: who, startedAt: t0 };
  if (!m.label && process.env.XTEAM_LABEL) m.label = process.env.XTEAM_LABEL;
  m.lastSeenAt = t0;
  writeMetaAtomic(key, m);
  renewOwnLocks();
  return who;
}

function report(p, key, via) {
  const m = readMeta(key);
  const who = m && m.owner ? m.owner : '?';
  const st = m ? lockState(m) : { tag: 'orphaned', idle: 0, alive: false };
  const viaStr = via && via !== p ? ` [via ${via}]` : '';
  const note = m && m.note ? t('held_note', { note: m.note }) : '';
  const tag = st.tag === 'orphaned' ? t('held_tag_orphaned') : st.alive ? '' : t('held_tag_gone');
  console.log(`${t('held_head', { via: p + viaStr })} — ${t('held_owner', { owner: displayName(who), idle: st.idle })}${tag}${note}`);
  const queue = listWaiters(p);
  if (queue.length) {
    console.log(t('queue_waiting', { names: queue.map((w) => displayName(w.owner)).join(', ') }));
  }
  if (st.tag === 'orphaned') {
    console.log(t('hint_takeover_safe'));
    console.log(`    xteam takeover ${p}`);
  } else if (st.alive) {
    console.log(t('hint_owner_alive', { path: p }));
  } else {
    console.log(t('hint_gone_wait', { in: fmtIdle(TTL - st.idle), path: p }));
  }
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
  else console.log(t('free', { path: p }));
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
  // git fallback 身份不放行"自己"的锁：同 user.name 的多个无 session 进程会撞成同一 owner，
  // 静默放行等于防冲突失效。宁可让同名本人看到一次误报警告。
  if (who === owner() && ownerSource() !== 'git') return;
  const note = m && m.note ? t('held_note', { note: m.note }) : '';
  console.error(t('preedit_conflict', { path: p, owner: displayName(who), note }));
}

function acquire(p, opts) {
  p = normalize(p);
  registerPresence();
  if (opts.label) applyLabel(owner(), opts.label);
  if (ownerSource() === 'git') {
    console.log(t('warn_git_identity'));
  }
  const key = lockDir(p);
  fs.mkdirSync(LOCKS, { recursive: true });
  try {
    fs.mkdirSync(key);
  } catch (e) {
    if (e.code === 'EEXIST') {
      const m = readMeta(key);
      if (m && m.owner === owner()) {
        console.log(`ALREADY HELD BY YOU: ${p}  / ${t('already_held_by_you')}`);
        return;
      }
      report(p, key);
      return;
    }
    throw e;
  }
  const t0 = nowSec();
  const meta = { path: p, owner: opts.owner || owner(), note: opts.note || '', acquiredAt: t0, heartbeatAt: t0 };
  writeMetaAtomic(key, meta);
  console.log(`ACQUIRED: ${p} (owner=${displayName(meta.owner)})  / ${t('acquired')}`);
}

function release(p, opts) {
  p = normalize(p);
  const key = lockDir(p);
  if (fs.existsSync(key)) {
    const m = readMeta(key);
    const who = m && m.owner ? m.owner : '?';
    // P0 防护：只允许放自己的锁，--force 是显式逃生口。否则任何会话一声 release
    // 就能抹掉别人的锁，防冲突承诺失效。
    if (who !== owner() && !(opts && opts.force)) {
      console.log(t('refused_not_yours', { path: p, owner: displayName(who) }));
      console.log(t('refused_force_hint'));
      return;
    }
    fs.rmSync(key, { recursive: true, force: true });
    console.log(`RELEASED: ${p}  / ${t('released')}`);
    const queue = listWaiters(p).filter((w) => w.owner !== owner());
    if (queue.length) {
      const names = queue.map((w) => displayName(w.owner));
      console.log(t('waiting_count', { n: queue.length, names: names.join(', ') }));
      say(`${p} ${t('st_released_you', { names: names.map((n) => `@${n}`).join(' ') })}`, {});
      console.log(t('notified_chat'));
    }
  } else {
    console.log(`NOT HELD: ${p}  / ${t('not_held')}`);
  }
}

function releaseAll() {
  const me = owner();
  const mine = [];
  for (const d of fs.existsSync(LOCKS) ? fs.readdirSync(LOCKS) : []) {
    const m = readMeta(path.join(LOCKS, d));
    if (m && m.owner === me) mine.push(m.path);
  }
  if (!mine.length) {
    console.log(t('release_all_none'));
    return;
  }
  for (const p of mine) release(p);
  console.log(t('released_all', { n: mine.length }));
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
  console.log(t('heartbeated', { path: p }));
}

function waiterDir(p, who) {
  const h = createHash('sha1').update(`${lockKey(p)} ${who}`).digest('hex');
  return path.join(WAITERS, h);
}
function addWaiter(p, who, note) {
  const key = waiterDir(p, who);
  const t0 = nowSec();
  writeMetaAtomic(key, { path: p, owner: who, note: note || '', since: t0, heartbeatAt: t0 });
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
    console.log(t('free_no_wait', { path: p }));
    return acquire(p, opts);
  }

  addWaiter(p, me, opts.note);
  const m = readMeta(held.key);
  const blocker = m && m.owner ? m.owner : '?';
  console.log(t('waiting_on', { path: p, owner: displayName(blocker) }));
  say(`@${displayName(blocker)} ${t('st_waiting_you', { path: p, note: opts.note ? `（${opts.note}）` : '' })}`, { owner: me });
  console.log(t('polling', { poll: WAIT_POLL, max: WAIT_MAX }));

  const deadline = nowSec() + WAIT_MAX;
  for (;;) {
    sleepSync(WAIT_POLL);
    const cur = findHeld(p);
    if (!cur) {
      dropWaiter(p, me);
      console.log(t('freed', { path: p }));
      return acquire(p, opts);
    }
    const cm = readMeta(cur.key);
    const st = cm ? lockState(cm) : { tag: 'orphaned', idle: 0, alive: false };
    if (st.tag === 'orphaned') {
      dropWaiter(p, me);
      console.log(t('orphaned_notice', { path: p, owner: displayName((cm && cm.owner) || '?'), idle: st.idle }));
      console.log(t('safe_takeover_cmd', { path: p }));
      return;
    }
    addWaiter(p, me, opts.note);   // keep our waiter entry fresh
    if (nowSec() >= deadline) {
      console.log(t('timeout_still_held', { path: p, owner: displayName((cm && cm.owner) || '?'), max: WAIT_MAX }));
      console.log(t('waiter_kept', { path: p }));
      return;
    }
  }
}

function takeover(p, opts) {
  p = normalize(p);
  const key = lockDir(p);
  const m = readMeta(key);
  if (m) {
    const st = lockState(m);
    if (st.alive) {
      report(p, key);
      console.log(t('takeover_alive', { idle: st.idle }));
      console.log(t('takeover_alive_hint', { path: p }));
      return;
    }
    if (st.tag !== 'orphaned') {
      report(p, key);
      console.log(t('takeover_notyet', { in: fmtIdle(TTL - st.idle) }));
      console.log(t('takeover_notyet_hint', { path: p }));
      return;
    }
    fs.rmSync(key, { recursive: true, force: true });
    console.log(t('takeover_cleared', { path: p }));
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

// Is the session that owns a lock still alive? Presence heartbeats on every
// status/check, so a live session keeps proving itself even while its lock
// sits untouched. Without this, a long edit looks identical to a dead session.
function ownerAlive(who) {
  const m = readMeta(presenceDir(who));
  if (!m) return false;
  return nowSec() - (m.lastSeenAt || 0) <= TTL;
}

// A lock is only safe to take over when its OWNER is gone — not merely when
// the lock itself has sat still. Long work must not look like death.
function lockState(m) {
  const idle = nowSec() - (m.heartbeatAt || 0);
  if (ownerAlive(m.owner)) return { tag: 'held', idle, alive: true };
  if (idle > TTL) return { tag: 'orphaned', idle, alive: false };
  return { tag: 'held', idle, alive: false };
}

// Renew every lock this session holds. Called from status/check, so simply
// working the protocol keeps your locks alive — no discipline required.
function renewOwnLocks() {
  const me = owner();
  const t0 = nowSec();
  let n = 0;
  for (const d of fs.existsSync(LOCKS) ? fs.readdirSync(LOCKS) : []) {
    const key = path.join(LOCKS, d);
    const m = readMeta(key);
    if (!m || m.owner !== me) continue;
    m.heartbeatAt = t0;
    writeMetaAtomic(key, m);
    n++;
  }
  return n;
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

  console.log(`xteam: ${active.length} ${t('st_sessions')} · ${locks.length} ${t('st_locks')} · ${t('st_chat')} ${chat.length}`);
  console.log(t('st_must_lock'));

  for (const p of active) {
    const o = p.owner;
    const idle = now - (p.lastSeenAt || 0);
    const isMe = o === me;
    const held = heldBy[o] || [];
    const heldStr = held.length ? held.join(', ') : t('st_none');
    console.log(`  [session] ${displayName(o)}${isMe ? ' ' + t('st_you') : ''}  idle ${fmtIdle(idle)}  ${t('st_holding')}: ${heldStr}`);
  }
  const orphans = [];
  for (const m of locks) {
    if (active.some((p) => p.owner === m.owner)) continue; // already shown under its session
    const st = lockState(m);
    if (st.tag === 'orphaned') orphans.push(m.path);
    const tag = st.tag === 'orphaned' ? t('st_orphaned_tag') : t('st_gone_tag');
    console.log(`  [lock] ${m.path}  owner=${displayName(m.owner)}  idle=${fmtIdle(st.idle)}${tag}${m.note ? ` (${m.note})` : ''}`);
  }
  if (orphans.length) {
    console.log(t('st_orphans_hint', { n: orphans.length }));
    for (const p of orphans) console.log(`     xteam takeover ${p}`);
  }
  for (const l of chat) console.log(`  [xteam#chat] ${l}`);

  const queue = listWaiters(null);
  for (const w of queue) {
    console.log(`  [waiting] ${displayName(w.owner)} ${t('st_waiting_on')} ${w.path}${w.note ? ` (${w.note})` : ''}`);
  }
  const mine = queue.filter((w) => w.owner === me);
  if (mine.length) {
    console.log(t('st_waiting_you_queued', { paths: mine.map((w) => w.path).join(', ') }));
  }

  const others = active.filter((p) => p.owner !== me);
  if (others.length) {
    console.log(t('st_other_sessions', { n: others.length, names: others.map((p) => displayName(p.owner)).join(', ') }));
    console.log(t('st_reach_out'));
  }
  if (locks.length === 0) {
    console.log(t('st_no_locks'));
  }
}

// One-line summary for the status bar (statusLine). Refreshes after every
// assistant message, so it doubles as a heartbeat for this session.
function statusline() {
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
  const mine = heldBy[me] || [];
  const orphaned = locks.filter((m) => lockState(m).tag === 'orphaned').length;
  const others = active.filter((p) => p.owner !== me).length;
  const seg = [
    t('sl_head', { a: active.length, l: locks.length, c: chat.length }),
    mine.length ? t('sl_mine_locks', { n: mine.length }) : t('sl_no_locks'),
  ];
  if (orphaned) seg.push(t('sl_orphans', { n: orphaned }));
  if (others) seg.push(t('sl_others', { n: others }));
  console.log(seg.join(' | '));
}

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 全局单调消息号：独立 seq 文件 + mkdir 自旋互斥，rotate 截断日志也不重置。
// 内容 hash 去重会漏掉「同样内容说两次」的消息，消息号是唯一可靠游标。
function nextSeq() {
  const seqFile = path.join(COORD, 'chat.seq');
  const guard = seqFile + '.lock';
  fs.mkdirSync(COORD, { recursive: true });
  for (let i = 0; i < 50; i++) {
    try { fs.mkdirSync(guard); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (i === 49) throw new Error('chat.seq busy（序号锁被占超时）');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    let cur = 0;
    try { cur = parseInt(fs.readFileSync(seqFile, 'utf8'), 10) || 0; } catch {} // 首次运行无文件
    fs.writeFileSync(seqFile, String(cur + 1));
    return cur + 1;
  } finally {
    try { fs.rmdirSync(guard); } catch {}
  }
}

function say(msg, opts) {
  const who = (opts && opts.owner) || owner();
  registerPresence();
  if (opts && opts.label) applyLabel(who, opts.label);
  const name = displayName(who);
  const line = `[${ts()} #${nextSeq()}] ${name}: ${msg}`;
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

// ——— cross-model: ask / bridge（api: 或 cli: 后端） ———
// 群聊即共享记忆：外部 agent（codex/cursor/...）无状态也没关系——
// 桥每轮把未读消息喂给它，它的回复贴回群聊，记忆由 chat.log 承载。
// model spec: api:<model> | cli:<name> | <model>（默认 api:）
//   api → OpenAI 兼容 POST {XTEAM_LLM_API_BASE}/chat/completions（Bearer XTEAM_LLM_API_KEY）
//   cli → 环境变量 XTEAM_CLI_<NAME> 命令模板；{text}=prompt 作为独立 argv 元素（不经 shell，安全），
//         {file}=临时文件路径；都无占位则 prompt 走 stdin。复杂命令请包一层 .bat/.sh 再指向它。

function parseModelSpec(spec) {
  const s = String(spec || process.env.XTEAM_LLM_MODEL || '').trim();
  if (!s) return null;
  if (s.startsWith('cli:')) return { kind: 'cli', name: s.slice(4) };
  if (s.startsWith('api:')) return { kind: 'api', name: s.slice(4) };
  return { kind: 'api', name: s };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flatMsg(s) {
  // chat.log 一行一条消息，回复里的换行压平，保住行格式
  return String(s).replace(/\r?\n+/g, ' ⏎ ');
}

function tokenizeTemplate(tpl) {
  const out = [];
  const re = /"[^"]*"|\{text\}|\{file\}|\S+/g;
  let m;
  while ((m = re.exec(tpl))) {
    let tok = m[0];
    if (tok.length >= 2 && tok.startsWith('"') && tok.endsWith('"')) tok = tok.slice(1, -1);
    out.push(tok);
  }
  return out;
}

async function llmApiCall(model, prompt, timeoutSec) {
  const base = (process.env.XTEAM_LLM_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const key = process.env.XTEAM_LLM_API_KEY;
  if (!key) {
    throw new Error('XTEAM_LLM_API_KEY 未设置（set XTEAM_LLM_API_KEY, or use cli: backend）');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), (timeoutSec || 120) * 1000);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM API HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const j = await res.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('LLM API 返回空（empty choices[0].message.content）');
    }
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

function llmCliCall(name, prompt, timeoutSec) {
  const key = 'XTEAM_CLI_' + String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const tpl = process.env[key];
  if (!tpl) {
    throw new Error(`${key} 未设置（set ${key}="cmd {text}" 或 "cmd" 走 stdin）`);
  }
  let tmp = null;
  try {
    const toks = tokenizeTemplate(tpl);
    const args = [];
    let useStdin = true;
    for (const tok of toks) {
      if (tok === '{text}') { args.push(prompt); useStdin = false; }
      else if (tok === '{file}') {
        if (!tmp) {
          tmp = path.join(os.tmpdir(), `xteam-prompt-${process.pid}-${Date.now()}.txt`);
          fs.writeFileSync(tmp, prompt);
        }
        args.push(tmp);
        useStdin = false;
      } else args.push(tok);
    }
    const exe = args.shift();
    if (!exe) throw new Error(`${key} 模板为空`);
    // Windows：npm 装的 CLI 是 .cmd shim，必须经 shell 才能 spawn。shell 会重拼命令行，
    // {text} 自由文本仅纯 ASCII 且不含 % 时安全（cmd 展开 %VAR%，ANSI codepage 会弄坏中文）；
    // 否则请改用 {file} 或 stdin 模板（推荐 `codex exec -s read-only -`，argv 全固定零转义）。
    const needShell = process.platform === 'win32';
    if (needShell && !useStdin && (/[^\x00-\x7F]|%/.test(prompt))) {
      throw new Error(`${key}: Windows 下 {text} 只支持纯 ASCII 且不含 % 的文本；请改用 {file} 或 stdin 模板（如 codex exec -s read-only -）`);
    }
    let r;
    const spawnOpts = {
      input: useStdin ? prompt : undefined,
      timeout: (timeoutSec || 180) * 1000,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    };
    if (needShell) {
      // 单 command 字符串 + shell，args 此时只含模板固定 token（prompt 走 stdin/{file} 或已限制 ASCII），
      // 逐个引号后拼接；避开 DEP0190（args 数组 + shell 只拼接不转义）。
      const cmdLine = [exe, ...args]
        .map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
        .join(' ');
      r = spawnSync(cmdLine, { ...spawnOpts, shell: true });
    } else {
      r = spawnSync(exe, args, spawnOpts);
    }
    if (r.error) {
      if (r.error.code === 'ENOENT') {
        throw new Error(`${key}: 找不到命令 "${exe}"（模板首词须是 PATH 里的命令名或可执行文件绝对路径）`);
      }
      throw r.error;
    }
    if (r.status !== 0) {
      throw new Error(`${key} exit ${r.status}${r.stderr ? ': ' + String(r.stderr).slice(0, 200) : ''}`);
    }
    const out = String(r.stdout || '').trim();
    if (!out) throw new Error(`${key} 无输出（empty stdout）`);
    return out;
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

async function llmCall(spec, prompt, timeoutSec) {
  const p = parseModelSpec(spec);
  if (!p) {
    throw new Error('缺少模型 spec：--model api:<model> 或 cli:<name>（或设 XTEAM_LLM_MODEL）');
  }
  return p.kind === 'cli' ? llmCliCall(p.name, prompt, timeoutSec) : llmApiCall(p.name, prompt, timeoutSec);
}

async function askCmd(args, opts) {
  const prompt = args.join(' ').trim();
  if (!prompt) {
    console.log('usage: xteam ask [--say] [--model <spec>] [--timeout <s>] <prompt>');
    console.log('  spec: api:<model> | cli:<name> | <model>(=api:)  — 详见 xteam help');
    return;
  }
  const spec = opts.model;
  const label = parseModelSpec(spec);
  console.log(`ASK: ${label ? label.kind + ':' + label.name : '(XTEAM_LLM_MODEL)'}`);
  const answer = await llmCall(spec, prompt, opts.timeout || 120);
  if (opts.say) {
    const tag = label ? `${label.kind}:${label.name}` : 'llm';
    say(`[${tag}] Q: ${flatMsg(prompt)} || A: ${flatMsg(answer)}`, {});
  }
  console.log(answer);
}

function parseChatLine(line) {
  // ts 锚定 MM-DD HH:MM 固定宽（ts() 生成），#N 才能可靠从可选组解出——
  // 否则非贪婪会把 #N 吞进 ts、seq 恒 0，新消息全被游标当旧消息跳过。
  // 旧行（无 #N）seq=0，天然被基线跳过。
  const m = line.match(/^\[(\d{2}-\d{2} \d{2}:\d{2})(?: #(\d+))?\] ([^:]+): ([\s\S]*)$/);
  if (!m) return null;
  return { ts: m[1], seq: m[2] ? Number(m[2]) : 0, display: m[3], msg: m[4] };
}

function bridgeStatePath(name) {
  return path.join(COORD, 'bridge', `${String(name).replace(/[^\w.-]/g, '_')}.json`);
}

function loadBridgeState(name) {
  try { return JSON.parse(fs.readFileSync(bridgeStatePath(name), 'utf8')); } catch { return { seen: [] }; }
}

function saveBridgeState(name, st) {
  fs.mkdirSync(path.join(COORD, 'bridge'), { recursive: true });
  fs.writeFileSync(bridgeStatePath(name), JSON.stringify(st));
}

async function bridgeReply(name, me, spec, prompt, timeoutSec) {
  try {
    const answer = await llmCall(spec, prompt, timeoutSec);
    if (/^\(silent\)\s*$/i.test(answer.trim())) return;
    say(`[@${me}] ${flatMsg(answer)}`, { owner: me });
  } catch (e) {
    console.log(`bridge @${me}: ${e.message}`);
  }
}

async function bridgeCmd(args, opts) {
  const name = opts.name;
  if (!name) {
    console.log('usage: xteam bridge --name <n> --model <spec> [--interval <s>] [--no-digest] [--timeout <s>]');
    console.log('  驻场跨模型 agent：@<n> 必回；默认每 <interval>s 汇总未读问一次（无贡献输出 (silent)）');
    return;
  }
  const spec = opts.model;
  const interval = Math.max(5, opts.interval || 60);
  const digestOn = !opts.noDigest;
  const timeoutSec = opts.timeout || 180;
  // 显示名带模型名前缀：<model>-<name>（如 codex-advisor、gpt-5.5-reviewer），
  // 群里一眼看出驻场 agent 背后是哪个模型。不设 label：displayName 会再拼一层。
  const modelLabel = (parseModelSpec(spec) || parseModelSpec(process.env.XTEAM_LLM_MODEL) || { name: 'llm' }).name;
  const me = `${modelLabel}-${name}`;
  // 游标按全局消息号（seq）推进：rotate 截断不重置、同内容两条消息不会被误判已读。
  const st = loadBridgeState(name);
  const maxSeqOf = (ls) => ls.reduce((mx, l) => Math.max(mx, (parseChatLine(l) || {}).seq || 0), 0);
  let lastSeq = st.lastSeq || 0;
  if (!st.lastSeq) {
    // 启动基线：历史消息一律视为已读，只处理启动后的新消息
    const hist = fs.existsSync(CHAT) ? fs.readFileSync(CHAT, 'utf8').split('\n').filter(Boolean) : [];
    lastSeq = maxSeqOf(hist);
    saveBridgeState(name, { lastSeq });
  }

  console.log(`BRIDGE: @${me} 驻场中 (model=${modelLabel}, digest=${digestOn ? interval + 's' : 'off'}, from seq>${lastSeq}, Ctrl+C 退出)`);
  say(t('bridge_parked', { me, name, model: modelLabel }), { owner: me });

  let lastDigest = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const lines = fs.existsSync(CHAT) ? fs.readFileSync(CHAT, 'utf8').split('\n').filter(Boolean) : [];
    const fresh = [];
    for (const line of lines) {
      const p = parseChatLine(line);
      if (!p || p.seq <= lastSeq) continue; // 游标：只收消息号推进后的新消息
      if (p.display === me || p.display.startsWith(`${me}-`)) continue; // 自己发的
      fresh.push(p);
    }
    if (fresh.length) {
      lastSeq = Math.max(lastSeq, ...fresh.map((p) => p.seq));
      saveBridgeState(name, { lastSeq });
    }
    const mentions = fresh.filter((p) => new RegExp(`@(?:${escapeRe(me)}|${escapeRe(name)})\\b`).test(p.msg));
    if (mentions.length) {
      const ctx = lines.slice(-12).join('\n');
      const prompt = `你是群聊驻场 agent "@${me}"（模型 ${modelLabel}）。群聊是多个 AI 协作会话共享的实时通讯（作战室）。最近消息：\n---\n${ctx}\n---\n有人 @ 了你。请以 @${me} 身份回复：简体中文、直接给结论和依据、别客套、几句话为宜。回复会被原样贴进群聊。若不值得回，只输出 (silent)。`;
      await bridgeReply(name, me, spec, prompt, timeoutSec);
      lastDigest = Date.now();
      continue;
    }
    if (digestOn && fresh.length && Date.now() - lastDigest >= interval * 1000) {
      lastDigest = Date.now();
      const ctx = lines.slice(-20).join('\n');
      const prompt = `你是群聊驻场 agent "@${me}"（模型 ${modelLabel}）。以下是群聊新消息：\n---\n${ctx}\n---\n判断你是否有实质贡献（纠错、补充依据、指出失败路径）。有则以 @${me} 身份发言（简体中文、短、直接）；没有、或只是闲聊/礼貌，只输出 (silent)。`;
      await bridgeReply(name, me, spec, prompt, timeoutSec);
    }
  }
}

// ——— wake：定时 @全体 进展检查（防 agent 超时/无响应） ———
// 每 <interval>s 在群聊发一条 @全体 催报，消息自带在线态势（谁 idle 多久），
// 超过一个周期没动静的会话被点名——无响应者在群里现形，而不是默默挂死。
async function wakeCmd(opts) {
  const interval = Math.max(30, opts.interval || 180);
  const me = 'wake';
  console.log(`WAKE: 每 ${interval}s @全体 进展检查 (Ctrl+C 退出 / quit)`);
  let n = 0;
  for (;;) {
    n++;
    const now = nowSec();
    const others = listPresence().filter((p) => p.owner !== me && now - (p.lastSeenAt || 0) <= TTL);
    const parts = [t('wake_all', { n })];
    if (others.length) {
      parts.push(t('wake_online', {
        names: others.map((p) => `${displayName(p.owner)}(idle ${fmtIdle(now - (p.lastSeenAt || 0))})`).join(', '),
      }));
      const stale = others.filter((p) => now - (p.lastSeenAt || 0) > interval)
        .map((p) => `@${displayName(p.owner)}`);
      if (stale.length) parts.push(t('wake_idle', { names: stale.join(' ') }));
    } else {
      parts.push(t('wake_none'));
    }
    say(parts.join(' '), { owner: me });
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

// ——— models：枚举当前可用的模型 ———
// 来源三路：XTEAM_CLI_* 注册的路由 / api 后端 GET /models（OpenAI 兼容口大多支持）/ 默认 spec。
async function modelsCmd() {
  console.log('xteam models:');
  // 1) cli routes
  const routes = Object.keys(process.env)
    .filter((k) => k.startsWith('XTEAM_CLI_') && process.env[k])
    .sort()
    .map((k) => ({ spec: 'cli:' + k.slice('XTEAM_CLI_'.length).toLowerCase(), tpl: process.env[k] }));
  console.log(`  ${t('models_cli')}`);
  if (routes.length) {
    for (const r of routes) console.log(`    ${r.spec}   ← ${r.tpl}`);
  } else {
    console.log(`    ${t('models_none')}`);
  }
  // 2) api models
  const base = (process.env.XTEAM_LLM_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const key = process.env.XTEAM_LLM_API_KEY;
  console.log(`  ${t('models_api', { base })}`);
  if (!key) {
    console.log(`    ${t('models_api_fail', { reason: 'XTEAM_LLM_API_KEY 未设置' })}`);
  } else {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      const res = await fetch(`${base}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        console.log(`    ${t('models_api_fail', { reason: 'HTTP ' + res.status })}`);
      } else {
        const j = await res.json();
        const ids = (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [])
          .map((m) => (m && (m.id || m.name)) || null)
          .filter(Boolean)
          .sort();
        if (ids.length) {
          for (const id of ids) console.log(`    ${id}`);
        } else {
          console.log(`    ${t('models_none')}`);
        }
      }
    } catch (e) {
      console.log(`    ${t('models_api_fail', { reason: e.message })}`);
    }
  }
  // 3) default + hint
  const dflt = process.env.XTEAM_LLM_MODEL;
  console.log(`  ${t('models_default', { spec: dflt || t('models_none') })}`);
  console.log(`  ${t('models_hint')}`);
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

function isXteamHook(h) {
  return String((h && h.command) || '').includes('xteam.mjs');
}

// Remove every xteam hook + xteam statusLine from a parsed settings object
// (across all events). Returns true if anything changed.
function removeXteam(settings) {
  let changed = false;
  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      const groups = settings.hooks[event];
      if (!Array.isArray(groups)) continue;
      const kept = groups
        .map((g) => {
          if (!g || !Array.isArray(g.hooks)) return g;
          const hooks = g.hooks.filter((h) => !isXteamHook(h));
          if (hooks.length !== g.hooks.length) changed = true;
          return { ...g, hooks };
        })
        .filter((g) => g && g.hooks && g.hooks.length);
      if (kept.length) settings.hooks[event] = kept;
      else { delete settings.hooks[event]; changed = true; }
    }
    if (Object.keys(settings.hooks).length === 0) { delete settings.hooks; changed = true; }
  }
  if (settings.statusLine && isXteamHook(settings.statusLine)) { delete settings.statusLine; changed = true; }
  return changed;
}

// Re-write the hooks + statusLine (mirrors install.mjs). Called by `update` on
// every run so existing installs self-heal new hooks without a full reinstall.
// Uses forward-slash paths so the command strings are shell-safe.
// With `local` (or XTEAM_SETTINGS_LOCAL=1) it writes to settings.local.json
// instead of settings.json — for config managers (e.g. cc-switch) that rewrite
// settings.json on every provider switch, clobbering the hooks.
function refreshHooks(local) {
  local = !!local || ['1', 'true'].includes(process.env.XTEAM_SETTINGS_LOCAL);
  const dir = path.join(os.homedir(), '.claude');
  const target = path.join(dir, local ? 'settings.local.json' : 'settings.json');
  const other = path.join(dir, local ? 'settings.json' : 'settings.local.json');
  const scriptFwd = path.join(SKILL_DIR, 'xteam.mjs').replace(/\\/g, '/');
  // Absolute path to the node binary running this script, so the hook fires even
  // when `node` isn't on PATH in the hook's shell (e.g. Homebrew on macOS).
  const nodeCmd = process.execPath.replace(/\\/g, '/');

  // Strip any xteam hooks from the *other* file so exactly one copy survives.
  if (fs.existsSync(other)) {
    try {
      const otherSettings = JSON.parse(fs.readFileSync(other, 'utf8'));
      if (removeXteam(otherSettings)) {
        fs.writeFileSync(other, JSON.stringify(otherSettings, null, 2) + '\n');
        console.log(`  ✔ 已从 ${other} 移除旧的 xteam hook`);
      }
    } catch (e) {
      console.log(`  ⚠ 无法解析 ${other}: ${e.message}，跳过清理`);
    }
  }

  let settings = {};
  if (fs.existsSync(target)) {
    try {
      settings = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (e) {
      console.log(`  ⚠ 无法解析 ${target}: ${e.message}，跳过 hook 刷新`);
      return;
    }
  }
  removeXteam(settings);   // self-heal any leftover xteam hooks in the target
  const ensure = (event, entry) => {
    settings.hooks = settings.hooks || {};
    settings.hooks[event] = settings.hooks[event] || [];
    settings.hooks[event] = settings.hooks[event].filter(
      (g) => !(g.hooks || []).some((h) => isXteamHook(h))
    );
    settings.hooks[event].push(entry);
  };
  ensure('SessionStart', { hooks: [{ type: 'command', command: `"${nodeCmd}" "${scriptFwd}" status` }] });
  ensure('PreToolUse', {
    matcher: 'Edit|Write|MultiEdit|NotebookEdit',
    hooks: [{ type: 'command', command: `"${nodeCmd}" "${scriptFwd}" preedit` }],
  });
  settings.statusLine = { type: 'command', command: `"${nodeCmd}" "${scriptFwd}" statusline`, padding: 0 };
  fs.writeFileSync(target, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  ✔ 已刷新 hook + statusLine${local ? ' → settings.local.json' : ''}`);
}

async function update(local) {
  console.log(`xteam: 当前 / current v${VERSION}，检查 GitHub 最新版本 / checking...`);
  refreshHooks(local);
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
  console.log('       hook/statusLine 已刷新；SKILL.md 指令请新开对话加载。');
}

function help() {
  console.log(`xteam v${VERSION} — cross-session file coordination + group chat
        跨会话文件协调 + 群聊

Commands / 子命令:
  xteam status                       查看所有会话+锁+聊天 / show all sessions, locks & chat
  xteam statusline                   单行简报(底部状态栏用) / one-line summary (status bar)
  xteam rehook [--local]             重写 hook/statusLine（--local 写 settings.local.json）/ re-write hooks + statusLine
  xteam check <path>                 路径是否被占用 / is the path locked?
  xteam acquire <path> [--note N] [--owner O] [--label L]   加锁(含子目录) / lock file or dir (+subtree)
  xteam release <path>               放锁(并 @ 通知等待者) / release (+ notify waiters)
  xteam release --all                放掉本会话所有锁(收尾必做) / release ALL your locks (do this before you finish)
  xteam wait <path> [--note N]       阻塞等锁，一放开自动接手 / block until free, then auto-acquire
  xteam heartbeat <path>             续期 / refresh a lock
  xteam takeover <path>              接管过期锁 / clear & re-acquire a stale lock
  xteam label <名称>                 给本会话起名(显示为 <id>-<名称>) / name this session
  xteam say <message> [--label L]    发到群聊 / post to group chat
  xteam ask [--say] [-m <spec>] <prompt>   单次跨模型咨询 / ask another model once
  xteam models                           枚举当前可用模型（cli 路由 + api /models）/ list available models
  xteam bridge --name <n> -m <spec> [--interval <s>] [--no-digest]
                                       驻场跨模型 agent 进群聊（@<n> 必回）/ resident cross-model agent
  xteam wake [--interval <s>]         定时 @全体 进展检查（默认 180s，防挂死）/ periodic @all status check
  xteam tail [N]                     最近 N 条聊天 / last N chat lines (default 20)
  xteam update [--local]             更新到最新 GitHub 版本 / update to latest GitHub release
  xteam version                      版本号 / version
  xteam help                         本帮助 / this help

State / 状态目录: <repo>/.claude/xteam/  (locks/ + presence/ + waiters/ + chat.log; gitignored)
Owner / 身份:     自动取自当前会话 (auto-detected from session); --owner 或 XTEAM_OWNER 覆盖
Label / 名字:     用 \`xteam label\` 或 \`--label\` 或 XTEAM_LABEL 设置，显示为 <id>-<名字>
TTL / 过期:       ${TTL}s (XTEAM_TTL); 日志上限 ${LOG_MAX} 条 (XTEAM_LOG_MAX)
Wait / 等锁:      轮询 ${WAIT_POLL}s (XTEAM_WAIT_POLL)，上限 ${WAIT_MAX}s (XTEAM_WAIT_MAX)

跨模型 / cross-model (ask · bridge):
  spec = api:<model> | cli:<name> | <model>(=api:)   默认取 XTEAM_LLM_MODEL
  api:  XTEAM_LLM_API_BASE (default https://api.openai.com/v1, OpenAI 兼容口均可)
        XTEAM_LLM_API_KEY  (必设)
  cli:  XTEAM_CLI_<NAME> = 命令模板，推荐 stdin 形式如 XTEAM_CLI_CODEX="codex exec -s read-only -"
        {text}=prompt 作独立 argv（Windows 下仅纯 ASCII 且不含 %）；{file}=临时文件；无占位走 stdin
        复杂命令请包一层 .bat/.sh 再指向它
  bridge: 群聊即共享记忆 —— 未读喂给 agent、回复贴回群聊；@<name> 必回，
          默认每 <interval>s 汇总未读征求意见（无贡献则 (silent)），--no-digest 只回 @
Hook 位置 / hooks:  默认写 settings.json；--local 或 XTEAM_SETTINGS_LOCAL=1 则写 settings.local.json（防 cc-switch 等切换器冲掉）

默认已启用 / enabled by default:
  · 会话启动 SessionStart 自动跑 \`xteam status\`。
  · 底部状态栏 statusLine 每轮回复后刷新一行简报 (xteam statusline)。
Default: SessionStart auto-runs \`xteam status\`; the statusLine refreshes a one-line
summary after every reply.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  const opts = { owner: null, note: null, label: null, all: false, local: false, model: null, say: false, name: null, interval: null, timeout: null, noDigest: false };
  const pos = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--owner' && rest[i + 1]) { opts.owner = rest[i + 1]; i++; }
    else if (rest[i] === '--note' && rest[i + 1]) { opts.note = rest[i + 1]; i++; }
    else if (rest[i] === '--label' && rest[i + 1]) { opts.label = rest[i + 1]; i++; }
    else if (rest[i] === '--all') { opts.all = true; }
    else if (rest[i] === '--local') { opts.local = true; }
    else if ((rest[i] === '--model' || rest[i] === '-m') && rest[i + 1]) { opts.model = rest[i + 1]; i++; }
    else if (rest[i] === '--say') { opts.say = true; }
    else if (rest[i] === '--name' && rest[i + 1]) { opts.name = rest[i + 1]; i++; }
    else if (rest[i] === '--interval' && rest[i + 1]) { opts.interval = Number(rest[i + 1]) || null; i++; }
    else if (rest[i] === '--timeout' && rest[i + 1]) { opts.timeout = Number(rest[i + 1]) || null; i++; }
    else if (rest[i] === '--no-digest') { opts.noDigest = true; }
    else if (rest[i] === '--force') { opts.force = true; }
    else pos.push(rest[i]);
  }
  switch (cmd) {
    case 'check': return check(pos[0] || '');
    case 'acquire': return acquire(pos[0] || '', opts);
    case 'release': return opts.all ? releaseAll() : release(pos[0] || '', opts);
    case 'wait': return wait(pos[0] || '', opts);
    case 'heartbeat': return heartbeat(pos[0] || '');
    case 'takeover': return takeover(pos[0] || '', opts);
    case 'list':
    case 'status': return status();
    case 'statusline':
    case 'line': return statusline();
    case 'rehook': return refreshHooks(opts.local);
    case 'label': return setLabel(pos.join(' '));
    case 'say':
    case 'log':
    case 'chat': return say(pos.join(' '), opts);
    case 'ask': return await askCmd(pos, opts);
    case 'bridge': return await bridgeCmd(pos, opts);
    case 'models': return await modelsCmd();
    case 'wake': return await wakeCmd(opts);
    case 'i18n-gen': return await i18nGen(pos[0] || detectLang());
    case 'tail': return tailCmd(pos[0]);
    case 'preedit': return preedit();
    case 'update':
    case 'upgrade': return await update(opts.local);
    case 'version':
    case '-v':
    case '--version': return showVersion();
    case 'help':
    case '-h':
    case '--help':
    default: return help();
  }
}

main().catch((e) => {
  console.log(`xteam: error: ${e.message}`);
  process.exitCode = 1; // 子进程调用方（如 ensurePack）靠 exit code 判定失败
});
