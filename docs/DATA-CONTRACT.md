# 公共数据契约 v2（第二轮 2A 候选）

当前 producer 的唯一类型定义是 [`shared/schema.ts`](../shared/schema.ts)，HTTP、SSE 和新录制的 `schema_version=2`。原 v1 类型完整冻结在 [`shared/schema-v1.ts`](../shared/schema-v1.ts)，原录制不改写。v2 新增每轮场景与指标；这是离线工程候选，原 [CALLER-HANDOFF.md](CALLER-HANDOFF.md) 的实机结论不自动转移到本版。

## v2 场景与指标

每个 `RoundSummary`（含 `latest_round`、timeline 和 SSE round）新增必须字段 `scenario`、`metrics`；`RoundTimeline` 继承相同字段。旧 v1 经 [`shared/replay.ts`](../shared/replay.ts) 生成消费者视图时，两者明确为 `null`，不臆造原场景参数或费用。原 JSON、版本事实与已完成的 FAILED/UNKNOWN 均保留。

`scenario` 固定记录 `scenario_id`（S1–S5 / F1–F4）、`direction`、`symbol=BTCUSDT`、请求 `sl_pct` / `tp_pct`、`max_hold_ms`、`exit_mode`、`policy_version` 和 `funding_settlement_at`。新场景的两个比例使用十进制字符串（`"0.0015"` 表示 0.15%）；已有预算比例仍为 number。`ACTIVE_CLOSE` 沿用九步；`WAIT_SL` / `WAIT_TP` 只执行 preflight、cleanup_before、open_position、verify_protection、hold、cleanup_after 六步，不伪造未执行的重启或主动平仓；`FUNDING_WINDOW` 执行前四步、hold、close_position、cleanup_after 七步。SUCCEEDED 仍要求本场景全部必要步骤按序 PASS；安全清理不能覆盖原失败。

`metrics` 的完整字段见类型：各步骤耗时、实际观察到的 UNKNOWN 窗口及总时长、保护确认耗时、参考价格、计划 SL/TP、请求取整后的有效距离、tick / stop_grid、开平前后权益、保护触发与确认账户干净的时间，以及盈亏核对状态。保护确认耗时使用保守上界：从 caller 发出唯一 Entry RPC 之前计到同一完整 Algo 快照独立证明 SL/TP，涵盖请求、成交及观察延迟，避免首次看到成交太晚而低估时延。精确的交易所成交到保护生效时延仍须对照交易所时间与每小时钟差。保护触发同时保存本机接收时间 `trigger_observed_at` 和成交源时间 `trigger_source_at`，六十秒清理判据以源时间为起点，缺源时间不能通过。无法证实的数值为 `null`。

`accounting_status=COMPLETE` 只在完整窗口的资金费用查询成功，且原 position 的全部实际 entry/exit 成交量匹配、费用与 realized PnL 均有可靠 USDT 数值时成立。`gross_pnl_usdt` 使用成交事件中的交易所损益，`fees_usdt` 为实际手续费，`funding_usdt` 为有符号资金收入，`net_pnl_usdt = gross - fees + funding`。账户权益直接读取内核交易所余额（本来已含资金费），不重复加算。`funding_entries` 每笔保留公开不可逆 ID、时间、BTCUSDT、USDT 和精确金额；缺页、重复 ID、金额总和不符或读失败均保持 UNKNOWN，不能以空列表或零替代。

S2/S3 只有指定保护腿的实际成交事件与 fresh full-account flat / 无 Algo 共同满足才通过。最长持仓内未触发则 FAILED 并安全平仓；只有零仓位却无成交归因时 UNKNOWN。S4 必须在指定结算前十分钟的开仓窗口开始，结算后十分钟主动平仓，并确实取得该结算时刻的流水；错过窗口、未收取流水或费用不全均不能通过。以上离线分支验证不能代替测试网真实触发、资金流水格式与时序验证。

consumer 在独立副本中规范化已知 v1 为 v2 视图，支持原 v1 与新 v2 录制。未知版本及混合 envelope 版本明确拒绝。公共对象不包含原 credential_id、交易所 UID、listenKey 或原始交易流水 ID；内部数据库保留去敏 ID 的关联依据。


## 接口与类型

| 读取入口 | 响应类型 | 用途 |
| --- | --- | --- |
| `GET /api/state` | `StateResponse` | 当前账户、持仓、普通及 Algo 挂单、SL/TP、预算、熔断和内核状态 |
| `GET /api/timeline?limit=20&cursor=…` | `TimelineResponse` | 场景轮次和各步骤，含失败轮次 |
| `GET /api/stream` | `SseEvent` | 完整快照、步骤/轮次更新和心跳 |
| `recordings/*.json` | `Recording` | 初始快照和同一格式的 SSE 事件，可离线回放 |

以上均为只读接口。timeline 的 `limit` 按轮次计，默认 20、范围 1–100；`next_cursor` 为不透明的分页游标，`null` 表示末页。页内 `rounds` 按开始时间倒序，同时间按 `round_id` 倒序；每轮 `steps` 按 `sequence` 升序。分页游标固定查询时的历史边界，后续新轮次由 SSE 告知，不能挤掉已经翻页的失败记录。调用方不得解析游标内容。

## 通用约定

- 字段名采用 `snake_case`。接口列出的字段必须存在；没有可靠值时写 `null`，不能省略，也不能填 `0`、空字符串或空数组来替代未知。
- 时间为带毫秒的 UTC ISO 8601，例如 `2026-11-02T08:00:00.000Z`。`observed_at` 是 caller 接收观察的时间，`source_as_of` 是源数据的时间，`generated_at` 是响应组装时间；刷新响应不能刷新旧事实的时间。
- 金额、价格、数量使用十进制**字符串**，例如 `"1000.00"`、`"0.002"`，不使用科学计数法。数量为绝对值，方向由 `side` 给出。`*_pct` 是比例数值，`0.03` 表示 3%；不得把 `3` 当成 3%。
- `source.kind` 为 `MOCK`、`TESTNET` 或 `PAPER`；`source.label` 是页面必须可见的来源说明。`DisplayMode` 的 `live/replay` 只表示读取方式；回放测试网记录仍是 `TESTNET`，回放假数据仍是 `MOCK`。
- `StateResponse.build` 和 `Recording.build` 共用 `BuildInfo`：`{ caller_commit: string; rustcore_commit: string }`。真实运行分别记录实际 caller 构建与内核版本的完整 Git commit，不以分支名或当前工作区 HEAD 代替正在运行的版本；同一份录制中的状态必须与顶层 build 一致。手写 MOCK 示例使用明确的 `mock-caller-v1` / `mock-rustcore-v1` 虚构标识，不能作为真实版本证据。
- `account_label` 只能是公开别名。所有 ID 都是不透明的公开标识，不得携带原始 `credential_id`、交易所 UID、密钥、内部路径、地址、主机名。`reason`、`actual.summary` 等自由文本也要遵守此规则，不直接透传内部错误或日志。

`Observation<T>` 的 `status` 与 `value` 一起读取：`AVAILABLE` 为完整可用观察，`PARTIAL` 为覆盖不全，`STALE` 为过期，`UNAVAILABLE` 为本次无法取得，`UNKNOWN` 为尚未建立事实。后三者可以带上一次已知值，但页面必须保留其状态和原始时间。只有完整、可用观察的 `[]` 才能证明没有持仓或挂单；`null` 不能显示为“空仓”。`ONLINE` 只说明内核可连接，不能代替恢复完成、可开仓或双保护通过。

v1/v2 的 `PositionView.symbol` 固定为 `BTCUSDT`。若账户存在其他品种的持仓，公开 `positions.status` 必须标为 `PARTIAL`，并在 `reason` 写明未覆盖的品种及原因，不能静默过滤后宣称完整或空仓；已有的 BTCUSDT 行仍可展示。公开范围限制不缩小内部风险预算的全账户敞口口径。

预算的公开权益变化字段统一为 `approximate_today_pnl_usdt` 和 `approximate_today_pnl_pct`，两者都是近似值。内核 RPC 的 `today_realized_pnl_usdt/pct` 保持原名，caller 只在内部做对应映射；公开结构中不使用 `realized` 字段名。发布不以权益达到 100 USDT 为条件，真实低权益交由内核按策略拒绝，并保留实际拒单原因；口径见 [RISK-BUDGET.md](RISK-BUDGET.md)。

## 时间线

`round_id` 是公开的场景轮次 ID，对应内部 `run_id` 的一对一映射；同一轮始终不变，手动再发起必须产生新 ID。`step_id` 在一轮内唯一且稳定。字段固定如下：

| 字段 | 含义 |
| --- | --- |
| `round_id` / `step_id` | 轮次 / 步骤标识，用于更新去重 |
| `sequence` | 从 1 开始的连续执行顺序，不由 `step` 枚举位置推算 |
| `step` | 下面九种动作之一 |
| `started_at` / `ended_at` | 开始/结束时间；进行中 `ended_at=null` |
| `phase` | `RUNNING` 或 `COMPLETED` |
| `expected` | 本步应满足的可观察条件 |
| `actual` | `StepActual`：文字摘要、原因码及本步观察到的结构化事实 |
| `result` | `PASS` / `FAIL` / `UNKNOWN` |
| `reason` | 判定原因；三种结果都填写可读说明 |

`step` 固定为 `preflight`、`cleanup_before`、`open_position`、`verify_protection`、`hold`、`restart_kernel`、`verify_recovery`、`close_position`、`cleanup_after`。只记录执行过的步骤，不伪造未执行动作。失败后可以执行安全平仓和清理，因此失败记录允许跳过 hold/restart/recovery，`sequence` 仍连续。

进行中固定为 `phase=RUNNING`、`result=UNKNOWN`、`ended_at=null`；完成后必须有结束时间。完成的 `UNKNOWN` 表示判据无法证实，不是成功。`actual` 各字段均存在，与本步无关的字段为 `null`。开/平仓成交使用 `actual.fill` 保存数量、成交均价、名义额，不能用请求值或风控上限代替成交值。

`RoundSummary.trigger` 必填且一轮内不变：定时触发为 `SCHEDULED`，本机人工发起为 `MANUAL`。时间线、`state.latest_round` 和 `round` 事件均携带它，页面应明确显示，不能用开始时间猜测触发方式。首轮失败后人工发起的新轮次必须使用新 ID 并标为 MANUAL。

轮次为 `RUNNING`、`SUCCEEDED` 或 `FAILED`。v1 只有完整走过九步且所有必要判据 PASS 才为 `SUCCEEDED`；v2 按上面的场景必要步骤判定；任一步 FAIL 或最终仍 UNKNOWN 为 `FAILED`，并附原因。首轮 `not_started` 同样保留为 FAILED。清理成功不能将失败轮次改成成功；完成的步骤和轮次不可覆盖为另一个结论。新轮次也不删除旧轮次。

## SL / TP 分开呈现

`ProtectionPairView` 始终具有独立的 `sl` 和 `tp`，每一腿都有 `status`、`reason`、`reason_code`、订单标识、触发价、交易所状态和观察时间。禁止从持仓 `PROTECTED` 推断二者均 PASS。

`observation_id` 标识本次**同一份全账户 Algo 快照**；两腿必须由它分别核对。稳定且匹配的订单才能 PASS；完整快照确认 TP 缺失则 TP 为 FAIL；快照不完整、详情不足、过期或交易所状态不明则为 UNKNOWN，并说明原因。不能拿上一轮 TP 与本轮 SL 拼成双保护。没有快照时 `observation_id=null`，不能产生 PASS。平仓后的空列表不表示“保护验证通过”；时间线保留先前的保护核对事实。

## SSE 与断线续接

每条消息的 `id` 等于 `event_id`，`event` 等于 `type`，`data` 为**整个** `SseEvent` 的 JSON（包括 envelope），不是只有 `data` 子字段：

```text
id: evt-public-000042
event: heartbeat
data: {"schema_version":2,"event_id":"evt-public-000042","emitted_at":"2026-11-02T08:00:00.000Z","source":{"kind":"MOCK","label":"手写假数据，非真实交易记录"},"type":"heartbeat","data":{"at":"2026-11-02T08:00:00.000Z"}}

```

| `type` | `data` | 应用方式 |
| --- | --- | --- |
| `state` | `StateResponse` | 完整替换当前状态 |
| `timeline` | `TimelineResponse` | 替换订阅范围内的时间线基线，保留另行加载的旧页 |
| `step` | `TimelineStep` | 按 `(round_id, step_id)` 更新，按 `sequence` 排列 |
| `round` | `RoundSummary` | 按 `round_id` 更新摘要，保留已有步骤 |
| `heartbeat` | `{ at }` | 连接心跳，不代表数据已刷新 |
| `resync` | `{ reason }` | 游标已失效或历史有缺口，重新建立完整基线 |

首次订阅不带游标，服务端先发送一致的 `state` 和 `timeline` 基线（最近 20 轮），然后接续其后的事件，基线与接续之间不得丢更新。客户端可用 GET 先展示，但流建立后不能让晚到的 GET 覆盖较新的流数据。历史页仍可通过 timeline 接口读取。

`event_id` 是持久化、不透明的公开事件游标，不是 rustcore 的内部 `seq` 或 `event_id`，也不能按字符串大小比较。服务端按写入顺序发送；客户端用 `event_id` 去重，并用最后接收的 ID 作为 `Last-Event-ID` 续接。原生 EventSource 自动重连发送该头；重新创建连接时也可用 `?since_event_id=…`。服务端能增量续传时，只发送该 ID 之后的事件；不能续传时发送 `resync`，随后在同一连接发送新的完整基线再继续。客户端收到 resync 即清除旧游标，等待基线，不能将缺口当作无变化。单个订阅内先发送轮次再发送其步骤。

**第一版采用最简实现：任何携带游标的重连，一律先发 `resync`，再发一致的完整 `state` / `timeline` 基线，之后继续实时事件。** 暂不实现历史事件的增量续传；客户端按上述统一流程处理即可。`event_id` 的不透明性和去重语义保持不变，将来实现增量续传不改变 v1 格式。

## 录制与回放

`Recording` 含元数据、`initial_state`、`initial_timeline` 和有序 `events`。录制中的事件就是 `SseEvent`，不引入另一套 frame 类型。所有来源字段必须一致；`started_at ≤ ended_at`，初始快照为开始时刻，事件在此区间内按 `emitted_at` 非递减排列，同时间按数组顺序应用，`event_id` 不重复。

回放从两份初始快照开始，用与 live 相同的处理器依次应用事件。拖动时重置为初始快照，再应用 `emitted_at ≤ 目标时刻` 的事件；偏移毫秒数为 `Date.parse(emitted_at) - Date.parse(started_at)`。录制保留重启离线、预算过期、失败和随后的安全清理，不将这些阶段裁掉。`created_at` 是文件导出时间，不是场景开始时间。

手写假数据位于：

- [`recordings/mock-success-v1.json`](../recordings/mock-success-v1.json)：SCHEDULED 轮次，九步成功，含内核重启和恢复、SL/TP 分开通过、成交量和名义额。
- [`recordings/mock-failure-v1.json`](../recordings/mock-failure-v1.json)：MANUAL 轮次，中途 TP 缺失，SL PASS / TP FAIL；随后安全平仓和清理，轮次保持 FAILED。

两份均为 `source.kind=MOCK`，标题、描述和来源标签明确注明手写假数据，不代表测试网验收。页面进入回放时显示“回放”，加载这两份时额外显示“假数据”，不能标成真实交易。

## 兼容与验证

原 v1 继续冻结；2A 新 producer/consumer 按 v2 开发。字段重命名、删除、类型/单位变化、新增必须字段或封闭枚举成员都需要升版并同步更新文档、producer/consumer 和录制；冻结后不由任一端单独修改。消费者支持 1、2；遇到未知 `schema_version` 应显示不支持，不能强行解释。

安装依赖后运行 `npm run typecheck` 和 `npm run check:recordings`。原 v1 录制检查直接以冻结 TypeScript 类型检查 JSON；v2 producer 到 SQLite、导出再到 consumer 的契约往返由 `caller/test/replay-v2.test.ts` 验证，`npm --prefix web test` 验证 v1 回放。上述检查覆盖轮次、保护腿及失败保留等必要一致性，不另外维护一套公共 schema。
