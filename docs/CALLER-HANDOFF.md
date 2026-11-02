# 第 1 部分交付与前端对接

2026-11-02，VPS-A 的真实终端九步场景和只读 HTTP/SSE 均已通过。前端使用已冻结的 [shared/schema.ts](../shared/schema.ts)，规则见 [DATA-CONTRACT.md](DATA-CONTRACT.md)；不需要新增或改名公开字段。

## 对接入口

测试机 `ssh sgft` 上 caller 只监听 `127.0.0.1:8787`。本地开发可在独立终端保持 SSH 转发，再由前端开发服务器将 `/api` 同源代理到 `http://127.0.0.1:8787`：

```sh
ssh -F /home/debian/.ssh/config -o ExitOnForwardFailure=yes -N \
  -L 127.0.0.1:8787:127.0.0.1:8787 sgft
```

如果本地 8787 已被占用，可只改转发参数左侧端口及开发代理目标。若开发代理转发了浏览器 Origin，或浏览器直接跨域访问转发端口，须在私有 caller 配置中显式设置 `DEMO_PUBLIC_ORIGIN` 为前端的精确 origin 后重启 caller。同源部署时浏览器使用相对路径 `/api/*`。不要放宽为通配跨域。只有代理明确覆盖 `X-Real-IP` 时才能启用 `DEMO_TRUST_PROXY=1`。

| 请求 | 用途 |
| --- | --- |
| `GET /api/health` | HTTP 与内核/账户依赖健康；保留各事实状态及 `snapshot_complete` |
| `GET /api/state` | 完整公开状态，包含 source、caller/kernel build、独立 SL/TP、预算与最近一轮 |
| `GET /api/timeline?limit=20` | 最新轮次在前；后续页使用响应中的 `next_cursor` |
| `GET /api/stream` | SSE；`data` 是完整的共享 `SseEvent`，不是单独的 data 成员 |

首次 SSE 发送 `state → timeline`，随后为实时事件；任何携带 `Last-Event-ID` 或 `since_event_id` 的重连均先发 `resync → state → timeline`。SSE 的 `id` 等于 JSON 的 `event_id`，`event` 等于 JSON 的 `type`。客户端收到 `resync` 后用新基线替换缓存。无需实现历史增量拼接。

事实为 UNKNOWN、PARTIAL 或过期时按契约显示原因；服务 healthy 不代表双保护通过。SL 与 TP 分开显示。每轮保留 `trigger`，MANUAL 与 SCHEDULED 不混淆。接口只有读取，网页没有运行场景的写入口。所有非 GET 请求返回 405，默认每 IP 每分钟 120 次请求。

## 可直接使用的录制

- 真实成功：[run-20261102-150145-succeeded.json](../recordings/run-20261102-150145-succeeded.json)，九步 PASS，包括新 boot 下持仓及原 SL/TP 的恢复证明。
- 真实失败：另五份 `run-*-failed.json`，索引与原因见 [TERMINAL-RUN.md](TERMINAL-RUN.md#保留的五轮失败)。失败轮次已在在线时间线中保留。
- 手写假数据：[mock-success-v1.json](../recordings/mock-success-v1.json)、[mock-failure-v1.json](../recordings/mock-failure-v1.json)，source 明确标记 MOCK，用于开发回放。

录制的 caller build 是该轮真实运行版本；当前在线 API 的 build 可以更晚，不能拿当前提交覆盖历史指纹。

## 实机接口验证

检查完成时间：`2026-11-02T15:49:56.649Z`。该次在线 caller 为 `2e252f78624711be7c1ac0a03591da2476ba5286`，内核为 `6a81a4aec7ee92a9cd6aebdaef6446515ac2d989`。端点兼容 [PR #2](https://github.com/svip2025/rustcore/pull/2) 随后按 Create a merge commit 合入 main；当前 submodule 固定为合并提交 `f8a331a1a3ff035162ceca657b2467dc45583a61`，原内核指纹仍在 main 历史中。验证只发送读取和被拒绝的 HTTP 方法请求，没有发起新交易轮次。

| 检查 | 实际结果 |
| --- | --- |
| `/api/health` | 200，healthy；该次读取 `snapshot_complete=true`，各依赖可用，预算 FRESH |
| `/api/state` | 200，TESTNET、内核 ONLINE、零持仓；两个 build 与部署版本一致；无公开 realized 字段 |
| `/api/timeline` | 200，6 轮：最新 SUCCEEDED，前 5 轮 FAILED；均为各自独立的 MANUAL 轮次 |
| POST / PUT / DELETE / PATCH / OPTIONS `/api/state` | 各返回 405 |
| 未授权 Origin / 同源 Origin | 分别 403 / 200；同源响应只返回精确 origin |
| 首次 SSE | `state → timeline → state`，证明基线之后有后台实时状态事件 |
| 带过期游标的 SSE 重连 | `resync → state → timeline`；事件头、JSON 类型与 ID 一致 |

另在 `15:51:01.858Z` 检查：私有凭证文件权限为 600；以上三个 JSON 接口及 caller 日志中均未匹配实际 Key/Secret 值，JSON 中未发现原始 `credential_id` 字段或内部部署路径。端口 50051 与 8787 均只绑定 `127.0.0.1`。该检查不代表已完成第三部分的全机端口加固。

本地机械检查：119/119 测试通过，类型检查通过，两份 MOCK 的契约及回放一致性检查通过。真实交易证据以终端录制为准。

当前交付是第一部分；每 6 小时的 systemd timer、加固、Caddy、公网部署、48 小时连续运行、生产机和发布 tag 属于后续第三部分。测试机 caller 目前为常驻开发进程，不能据此宣称已具备 systemd 自动拉起。第二部分前端单独并行推进。

整体工单要求的交易所后台对应订单截图、网页实时延迟及回放验收、演示录屏尚未提供；当前交易与恢复证据来自真实 RPC 事实和已提交录制。
