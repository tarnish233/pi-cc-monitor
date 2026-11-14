# pi-cc-monitor

> 在 Pi 里统一后台命令与事件监视：`completion` 只在命令结束时通知一次；`events` 把命令的每行 stdout、WebSocket 的每个帧作为事件；也可以给已在运行的工作附加 literal watches，而不重启或拥有它。

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
| 后台执行 | `completion`：命令异步运行，stdout/stderr 只写日志；终态与尚未发送的末批输出合成一条可信结果 | `Monitor` |
| 后台监视 | `events`：命令 stdout 每行 = 一个事件；进程退出结束 | `Monitor` |
| WebSocket | `events`：每个 text frame = 一个事件，binary 记为占位行 | `Monitor` |
| 输出订阅 | `events` + `source.monitorId`：订阅本会话中运行中的 command Monitor；观察不拥有进程，停止/超时/flood 不影响工作 | `Monitor` |
| 动态 watches | literal、stdout/stderr/both、once/repeat、独立通知等级；`action=update` 原地更新，未变规则保留触发状态 | `Monitor` |
| 通知策略 | `notify.output=turn/context/none`、`notify.terminal=turn/context`；用户停止只记 context 不重启回合 | `Monitor` |
| 通知节奏 | completion 与 events 终态在忙时由插件暂存，Agent settled 后通知；中断只保存结果、不重启回复；events 普通输出仍为 steer | 自动 |
| 超时/常驻 | `timeout_ms`：completion 默认 30 分钟（上限 2 小时）；events 默认 5 分钟（上限 1 小时）；`persistent` 到会话结束 | `Monitor` |
| 批量 | events 模式：200ms 内的事件合并成一条通知 | 自动 |
| 长度上限 | events 模式：单行 500 字符、完整通知 3000 字符（含头部、抑制提示、换行和截断标记）；仅显示头部有界，原始描述保留在 metadata | 自动 |
| 限流 | events 模式：每来源突发 10 条、之后每 2 秒 1 条；持续超量 30 秒只停止该来源。另有会话级 20 条输出/60 秒预算：超出仅抑制并汇总，不停止工作，终态独立投递；汇总本身不占输出额度 | 自动 |
| 停止语义 | 先 `stopping`；SIGTERM→2s→SIGKILL→1s 确认。未确认时 `stop_timeout` 保留句柄可重试；`exited` 是逻辑结果，资源层单独跟踪到消失 | 自动 |
| 停止/列表 | 按 id 停止（source 只停订阅）、列出模式、状态、事件/抑制与退出码 | `monitor_stop` / `monitor_list` |
| 工具行 | `Monitor` / `monitor_stop` / `monitor_list` 交给 Pi 原生或 `pi-cc-extensions` 渲染；本扩展不注册自定义 tool renderer。`✻ monitor` 只用于异步事件卡片。 | 自动 |
| 任务面板 | 按真实 source 关系分组，区分 task/watcher/socket/subscription；语义分区详情、只读日志 + 显式停止；装了 pi-cc-loop 时还有 Loop 页 | `/tasks`（重名时改用 `/cc-tasks`，二选一） |
| 底部状态 | 活跃实例数：`2 monitors`；不是后台进程数，没有活跃实例就不占位 | 自动 |

## 工具

| 工具 | 说明 |
| --- | --- |
| `Monitor` | 启动 completion/events 任务，或 `source` 订阅；`action: "update"` 原地修改观察策略 |
| `monitor_stop` | 按 id 停止 |
| `monitor_list` | 列出模式、状态、事件数、退出码；退出后时长冻结 |

三个工具都声明了 `outputSchema`：开了 codemode 时，脚本里 `tools.Monitor(...)` 返回 `{ taskId, mode, kind, outputPath, stderrPath, … }`，`tools.monitor_list()` 返回 `{ monitors: [...] }`，批量起/停不用解析文本。没开 codemode 时没有影响。

显示名称按职责分为 `task`（command/completion）、`watcher`（command/events）、`socket`（ws/events）、`subscription`（source/events）；只是展示术语，不改 API 枚举或结构化结果。工具正文先显示操作结论与身份，再列设置、完整日志路径和模型等待规则。update 显示实际规则/通知变化；stop 明确影响范围，清理未确认不会声称成功。`monitor_list` 是状态快照，不是实时输出流。

任务面板入口（`/tasks` 或重名时改用的 `/cc-tasks`，只注册一个）是本地 TUI 命令，不是模型工具：它不出现在工具表里，不经过模型，也不改变工具的可用集合。监控本身仍只用上面的三个工具。

### Monitor 参数

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `"start" \| "update"`? | 缺省 start；update 必须带 `id`，只接受 `watches`/`notify`，绝不启动或重启工作 |
| `id` | string? | 仅 `action=update` 的目标 Monitor id |
| `source` | `{ monitorId }`? | events 专用：订阅本会话运行中的 command Monitor，不另起进程 |
| `watches` | WatchRule[]? | 仅 source observer：`{id,text,stream?,once?,notify?}`；literal 匹配，最多 20 条，`[]` 静音 |
| `notify` | object? | `output`：turn/context/none；`terminal`：turn/context。监听自身等级不能超过 Monitor 上限 |
| `mode` | `"completion" \| "events"`? | 通知模式；缺省为 `events` 保持旧调用兼容。completion 只支持 `command` |
| `command` | string? | 脚本；completion 记录日志并报告一次终态，events 每行 stdout 一个事件 |
| `ws` | object? | `{ url, protocols? }`；events 模式下 text frame 一个事件 |
| `description` | string | 出现在每条通知里 |
| `timeout_ms` | number? | 1000 起。completion 默认 1800000（30 分钟）、上限 7200000（2 小时）；events 默认 300000、上限 3600000 |
| `persistent` | boolean? | 会话级常驻，不超时 |
| `loopPrompt` | string? | 所属 `/loop` 的 prompt（原样），loop 结束时连带停止；只在装了 `pi-cc-loop` 时生效，否则忽略 |

`command`、`ws`、`source` 三选一；`watches` 只能配 `source`。新调用应显式选择 `mode`：只需要完成结果用 `completion`，每次发生都要通知用 `events`。预计长时间运行、等待外部条件或可能碰到前台 Bash timeout 的命令，应直接用 `completion`，不要先在前台 Bash 阻塞。这个选择规则同时写在工具描述和静态 `promptGuidelines` 中；不修改原生 Bash，也不注册动态 prompt hook。

completion 的默认期限是 30 分钟。长构建／测试应把 `timeout_ms` 设得足以覆盖预期耗时（最长 2 小时）；超时通知说明的是后台时限，不会显示成 `monitor expired`。退出码 0 记为 completed，非零／信号记为 failed。只有明确需要会话级常驻的进程才使用 `persistent: true`，它不是跨进程退出保留机制。

模型侧的选择规则保持精简：一次完成用 completion，每次发生用 events，长期工作的选择性输出用 completion + source observer。静态 `promptGuidelines` 只有三句（completion 替代前台 Bash、等待时结束回合、update 不得重启工作）。不修改原生 Bash，也不注册动态 prompt hook。

### 订阅与更新示例

```json
{ "command": "python train.py > train.log 2>&1", "description": "training run", "mode": "completion", "persistent": true }
```

```json
{ "mode": "events", "source": { "monitorId": "mon_ab12" }, "description": "training errors",
  "watches": [{ "id": "errors", "text": "Traceback", "stream": "both", "once": false, "notify": "turn" }] }
```

```json
{ "action": "update", "id": "mon_cd34", "watches": [], "notify": { "output": "context" } }
```

第二条只读取未来输出，`source` 不在同一主机/会话内或已结束时拒绝。第三条静音观察但训练继续；原始日志不受影响。

## 用法

**跑一次测试，结束后告诉我**

```json
{
  "command": "npm test",
  "description": "test suite",
  "mode": "completion",
  "timeout_ms": 600000
}
```

工具立即返回任务 ID 和日志路径。测试产生的 stdout/stderr 只写文件，不逐行进入对话；结束后模型收到一次退出码和日志路径。 忙碌时完成结果不进入 Pi 的可清除消息队列；如果当前回复被中断，已有完成结果会留在会话中，但不会强行重启该回复。中断之后才完成的新任务仍按正常的空闲通知规则处理。

**等一次服务就绪，但不阻塞主 agent**

```json
{
  "command": "until curl -sf localhost:3000/health; do sleep 1; done",
  "description": "server is up",
  "mode": "completion"
}
```

**盯日志**

```json
{
  "command": "tail -f deploy.log | grep --line-buffered ERROR",
  "description": "deploy errors",
  "mode": "events",
  "persistent": true
}
```

**配合 loop**

```text
/loop check whether the deploy finished
```

下一步要等外部事件时，模型会起一个带 `loopPrompt` 的 Monitor。事件到达即唤醒 agent；`schedule_wakeup` 的延迟是兜底心跳，事件不会取消它。loop 结束时，绑定的 Monitor 会被静默停止。

## 任务面板 `/tasks`

启动时二选一注册：`/tasks` 未被占用就只注册 `/tasks`；已被占用就只注册 `/cc-tasks`（连字符），不再注册旧的 `/cc_tasks`（下划线）。选中的入口打开原生的 Pi 浮层（`ctx.ui.custom(..., { overlay: true })`），不是编辑器快捷键。打开、刷新、关闭都不会发消息、不会开新一轮、不会改工具集；模型正在回复时也可以打开。RPC 模式通过 `ctx.ui.notify` 输出一段文字摘要；print/JSON 模式是安全 no-op（不调用 TUI 方法，也不输出摘要）。

```text
╭──────────────────────────────────────────────────────────────────╮
│ Tasks                                                  Esc close │
│ All 4  /  Monitor 4                                             │
├──────────────────────────────────────────────────────────────────┤
│ ▸ M ▾ running build · task · 2m 14s                              │
│   M   ↳ running build errors · subscription · 3 events           │
│   M   ↳ running progress · subscription · output muted           │
│   M running deploy errors · watcher · 1m 08s                     │
├──────────────────────────────────────────────────────────────────┤
│ Tab switch · ↑↓ select · Enter detail · x stop · Esc close       │
╰──────────────────────────────────────────────────────────────────╯
```

- **范围**：只列本会话的 Monitor；装了 pi-cc-loop 时，Loop 页显示该会话的定时任务和它可见的 durable 任务。别的会话执行的 durable 任务会标成 foreign，不会显示成“正在这里运行”。不做跨会话的全局面板。
- **Tab / Shift+Tab**：All 加已加载的 provider 页；只装本包时是 All / Monitor，同时装了 pi-cc-loop 才有 Loop，不显示未安装包的空页。上下键走 Pi 的 `tui.select.up/down` 命名动作，会跟随你的 keybindings；PgUp/PgDn 翻页。选中项用 `provider + id` 记录，列表更新后不会跳到别的任务。
- **Enter**：详情。Esc 先回列表，再按一次才关面板；关面板只关 UI，不取消任何任务，也不会把 Esc 传给 app.interrupt。
- **分组**：仅依据同一 provider 内真实的 source id 把 subscription 放在源命令下；不根据标题猜关系，不跨会话或跨 provider 关联。不存在的父项保留为根项；分组/刷新不改变选中对象身份。静音、规则耗尽是附加标记，不是 stopped 状态。
- **Monitor 详情**：按 State → Observation（events）→ Delivery → Lifetime → Logs 分区，显示真实状态、资源归属、source 关系、规则状态、通知策略、期限及日志。once 命中标为 consumed，repeat 命中仍 active；subscription 不显示自己拥有 PID，继承的退出码明确叫 Source exit。stdout/stderr 只读**有上限的尾部**（约最后 8KB / 60 行），ANSI 和控制字符会被剥掉。订阅看到的是完整源日志，不只是命中行；读取不会喂给事件流。
- **刷新**：任务变化会通知面板，但按 250ms 合并；时间显示每秒走一次。不会每来一行 stdout 就重绘。窄窗口、调整终端大小、宽字符（中文/emoji）、主题切换都有处理，正文高度有上限并可滚动。
- **`x` 停止**：先本地确认（`y` / `n`），确认页显示对象类型、id 和影响范围，长文字自动换行；不经过模型。command/WebSocket 走 `endMonitor`：请求并确认资源清理后照常发一条 `[Monitor stopped]`；source observer 只结束订阅，不停工作。如果选中的是 Loop 页里的任务，则复用 pi-cc-loop 的停止逻辑（`retireChain` / `removeJob` / durable store），自定步调 loop 结束时会连带停止绑定的 Monitor。
- **停止的是计划，不是主 agent**：不会 abort 当前回复，也不会结束正在运行的 turn；要中断模型请照常按 Esc 或用 Pi 的 abort。
- 已结束的 Monitor 记录仍会列出，但停止动作禁用。v1 不做暂停/恢复、不改 cron、不做每个 loop 的独立 transcript，也不保留已结束 loop 的历史。

两个包共用一套命令注册：只装 pi-cc-monitor 或只装 pi-cc-loop 都能使用；两个都装时也只注册一个面板入口。所有 `session_start` 处理完成、构建补全列表之前，会检查当时已加载的扩展命令和 prompt 模板（包括已重名的 `/tasks:1` 等入口）：名称空闲时只注册 `/tasks`；已占用时不抢占、不新增 `/tasks:1`，只注册 `/cc-tasks`。无法安全查询命令列表的旧版宿主也只提供 `/cc-tasks`。同一运行时不因再次资源发现而切换或补注册别名；`/reload` 会为新的扩展实例重新检查。检查不覆盖其他插件之后动态新增的命令。任务面板入口不是 `/pi_cc`（pi-cc 设置面板），也不改变 `Monitor` 工具或 `/loop` 的语义。

## 规则

- 命令和 Pi 的 bash 工具一样执行：用 Pi 设置里的 `shellPath`（支持开头的 `~`）和 `shellCommandPrefix`，PATH 最前面是 Pi 的 `bin` 目录
- completion 模式：stdout/stderr 都只写日志，运行中不发输出通知；终态通知一次，附有界的 stdout（及非空 stderr）尾部和完整日志路径；退出码 0 = completed，非零／信号 = failed，普通日志量不会触发事件限流
- 尾部读取每个日志最多约 8 KiB / 60 行，长行也标注截断并保留结尾；消息是净化后的纯文本，不带 TUI 样式字节
- 直接 events 命令：只有 stdout 是事件流；stderr 写进文件，不触发唤醒。source observer 默认只观察未来 stdout；`watches[].stream` 可选 `stdout`/`stderr`/`both`，stderr 命中行在通知中带 `[stderr]` 前缀，但不会改变原命令的 event 语义
- 退出、停止、超时都只发一条结束通知；completion 的超时通知说明后台时限（不是 `monitor expired`）；停止之后的输出会被丢弃
- events 模式：空行不算事件；超长内容以 `...(truncated)` 截断
- 日志按运行时隔离在 `$TMPDIR/pi-cc-monitor-*/`；目录 0700、文件 0600（POSIX）。只清理已关闭或确认所属进程已退出、且最后活动超过 3 天的目录；安静的活跃任务不清理。旧版无归属信息的扁平目录不自动删除
- 运行中日志写入错误不会崩溃 Pi；初始化失败会正常收尾，不会遗留假的 running 记录
- events 模式的管道要逐行 flush：`grep --line-buffered`；`head` 不行
- 只匹配成功标记的监视脚本在 crash/hang 时会静默；把 `ERROR|FAILED|Killed` 也覆盖进去
- `tail -f` / `while true` 不会自己退出；不需要时用 `monitor_stop` 或 `timeout_ms`
- events 模式每行都是一条消息；测试时别一次打印几十行
- `command` 直接运行主命令，后台化由 Monitor 负责；不要再套 `nohup` / `&`。stdin/PTY 交互、daemon 化或远程进程托管不属于本工具的生命周期保证
- Monitor 是真实 Shell 入口，不是沙箱；只匹配 `bash` 工具名的权限插件需要同时覆盖 Monitor。通知和日志是外部数据，不是用户指令或对问题的回答

## 渲染

异步通知沿用 CC 风格的透明 `✻ monitor` 卡片；标题显示事实、时间和描述，下一行显示对象身份、真实来源或终态结果：

```text
✻ monitor · 10:22pm · build errors
   subscription #obs12345 → build #job12345
   [stderr] ERROR: compilation failed

✻ monitor completed · 10:24pm · build
   task #job12345 · exit 0 · 2m
   stdout: Build completed successfully.

✻ monitor stopped · 10:25pm · build errors
   subscription #obs12345 → build #job12345 · context only
   Subscription ended; source command was not stopped by this operation.
```

表头按原因分：`monitor`（有事件）、`monitor ended`（命令退出）、`monitor expired`（events 超时；completion 超时改用后台时限措辞，不叫 expired）、
`monitor failed`（启动或连接失败）、`monitor closed`（WebSocket 关闭）、`monitor stopped`（手动停止或输出过多被停）。
折叠时一行标题、一行身份、最多两行**实际终端行**的正文；有剩余输出时显示 `+N more lines`。标题和身份截断到终端宽度，正文按宽度换行后再计预算；中文/emoji/ANSI 不会把折叠卡片撑成长页。completion 失败优先展示真实 stderr，成功保留 stdout；不生成虚构进度或输出摘要。Ctrl+O 展开完整有界输出、技术类型/模式、事件/抑制统计、通知策略、期限、命令或 URL、完整日志路径及 Loop 关联。成功色只表示真实 completed；普通结束/手动停止用主题的青蓝强调色（accent），提高终态辨识度；失败为错误色，超时/flood/停止未确认为警告色。异步卡片与任务面板使用同一语义配色，不覆盖 Pi/ccstyle 的原生工具外壳。渲染不改模型收到的异步消息，不新增观察者自动关闭通知。

`Monitor`、`monitor_stop`、`monitor_list` 的工具调用行和结果行走 Pi 原生或 `pi-cc-extensions` 的渲染，不走这里的自定义 renderer；只有异步事件卡片使用上面的 `✻ monitor` 样式。展开快捷键跟随宿主：Pi 原生可展开消息，ccstyle 接管 Ctrl+O 时会打开它的 detailed transcript；本扩展不抢占该快捷键，完整 Monitor 信息始终可从 `/tasks` 详情查看。

样式开关是 `~/.pi/agent/pi-cc.json` 里的 `compactMessages`（和 pi-cc-loop 共用，用 `/pi_cc` 面板或 `/pi_cc messages on|off` 切换，
或用环境变量 `PI_CC_COMPACT_MESSAGES=0|1` 覆盖）；关闭时回到旧的带底色卡片。

## 底部状态

有活跃 Monitor 时，Pi 底部显示 `2 monitors`（实例数，包含 task/watcher/socket/subscription 和停止中/清理待确认的实例），不是进程数；一个任务加两个订阅就是三个实例。和 pi-cc-loop 的 `2 loops · next 3m` 一样使用数量在前的单复数形式，全部结束并清理后这一项消失。只在生命周期或设置变化时更新，事件到达不会重绘底部。

- 装了 `pi-cc-extensions`：作为一个芯片出现在第 2 行，可在它的配置面板里移动或隐藏
- 没装：Pi 内置 footer 把它和其他扩展的状态按 key 排序、拼成一行，比如 `1 loop · next 3m 1 monitor`

开关是 pi-cc 扩展共用的 `footer`（`~/.pi/agent/pi-cc.json`，用 `/pi_cc` 面板或 `/pi_cc footer on|off` 切换，或用环境变量 `PI_CC_FOOTER=0|1` 覆盖）。

`/pi_cc` 由四个 pi-cc 包（loop、monitor、plugins、compaction）共同提供：装了其中任意一个，命令就在；装了多个，也只有一个 `/pi_cc`
（同名命令会被 Pi 改名成 `/pi_cc:1`、`/pi_cc:2`，所以由最先加载的包认领注册）。面板按插件分页（Tab / Shift+Tab 切换）：本包的两项和 pi-cc-loop 共用，在 Loop & Monitor 页；Plugins 页属于 pi-cc-plugins，Compact 页属于 pi-cc-compaction（装了才生效）。

## 兼容性

- Node.js `>=22.19.0`
- Pi 1.5.1、1.5.2（本版回归通过）；Pi 1.5.0 及更早版本本版未重新验收
- `pi-cc-loop` 可选；两者通过 `pi.events` 通信。建议搭配 Loop 0.9.0 获得完整分组/分区详情和停止确认；旧 Loop 接管面板时仍能读取兼容的扁平详情，不会出现空详情。
- 与 `pi-cc-extensions` 共存。工具调用行交给 Pi 原生或 `pi-cc-extensions` 渲染，不需要配置它的 `excludeRenderers`，也不需要关闭 ccstyle 或其 tool grouping。事件卡片走独立 custom message renderer，不受 ccstyle 开关影响。本扩展不写其他插件的配置文件。

## 本地开发

```bash
node --test tests/*.test.mjs
npm run typecheck
```

类型检查使用本地 TypeScript 开发依赖，并自动定位本地 peer dependencies 或已安装的 Pi；不再写死用户目录／某个旧 release。可用 `PI_AGENT_DIR` 选择隔离的 Pi 安装，用 `PI_TYPESCRIPT_PATH` 指向已有的 `typescript/lib/typescript.js`，不必为验收安装或更新宿主。测试 worker 自动使用独立的临时日志目录。

### 缓存约束

提示缓存按前缀匹配（工具 → system prompt → 消息）。本扩展只往对话末尾追加通知消息：不注册会改 prompt 或历史的钩子
（`before_agent_start` / `context` / `context_with_system` / `before_provider_request`），工具在加载时注册，描述和选择规则固定。
`tests/cache.test.mjs` 守住这一点；真实 provider 的检查在 pi-cc-loop 的 `scripts/cache-check.mjs`，它会一起加载本扩展，覆盖 Monitor 事件。

## 与 Claude Code 的差异

行为选择规则对齐 Claude Code 2.1.318：一次完成用后台命令，多次发生用 Monitor 事件流。用 Pi 扩展 API 实现。有意不同的地方：

- CC 分别使用 Bash 的 `run_in_background` 和独立 Monitor；本扩展把它们合并成 `Monitor.mode`，避免长命令先阻塞前台 Bash。缺省仍是 `events`，已有调用不变。
- completion 在活动回合中先保留结果，等 `agent_settled` 后投递，避免 Pi 清队列丢失唯一通知；中断回合和手动 compaction 只保存结果，不重新启动模型。events 保持 Monitor 的 steer。
- `monitor_stop` / `monitor_list` 对应 CC 的 `TaskStop` / `TaskList`。
- 底部显示 `2 monitors`（和 pi-cc-loop 的芯片同一格式）；CC 底部的任务 pill 也写作 `2 monitors`，还能选中后打开任务列表。
- 事件是 Pi 的自定义消息（类型 `Monitor`，正文首行 `monitor <id> · <描述>`），不是 CC 的 `<task-notification>`。
- `loopPrompt` 是额外加的：装了 pi-cc-loop 时，loop 结束会连带停掉绑定的 Monitor；CC 靠模型自己调用 `TaskStop`。
- Pi 异常退出（没走 `session_shutdown`）时，也会在进程退出前杀掉 Monitor 的进程组。

## 许可证

MIT
