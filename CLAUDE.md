# xteam — 项目理解与协作规则

xteam 是 Claude Code / Codex 等 AI 会话的**跨会话协作 + 多模型作战室**：文件锁防冲突、共享群聊通消息、跨模型 ask/bridge（GPT 等进群混编）、wake 定时唤醒防挂死、models 枚举、i18n 多语言输出。目标形态：装完零配置，AI 自己就会用。

## 技术约束（不可违背）

- **纯 Node 内置模块、零依赖**，单文件 `xteam.mjs` 为主体，Node ≥ 18（用到内置 `fetch`）。
- 跨平台：Windows / macOS / Linux 行为一致。Windows 是测试重点（npm `.cmd` shim、cmd 转义、终端 codepage 全是坑，见下）。
- 状态在 `<repo>/.claude/xteam/`（gitignore），安装产物在 `~/.claude/skills/xteam/` + `~/.claude/commands/xteam.md`，hooks/statusLine 写 `~/.claude/settings.json`（`--local` 改写 settings.local.json，防 cc-switch 类切换器冲掉）。
- 文档三件套各司其职，**不要互相复制内容**：`README.md` 极简四块（介绍/安装更新/两段 CLAUDE.md·AGENTS.md 接入示例，给人看）；`SKILL.md` 场景导向（给装好后的 AI 用）；`xteam help` 即时命令速查。项目开发规则就是本文件。

## 架构速览（xteam.mjs 内部分区）

| 区 | 内容 |
|---|---|
| 锁 | `acquire/release/check/wait/takeover/heartbeat`，mkdir 原子拿锁，目录锁覆盖子树 |
| presence | 会话在线心跳；`status/check/say/statusline` 都会续期并滑动续自己的锁（renewOwnLocks） |
| 群聊 | `say/tail`，`chat.log` append-only + `chat.seq` 全局单调序号 |
| 跨模型 | `ask`（单次）/`bridge`（驻场桥）/`models`（枚举），后端 `api:`（OpenAI 兼容）与 `cli:`（任意 CLI）双轨 |
| 唤醒 | `wake` 定时 @全体 催报，点名 idle/无响应者 |
| i18n | `t()` + MSG 目录 + `i18n/<lang>.json` 翻译缓存 |
| 自更新 | `update` 从 GitHub main 拉 SKILL.md/xteam.mjs/commands 覆盖安装目录 |

## 核心设计决策（改代码前先理解为什么）

1. **锁 = 租期 + 最后通牒**，区分「慢而活」与「死/忘放锁」：
   - `lease`（默认 30min，`acquire --lease <秒>` 拉长）内**绝对不可抢**——慢工长任务不能被接管，否则两人改同一文件。
   - 租期过只是通牒候选：`wait` 接管前群内 @持有者 下最后通牒（`TAKEOVER_GRACE` 宽限），宽限内持有者 `say`/`heartbeat` 一条即作废通牒。持续零响应才按排队顺序自动接管。
   - `orphaned`（会话消失 + 锁过期）排队者直接自动接手。
2. **群聊消息带全局单调序号 `#N`**（`chat.seq` 文件 + mkdir 自旋），**绝不用内容 hash 做去重游标**——同样内容说两次，hash 会漏掉第二条（踩过）。rotate 截断日志不影响 seq。
3. **群聊即共享记忆**：bridge 驻场的外部 agent 无状态没关系，每轮把未读喂给它、回复贴回群聊。启动基线：历史消息一律视为已读。
4. **agent 显示名 = `<model>-<name>`**（如 `codex-reviewer`），@显示名或 @短名都触发——群里一眼看出谁是哪个大脑。
5. **i18n 永不反复翻译**：中英内置模板（零 AI 可用）；其他语言首用时 AI 翻译一次落盘（pack 带 `sourceHash`，源模板不变永不重翻）；无 LLM 回退英文（ASCII 安全）。
6. **写审分离的精神**：xteam 自身是协作工具，所有多 agent 场景都要保证"冲突可见、接管有据、慢工不受伤"。

## 开发规则

- 改 `xteam.mjs` 后必跑：`node --check xteam.mjs` + **场景实测**（锁冲突/wait 接手/通牒救回/ask/bridge 真跑一轮）。测试用 `XTEAM_OWNER=xxx` 模拟多会话，短参（`XTEAM_WAIT_POLL=2` 等）加速。
- **新 UI 文案一律进 MSG 目录**（中英双条），调用处走 `t(key, vars)`，不许硬编码输出字符串。改了英文源 = `sourceHash` 变 = 各语言下次自动重翻，属预期行为。
- `help` 文档与群聊消息**内容**不翻译（命令名翻坏会出事）。
- 版本号两处同步：`xteam.mjs` 的 `VERSION` 与 `package.json`。
- 安装目录同步：改完 `cp xteam.mjs SKILL.md ~/.claude/skills/xteam/`（以及 `commands/xteam.md` → `~/.claude/commands/`），再本机验证。
- 提交信息：中文 conventional（`feat:/fix:/docs:` + 一句主旨 + 要点列表）。

## Windows 坑清单（都踩过，别回退）

- **npm CLI 是 `.cmd` shim**：`spawnSync` 无 shell 必 ENOENT。win32 下经 shell 跑；`{text}` 自由文本仅纯 ASCII 且不含 `%`（cmd 展开 `%VAR%`、codepage 弄坏中文），**推荐 stdin 模板**（如 `codex exec -s read-only -`，argv 全固定零转义）。
- shell 调用用**单 command 字符串**拼（固定 token 逐个引号），不用 args 数组 + shell（Node DEP0190：只拼接不转义）。
- `waiterDir` 的 hash 输入里 `${p}` 与 `${who}` 之间是 **NUL 分隔符**（防路径含空格碰撞，故意的）；grep/edit 会把文件当 binary，用 `grep -a` 或 node 脚本按字节改，**改含中文的文件用 latin1 字节透传**（UTF-8 字节不损）。
- Windows 路径大小写：`lockKey()` 做 key 前 lowercase 归一（`A.txt`/`a.txt` 是同一把锁）。
- `path.relative` 在 win32 大小写不敏感，绝对路径会归一成相对路径——这是好事，别破坏 `normalize()`。

## 锁/身份语义备忘

- `owner` 来源优先级：`XTEAM_OWNER` → session id → `git config user.name`。**git fallback 可能被多个无 session 进程共享**（撞车）：acquire 会警告，preedit 对 git 身份**不放行**"自己"的锁（宁可误报）。
- `release`/`heartbeat` 只能操作自己的锁，越权要 `--force` 显式逃生口。
- preedit hook 是**劝阻**（stderr 警告 + exit 0）不是机器阻断——防冲突的最终保障是锁协议本身。

## 不做的事

- 不做协议代理（OpenAI/Anthropic 互转）——消息桥（ask/bridge）已覆盖"多模型交互"需求。
- 不做重依赖/构建链/测试框架——保持零依赖单文件。
- README 不放大而全的命令表/FAQ（那是 SKILL.md 和 help 的事）。
