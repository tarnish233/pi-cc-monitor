# pi-cc-monitor

> 把 Claude Code 的 `Monitor` 搬到 Pi：后台命令或 WebSocket 的每一行输出都是一个事件，事件会唤醒 agent。

## 安装

```bash
pi install npm:pi-cc-monitor
```

安装后执行 `/reload`。本地开发时把仓库软链接到扩展目录即可：

```bash
ln -sfn "$PWD" ~/.pi/agent/extensions/pi-cc-monitor
```

## 功能

| 功能 | 说明 | 入口 |
| --- | --- | --- |
| 后台监视 | 命令 stdout 每行 = 一个事件；进程退出结束 | `Monitor` |
| WebSocket | 每个 text frame = 一个事件，binary 记为占位行 | `Monitor` |
| 事件唤醒 | 空闲时开一轮 turn；忙时在当前工具调用结束后插入（CC 的 next 优先级） | 自动 |
| 超时/常驻 | `timeout_ms` 默认 5 分钟；`persistent` 到会话结束 | `Monitor` |
| 批量 | 200ms 内的行合并成一条通知 | 自动 |
| 长度上限 | 单行 500 字符、单条通知 3000 字符，超出截断 | 自动 |
| 限流 | 突发 10 条、之后每 2 秒 1 条；超出的事件丢弃并提示，持续超量 30 秒自动停止 | 自动 |
| 停止/列表 | 按 id 停止、列出状态与退出码 | `monitor_stop` / `monitor_list` |
| 底部状态 | 运行中的 monitor 数：`monitor 2`；没有运行中的就不占位 | 自动 |

## 工具

| 工具 | 说明 |
| --- | --- |
| `Monitor` | 起一个后台监视 |
| `monitor_stop` | 按 id 停止 |
| `monitor_list` | 列出状态、事件数、退出码；退出后时长冻结 |

### Monitor 参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `command` | string? | 脚本；stdout 每行一个事件，退出结束 |
| `ws` | object? | `{ url, protocols? }`；text frame 一个事件 |
| `description` | string | 出现在每条通知里 |
| `timeout_ms` | number? | 1000–3600000，默认 300000 |
| `persistent` | boolean? | 会话级常驻，不超时 |
| `loopPrompt` | string? | 所属 `/loop` 的 prompt（原样），loop 结束时连带停止；只在装了 `pi-cc-loop` 时生效，否则忽略 |

`command` 和 `ws` 二选一。

## 用法

**等一个事件**

```json
{
  "command": "until curl -sf localhost:3000/health; do sleep 1; done",
  "description": "server is up"
}
```

**盯日志**

```json
{
  "command": "tail -f deploy.log | grep --line-buffered ERROR",
  "description": "deploy errors"
}
```

**配合 loop**

```text
/loop check whether the deploy finished
```

下一步要等外部事件时，模型会起一个带 `loopPrompt` 的 Monitor。事件到达即唤醒 agent；`schedule_wakeup` 的延迟是兜底心跳，事件不会取消它。loop 结束时，绑定的 Monitor 会被静默停止。

## 规则

- 命令和 Pi 的 bash 工具一样执行：用 Pi 设置里的 `shellPath`（支持开头的 `~`）和 `shellCommandPrefix`，PATH 最前面是 Pi 的 `bin` 目录
- 只有 stdout 是事件流；stderr 写进文件，不触发唤醒
- 退出、停止、超时都只发一条结束通知；停止之后的输出会被丢弃
- 空行不算事件；超长内容以 `...(truncated)` 截断
- 输出日志在 `$TMPDIR/pi-cc-monitor/`，保留 3 天；日志写不进去（磁盘满、临时目录被删）不影响监视
- 管道要逐行 flush：`grep --line-buffered`；`head` 不行
- 只匹配成功标记的脚本在 crash/hang 时会静默；把 `ERROR|FAILED|Killed` 也覆盖进去
- `tail -f` / `while true` 不会自己退出；不需要时用 `monitor_stop` 或 `timeout_ms`
- 每行都是一条消息；测试时别一次打印几十行

## 渲染

事件和 pi-cc-loop 的定时任务块一个样式：

```text
✻ monitor · 10:22pm · errors in deploy.log
   ERROR: connection refused on :3000

✻ monitor ended · 10:22pm · errors in deploy.log
   [Monitor ended — exit code 0, 3 events delivered]
```

表头按原因分：`monitor`（有事件）、`monitor ended`（命令退出）、`monitor expired`（超时）、
`monitor failed`（启动或连接失败）、`monitor closed`（WebSocket 关闭）、`monitor stopped`（手动停止或输出过多被停）。
折叠时正文最多 3 行，Ctrl+O 展开后多一行元信息（id、事件数、退出码）。

样式开关是 `~/.pi/agent/pi-cc.json` 里的 `compactMessages`（三个 pi-cc 扩展共用，用 `/pi_cc` 面板或 `/pi_cc messages on|off` 切换，
或用环境变量 `PI_CC_COMPACT_MESSAGES=0|1` 覆盖）；关闭时回到旧的带底色卡片。

## 底部状态

有 monitor 在运行时，Pi 底部显示 `monitor 2`（运行中的个数），和 pi-cc-loop 的 `loop 2 · next 3m` 同一格式；
全部结束后这一项消失。只在 monitor 启动或结束时更新，事件到达不会重绘底部。

- 装了 `pi-cc-extensions`：作为一个芯片出现在第 2 行，可在它的配置面板里移动或隐藏
- 没装：Pi 内置 footer 把它和其他扩展的状态按 key 排序、拼成一行，比如 `loop 1 · next 3m monitor 1`

开关是 pi-cc 扩展共用的 `footer`（`~/.pi/agent/pi-cc.json`，用 `/pi_cc` 面板或 `/pi_cc footer on|off` 切换，或用环境变量 `PI_CC_FOOTER=0|1` 覆盖）。

`/pi_cc` 由四个 pi-cc 包（loop、monitor、plugins、compact）共同提供：装了其中任意一个，命令就在；装了多个，也只有一个 `/pi_cc`
（同名命令会被 Pi 改名成 `/pi_cc:1`、`/pi_cc:2`，所以由最先加载的包认领注册）。本包从 0.6.0 起也提供它；面板按插件分页（Tab / Shift+Tab 切换）：本包的两项和 pi-cc-loop 共用，在 Loop & Monitor 页；Plugins 页属于 pi-cc-plugins，Compact 页属于 pi-cc-compact（装了才生效）；
之前设置要靠 pi-cc-loop 的 `/loop settings`，现在只装 monitor 也能调。

## 兼容性

- Node.js `>=22.19.0`
- Pi 1.3.0、1.4.0（测试通过）
- `pi-cc-loop` 可选；两者通过 `pi.events` 通信
- 与 `pi-cc-extensions` 共存。本扩展不写其他插件的配置文件；旧版本在 `pi-cc-extensions.json` 里加过的
  `Monitor`、`monitor_stop`、`monitor_list` 这几条 `excludeRenderers` 可以删掉

## 本地开发

```bash
node --test tests/*.test.mjs
npx --yes typescript@5.9.3 tsc --noEmit -p tsconfig.json
```

### 缓存约束

提示缓存按前缀匹配（工具 → system prompt → 消息）。本扩展只往对话末尾追加事件消息：不注册会改 prompt 或历史的钩子
（`before_agent_start` / `context` / `context_with_system` / `before_provider_request`），工具在加载时注册且描述固定。
`tests/cache.test.mjs` 守住这一点；真实 provider 的检查在 pi-cc-loop 的 `scripts/cache-check.mjs`，它会一起加载本扩展，覆盖 Monitor 事件。

## 与 Claude Code 的差异

行为对齐 Claude Code 2.1.308 的 `Monitor`，用 Pi 扩展 API 实现。有意不同的地方：

- `monitor_stop` / `monitor_list` 对应 CC 的 `TaskStop` / `TaskList`。
- 底部显示 `monitor 2`（和 pi-cc-loop 的芯片同一格式）；CC 底部的任务 pill 写作 `2 monitors`，还能选中后打开任务列表。
- 事件是 Pi 的自定义消息（类型 `Monitor`，正文首行 `monitor <id> · <描述>`），不是 CC 的 `<task-notification>`。
- `loopPrompt` 是额外加的：装了 pi-cc-loop 时，loop 结束会连带停掉绑定的 Monitor；CC 靠模型自己调用 `TaskStop`。
- Pi 异常退出（没走 `session_shutdown`）时，也会在进程退出前杀掉 Monitor 的进程组。

## 许可证

MIT
