<div align="center">

# 🧩 xteam skill

# ** 简单的说,Claude安装这个插件后,解决了平时使用Claude在一个项目里同时开多个对话可能多个Agent改同一个文件的问题。**
# 这个Skill会协调多个Agent改同1个源码文件的优先级，比如 A-Agent 让 B-Agent 暂时先别改这个,先改别的，等A改完了这个文件，再通知B这个文件可以动了

## Simply put, after Claude installs this plugin, it solves the problem where you'd normally have multiple conversations open in one project at the same time, and several Agents might end up editing the same file.

## This skill coordinates the priority among multiple Agents editing the same source file. For example, Agent A tells Agent B to hold off on editing this file for now and work on something else first; once A is done with the file, it lets B know the file is free to edit.

## Everything below is for the AI to read — humans can just ignore it.


## 下面那些是给AI看的，人类可以不用管。

*Cross-session file coordination + group chat for Claude Code & Codex — locks, presence, and a shared chat. Zero config, cross-platform.*

</div>

---

## ⚡ 最快安装 Fastest install（一句话 / one sentence）

> 在 **Claude Code / Codex（GPT）** 对话里直接输入下面这句，它会自己 clone 并装好：

```
帮我安装 https://github.com/ji4ozhu/xteam 这个插件
```
安装后什么都不用管，自动会给所有新的对话激活。

> In **Claude Code / Codex (GPT)**, just say this and it will install itself:

```
Install the xteam plugin from https://github.com/ji4ozhu/xteam
```
After installing it, you don't need to do anything — it automatically activates for all new conversations.
---

## ✨ 功能 Features

| 功能 Feature | 说明 Description |
|---|---|
| 🔒 **文件/目录锁 File/dir locks** | 原子锁、子树覆盖（锁 `src/auth` = 锁住整个子目录），杜绝两个会话同时改同一文件。Atomic, subtree-covering — locking `src/auth` locks the whole dir, so two sessions never edit the same file. |
| 💬 **群聊 Group chat** | 所有会话共享一个 `chat.log`，互通「我在改什么、还差多久」。All sessions share one `chat.log` — "what I'm editing, how long I'll be". |
| 👥 **在线状态 Presence** | 每个会话自动登记 presence，一眼看到「谁在、正在改什么」。Every session auto-registers; see who's online and what they hold. |
| ⚡ **默认启用·零配置 Zero config** | SessionStart hook 自动跑 `status`，新开对话即可用，无需手动输入。A SessionStart hook auto-runs `status` — works in every new session. |
| 🚨 **冲突自动警告 Conflict warning** | 编辑被他人占用的文件前，PreToolUse hook 自动弹 `[xteam] 冲突`。Warns before you edit a file someone else holds. |
| 🤝 **Codex/GPT 协作 Codex/GPT collab** | 先锁路径再派 Codex，Claude 指挥、Codex 落盘。Lock paths first, then delegate — Claude directs, Codex writes. |
| 🌍 **跨平台 Cross-platform** | Windows / macOS / Linux，纯 Node 内置模块，零第三方依赖。Pure Node builtins, zero deps. |
| 🪶 **省 token Token-lean** | 状态只输出摘要 + 最近几条聊天，不会 `cat` 整个日志。Summaries only, never dumps the log. |

## 📐 原理 How it works

状态存在 `<repo>/.claude/xteam/`（安装时已自动加入 gitignore）。State lives in `<repo>/.claude/xteam/` (auto-gitignored on install):

```
.claude/xteam/
├── locks/      # 每个锁一个目录 + meta.json（fs.mkdirSync 原子创建）atomic dir-per-lock
├── presence/   # 每个会话一个目录（自动登记在线状态）dir-per-session heartbeat
└── chat.log    # 群聊日志（自动轮转，上限 200 条）append-only chat, auto-rotated
```

锁是**结构化防冲突**，群聊是**自由文本沟通**，二者互补：锁决定「谁先谁后」，群聊让决策可见。
*Locks are structured conflict-prevention; the chat is free-form communication. Locks decide who goes first; the chat makes decisions visible.*

---

## 🚀 安装 Install

### 要求 Requirements

- Node.js ≥ 18
- git

### 方式一：一句话安装（推荐）Method 1: Just ask Claude

见顶部「⚡ 最快安装」。直接把仓库链接甩给 Claude Code / Codex 就行。
*See "Fastest install" above — paste the repo link to Claude Code / Codex.*

### 方式二：一键脚本 Method 2: One-click script（git clone）

```bash
git clone git@github.com:ji4ozhu/xteam.git
cd xteam
node install.mjs
```

### 方式三：npx（免 clone）Method 3: npx (no clone)

```bash
npx github:ji4ozhu/xteam
```

> 首次会问 `Ok to proceed?`，输入 `y` 回车即可。需已装 Node/npm。*First run asks "Ok to proceed?" — press `y`. Requires Node/npm.*

### 方式四：curl（免 clone）Method 4: curl (no clone)

```bash
curl -fsSL https://raw.githubusercontent.com/ji4ozhu/xteam/main/install.mjs | node --input-type=module -
```

> Windows PowerShell 里 `curl` 可能是 `Invoke-WebRequest` 的别名，请用 `curl.exe` 或改在 Git Bash / WSL 里跑。*On Windows PowerShell `curl` may alias `Invoke-WebRequest` — use `curl.exe`, or run in Git Bash / WSL.*

安装脚本会自动：拷 skill 到 `~/.claude/skills/xteam/`、拷命令到 `~/.claude/commands/`、往 `~/.claude/settings.json` 合并 hook、配置全局 gitignore。**可重复运行，幂等。**
*The script auto: copies the skill to `~/.claude/skills/xteam/`, the command to `~/.claude/commands/`, merges hooks into `~/.claude/settings.json`, and sets up global gitignore. Safe to re-run (idempotent).*

装完**新开一个对话**即可，开头会自动输出所有会话状态。*Open a new session — it auto-prints all sessions' status at startup.*

### 手动安装 Manual

```bash
mkdir -p ~/.claude/skills/xteam ~/.claude/commands
cp SKILL.md xteam.mjs ~/.claude/skills/xteam/
cp commands/xteam.md ~/.claude/commands/
```

然后在 `~/.claude/settings.json` 的 `hooks` 里加（把 `<你的home>` 换成实际 home 路径，Windows 上注意用 `/` 不用 `\`）：
*Then add to `hooks` in `~/.claude/settings.json` (replace `<你的home>` with your real home; on Windows use `/` not `\`):*

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node \"<你的home>/.claude/skills/xteam/xteam.mjs\" status" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [ { "type": "command", "command": "node \"<你的home>/.claude/skills/xteam/xteam.mjs\" preedit" } ] }
    ]
  }
}
```

> 💡 为什么 hook 里用绝对路径而不是 `~`？因为 Windows 的 hook 默认走 `cmd.exe`，`~` 不展开。安装脚本用 `os.homedir()` 现算原生路径写进去，三平台通用、与 shell 无关。
> *Why an absolute path, not `~`? Windows hooks run under `cmd.exe`, which doesn't expand `~`. The installer computes the native path via `os.homedir()` — works on all three OSes, shell-independent.*

---

## 🔄 更新 Update

装好后升级到最新版 / Upgrade to the latest release:

```bash
xteam update
```

或重跑任一安装方式（clone / npx / curl 都行，幂等覆盖）。*Or re-run any install method (clone / npx / curl — all idempotent).*

---

## 📖 使用 Usage

### 自动模式（默认）Auto mode (default)

新开对话，SessionStart hook 自动跑 `xteam status`，输出类似：
*Open a new session — the SessionStart hook runs `xteam status`, printing something like:*

```
xteam: 2 session(s) · 1 lock(s) · chat 3  (2 会话 · 1 锁 · 聊天 3)
  [session] fdf64f36-改Auth功能 [you/你]  idle 0s  holding/占用: src/auth
  [session] e5f6a7b8-改支付功能         idle 3m  holding/占用: -
  [xteam#chat] [08-23 00:40] fdf64f36-改Auth功能: 锁了 src/auth，改登录，预计 20 分钟
```

### 🎬 效果演示 Demo

两个并行会话在同一个仓库里，一眼看清「谁是谁、谁占着哪个文件」。下面是你在终端里真实看到的画面：
*Two parallel sessions in one repo — at a glance you see who's who and who holds what. Here's what you actually see:*

会话 A（`改Auth功能`）开工：
*Session A (`改Auth功能`) starts:*

```text
$ xteam label "改Auth功能"
  LABEL: fdf64f36-改Auth功能  / 已命名

$ xteam acquire src/auth --note "改登录"
  ACQUIRED: src/auth (owner=fdf64f36-改Auth功能)  / 已加锁

$ xteam say "锁了 src/auth，改登录，预计 20 分钟"
  SAID: [08-23 00:40] fdf64f36-改Auth功能: 锁了 src/auth，改登录，预计 20 分钟
```

会话 B（`改支付功能`）也去改 `src/auth/login.ts`，**编辑前被 PreToolUse 钩子拦下**，弹警告：
*Session B (`改支付功能`) also tries to edit `src/auth/login.ts` — the PreToolUse hook fires before the edit:*

```text
[xteam] 冲突/conflict: src/auth/login.ts 正被 held by fdf64f36-改Auth功能。
请勿修改此文件——去改别的文件，或先协调（xteam status 看锁/群聊）。
```

于是 B 自觉转去改别的，最终 `xteam status` 全景：
*So B switches away; the final `xteam status` picture:*

```text
xteam: 2 session(s) · 2 lock(s) · chat 2  (2 会话 · 2 锁 · 聊天 2)
  [session] fdf64f36-改Auth功能 [you/你]  idle 2m  holding/占用: src/auth
  [session] e5f6a7b8-改支付功能         idle 0s  holding/占用: src/payment
  [xteam#chat] [08-23 00:40] fdf64f36-改Auth功能: 锁了 src/auth，改登录，预计 20 分钟
  [xteam#chat] [08-23 00:45] e5f6a7b8-改支付功能: auth 被占，我先改 payment
```

而且 B 还能基于代码给 A 挑毛病，群聊互通判断 / And B can call out a code issue in the group chat:

```text
$ xteam say "@fdf64f36：login.ts:42 你只清了 token、没同步刷新 session 里的 userId，登录态一过期就是 undefined，联调必 500"
  SAID: [08-23 00:52] e5f6a7b8-改支付功能: @fdf64f36：login.ts:42 你只清了 token、没同步刷新 session 里的 userId，登录态一过期就是 undefined，联调必 500
```

> 💡 每个会话一开工就 `xteam label "..."` 起个短名，别的会话（和你）在群里就能一眼认出「这是哪个 AI 在干嘛」。
> *Tip: name each session with `xteam label "..."` at the start, so everyone (and you) instantly sees which AI is doing what.*

### 命令 Commands

| 命令 Command | 说明 Description |
|---|---|
| `/xteam` | 查看帮助（中英双语）show bilingual help |
| `xteam status` | 所有会话 + 锁 + 群聊 all sessions, locks & chat |
| `xteam check <path>` | 该路径是否被占用 is the path locked? |
| `xteam acquire <path> --note "..."` | 加锁（目录锁覆盖子树）lock (dir locks cover subtree) |
| `xteam release <path>` | 放锁（自动 @ 通知等待者）release (+ auto @-notify waiters) |
| `xteam wait <path>` | 排队等锁，一放开自动接手 queue up; auto-acquire on release |
| `xteam say "..."` | 发到群聊 post to group chat |
| `xteam tail [N]` | 最近 N 条聊天 last N chat lines |
| `xteam heartbeat <path>` | 续期（长任务防误判 stale）refresh a lock |
| `xteam takeover <path>` | 接管过期锁 clear & re-acquire a stale lock |
| `xteam label "..."` | 给会话起名（显示 `<id>-名字`）name this session |
| `xteam update` | 更新到最新 GitHub 版本 update to latest release |
| `xteam version` | 版本号 show version |

### 铁律 Protocol（改文件 / 派 Codex 前）before editing / delegating

1. **查 check** `xteam check <path>` → 输出 `FREE` 才能动 *only touch if it says `FREE`*
2. **拿 acquire** `xteam acquire <path> --note "在做什么"` *acquire with a note*
   被锁了？→ **等 wait** `xteam wait <path>`，别硬改 *locked? queue with `wait`, never force the edit*
3. **说 say** `xteam say "锁了 <path>，在做什么，预计多久"` *post progress*
4. **改 edit** 正常编辑 / 派 Codex *edit or delegate to Codex*
5. **放 release** `xteam release <path>` *release when done — waiters get @-notified automatically*

### 等锁 Waiting（别干等，也别硬改）

对方锁着文件、迟迟不回应？用 `xteam wait <path>`：
*Holder unresponsive? Don't spin, don't force it — use `xteam wait`:*

- 自动在群聊 @ 持有者，并把你登记进**等待队列**（对方 `status`/`check` 能看到谁在等）
  *@-pings the holder and registers you in the queue, visible in their `status`/`check`*
- 阻塞轮询（默认 5s 一次，上限 900s），对方一放锁**立刻自动接手**，无需再手动 acquire
  *blocks and polls; the moment they release, you auto-acquire*
- 持有者失联过期 → 直接提示 `xteam takeover`，不会无限等
  *if the holder goes stale, it tells you to `takeover` instead of waiting forever*

> **在 AI 会话里要用后台跑**（`run_in_background=true`），然后结束这一轮去干别的。锁一放开，`wait` 进程退出，Claude Code 会自动把会话叫醒——和「派 Codex 干活、干完自动通知」是同一个模式。前台跑会白白卡住一整轮。
> *In an AI session, launch it in the **background** and end the turn. When the lock frees, the process exits and Claude Code wakes the session automatically — same pattern as delegating to Codex. Running it in the foreground just blocks the turn.*

```console
$ xteam wait crates/Wanli_Config/src/security.rs --note "STATE_VERSION 3 + 迁移"
WAITING: crates/Wanli_Config/src/security.rs — 被 23fa1cb6-device_uuid修复 锁着
SAID: [08-23 12:15] fdf64f36-SecurityKey语义: @23fa1cb6-device_uuid修复 我在等 ... 你放锁后我立刻接手
  轮询中，每 5s 一次，最多 900s
FREED: crates/Wanli_Config/src/security.rs — 锁已释放，正在接手
ACQUIRED: crates/Wanli_Config/src/security.rs (owner=fdf64f36-SecurityKey语义)  / 已加锁
```

对方那边放锁时会看到：*The holder sees, on release:*

```console
$ xteam release crates/Wanli_Config/src/security.rs
RELEASED: crates/Wanli_Config/src/security.rs  / 已放锁
  -> 1 个会话在等这把锁 / 1 session(s) waiting: fdf64f36-SecurityKey语义
  已在群聊 @ 通知 / notified them in chat
```

### 与 Codex / GPT 协作 With Codex / GPT

Claude 是指挥，Codex 落盘。派 Codex 改哪些文件，就**先锁哪些路径**：
*Claude directs, Codex writes. Lock the paths before delegating:*

```bash
xteam acquire src/auth --note "派 Codex 改登录"
codex-collab run "只动 src/auth 下的文件，实现 X" -s workspace-write
xteam release src/auth
```

Codex 不感知锁，所以在给 Codex 的提示词里写「只动 X 下的文件」。探索用 `-s read-only`，落盘才用 workspace-write。
*Codex doesn't see the locks, so tell it in the prompt "only touch files under X". Use `-s read-only` to explore, `workspace-write` to write.*

---

## 🌍 跨平台 Cross-platform

- 纯 Node 内置模块（`fs` / `path` / `crypto` / `child_process`），三系统行为一致 *pure Node builtins, identical behavior*
- 锁用 `fs.mkdirSync` 原子创建（POSIX `mkdir(2)` / Windows `CreateDirectoryW` 均为原子操作）*atomic `mkdir` = lock acquisition*
- 路径自动规范化（`\` ↔ `/`）；`git rev-parse` 失败自动回退 `cwd`（非 git 目录也能用）*auto path-normalize; falls back to `cwd` outside a git repo*
- 身份自动识别：默认取会话 `CLAUDE_CODE_SESSION_ID` 前 8 位，每个对话自动唯一 *auto identity: first 8 hex of the session id — unique per conversation*

---

## ❓ FAQ

**Q：会不会浪费 token？ Does it burn tokens?**
A：不会。SessionStart 只输出一行摘要 + 最近几条聊天；想看更多用 `xteam tail N`，绝不 `cat` 整个 `chat.log`。*No — startup prints one summary line + recent chat; use `tail N` for more, never dumps the log.*

**Q：锁忘了释放怎么办？ What if a lock is never released?**
A：锁有 TTL（默认 45 分钟），超时标记 `STALE`，可用 `xteam takeover` 接管。长任务中途跑 `xteam heartbeat` 续期。*Locks have a TTL (default 45 min); stale ones show `STALE` and can be `takeover`n. Long tasks should `heartbeat` periodically.*

**Q：非 git 项目能用吗？ Does it work outside a git repo?**
A：能。`git rev-parse` 失败时自动回退到当前目录作为仓库根。*Yes — falls back to cwd as repo root.*

**Q：可以手动指定身份名吗？ Can I name a session?**
A：默认自动识别，想看可读名传 `--owner 名字` 或用环境变量 `XTEAM_OWNER`。*Auto by default; pass `--owner name` or set `XTEAM_OWNER` for a readable name.*

**Q：多个 AI 抢同一个文件，我会看到什么？ What do I see when AIs fight over one file?**
A：会话开头有全景、编辑被占用文件前弹 `[xteam] 冲突` 警告、群聊里能看进展。冲突警告是**提示不是硬拦截**——靠 AI 遵守协议（HELD 就换文件）；真硬碰硬时后写覆盖前写，由 git 兜底。*Startup shows the full picture, a `[xteam] 冲突` warning fires before editing a held file, and the chat shows progress. The warning is advisory, not a hard block — AIs follow the protocol (switch on HELD); a genuine collision falls back to git's last-write-wins.*

---

## 📄 License

[MIT](LICENSE)
