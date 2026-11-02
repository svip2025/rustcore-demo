# 第 1 部分：实现决策与当前边界

状态（2026-11-02）：第 0 步调研已获批，caller 终端链路正在实现和验证；**尚无一轮真实测试网完整场景通过**。本页记录本轮获准的实现选择，不改写 [第 0 步源码研究](TESTNET-SETUP.md) 的固定证据。

## 常驻 caller 和本机命令

`scripts/start-caller.ts` 保持常驻，持有独立实例锁，并建立权限 600 的 Unix socket。`scripts/run-scenario.ts` 通过该 socket 发送一次 `MANUAL` 或 `SCHEDULED` 新轮次请求；现阶段只先做终端，没有公网 HTTP/SSE 服务或写入口。socket 文件名为 caller 数据库文件名加 `.sock`，由同一服务用户访问。

首次场景的只读前置检查通过后，caller 启动并持有自己的 rustcore 子进程。每轮结束或失败不停止常驻内核，以保留私有流和恢复状态。重启步骤只向自己 spawn 的子进程发送 SIGKILL，再以相同私有环境及同一内核数据库拉起；不能接管、搜索 PID 后杀进程，或影响其他服务。connect-only 模式的重启步骤明确失败。

单实例及单轮互斥使用 Linux 原生 `flock`。锁文件不删除，锁的有效期由打开的文件描述符决定；正常释放或持有 caller 进程死亡后由系统释放，不依赖可能过期的 PID 文件。

## 首轮失败、新轮次和恢复

F-01 是保留的集成限制：空库首次 `ExecuteIntents` 会异步启动私有流，但开仓准入可能仍因 `not_started` 等恢复未就绪原因被拒绝。不能通过直写内核数据库、隐藏失败或反复提交旧意图来把首轮变成成功。

获准做法是完整保存首轮 `FAILED` 及其原因，让常驻内核继续运行；用户可在本机明确发起新的 `MANUAL` 独立轮次，生成新的 round、cycle、intent 和幂等身份。它不是旧轮次的重试，旧失败不会覆盖。连接中断时先检查已持久时间线和交易所事实，不自动再发新开仓请求。重启后必须等待对账与账户事实，不能以 gRPC 在线替代恢复成功。

## 自动数量和独立保护

场景接受默认风控的自动计算数量，默认单仓名义额上限为 **1000 USDT**。不声称精确最小 lot，不用预算中的可选名义额字段假装已经约束订单，也不篡改实际 equity。保存实际成交量、成交均价和名义额；固定内核风险策略保持不变。

`ExecuteIntents` 携带 typed Protection，由内核在成交后提交保护。caller 分别核验 SL 和 TP，同一次完整 Algo 快照、身份、数量及状态都必须可证；单个 `protected` 状态、SL 确认或 RPC ACK 不能代替 TP 证据。缺 TP 或详情不足时如实失败，不由 caller 增发 TP、不自行补挂。重启恢复同样独立核验两腿；精确平仓后还须确认持仓归零和保护单清理，`filled` 回执不能直接视为 `cleaned`。

## 账户与风险预算

账户所有者须手动设置 One-way、BTCUSDT 全仓、**1x**，并准备至少 100 USDT 测试网 USDT 钱包余额。前置检查仅签名 GET 持仓模式、positionRisk 和 account，不设置杠杆、不切换保证金或持仓模式、不下单。100 USDT 是场景手工准备前提，**不是预算发布门槛**；有效低权益预算照发，由内核返回真实拒绝。

日初权益为 UTC 当日首次有效观测；权益高水位持久化并跨日沿用。日收益是权益差值的近似，含未实现盈亏和资金变化，不称为交易所已实现收益。内部沿用内核 RPC 的 `today_realized_pnl_usdt/pct`，公开映射为 `approximate_today_pnl_usdt/pct`；缺历史、缺 mark、过期或零分母不能伪造比例。详细口径见 [RISK-BUDGET.md](RISK-BUDGET.md)。

## 配置、版本和当前阻塞

私有环境文件默认 `/etc/rustcore-demo/env`，可用 `--env` 指定。必须为权限 600 的普通文件，仅支持字面环境赋值，不执行 shell；不继承父进程中未经验证的 Binance 覆盖项。固定 `ENGINE_LIVE_ENABLED=0`、`ENGINE_STAGE_MAX=demo`、per-credential `testnet`，gRPC 仅 loopback，内核/caller 数据库分开。配置项以仓库 [.env.example](../.env.example) 为准；模板不含任何 Key 值。

每次实际构建分别读取 caller 和 submodule 的真实 Git 提交，填写 `DEMO_CALLER_COMMIT` 和 `DEMO_RUSTCORE_COMMIT`。当前内核 pin 为 `1986eac011badfa268be9e2e7f9667e024fd046c`；caller 尚无初始提交，`unknown` 必须明确视为草稿，不能伪造发布指纹。

已知阻塞见 [F-07](../FINDINGS.md#f-07真实只读检查与尚未满足的账户前提)：旧测试网入口首个只读请求返回 418 / `-1003`，未重试；新官方入口三项读取成功，确认 One-way、全仓、空持仓及资金，但 BTCUSDT 当前为 20x。用户需手动改为 1x；端点兼容通过独立获授权的内核 PR 处理，不直接改当前 pin，不切换主网。只读成功不能替代下单、双保护、重启恢复或平仓的真实验收。
