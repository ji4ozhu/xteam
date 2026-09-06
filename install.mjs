#!/usr/bin/env node
// xteam — one-click installer (cross-platform: Windows / macOS / Linux)
// Installs the xteam skill + /xteam command + hooks + gitignore into ~/.claude/.
// Idempotent: safe to re-run.
//
// Four ways to run (all end in the same installed result):
//   1. git clone →  node install.mjs                                     (local files)
//   2. npx github:ji4ozhu/xteam                                          (npx clones + runs)
//   3. curl -fsSL .../install.mjs | node --input-type=module -           (downloads files)
//   4. just tell Claude/Codex: "帮我安装 https://github.com/ji4ozhu/xteam"

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const REPO_RAW = 'https://raw.githubusercontent.com/ji4ozhu/xteam/main';

// For `curl | node -`, import.meta.url points to a synthetic [eval] path — guard it.
let __dirname;
try {
  __dirname = path.dirname(fileURLToPath(import.meta.url));
} catch {
  __dirname = process.cwd();
}

const HOME = os.homedir();
const homeFwd = HOME.replace(/\\/g, '/'); // forward slashes: safe for shell + node on Windows
const scriptFwd = `${homeFwd}/.claude/skills/xteam/xteam.mjs`;

const SKILL_DIR = path.join(HOME, '.claude', 'skills', 'xteam');
const COMMAND_DIR = path.join(HOME, '.claude', 'commands');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');
const SETTINGS_LOCAL = path.join(HOME, '.claude', 'settings.local.json');
const GITIGNORE = path.join(HOME, '.gitignore_global');

// Absolute path to the node binary running this script, so the hook fires even
// when `node` isn't on PATH in the hook's shell (e.g. Homebrew on macOS).
const nodeCmd = process.execPath.replace(/\\/g, '/');
const HOOK_STATUS = `"${nodeCmd}" "${scriptFwd}" status`;
const HOOK_PREEDIT = `"${nodeCmd}" "${scriptFwd}" preedit`;
const HOOK_STATUSLINE = `"${nodeCmd}" "${scriptFwd}" statusline`;
const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

// Write hooks to settings.local.json instead of settings.json. Useful when a
// config manager (e.g. cc-switch) rewrites settings.json on every provider
// switch, clobbering the xteam hooks. Pass --local or set XTEAM_SETTINGS_LOCAL=1.
const USE_LOCAL = process.argv.includes('--local')
  || ['1', 'true'].includes(process.env.XTEAM_SETTINGS_LOCAL);

function ok(m) { console.log(`  ✔ ${m}`); }
function warn(m) { console.log(`  ⚠ ${m}`); }
function home(p) { return p.replace(HOME, '~'); }

// Find a source file next to the script or in cwd (clone / npx contexts).
function findLocal(rel) {
  for (const dir of [__dirname, process.cwd()]) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Fetch a source file from GitHub (curl / remote contexts).
async function download(rel) {
  const res = await fetch(`${REPO_RAW}/${rel}`);
  if (!res.ok) throw new Error(`download ${rel} failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Resolve the three source files — local repo if present, else download from GitHub.
async function resolveSources() {
  const rels = { skill: 'SKILL.md', script: 'xteam.mjs', command: 'commands/xteam.md' };
  const sources = {};
  let allLocal = true;
  for (const [k, rel] of Object.entries(rels)) {
    const p = findLocal(rel);
    if (p) sources[k] = { path: p, data: null };
    else { allLocal = false; sources[k] = { path: null, data: await download(rel) }; }
  }
  return { allLocal, sources };
}

function installFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (src.data != null) fs.writeFileSync(dst, src.data);
  else fs.copyFileSync(src.path, dst);
  ok(`已安装 ${home(dst)}`);
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

// Replace any existing xteam hook (self-healing across old `~` / `${HOME}` / absolute forms)
function ensureHook(settings, event, entry) {
  settings.hooks = settings.hooks || {};
  settings.hooks[event] = settings.hooks[event] || [];
  settings.hooks[event] = settings.hooks[event].filter(
    (g) => !(g.hooks || []).some((h) => isXteamHook(h))
  );
  settings.hooks[event].push(entry);
}

function mergeHooks() {
  const target = USE_LOCAL ? SETTINGS_LOCAL : SETTINGS;
  const other = USE_LOCAL ? SETTINGS : SETTINGS_LOCAL;

  // Strip any xteam hooks from the *other* file so exactly one copy survives.
  if (fs.existsSync(other)) {
    try {
      const otherSettings = JSON.parse(fs.readFileSync(other, 'utf8'));
      if (removeXteam(otherSettings)) {
        fs.writeFileSync(other, JSON.stringify(otherSettings, null, 2) + '\n');
        ok(`已从 ${home(other)} 移除旧的 xteam hook`);
      }
    } catch (e) {
      warn(`无法解析 ${home(other)}: ${e.message}，跳过清理`);
    }
  }

  let settings = {};
  if (fs.existsSync(target)) {
    try {
      settings = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (e) {
      warn(`无法解析 ${home(target)}: ${e.message}，跳过 hook 配置`);
      return;
    }
  }
  removeXteam(settings);   // self-heal any leftover xteam hooks in the target
  ensureHook(settings, 'SessionStart', { hooks: [{ type: 'command', command: HOOK_STATUS }] });
  ensureHook(settings, 'PreToolUse', {
    matcher: MATCHER,
    hooks: [{ type: 'command', command: HOOK_PREEDIT }],
  });
  settings.statusLine = { type: 'command', command: HOOK_STATUSLINE, padding: 0 };
  fs.writeFileSync(target, JSON.stringify(settings, null, 2) + '\n');
  ok(`已写入 hook + statusLine 到 ${home(target)}${USE_LOCAL ? ' (settings.local.json)' : ''}`);
}

function setupGitignore() {
  const line = '.claude/xteam/';
  let content = fs.existsSync(GITIGNORE) ? fs.readFileSync(GITIGNORE, 'utf8') : '';
  const lines = content.split(/\r?\n/);
  if (!lines.includes(line)) {
    if (content && !content.endsWith('\n')) content += '\n';
    content += `# Claude Code cross-session coordination state (xteam)\n${line}\n`;
    fs.writeFileSync(GITIGNORE, content);
    ok(`已追加 ${line} 到 ${home(GITIGNORE)}`);
  }
  try {
    const cur = execSync('git config --global core.excludesfile', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!cur) {
      execSync(`git config --global core.excludesfile "${homeFwd}/.gitignore_global"`, { stdio: 'ignore' });
      ok('已设置 git core.excludesfile');
    } else if (cur.replace(/\\/g, '/') !== `${homeFwd}/.gitignore_global`) {
      warn(`git core.excludesfile 当前指向 ${cur}，未改动（如需全局忽略，请指向 ${homeFwd}/.gitignore_global）`);
    }
  } catch {
    // git 不可用 — 非致命
  }
}

function verify() {
  try {
    execSync(`node "${scriptFwd}" help`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    ok('xteam 脚本可执行');
  } catch (e) {
    warn(`验证失败 ${e.message}`);
  }
}

async function main() {
  console.log('xteam — 一键安装 one-click installer\n');
  const { allLocal, sources } = await resolveSources();
  if (!allLocal) console.log('  未在本地找到源码，从 GitHub 下载 / downloading from GitHub...\n');
  installFile(sources.skill, path.join(SKILL_DIR, 'SKILL.md'));
  installFile(sources.script, path.join(SKILL_DIR, 'xteam.mjs'));
  installFile(sources.command, path.join(COMMAND_DIR, 'xteam.md'));
  mergeHooks();
  setupGitignore();
  verify();
  console.log('\n✅ 安装完成 installed.');
  console.log('   新开一个 Claude Code 对话即可自动启用 / start a new session to enable.');
  console.log('   查看帮助 / view help:  /xteam');
}

main().catch((e) => {
  console.error(`xteam install: error: ${e.message}`);
  process.exit(1);
});
