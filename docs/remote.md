# SSH 与 Slurm 远程执行

本文描述 v0.9.0-alpha 的远程执行表面：SSH 目标连接、Slurm 作业生命周期、两种通道（TCP 与 step relay）、持久化条件与不支持拓扑。

**证据基础**：E46 的 122 条断言、0 跳过，全部对着真实环境：真实 sshd（OpenSSH_9.6p1）、真实 slurmctld + 两台真实 slurmd（slurm-wlm 23.11.4）、真实 munge（munge-0.5.15）、真实网络命名空间，运行在 `--privileged` 的 ubuntu:24.04 容器内。没有 mock 替代任何被验收的表面。

## 1. SSH 连接

- 使用宿主系统 `ssh` 与 Git，遵循宿主 ssh config/known_hosts，**不自动开启 agent forwarding**。
- 首次 host key 由用户确认并固定（真实 hashed known_hosts 条目）；变更即拒绝。E46 实测重连时 `StrictHostKeyChecking=yes` 信任同一密钥；两跳 ProxyJump（client → login bastion → compute）两跳都固定了真实 host key。
- 密码/OTP/密钥 passphrase 在交互 challenge 输入，禁止写入 argv 或日志。
- 正式 transport 用无 PTY binary clean stream 或 loopback forward；remote stdout 仅 framing，stderr 是脱敏 bounded log。
- **连接就绪必须目标 hello**，不以 ssh exit 或 setup 成功判断。
- 断线后重连绑定 live job + bridge instance；job requeue 产生新 epoch 并重新 reconcile。E46 实测真实网络断裂（login 节点 veth 在自身命名空间内 down）被观测为真实失败，恢复链路后全新会话真实重连到同一 target。

## 2. Slurm 作业生命周期

- 默认 `sbatch --parsable`，batch owner 持有 compute Bridge；job UUID intent 先落盘，提交结果歧义用 comment/name UUID 查询调度器并 reconciling，**不自动重提**。
- 状态机：队列 PENDING、资源 RUNNING、BridgeREADY、transport CONNECTED、终止各自独立呈现。
- profile 显式声明 account/partition/cpus/memory/time/gres，**默认不申请 GPU**；提交动作展示资源与最长运行时限。
- **detach 不 cancel；stop 仅取消 owned job；borrowed allocation 不取消；到期/抢占不自动 replacement。**

## 3. 两种通道

| 通道 | 条件 | 行为 |
|---|---|---|
| TCP | login→compute 应用 TCP 允许 | 认证 compute listener + login SSH forward |
| relay | compute SSH 与应用 TCP 均不允许 | batch-owned Bridge 监听本地 socket，`srun` 单任务 relay step 转发 framed bytes |

E46 AC2 两种模式都对着真实 `srun` step 与真实 daemon 验证：TCP 模式在 cn2 上绑定真实 TCP listener 并记录真实 Slurm job/step id；relay 模式在禁掉 compute SSH 与应用 TCP 后，cn1 上的真实 `srun` step 经其真实 stdio 往返 framed bytes。

**资源契约**（参数来自冻结 profile 数值/已验证 node，不是 shell 字符串）：

- 默认 allocation 申请 computeCPU+1 CPU、computeMemoryMiB+128MiB 内存、profile 显式 GRES（不隐式 GPU）。
- service step：`--nodes=1 --ntasks=1 --nodelist=<bridgeNode> --cpus-per-task=<computeCPU> --mem=<computeMemoryMiB>M --exact --exclusive` 加明确 GRES。
- relay step：`--nodes=1 --ntasks=1 --nodelist=<bridgeNode> --cpus-per-task=1 --mem=128M --gres=none --exact --exclusive`。
- 移除冲突的继承 step-resource 环境变量，传入 job/step UUID；确认旧 relay 属于本 operation 后停止并等待资源释放，再建立 replacement。

## 4. 节点替换与持久化条件

E46 AC3：cn1 的 sshd 按其记录 pid 停止、真实 SSH 连接尝试被拒绝，应用 TCP 被真实 iptables REJECT 拦截，同时一个 compute step 占满 cn1 全部预算（CPUAlloc=4/4、AllocMem=512/512、gres/gpu:2）。申请 **1 CPU / 128 MiB / gres:0** 的 replacement relay 仍然成功并真实执行；store login 会话在饱和前、中、后逐字节一致（经真实 SSH control master 观测，不是返回值）。

持久化三层，缺一层即不承诺对应语义：

1. **login-local control DB**：`vis_bridge --role=control-store` 在 login 本地持久磁盘持 worker 数据库；login 进程拥有 srun relay 与 batch/store 关联，laptop 断线不结束它；compute 不能访问 login 应用端口时仍用 relay 反向 channel。
2. **compute-local socket/cache**：本地套接字与缓存。
3. **原生 Harness state 与 workspace persistent data**：按各 driver 已验证版本的官方参数/env 设置；不共享时仅来源已有经过版本验证的 state export/restore 能同步，否则提交前拒绝 durable mode，不承诺节点消失后历史存在。

store 不可用时停止接收新 mutation，运行中的 native 工作标记 reconciling，恢复从原生权威状态补齐，不宣称 durable 完成。每 environment 单 owner fencing epoch，竞争 job 持只读/失败。

## 5. direct 与 managed browser

- **direct**：前端直接访问目标；手动预建隧道可用。
- **managed remote**：前端只持有管理端入口的一条 `/runtime` 逻辑 WS。
- **纯浏览器无管理 Bridge**：managed transport capability 显示 `unavailable`，direct/预建隧道仍可用。
- 不能凭 loopback URL 判断本地/远程：E27 实测同一 loopback 健康 URL 在 SSH/Slurm 主机身份下报告为 remote。

## 6. 不支持拓扑（明确 unsupported）

- 多节点作业：本版本调度范围为单节点；多节点仅采用明确记录的 Bridge node。
- `srun --parsable --async` 不作为兼容基线。
- 缺 `--exact` / `gres=none` / reserve 支持：unsupported，不默认 overlap。
- Slurm 自身网络/step I/O 不可用：unsupported。
- bootstrap 与提交控制只在 login；不把 Agent/PTY 移到 login 执行。

## 7. 平台限制（逐字记录）

- **没有物理 GPU**：GRES 经 Slurm 真实 generic-GRES 记账演练（两个真实设备文件使 slurmd 真实报告 `gpu:2`、调度器真实跟踪），无真实 NVIDIA 设备。
- **macOS/Windows live 腿只在 CI 工作流（`.github/workflows/runtime-v090-qa.yml`）中定义、未执行**：它们消费 task 45 的真实打包 Bridge/Electron 产物，必须在 macOS/Windows GitHub runner 上运行。
- **非容器原生 lab 未在本机执行**：本主机无 sshd、无 Slurm、无 Munge、不能创建网络命名空间，实验在 `--privileged` 容器内完成；`--runtime native` 路径已实现且为 CI 所走路径，但未在本机执行（计划禁止在本主机安装系统包）。
- 未取得平台证据的能力不得声称支持；升级与安装路径见 [migration-v090.md](./migration-v090.md) 第 9 节（平台限制）与第 5 节（旧 Bridge 版本拒绝）。
