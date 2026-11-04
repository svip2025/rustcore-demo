# 接入调研记录

基线：rustcore `1986eac011badfa268be9e2e7f9667e024fd046c`，2026-11-02。

本文件记录第 0 步的**静态接口差异和集成限制**。没有真实测试网运行证据，不据此宣称已经发生交易故障；没有修改 rustcore。完整使用方案与待审核事项见 [TESTNET-SETUP.md](docs/TESTNET-SETUP.md)。

## F-01：空库首次 Entry-ready 初始化未证实

ReconcileNow/EnsureMarketData 不直接启动成交私有流；startup 的流恢复依赖持久化 scopes/orders/fills，缺少 fill_stream_state 时 Entry 被拒。ExecuteIntents 会在风控前启动私有流，但它是异步的，当前也没有公开 ready 字段。

依据：[src/svc.rs:2449](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2449)、[src/svc.rs:5833](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L5833)、[src/binance_user_stream.rs:187](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/binance_user_stream.rs#L187)、[src/fill_replay.rs:220](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/fill_replay.rs#L220)、[src/risk.rs:317](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/risk.rs#L317)、[proto/execution_engine_v2.proto:353](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L353)。

处理：提交甲方确认。不得写数据库或反复提交同一场景直到成功后隐藏失败；是否接受独立首次 FAILED 轮次尚未决定。

## F-02：protected 与 SL 恢复不能证明 TP 恢复

已有确认 SL 时，submit_planned_protection 可以直接返回；恢复逻辑主要按 SL 查询、复用或修复。不能由 protected 推断双保护有效，也不能承诺 SL 仍在而 TP 缺失时会自动补 TP。

依据：[src/svc.rs:1881](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L1881)、[src/svc.rs:2064](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2064)、[src/svc.rs:2203](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2203)。

处理：演示逐一核对同轮交易所 Algo 快照中的 SL/TP；缺失、未知或缺详情必须如实显示，不自行修改内核或补造真值。

## F-03：Protection.confirm_timeout_ms 与实际确认定时器来源不同

RPC 字段被持久化进保护计划，但 Algo ACK 后的确认任务读取进程环境 PROTECTION_CONFIRM_TIMEOUT_MS，而非在该处读取请求值。

依据：[src/svc_v2.rs:1487](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L1487)、[src/protection.rs:219](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/protection.rs#L219)、[src/svc.rs:4391](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L4391)。

处理：文档示例与默认统一为 5000ms；不承诺修改请求字段即可改变有效定时器。设计意图及是否需要修订接口语义待确认。

## F-04：契约注释与当前接口边界有差异

- proto 的 run_mode 注释只写 paper/live，精确平仓注释还称 paper-only；实现已支持 demo exchange。依据：[proto/execution_engine_v2.proto:18](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L18)、[proto/execution_engine_v2.proto:53](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L53)、[src/position_close.rs:293](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_close.rs#L293)。
- GetAccountOrderState 的 exchange credential 只接受 1–10 位无前导零数字，比执行接口的 credential 文法窄。依据：[src/account_order_read.rs:96](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/account_order_read.rs#L96)、[src/venue.rs:256](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/venue.rs#L256)。
- README 的认证“未过期”措辞不等于内核有 TTL：RPC 没有 expires_at，当前选择只检查 passed、未 invalidated、stage/hash/policy/commit 等匹配。依据：[proto/execution_engine_v2.proto:518](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L518)、[crates/risk-policy/src/lib.rs:562](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/crates/risk-policy/src/lib.rs#L562)。

处理：本演示使用 demo/testnet，不需要 promotion certification；本地示例 ID 统一为 9001/9002，使用实现明确支持的接口。不修改固定版本。

## F-05：“最小仓位”与公开定量接口的边界

v2 quantity 字段 reserved，数量由风控计算；remaining_credential_notional_usdt 虽可被接受/存储，其值没有直接映射为定量硬限额。不能声称设置该字段即可得到最小 lot。

依据：[proto/execution_engine_v2.proto:78](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L78)、[src/risk.rs:579](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/risk.rs#L579)、[crates/risk-policy/src/lib.rs:1025](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/crates/risk-policy/src/lib.rs#L1025)。

处理：待甲方确认“最小”的口径；不伪造预算、不直写 policy/数据库、不改业务逻辑。

## F-06：官方测试网域名与固定内核基线不同

2026-11-02 查阅的 [Binance General Info](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info) 已将测试网 REST 地址列为 `https://demo-fapi.binance.com`；固定内核仍使用 `https://testnet.binancefuture.com`，其 venue 校验也依赖该地址。官方 [Postman 集合](https://github.com/binance/binance-api-postman/blob/master/collections/Binance%20Derivatives%20Trading%20USDS%20Futures%20API.json) 仍分别列出 testnet 和 demo 地址。这些文档不能证明两个端点的账户或密钥可以互用。

处理：caller 的独立只读前置检查固定使用与内核一致的旧测试网地址，三个签名 GET 分别为 `Get Current Position Mode`（`dualSidePosition=false`）、`Position Information V2`（BTCUSDT 的 `marginType=cross`、`leverage=1`）、`Account Information V2`（USDT `walletBalance>=100`）。当前官方 [账户接口](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account) 和[持仓接口](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/trade#position-information-v2) 仍列出这些 GET 路径与字段。本文仅记录文档和源码差异，未进行真实连接验证；权限错误、404 或其他失败必须明确记录，不换主网、不自动切换地址、不修改内核。

## F-07：真实只读检查与尚未满足的账户前提

2026-11-02 约 13:10–13:18 UTC，单次只读检查得到以下去敏事实。此节是后续运行记录，F-01 至 F-06 的原始静态研究保持不变；它不是交易场景验收。

| 检查 | 实际结果 |
| --- | --- |
| 固定内核旧测试网入口的首次持仓模式 GET | HTTP 418，交易所错误代码 `-1003`；停止请求，未重试。 |
| 官方新测试网入口：持仓模式、BTCUSDT positionRisk、账户信息三项 GET | 使用同一测试网凭证，三项读取均成功。 |
| 持仓模式 | `one_way=true`，BTCUSDT `position_side=BOTH`。 |
| BTCUSDT 保证金和杠杆 | `margin_type=cross`，`leverage=20`。 |
| USDT 钱包余额 | `4955.91702421`（测试资金，满足场景资金前提）。 |
| 非零持仓 | `held_positions=[]`。 |

依据为该次工具的去敏输出，未另存独立 receipt。固定源码的测试网地址见 [venue.rs:7](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/venue.rs#L7)，URL 与显式 venue 的匹配仍由内核 `resolve_base_url` 约束；当前环境变量不能直接改成另一入口绕过校验。

处理：旧入口的 418 / `-1003` 如实保留，不能据此判定为坏 Key；新入口只读成功也不能推断已经下单或恢复成功。用户随后手动调整杠杆，只读复核已确认 BTCUSDT 与 ETHUSDT 均为 `cross`、`1x`、`BOTH`。端点兼容通过独立授权的 [PR #2](https://github.com/svip2025/rustcore/pull/2) 处理，caller 只读检查切换到同一官方新测试网；演示 submodule 固定 `6a81a4aec7ee92a9cd6aebdaef6446515ac2d989`，PR 尚未合并。这些检查未修改交易所设置、没有订单写入，也未通过完整场景。

## F-08：首轮 caller 对账期限与额外限流配置不匹配

真实轮次 `round_01M6E83G0JPS0ZX0XR5RHTCD1J`（MANUAL）于 `2026-11-02T13:45:11.444Z` 开始，在前置对账得到 `DEADLINE_EXCEEDED: ReconcileNow budget exhausted`，结束为 FAILED，没有提交开仓。原始 [TESTNET 录制](recordings/run-20261102-134511-failed.json) 保留 caller/内核具体版本、失败步骤及原因。

这是 caller 接入配置问题，不作为内核风控故障：测试进程额外设置的旧名 `RUSTCORE_BINANCE_RPS=2` / `BURST=2` 实际以**请求权重**计量，全账户读取的成本远大于两次请求；caller 同时只给了 10 秒 gRPC 期限。处理是移除额外限流覆盖、沿用内核默认限流，并让 caller 的有界读取期限覆盖正常全账户对账。预算发布独立每 10 秒运行，源数据过期或不可用时仍不发布，不能用新时间刷新旧事实。原失败轮次不会覆盖；后续验证使用新的 MANUAL 轮次。

## F-09：首个开仓准入拒绝及不存在的客户端映射

MANUAL 轮次 `round_01M6E95ZPXR3TN7QP59FX6Y7Q9` 的账户前提、预算基准重置及前置清理通过，开仓明确返回 `FILL_RECOVERY_NOT_READY`。该 [FAILED 录制](recordings/run-20261102-140401-failed.json) 原样保留；RPC 没有提供 ready 的更细内部状态，不把 `not_started` 当作本次额外观察事实。

caller 在明确拒绝且未产生 engine_order_id 后，仍用 client ID 查询不存在的订单映射，使后置清理得到 UNKNOWN。修正只针对这种明确否定回应：跳过不存在的映射查询，仍须完整 fresh-flat 证明清理；提交结果未知时继续用原 ID 读回，不重发开仓。原轮次及原 UNKNOWN 不修改。

## F-10：成交后保护观察尚未满足完整快照条件

MANUAL 轮次 `round_01M6E9BH2FT4VM34RVVFRX58N9` 开仓成交 `0.0095 BTC`、名义额 `741 USDT`，但双保护核验为 UNKNOWN：当前可读观察不满足同一轮、成功、完整账户的条件。随后精确平仓成交、保护清理及全账户零敞口检查均 PASS；[原录制](recordings/run-20261102-140703-failed.json) 保持 FAILED，没有进入持仓重启步骤。

公开事件中完整对账后紧接符号范围对账；观察注册表的每次 begin 会使当前完整性失效，旧 full 只能带原时间展示，见固定提交 [account_order_observation.rs](https://github.com/svip2025/rustcore/blob/6a81a4aec7ee92a9cd6aebdaef6446515ac2d989/src/account_order_observation.rs)。这是实际读回时序与严格观察条件的交界，不能仅凭事件报告有两张 Algo 单便宣称 SL/TP 各自通过。后续 caller 在有界窗口内等待完整观察，FAIL 仍立即失败，持续 UNKNOWN 到期仍失败；不修改核验判据，不补挂保护，先前终结轮次不改写。

测试网新入口随后实际返回 REQUEST_WEIGHT 上限 `6000/min`。后续演示使用内核已有的 Testnet 请求权重配置 `20/s`、burst `100`（持续值 `1200/min`），减少一次 full 读取与后台周期交错的时间；保留内核的 exit reserve、冷却及预算守卫，不修改后台对账周期或风控 policy，也不改变保护观察的 30 秒新鲜度要求。该速率配置不承诺每次观察一定成功。

## F-11：小数 SL 的浮点尾差与交易所步长

MANUAL 轮次 `round_01M6EAK2KQP2W51D7JXFMBKFP8` 的 TP 独立 PASS、SL FAIL（触发价与当前计划不一致）；精确平仓、保护清理及全账户零敞口检查均 PASS，整轮保留 [FAILED 录制](recordings/run-20261102-142839-failed.json)。caller 私有输入记录的 SL 为 `76984.8`，公共事件中的 SL 子单 requestedPrice 与交易所读回均为 `76984.9`，当时 BTC tick 为 `0.1`。

源码路径是风险 sizing 把 stop 转为 f64，再以 12 位小数序列化为计划（[risk-policy decimal](https://github.com/svip2025/rustcore/blob/6a81a4aec7ee92a9cd6aebdaef6446515ac2d989/crates/risk-policy/src/lib.rs#L477)）；交易所过滤器对 SELL 价格向上对齐步长。单例数值复现 `76984.8 → 76984.800000000003 → 76984.9` 与实读子单吻合。该次原始 current-plan 字符串没有另存，不将源码推导说成原始字段读回。

不在此工单修改内核精度逻辑。caller 后续 SL 规划使用合法整数 USDT 网格，且该网格必须为真实 tick 的整数倍（如 tick=0.1 时 grid=1）；仍按同一 1% 公式向下对齐，不改权益、policy 或内核自动定量。有效规划价、实际 tick 和 stop_grid 一并纳入配置摘要和私有输入记录。`verifyProtection` 仍要求计划/本地行/交易所精确一致，不以容差放行，不补挂保护；已有 FAILED 原样保留。

整数网格兼容的是未触发 stop-distance clamp 的正常输入路径。最终实际止损距离和 RR 仍由内核按默认策略核算；若 clamp 重新计算浮点 SL，仍可能出现此精度边界，不能将该输入规划方式说成内核的普遍修复。

## F-12：重启状态事件的旧生成时间与 caller 异常恢复

MANUAL 轮次 `round_01M6EBBXRDXQD5QBJN1SE294W3` 的开仓、SL/TP 独立核验和持仓均 PASS。进入重启步骤后，caller 复用了旧 `StateResponse.generated_at`，触发持久事件的单调时间检查 `Public event time cannot move backwards`，流程在调用终止内核前中断。此前没有发生本轮计划中的持仓重启；[原 FAILED 录制](recordings/run-20261102-144213-failed.json) 保留。

异常同时让 caller 的 restarting 标志未恢复、事件订阅未恢复。后续精确平仓结果无法在该轮被 caller 完整证实，清理步骤也没有通过。随后独立的公开 gRPC 对账已实际确认 `completed=true`、`has_diff=false`、全部仓位为零、普通与 Algo 挂单均为空，本地差异为零。这份后续观察不能倒改已完成的 UNKNOWN/FAIL 步骤。

修正仅在 caller：每条新状态更新自己的 generated_at，保留事实 observed_at/source_as_of；整个重启过程用 finally 恢复调度状态，尚未终止内核就失败时恢复读取与订阅。持久日志的单调时间检查保持不变。

## F-13：交易所平仓后持久额度预留未释放（修复与验证通过）

2026-11-03 的第二、第三轮 SCHEDULED 开仓均被 `RESERVATION_CONFLICT; deterministic risk policy` 拒绝；前置检查、前置清理和失败后清理均 PASS，没有新开仓成交。两轮 FAILED 及其录制保留，不能通过重发、清空额度表、修改权益或重置数据库把失败隐藏。原 `attempt-001` 于 `2026-11-03T10:30:56.686Z` 标记为 `STOPPED / DEPLOYMENT_BUG`，其三轮 SCHEDULED 为一轮 SUCCEEDED、两轮 FAILED；STOPPED 是观测 attempt 状态，不改写任何 round。修复前备份回执已确认 `scenario.timer=inactive`，原窗口不构成 48 小时通过证据。

固定内核 `f8a331a1a3ff035162ceca657b2467dc45583a61` 的 Entry 准入会按最终 sizing 增加 `notional_reservations`，后续准入读取该持久余额；正常交易所成交平仓、对账归零和精确平仓终结没有对应的额度释放。依据为 [Entry 预留](https://github.com/svip2025/rustcore/blob/f8a331a1a3ff035162ceca657b2467dc45583a61/src/svc.rs#L2922)、[持久余额读取](https://github.com/svip2025/rustcore/blob/f8a331a1a3ff035162ceca657b2467dc45583a61/src/risk.rs#L1150)、[仓位关闭](https://github.com/svip2025/rustcore/blob/f8a331a1a3ff035162ceca657b2467dc45583a61/src/position_state.rs#L936)及[交易所精确平仓终结](https://github.com/svip2025/rustcore/blob/f8a331a1a3ff035162ceca657b2467dc45583a61/src/position_close.rs#L1254)。用户已单独授权修复这一内核业务缺口，修复与验证结果如下。

2026-11-03 11:38:34.913656 UTC 已从只读源创建 SQLite 在线备份，`quick_check=ok`；备份文件权限 600，目录权限 700。备份 SHA256 为 `c3cec497dad42889ab770621e8aed6d7de65abbca35da705b7c42bb5c034578a`。私有去敏回执为 `pre-fix-backup.json`、`historical-entry-reservations.json`、`historical-safe-closes.json`。

历史只读关联已实际完成：`demo_scenario_inputs` 的 Entry intent 关联 `risk_verdicts` 与原始 Entry 订单，取 `sizing_json.final_notional_usdt` 作为最终预留金额；再以 Entry 订单关联仓位，并用 `position_close_requests.target_json.entry_engine_order_id` 限定原 Entry 的平仓回执。11 月 2 日共六笔实际开仓，六笔仓位均为 `closed`、`qty=0`，均有 `filled / EXCHANGE_FILLED` 平仓回执；Entry 与 close 的成交行已分别读回，成交量一致，symbol scope 均已知。六笔保护清理均为 `complete / exchange_truth / truth_confirmed`。

| 轮次开始时间（UTC，2026-11-02） | 原轮次状态 | 实际开仓 / 平仓 BTC | Entry 最终预留 USDT |
| --- | --- | --- | --- |
| 14:07:03.248 | FAILED | 0.0095 / 0.0095 | 743.3875536315 |
| 14:28:39.161 | FAILED | 0.0095 / 0.0095 | 743.276982297 |
| 14:42:13.390 | FAILED | 0.0095 / 0.0095 | 743.188153122 |
| 15:01:45.420 | SUCCEEDED | 0.0095 / 0.0095 | 743.0420824155 |
| 18:18:41.518 | SUCCEEDED | 0.0096 / 0.0096 | 742.9617763125 |
| 18:27:54.564 | SUCCEEDED | 0.0096 / 0.0096 | 742.7737818945 |

六笔原始最终预留以 Decimal 相加为 `4458.6303296730 USDT`，与此前实读仍占用的 `4458.630329673 USDT` 相等。预留金额与交易所成交名义额分别记录：例如首笔 Entry 成交名义额为 `741.0000 USDT`，其最终预留为 `743.3875536315 USDT`，释放依据须使用原预留金额。第一笔缺少 `position_execution_provenance` 匹配证明；其余五笔该证明匹配且 venue 为 `testnet`。六笔均已读回语义 epoch 键匹配、请求 stage 为 `demo`，第一笔的证明缺口仍保留，不补造来源。

特别保留 11 月 2 日三轮失败后的安全处理边界：14:07、14:28 两轮原录制的精确平仓、保护清理及完整账户零敞口检查均 PASS；14:42 轮自身的后置清理未获证明。此次读回其后续持久回执为 `filled / EXCHANGE_FILLED`，frozen outcome 为 `closed / 0`，但这份后续真值及独立 flat 观察均不倒改原轮 UNKNOWN/FAIL。

修复集中在正常对账 `Finalize` 阶段：同轮交易所仓位读取覆盖目标 symbol/direction，Entry 已终结，读取开始时间严格晚于 Entry 创建及最后更新时间，本地仓位为 `closed / 0` 且交易所该 scope 为 flat，才进入共用回收。单独的本地零仓位或平仓成交回执不足以释放。实现见 [reconcile.rs](https://github.com/svip2025/rustcore/blob/9d78049fda170939bfa21cbbd0e837eb88e5af2f/src/reconcile.rs#L2440) 与 [reservation_release.rs](https://github.com/svip2025/rustcore/blob/9d78049fda170939bfa21cbbd0e837eb88e5af2f/src/reservation_release.rs#L29)。

| 平仓 / 恢复路径 | 共用回收依据 |
| --- | --- |
| `ClosePosition` 精确平仓 | 正常成交终结后，在对账 `Finalize` 取得上述 fresh-flat 真值。 |
| 普通 reduce-only 平仓 | 成交和仓位真值使本地仓位关闭后，走同一 `Finalize` 回收。 |
| 失败轮次的安全平仓 | 使用相同精确平仓与 fresh-flat 回收；原轮次 FAILED 不影响已证实额度归还，也不被改写。 |
| 重启恢复、旧版本遗留的已关闭仓位 | 后续正常对账重新扫描持久仓位和 Entry；不依赖进程内记忆。 |
| 交易所手动平仓、SL / TP 触发平仓 | 对账确认关闭并取得 fresh-flat 真值后共用回收；不要求一定存在 caller 的精确平仓请求。 |

每笔只归还原 Entry 对应批准 / resize verdict 中的 `sizing_json.final_notional_usdt`，使用精确十进制减法。新增 [0046 迁移](https://github.com/svip2025/rustcore/blob/9d78049fda170939bfa21cbbd0e837eb88e5af2f/migrations/0046_notional_reservation_releases.sql) 以 `entry_engine_order_id` 为主键、`risk_verdict_id` 为唯一键；释放 marker 与余额扣减在同一事务提交，并使用账户预留锁和原余额校验。重复对账、并发执行及进程重启都不能重复归还同一 Entry；金额不足或归属不明时保留预留并报告原因，不清空整个账户额度池。

legacy fallback 仅用于缺少 execution provenance 的记录：仍要求唯一 Entry、唯一引用的批准 verdict、账户 / bot / symbol / direction 一致、语义 epoch 幂等键匹配、replay stage 为 `demo` / `live_small` / `live`，并有同交易所订单、已知 symbol scope 的真实正数量成交。已有 provenance 若冲突则不走 fallback；fallback 只证明额度归属，不恢复精确平仓权限。

修复前真库回归 `exchange_close_reconcile_releases_exact_original_entry_reservation` 已实际 RED（实际 `237.125`、期望 `100`），修复后已 GREEN；另七项专项检查通过，涵盖 MySQL 并发、SQLite 回滚、进程重启、legacy 及守卫条件。本地全量测试 exit 0，顶层聚合为 **1400 PASS / 0 FAIL / 31 ignored**，不重复计入 filtered 子 helper；`RUSTCORE_REQUIRE_MYSQL_TESTS=1` 且 MySQL fixture 健康，fmt / clippy 通过。[CI 41632219712](https://github.com/svip2025/rustcore/actions/runs/41632219712) 的 test、fmt、clippy 三项均成功。修复提交 `9d78049fda170939bfa21cbbd0e837eb88e5af2f` 已通过 [PR #3](https://github.com/svip2025/rustcore/pull/3) 合并，merge commit 为 `cdd7916458855375a4dfe5b543e8a47b2d75fc78`。

存量释放由后续成功对账按上述 fresh-flat 判据执行；部署读回及新 48 小时窗口见运行回执。旧 `attempt-001` 和全部原始失败记录保留；新 attempt 从新的首个 SCHEDULED/RUNNING 重新计时，规则见 [RUN-48H.md](docs/RUN-48H.md)。本节的修复与测试通过不代表 48 小时观测通过。

## F-14：systemd 重载后重复执行首触发条件

`attempt-002` 于 2026-11-04 06:40:38.799 UTC 标为 `STOPPED / DEPLOYMENT_BUG`，停止未来 timer，保留 caller、内核和全部五轮录制。五轮九步均 PASS，但后两轮于 01:41:31.609、01:44:10.580 UTC 额外启动，偏离六小时间隔，不能据此宣布该窗口通过。五笔原 Entry 预留都有等额释放 marker，停表前只读余额为零；额外两轮之间没有直接池余额采样，对应第四轮后 / 第五轮前证据保留 UNKNOWN。

原 timer 同时有 `OnActiveSec=30s` 和 `OnUnitActiveSec=6h`。实际 manager reload 于 01:41:00.832599、01:43:39.545797 UTC 完成，约三十秒后分别触发上述额外轮次；timer 的激活时间和文件指纹没有变化。无交易 systemd 回归已复现：保留旧条件时，reload 后约 3.45 秒就产生第二次执行，未等正常的 60 秒周期。

最终调度使用 `OnCalendar=*-*-* 00/6:00:00 UTC`，在 UTC 00、06、12、18 点各执行一次，`Persistent=false` 不补跑历史时点。新 observer 先 arm，再启用 timer，首轮也等待真实 calendar 触发；没有人工 bootstrap。timer/manual 仍走同一 caller 文件锁。无交易 calendar 回归以二十秒网格加速验证：连续三次 reload 不增加执行、不改变下一次时间，只有正常网格到期才产生第二次执行。

另一份相对定时试验中，瞬时 oneshot 在启用 timer 前已退出并被回收，下一次时间为 `infinity`；失败回执保留。这也说明相对定时方案需要额外维持首次 service 的时间锚，最终 calendar 方案不依赖它。修复不改 caller 业务、内核、风控或原录制；部署后另建 attempt，从首个真正的 SCHEDULED/RUNNING 从零观察。

## F-15：正常 listenKeyExpired 被忽略（2A 离线修复候选）

冻结内核的用户数据流读取器遇到格式合法的 `listenKeyExpired` 时，解析成功后交给未处理该事件的 sink，未结束当前 cycle，也未立即撤销 ready。畸形失效帧已有测试，不能代替正常失效事件的判据。

2026-11-04 先以真实 SQLite 和受控本地 WebSocket 帧复现 RED：`round2_valid_listen_key_expired_stops_reader_before_next_frame` 断言合法失效帧必须结束读取失败。修复在读取器 envelope 路径立即处理该事件，撤销 ready、推进恢复 generation，并复用重连、补成交与 REST 对账流程。同名回归及受测试网守卫限制的主动断流/失效注入专项已 GREEN。证据名为 `f15-listenkey-red-clean.log`、`kernel-round2-green-3.log`；完整本地索引见本次 `RUSTCORE-ROUND2-PREP.md` 交接。

该结论仅证明本地受控事件和数据库恢复分支。真实测试网 listenKey 生命周期、失效通知格式和断流期间真实止损触发后的清理仍为“待测试网实测”。未修改第一轮运行版本或原监控；F-13、F-14 编号与原始事实保持不变。

## F-16：2A 候选排期未覆盖完整资金费窗口与 MANUAL 间隔

前置候选 `4e8ab2662a6864bf3e8edfbbdc6b76460481c29b` 的 S4 插入判断仅检查开仓时刻，导致 T0 对齐资金费结算时，23h50m 开始的 S4 会持仓进入 24–30h 故障段；普通 dispatcher 又只比较自己认领的轮次及 caller 当前是否运行，未计入刚结束的 MANUAL 轮。两个问题均发生在未部署候选，不能归因于第一轮冻结版本。

修复前的独立真实 CLI/SQLite 用例与排期断言分别保留 `scheduler-manual-spacing-red.log`、`scheduler-funding-overlap-red.log`。后续候选按 S4 完整二十分钟窗口排除故障段，并读取 caller 的实际 latest_round 开始时间，距最近任意轮不足三十分钟时将正常自动 slot 保留为 BUSY。负责人明确允许的同组故障/S1 例外仍只由 MANUAL 故障工具执行，不扩散到普通 dispatcher。修复后专项与全量/CI 结果见最终交接索引；没有修改工单基线或任何运行中服务。

## F-17：慢 CI 暴露模拟交易所共享限流桶和旧快照夹具的时间竞赛

候选内核 `854cd95fdd07804863601611dd8f9ec56eeab17b` 的本地全量为 1417 PASS / 0 FAIL，但 [CI 41826496251](https://github.com/svip2025/rustcore/actions/runs/41826496251) 的核心测试为 1290 PASS / 2 FAIL，不能将本地 PASS 作为远端通过。`exchange_close_contract_vector` 的模拟对账在继承的进程级限流队列超时；`exchange_close_never_finalizes_from_a_position_read_older_than_the_close_order` 则要求整次真实 Reconcile 在人为预设的未来八秒之前完成，慢 CI 已越过该前提。完整远端日志保留为 `kernel-ci-854cd95-failed.log`。原 CI 未保存桶余额；后续零 token/零 refill 是独立受控机制复现，不冒称原 CI 的余额实测。

后续修复只针对夹具隔离与确定性时序：每个模拟交易所使用独立 route，旧读数测试通过可控读数开始点证明实际 interleaving。资金安全判据仍是旧读数不得终结平仓，随后严格更新的读数才能终结；不调整生产风控或超时，不跳过用例。最终候选的专项、全量、fmt/clippy 与适用 CI 必须重新实际通过，结果以交接回执为准。
