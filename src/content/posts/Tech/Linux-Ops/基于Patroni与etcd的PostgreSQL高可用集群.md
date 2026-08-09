---
title: 基于Patroni与etcd的PostgreSQL高可用集群
published: 2026-07-28
updated: 2026-08-09
pinned: false
description: 在已有 K3s 集群的三台 Debian 节点上部署独立于 K8s 的 Patroni + etcd 方案，实现 PostgreSQL 17 高可用，并通过标签优先级确保指定节点始终为主库
tags: [Database, High Availability]
category: Database
author: Hyperbola
draft: false
---

> 本文记录了在已有 K3s 集群的三台 Debian 节点上，部署独立于 K8s 的 Patroni + etcd 方案，实现 PostgreSQL 17 高可用，并通过标签优先级确保 `10.0.0.10` 始终为主库的完整过程。文中详细复盘了从架构设计到疑难排错的每一步，希望能为有类似需求的读者提供参考。

---

## 一、背景与目标

我们已有三台通过 ZeroTier 组成内网的物理机/虚拟机，全部安装了 K3s 并组成高可用控制面（3 个 Server 节点内嵌 etcd）。现在需要在**这套基础设施之上**，为业务提供一套独立于 K8s 的传统 PostgreSQL 高可用方案，原因有三：

1. 核心数据库与 Kubernetes 控制面解耦，降低连锁故障风险；
2. 团队有成熟的 PostgreSQL 运维经验，习惯使用 Patroni；
3. 明确要求 `10.0.0.10` 这台机器始终作为主库，其他节点为附属只读。

最终选择 **Patroni + 独立 etcd（避免与 K3s 内嵌 etcd 冲突）**，并通过 `failover-priority` 标签实现优先级控制。

---

## 二、架构总览

```
ZeroTier 网络：10.0.0.0/24

10.0.0.10 : PostgreSQL Leader (failover-priority: 100)
10.0.0.30 : PostgreSQL Replica (failover-priority: 50)
10.0.0.40 : PostgreSQL Sync Standby (failover-priority: 0)

独立 etcd 集群（端口 3379）运行在这三台机器上
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  etcd-10    │◄──►│  etcd-30    │◄──►│  etcd-40    │
└─────────────┘    └─────────────┘    └─────────────┘
       ▲                   ▲                   ▲
       └───────────────────┼───────────────────┘
                     Patroni 通过 etcd 协调

应用访问：直连 10.0.0.10:5432 读写，10.0.0.30/40:5432 只读
（后续可叠加 HAProxy 做 VIP 自动切换）
```

**关键设计点：**

- etcd 使用独立端口 `3379`，与 K3s 的 `2379` 完全隔离；
- 同步复制采用 `synchronous_mode: true`，指定至少一个备库同步提交（`synchronous_standby_names: "*"`），但关闭严格模式，避免备库故障阻塞主库；
- 优先级配置确保 `10.0.0.10` 只要存活就是 Leader，故障恢复后自动夺回。

---

## 三、环境信息

- 操作系统：Debian 13 (trixie)
- PostgreSQL 版本：17
- Patroni 版本：`apt install patroni python3-etcd3 python3-etcd`
- etcd 版本：3.5.x（通过 `apt install etcd-server`）
- 网络：ZeroTier 内网，节点 IP 分别为 `10.0.0.10`、`10.0.0.30`、`10.0.0.40`

---

## 四、部署独立 etcd 集群

### 4.1 安装 etcd

三台机器均执行：

```bash
sudo apt update
sudo apt install -y etcd-server etcd-client
```

### 4.2 配置 etcd

以 `10.0.0.10` 为例，编辑 `/etc/default/etcd`：

```bash
ETCD_NAME="etcd-10"
ETCD_INITIAL_CLUSTER="etcd-10=http://10.0.0.10:3380,etcd-30=http://10.0.0.30:3380,etcd-40=http://10.0.0.40:3380"
ETCD_LISTEN_CLIENT_URLS="http://10.0.0.10:3379,http://127.0.0.1:3379"
ETCD_LISTEN_PEER_URLS="http://10.0.0.10:3380"
ETCD_ADVERTISE_CLIENT_URLS="http://10.0.0.10:3379"
ETCD_INITIAL_ADVERTISE_PEER_URLS="http://10.0.0.10:3380"
ETCD_DATA_DIR="/var/lib/etcd/default"
ETCD_INITIAL_CLUSTER_STATE="new"
ETCD_INITIAL_CLUSTER_TOKEN="pg-cluster-token"
ETCD_ENABLE_V2="true"
```

其他节点同理修改 `ETCD_NAME` 和对应 IP。注意我们将客户端端口从默认的 `2379` 改成了 `3379`，避免与 K3s 冲突。

### 4.3 启动并验证

先启动 `10.0.0.10`，再依次启动其他节点：

```bash
sudo systemctl enable etcd
sudo systemctl start etcd
```

检查集群健康：

```bash
etcdctl --endpoints=http://10.0.0.10:3379,http://10.0.0.30:3379,http://10.0.0.40:3379 endpoint health
```

---

## 五、安装 Patroni（带 etcd 支持）

直接使用 Debian 13 的 APT 包即可，`patroni` 加上 `python3-etcd3`、`python3-etcd` 依赖足够：

```bash
sudo apt install -y patroni python3-etcd3 python3-etcd
```

验证导入：

```bash
python3 -c "from patroni.dcs.etcd import Etcd; print('etcd driver OK')"
```

> **避坑提示**：Patroni 的 DCS 后端必须使用 **`etcd3:`**（etcd v3 API），不能写成 `etcd:`（v2 API）。若误用 `etcd:`，会读不到 `leader`/`config`/`status` 等键，导致 Patroni 认为集群未初始化、一直卡在 `waiting for leader to bootstrap`，详见下文配置部分。

---

## 六、配置 Patroni

### 6.1 Leader 节点配置 (10.0.0.10)

文件 `/etc/patroni/config.yml`：

```yaml
scope: pg-cluster
namespace: /db/
name: pg-10

restapi:
  listen: 10.0.0.10:8008
  connect_address: 10.0.0.10:8008

etcd3:
  hosts: 10.0.0.10:3379,10.0.0.30:3379,10.0.0.40:3379,10.0.0.20:3379

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576
    master_start_timeout: 300
    synchronous_mode: true
    synchronous_mode_strict: false
    postgresql:
      use_pg_rewind: true
      parameters:
        max_connections: 200
        shared_buffers: 256MB
        wal_level: replica
        hot_standby: "on"
        wal_keep_size: 128
        max_wal_senders: 10
        max_replication_slots: 10
        synchronous_commit: "remote_apply"
        synchronous_standby_names: "*"
  initdb:
    - encoding: UTF8
    - locale: C.UTF-8
    - data-checksums
  pg_hba:
    - local all all trust
    - host all all 0.0.0.0/0 md5
    - host replication all 0.0.0.0/0 md5

postgresql:
  listen: 10.0.0.10:5432
  connect_address: 10.0.0.10:5432
  data_dir: /var/lib/postgresql/17/main
  conf_dir: /etc/postgresql/17/main
  bin_dir: /usr/lib/postgresql/17/bin
  pgpass: /tmp/pgpass
  authentication:
    replication:
      username: replicator
      password: 'YourReplicatorPassword'
    superuser:
      username: postgres
      password: 'YourSuperuserPassword'
  parameters:
    unix_socket_directories: '/var/run/postgresql'

tags:
  nofailover: false
  clonefrom: false
  failover-priority: 100   # 最高优先级，只要存活就是 Leader
```

**配置要点解读：**

- **DCS 后端必须使用 `etcd3:`（etcd v3 API）**，不要写成 `etcd:`（v2 API）。误用 `etcd:` 会导致 Patroni 读不到 `leader`/`config`/`status` 等键，误判集群未初始化，一直卡在 `waiting for leader to bootstrap`；
- `etcd3.hosts` 包含四节点 etcd（含新加入的 `10.0.0.20:3379`）；
- `postgresql.conf_dir` 指向 `/etc/postgresql/17/main`（Debian 包路径），缺失会导致 PG 启动异常；
- `synchronous_mode: true` 且 `synchronous_standby_names: "*"`：保证至少有一个备库实时同步，且主库 commit 必须等待至少一个备库将 WAL 刷盘（`remote_apply`）。
- `synchronous_mode_strict: false`：即便所有备库都离线，主库仍可接受写入，不会阻塞业务。
- `pg_hba` 部分必须显式添加 `host all all 0.0.0.0/0 md5`，否则 Patroni 无法通过 TCP 心跳连接数据库，会反复报 `no pg_hba.conf entry`。
- `initdb` 中**不要添加 `pgdata` 选项**，Patroni 4.0.7 会报 `pgdata option for initdb is not allowed`，数据目录已在 `postgresql.data_dir` 中指定。
- 使用 `C.UTF-8` locale 可避免系统 glibc 版本不一致导致的 collation 警告。

### 6.2 其他节点配置

`10.0.0.30` 和 `10.0.0.40` 的配置文件仅需修改：

- `name`: 对应 `pg-30` / `pg-40`
- `restapi.listen` / `connect_address`
- `postgresql.listen` / `connect_address`
- `tags.failover-priority`: 分别设为 `50` 和 `0`

其余与 Leader 完全相同。

---

## 七、启动集群

### 7.1 初始化第一个节点

**务必清空数据目录**（否则旧残留会导致初始化失败）：

```bash
sudo systemctl stop patroni postgresql 2>/dev/null
sudo pkill -9 -u postgres

# 彻底删除整个目录再重建（不要用 rm -rf *，zsh 通配符可能不展开隐藏文件）
sudo rm -rf /var/lib/postgresql/17/main
sudo -u postgres mkdir -p /var/lib/postgresql/17/main
```

清空 etcd 中的旧集群信息（如果有）：

```bash
patronictl -c /etc/patroni/config.yml remove pg-cluster
# 输入 "Yes I am aware" 确认
```

启动 Patroni：

```bash
sudo systemctl start patroni
```

观察日志，应出现：

```
INFO: trying to bootstrap a new cluster
INFO: initialized a new cluster
INFO: acquired session lock as a leader
```

### 7.2 加入其他节点

在 `10.0.0.30` 和 `10.0.0.40` 上同样清空数据目录，然后启动 Patroni：

```bash
sudo rm -rf /var/lib/postgresql/17/main
sudo -u postgres mkdir -p /var/lib/postgresql/17/main
sudo systemctl start patroni
```

它们会自动从 Leader 同步数据，成为 Replica 或 Sync Standby。

---

## 八、疑难排错实录

在部署过程中，我们踩了几个坑，特此记录以便读者自查。

### 坑 1：`rm -rf /var/lib/postgresql/17/main/*` 在 zsh 下失效

现象：执行后 `ls -la` 仍显示大量目录和文件，但缺少 `postgresql.conf`，导致 Patroni 误判为已存在实例，并报 `FileNotFoundError: postgresql.conf`。  
原因：zsh 在通配符没有匹配到任何文件时会报错 `no matches found`，**且不会删除隐藏文件和子目录**。  
**解决**：直接删除整个目录 `rm -rf /var/lib/postgresql/17/main`，然后重建。

### 坑 2：Patroni 报 `pgdata option for initdb is not allowed`

完整错误：

```
Exception: pgdata option for initdb is not allowed
```

这是 Patroni 4.0.7 的硬限制，`initdb` 配置中不能包含 `pgdata` 参数。只需从 `bootstrap.initdb` 列表中移除该项即可。

### 坑 3：Patroni 心跳连接失败 `no pg_hba.conf entry for host "10.0.0.10"`

PostgreSQL 虽然启动，但 Patroni 无法通过 TCP 连接执行管理命令，日志频繁刷 `FATAL: no pg_hba.conf entry`。  
原因：未在 `bootstrap.pg_hba` 中显式配置允许远程 TCP 认证。  
**解决**：在 `bootstrap` 段添加：

```yaml
pg_hba:
  - local all all trust
  - host all all 0.0.0.0/0 md5
  - host replication all 0.0.0.0/0 md5
```

然后重置集群重新引导。

### 坑 4：collation 版本不匹配警告

警告内容：

```
WARNING: database "postgres" has a collation version mismatch
DETAIL: The database was created using collation version 2.42, but the operating system provides version 2.41.
```

这不影响功能，但可以通过 `ALTER DATABASE postgres REFRESH COLLATION VERSION;` 消除。使用 `locale: C.UTF-8` 可以从根本上避免此类问题。

---

## 九、验证集群状态

使用 `patronictl` 查看：

```bash
sudo patronictl -c /etc/patroni/config.yml list
```

输出：

```
+ Cluster: pg-cluster (7667324251917980557) ----+----+-----------+------------------------+
| Member | Host      | Role         | State     | TL | Lag in MB | Tags                   |
+--------+-----------+--------------+-----------+----+-----------+------------------------+
| pg-10  | 10.0.0.10 | Leader       | running   |  1 |           | failover-priority: 100 |
| pg-30  | 10.0.0.30 | Replica      | streaming |  1 |         0 | failover-priority: 50  |
| pg-40  | 10.0.0.40 | Sync Standby | streaming |  1 |         0 | failover-priority: 0   |
+--------+-----------+--------------+-----------+----+-----------+------------------------+
```

解读：
- `pg-10` 为 Leader，符合预期；
- `pg-40` 被自动选为同步备库（因为 `synchronous_standby_names: "*"` 允许任选一个），主库的每个事务必须等待该备库确认；
- 所有节点复制延迟为 0 MB，数据完全一致。

---

## 十、故障转移测试

模拟 `pg-10` 宕机：

```bash
sudo systemctl stop patroni   # 在 10.0.0.10 上执行
```

其他节点立即检测到，`pg-30` 或 `pg-40`（优先级高的）会被提升为新 Leader。当 `pg-10` 恢复后：

```bash
sudo systemctl start patroni
```

因其 `failover-priority: 100` 最高，Patroni 会执行 **switchover**，自动将 Leader 交还给 `pg-10`，无需人工干预。

---

## 十一、计划内切换（Switchover）—— 让指定节点重新成为主库

### 11.1 为什么需要手动 Switchover？

`failover-priority` 标签只能在自动故障转移（failover）中影响选主，若集群平稳运行中你想主动把 Leader 交还给 `pg-10`，就需要执行 **switchover** 命令。否则即使 `pg-10` 优先级最高，它也不会自动抢夺健康主库的 Leader 地位。

### 11.2 遇到的首个障碍：同步模式下的限制

尝试直接切换时：

```bash
sudo patronictl -c /etc/patroni/config.yml switchover pg-cluster --candidate pg-10
```

报错：

```
Switchover failed, details: 412, candidate name does not match with sync_standby
```

原因在于我们开启了 `synchronous_mode: true` 和 `synchronous_standby_names: "*"`，Patroni 要求计划内切换的目标节点**必须是当前 Sync Standby**，以确保切换过程中零数据丢失。而此刻集群的 Sync Standby 是 `pg-40`（或 `pg-30`），并非 `pg-10`。

### 11.3 不丢失数据的安全切换方案

我们可以通过临时修改 DCS 中的同步配置，让 `pg-10` 成为 Sync Standby，然后再执行切换。这里给出两种同样安全的方法，全程无需 `--force`，数据零丢失。

#### 方案一：调整 `synchronous_standby_names`（推荐）

动态修改 DCS 中的 PostgreSQL 参数，将同步备库候选列表精确限定为仅 `pg-10`：

```bash
sudo patronictl -c /etc/patroni/config.yml edit-config
```

在编辑器中找到 `synchronous_standby_names`，将其值改为：

```yaml
synchronous_standby_names: '1 (pg-10)'
```

保存退出后，Patroni 会立即重载配置。稍等片刻，`pg-10` 的角色就会从 `Replica` 变为 `Sync Standby`。此时执行标准切换即可：

```bash
sudo patronictl -c /etc/patroni/config.yml switchover pg-cluster --candidate pg-10
```

出现时间确认提示直接回车（立即执行），再输入 `y` 确认。切换在 1~2 秒内完成。

切换成功后，**务必把同步参数恢复原状**，以保持集群原有的同步策略：

```bash
sudo patronictl -c /etc/patroni/config.yml edit-config
# 将 synchronous_standby_names 改回 '*'
```

#### 方案二：使用 `nosync` 标签

如果不愿直接改动 `synchronous_standby_names`，也可以给其他两个备库打上 `nosync: true` 标签，让它们暂时放弃成为同步备库的资格，从而让 `pg-10` 自动当选：

```bash
# 给 pg-30 和 pg-40 打上 nosync 标签
sudo patronictl -c /etc/patroni/config.yml tag pg-30 nosync true
sudo patronictl -c /etc/patroni/config.yml tag pg-40 nosync true
```

等待 `patronictl list` 显示 `pg-10` 的角色为 `Sync Standby`，然后执行：

```bash
sudo patronictl -c /etc/patroni/config.yml switchover pg-cluster --candidate pg-10
```

切换完成后，移除标签：

```bash
sudo patronictl -c /etc/patroni/config.yml tag pg-30 nosync false
sudo patronictl -c /etc/patroni/config.yml tag pg-40 nosync false
```

### 11.4 验证切换结果

执行 `patronictl list`：

```
+ Cluster: pg-cluster (7667324251917980557) ----+----+-----------+------------------------+
| Member | Host      | Role         | State     | TL | Lag in MB | Tags                   |
+--------+-----------+--------------+-----------+----+-----------+------------------------+
| pg-10  | 10.0.0.10 | Leader       | running   |  8 |           | failover-priority: 100 |
| pg-30  | 10.0.0.30 | Replica      | streaming |  8 |         0 | failover-priority: 50  |
| pg-40  | 10.0.0.40 | Replica      | streaming |  8 |         0 | failover-priority: 0   |
+--------+-----------+--------------+-----------+----+-----------+------------------------+
```

Leader 已成功回到 `pg-10`，所有备库同步延迟为 0，数据完好。

### 11.5 要点小结

- 开启同步复制的集群，计划内切换必须面向当前 Sync Standby 执行，这是 Patroni 的数据安全保护机制。
- 通过临时修改 `synchronous_standby_names` 或给节点打 `nosync` 标签，可以引导 Sync Standby 角色迁移到目标节点，从而合规地完成切换。
- 操作完成后记得恢复原始配置，以保证后续自动故障转移的行为符合预期。
- 整个过程无需重启任何服务，业务几乎无感知。

---

## 十二、总结

通过 Patroni + 独立 etcd 的组合，我们成功在现有 ZeroTier 内网中搭建了一套强健的 PostgreSQL 高可用方案。整个过程中，优先级标签完美满足了“指定主机永远为主库”的业务需求，同步复制则为数据一致性提供了有力保障。

后续可在此基础上叠加 **HAProxy + VIP** 实现自动读写分离和连接池（pgBouncer），进一步适配大规模应用场景。

希望这篇踩坑记录能帮你少走弯路，欢迎交流与指正。