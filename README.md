# rustcore-demo

Binance USDⓈ-M 期货测试网演示：通过 [rustcore](https://github.com/svip2025/rustcore) 的公开 gRPC 接口执行开仓、双保护、持仓、重启恢复和平仓，并保存每一步的真实结果。仅测试网，非金融软件。

**当前：第 0 步调研已获批，第 1 部分 caller 正在完成终端链路；真实完整场景尚未通过。** 已真实完成开仓、精确平仓和保护清理；双保护观察不足的轮次保持 FAILED，尚未验证持仓重启恢复。三份真实失败录制均保留，详见 [F-08 至 F-10](FINDINGS.md#f-08首轮-caller-对账期限与额外限流配置不匹配)。公网 HTTP/SSE 服务尚未实现，另两份 `MOCK` 录制是手写假数据，不能作为交易或恢复证据。

2026-11-02 的真实只读检查中，内核旧测试网入口返回 HTTP 418 / `-1003`，已停止请求；当前官方入口的账户读取成功。账户所有者调整后，BTCUSDT 和 ETHUSDT 均已读回全仓、**1x**、单向持仓。内核端点兼容由单独授权的 [rustcore PR #2](https://github.com/svip2025/rustcore/pull/2) 处理，演示固定其具体提交，不依赖浮动分支；完整测试网场景仍待终端验证。见 [FINDINGS F-07](FINDINGS.md#f-07真实只读检查与尚未满足的账户前提)。

## 本机使用

需要 Linux、Node 22.13–22.x、`flock`（util-linux）、POSIX `sh`/`cat`，以及内核固定的 Rust 工具链。

```sh
git submodule update --init --recursive
npm ci
cargo build --locked --release --manifest-path rustcore/Cargo.toml
install -d -m 700 "$HOME/.config/rustcore-demo"
install -m 600 .env.example "$HOME/.config/rustcore-demo/env"
```

在该私有文件中填写独立测试账户的 Key/Secret，并把内核程序、两个独立数据库和锁文件改为本机可用的绝对路径。`9001`、`9002` 是本地示例 ID，不是交易所 UID。环境文件默认位置是 `/etc/rustcore-demo/env`；下面通过 `--env` 指定本机文件。只解析字面 `KEY=VALUE` 或双引号文本，不执行 shell，不展开变量；文件必须为权限 600 的普通文件，不能是符号链接。

构建指纹分别读取两个仓库的实际提交：

```sh
git rev-parse HEAD
git -C rustcore rev-parse HEAD
```

将输出分别填写到 `DEMO_CALLER_COMMIT`、`DEMO_RUSTCORE_COMMIT`。当前集成内核固定为端点兼容提交 `6a81a4aec7ee92a9cd6aebdaef6446515ac2d989`（独立 PR，未合并）；示例中的 `unknown` 表示未指定构建，运行前必须填写实际 caller 提交，不能作为已验收构建的指纹。

一个终端保持 caller 常驻：

```sh
npm run caller -- --env "$HOME/.config/rustcore-demo/env"
```

另一个终端发起一次独立场景：

```sh
npm run scenario -- --env "$HOME/.config/rustcore-demo/env" --trigger MANUAL
```

`start-caller` 持有单实例锁，并提供权限 600 的本地 Unix socket；`run-scenario` 只通过该 socket 请求新轮次，没有公网写入口。socket 位于 caller 数据库文件名加 `.sock`。首次前置检查通过后，常驻 caller 启动并持有自己的内核进程；`caller_ready` 仅表示本机控制通道就绪。场景失败后常驻进程继续运行，不因一轮失败停止内核。`--connect-only` 可连接外部内核，但重启步骤会明确失败，不接管或杀掉外部进程。

每轮逐步保存预期、实际、`PASS/FAIL/UNKNOWN` 和原因；失败保留为 `FAILED`，不自动重试开仓。同一轮不能重做失败步骤。F-01 已知的空库私有流 `not_started` 可能使首次开仓失败；保留该轮、让常驻内核继续运行，经本机明确操作可创建新的 **MANUAL 独立轮次**，使用新的身份，不能隐藏首次失败或重发旧意图。

结束的成功或失败轮次会自动导出录制；也可明确导出指定轮次：

```sh
umask 077
npm run --silent export:recording -- --env "$HOME/.config/rustcore-demo/env" --round ROUND_ID > run.json
```

## 场景口径

- 数量由默认风控自动计算，默认单仓名义额上限 **1000 USDT**；不声称精确最小 lot，不伪造账户权益来缩量。时间线保存实际成交数量和名义额。
- 账户所有者须手动设置 One-way、BTCUSDT 全仓、1x，并具备至少 100 USDT 的测试网 USDT 钱包余额。只读前置检查不会替用户设置账户；该场景前提与预算发布逻辑不同，真实低权益预算仍照发，由内核裁决。
- SL 与 TP 分别核验，同一次完整交易所快照才能证明双保护；`protected` 不等于 TP 有效。缺失或无法证明则如实失败，不由 caller 自行补挂。重启恢复也须分别证明；平仓成交回执不等于保护单已清理。
- 日收益使用权益变化的近似值，可能包含未实现盈亏和资金变化；公开字段为 `approximate_today_pnl_*`。跨日高水位、首次/reset 基准与新鲜度见 [风险预算口径](docs/RISK-BUDGET.md)。

实现决策见 [STEP1-DECISIONS.md](docs/STEP1-DECISIONS.md)，固定源码调研见 [TESTNET-SETUP.md](docs/TESTNET-SETUP.md)，共享 HTTP/SSE/录制契约见 [DATA-CONTRACT.md](docs/DATA-CONTRACT.md)。契约已定义不代表 HTTP 已上线。

本地工程检查：`npm run typecheck`、`npm test`、`npm run check:recordings`。这些检查不证明测试网完整场景、长期运行、主网交易或盈利能力。
