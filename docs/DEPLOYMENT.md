# VPS-A 部署与日常运维

当前目标是 VPS-A 的测试网长期运行准备。**48 小时观测尚未开始，caller/current 的最终 release SHA 待定**；服务就绪与端口外部验收需按实际结果记录，本页不预先宣告通过。VPS-B 及其 demo 域名保持不动，待 A 验收后再确定 tag 和后续部署。

## 当前资产

| 项目 | 已知状态或位置 |
| --- | --- |
| 演示域名 | [test.code518.info](https://test.code518.info) → `103.195.188.21` |
| 静态站点 | Caddy 已取得证书并提供原生产包：`/srv/rustcore-demo-web/current/dist`；API 默认 `/api`，同源转发到 `127.0.0.1:8787` |
| 原生产包 SHA256 | `5439f0bbcd42d054944deedeba1a522167cf96b85a0e5c973eceed0c5ed4e521` |
| 内核源码 | main 合并提交 `f8a331a1a3ff035162ceca657b2467dc45583a61` |
| 已构建内核 SHA256 | `b3d1e6946762d944f074f5254816cb23018447716f3981d1ea47494622d64e9c`；**dev profile，非 release 优化构建** |
| 代码 | `/opt/rustcore-demo/releases/<tag-or-fullsha>`，root:root、服务用户不可写；`/opt/rustcore-demo/current` 指向选定 release |
| 工具 | 独立 Node：`/opt/rustcore-demo/tools/node-v22.23.2-linux-x64/bin/node` |
| 私有配置、数据 | `/etc/rustcore-demo/env`，权限 600；数据库 `/var/lib/rustcore-demo/{kernel,caller}.db` |
| 既有站点 | 原 sg 域名保留；Apache 后端维持 loopback `18080` / `18443`，不替换其他站点配置 |

上述静态包与内核哈希分别对应已有产物，不应当作尚未生成的最终 caller release 指纹。[deploy.sh](../deploy/deploy.sh) 后续按 `cargo build --release` 构建时，应另记其实际二进制哈希。

## 登录与权限

本地管理别名已切换到独立密钥管理用户：

```sh
ssh -F /home/debian/.ssh/config sgft
sudo -n id
```

管理账户为 `rustcore-admin`，远端管理命令使用 sudo；root SSH 和密码登录已禁用。`rustcore-demo` 是 nologin 服务账户，唯一 sudo 权限为：

```text
/usr/bin/systemctl restart rustcore.service
```

服务模式配置为 `DEMO_KERNEL_MODE=systemd`。caller 通过上述精确命令重启 core，不接管其他进程。`caller.service` 使用 `Wants` + `After` 依赖 core，重启 core 不连带停止 caller。不要给服务用户代码写权限或扩展其 sudo 范围；私有环境内容不输出到日志或工单。

## 服务与定时任务

在最终 release 激活并完成其就绪检查后，由管理用户操作：

```sh
sudo systemctl start rustcore.service caller.service
sudo systemctl status rustcore.service caller.service --no-pager
sudo systemctl list-timers --all scenario.timer rustcore-health.timer rustcore-backup.timer --no-pager
curl -fsS http://127.0.0.1:8787/api/health
sudo journalctl -u caller.service -u rustcore.service -n 80 --no-pager
```

| 单元 | 行为 |
| --- | --- |
| `rustcore.service` / `caller.service` | 独立服务账户运行，`Restart=always`；core 重启期间 caller 继续保存状态 |
| `scenario.timer` → `scenario.service` | 激活后约 30 秒首触发，随后每 6 小时触发 `--trigger SCHEDULED`；与手工场景共用 `/var/lib/rustcore-demo/scenario.lock`，不另套场景锁 |
| `rustcore-health.timer` | 每 5 分钟只读检查本机 health；失败进入该单元的状态/日志，不自动触发交易 |
| `rustcore-backup.timer` | 每日 UTC 03:15，随机延迟最多 5 分钟，在线备份两个 SQLite，保留最近 7 份完整代次 |
| `rustcore-recordings.path` | 已完成录制变化后发布公开副本及 index，保留成功和失败；Caddy 从 `/recordings/` 读取 |

场景失败保留为 FAILED，`scenario.service` 不自动重启或重试到成功。首装的部署脚本保持 `scenario.timer` 停止，留出冻结配置和 arm observer 的时机。

## 启动和停止 48 小时观测

先按 [RUN-48H.md](RUN-48H.md) 启动 observer，并纳入实际 env、units/timer、Caddyfile、前端 BUILD-INFO 和原始 tgz 的冻结指纹。它必须先 armed，随后才能启动 timer：

```sh
sudo -u rustcore-demo /usr/bin/python3 /opt/rustcore-demo/current/deploy/observe-48h.py status \
  --output /var/lib/rustcore-demo/observations/attempt-001
sudo systemctl start scenario.timer
sudo systemctl status scenario.timer scenario.service --no-pager
```

`attempt-001` 为示例，操作时使用实际新建的私有 attempt 目录。`WAITING_FOR_SCHEDULED` 表示已 arm、尚未计时；首个实际观测到的 SCHEDULED/RUNNING 轮次 `started_at` 才是起点，终点为其后 48 小时，以该目录 `summary.json` 为准。当前没有真实起点或终点，不用服务启动时间代替。

暂停新的场景触发并中止本次观察：

```sh
sudo systemctl stop scenario.timer
sudo -u rustcore-demo /usr/bin/python3 /opt/rustcore-demo/current/deploy/observe-48h.py stop \
  --output /var/lib/rustcore-demo/observations/attempt-001 --kind OPERATOR_STOP
```

停止 timer 不会强杀已经在运行的场景；stop observer 也不会停止 caller/core。已确认程序 bug 使用 `--kind DEPLOYMENT_BUG`；代码、build 或冻结配置变化后保留旧 attempt，修复后另开新目录重计。外部测试网场景失败照实记录，不靠自动重试清除。48 小时内至少八个已结束的 SCHEDULED 轮次、健康与资源趋势均需审阅，`WINDOW_ELAPSED` 不自动等于验收通过。

## 发布、回滚与备份

[部署脚本](../deploy/deploy.sh) 只接收已验收的 tag 或完整 SHA。它先暂停 timer，使用同一个场景锁拒绝打断活动轮次，在线备份后激活代码、更新非秘密版本字段并执行 smoke。已有 timer 是否恢复取决于变更前状态；不自动拉取或发布新代码。

以下是获准维护窗口内的操作，48 小时冻结期间不执行：

```sh
sudo /opt/rustcore-demo/current/deploy/deploy.sh ACCEPTED_TAG_OR_FULLSHA
sudo /opt/rustcore-demo/current/deploy/rollback.sh PREVIOUS_TAG_OR_FULLSHA
sudo systemctl start rustcore-backup.service
sudo systemctl status rustcore-backup.service --no-pager
```

回滚只回代码，保留当前 SQLite 数据，不自动倒退订单或成交事实。备份位于 `/var/backups/rustcore-demo/sqlite`，使用 SQLite 在线 backup 与完整性检查；两库分别一致，不声称是跨库原子快照。

journald 配额为全机持久日志 `500M`、运行时日志 `100M`。自动安全更新启用，但不自动重启机器。相关配置与服务模板在 [deploy/](../deploy/)；这些资产存在不替代实际启用状态检查。

**TODO：公网外部邮件监控尚未配置。** 本机五分钟 health 检查不能替代外部可达性及邮件通知。VPS-B 发布、A 的 48 小时结果、外部端口验收及最终 tag 仍按实际完成情况另记。
