---
description: Show xteam usage & protocol — locks, group chat, multi-model ask/bridge, wake
---

Run the full help first, then follow the protocol.

```bash
node ~/.claude/skills/xteam/xteam.mjs help
```

## What xteam is / 是什么

跨会话协作 + 多模型作战室：**文件锁**（防多会话改同一文件）· **群聊**（`say`/`tail`）· **跨模型**（`ask` 单次问 GPT 等 / `bridge` 让外部模型驻场群聊）· **`wake`**（定时 @全体 催报防挂死）· **`models`**（枚举可用模型）· 自动 i18n。详细场景导航见 SKILL.md（skill 首页），命令速查见 `xteam help`。

## Protocol / 铁律（编辑任何文件前）

0. `xteam label "<task>"` — name this session.
1. `xteam check <path>` — `FREE` or `HELD`?
2. FREE → `xteam acquire <path> --note "<what>"`. HELD → **background** `xteam wait <path>`
   (`run_in_background=true`) then end your turn — it @-pings the holder and auto-acquires on release
   (you get `<task-notification>`). Never poll, never edit a locked path anyway.
3. `xteam say "锁了 <path>，在做什么"` — post progress.
4. Edit / delegate.
5. `xteam release <path>` when done (auto @-notifies waiters).
6. `xteam release --all` before you finish the turn.

- Lock whole directories for module work (covers subtree).
- A lock is takeable only when the OWNER SESSION is gone (`ORPHANED`), never merely idle —
  a long Codex write looks exactly like an idle lock. `takeover` refuses while owner is ALIVE.
- Your own locks auto-renew on every `status`/`check`.
- After launching background `wait`, **report in plain text** before ending your turn (who holds it,
  what you're waiting for, that you'll auto-take over) — never leave the raw background-task ID as the status.

## Multi-model / 跨模型

- `xteam ask -m cli:gpt55 "..."` — ask another model once. Routes: `export XTEAM_CLI_GPT55="codex exec -m gpt-5.5 -s read-only -"`.
- `xteam bridge --name reviewer -m cli:gpt55` (background) — resident agent in chat; `@reviewer` gets replies.
- `xteam wake --interval 180` (background) — periodic `@all` status check; names unresponsive sessions.
- `xteam models` — list available models. codex `-m` needs the FULL model id (`gpt-5.5-luna`, not `luna`).
