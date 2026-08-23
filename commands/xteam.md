---
description: Show xteam coordination help (bilingual) — cross-session locks + group chat
---

Run the xteam help (bilingual usage), then follow the protocol.

```bash
node ~/.claude/skills/xteam/xteam.mjs help
```

## Protocol / 协议 (before editing any file or delegating to Codex)

0. `xteam label "<task>"` — name this session (shown as `<id>-<task>`)
1. `xteam check <path>` — FREE or HELD?
2. FREE → `xteam acquire <path> --note "<what you're doing>"`
   HELD → run `xteam wait <path>` in the **background** (`run_in_background=true`), then end your turn. It @-pings the holder, queues you, and auto-acquires the moment they release — Claude Code wakes you via `<task-notification>`. Don't poll or sleep on it. Never edit a locked path anyway.
3. `xteam say "锁了 <path>, 在做什么"` to post progress
4. Edit / delegate to Codex.
5. `xteam release <path>` when done — automatically @-notifies everyone waiting on it.

- Lock whole directories when touching a module (covers subtree).
- `HELD … (STALE)` → `xteam takeover <path> --owner <name>`.
- Holder unresponsive but not yet stale? Background `xteam wait` — it returns the moment they release, or tells you to `takeover` if they go stale. Don't force the edit.
- Owner is auto-detected from the session; pass `--owner A` only for a readable name.
- After launching a background `wait`, **report in plain text before ending your turn** — never leave the raw `Command running in background with ID: …` as the user-facing status:

  ```
  Xteam: 已排队等 crates/Wanli_Config/src/actor.rs
    持有者：e193b67b（idle 17m）
    它一放锁我会被自动叫醒，然后立刻落盘。
  ```
