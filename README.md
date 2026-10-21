# pi-cc-monitor

Claude Code 的 `Monitor` 工具，搬到 Pi coding agent 上。

一个 monitor 在后台跑命令（或开一个 WebSocket），把它的输出变成**通知**，
通知会**唤醒 agent**。这样你不用轮询，事件到了自然有人叫你。

```
Monitor({
  command: "tail -f deploy.log | grep --line-buffered ERROR",
  description: "errors in deploy.log"
})
```

---

## 用法

### 工具

| 工具 | 说明 |
| --- | --- |
| `Monitor` | 起一个后台监视 |
| `monitor_stop` | 按 id 停掉一个监视 |
| `monitor_list` | 列出当前所有监视；运行时长在退出后冻结，并显示 exit code |

### `Monitor` 的参数

Schema 与 Claude Code v2.1.306 **逐字段一致**：

| 参数 | 类型 | 约束 |
| --- | --- | --- |
| `command` | string? | 脚本或命令。**stdout 每行是一个事件**；进程退出即结束监视。拒绝 control 字符 |
| `ws` | object? | `{ url, protocols? }`。每个 text frame 是一个事件；binary frame 记为 `[binary frame, N bytes]`；连接关闭即结束监视 |
| `description` | string | 一句话说明在盯什么，**会出现在每条通知里** |
| `timeout_ms` | number? | min 1000，default **300000**（5 分钟），max **3600000**（1 小时） |
| `persistent` | boolean? | default false。为 true 时跑到会话结束，不超时 |

外加一个 Pi 专属字段：

| 参数 | 说明 |
| --- | --- |
| `loopPrompt` | 这个监视属于哪条 `/loop` chain。填了之后，事件会**顶掉**那条 chain 的兜底心跳 |

校验规则也照抄 CC：

- `command` 和 `ws` **必须二选一**（否则报 `exactly one of command or ws`）
- `command` / `ws.url` 拒绝 control 字符
- `ws.url` 必须是纯 ASCII 的 `ws://` 或 `wss://`，不能带 userinfo，不能带 tab/换行
- `ws.protocols` 必须是唯一的 RFC 6455 token
- `timeout_ms` 超出范围直接拒绝（`persistent` 时忽略）

> CC 的报错文案写的是 "no whitespace"，但它自己的检查只拒绝 `\t \n \r` 和非 ASCII，
> 路径里的普通空格是放行的。这里**行为跟 CC 一致**，文案改准确了。

### 事件怎么到达 agent

每条通知是一个 custom message，界面上画成两行的轻量块（无图标、无底色。Pi 默认会画成
`[pi-cc-monitor-event]` 这种机器名，本扩展注册了自己的 renderer）：

```
monitor · 4:14 PM · errors in deploy.log
  ERROR: connection refused on :3000
  ERROR: retry failed
  ERROR: gave up
  +1 more lines
```

折叠态最多显示 3 行输出，超出时用 `+N more lines` 标记；`Ctrl+O` 展开后显示完整输出和
`id … · N events`。renderer 只影响显示，模型看到的内容不变。

投递走 `followUp` 低优先级通道 —— agent 忙的时候排队等这一轮结束，不会插进去打断
（对齐 CC 的 *"A scheduled prompt fires between your turns, not while Claude is
mid-response"*）。

同时会往 event bus 发一个 `monitor:wake` 事件：

```ts
{
  monitorId: string,
  description: string,
  kind: "command" | "ws",
  cause: "output" | "exit" | "timeout" | "error" | "closed" | "stopped" | "flooded",
  lines: string[],
  eventCount: number,
  loopPrompt?: string,
}
```

### 界面设置（与 pi-cc-loop 共享）

两个扩展读同一个 `~/.pi/agent/pi-cc.json`，用 `/loop settings` 切换：

```
/loop settings messages on|off   紧凑消息 / 旧的带底色卡片
/loop settings tools on|off      一行工具结果 / Pi 默认工具行
```

如果装了 `pi-cc-extensions`，`tools on` 时本扩展会把 `Monitor` / `monitor_stop` /
`monitor_list` 加进它的 `excludeRenderers`（`tools off` 时只移除自己加的名字），
它只在启动时读配置，所以切换后需要 `/reload`。设 `"managePiCcExtensions": false`
或 `PI_CC_MANAGE_CCSTYLE=0` 可关闭自动同步。

`compactToolRows` 打开时，三个工具的结果也压成一行（结果返回后调用行自动隐藏）：

```
✓ Armed bd9j9ugm · 60m timeout · errors in deploy.log
✓ Stopped bd9j9ugm
✓ 2 monitors · bd9j9ugm running (3 events) · xyz stopped (0 events)
```

也可以直接编辑配置文件后 `/reload`。环境变量 `PI_CC_COMPACT_MESSAGES=0` /
`PI_CC_COMPACT_TOOL_ROWS=0` 可临时覆盖。


---

## 对齐 Claude Code 的细节

| CC 行为 | pi-cc-monitor |
| --- | --- |
| stdout 每行 = 一个事件 | ✅ |
| 200ms 内到达的行合并成一条通知 | ✅ `BATCH_WINDOW_MS` |
| 退出即结束监视，退出码要报出来 | ✅ |
| stderr 不触发通知，只进输出文件 | ✅ |
| `description` 出现在每条通知里 | ✅ |
| `timeout_ms` 默认 5 分钟 / 上限 1 小时 | ✅ |
| `persistent: true` 跑到会话结束 | ✅ |
| ws：text frame = 一个事件，binary = 占位行 | ✅ |
| ws：关闭时带上 close code | ✅ |
| ws：错误先于 close 报出 | ✅ |
| 事件到达 = 开一轮 turn（不是 user reply） | ✅ |
| 输出洪水自动停掉 | ✅ 见下 |
| 进程组 kill，不留孤儿 | ✅ |
| 「和 Bash 同一个 shell 环境」 | ⚠️ 拿不到 pi 的 `getShellEnv()`，自己按同规则拼 |

### 洪水保护

用 CC 运行时的两个常量：

- `QUIET_GAP_MS = 2000` —— 间隔短于 2 秒算「连续输出」
- `KILL_AFTER_MS = 600000` —— 连续输出超过 10 分钟 → 判定为 firehose → 停掉

另加一道硬上限 `MAX_EVENTS = 2000`，防止脚本失控刷爆 transcript。

### 输出文件

stdout / stderr 分别落在 `$TMPDIR/pi-cc-monitor/<id>.out.log` 和 `<id>.err.log`，
路径在通知的 details 里，模型可以用 `read` 工具去看。

---

## 与 pi-cc-loop 的协作

装了 pi-cc-loop 之后，自选间隔的 `/loop` chain 可以被事件直接唤醒：

```
/loop check whether the deploy finished
```

chain 会告诉模型：

> Arm the `Monitor` tool with `loopPrompt` set to "check whether the deploy finished"
> so the event wakes this chain immediately instead of waiting for the next heartbeat.

模型 arm monitor 时带上 `loopPrompt`，之后：

1. monitor 事件到达 → pi-cc-monitor 发 `monitor:wake`
2. pi-cc-loop 收到 → **顶掉**这条 chain 的兜底心跳，并标记「模型该重新调度了」
3. agent 被唤醒处理事件 → 模型再调 `schedule_wakeup` 续上

反向也有一条通道：pi-cc-loop 在 chain 结束（`/loop stop`、模型调 `stop: true`、
keepalive 用完、超龄）时发 `loop:stopped`，本扩展收到后停掉 `loopPrompt` 匹配的
monitor —— 对齐 CC 的 *"call ScheduleWakeup with stop: true and TaskStop any Monitor
you armed"*。

> 不带 `loopPrompt` 的 monitor 是独立用途的，不受 loop 停止影响。

`loopPrompt` 是**同步**处理的：pi-cc-monitor 先发 bus 事件再发通知，所以 loop 侧的
取消动作一定发生在那一轮开始之前。

没装 pi-cc-loop 时，`Monitor` 依然独立可用（"deploy 好了叫我一声"）。

---

## 与 Claude Code 的差异

| | Claude Code | pi-cc-monitor |
| --- | --- | --- |
| 停止监视 | `TaskStop` | `monitor_stop`（Pi 没有通用 task 原语） |
| 列出监视 | `TaskList` / `/tasks` 面板 | `monitor_list` |
| 事件来源标记 | `<task-notification>` 一等公民，带 `turnAttribution` / `isHousekeeping` | 只能靠消息前缀 `[monitor · ...]` |
| 域名白名单 | `allowed_domains` | 无（Pi 的沙箱是路径级的） |
| 权限审批 | ToolHost 的 `monitor_input` + `deny_rules` | Pi 的 `tool_call` hook（机制不同） |
| shell 环境 | 与 Bash 完全一致 | 路径/参数一致，env 自己拼（少 `getShellEnv()`） |
| 服务端版 `RunMonitorCommand` | 有 | 无（Pi 是纯本地，不该有） |

---

## 文件

```
index.ts      Monitor / monitor_stop / monitor_list，事件分发
config.ts     共享设置（~/.pi/agent/pi-cc.json）
process.ts    detached spawn + 进程组 kill
stream.ts     逐行切分 + 200ms 批量 + 洪水检测
shell.ts      shell 配置与环境
tests/        单元测试
```

## 测试

```bash
cd ~/workspace/pi_extensions/pi-cc-monitor
node --test tests/*.test.mjs
```
