# Binance USDⓈ-M 测试网接入调研（第 0 步）

执行版本补记：原始研究仍固定下述 `1986eac`。第 1 部分经单独授权，使用 [端点兼容 PR #2](https://github.com/svip2025/rustcore/pull/2) 的 `6a81a4aec7ee92a9cd6aebdaef6446515ac2d989` 进行集成测试，canonical 测试网 REST/WS 已更新，其他交易及风控判据未修改。

状态（2026-11-02）：**第 0 步调研已审核通过；第 1 部分 caller 终端链路正在实现和验证，真实完整场景尚未通过。** 公网 HTTP/SSE 与部署尚未完成。

下文保留原第 0 步静态源码研究、行号和未实测边界，不将后续只读账户检查倒填为源码调研或交易成功。当前实现选择见 [STEP1-DECISIONS.md](STEP1-DECISIONS.md)；旧测试网入口 418、新官方入口读取成功但 BTCUSDT 为 20x，以及待手动 1x/独立端点兼容 PR 的状态见 [F-07](../FINDINGS.md#f-07真实只读检查与尚未满足的账户前提)。

源码基线：rustcore [1986eac011badfa268be9e2e7f9667e024fd046c](https://github.com/svip2025/rustcore/tree/1986eac011badfa268be9e2e7f9667e024fd046c)。下文链接固定到这一提交；后续 submodule 应固定版本后再实施。本步骤只读源码、proto、README，未使用交易所凭证、调用交易 RPC或重复进行 VPS 连通性调研。请求示例是待填运行时数据的协议模板，不是成功下单记录。

## 结论与实施前提

| 问题 | 源码结论 |
| --- | --- |
| 测试网真实执行 | `run_mode=demo`、`ENGINE_STAGE_MAX=demo`、明确的 per-credential `testnet`，同时保持 `ENGINE_LIVE_ENABLED=0`。 |
| 阶段认证 | 这个测试网 demo 不需要 `PutPromotionCertification`。 |
| 开仓和保护 | 使用 v2 `ExecuteIntents`，附带 typed `Protection`；数量由风控计算，成交后内核自动发止损/止盈子意图。 |
| 正常精确平仓 | 优先 v2 `GetPositionCloseTarget → ClosePosition → GetPositionCloseReceipt`；当前实现支持 exchange demo。 |
| 重启恢复 | 依赖同一持久数据库、恢复域、user-stream 回补、对账和保护计划；进程在线不等于恢复完成。 |
| 风险预算 | 按 credential 发布完整账户事实，每 10 秒更新；默认超过 30 秒拒绝开仓。 |

有三个事项必须在审核时明确：**空库首次 Entry-ready 的初始化方式、场景“最小仓位”的定义、双保护无法完整证明时的失败处理**。不能把后文列出的不确定项当作已打通链路；具体见第 7 节和 [FINDINGS.md](../FINDINGS.md)。

## 1. 测试网凭证、最小环境与认证

### 1.1 统一凭据标识

文档使用本地示例标识 `"9001"`（测试机）和 `"9002"`（长期运行机），**不是交易所账户 UID，也不是实际凭据**。选择数字是因为已实现的 v2 `GetAccountOrderState` 对 exchange credential 另有更窄限制：1–10 位数字、不允许前导零，并要求 `schema_version=1`。其他执行接口允许的标识更宽，不能据此推断这个读接口也接受 `demo-testnet-a`。依据：[src/account_order_read.rs:96](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/account_order_read.rs#L96)、[src/account_order_read.rs:142](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/account_order_read.rs#L142)。

环境变量后缀是 `H + trim(credential_id) 的 UTF-8 字节大写十六进制`：

| 本地 ID | locator |
| --- | --- |
| `9001` | `H39303031` |
| `9002` | `H39303032` |

这是可逆编码，不是把标点替换为下划线。依据：[src/venue.rs:345](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/venue.rs#L345)。两台需要不同的测试网 Key **以及真正隔离的测试网账户**；不同本地 ID、不同 Key 本身不构成交易所账户隔离证明，内核的身份检查也不是交易所账户归一化服务。依据：[src/account_identity.rs:1](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/account_identity.rs#L1)。

### 1.2 真实测试网执行的五个核心环境变量

测试机示例；尖括号内容只能在机器上的受限环境文件中替换，不能提交仓库：

~~~dotenv
ENGINE_LIVE_ENABLED=0
ENGINE_STAGE_MAX=demo
BINANCE_VENUE_H39303031=testnet
BINANCE_API_KEY_H39303031="<replace-me>"
BINANCE_API_SECRET_H39303031="<replace-me>"
~~~

长期运行机使用 `9002/H39303032` 和其独立测试账户的 Key/Secret。不要使用 `paper` 或 `paper:<32hex>` 作为真实测试网凭据：它们是模拟身份。依据：[src/venue.rs:256](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/venue.rs#L256)、[src/svc.rs:782](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L782)。

守卫链不是“把 live 开关打开再连测试网”：

1. `demo` 是 exchange-backed 档位；只有 `live_small/live` 才在档位检查中要求 live 开关。部署上限默认 `paper`，因此必须显式设 `ENGINE_STAGE_MAX=demo`。[src/svc.rs:753](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L753)、[src/svc.rs:808](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L808)、[src/svc.rs:818](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L818)
2. demo 开仓/保护单要求该 credential **明确选择 Testnet venue**；只改进程级 REST/WS URL 不等价。通用网关允许条件包含 `venue == Testnet`，所以 `ENGINE_LIVE_ENABLED=0` 不阻塞测试网。[src/svc.rs:851](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L851)、[src/svc.rs:872](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L872)、[src/svc.rs:3606](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L3606)
3. 显式 venue 下，只读取同一 locator 的 Key/Secret，不回退全局 Key。[src/binance_futures.rs:4407](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/binance_futures.rs#L4407)

当前内置测试网地址为 REST `https://testnet.binancefuture.com`、WS `wss://stream.binancefuture.com`，由代码决定。最小配置无需另设 URL；若设置，必须与显式 venue 一致，不能未经分析换成不被当前 venue 校验器识别的域名。这里只说明固定版本的行为，不重新证明这些端点的实际可达性。依据：[src/venue.rs:7](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/venue.rs#L7)、[src/venue.rs:600](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/venue.rs#L600)、[src/main.rs:366](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/main.rs#L366)。

为落实演示的绑定与持久化要求，部署时还应明确指定：

~~~dotenv
RUSTCORE_GRPC_ADDR=127.0.0.1:50051
RUSTCORE_DB_URL=sqlite:///var/lib/rustcore-demo/rustcore.db
RUSTCORE_GRPC_AUTH_TOKEN="<LOCAL_GRPC_TOKEN>"
~~~

默认已经是 loopback 和 SQLite；以上是部署的显式配置，不是额外交易许可。SQLite 是文件数据库，没有数据库 TCP 监听端口；数据库文件和原路径必须跨进程重启保留。目录、权限和 systemd EnvironmentFile 留待获批后的部署步骤处理。配置读取依据：[src/main.rs:267](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/main.rs#L267)、[src/main.rs:278](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/main.rs#L278)。本机 gRPC 若配置 token，caller 也须发送 `authorization: Bearer <token>`，不能设置禁用认证来替代绑定要求。

### 1.3 是否需要 PutPromotionCertification

**不需要。** 风控在 `requested_stage="demo" && venue_is_testnet` 时通过阶段认证规则，审计说明为：

~~~text
authorization_source=testnet_venue requested_stage=demo certified_stage=none
~~~

依据：[crates/risk-policy/src/lib.rs:582](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/crates/risk-policy/src/lib.rs#L582)；服务端将实际 credential venue 传入风控，见 [src/svc.rs:2651](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2651)、[src/risk.rs:1260](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/risk.rs#L1260)；空认证投影的现有例子见 [src/svc_v2.rs:6098](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L6098)。

因此本演示不发送虚构的“已通过认证”。仅供澄清：认证 RPC 有 cert_id、bot_uid、stage、config_hash、prompt_hash、policy_version、code_commit、passed、certified_at_ms、可选 invalidated_at_ms；**没有 expires_at，当前匹配逻辑也没有按认证年龄执行 TTL**。README 的“未过期”不能解释成一个源码中不存在的自动过期机制。本 demo 不依赖该接口。依据：[proto/execution_engine_v2.proto:518](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L518)、[crates/risk-policy/src/lib.rs:562](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/crates/risk-policy/src/lib.rs#L562)。

## 2. ExecuteIntents 的最小完整开仓请求

### 2.1 使用哪个接口

开仓使用 `execution_engine.v2.EngineExecution/ExecuteIntents`。裸 vNext 开仓被生产入口拒绝，不能借它的 quantity 字段绕过 v2 定量。依据：[src/svc.rs:2354](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2354)、[src/svc_v2.rs:1458](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L1458)。

| 字段组 | 本演示应提供的内容 |
| --- | --- |
| 批次 | credential_id、run_mode="demo"、intents、data_snapshot、schema_version=1 |
| 追踪与幂等 | bot_uid、run_id、cycle_id、intent_id、idempotency_key、client_order_id_short |
| 合约身份 | exchange="binance"、market_kind="futures"、symbol_key="binance\|futures\|BTC\|USDT\|USDT" |
| 开仓 | action="open_long"、order_type="market"、limit_price=""、reduce_only=false、max_slippage_bps=15、valid_until_ms |
| 保护 | required=true、stop_loss_price、take_profit_price、confirm_timeout_ms=5000、schema_version=1 |
| provenance | policy_version="risk_policy_v3"、config_hash、prompt_hash、code_commit |

字段定义见 [proto/execution_engine_v2.proto:53](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L53)、[proto/execution_engine_v2.proto:78](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L78)。v2 适配层明确硬检 `intent_id/idempotency_key` 非空；不能误称它已验证所有 provenance 的 ULID/hash 格式及事实真实性。caller 应按契约填全、保存并保证真实性。依据：[src/svc_v2.rs:1468](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L1468)、[src/svc_v2.rs:1497](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L1497)。

v2 **没有 quantity、side、max_position_notional 等可用输入字段**；其中若干 wire 字段已 reserved。方向从 action 派生，quantity 留空后由 OMS/风控生成。不能向请求额外塞这些字段期待生效。依据：[proto/execution_engine_v2.proto:78](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L78)、[src/svc_v2.rs:1521](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L1521)。

### 2.2 最小完整 JSON 模板

下例使用 proto 原字段名，64 位整数用十进制字符串表达。后续客户端加载 proto 时须统一字段命名/64 位数处理，不可混用 snake_case 和 camelCase。所有 `<...>` 动态量必须在调用前替换；这不是可原样发送的成功录制。

~~~json
{
  "credential_id": "9001",
  "run_mode": "demo",
  "intents": [
    {
      "bot_uid": "demo_btc",
      "run_id": "<RUN_ID>",
      "cycle_id": "<CYCLE_ID>",
      "idempotency_key": "<STABLE_OPEN_KEY>",
      "client_order_id_short": "<UNIQUE_SHORT_CLIENT_ID>",
      "exchange": "binance",
      "market_kind": "futures",
      "symbol_key": "binance|futures|BTC|USDT|USDT",
      "action": "open_long",
      "order_type": "market",
      "limit_price": "",
      "reduce_only": false,
      "intent_id": "int_<ULID>",
      "max_slippage_bps": 15,
      "protection": {
        "required": true,
        "stop_loss_price": "<SL_DECIMAL>",
        "take_profit_price": "<TP_DECIMAL>",
        "confirm_timeout_ms": 5000,
        "schema_version": 1
      },
      "policy_version": "risk_policy_v3",
      "valid_until_ms": "<SEND_TIME_MS_PLUS_30000>",
      "config_hash": "<64_LOWER_HEX_CONFIG_DIGEST>",
      "prompt_hash": "sha256:<64_LOWER_HEX_PROMPT_DIGEST>",
      "code_commit": "1986eac011badfa268be9e2e7f9667e024fd046c",
      "schema_version": 1
    }
  ],
  "data_snapshot": {
    "snapshot_id": "snap_<32_LOWER_HEX>",
    "quality_gate": "pass",
    "allow_open": true,
    "allow_close": true,
    "created_at_ms": "<SNAPSHOT_SOURCE_TIME_MS>",
    "schema_version": 1
  },
  "schema_version": 1
}
~~~

填值与有效前提：

- 每轮生成新的 run/cycle/intent 及业务幂等身份；同一写请求结果未知时保留原身份并读回，不更换身份盲目重发。client_order_id_short 应是交易所允许的短标识；内核自动生成的保护单另有自己的身份。
- config_hash 是实际配置的稳定 SHA-256，小写 64 hex；没有提示词的 demo 也可记录固定空输入的 SHA-256，并显式加 `sha256:` 前缀。code_commit 是本示例固定的代码指纹；后续 caller 应说明它代表哪个版本，并在录制里同时保留 caller 和 kernel 版本。
- `snapshot_id` 必须严格为 `snap_` 加 32 个小写 hex；quality_gate="pass"、allow_open=true、allow_close=true 必须一致。内核只消费这份决策，不查询 caller 的完整快照；当前 mapper 不用 created_at_ms 验证快照年龄。caller 必须保存真实来源及时间，不能靠填 true 伪造质量。依据：[src/risk.rs:36](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/risk.rs#L36)。
- caller 可从 vNext `bar_closed` 事件的 payload_json 中取得 close/closeTs 等公开行情事实作为计划输入；字节字段须解析成 JSON。市场单的**最终风控参考价**则由内核读取新鲜的交易所标记价，不能用 limit_price 冒充。依据：[src/market_data.rs:1577](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/market_data.rs#L1577)、[src/svc.rs:2631](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2631)、[src/risk.rs:819](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/risk.rs#L819)。
- SL/TP 必须由当前价格和合约 tick 约束计算，不能抄测试里的 100/95/111 作为当前 BTC 价格。仅作公式示意：若可靠参考 P=100000，可考察 SL=99000、TP=102500；这是 1% 止损距离、2.5 的 RR，**不是当前报价或保证被接受的订单参数**。实际时刻价格变化、交易所过滤器或其他准入仍可使请求被拒。
- 默认策略要求 typed protection，止损距离下限 0.8%、上限 6%，RR 至少 2，max_slippage_bps 上限 15，策略最低名义额 10 USDT；实际交易所过滤器可更严格。依据：[crates/risk-policy/policy/risk_policy_v3.json:14](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/crates/risk-policy/policy/risk_policy_v3.json#L14)、[src/svc.rs:2518](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2518)。
- 先取得真实账户/恢复/保护状态并发布第 6 节的预算。accepted 只表示入口受理或订单状态，不能当作已经成交；须继续读取成交及仓位真值。可借鉴现有请求形状，但这些用例是 paper 或替身交易所，并非真实测试网成交证据：[src/svc_v2.rs:3565](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L3565)、[src/position_close_tests.rs:82](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_close_tests.rs#L82)。

### 2.3 “最小仓位”不能等同于填写 quantity

当前风控起始数量按 `equity × 0.005 / (stop_distance × entry_price)` 计算，再受仓位/账户/敞口/保证金/交易所过滤器约束；默认单仓名义额上限为 1000 USDT。v2 没有公开的精确数量输入，也没有公开的改 policy RPC。可选预算字段 remaining_credential_notional_usdt 在当前映射中不是硬性下单上限，不能拿它伪装单笔限额，更不能伪造 equity 缩小下单量。依据：[crates/risk-policy/src/lib.rs:1025](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/crates/risk-policy/src/lib.rs#L1025)、[crates/risk-policy/policy/risk_policy_v3.json:29](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/crates/risk-policy/policy/risk_policy_v3.json#L29)、[src/risk.rs:579](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/risk.rs#L579)。

**不确定：**是否能仅靠现有公开 gRPC，在真实测试账户权益与过滤器下得到“交易所允许的最小 lot”。需甲方明确该要求是否可解释为“默认风控自动定量的小仓位”；若必须精确最小 lot，本基线尚无已证明的接口方案。实际数量及最小名义额必须在后续测试网验收中记录。

## 3. 保护单由谁挂

caller 在开仓意图中提供 typed Protection；内核持久化保护计划，在 entry 成交后生成并派发 SL/TP 子意图。caller **不再重复提交一组同义保护意图**。依据：[src/protection.rs:245](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/protection.rs#L245)、[src/svc.rs:1876](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L1876)；现有自动挂单/幂等例子：[src/svc_v2.rs:4157](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L4157)。

本演示要求两条保护，因此 SL 和 TP 都填写。内核的 `protected` 状态主要围绕确认的 SL 判定，已确认 SL 的分支可能直接返回；它不是“双保护都在交易所有效”的充分证据。SL 存在但 TP 缺失时，不能承诺当前恢复方法会自动补 TP。持仓步骤必须分别核对两张实际 Algo 保护单，见第 5 节。依据：[src/svc.rs:1881](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L1881)、[src/svc.rs:2064](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2064)、[src/svc.rs:2203](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2203)。

另一个接口边界：RPC 的 confirm_timeout_ms 会持久化，但真实 Algo ACK 后的确认定时器读取 `PROTECTION_CONFIRM_TIMEOUT_MS` 环境变量，默认 5000，限制在 1..60000 毫秒。示例统一使用 5000，不能承诺仅改 RPC 字段就能改变实际定时器。依据：[src/protection.rs:219](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/protection.rs#L219)、[src/protection.rs:17](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/protection.rs#L17)、[src/svc.rs:4391](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L4391)。

## 4. 平仓：精确 ClosePosition 与普通 reduce-only

### 4.1 正常演示优先精确平仓

使用 v2 三个 RPC。虽然 proto 留有“paper close”旧注释，**实现已支持 exchange-backed 的 demo**，不能只依据注释判为 paper-only。依据：[proto/execution_engine_v2.proto:18](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L18)、[src/position_close.rs:293](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_close.rs#L293)。

先读取最新目标：

~~~json
{
  "credential_id": "9001",
  "position_id": "<POSITION_ID>",
  "schema_version": 1
}
~~~

仅在 `GetPositionCloseTarget.available=true` 时，用刚返回的目标及 boot 构造 `ClosePosition`：

~~~json
{
  "credential_id": "9001",
  "position_id": "<TARGET_POSITION_ID>",
  "expected_revision": "<TARGET_REVISION>",
  "expected_boot_id": "<CURRENT_ENGINE_BOOT_ID>",
  "request_ref": "<CANONICAL_UPPERCASE_ULID>",
  "actor_member_id": "1",
  "schema_version": 1
}
~~~

主要前置条件：

- 目标有原 Entry provenance，且 credential、bot、symbol、direction、entry_epoch 逐字段相符；来源 Entry 订单已 filled。[src/position_close.rs:213](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_close.rs#L213)
- state 为 open/protected、revision>0、数量为有效正数；来源 run_mode 与当前 venue 合法且匹配。相同 credential+symbol+direction 不可共享另一活仓。[src/position_close.rs:237](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_close.rs#L237)、[src/position_close.rs:293](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_close.rs#L293)
- expected_boot_id、expected_revision 与当前值一致，同 scope 没有 pending close 或未终结 Entry。重启后必须重新取 target，不能沿用旧 boot/revision。actor_member_id 为正的 JS-safe 整数，request_ref 为规范 ULID。[src/position_close.rs:84](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_close.rs#L84)、[src/position_close.rs:558](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_close.rs#L558)
- 内核生成全目标数量的 reduce-only market exit；若过滤器取整后不再等于完整目标，拒绝 CLOSE_QUANTITY_NOT_EXACT。[src/position_close.rs:725](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_close.rs#L725)、[src/svc.rs:2825](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2825)

身份/成员授权仍由可信 caller 承担；不能把 actor_member_id=1 当作访客授权。本演示仅允许本机脚本/timer 调用这些写 RPC。

轮询 `GetPositionCloseReceipt` 使用同一 credential_id、request_ref、actor_member_id，schema_version=1。相同 request_ref 不能改变 position/revision/boot/actor；它绑定持久请求，不是生成新身份重试的开关。依据：[src/position_close.rs:575](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_close.rs#L575)、[proto/execution_engine_v2.proto:984](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L984)。

测试网成功判据至少为：

1. request_status="filled"，累计成交等于目标量；accepted/working/partially_filled/unknown 不是成功。
2. 当前 position_observation 为 observed，state=closed、quantity=0，且后续交易所同 scope 仓位为零。
3. protection_observation.status="cleaned"；cleanup_pending/unknown 仍未完成。
4. 再次全量对账确认零仓位、无普通挂单、无 Algo 挂单；不得只看普通挂单为空。

回执完成与保护清理是不同判据，依据：[src/position_close.rs:1250](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_close.rs#L1250)、[src/position_close.rs:1082](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_close.rs#L1082)、[proto/execution_engine_v2.proto:315](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L315)。

### 4.2 普通 v2 reduce-only 意图

复用第 2 节的身份/provenance 字段，改为 action="close_long"（对应原 long）、reduce_only=true、order_type="market"、limit_price=""，不提供开仓 Protection。保留原 bot_uid 和 symbol_key。close 不要求新的 data_snapshot、预算新鲜度或 promotion certification，但身份/venue/未知档位错误仍会阻塞。依据：[crates/risk-policy/src/lib.rs:534](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/crates/risk-policy/src/lib.rs#L534)、[crates/risk-policy/src/lib.rs:618](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/crates/risk-policy/src/lib.rs#L618)、[crates/risk-policy/src/lib.rs:656](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/crates/risk-policy/src/lib.rs#L656)、[src/svc.rs:834](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L834)。

它没有 position_id/revision/boot 绑定：OMS 通过 bot+symbol+direction 定位本地活仓并推导数量；无活仓时存在基于 credential-scoped 交易所投影的恢复分支，缺少权威数量仍会拒绝。不能把它称为“指定 position_id 的精确平仓”，也不能保证任意孤儿仓均可关闭。依据：[src/position_state.rs:357](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_state.rs#L357)、[src/position_state.rs:539](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_state.rs#L539)、[src/position_state.rs:627](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/position_state.rs#L627)、[src/svc.rs:2738](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2738)。

正常 demo 优先有独立回执的 ClosePosition；残留仓的精确目标不可用时，记录 reason_code，再决定受控清理方案。不能直接写数据库补造 Entry provenance。

## 5. 重启恢复机制与 caller 的完成判据

### 5.1 哪些公开 RPC 可以用

| 用途 | 使用的契约 | 注意 |
| --- | --- | --- |
| 开仓、精确平仓、预算、账户/仓位/保护投影 | execution_engine.v2 | 使用已实现的方法 |
| EnsureMarketData | execution_engine.vnext | v2 对应方法未实现 |
| GetOrder / GetOpenOrders / CancelOrder | execution_engine.vnext | GetOpenOrders 不能替代完整 Algo 真值观察 |
| EngineEvents.StreamEvents | execution_engine.vnext | 按 credential 的 seq 续接，并按 (seq,event_id) 去重 |
| 需要同步取得完整对账结果 | v2 ReconcileNow | vNext 版本仅回复 reconcile scheduled |

实现边界依据：[src/svc_v2.rs:1608](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L1608)、[src/svc_v2.rs:1673](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L1673)、[src/svc_v2.rs:3258](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L3258)、[proto/execution_engine_vnext.proto:9](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_vnext.proto#L9)、[src/svc.rs:5833](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L5833)。

行情订阅的最小请求（vNext）：

~~~json
{
  "credential_id": "9001",
  "subscriptions": [
    {
      "exchange": "binance",
      "market_kind": "futures",
      "symbol_key": "binance|futures|BTC|USDT|USDT",
      "timeframe": "1m"
    }
  ]
}
~~~

### 5.2 内核实际恢复什么

同一数据库中保留订单、持仓、保护计划、恢复域与游标。启动时从已持久化且身份已证明的 scopes/orders/fills 发现私有流恢复任务，并为持久活仓恢复管理对账；同时重建 required 行情订阅，继续保护善后义务。依据：[src/main.rs:484](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/main.rs#L484)、[src/main.rs:489](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/main.rs#L489)、[src/binance_user_stream.rs:187](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/binance_user_stream.rs#L187)、[src/binance_user_stream.rs:265](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/binance_user_stream.rs#L265)、[src/fill_replay.rs:220](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/fill_replay.rs#L220)。

内部成交恢复的顺序为 WS → REST 回补 → 对账 → generation/CAS 检查 → DeclareReady；只有这些阶段成功才设置 ready。持仓期间对账收敛要求 has_diff=false、local_position_zero_diff=true，不要求仓位/保护单为空。依据：[src/binance_user_stream.rs:962](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/binance_user_stream.rs#L962)、[src/fill_replay.rs:539](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/fill_replay.rs#L539)、[src/reconcile.rs:1443](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/reconcile.rs#L1443)。

恢复保护时读取交易所 Algo 真值：活跃单复用，已触发单绑定，未知状态停止，确认缺失才推进 generation 补单；失败可能触发 flatten。这里不能承诺自动修复所有 TP 缺失情况。依据：[src/svc.rs:2064](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2064)、[src/svc.rs:2203](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2203)、[src/svc.rs:2288](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2288)。

### 5.3 caller 在重启后的顺序

1. 保留运行时间线、原 position_id、保护计划对应身份、事件游标和数据库；等待 gRPC 可连接，恢复 vNext 事件订阅与行情订阅。不要重新发送旧开仓。
2. 调用 v2 ReconcileNow，检查 accepted/completed 和实际差异字段；该方法会进行全账户真值读取并检查已有保护计划。它没有 full_account=true 参数。返回 truth 的取得早于后续保护修复，不能把单次 completed 当成修复后的最新挂单清单。[src/svc_v2.rs:1306](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L1306)、[src/svc_v2.rs:1322](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L1322)、[proto/execution_engine_v2.proto:309](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L309)
3. 读取 v2 GetAccountState、GetPositionStates、GetAccountOrderState，确认同一仓位及数量、当前 boot 下的新观察，以及 SL/TP 各自的交易所证据。必要时再次对账后读取；这是观察恢复，不是重发开仓直到“成功”。
4. 按第 4 节重新取精确平仓 target，并在平仓后等待 cleanup 及完整零敞口证据。

GetAccountOrderState 的请求：

~~~json
{
  "credential_id": "9001",
  "max_items_per_section": 500,
  "schema_version": 1
}
~~~

首次响应取得 engine_boot_id 后，后续请求可附 expected_boot_id 绑定当前进程；重启后旧 boot 会得到 failed_precondition，须重新观察。依据：[src/account_order_read.rs:150](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/account_order_read.rs#L150)。

### 5.4 双保护不能只看 protected 或本地行

GetAccountOrderState 为被动只读：轮询它不产生交易所读取，也不刷新缓存。必须先有成功的**全账户对账**；启动前旧进程的内存快照不会跨重启成为新观察。可接受的 venue 观察至少满足：

- availability=AOA_AVAILABLE，latest_attempt.status="succeeded"，coverage="full_account"；
- ordinary/algo 两个 section 都为 AOC_COMPLETE_VENUE、overflow=false；源 capture 时间位于当前 boot 的有效窗口内且未过 30 秒；
- 对目标 position，local.protection_orders 中 sl/tp 各有当前 generation 的 matched 行，并具有 verified_projection=true；
- 分别用 exchange_algo_id/client_algo_id 与**同一轮 venue.algo.rows** 关联；identity_valid=true、symbol=BTCUSDT、类型分别为 STOP_MARKET/TAKE_PROFIT_MARKET、关闭方向/trigger_price/close_position 或 reduce_only 等详情足够且一致。

稳定持仓演示应看到两张 NEW 状态的保护单；TRIGGERING 是在途，不能展示为稳定持仓；已触发/未知/缺失按实际记录。未触发 Algo 可以没有 actual_order_id，不能因此误判失败。订单 last_verified_at_ms 可能取自交易所旧 updateTime，**不能要求其一定晚于重启**；判断新观察使用当前 boot 的捕获/源时间。依据：[src/account_order_observation.rs:157](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/account_order_observation.rs#L157)、[src/account_order_observation.rs:435](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/account_order_observation.rs#L435)、[proto/execution_engine_v2.proto:827](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L827)、[proto/execution_engine_v2.proto:878](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L878)、[src/protection.rs:91](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/protection.rs#L91)。

如果交易所响应或公开投影缺少身份、类型、触发价或关闭语义，结论是 **UNKNOWN／不足以通过双保护步骤**，不能用本地计划补成“交易所已证明有效”。如果 TP 丢失而 SL 仍在，记录失败/异常；不通过 caller 重复挂同义保护单掩盖问题。

### 5.5 空库首次启动的未决项

**不确定：如何仅用当前公开接口，在 fresh DB 第一次开仓前确定性建立并观察 Entry-ready，而不依赖一轮失败的开仓。**

依据：

- ReconcileNow 只运行对账或启动 reconciler；EnsureMarketData 只负责 kline。它们不是公开的私有 user-stream 启动接口。[src/svc_v2.rs:1306](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L1306)、[src/svc.rs:5883](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L5883)、[src/svc.rs:5907](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L5907)
- 启动发现依赖持久 scopes/orders/fills；空库没有这些记录。缺失 fill_stream_state 会按 not_started 拒绝 Entry。[src/fill_replay.rs:220](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/fill_replay.rs#L220)、[src/risk.rs:317](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/risk.rs#L317)
- 正常 ExecuteIntents 在风控前启动相关私有流，初始化是异步的，不能承诺首次只拒一次或首次必被接受。[src/svc.rs:2449](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc.rs#L2449)
- 当前公开 GetPositionStates 等响应没有 fill ready 位；没有可以凭空调用的 GetReady/EnsureUserStream RPC。不能把“账户可读、对账完成”替代该内部状态。[proto/execution_engine_v2.proto:353](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L353)、[src/fill_replay.rs:539](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/fill_replay.rs#L539)

本步骤不把 hold、假订单、写数据库、篡改 ready 或反复提交开仓当作已验证预热方案。若甲方接受首次真实运行如实 FAILED，后续**独立定时轮次**可以记录自然恢复后的结果；不得重试同一轮直至成功再隐藏先前失败。若要求全新环境首轮一定完整成功，则这个初始化接口缺口必须先确认。

## 6. PutRiskBudget 的最小有效内容与有效期

使用 v2 PutRiskBudget。虽然 proto 多数字段是 optional，当前处理器实际上要求九个账户事实字段；schema_version 示例显式给 1。

~~~json
{
  "credential_id": "9001",
  "as_of_ms": "<ACCOUNT_SOURCE_TIME_MS>",
  "equity_usdt": "<ACTUAL_EQUITY_DECIMAL>",
  "available_usdt": "<ACTUAL_AVAILABLE_DECIMAL>",
  "today_realized_pnl_usdt": "<ACTUAL_DAY_PNL_DECIMAL>",
  "today_realized_pnl_pct": 0,
  "drawdown_pct": 0,
  "total_exposure_pct": 0,
  "open_positions_count": "0",
  "schema_version": 1
}
~~~

后三个比例和 open_positions_count 中的零只表示**已证实空仓、无日收益/回撤的示例状态**，不是通用默认值。真实发送须替换成真实事实。

| 字段 | 当前有效性要求 |
| --- | --- |
| credential_id | 非空；预算按整个 credential 保存，不按 bot 或 symbol 分开 |
| as_of_ms | 正整数毫秒源时间，不是 HTTP/RPC 接收时间 |
| equity_usdt / available_usdt / today_realized_pnl_usdt | 必须显式提供有限十进制字符串 |
| today_realized_pnl_pct | 必须显式提供有限数，可负 |
| drawdown_pct / total_exposure_pct | 必须显式提供有限且非负的数 |
| open_positions_count | 必须显式提供非负整数 |

依据：[proto/execution_engine_v2.proto:489](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L489)、[src/svc_v2.rs:2612](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L2612)。比例采用小数，例如 0.03 表示 3%，与默认策略中的 0.03 日亏损上限一致。[crates/risk-policy/policy/risk_policy_v3.json:43](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/crates/risk-policy/policy/risk_policy_v3.json#L43)

以上是预算 RPC 的完整性要求，不是开仓许可。默认策略还要求权益至少 100 USDT，以及可用保证金、敞口、保护、行情与恢复状态等条件；真实账户不满足时应拒绝，不能调低或伪造账户事实来让示例通过。依据：[crates/risk-policy/src/lib.rs:1267](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/crates/risk-policy/src/lib.rs#L1267)。

group_exposure_json、remaining_credential_notional_usdt 和熔断描述可省，kill_switch_level 缺省为 none；**none 不会解除已经锁存的熔断**。前两项目前参与格式有效性检查，但未被映射成可以由 caller 直接设定的单笔/账户硬限额。不能把 RPC accepted 当成这项数值已经控制了下单规模。依据：[src/svc_v2.rs:2645](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L2645)、[src/risk.rs:579](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/risk.rs#L579)、[src/risk.rs:1088](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/risk.rs#L1088)。

有效期和发布策略：

- 默认 `RISK_BUDGET_MAX_AGE_MS=30000`；开仓时 `now_ms-as_of_ms > 30000` 才判过期，无独立 expires_at。close/hold 路径跳过这项开仓新鲜度规则。[src/risk.rs:122](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/risk.rs#L122)、[crates/risk-policy/src/lib.rs:656](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/crates/risk-policy/src/lib.rs#L656)
- 每 10 秒发布一次**真实新观察**。旧 as_of_ms 的更新不覆盖现行预算，响应可能 accepted=true 但 applied=false；必须检查响应。[src/svc_v2.rs:2699](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/svc_v2.rs#L2699)
- GetAccountState.available=false、缺失/过期行情或缺失账户事实时，不用零补齐后发布“新鲜预算”。as_of_ms 应来自保守的源时间，不能把陈旧事实改成 Date.now()。接口说明见 [proto/execution_engine_v2.proto:372](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L372)。
- GetAccountState 不直接返回 today_realized_pnl_pct、drawdown_pct、total_exposure_pct；caller 需要定义并持久保存日初权益/权益高水位等计算依据，并从账户持仓计算敞口。口径和历史缺失时的处理仍需在下一步实现前明确，不能伪造 0。[proto/execution_engine_v2.proto:372](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/proto/execution_engine_v2.proto#L372)、[src/risk.rs:633](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/risk.rs#L633)

## 7. 提交审核的未决事项

| 项目 | 当前结论／需要确认的内容 |
| --- | --- |
| 空库首次 ready | 不确定已有公开接口能否不依赖失败轮次完成初始化；需要确认是否接受如实保留初次 FAILED，或另行处理接口缺口。见 5.5。 |
| 最小仓位 | v2 自动定量，没有已证明的精确最小 lot 控制方案；不能把未消费的预算字段当限额。见 2.3。 |
| 双保护恢复 | protected 不能证明 TP；须独立观察两单，缺详情或 TP 缺失就 UNKNOWN/FAILED，不能伪造恢复成功。见 3、5.4。 |
| 预算派生口径 | 日初权益、高水位及重置后的历史缺失，需 caller 持久管理；测试网账户重置后不能延用旧事实。见 6。 |
| 账户侧前提 | 两个独立测试网账户、资金、实际持仓模式/杠杆与合约过滤器尚未实测；内核读取到的缺省杠杆 1 不代表它已经在交易所设置杠杆。依据：[src/risk.rs:893](https://github.com/svip2025/rustcore/blob/1986eac011badfa268be9e2e7f9667e024fd046c/src/risk.rs#L893)。 |

本调研没有把现有 paper/替身交易所测试当成真实 Binance 测试网演示。静态接口差异及集成限制已记在 [FINDINGS.md](../FINDINGS.md)，不改 rustcore 业务逻辑。

后续 caller 对外只读 DTO 还须移除凭证原值、Key/Secret、内部路径和主机信息；本文的内部 RPC 模板不能原样作为公网 HTTP/SSE 响应。失败轮次保留 FAILED 和原因，后续观察或内核自然恢复不应把它改写成一轮从未失败的成功记录。

**本步骤到此结束，提交甲方审核。审核通过后才进入下一步；若后续第 3 天结束仍未打通测试网链路，按任务包切换 paper 并在页面/README 如实注明。**
