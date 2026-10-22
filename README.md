# pi-cc-monitor

> 把 Claude Code 的 `Monitor` 搬到 Pi：后台命令或 WebSocket 的每一行输出都是一个事件，事件会唤醒 agent。

## 快速开始

```bash
# 本地开发：把仓库软链接到 Pi 扩展目录
ln -sfn "$PWD" ~/.pi/agent/extensions/pi-cc-monitor

# 发布后
pi install npm:pi-cc-monitor
```

安装后执行 `/reload`。

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
| `loopPrompt` | string? | 所属 `/loop` 的 prompt（原样）；loop 结束时连带停止 |

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

模型会起一个带 `loopPrompt` 的 Monitor。事件到达即唤醒 agent；`schedule_wakeup` 的延迟是兜底心跳，事件不会取消它。loop 结束时，绑定的 Monitor 会被静默停止。

## 规则

- 只有 stdout 是事件流；stderr 写进文件，不触发唤醒
- 退出、停止、超时都只发一条结束通知；停止之后的输出会被丢弃
- 空行不算事件；超长内容以 `...(truncated)` 截断
- 输出日志在 `$TMPDIR/pi-cc-monitor/`，保留 3 天
- 管道要逐行 flush：`grep --line-buffered`；`head` 不行
- 只匹配成功标记的脚本在 crash/hang 时会静默；把 `ERROR|FAILED|Killed` 也覆盖进去
- `tail -f` / `while true` 不会自己退出；不需要时用 `monitor_stop` 或 `timeout_ms`
- 每行都是一条消息；测试时别一次打印几十行

## 渲染

事件消息不做单独渲染：走 Pi 的默认自定义消息样式，标签就是 `[Monitor]`，内容是
`monitor <id> · <描述>` 加事件行。`compactMessages` 只影响 pi-cc-loop 的定时任务块，
对本扩展无效。

> 本扩展不写其他插件的配置文件。

## 兼容性

- Node.js `>=22.19.0`
- Pi `1.3.0`（开发环境）
- `pi-cc-loop` 可选；两者通过 `pi.events` 通信

## 本地开发

```bash
node --test tests/*.test.mjs
npx --yes typescript@5.9.3 tsc --noEmit -p tsconfig.json
```

## 说明

- 行为对齐 Claude Code v2.1.306 的 `Monitor`，用 Pi 扩展 API 实现。
- `monitor_stop` / `monitor_list` 对应 CC 的 `TaskStop` / `TaskList`。
- 事件来源用消息前缀 `[monitor · ...]` 标记，而不是 CC 的 `<task-notification>` 元数据。
- 和 `pi-cc-loop` 一起用时，`/loop stop` 会停掉该 chain 绑定的 Monitor。
- Pi 异常退出（没走 `session_shutdown`）时，也会在进程退出前杀掉 Monitor 的进程组。

## 许可证

MIT
