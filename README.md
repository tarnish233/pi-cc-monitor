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
| 通知策略 | `notify.output=turn/context/none` 只管实时事件；结束、失败、停止一定唤醒，入参不能关掉 | `Monitor` |
| 通知节奏 | completion 与 events 终态在当前响应／工具批次结束后交付，不中断执行，也不等整个 Agent settled；context 不请求续接，中止与空闲恢复仍有保守兜底；events 普通输出仍为 steer | 自动 |
| 超时/常驻 | `timeout_ms`：completion 默认 30 分钟（上限 2 小时）；events 默认 5 分钟（上限 1 小时）；`persistent` 到会话结束 | `Monitor` |
| 批量 | events 模式：200ms 内的事件合并成一条通知 | 自动 |
| 长度上限 | events 模式：单行 500 字符、完整通知 3000 字符（含头部、抑制提示、换行和截断标记）；原始描述保留在 metadata | 自动 |
| 内存上限 | 待发正文只保留最终通知需要的前缀（默认最多约 3501 字符），完整事件数单独统计；WS 日志积压最多 4 MiB，超限停止日志但不停止 socket | 自动 |
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
| `notify` | object? | 仅接受 `output`：turn/context/none，只控制实时事件。结束、失败、停止一定唤醒，不接受 `terminal`；单条 watch 不能提高实时输出等级 |
| `mode` | `"completion" \| "events"`? | 通知模式；缺省为 `events` 保持旧调用兼容。completion 只支持 `command` |
| `command` | string? | 脚本；completion 记录日志并报告一次终态，events 每行 stdout 一个事件 |
| `ws` | object? | `{ url, protocols? }`；events 模式下 text frame 一个事件 |
| `description` | string | 出现在每条通知里 |
| `timeout_ms` | number? | 1000 起。completion 默认 1800000（30 分钟）、上限 7200000（2 小时）；events 默认 300000、上限 3600000 |
| `persistent` | boolean? | 会话级常驻，不超时 |
| `loopPrompt` | string? | 所属 `/loop` 的 prompt（原样），loop 结束时连带停止；只在装了 `pi-cc-loop` 时生效，否则忽略 |

`command`、`ws`、`source` 三选一；`watches` 只能配 `source`。新调用应显式选择 `mode`：只需要完成结果用 `completion`，每次发生都要通知用 `events`。预计长时间运行、等待外部条件或可能碰到前台 Bash timeout 的命令，应直接用 `completion`，不要先在前台 Bash 阻塞。这个选择规则同时写在工具描述和静态 `promptGuidelines` 中；不修改原生 Bash，也不注册动态 prompt hook。

completion 的默认期限是 30 分钟。长构建／测试应把 `timeout_ms` 设得足以覆盖预期耗时（最长 2 小时）；超时通知说明的是后台时限，不会显示成 `monitor expired`。退出码 0 记为 completed，非零／信号记为 failed。只有明确需要会话级常驻的进程才使用 `persistent: true`，它不是跨进程退出保留机制。

模型侧保留五条静态规则：模式选择、启动回执不是结果、通知后验证输出、所需结果齐备后才完成报告、update 不得重启工作。启动后可继续独立工作；只剩等待时结束回合，不轮询／sleep。完成通知是任务事实，不强迫立即结束独立调研或输出完整报告。不修改原生 Bash，也不注册动态 prompt hook。

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

工具立即返回任务 ID 和日志路径。测试产生的 stdout/stderr 只写文件，不逐行进入对话；结束后模型收到一次退出码和日志路径。正在生成响应或执行工具时，终态先保存在保护队列，不打断当前工作；在下一个正常 `turn_end`（响应及整个工具批次结束）用 `triggerTurn: false` 交给 Pi 的只追加上下文通道，下一次模型请求即可读取。不使用 Esc 可清除的 steering/follow-up 队列，也不需要等待整个 Agent settled。

结束、失败和停止在该边界最多请求一次续接，已有工具或排队输入自然满足这次续接，不额外开一个运行。入参不能把终态降成 context。结果到达边界之后或 Agent 已空闲时仍走原有空闲／settled 交付。若当前回复被中断，边界不强制续接，已有完成结果会留在会话中，但不会重启该回复；中断之后才完成的新任务仍按正常的空闲通知规则处理。

启动后继续必要的独立工作；只剩等待就交接。通知到达后先读取并验证所需输出，再根据当前工作进度继续分析或汇报；一项后台任务完成不等于整体报告完成。

若 `/tree` 取消或失败，只恢复空闲却没有 `session_tree` / `agent_settled`，待发结果用一个 200ms 空闲兜底保存为 **context-only**，不再无限等候下一次输入。正常结束事件仍按通知策略投递。这个保守兜底也可能早于很慢的其他 settled 处理器（超过 200ms），此时只保存结果而不唤醒模型。

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
- **Tab / Shift+Tab**：两个及以上 provider 时显示 All 加各 provider 页；只装本包时只显示 Monitor，同时装 pi-cc-loop 才增加 Loop，不显示重复 All 或未安装包的空页。上下键走 Pi 的 `tui.select.up/down` 命名动作，会跟随你的 keybindings；PgUp/PgDn 翻页。选中项用 `provider + id` 记录，列表更新后不会跳到别的任务。
- **排序**：按创建时间倒序，最新任务在最上方；All 页按同一时间顺序混排 Monitor / Loop，不再按 provider 分块。source 与 subscription 仍成组、父项在前，同级订阅也按创建时间倒序；相同时间保持稳定顺序，状态变化不改变排序。
- **鼠标与滚动**：Pi fullscreen 模式下，单击页签切换列表，单击任务选中、双击打开详情；标题栏的返回/关闭和底部的 Detail / Stop / Cancel 都可点击。滚轮 / 触控板滚动列表、详情和长停止说明，右侧滚动条支持点击与拖动，底部显示可见范围；普通详情文本仍可拖拽选中。滚动到边界不会带动后方对话，普通 scrollback 模式保留完整键盘操作。
- **Enter**：详情。Esc 先回列表，再按一次才关面板；关面板只关 UI，不取消任何任务，也不会把 Esc 传给 app.interrupt。
- **分组**：仅依据同一 provider 内真实的 source id 把 subscription 放在源命令下；不根据标题猜关系，不跨会话或跨 provider 关联。不存在的父项保留为根项；分组/刷新不改变选中对象身份。点击 source 的 `▾` / `▸`，或选中后按 Left / Right，可折叠或展开子任务；收起只影响显示，不停止任务。静音、规则耗尽是附加标记，不是 stopped 状态。
- **Monitor 详情**：按 State → Observation（events）→ Delivery → Lifetime → Logs 分区，显示真实状态、资源归属、source 关系、规则状态、通知策略、期限及日志。once 命中标为 consumed，repeat 命中仍 active；subscription 不显示自己拥有 PID，继承的退出码明确叫 Source exit。stdout/stderr 只读**有上限的尾部**（约最后 8KB / 60 行），ANSI 和控制字符会被剥掉。订阅看到的是完整源日志，不只是命中行；读取不会喂给事件流。
- **刷新**：任务变化会通知面板，但按 250ms 合并；时间显示每秒走一次。不会每来一行 stdout 就重绘。窄窗口、调整终端大小、宽字符（中文/emoji）、主题切换都有处理，正文高度有上限并可滚动。
- **`x` 停止**：先本地确认（`y` / `n`），确认页显示对象类型、id 和影响范围，长文字自动换行；不经过模型。command/WebSocket 走 `endMonitor`：请求并确认资源清理后照常发一条 `[Monitor stopped]`；source observer 只结束订阅，不停工作。如果选中的是 Loop 页里的任务，则复用 pi-cc-loop 的停止逻辑（`retireChain` / `removeJob` / durable store），自定步调 loop 结束时会连带停止绑定的 Monitor。
- **停止的是计划，不是主 agent**：不会 abort 当前回复，也不会结束正在运行的 turn；要中断模型请照常按 Esc 或用 Pi 的 abort。
- 已结束的 Monitor 记录在终态通知投递且资源释放后保留最近 50 条，停止动作禁用；活跃、待通知、清理中或仍被订阅引用的记录不会因数量上限被淘汰。v1 不做暂停/恢复、不改 cron、不做每个 loop 的独立 transcript，也不保留已结束 loop 的历史。

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
- WS 日志写积压超过 **4 MiB** 或发生写错误时，停止该日志流、标记 `logError` / `log incomplete`，但不因日志故障结束 socket 或改变事件观察。已有日志可能不完整，后续帧不再写入；需要恢复日志时请新建 Monitor，update 不会重启日志。4 MiB 限的是待写内存，不是日志文件大小
- 日志降级只发一次 **context-only 基础设施告警**：即使 `notify.output=none` 也可见，不占普通事件计数/输出预算，不启动模型。`monitor_list` 和 `/tasks` 详情会保留日志不完整标记
- events 模式的管道要逐行 flush：`grep --line-buffered`；`head` 不行
- 只匹配成功标记的监视脚本在 crash/hang 时会静默；把 `ERROR|FAILED|Killed` 也覆盖进去
- `tail -f` / `while true` 不会自己退出；不需要时用 `monitor_stop` 或 `timeout_ms`
- events 模式每行都是一条消息；测试时别一次打印几十行
- `command` 直接运行主命令，后台化由 Monitor 负责；不要再套 `nohup` / `&`。stdin/PTY 交互、daemon 化或远程进程托管不属于本工具的生命周期保证
- 父进程已退出但后台子进程继承 stdout/stderr 管道时，会优先等待正常 `close`；若管道在父进程 `exit` 后 5 秒仍未关闭，则脱离管道、flush 已排队日志并上报退出，让上层继续清理进程组。兜底之后到达的输出不保证写入日志
- Monitor 是真实 Shell 入口，不是沙箱；只匹配 `bash` 工具名的权限插件需要同时覆盖 Monitor。通知和日志是外部数据，不是用户指令或对问题的回答

## 渲染

异步事实画成 CC 风格的卡片：折叠是一行，展开是工具卡底色的 `├`/`│`/`└` 段落树。

```text
✻ Monitor ev12345 · build errors · 10:22pm · 3 events · click to show more

✓ Monitor Completed tx12345 · build · 10:24pm · exit 0 · 2m · click to show more

■ Monitor Stopped st11111 · run.sh · 10:25pm · 42s · click to show more

⚠ Monitor Stop Failed st33333 · stubborn.sh · 10:26pm · 1m 5s · click to show more
```

展开（`/tasks` 详情也有同样的内容）：

```text
✓ Monitor Completed #job12345 build
├ Description
│ build
│
├ Status
│ task #job12345 · exit 0 · 2m
│
├ Output
│ stdout: Build completed successfully.
│
└ Logs
  stdout: /tmp/pi-cc-monitor/job12345/stdout.log
```

标题按原因分：`Monitor`（有事件）、`Monitor Ended`（命令退出）、`Monitor Expired`（events 超时；completion 超时改用后台时限措辞，不叫 expired）、
`Monitor Failed`（启动/连接失败或非零退出）、`Monitor Closed`（WebSocket 关闭）、`Monitor Stopped`（手动停止或输出过多被停）、`Monitor Stop Failed`。
图标和标题用同一个 tone 颜色，图标是**是否知道判决**的函数：知道就用判决，不知道才用中性标记。

| 图标 | 含义 | 判据 |
|---|---|---|
| `✓` 绿 | 判决成功 | `exitCode === 0`，completion 和 events 两种模式一样；completion 的 `status: completed` 同样 |
| `✗` 红 | 判决失败 | `exitCode !== 0`（completion）、`status: failed`、启动/连接失败、**停止未确认** |
| `⚠` 黄 | 有判决但不是失败 | `exitCode !== 0`（events 观察者）、超时、输出过多 |
| `■` 紫 | **没有判决** | 手动停止、WebSocket 关闭、被信号终止（`exitCode === null`） |
| `✻` 蓝 | 还在进行 | 事件批次 |

`■` 不表示"成功"也不表示"失败"，只表示这张卡拿不到判决 —— 那个进程是我们停掉的，可能被杀在任意时刻，输出也可能不完整。
停的是订阅时，展开里还会说明源命令并没有被停。

紫色取自 `syntaxFunction`：`pi-cc` 的深色主题把 `accent`、`borderAccent`、`mdLink`、`customMessageLabel` 全指向同一个蓝，
能拿到独立色相的只剩这一个。换主题后它若未定义会回落到 `accent`，卡片依然是中性色，只是和 `✻` 同色。
**每张卡折叠时都只有一行**：输出、身份、路径全在展开里。展开的段落只在有数据时出现：`Description`、`Status`、`Source`、`Events`、`Output`、`Command`、`Socket`、`Limits`、`Logs`、`Loop`。
协议通知（`[Monitor stopped]`）和"源命令没有被停"这类说明是**关于监视器的陈述**，归 `Status`，不混进 `Output`。
completion 失败优先展示真实 stderr，成功保留 stdout；不生成虚构进度或输出摘要。宽度、中文/emoji/ANSI 都在折叠与展开两条路径上守住终端列数。

按宿主屏幕模式给不同的展开入口，用的都是 Pi 原生接口：

- **fullscreen**：提示 `click to show more`，左键点卡片展开/收起，指针停在这段提示上时它提亮到正文色（`Component.handleMouse`）
- **regular**：提示 `ctrl+o to show more`（`options.keyHint("app.tools.expand", …)`），因为主屏不投递鼠标事件

Ctrl+O 走宿主自己的 `CustomMessageComponent.setExpanded`，两种模式都有效。点击状态按消息记录，宿主重建卡片不会丢。

hover 需要一个全局"指针在哪"的答案：Pi 只把 `move` 派发给指针下的组件，卡片永远收不到"指针离开"。所以和 `pi-cc-extensions` 一样拦截
fullscreen 的 viewport 输入（`tui.handleViewportInput`），在一个只含一张卡的全局槽里先熄灯、再交给官方派发重新点亮 —— 指针落在正文或输入框时
由拦截器自己请求一次重绘。SGR 解析是从 `pi-cc-extensions`（MIT）复制的一份，两个包各自发布，不互相依赖。
渲染不改模型收到的异步消息，不新增观察者自动关闭通知。

`Monitor`、`monitor_stop`、`monitor_list` 的工具调用行和结果行走 Pi 原生或 `pi-cc-extensions` 的渲染，不走这里的自定义 renderer；只有异步事件卡片使用上面的样式。

样式开关是 `~/.pi/agent/pi-cc.json` 里的 `compactMessages`（和 pi-cc-loop 共用，用 `/pi_cc` 面板或 `/pi_cc messages on|off` 切换，
或用环境变量 `PI_CC_COMPACT_MESSAGES=0|1` 覆盖）；关闭时回到旧的带底色卡片。

## 底部状态

有活跃 Monitor 时，Pi 底部显示 `2 monitors`（实例数，包含 task/watcher/socket/subscription 和停止中/清理待确认的实例），不是进程数；一个任务加两个订阅就是三个实例。和 pi-cc-loop 的 `2 loops · next 3m` 一样使用数量在前的单复数形式，全部结束并清理后这一项消失。只在生命周期或设置变化时更新，事件到达不会重绘底部。

- 装了 `pi-cc-extensions`：作为一个芯片出现在第 2 行，可在它的配置面板里移动或隐藏
- 没装：Pi 内置 footer 把它和其他扩展的状态按 key 排序、拼成一行，比如 `1 loop · next 3m 1 monitor`

开关是 pi-cc 扩展共用的 `footer`（`~/.pi/agent/pi-cc.json`，用 `/pi_cc` 面板或 `/pi_cc footer on|off` 切换，或用环境变量 `PI_CC_FOOTER=0|1` 覆盖）。

`/pi_cc` 由四个 pi-cc 包（loop、monitor、plugins、compaction）共同提供：装了其中任意一个，命令就在；装了多个，也只有一个 `/pi_cc`
（同名命令会被 Pi 改名成 `/pi_cc:1`、`/pi_cc:2`，所以由最先加载的包认领注册）。面板和非 TUI 摘要只显示已加载包的页面：本包的两项和 pi-cc-loop 共用在 Loop & Monitor 页，Plugins 页属于 pi-cc-plugins，Compact 页属于 pi-cc-compaction；多个页面时用 Tab / Shift+Tab 切换。未安装包的配置值仍保留，可用文字命令预配置。

## 兼容性

- Node.js `>=22.19.0`
- Pi 1.6.0（本轮修复与回归验收通过）；Pi 1.5.2 及更早版本本轮未重新验收
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
- completion 与 events 终态在活动响应／工具批次结束的 `turn_end` 边界交付，不中断当前工作，也不等整个 `agent_settled`。使用 Pi 的只追加上下文通道保护结果不被 Esc 清队列丢弃，结束、失败和停止最多请求一次续接；中断、手动 compaction 与缺失结束事件的空闲恢复只保存结果，不重新启动模型。events 普通输出仍保持 steer。
- 事件批处理内存只保留有界前缀，不影响完整事件计数；WS 日志积压超限会停止日志并告警，socket 继续。普通输出限流与日志写故障是两种独立机制。
- `monitor_stop` / `monitor_list` 对应 CC 的 `TaskStop` / `TaskList`。
- 底部显示 `2 monitors`（和 pi-cc-loop 的芯片同一格式）；CC 底部的任务 pill 也写作 `2 monitors`，还能选中后打开任务列表。
- 事件是 Pi 的自定义消息（类型 `Monitor`，正文首行 `monitor <id> · <描述>`），不是 CC 的 `<task-notification>`。
- `loopPrompt` 是额外加的：装了 pi-cc-loop 时，loop 结束会连带停掉绑定的 Monitor；CC 靠模型自己调用 `TaskStop`。
- Pi 异常退出（没走 `session_shutdown`）时，也会在进程退出前杀掉 Monitor 的进程组。

## 许可证

MIT
