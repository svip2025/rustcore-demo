# caller 风险预算口径

本模块只计算和持久保存预算依据，不下单、不启动定时器、不调用 gRPC。caller 集成时的循环每 10 秒读取账户/持仓，按结果决定是否调用 `PutRiskBudget`，并保存返回的内部事件 payload。HTTP、SSE、录制和正式时间线格式由共享数据契约负责；此模块不建立另一套公共 schema。

## 计算依据

- 按 `credential_id` 和**观察时刻所属的 UTC 日期**保存日初权益。日初指该日首次有效观测，不声称知道未观测到的 UTC 00:00 精确权益；同时保存真实源时间和首次观察时间。
- 首次有效权益或用户显式账户 reset，把日初权益及权益高水位都设为该次权益，返回消息 **“预算基准已重置”**。此前历史标记为 unknown，不能将这次定义的零差值说成完整当日实际收益为零。
- 正常 UTC 跨日只建立新日日初权益；权益高水位沿用，只有更高的有效权益才向上更新。用户显式 reset 才允许重置高水位。SQLite 保存 reset epoch、待处理 reset 和每日基准，重启不会自行重建或降低高水位。
- 有效账户权益已观察到时，即使稍后发现缺 mark/持仓过期而不发布预算，也保存该权益作为首次基准/高水位观察，避免丢失等待期间的第一份有效权益。

公式均按 credential 全账户范围计算：

| 派生值 | 口径 |
| --- | --- |
| `today_pnl_usdt` | 当前权益 − 本日首次观测权益 |
| 日收益比例 | `today_pnl_usdt / 日初权益` |
| 回撤比例 | `(权益高水位 − 当前权益) / 权益高水位` |
| 总敞口 | `sum(abs(qty) * 当前 mark_price)` |
| 总敞口比例 | `总敞口 / 当前权益` |

**日收益是权益变化的保守近似，包含未实现盈亏，也可能包含入金、出金及其他资金变化；它不等于交易所已实现收益。** 内核私有 RPC 请求保留 `today_realized_pnl_usdt`、`today_realized_pnl_pct` 字段名；公开投影分别映射为 `approximate_today_pnl_usdt`、`approximate_today_pnl_pct`，不对外称为精确已实现收益。比例采用小数（0.03 = 3%）。金额、数量、乘积、差值和持久值均通过 bigint 十进制文本运算；仅最终无量纲比例转成有限 JavaScript number。

caller 不以权益达到 100 USDT 为发布条件。有效低权益照实生成预算，交由内核裁决并记录实际拒绝原因。负权益及负分母按上述有符号公式计算，有限结果原样发布，不截断或伪造比例。分母为零时比例无定义，返回 `INVALID_RATIO`（`ratio denominator is zero`）而不发布预算，公开比例保持未知；例如首次权益为零会使日初/HWM分母为零，已有正基准但当前权益为零会使敞口比例分母为零。这是数学边界，不是新增权益政策。

## 事实和新鲜度门槛

发布必须同时满足：

1. `GetAccountState.available === true`，`as_of_ms` 为不晚于当前时钟的正整数，年龄不超过 30 秒；权益为有限十进制文本，可用余额字段也必须实际存在且有效。
2. 两个 RPC 使用同一 credential 的**完整账户范围**，不加 bot 筛选。空仓时两份 `positions` 必须显式为 `[]`；未知/缺失数组不推断为零仓位。
3. 每个非零持仓的 `GetPositionStates.last_reconciled_ms` 同样不超过 30 秒。按 symbol + direction 汇总本地数量，并与账户同 symbol + side 的数量一致；负数量按绝对值计算。孤儿持仓、数量/范围不一致、重复 mark 身份均不发布。
4. mark 取 `GetAccountState.positions[].mark_price`。**`GetPositionStates.entry_price` 不是实时 mark，绝不作为替代。** 非零持仓缺 mark、mark 非正或无对应账户行时不发布。live 返回缺少独立 mark 时间的旧协议时，用账户保守 `as_of_ms` 约束该 mark；若返回 `mark_truth.source_timestamp_ms`，也必须新鲜并纳入最老源时间。
5. 预算 `as_of_ms` 取账户、所有非零持仓和已提供 mark 真值的**最老源时间**，不使用 RPC 接收时间或发布时刻重新盖章。较旧的乱序账户观察不覆盖已记录权益历史。

持仓为零的行不贡献敞口；`closed` 却数量非零属于不一致事实。保留负的实际可用余额，不伪造为零或正数；内核仍会据真实事实执行准入判断。

## 集成接口（内部）

```ts
const calculator = new RiskBudgetCalculator(existingDatabaseSync);
const result = calculator.observe({
  credentialId,
  account: getAccountStateResponse,       // 原 gRPC snake_case 字段
  positionStates: getPositionStatesResponse,
  nowMs: Date.now(),
});
// events 只有 kind/message/details；由主流程映射并持久到正式 timeline。
// result.publish === false：记录 reason/message，不发布零值替代品。
// result.publish === true：把 result.budget 发给 PutRiskBudget。
// 对 RPC 的每次响应调用 calculator.recordPublishResponse(credentialId, response)。
```

`recordPublishResponse` 对每次 `accepted=true, applied=false` 返回 `budget_not_applied` payload，保留内核 `current_as_of_ms`；重复 10 秒发布也不会将“已接受但未应用”展示成成功更新。`accepted=false` 返回 `budget_rejected`。没有新源事实时，重复发布的 `as_of_ms` 保持原值。

显式账户 reset：调用 `requestReset(credentialId, nowMs)`；或在**一次明确用户操作**对应的 `observe` 中传 `reset: true`。不要在每次循环中持续传 true。reset 请求持久化，直到账户源时间不早于请求时间、且账户权益符合有效性条件后才消费；期间旧观察不发布。下一份有效权益重置日初/HWM并产生“预算基准已重置”事件。模块不根据余额骤增/骤降猜测交易所账户重置。

数据库由主 store 提供并管理生命周期；模块创建独立命名的两个内部表，使用 savepoint 原子更新，不关闭共享连接。持久化异常交给主流程记录失败，不能捕获后生成默认预算。内部 payload 中的 credential 只供主流程关联；公网投影仍须按共享契约脱敏。

运行对应测试：在仓库根目录执行 `npm test`，或 `npx tsx --test caller/test/risk-budget.test.ts`。测试使用 Node 22 内置 [`node:sqlite` / `DatabaseSync`](https://github.com/nodejs/node/blob/v22.23.4/doc/api/sqlite.md)，覆盖重启持久化、UTC 跨日、高水位/回撤、显式 reset、缺 mark/过期、低正权益、负权益有符号比例、零分母、负数量及未应用响应。模块没有新增外部 decimal 依赖。
