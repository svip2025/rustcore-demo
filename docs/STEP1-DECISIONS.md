# 第 1 部分：实现决策与当前边界

状态（2026-11-02）：第 0 步调研已获批，**真实测试网终端九步闭环已通过，只读 HTTP/SSE 也已通过实机验证**。前端接入和服务实机结果见 [CALLER-HANDOFF.md](CALLER-HANDOFF.md)，成功轮次与前五轮原始失败见 [TERMINAL-RUN.md](TERMINAL-RUN.md)。本页记录本轮获准的实现选择，不改写 [第 0 步源码研究](TESTNET-SETUP.md) 的固定证据。

## 常驻 caller 和本机命令

`scripts/start-caller.ts` 保持常驻，持有独立实例锁，并建立权限 600 的 Unix socket。`scripts/run-scenario.ts` 通过该 socket 发送一次 `MANUAL` 或 `SCHEDULED` 新轮次请求。socket 文件名为 caller 数据库文件名加 `.sock`，由同一服务用户访问。只读 HTTP/SSE 默认监听 `127.0.0.1:8787`，不提供 HTTP 场景触发或其他写入口；公网域名和反向代理留待部署步骤。

caller 启动时即只读检查账户设置，通过后启动并持有自己的 rustcore 子进程，以及行情订阅、事件续接、周期读取和每 10 秒预算发布，不等待手工触发场景。每轮结束或失败不停止常驻内核，以保留私有流和恢复状态。重启步骤只向自己 spawn 的子进程发送 SIGKILL，再以相同私有环境及同一内核数据库拉起；不能接管、搜索 PID 后杀进程，或影响其他服务。connect-only 模式的重启步骤明确失败。

单实例及单轮互斥使用 Linux 原生 `flock`。锁文件不删除，锁的有效期由打开的文件描述符决定；正常释放或持有 caller 进程死亡后由系统释放，不依赖可能过期的 PID 文件。

## 首轮失败、新轮次和恢复

F-01 是保留的集成限制：空库首次 `ExecuteIntents` 会异步启动私有流，但开仓准入可能仍因 `not_started` 等恢复未就绪原因被拒绝。不能通过直写内核数据库、隐藏失败或反复提交旧意图来把首轮变成成功。

获准做法是完整保存首轮 `FAILED` 及其原因，让常驻内核继续运行；用户可在本机明确发起新的 `MANUAL` 独立轮次，生成新的 round、cycle、intent 和幂等身份。它不是旧轮次的重试，旧失败不会覆盖。连接中断时先检查已持久时间线和交易所事实，不自动再发新开仓请求。重启后必须等待对账与账户事实，不能以 gRPC 在线替代恢复成功。

## 自动数量和独立保护

场景接受默认风控的自动计算数量，默认单仓名义额上限为 **1000 USDT**。不声称精确最小 lot，不用预算中的可选名义额字段假装已经约束订单，也不篡改实际 equity。保存实际成交量、成交均价和名义额；固定内核风险策略保持不变。

SL 输入规划采用同时满足真实 tick 的合法整数 USDT 网格，规避当前内核小数 SL 序列化尾差；仍按最终价格检查止损距离及 RR，并精确核对交易所触发价。此选择不放宽保护判据，处理经过见 [F-11](../FINDINGS.md#f-11小数-sl-的浮点尾差与交易所步长)。

`ExecuteIntents` 携带 typed Protection，由内核在成交后提交保护。caller 分别核验 SL 和 TP，同一次完整 Algo 快照、身份、数量及状态都必须可证；单个 `protected` 状态、SL 确认或 RPC ACK 不能代替 TP 证据。缺 TP 或详情不足时如实失败，不由 caller 增发 TP、不自行补挂。重启恢复同样独立核验两腿；精确平仓后还须确认持仓归零和保护单清理，`filled` 回执不能直接视为 `cleaned`。

## 账户与风险预算

账户所有者须手动设置 One-way、BTCUSDT 全仓、**1x**，并准备至少 100 USDT 测试网 USDT 钱包余额。前置检查仅签名 GET 持仓模式、positionRisk 和 account，不设置杠杆、不切换保证金或持仓模式、不下单。100 USDT 是场景手工准备前提，**不是预算发布门槛**；有效低权益预算照发，由内核返回真实拒绝。

日初权益为 UTC 当日首次有效观测；权益高水位持久化并跨日沿用。日收益是权益差值的近似，含未实现盈亏和资金变化，不称为交易所已实现收益。内部沿用内核 RPC 的 `today_realized_pnl_usdt/pct`，公开映射为 `approximate_today_pnl_usdt/pct`；缺历史、缺 mark、过期或零分母不能伪造比例。详细口径见 [RISK-BUDGET.md](RISK-BUDGET.md)。

## 配置、版本和实际结果

私有环境文件默认 `/etc/rustcore-demo/env`，可用 `--env` 指定。必须为权限 600 的普通文件，仅支持字面环境赋值，不执行 shell；不继承父进程中未经验证的 Binance 覆盖项。固定 `ENGINE_LIVE_ENABLED=0`、`ENGINE_STAGE_MAX=demo`、per-credential `testnet`，gRPC 仅 loopback，内核/caller 数据库分开。配置项以仓库 [.env.example](../.env.example) 为准；模板不含任何 Key 值。

每次实际构建分别读取 caller 和 submodule 的真实 Git 提交，填写 `DEMO_CALLER_COMMIT` 和 `DEMO_RUSTCORE_COMMIT`；`unknown` 不作为已验收版本。当前内核固定为测试网端点兼容提交 `6a81a4aec7ee92a9cd6aebdaef6446515ac2d989`，来自独立 [PR #2](https://github.com/svip2025/rustcore/pull/2)，不依赖浮动分支。第 0 步研究中的 `1986eac` 保留为历史源码基线。

成功轮次 `round_01M6ECFPAB9TS6H9Q46ATWP3JM` 使用 caller `d7c4d16ca72da9a1ab094f040fc1abea9a5edb21` 和上述内核提交，于 `2026-11-02T15:01:45.420Z` 至 `15:03:36.884Z` 完成九步 PASS：默认风控开多 0.0095 BTC、双保护分别通过、持仓、SIGKILL 后新 boot 恢复同一仓位数量、平仓及完整账户清理。实际账户已读回 One-way、全仓和 BTCUSDT **1x**；20x 是 [F-07](../FINDINGS.md#f-07真实只读检查与尚未满足的账户前提) 中的早期检查事实。

端点、对账和 caller 问题的原始失败及处理经过见 [F-07 至 F-12](../FINDINGS.md#f-07真实只读检查与尚未满足的账户前提)，不因后续成功改写旧轮次结果。

## 与前端及长期运行的边界

第一部分交付 `/api/health`、`/api/state`、`/api/timeline` 和 `/api/stream`，实机访问、禁写、CORS、SSE 以及脱敏结果已记录于 [CALLER-HANDOFF.md](CALLER-HANDOFF.md)。前端直接使用 [共享数据契约](DATA-CONTRACT.md)；SSE 的 data 是完整 envelope，带游标的重连先处理 `resync → state → timeline` 基线，再接实时事件。SL/TP 独立状态、UNKNOWN、失败历史及近似权益收益沿用共享语义。成功录制和五份真实失败录制已提供，网页接入、回放交互和自动回退属于第二部分。

第一部分要求场景只能由本机命令行或 systemd timer 触发，现有本机 CLI 与原生文件锁覆盖该边界。**每六小时运行的 systemd timer、48 小时至少八轮、生产部署和监控属于第三部分**，不是第一部分终端闭环的新增前提。
