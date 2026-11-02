# 公共数据契约 v1（已冻结）

唯一类型定义是 [`shared/schema.ts`](../shared/schema.ts)。caller、web、SSE 和录制/回放共同导入该文件；不在各端另写同名响应类型。`schema_version` 固定为 `1`。本版已纳入冻结前的修订（预算命名、版本与触发来源）；HTTP 服务仍待实现。

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

v1 的 `PositionView.symbol` 固定为 `BTCUSDT`。若账户存在其他品种的持仓，公开 `positions.status` 必须标为 `PARTIAL`，并在 `reason` 写明未覆盖的品种及原因，不能静默过滤后宣称完整或空仓；已有的 BTCUSDT 行仍可展示。公开范围限制不缩小内部风险预算的全账户敞口口径。

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

轮次为 `RUNNING`、`SUCCEEDED` 或 `FAILED`。只有完整走过九步且所有必要判据 PASS 才为 `SUCCEEDED`；任一步 FAIL 或最终仍 UNKNOWN 为 `FAILED`，并附原因。首轮 `not_started` 同样保留为 FAILED。清理成功不能将失败轮次改成成功；完成的步骤和轮次不可覆盖为另一个结论。新轮次也不删除旧轮次。

## SL / TP 分开呈现

`ProtectionPairView` 始终具有独立的 `sl` 和 `tp`，每一腿都有 `status`、`reason`、`reason_code`、订单标识、触发价、交易所状态和观察时间。禁止从持仓 `PROTECTED` 推断二者均 PASS。

`observation_id` 标识本次**同一份全账户 Algo 快照**；两腿必须由它分别核对。稳定且匹配的订单才能 PASS；完整快照确认 TP 缺失则 TP 为 FAIL；快照不完整、详情不足、过期或交易所状态不明则为 UNKNOWN，并说明原因。不能拿上一轮 TP 与本轮 SL 拼成双保护。没有快照时 `observation_id=null`，不能产生 PASS。平仓后的空列表不表示“保护验证通过”；时间线保留先前的保护核对事实。

## SSE 与断线续接

每条消息的 `id` 等于 `event_id`，`event` 等于 `type`，`data` 为**整个** `SseEvent` 的 JSON（包括 envelope），不是只有 `data` 子字段：

```text
id: evt-public-000042
event: heartbeat
data: {"schema_version":1,"event_id":"evt-public-000042","emitted_at":"2026-11-02T08:00:00.000Z","source":{"kind":"MOCK","label":"手写假数据，非真实交易记录"},"type":"heartbeat","data":{"at":"2026-11-02T08:00:00.000Z"}}

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

第二部分可以现在按 v1 开发。字段重命名、删除、类型/单位变化、新增必须字段或封闭枚举成员都需要升版并同步更新文档、producer/consumer 和录制；冻结后不由任一端单独修改。消费者遇到未知 `schema_version` 应显示不支持，不能按 v1 强行解释。

安装依赖后运行 `npm run typecheck` 和 `npm run check:recordings`。录制检查直接以这里的 TypeScript 类型检查 JSON，并检查轮次、保护腿及失败保留等必要一致性；不另外维护一套公共 schema。
