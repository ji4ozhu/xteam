---
name: xteam
description: 跨会话协作 + 多模型 agent 作战室 —— 文件锁（防多会话改同一文件）、共享群聊、跨模型咨询与驻场桥（ask/bridge，让 GPT 等外部模型进群混编）、定时唤醒（wake 防 agent 挂死）、模型枚举（models）、多语言输出（i18n）。什么时候用：同一仓库开多个会话/改任何文件前/派 Codex 干活前/需要另一个模型的意见或想让 GPT 驻场群聊/多 agent 长任务怕超时无响应。SessionStart 自动激活，零配置。Coordinates file edits and shares a group chat across concurrent Claude Code sessions (and external agents like Codex/GPT); also multi-model ask/bridge, periodic wake, model listing, i18n. Use BEFORE editing any file, before delegating to Codex, when another model's opinion helps, or when long multi-agent work needs a heartbeat.
---

# xteam — 跨会话协作 + 多模型作战室

同一个仓库里多个并行会话（每个都可能派 Codex/挂 GPT）协调"谁改哪个文件"、互通进展、互相派活、跨模型互评。**锁防冲突，群聊通消息，ask/bridge 接外部大脑，wake 防挂死。** 状态在 `<repo>/.claude/xteam/`，纯 Node 零依赖，跨平台。

## 30 秒上手（新会话先看这段）

```bash
node ~/.claude/skills/xteam/xteam.mjs <子命令>   # 下文简写为 xteam
```

| 命令 | 干什么 |
|---|---|
| `xteam status` | 一眼看清：谁在线、谁锁着什么、群里在聊什么 |
| `xteam acquire <path> --note "在做什么"` | 改文件前**必须**加锁（目录锁覆盖子树） |
| `xteam release <path>` / `xteam release --all` | 改完放锁（收尾必放全部） |
| `xteam say "..."` / `xteam tail` | 群聊发言 / 看最近消息 |
| `xteam ask -m cli:codex "问题"` | 问另一个模型（如 GPT），秒级返回 |
| `xteam models` | 看当前有哪些模型可用 |

## 场景导航：我要做 X → 用什么

| 我要… | 用法 |
|---|---|
| 改文件，怕和别的会话撞车 | `check` → `acquire` → 改 → `release`（铁律见下） |
| 别人锁着我要的文件 | **后台** `xteam wait <path>` 排队，放锁自动接手（别硬改、别干等） |
| 跟其他会话说话 / 派活 / 报进展 | `xteam say "@名字 任务…"`；看历史 `xteam tail` |
| 问另一个模型的意见 | `xteam ask -m cli:gpt55 "…"`（route 见下） |
| 让 GPT 常驻群聊当顾问 | 后台 `xteam bridge --name reviewer -m cli:gpt55`，群里 `@reviewer` 必回 |
| 多 agent 长任务怕超时/挂死 | 后台 `xteam wake --interval 180`，每 3 分钟 @全体 催报，无响应者被点名 |
| 看有哪些模型 / 确认 route 注册好没 | `xteam models` |
| 输出想换语言 / 非中文系统怕乱码 | 自动跟随系统 locale；`XTEAM_LANG=en` 显式指定 |
| 起个好认的名字 | `xteam label "改Auth"`（显示为 `<id>-改Auth`） |

## 铁律（编辑任何文件前 / before editing）

0. **名**：开工先 `xteam label "<任务名>"`。
1. **查** `xteam check <path>` → `FREE` 才动；`HELD` 就别碰。
2. **拿** `xteam acquire <path> --note "<在做什么>"`（动模块锁整个目录）。
3. **说** `xteam say "锁了 <path>，<在做什么>，<预计>"`。
4. **改** 正常编辑 / 派活。
5. **放** `xteam release <path>`（自动 @ 通知排队者）。
6. **收尾** `xteam release --all`——会话退出后没人替你放锁。

**锁不会因为「很久没动」就能抢**，判据是持有者会话是否还活着（presence 心跳）：
`owner is ALIVE`（可能在长落盘，**绝不能抢**）→ 后台 wait 或群里问；
`会话已退出` → 等到期或后台 wait；
`ORPHANED/无主` → `xteam takeover <path>` 可安全接管。
你自己的锁在每次 `status`/`check` 时自动续期。

**wait 必须后台跑**（`run_in_background=true`）然后**结束本轮**——它 @ 持有者、排队、放锁瞬间自动接手并被 `<task-notification>` 唤醒。不要轮询、不要 sleep 守着。启动后用人话汇报再收尾：

```
Xteam: 已排队等 src/foo.cpp
  持有者：e193b67b-改Auth（idle 17m）
  它一放锁我自动接手，然后立刻开工。
```

## 跨模型：ask / bridge / models

model spec：`cli:<name>`（本地 CLI，主打 codex）· `api:<model>`（OpenAI 兼容口）· 裸模型名（=api:）。

```bash
# route 注册（一次性，shell profile）——cli 后端每个模型一个 route
export XTEAM_CLI_GPT55="codex exec -m gpt-5.5 -s read-only -"   # 末尾 "-" 走 stdin，零转义
export XTEAM_LLM_API_KEY=...                                     # api 后端才需要

xteam ask -m cli:gpt55 "评审这段协议设计"              # 单次咨询
xteam bridge --name reviewer -m cli:gpt55              # 驻场：群聊 @reviewer 必回（后台跑）
xteam models                                           # 枚举可用模型
```

- **驻场桥**显示名自动带模型前缀：`gpt55-reviewer`；`@显示名` 或 `@reviewer` 都触发。默认每 60s 把未读群聊打包征求意见（没实质贡献它回 `(silent)` 不刷屏），`--no-digest` 只回 @。**群聊即共享记忆**——外部 agent 无状态也没关系，未读喂给它、回复贴回群聊。
- **codex 的 `-m` 写完整模型名**（`gpt-5.5-luna` 不是 `luna`）；报 `No available channel for model X` = relay 渠道没开通道，不是名字错。
- api 后端需 `XTEAM_LLM_API_BASE`（默认 OpenAI 官方）+ `XTEAM_LLM_API_KEY`。
- 复杂命令包一层 `.bat`/`.sh` 再指向它；`{text}` 占位在 Windows 仅纯 ASCII（推荐 stdin 模板）。

## wake 定时唤醒（防挂死）

```bash
xteam wake --interval 180   # 后台跑；默认 180s
```

每周期群聊 `@全体` 催报进展，消息自带在线态势（谁 idle 多久），**超过一个周期没动静的会话被点名**——多 agent 长任务必开。

## i18n（输出语言）

跟随系统 locale（zh/en 内置模板）；其他语言首次使用时自动调一次 AI 翻译并缓存（`i18n/<lang>.json`，源不变永不重翻）；没配 LLM 回退英文（不乱码）。`XTEAM_LANG=<lang>` 显式覆盖。`help` 与群聊消息内容不翻译。

## 状态存哪 / State

`<repo>/.claude/xteam/`（已 gitignore）：`locks/` `presence/` `waiters/` `chat.log` `chat.seq`。锁 TTL 2700s（`XTEAM_TTL`）。底部 statusLine 每轮自动刷新简报（兼心跳）。完整帮助 `xteam help`。
