---
name: xteam
description: Coordinate file edits and share a group chat across concurrent Claude Code sessions (and Codex delegates) in the same repo. Use BEFORE editing any file or delegating edits to Codex — run `xteam check <path>`, then `xteam acquire <path>`, post progress with `xteam say "<msg>"`, and `xteam release <path>` when done. If a path is already locked, run `xteam wait <path>` in the BACKGROUND (run_in_background=true) and end your turn — it auto-acquires the moment the holder releases and you get woken up. Trigger automatically in EVERY session (no config needed), whenever multiple sessions work in parallel, or when delegating edits to Codex.
---

# xteam — 跨会话协作（锁 + 群聊）/ cross-session coordination (locks + group chat)

让同一仓库里的多个并行对话（每个都可能派 Codex）协调"谁先改哪个文件"，并通过共享群聊互通进展。锁是结构化防冲突，群聊是自由文本沟通，二者互补。

Coordinates which parallel conversation edits which file first, and shares a group chat for progress. Locks prevent conflicts; the chat is free-form communication.

## 调用方式 / Usage

```bash
node ~/.claude/skills/xteam/xteam.mjs <子命令/subcommand> [参数/args]
```

子命令：`status` · `check` · `acquire` · `release` · `wait` · `heartbeat` · `takeover` · `label` · `say` · `tail` · `update` · `version` · `help`

## 铁律 / Protocol（改任何文件 / 派 Codex 之前必须遵守）

0. **名 / label**：会话一开工就给自己起个短名，例如 `xteam label "改Auth功能"`，别的会话在群里就能一眼认出你是谁（显示为 `a1b2c3d4-改Auth功能`）。不设也行，会自动用你锁的 note 兜底。
1. **查 / check**：`xteam check <path>` → 输出 `FREE` 才能动；输出 `HELD … owner=X` 就别碰。**别干等、更别硬改**：用后台 `xteam wait <path>` 排队（见下），然后去干别的。
2. **拿 / acquire**：`xteam acquire <path> --note "<在做什么>"`（owner 自动识别，无需传；想看可读名再 `--owner A`）。锁目录会覆盖整棵子树，整模块改动锁目录。
3. **说 / say**：`xteam say "锁了 <path>，<在做什么>，预计 <多久>"` —— 让别的对话在群里看到。
4. **改 / edit**：正常编辑 / 派 Codex。
5. **放 / release**：改完验证完 → `xteam release <path>`。会自动 @ 通知所有在等这把锁的会话，不用再手动喊。

## 等锁 / Waiting（别干等，也别硬改）

`xteam wait <path>` —— 被别人锁着时用它，一条命令解决排队：

- 自动在群聊 @ 持有者说明你在等什么，**并登记到等待队列**（对方 `xteam status` / `xteam check` 都能看到「谁在等」）；
- 轮询等待（默认每 5s，上限 900s），对方一 `release`，**你立刻自动拿到锁**，无需再手动 acquire；
- 如果持有者已经**失联过期**（idle > TTL），会直接提示你 `xteam takeover <path>` 接管，不会无限等下去；
- 超时也不丢：等待登记保留，再跑一次 `xteam wait` 即可。

### 必须用后台跑 / MUST run it in the background

`wait` 会阻塞。**不要前台跑**——那会把你这一轮整整卡住 900 秒，什么都干不了。

正确姿势：用 Bash 工具、**`run_in_background=true`** 启动它：

```bash
xteam wait crates/Wanli_Config/src/security.rs --note "STATE_VERSION 3 + 迁移"
```

然后**结束这一轮**：去改别的没锁的文件，或者告诉用户"已排队，等 X 放锁后我自动接手"。

- **不要** poll、不要 `sleep` 守着、不要开 agent 盯着——纯属浪费。
- 锁一放开，`wait` 拿到锁后进程就退出，Claude Code 会用 `<task-notification>` **自动叫醒你**。
- **被叫醒后**先看输出确认是 `ACQUIRED`（拿到了）还是 `STALE`/`TIMEOUT`（要 `takeover` 或再等），确认拿到锁了再开始落盘。

### 必须用人话汇报 / MUST report in plain text

后台任务的工具输出（`Command running in background with ID: …`）对用户是**噪音**，别把它当汇报。启动后台 `wait` 之后、结束这一轮之前，**必须**用普通文字写一句状态，让用户不点开任何东西就知道发生了什么：

```
Xteam: 已排队等 crates/Wanli_Config/src/actor.rs
  持有者：e193b67b-增强安全 short_id 改造落盘（idle 17m）
  我在等：save_account_tokens 放宽 XOR + auto_login 派生
  已在群聊 @ 过对方；它一放锁我会被自动叫醒，然后立刻落盘。
```

要点：**谁锁着**、**你等它干什么**、**接下来会自动发生什么**。一到四行，别贴 ID、别贴临时文件路径、别让用户去 Read output 文件。

被唤醒后同理，先用人话说结果：

```
Xteam: actor.rs 拿到锁了（e193b67b 已放锁），开始落盘。
```

或者：

```
Xteam: actor.rs 等待超时，持有者 e193b67b 仍活跃（idle 3m）。
  我先去改 ipc.rs，稍后重新排队。
```

这和派 Codex 是同一个模式：**发起 → 结束回合 → 被自动唤醒 → 回来干活**。

**别做的事**：不要因为对方"迟迟不回应"就硬改被锁的文件。要么后台 `wait`，要么等它过期后 `takeover`——两条路都会留下痕迹，改动始终可归属。

## 共享感知 / Shared awareness（看到别人在干嘛 / see what others are doing）

会话启动时 SessionStart 已经自动跑过 `xteam status`，你能看到**其他会话的名字 + 在改什么 + 最近说了什么**。别当摆设：

1. **先看再动手**：改之前看一眼，有没有别的会话在做**同一件事 / 相关的事**。
2. **别重复造轮子**：A 已经在改你正想改的东西，就别重做——`xteam say "A 在改 X，我改去 Y，等 A 放锁我接手 Z"`。
3. **可以点评 / 接洽（基于代码）**：点评前先读对方的改动（`git diff`、或直接读相关文件——锁只禁**改**、不禁**读**），找到**具体证据**再开口。要**直接、指到具体坑**，并引用位置：`xteam say "@<对方id>：你在 login.ts:42 只清了 token、没同步刷新 session 里的 userId，登录态一过期就是 undefined，联调必 500"`。**没读代码就别点评**——别凭想象乱说，一句没证据的话比不说更糟。
4. **干完留句话**：做完 / 放锁时 `xteam say "X 改完，思路 Y，踩了 Z 个坑"`，让别人能接着评审。

看完整聊天用 `xteam tail`，看实时全景用 `xteam status`。

## 关键规则 / Key rules

- **默认启用，零配置 / enabled by default, zero config**：会话启动时 SessionStart hook 自动跑 `xteam status`，输出当前所有会话状态。无需手动输入 `/xteam`。
- **身份自动识别 / auto identity**：脚本默认用当前会话的 `CLAUDE_CODE_SESSION_ID` 前 8 位作为 owner，每个对话自动唯一、跨调用稳定。想看可读名才传 `--owner A`。
- **锁目录优先 / prefer dir locks**：动一个模块就锁整个目录，别逐文件，省心且不漏。
- **冲突自动提示 / auto conflict warning**：已配 PreToolUse hook——你要改的文件若被别的会话占用，编辑前会自动弹出 `[xteam] 冲突` 警告。看到就停手，改别的文件或去协调。
- **决策要可见 / make decisions visible**：发现冲突时，把决定写清楚（"我先改 X，等 owner 放锁再回来"），并用 `say` 发到群里，让别的对话也能看到。
- **stale 锁 / stale locks**：`HELD … (STALE)` 表示对方可能挂了没释放，用 `takeover <path> --owner <你>` 接管。
- **长任务 / long tasks**：单次改动预计 >30 分钟，中途跑一次 `heartbeat <path>` 续期，避免被误判 stale。
- **Codex 场景 / Codex delegation**：Claude 是指挥，Codex 落盘。派 Codex 改哪些文件，就**先锁哪些路径**，Codex 干完再放。Codex 不感知锁，所以在给 Codex 的提示词里写"只动 X 下的文件"；探索用 `-s read-only`，落盘才用 workspace-write。
- **省 token / token economy**：看状态用 `status`（只含活会话 + 活锁 + 最近几条聊天），不要 `cat` 整个 `chat.log`；要看更多用 `tail N`。
- **更新 / update**：`xteam update` 从 GitHub 拉最新版本并原地覆盖；`xteam version` 看版本号。或重跑安装脚本（clone / npx / curl 都行）。

## 状态存哪 / State location

`<repo>/.claude/xteam/`（已 gitignore，运行时数据）—— `locks/` 是锁（每个锁一个目录 + `meta.json`），`presence/` 是会话在线状态，`chat.log` 是群聊。纯文本/JSON，可直接看。
