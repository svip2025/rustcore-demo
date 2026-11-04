> 本工作目录是第二轮 2A 离线候选。复用原工作区未提交的 web 源文件副本并增加 v1/v2 消费兼容，原工作区保持原样。下文先前发布与实机证据属于原候选，不代表本候选已部署或通过测试网验收。

# rustcore 只读演示前端

第二部分的独立静态单页。它使用 [冻结的数据契约 v1](../docs/DATA-CONTRACT.md) 读取 caller 的状态和场景时间线，实时模式与录制回放共用数据处理器。浏览器不持有交易凭证，不提供交易操作，不引入第三方运行时脚本。

当前页面使用 **6 份真实 TESTNET 录制**：默认选择 `run-20261102-150145-succeeded.json` 并停在录制末尾，先展示最终成功结论；可从头播放或拖动进度。另 5 轮失败全部可选，选中后同样先显示最终结果，列表显示每轮 UTC 开始时间、结果和原始失败原因。原始两份 MOCK 文件保留作开发夹具，有真实录制时不发布到页面。`live/replay` 表示读取方式，`TESTNET/PAPER/MOCK` 表示来源；两者分开标注，历史失败不因后续成功被覆盖。

## 本地运行

在仓库根目录使用现有 Node 22 与依赖：

```sh
npm ci
npm --prefix web run build
npm --prefix web run serve
```

打开终端给出的 `http://127.0.0.1:4173`。指定其他本地端口可运行 `npm --prefix web run serve -- 4174`。服务只绑定本机地址，仅提供 GET/HEAD；不存在的文件返回 404。已有依赖未变化时无需重新安装。

构建调用仓库已有 TypeScript 编译器，实际进行类型检查，输出到 `web/dist/`；前端包没有额外安装步骤。编译时从 `shared/schema.ts` 导入类型，生成的浏览器模块不依赖仓库外部文件。

```sh
npm --prefix web test
npm run check:recordings
```

## 连接 VPS-A 的真实 SSE（本机联调）

先在独立终端保持 SSH 本地转发；caller 继续仅监听 VPS-A 本机，不修改其绑定、不重启交易进程：

```sh
ssh -F /home/debian/.ssh/config -o ExitOnForwardFailure=yes -N -L 127.0.0.1:8787:127.0.0.1:8787 sgft
```

另一个终端在仓库根目录启动静态服务和同源只读代理：

```sh
npm --prefix web run build
DEMO_API_PROXY=http://127.0.0.1:8787 npm --prefix web run serve
```

打开 `http://127.0.0.1:4173`。代理只接受四个公开 GET 路由，SSE 逐块透传，断开网页即取消相应上游流。它不转发浏览器 Origin、Cookie、Authorization 或转发 IP 头；不会对 caller 发出写操作。代理目标只允许显式 loopback HTTP 地址，不构成公网服务。收到完整 `state` 和 `timeline` 基线后才显示实时；断流或无法连接时回到默认成功录制。

浏览器不暴露 SSE 的 `: keepalive` 注释；连接建立后依赖 EventSource 真实断线事件，不能用“长时间没有状态变化”冒充内核离线。观察的新鲜度继续按各字段的源时间与状态显示。

## 录制与接口配置

构建读取 `recordings/*.json` 并生成 `recordings/index.json`。存在非 MOCK 录制时仅发布非 MOCK；默认优先选择最新 TESTNET 成功轮，没有时再选其他成功轮或最新录制。索引保留每轮最终 `status` 与 `reason`，选择录制不修改它们。成功轮中携带的前五轮失败历史也保留在时间线中。

`dist/config.json` 中的 `live_enabled` 默认为 `true`，`api_base` 默认为 `/api`，即请求同源 `/api/stream` 和 `/api/timeline`。构建变量 `VITE_API_BASE` 可覆盖，兼容旧变量 `DEMO_API_BASE`；两者同时存在时 VITE 优先。允许 `/api`、空字符串或 HTTPS origin（可带 `/api` 后缀）：

```sh
VITE_API_BASE=https://demo.example.com npm --prefix web run build
```

**Sites 仅保留回放模式**，使用 `DEMO_LIVE_ENABLED=false npm --prefix web run build` 构建，既不连接 VPS-A，也不为预览单独暴露接口。正式 VPS 版本按默认配置构建，通过同一域名下的 Caddy 返回静态页面，将 `/api/*` 反向代理到 caller 的 `127.0.0.1:8787`；无需浏览器跨域配置。正式站点以自有域名为准，Sites 不代表正式 VPS 发布。

这只配置公开只读 caller 的地址，不是交易所地址。跨域 caller 必须将实际前端 origin 加入 CORS 白名单。配置中不可写入 token、交易凭证或内部主机信息。构建不接受 HTTP 外部地址、用户名密码、查询参数或其他路径。无法连接 caller 时页面进入回放；Sites 上的静态演示没有附带 caller 服务。

`recordings/index.json` 结构为：

```json
{
  "schema_version": 1,
  "default_id": "recording-id",
  "recordings": [
    {
      "id": "recording-id",
      "title": "录制标题",
      "source": { "kind": "TESTNET", "label": "Binance USDⓈ-M 测试网" },
      "status": "SUCCEEDED",
      "reason": "完整场景九步均通过",
      "file": "recordings/example.json",
      "duration_ms": 60000,
      "started_at": "2026-11-02T00:00:00.000Z",
      "ended_at": "2026-11-02T00:01:00.000Z"
    }
  ]
}
```

## 托管与验证边界

正式 VPS 静态托管选择 **Caddy**：站点根目录指向构建后的 `web/dist`，`/api/*` 反向代理到本机 caller，其余请求提供静态文件。具体加固、服务管理和 VPS 发布属于第三部分；此目录不修改 rustcore，也不部署交易进程。Sites 保持已有访问权限，仅提供真实录制回放，不代表 VPS-B 已发布或正式部署已完成。

构建产生的 `_headers` 为支持该格式的平台提供 CSP 等响应头；Caddy 需在正式配置中设置等效响应头。若配置跨域 API，CSP 的 `connect-src` 同时加入该 HTTPS origin。

Lighthouse 手机端性能、无障碍、最佳实践、SEO 四项 ≥95 是目标，必须以实际审计报告为证。静态构建成功、数据层测试或截图不能代替该成绩，也不能代替真实 caller 的 ≤2 秒更新验收。

仅测试网演示，非金融软件。

## 本次前端验证（2026-11-02）

本机静态预览、手机 390 × 844，Lighthouse：性能 **98**、无障碍 **100**、最佳实践 **100**、SEO **100**；CLS 为 **0**。使用 `DEMO_LIVE_ENABLED=false` 的 Sites 预览配置，无 caller 时清楚显示录制回放。最小报告与截图保存在 [`qa/summary.json`](qa/summary.json)、[`qa/desktop.png`](qa/desktop.png)、[`qa/mobile.png`](qa/mobile.png)。这是本机测试成绩，不代表已对托管站点重新测分。

数据层覆盖精确拖动、事件去重、resync 双基线、未知版本拒绝、独立 SL/TP、失败清理保留和历史分页。浏览器验证重启离线、预算过期、内核在线但观察未知、恢复、保护失败及手机无横向溢出；另以隔离的持续 SSE 服务发送现有 v1 MOCK 事件，验证完整基线、实时更新和断线回放。浏览器未发现脚本或控制台错误。

真实 caller 的更新延迟 ≤2 秒、真实测试网成交与重启恢复、VPS 发布和长期稳定性均未在这部分验收。

## 真实 caller 联调（2026-11-03）

通过 SSH 本地转发连 VPS-A 的 loopback caller，并在浏览器使用真实 EventSource 验证：完成 state/timeline 双基线后进入实时 TESTNET，连续不同 `generated_at` 的 state 均更新页面；六轮均为 MANUAL，最新成功、前五轮失败。没有修改 caller 绑定，没有重启内核或发起交易。

回放默认 `150145` 成功录制，末尾九步 PASS；五轮失败逐项选择并拖到末尾，仍为 FAILED，原始原因与历史构建指纹保留。列表可展开查看全部六轮结果及失败原因。手机 390px 页面无横向溢出；真实长小数保持精度，单位在卡内换行。单独断线检查确认自动退回成功 TESTNET 录制。

证据：[`qa/caller-integration.json`](qa/caller-integration.json)、[`实时截图`](qa/caller-live.png)、[`回放截图`](qa/caller-replay.png)。浏览器测得收到 state 到页面更新约 97.2ms（首份，含等待 timeline 基线）和 8.1ms（后续）；这是接收后的渲染时延，不能代替交易所到页面的完整链路延迟验收。旧 Lighthouse 成绩是前一版的历史证据，本次没有重新测分。

必要检查：`npm --prefix web test`、`node --test web/scripts/build.test.mjs web/scripts/serve.test.mjs`、`node web/scripts/caller-smoke.mjs http://127.0.0.1:4173`。浏览器脚本需已有 Playwright/Chromium，不会自动安装浏览器。Sites 构建始终关闭实时连接，仅发布上述真实录制回放；正式同源 Caddy 部署与长期稳定性验收另行推进。
