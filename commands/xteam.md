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
6. `xteam release --all` before you finish the turn — nobody releases your locks after the session exits.

- Lock whole directories when touching a module (covers subtree).
- **A lock is takeable only when the OWNER SESSION is gone** (`ORPHANED`), never merely because the lock looks idle — a long Codex write looks exactly like an idle lock. `takeover` refuses while the owner is alive.
- `ORPHANED/无主` → `xteam takeover <path>`. `owner is ALIVE` → don't touch it; background `xteam wait`, or ask via `xteam say`.
- Your own locks auto-renew on every `status`/`check` — no manual `heartbeat` needed.
- Owner is auto-detected from the session; pass `--owner A` only for a readable name.
- After launching a background `wait`, **report in plain text before ending your turn** — never leave the raw `Command running in background with ID: …` as the user-facing status:

  ```
  Xteam: 已排队等 crates/Wanli_Config/src/actor.rs
    持有者：e193b67b（idle 17m）
    它一放锁我会被自动叫醒，然后立刻落盘。
  ```
