---
title: WSL2 加入 ZeroTier 集群：部署 K3s Agent 与 Patroni PostgreSQL
published: 2026-08-09
updated: 2026-08-09
pinned: false
description: 将 WSL2 主机通过 ZeroTier 加入现有高可用集群，作为 K3s Agent 工作节点与 Patroni 管理的 PostgreSQL 副本节点的完整过程
tags: [Kubernetes, Database, High Availability]
category: DevOps
author: Hyperbola
draft: false
---

> 在已有三节点 ZeroTier 高可用集群（K3s control-plane + Patroni PostgreSQL）的基础上，新增一台 WSL2 主机作为第四节点：部署 K3s Agent 工作节点与 Patroni 管理的 PostgreSQL 副本，通过 ZeroTier 网络 `88c5b1f3396eaea0` 组网并固定 IP 为 `10.0.0.20`。

---

## 一、背景与集群拓扑

现有集群由三台 Debian 主机组成，通过 ZeroTier 组成 `10.0.0.0/24` 二层内网：

| 主机名           | 内网 IP | 角色                               |
| ---------------- | ------- | ---------------------------------- |
| hyperbola-server | 10.0.0.10 | Patroni Leader、K3s control-plane |
| hyperbola-txy    | 10.0.0.30 | Patroni Replica、K3s control-plane |
| hyperbola-aly    | 10.0.0.40 | Patroni Replica、K3s control-plane |

本次新增一台 **WSL2 主机**（Windows 11 + Debian 13），作为第四节点：

| 主机名   | 内网 IP | 角色                            |
| -------- | ------- | ------------------------------- |
| HyQAQ-WSL | 10.0.0.20 | K3s Agent（工作节点）、Patroni Replica |

**备份节点定位（不参与 HA）：**

- `10.0.0.20` **不安装** Keepalived / HAProxy，不参与 VRRP 竞选，**永远不会持有 VIP**；
- Patroni 配置 `nofailover: true`，**永不成为数据库 Leader**；
- 三台主机的 HAProxy / Keepalived **配置与后端均无需改动**，`10.0.0.20` 不加入任何 HA 后端。

**目标：**

- WSL2 通过 ZeroTier 加入内网，固定地址 `10.0.0.20`；
- 部署 **K3s Agent** 加入现有集群，作为工作节点承载业务负载；
- 部署 **PostgreSQL + Patroni** 加入现有 HA 集群，作为普通副本（Replica），通过现有 etcd（端口 `3379`）协调。

---

## 二、环境信息

- 操作系统：Windows 11 + WSL2 Debian 13 (trixie)
- WSL 网络：桥接模式静态 IP `192.168.86.22`（宿主局域网）+ ZeroTier 内网 IP `10.0.0.20`
- PostgreSQL 版本：17
- Patroni 版本：`apt install patroni python3-etcd3 python3-etcd`
- ZeroTier 网络 ID：`88c5b1f3396eaea0`，接口名一般为 `ztpp6n6xmz`

> WSL2 桥接模式、静态 IP、systemd 等前置配置参考《WSL2 桥接模式实战：配置静态 IP、开启 IPv6 与 Systemd 避坑指南》。

---

## 三、WSL 环境准备

### 3.1 启用 systemd（关键）

WSL2 默认不使用 systemd 作为 init 系统，而 K3s 和 Patroni 都依赖 systemd 管理服务。编辑 `/etc/wsl.conf`：

```bash
sudo vim /etc/wsl.conf
```

```ini
[boot]
systemd=true

[network]
hostname = HyQAQ-WSL
generateHosts = false
generateResolvConf = false
```

在 PowerShell 中执行 `wsl --shutdown`，重新进入后验证：

```bash
ps -p 1 -o comm=
# 输出 systemd 即为成功
```

### 3.2 确认静态 IP 与 DNS

```bash
ip a show eth0
# 应看到 192.168.86.22/24 静态地址

cat /etc/resolv.conf
# nameserver 223.5.5.5
# nameserver 114.114.114.114
```

---

## 四、加入 ZeroTier 网络

### 4.1 安装 ZeroTier

```bash
curl -s https://install.zerotier.com | sudo bash
sudo systemctl enable --now zerotier-one
```

### 4.2 加入网络并固定 IP

```bash
sudo zerotier-cli join 88c5b1f***6eaea0
```

在 [ZeroTier Central](https://my.zerotier.com) 管理后台：

1. 找到网络 `88c5b1f***6eaea0`，在 Members 列表中授权新节点；
2. 在 Managed Addresses 中将该节点固定为 `10.0.0.20`；
3. 确认网络已有 `10.0.0.0/24` 的路由段。

查看接口与 IP：

```bash
sudo zerotier-cli listnetworks
# ztpp6n6xmz  88c5b1f3396eaea0 ... 10.0.0.20/24 ...

ip addr show ztpp6n6xmz
```

### 4.3 验证与集群互通

```bash
ping -c 4 10.0.0.10
ping -c 4 10.0.0.30
ping -c 4 10.0.0.40
```

全部通顺则内网就绪。

> [!NOTE]
>
> 集群 ZeroTier 接口名为 `ztpp6n6xmz`（与现有集群其他节点一致），后续所有配置均使用该接口名。若不确定，以本机 `ip a` / `zerotier-cli listnetworks` 实际输出为准。

---

## 五、部署 K3s Agent

### 5.1 获取集群 Token

在任一 Server 节点（如 `10.0.0.10`）执行：

```bash
sudo cat /var/lib/rancher/k3s/server/node-token
```

记录输出的 token 值（形如 `K10xxx::server:xxx`）。

### 5.2 安装 Agent（环境变量方式）

```bash
curl -sfL https://get.k3s.io | K3S_URL=https://10.0.0.10:6443 K3S_TOKEN="K10xxx::server:xxx" K3S_NODE_IP=10.0.0.20 K3S_NODE_EXTERNAL_IP=10.0.0.20 K3S_FLANNEL_IFACE=ztpp6n6xmz sh -
```

参数说明：
- `K3S_URL`：指向现有集群任一 Server 的 API 地址；
- `K3S_TOKEN`：与集群一致的认证令牌（从 5.1 获取）；
- `K3S_NODE_IP` / `K3S_NODE_EXTERNAL_IP`：使用 ZeroTier 内网 IP；
- `K3S_FLANNEL_IFACE`：**必须与集群其他节点保持一致**（集群使用 `host-gw` 后端，绑定 `ztpp6n6xmz`），否则 Pod 跨节点通信异常。

安装脚本会读取环境变量创建 `k3s-agent.service`，自动以 **agent** 模式运行（设置 `K3S_URL` 后默认即为 agent，无需指定命令）。

> [!NOTE]
>
> 也可用 `/etc/rancher/k3s/config.yaml` 持久化这些参数（`server`、`token`、`node-ip`、`node-external-ip`、`flannel-iface`），效果等价，二者选一即可。

> [!WARNING]
>
> 确认现有节点的 Flannel 配置：执行 `journalctl -u k3s | grep -i flannel`（查看 backend 类型），以及 `cat /etc/rancher/k3s/config.yaml` 确认 `flannel-iface`。集群当前为 `host-gw` 后端，接口为 `ztpp6n6xmz`，新节点必须一致，否则 Pod 网络不通。

### 5.3 验证节点加入

在任意 Server 节点执行：

```bash
sudo kubectl get nodes
```

应看到新节点处于 `Ready` 状态，角色为 `<none>`（工作节点）：

```
NAME            STATUS   ROLES    AGE   VERSION
hyperbola-server Ready   control-plane,master ...
hyperbola-txy    Ready   control-plane,master ...
hyperbola-aly    Ready   control-plane,master ...
hyqaq-wsl        Ready   <none>   1m    v1.xx.x
```

---

## 六、部署 etcd、PostgreSQL 与 Patroni

### 6.1 部署 etcd（第 4 个成员）

Patroni 依赖 etcd 作为 DCS 存储集群状态，20 节点需要**本地运行 etcd** 并作为第 4 个成员加入现有集群。

安装：

```bash
sudo apt update
sudo apt install -y etcd-server etcd-client
```

在**现有 etcd 集群任一节点**（如 `10.0.0.10`）注册新成员：

```bash
etcdctl --endpoints=http://10.0.0.10:3379 member add etcd-20 --peer-urls=http://10.0.0.20:3380
```

> [!WARNING]
>
> 输出会包含 `ETCD_INITIAL_CLUSTER` 完整列表（含新成员）和新的 `ETCD_INITIAL_CLUSTER_STATE="existing"`，**保存输出**，下一步配置需要。

编辑 `/etc/default/etcd`（以 `10.0.0.20` 为例，与现有 `10.0.0.10` 配置对齐：peer 端口 `3380`、token `pg-cluster-token`、启用 v2 API）：

```ini
ETCD_NAME="etcd-20"
ETCD_INITIAL_CLUSTER="etcd-10=http://10.0.0.10:3380,etcd-30=http://10.0.0.30:3380,etcd-40=http://10.0.0.40:3380,etcd-20=http://10.0.0.20:3380"
ETCD_LISTEN_CLIENT_URLS="http://10.0.0.20:3379,http://127.0.0.1:3379"
ETCD_LISTEN_PEER_URLS="http://10.0.0.20:3380"
ETCD_ADVERTISE_CLIENT_URLS="http://10.0.0.20:3379"
ETCD_INITIAL_ADVERTISE_PEER_URLS="http://10.0.0.20:3380"

ETCD_ENABLE_V2="true"
ETCD_DATA_DIR="/var/lib/etcd/default"
ETCD_INITIAL_CLUSTER_STATE="existing"
ETCD_INITIAL_CLUSTER_TOKEN="pg-cluster-token"
```

启动并验证：

```bash
sudo systemctl enable --now etcd
etcdctl --endpoints=http://10.0.0.20:3379 endpoint health
etcdctl --endpoints=http://10.0.0.10:3379,http://10.0.0.20:3379 member list
```

> [!NOTE]
>
> 客户端端口 `3379` 与现有集群一致（避免与 K3s 的 `2379` 冲突）。20 节点本地 etcd 起来后，Patroni 的 `etcd3.hosts` 可加入本机地址。

#### 其他 3 台主机的配合配置

20 作为第 4 个 etcd 成员加入后，`10.0.0.10`、`10.0.0.30`、`10.0.0.40` 三台主机的 **etcd 与 Patroni 配置也需要更新**：

**1. etcd `ETCD_INITIAL_CLUSTER` 追加 `etcd-20`**

`member add` 后现有成员虽然能通过 etcd API 实时感知新成员，但为了重启后静态配置与当前成员一致，建议在三台主机的 `/etc/default/etcd` 中将 `etcd-20` 加入 `ETCD_INITIAL_CLUSTER`：

```ini
ETCD_INITIAL_CLUSTER="etcd-10=http://10.0.0.10:3380,etcd-30=http://10.0.0.30:3380,etcd-40=http://10.0.0.40:3380,etcd-20=http://10.0.0.20:3380"
```

> [!WARNING]
>
> 三台主机逐一修改后需重启 etcd 使配置生效。etcd 是分布式一致存储，**逐台重启**（先重启一台，确认集群健康后再重启下一台），始终保持 quorum（4 节点 quorum = 3），切勿同时重启导致集群不可用。`ETCD_INITIAL_CLUSTER_STATE` 保持各节点原来的 `new`（仅新成员 `etcd-20` 用 `existing`）。

**2. Patroni `etcd3.hosts` 追加 `10.0.0.20:3379`**

在三台主机的 `/etc/patroni/config.yml` 中，将 `etcd3.hosts` 更新为（注意后端是 `etcd3:`，不是 `etcd:`）：

```yaml
etcd3:
  hosts: 10.0.0.10:3379,10.0.0.30:3379,10.0.0.40:3379,10.0.0.20:3379
```

然后重载 Patroni（无需重启，改配置后 `patronictl reload` 或 `systemctl reload patroni`）：

```bash
sudo systemctl reload patroni
```

> [!NOTE]
>
> 这样任意一台 etcd 故障时，Patroni 可自动切换到存活节点，提升 DCS 可用性。

**3. HAProxy 与 Keepalived**

见第七节——三台主机的 HAProxy / Keepalived **无需任何改动**，`10.0.0.20` 不加入任何后端。

### 6.2 安装 PostgreSQL 17

```bash
sudo apt install -y postgresql-17
```

### 6.3 安装 Patroni

直接使用 Debian 13 的 APT 包即可，`patroni` 加上 `python3-etcd3`、`python3-etcd` 依赖足够：

```bash
sudo apt install -y patroni python3-etcd3 python3-etcd
```

验证 etcd 驱动可用：

```bash
python3 -c "from patroni.dcs.etcd import Etcd; print('etcd driver OK')"
```

### 6.4 配置 Patroni

编辑 `/etc/patroni/config.yml`：

```yaml
---
scope: pg-cluster
namespace: /db/
name: pg-20

restapi:
  listen: 10.0.0.20:8008
  connect_address: 10.0.0.20:8008

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
        wal_keep_size: 128
        max_wal_senders: 10
        max_replication_slots: 10
        synchronous_commit: "remote_apply"
        synchronous_standby_names: "*"
  pg_hba:
    - local all all trust
    - host all all 0.0.0.0/0 md5
    - host replication all 0.0.0.0/0 md5


postgresql:
  listen: 10.0.0.20:5432
  connect_address: 10.0.0.20:5432
  data_dir: /var/lib/postgresql/17/main
  conf_dir: /etc/postgresql/17/main
  bin_dir: /usr/lib/postgresql/17/bin
  pgpass: /tmp/pgpass
  authentication:
    replication:
      username: replicator
      password: '@512710&Sql'
    superuser:
      username: postgres
      password: '@512710&Sql'
  parameters:
    unix_socket_directories: '/var/run/postgresql'

tags:
  nofailover: true    # 备份节点，永不参与选主，不能成为 Leader
  clonefrom: false
  failover-priority: 10
```

**配置要点：**

- **`etcd3:` 后端（关键，不要写成 `etcd:`）**：与现有集群节点完全一致，Patroni 通过 etcd **v3** API 读取 DCS。若误用 `etcd:`（v2 API），会读不到 `leader`/`config`/`status` 等键，导致 Patroni 认为集群未初始化、一直卡在 `waiting for leader to bootstrap`；
- `etcd3.hosts` 包含现有三节点 etcd 与本机 etcd（`10.0.0.20:3379`），本地有 etcd 后 Patroni 优先连本机，故障时可切换到其他节点；
- `bootstrap.dcs` 需与集群其他节点**逐字段一致**（含 `retry_timeout`），这是 Patroni DCS 初始化必需的；加入已有集群时该段用于对齐配置而非重新初始化；
- `postgresql.conf_dir` 指向 `/etc/postgresql/17/main`（Debian 包路径），缺失会导致 PG 启动异常；
- `name` 必须唯一，这里是 `pg-20`；
- `restapi` / `postgresql` 的监听地址均使用 ZeroTier 内网 IP `10.0.0.20`，确保其他节点可达；
- **`nofailover: true`**：标记为永不参与选主，即使其他节点全部宕机，`10.0.0.20` 也不会被提升为 Leader；
- `failover-priority: 10` 设为较低值，正常情况下它只是普通副本，不会争夺 Leader。

> [!IMPORTANT]
>
> 新节点配置必须**与现有节点逐字段对齐**（尤其 `etcd3:` vs `etcd:`、`bootstrap.dcs`、`conf_dir`），不要凭印象简化。部署前先 `ssh <现有节点> cat /etc/patroni/config.yml` 对比。

### 6.5 启动 Patroni

**务必清空数据目录**，加入集群时会自动从 Leader 流复制：

```bash
sudo systemctl stop patroni postgresql 2>/dev/null
sudo pkill -9 -u postgres
sudo rm -rf /var/lib/postgresql/17/main
sudo -u postgres mkdir -p /var/lib/postgresql/17/main
sudo chmod 700 /var/lib/postgresql/17/main   # PG 要求 0700/0750，否则启动失败

sudo systemctl daemon-reload
sudo systemctl enable --now patroni
```

> [!NOTE]
>
> Debian 的 `patroni` 软件包自带 systemd unit，但建议手动覆盖 `/etc/systemd/system/patroni.service`，加入 etcd 与 ZeroTier 的启动依赖（本集群其他节点同款配置）：
>
> ```ini
> [Unit]
> Description=Patroni for PostgreSQL HA
> After=network.target etcd.service zerotier-one.service
> Requires=etcd.service
>
> [Service]
> Type=simple
> User=postgres
> Group=postgres
> ExecStart=/usr/bin/patroni /etc/patroni/config.yml
> ExecReload=/bin/kill -HUP $MAINPID
> KillMode=process
> TimeoutSec=30
> Restart=always
> RestartSec=3
>
> [Install]
> WantedBy=multi-user.target
> ```
>
> 关键点：`Requires=etcd.service` 确保本地 etcd 先就绪，`After=zerotier-one.service` 确保 `10.0.0.20` 已分配到网卡，避免 `cannot assign requested address`。

---

## 七、接入 HA：三台主机无需任何调整

`10.0.0.20` 的定位是**纯备份节点**：不承接任何业务流量，不能成为数据库 Leader，也不能成为 VIP 节点。因此：

- **HA/Keepalived 仍由原有三台主机（`10.0.0.10`、`10.0.0.30`、`10.0.0.40`）承担**，`10.0.0.20` **不安装 Keepalived 与 HAProxy**，不参与 VRRP 竞选；
- **三台主机的 HAProxy 后端完全不动**，`pg_write`、`pg_read`、`k3s_servers` 均**不加入 `10.0.0.20`**；
- **三台主机的 Keepalived 配置完全不动**，VIP `10.0.0.100` 只会在三台之间漂移，永远不会到 `10.0.0.20`。

> [!WARNING]
>
> **为什么不在 `pg_read` 后端加 `pg20`？**
>
> 客户端只通过 VIP `10.0.0.100:5433` 访问读库，而 VIP 只存在于三台主机的 Keepalived 上。`10.0.0.20` 作为纯备份节点，平时不承接任何流量，加入读库后端反而会让只读请求分担到一台随时可能因 WSL 睡眠而掉线的节点上，得不偿失。
>
> 20 的价值在于：主链路整体故障时可**手动**拉起恢复，而非自动承接流量。

因此本步骤三台主机**无需任何改动**，保持原有 HA 配置即可。

---

## 八、验证集群状态

### 8.1 PostgreSQL 集群

在任意节点执行：

```bash
sudo patronictl -c /etc/patroni/config.yml list
```

输出应包含新节点：

```
+ Cluster: pg-cluster (...) ----+----+-----------+------------------------+
| Member | Host      | Role      | State     | TL | Lag in MB | Tags      |
+--------+-----------+-----------+-----------+----+-----------+------------+
| pg-10  | 10.0.0.10 | Leader    | running   |  1 |           | prio: 100 |
| pg-30  | 10.0.0.30 | Replica   | streaming |  1 |         0 | prio: 50  |
| pg-40  | 10.0.0.40 | Replica   | streaming |  1 |         0 | prio: 0   |
| pg-20  | 10.0.0.20 | Replica   | streaming |  1 |         0 | prio: 10  |
+--------+-----------+-----------+-----------+----+-----------+------------+
```

`pg-20` 状态为 `streaming`、延迟 0 MB 即为成功加入。

### 8.2 K3s 集群

```bash
sudo kubectl get nodes
sudo kubectl get pods -A -o wide
```

确认 `hyqaq-wsl` 节点 `Ready`，并可调度工作负载。

### 8.3 复制验证

在主库写入数据，副本应实时同步：

```bash
# 在 10.0.0.10 主库
psql -h 10.0.0.10 -U postgres -c "CREATE TABLE IF NOT EXISTS test(id int); INSERT INTO test VALUES (1);"

# 在 10.0.0.20 副本
psql -h 10.0.0.20 -U postgres -c "SELECT * FROM test;"
```

---

## 九、踩坑记录

1. **WSL 必须启用 systemd**  
   若不设置 `systemd=true`，K3s 与 Patroni 都无法以 systemd 服务方式运行，`systemctl` 会报 `System has not been booted with systemd as init system`。

2. **Patroni 依赖 ZeroTier 接口的启动顺序**  
   与集群中 etcd 的问题类似，若 Patroni/PostgreSQL 绑定 `10.0.0.20` 而 ZeroTier 尚未分配该 IP，会报 `cannot assign requested address`。在服务文件中添加依赖：

   ```ini
   After=zerotier-one.service network-online.target
   Requires=zerotier-one.service
   ```

3. **Flannel 接口必须与集群一致**  
   K3s Agent 的 `flannel-iface` 若与现有节点不同（集群使用 `host-gw` 后端），Pod 间通信异常。

4. **WSL 存在双 IP**  
   桥接静态 IP（`192.168.86.22`）与 ZeroTier IP（`10.0.0.20`）并存。集群内一律使用 `10.0.0.20`，Patroni 的 `connect_address` 不能写成 `192.168.86.22`，否则其他节点无法回连。

5. **PostgreSQL 使用 0.0.0.0 监听**  
   若需同时接受桥接网段与 ZeroTier 网段的连接，可让 PostgreSQL 监听 `0.0.0.0`，但 Patroni 的 `connect_address` 仍必须指向 `10.0.0.20`。

6. **etcd 对等端口配置错误导致 Cluster ID Mismatch**  
   `etcd-20` 加入集群时报错，`member list` 中该节点一直处于 `unstarted`。故障原因有两层：

   - **对等端口配置错误**：集群初始元数据中记录的 `etcd-20` 节点对等通信端口为默认的 `2380`，而实际配置文件使用的是 `3380`，导致节点无法与其他成员建立内部通信。
   - **集群 ID 不匹配（Cluster ID Mismatch）**：由于上述网络不通，`etcd-20` 启动时未能成功加入现有集群，而是基于本地残留的旧数据，自行初始化了一个全新的单节点集群。这导致它与其他三个节点拥有完全不同的集群 ID，从而被集群拒绝。

   恢复步骤：

   ```bash
   # 1. 在健康节点上移除错误成员
   etcdctl --endpoints=http://10.0.0.10:3379 member remove <错误memberID>

   # 2. 重新添加成员，指定正确的对等地址（端口 3380）
   etcdctl --endpoints=http://10.0.0.10:3379 member add etcd-20 --peer-urls=http://10.0.0.20:3380

   # 3. 在故障节点（10.0.0.20）上停止服务并清理旧数据
   sudo systemctl stop etcd
   sudo rm -rf /var/lib/etcd/default

   # 4. 确认配置中 ETCD_INITIAL_CLUSTER_STATE="existing"，重启并验证
   sudo systemctl start etcd
   etcdctl --endpoints=http://10.0.0.20:3379 endpoint health
   etcdctl --endpoints=http://10.0.0.10:3379,http://10.0.0.20:3379 member list
   ```

   `member list` 中该节点状态应变为 `started`，集群恢复健康。

   > [!TIP]
   >
   > `member add` 的输出会给出 `ETCD_INITIAL_CLUSTER` 与新的成员 ID，务必保存并严格按输出配置 `ETCD_INITIAL_CLUSTER_STATE="existing"`。一旦以错误端口/旧数据启动过，先 `member remove` + 清理数据目录再重来，不要直接叠加。

7. **二次踩坑：AI 重构步骤时"掐头去尾"，遗漏关键配置导致 Cluster ID Mismatch 复现**  
   明明旧文档踩坑记录里已经写过 Cluster ID Mismatch，实际部署时还是**再次踩坑**，且根因不止一个。原因是：**用 AI 重构部署步骤时，将配置"掐头去尾"了**——只保留了看起来"核心"的部分，遗漏了与现有集群保持一致的关键项。

   本次复现的实际故障链（三层）：

   - **etcd 旧数据残留（Cluster ID Mismatch）**：20 的 etcd 数据目录 `/var/lib/etcd/default` 里残留了之前以错误端口初始化的单节点集群数据（cluster-id `16f1bc0c8e86d48e`），与主集群 cluster-id（`7667324251917980557`）不符。etcd 启动后恢复本地旧数据，被主集群以 `rejected Raft message to mismatch member` 拒绝，随后**正常退出**（日志是 `Deactivated successfully`，非崩溃，极具迷惑性）。

   - **Patroni 误用 `etcd:` 后端而非 `etcd3:`**：这是最隐蔽的一层。集群其他节点（如 txy）的配置用的是 **`etcd3:`**（Patroni 走 etcd **v3** API），而重构后的 20 配置用的是 **`etcd:`**（Patroni 默认走 etcd **v2** API）。主集群的 etcd 虽开启 `ETCD_ENABLE_V2="true"`，但 **v2 API 下 `/db/pg-cluster/` 只有 `members` 和 `initialize`，读不到 `leader`、`config`、`status`**。于是 20 的 Patroni 能连上 etcd、却认为集群从未初始化，一直卡在 `waiting for leader to bootstrap`（`Lock owner: None`），甚至报出与主集群不同的 cluster ID。

   - **数据目录权限（附带）**：重建 `/var/lib/postgresql/17/main` 时默认权限 `755`，PostgreSQL 要求 `0700`/`0750`，导致 PG 启动 `FATAL: data directory has invalid permissions`。

   排查过程关键命令：

   ```bash
   # 1. 先看 etcd 成员状态 —— 发现 20 是 unstarted
   etcdctl --endpoints=http://10.0.0.10:3379,http://10.0.0.30:3379,http://10.0.0.40:3379 member list
   # → db828958631541e5, unstarted, , http://10.0.0.20:3380

   # 2. 看 20 的 etcd 启动日志 —— 发现本地旧数据 + mismatch
   journalctl -u etcd -n 30 --no-pager
   # → server has been already initialized / cluster-id 16f1bc0c...
   # → rejected Raft message to mismatch member / Deactivated successfully

   # 3. 对比正常节点（txy）的 Patroni 配置 —— 发现 etcd3: vs etcd:
   sudo cat /etc/patroni/config.yml   # 正常节点用 etcd3:

   # 4. v2 vs v3 视角对比 etcd 数据 —— 确认 v2 读不到 leader/config/status
   etcdctl --endpoints=http://10.0.0.20:3379 get /db --prefix --keys-only   # v3，数据完整
   ETCDCTL_API=2 etcdctl --endpoints=http://10.0.0.20:3379 ls /db/pg-cluster/   # v2，只有 members/initialize
   ```

   修复步骤（按顺序）：

   ```bash
   # 1. 停服务
   sudo systemctl stop patroni
   sudo systemctl stop etcd

   # 2. 清空 etcd 旧数据（Cluster ID Mismatch 根因）
   sudo mv /var/lib/etcd/default /var/lib/etcd/default.bak
   sudo mkdir -p /var/lib/etcd/default && sudo chown etcd:etcd /var/lib/etcd/default

   # 3. 启动 etcd，确认成员 started
   sudo systemctl start etcd
   etcdctl --endpoints=http://10.0.0.20:3379 endpoint health

   # 4. 修正 Patroni 配置：etcd: → etcd3:，补齐 bootstrap.dcs / conf_dir / retry_timeout
   sudo tee /etc/patroni/config.yml << 'EOF'
   # ... 与正常节点完全对齐：etcd3: + bootstrap.dcs + postgresql.conf_dir 等
   EOF

   # 5. 修正数据目录权限（PG 要求 0700/0750）
   sudo chmod 700 /var/lib/postgresql/17/main
   sudo chown -R postgres:postgres /var/lib/postgresql/17/main

   # 6. 启动 patroni，从 Leader 自动 pg_basebackup 加入
   sudo systemctl start patroni
   sudo patronictl -c /etc/patroni/config.yml list
   # → pg-20 Replica running, TL 24, Lag 0 MB
   ```

   > [!IMPORTANT]
   >
   > **教训：新增节点的配置必须与现有集群节点"逐字段对齐"，而不是凭印象重写。** Patroni 的 DCS 后端（`etcd3:` vs `etcd:`）、`bootstrap.dcs`、`postgresql.conf_dir`、端口、token 等任何一个被"掐头去尾"地省略，都会导致节点无法正确加入集群，且报错极具迷惑性（etcd 正常退出、Patroni 卡 bootstrap、cluster ID 不同）。部署新节点前，务必 `ssh 现有节点 cat /etc/patroni/config.yml` 逐项对比。

---

## 十、总结

通过 ZeroTier，WSL2 主机顺利加入了既有高可用集群：

- **K3s Agent** 作为工作节点，接入现有控制面，可承载业务负载；
- **Patroni + PostgreSQL** 作为 Replica，通过现有 etcd 协调并实时从 Leader 流复制，`nofailover: true` + `failover-priority` 低位确保其**永不成为 Leader**；
- **接入 HA**：三台主机的 HAProxy / Keepalived **完全不变**，`10.0.0.20` 不加入任何后端、不安装 HA/Keepalived，**永不持有 VIP**。

至此，集群从三节点扩展为四节点。`10.0.0.20` 作为**纯备份节点**定位明确：不承接任何业务流量，不参与数据库选主，也不参与 VIP 竞选，仅在主链路整体故障时手动拉起恢复，故障时不影响主链路高可用。
