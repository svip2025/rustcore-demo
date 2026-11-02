# 48 小时观测

观测工具是 [deploy/observe-48h.py](../deploy/observe-48h.py)，只使用 Python 3.10+ 标准库。它读取本机只读 HTTP、systemd MainPID、进程内存、数据盘和数据库大小；不触发场景、不管理交易进程、不拉代码、不修改环境或风控配置。实际 48 小时结果需等窗口结束并审阅证据，交付脚本不代表已完成运行。

## 起点与证据

先冻结已部署 release、构建指纹和私有配置，再启动观测，随后由现有 systemd timer 触发场景。**起点只取观测启动后首次实际看见的 `SCHEDULED`、`RUNNING` 轮次的 `started_at`**；不取 systemctl 启动时间，也不从历史已完成轮次补算。等待期间每 5 秒读 state/timeline；错过 RUNNING 就等待下一轮。窗口终点是该起点加 48 小时。

启动后的每 5 分钟保存健康读回、轮次摘要、caller/core RSS 和峰值、磁盘余量、两个数据库及 WAL/SHM 大小。缺失资源记为 null，不伪造为零。JSON 只保存公开轮次状态/原因和资源数字；配置仅存整体 SHA256，不保存环境内容、密钥、进程命令行或原始异常正文。

```sh
umask 077
python3 deploy/observe-48h.py run \
  --output /var/lib/rustcore-demo/observations/attempt-001 \
  --freeze-file /etc/systemd/system/caller.service \
  --freeze-file /etc/systemd/system/rustcore.service \
  --freeze-file /etc/systemd/system/scenario.service \
  --freeze-file /etc/systemd/system/scenario.timer
```

默认代码目录为 `/opt/rustcore-demo/current`，API 为 `http://127.0.0.1:8787`，私有配置为 `/etc/rustcore-demo/env`，数据目录为 `/var/lib/rustcore-demo`。脚本须由能读取这些配置和资源的本机用户运行，并通过部署进程管理或持久终端保持运行。示例命令本身不会启用 timer。首次运行要求 release 和 submodule 为干净 checkout；证据目录必须不存在，不能复用旧目录。

release 可保持 root:root 且服务用户只读；每次 Git 查询仅以命令级 `safe.directory` 精确信任解析后的该 release 或 submodule，不修改全局 Git 配置或代码属主。操作员可继续用重复的 `--freeze-file` 纳入前端 BUILD-INFO、原始发布 tgz、Caddyfile 和其他 unit/config 文件，只保存这些文件的整体校验值。

每个私有 attempt 目录保存：

- `summary.json`：状态、arm 时间、实际起点、计划终点、结束时间、轮次数量、build/冻结指纹及首尾资源样本。
- `samples.jsonl`：追加的五分钟观测，包含异常读回；不会裁掉失败样本。
- `rounds.jsonl`：窗口内轮次状态变化，保留原 `FAILED` 和公开原因。完整逐步骤证据仍由 caller 的自动录制保存，不改写已有录制。

`status` 输出可供交接实际起点、将来终点和累计轮次：

```sh
python3 deploy/observe-48h.py status --output /var/lib/rustcore-demo/observations/attempt-001
```

`WAITING_FOR_SCHEDULED` 尚未开始计时；`RUNNING` 正在观察。48 小时后至少八个 SCHEDULED 轮次在窗口内结束时为 `WINDOW_ELAPSED`，不足则为 `INSUFFICIENT_ROUNDS`。成功、失败和仍运行的轮次分别计数；MANUAL 不充抵八轮。`WINDOW_ELAPSED` 表示时间及数量已收集，**不自动宣布验收通过**，仍须检查失败、健康样本和内存/磁盘是否持续增长。

## 中止和新 attempt

代码提交、release 指向、工作区、API build 或冻结配置变化会使该 attempt `INVALIDATED` 并停止计时，保留原样本。实际部署/caller bug 由操作员判断并明确中止：

```sh
python3 deploy/observe-48h.py stop \
  --output /var/lib/rustcore-demo/observations/attempt-001 \
  --kind DEPLOYMENT_BUG
```

操作员也可用 CODE_CHANGE、BUILD_CHANGE、CONFIG_CHANGE、OPERATOR_STOP、EXTERNAL_TESTNET 标记中止类别；脚本约五秒内读取停止请求，不停止 caller、kernel 或 timer。纯场景失败和外部测试网错误原样记录，默认不自动停止观察，也不重试到成功；操作员区分真实程序 bug 与外部失败。修复或变更后，使用新的 attempt 目录，从新的首轮 SCHEDULED/RUNNING 重新计时，不能覆盖或拼接旧窗口。

观测进程意外退出也不能把空白时段当作连续观测或重启后续算；保留该目录并开始新 attempt。冻结检查按采样执行，操作员已知发生变更或程序 bug 时应立即使用 stop，不能等待下一次采样替自己追溯中止时间。

纯合成时钟检查：`python3 deploy/observe-48h.py self-test`。此模式不访问 HTTP/服务、不写真实观测文件，输出明确标为 synthetic；不能拿它当作八轮测试网成功或真实 48 小时结果。
