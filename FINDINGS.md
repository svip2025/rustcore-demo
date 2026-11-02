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
