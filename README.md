<div align="center">

# 🧩 xteam

**多会话协作 + 多模型混编的作战室：文件锁防冲突、群聊通消息、GPT 进群混编、定时唤醒防挂死。**
*Cross-session coordination + multi-model agent room: file locks, shared group chat, GPT/Codex mixed in, periodic wake to keep agents alive.*

</div>

---

## 安装 Install

在 **Claude Code / Codex** 对话里说一句，它会自己装好（自动配 hook + 状态栏，新会话即生效）：

```
帮我安装 https://github.com/ji4ozhu/xteam 这个插件
```
```
Install the xteam plugin from https://github.com/ji4ozhu/xteam
```

或手动（需 Node ≥ 18）：

```bash
git clone https://github.com/ji4ozhu/xteam && cd xteam && node install.mjs
```

## 更新 Update

```
xteam update
```

## 接入你的项目：写进 CLAUDE.md / AGENTS.md 的示例

把下面对应场景的段落复制进你项目的 `CLAUDE.md`（或 `AGENTS.md`），AI 读到就会照做。

### 场景 1 · 单模型、多 Agent 协作（多个会话并行改一个仓库）

> 多会话协作（xteam）：编辑任何文件前先 `node ~/.claude/skills/xteam/xteam.mjs acquire <path> --note "在做什么"` 加锁（锁目录覆盖子树），改完 `release <path>`，收尾 `release --all`；进度用 `xteam say "..."` 发群聊互通，看现场用 `xteam status`。被别的会话锁住就**后台** `xteam wait <path>` 排队（放锁自动接手），不许硬改、不许干等。多人协作的任务分派、进度汇报、验收都走群聊（`xteam say`，可以 `@会话名`）。长任务起 `xteam wake --interval 180` 防有 agent 超时无响应——它会定时 @全体 催报并点名掉队者。

> Multi-session coordination (xteam): before editing ANY file, lock it with `node ~/.claude/skills/xteam/xteam.mjs acquire <path> --note "what you're doing"` (dir locks cover the subtree), `release <path>` when done, `release --all` before you finish. Post progress via `xteam say "..."`; check the room with `xteam status`. If a path is held by another session, queue with `xteam wait <path>` in the background (auto-acquires on release) — never force the edit. Task assignment, progress reports and sign-offs all happen in the group chat (`xteam say`, `@session-name` to address someone). For long work, start `xteam wake --interval 180` so stalled agents get named instead of silently dying.

### 场景 2 · Claude + Codex(GPT) 多模型多 Agent 混编协作

> 多模型混编协作（xteam + codex）：文件锁与群聊协议同上（acquire/release/say/wait）。跨模型协作：单次咨询/交叉审查用 `XTEAM_CLI_GPT55="codex exec -m gpt-5.5 -s read-only -" node ~/.claude/skills/xteam/xteam.mjs ask -m cli:gpt55 "问题"`；让 GPT 驻场群聊用后台 `xteam bridge --name reviewer -m cli:gpt55`，之后群里 `@reviewer` 提问即可，问答全员可见。模型分配：方案咨询用 gpt-5.5、代码审查用 gpt-5.5-luna（`-m` 一律写完整模型名），**谁写代码谁不许审查**（写审分离，跨模型异构审查）。长任务照常起 `xteam wake`。`xteam models` 可查当前可用模型。

> Multi-model mixed collaboration (xteam + codex): same file-lock & chat protocol as above. Cross-model: one-shot consults / cross-review via `XTEAM_CLI_GPT55="codex exec -m gpt-5.5 -s read-only -" node ~/.claude/skills/xteam/xteam.mjs ask -m cli:gpt55 "question"`; make GPT a resident chat agent with `xteam bridge --name reviewer -m cli:gpt55` in the background, then just `@reviewer` in the chat — answers are visible to everyone. Model assignment: gpt-5.5 for design consults, gpt-5.5-luna for code review (always pass the FULL model id to `-m`), and **whoever writes the code must not review it** (cross-model review). Start `xteam wake` for long runs as usual. `xteam models` lists what's available.
