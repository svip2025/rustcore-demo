# rustcore 第二轮 2A 前置开发与离线验证交接

本文件交付 S1–S5、F1–F4 的工程候选；不表示第一轮正式验收、不表示第二轮进入条件齐备，也不表示真实交易所验证或 48 小时测试通过。最终完整提交、PR 和实跑结果以同名工作区交接文件及 `result.json` 为准。

## 范围与第一轮保护

第一轮运行回执为 `20261104/heartbeat-20261104T0636Z/result.json`：caller `b0685624ca5eda34780541bae17f9aa3a7214fa5`、内核 `cdd7916458855375a4dfe5b543e8a47b2d75fc78`，attempt-003 为 RUNNING、acceptance_48h=null。本候选从这两个提交分别建立 `prep/round2-2a` 分支及独立 worktree，使用独立 caller/内核 SQLite、独立 loopback MySQL 13406 fixture；编译缓存共用已有 target。

没有访问或变更 VPS-A（sgft），没有接管原监控、修改服务、配置、依赖或账户。VPS-B 没有获得本次部署授权。原 caller `README.md`、`web/` 的未提交内容保留；候选消费者使用原 web 源的独立副本。没有合并 main 或打 tag。

不包含 SL-only、AmendProtection、合计风险、多品种/全链路定点小数、S6–S8、F6，亦不包含工单第 10 节研究。

## 实现及离线判据

| 项目 | 候选行为 | 离线验证与边界 |
| --- | --- | --- |
| S1/S5 | BTCUSDT 多/空，显式 SL/TP 比例、最长持仓；基线九步，保留失败及独立清理 | caller 真实 SQLite + RPC 模拟覆盖方向、配置拒绝、实际成交与重启；内核全量验证风控/恢复 |
| S2/S3 | 等待指定 SL/TP 成交，最长 30 分钟；必须有成交归因和 fresh full-account 零仓位/无挂单证据；超时 FAILED 后安全清理 | 多/空 × SL/TP 四组合在受控交易所与真库验证；UNKNOWN、不完整快照、另一腿先触发、残留 Algo 均不成功；真实触发仍待测试网 |
| 另一腿撤单 | 复用内核已有 `protection_cleanup`：先证明 venue-flat，再持久清理义务、撤剩余腿并核验；不靠交易所自动撤另一腿 | 原触发腿 FINISHED 保留；不再发开仓 POST；回滚、重复 sweep、UNKNOWN、部分撤单及重启恢复 |
| 测试 policy | 每条意图显式 `risk_policy_testnet_v1`，仅 demo + 明确 testnet；参数越界拒绝，不静默 clamp | 默认 v3 不改、不激活测试 policy；策略 guard、哈希、重放与 typed SL 一致性专项 |
| S4 | 结算前十分钟开、结算后十分钟平；完整资金流水 + 实际成交手续费 + 交易所 realized PnL 形成净损益 | 原始 income identity 私有落库、公开 ID 去敏；真实 MySQL 并发/回滚、SQLite 重启、重复与不完整查询；实际结算格式/发布时间待测试网 |
| F1/F2 | loopback TLS 代理转发指定 MARKET POST 后先扣住回报，再 SIGKILL caller 自己持有的 child handle；另行重启同库恢复 | 真进程 SIGKILL + TLS venue + gRPC + SQLite：原 client ID 查回、Entry 不重复、保护恢复或清理；未命中边界保留失败并 disarm，不跑确认轮 |
| F3 | DNS 只解析官方测试网 API/WS 地址；每次独立链、仅目标地址 TCP/443；先设 systemd 定时删除，再写规则；finally 清理并核验无链/跳转 | 命令顺序/失败/部分安装/双栈/SSH peer 排除有测试；真实 IPv4/IPv6 规则及删除在隔离容器网络中通过；该验证的 timer 是 stub，真实特权 timer 与 60/300 秒断网待测试机 |
| F4/F-15 | 主动关闭 active reader 或向真实 reader 注入合法 listenKeyExpired；先降 ready，再走正常补账/重连 | 测试网、demo、live 关闭、显式开关四重守卫；原合法失效事件忽略已 RED→GREEN；真实 key 到期仍待测试网 |
| 观测 | 启动相对小时采样 RSS、DB 主文件/WAL/SHM、三类 WS 总重连/最近分钟、caller 对交易所时钟偏差及往返不确定度 | 缺值 null + 原因码；内核进程 generation 去敏标识防 PID 复用/混淆重启；WS connection ledger 持久跨重启，初次连接不计重连 |
| 录制/回放 | producer v2，必须有 scenario/metrics；消费者支持冻结 v1 与 v2；旧版本补 null，不臆造旧场景/费用 | 原 v1 录制不改写，拒绝未知或混合版本；原 FAILED/UNKNOWN 与自由文本去敏规则保留 |
| 调度 | 绝对时点 + 独立 SQLite 认领；错过/忙碌不补跑，不重发同 slot，不覆盖原失败；可切回 baseline | 双 owner、重启/重载、并发 tick、IPC 失败、真实 Unix socket 和新 Node 进程验证 |

`protection_confirmation_ms` 是从 Entry RPC 发出到两腿独立证明的保守上界；精确 venue 时延还须对照源事件和钟差。保护触发的 60 秒判据从成交源时间计算，不能用迟到的 REST 回补接收时间重新计时。费用缺失、成交量未闭合、资金窗口不完整均为 UNKNOWN，不能填零。权益直接使用交易所余额（本来已含资金费），不重复加 ledger。

## 契约与 policy

- 公共 HTTP/SSE/新录制 `schema_version: 1 → 2`；`shared/schema-v1.ts` 保留冻结原型，`shared/replay.ts` 生成消费视图，不改历史 JSON。新增 scenario、metrics、逐笔去敏 funding entries。公开字段不含 credential_id、UID、listenKey、原始 tranId、内部日志或私有路径。
- v2 内核 RPC 消息 schema 仍为 1，新增 `GetFundingHistory`、`GetRuntimeDiagnostics`、`InjectUserStreamFault`，与公共录制版本分别管理。
- `risk_policy_testnet_v1` canonical hash 为 `sha256:9cca4ac1aee4b3e02460ad14cc5844b370f910e1bffbe0e8ff3e89b8ac703ff3`。仅 min_stop_distance_pct=0.0015、min_rr=0.05、cost_aware_tp_multiple=1；0.5% 风险预算、15% 单品种权益与 1000 USDT 上限等沿用 v3。
- 只有测试 policy 保留已校验的 typed SL 原字符串，避免 f64 尾差推高一个 tick；这项 2A 窄修复没有完成 F-11 所涉及的全链路定点小数，也没有放行 S6。
- 内核新增迁移 `0047_exchange_funding_ledger.sql`；只用于候选库。资金页饱和时二分闭区间，最多 63 次读取，单毫秒仍饱和或前后记录不一致即拒绝完整结论。用户侧逐笔核对从私有 ledger 原 tranId → RPC opaque ID → caller funding public ID 映射进行。

## 2A 排期与切回

T0 必须是第一轮复盘与下一阶段开跑条件通过后，由负责人另行指定的 UTC 毫秒时间；本 goal 不选择正式开跑时刻。

1. 0–2h：S1、S1、S5、S2，正常轮次至少间隔 30 分钟。
2. 2–24h、30–48h：S1、S5、S2、S3 循环；S2/S3 分别按实际已认领轮次多空交替。S4 在北京时间 00/08/16 点前十分钟插入，其前后不足 30 分钟的普通 slot 不安排；S4 整段持仓若与 24–30h 故障段相交则不安排。上一轮未结束不开新轮，最近 MANUAL 轮也参与后续正常自动轮的 30 分钟间隔判定。2A 不安排 S6/S8。
3. 24–30h 暂停其他自动场景。八组依次为 F1、F2、F3(60s)、F4(disconnect)、F1、F2、F3(300s)、F4(expiry，S2 等待模式)。每组独立 MANUAL 故障轮，恢复完整账户干净后**立即**新建 MANUAL S1。按负责人 2026-11-04 澄清，同组两轮不受 30 分钟限制；组与组开始间隔至少 30 分钟。八组约四小时，故障段仍六小时，48h 总时长不变。若组未清理/确认，自动调度继续阻断。
4. 全程每小时采样；采样 timer 每分钟醒来检查启动相对小时的持久认领，不重复采同一小时。超过五次/分钟必须按三种 WS 各自的完整 connection ledger 查询，不能只凭某小时采样的最后一分钟排除中途尖峰。RSS 按进程 generation 区分，重启不能被当成同一进程内存下降。
5. 48h 后停止 2A dispatcher/sample timer，scheduler 切 baseline，再恢复原 `scenario.timer`：UTC 00/06/12/18 四轮、Persistent=false。保留 schedule DB、全部失败/UNKNOWN/录制，不重新使用已认领 slot 或 reset 原 attempt。

## 下一阶段外部条件及待测试网实测

需要一台**另行明确授权**的测试 VPS（与第一轮 VPS-A 隔离；VPS-B 不默认获准）、独立工作目录/数据库/端口、一只专用 USDⓈ-M 测试网账户，One-way、BTCUSDT cross/1x、满足只读 preflight 的测试资金。2A 不需要 S8 的第二账户。凭证由负责人在测试机私有 0600 环境中配置，不贴聊天、不写公开产物。保持 ENGINE_LIVE_ENABLED=0、ENGINE_STAGE_MAX=demo，测试网 IP 白名单及禁止提现权限。

F1/F2 需要 child 模式和仅测试机生成的本地 TLS 证书（127.0.0.1 SAN、私钥600）；F3 需要测试机上的 iptables/ip6tables、systemd-run 及受限 sudo。故障段需要有人值守，可访问 SSH/控制台，能查看 private receipt 与完整账户快照。真实网络防护和 cleanup timer 必须先在该测试机用只读/无交易演练确认，再运行持仓故障场景。

尚未执行，必须在下一阶段逐项验真：

- S1/S5 真正多空九步与恢复，测试 policy 的准入值/计划价/交易所 tick 精确一致。
- S2/S3 交易所实际触发一腿、源时间、60 秒识别 flat/撤另一腿、全账户普通/Algo 无残留；超时保留 FAILED。
- S4 资金结算真实时间、原始流水字段、分页/发布延迟、有符号金额逐笔核对及权益不重复加算。
- F1/F2 真实交易请求边界、查回幂等、UNKNOWN/部分成交及五分钟内干净；模拟证明不代替此项。
- F3 测试机 DNS、IPv4/IPv6、SSH 不受影响、60/300s 断网 UNKNOWN/禁止新开仓、独立 timer 在工具退出后仍清除规则、结束核验及 S1。
- F4 实际断流/真实 key 到期与模拟失效分开记录；断流期间真正 SL 触发、REST 补事件及另一腿清理。
- 48h RSS、数据库增长、全部 WS 重连尖峰、时钟偏差及每条红线，不能把离线通过替代长时稳定性。

## 明确的开跑步骤（仅供下一阶段获授权后执行）

1. 原 session 完成第一轮汇总/失败账户清理/保护窗口复盘并正式验收；负责人确认 2A 所需外部条件。工单含 2B 的原始进入清单不因本候选自动勾完。
2. 测试机只检出两个候选完整提交，caller 的 rustcore submodule 必须等于候选内核；构建并读回版本与二进制 SHA256，另设 DEMO_CALLER_COMMIT、DEMO_RUSTCORE_COMMIT 为实际完整哈希。建立全新 kernel/caller/scheduler 数据库，不复制第一轮账户数据库或修改其环境。
3. 私有环境明确设置 DEMO_KERNEL_MODE=child、DEMO_ROUND2_FAULTS=1、DEMO_FAULT_TLS_KEY、DEMO_FAULT_TLS_CERT、独立 proxy/HTTP/gRPC 端口。使用 `scripts/start-caller.ts --env <private-env>`；对照 docs/DATA-CONTRACT.md 检查只读页面来源及版本，先完成获授权测试网的短冒烟和上述待实测清单。
4. 生成并检查排期：`node --import tsx scripts/run-round2.ts --action plan --start <T0 UTC ISO>`。切换前确认该测试机没有 active round；停用其 baseline scenario.timer，仅在此测试机安装 candidate 的 round2-dispatch、round2-sample 单元。
5. `node --import tsx scripts/run-round2.ts --action activate --state <new-scheduler.db> --start <T0 UTC ISO> --env <private-env>`。启用该测试机的两只候选 timer。绝对时间 slot 不 bootstrap、不补历史轮次；MISSED/BUSY/UNKNOWN 保留。正式 T0 的首个执行证据必须实际读回，不根据 enable 命令推测开跑。
6. 24–30h 值守者逐组运行 `node --import tsx scripts/fault-round2.ts --test-vps-ack --group <1..8> --state <scheduler.db> --env <private-env>`。命令保留原故障轮结论，再证明 clean、立即发独立 S1；出错不确认、不重发 Entry、自动调度继续阻断。F3 的独立 cleanup receipt 必须为 VERIFIED；边界未命中的故障不计为已验证。
7. 到48h只停止下一阶段这台测试机的候选timer，执行 `run-round2.ts --action restore --state ... --env ...`，恢复原 calendar timer。独立读取下一触发时点；保留所有原轮次、scheduler、fault receipts、私有 snapshots、资金 ledger、每小时 samples，按工单红线与阈值作真实汇总。不要改写失败、清空额度或数据库、重新计时冒充原窗口通过。

## 测试证据索引

本地统一目录：`rustcore-round2-2a-evidence/20261104/`。`intake.json` 固定原回执、边界与原工作区指纹；`result.json` 记录最终候选完整提交/PR/命令退出码与测试计数；`evidence-index.json` 索引最小证明文件及 SHA256。RED、首次编译/fixture/全量失败、最终 GREEN 分别保留，helper 子进程不重复计入顶层测试数量。CI 仅在最终候选 head 的实际成功后计为通过。

关键专项：`policy-red.log`、`f15-listenkey-red-clean.log`、`caller-s5-red.log`、`caller-recovery-cancel-red.log`；`kernel-round2-green-3.log`（F1/F2 真 SIGKILL）、`protection-feature-green-1.log`（多空×触发腿）、`diagnostics-*-ws.log`（三类本地真实 WS 接线）；最终 kernel/caller 全量、fmt/clippy、真实 MySQL、录制/回放/web、调度/故障CLI、F3规则与systemd单元证据见结果索引。
