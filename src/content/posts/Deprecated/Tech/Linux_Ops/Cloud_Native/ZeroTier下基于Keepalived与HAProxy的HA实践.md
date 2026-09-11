---
title: ZeroTier 内网下，基于 Keepalived + HAProxy 的 PostgreSQL 读写分离与 K3s 高可用实践
published: 2026-07-28
updated: 2026-08-19
pinned: false
description: 在三台 Debian 云主机间用 ZeroTier 建立二层网络，部署 Patroni 管理的 PostgreSQL 流复制集群与 K3s 控制平面，再用 Keepalived 与 HAProxy 实现虚拟 IP 入口、读写分离和 API Server 高可用
tags: [Networking, High_Availability]
category: Networking
author: Hyperbola
draft: false
---

> **声明**：本文档记录的方案已不再是作者当前在生产环境中使用的方案。本文仅作历史演进参考。

在多云、跨地域的轻量级高可用场景中，我们经常需要将分散的云主机通过隧道组成一个虚拟内网，并在此之上搭建数据库集群和容器编排系统。本文记录了一次完整实践：在三台 Debian 云主机之间使用 **ZeroTier** 建立二层网络，部署 Patroni 管理的 PostgreSQL 流复制集群以及 K3s 控制平面，然后**利用 Keepalived 和 HAProxy 构建一个虚拟 IP 入口，同时实现 PostgreSQL 读写分离和 K3s API Server 高可用代理**。

与常见的 WireGuard 方案不同，ZeroTier 原生提供二层以太网，支持 ARP 和多播，理论上 VRRP 可直接使用多播模式。但本实践为更稳定可控，Keepalived 采用了 **单播 VRRP**（`unicast_src_ip` + `unicast_peer`），避免个别网络环境下多播包传播不稳定带来的误判。

---

## 一、背景与集群拓扑

**节点信息：**

| 主机名           | 内网 IP (ztpp6n6xmz) | 角色                               |
| ---------------- | -------------------- | ---------------------------------- |
| hyperbola-server | 10.0.0.10            | Patroni Leader、K3s control-plane  |
| hyperbola-txy    | 10.0.0.30            | Patroni Replica、K3s control-plane |
| hyperbola-aly    | 10.0.0.40            | Patroni Replica、K3s control-plane |

- 三节点通过 ZeroTier 组成 `/24` 的内网，接口名为 `ztpp6n6xmz`（由网络 ID 决定，这里以 `ztpp6n6xmz` 为例）。
- PostgreSQL 集群由 Patroni 管理，使用 `patronictl list` 可查看角色。
- K3s 集群有三个 etcd+control-plane 节点。
- 目标：提供一个统一的 **VIP 10.0.0.100**，对外暴露以下服务：
  - **5432 端口** → PostgreSQL 写库（自动指向 Leader）
  - **5433 端口** → PostgreSQL 读库（负载均衡到 Replica）
  - **6443 端口** → K3s API Server（四层代理）

---

## 二、整体架构

```
         ┌─────────────────────────────────┐
         │  keepalived (VIP 高可用)         │
         │  HAProxy  (四层代理 + 健康检查)  │
         └──────────┬──────────────────────┘
                    │ VIP: 10.0.0.100 (ztpp6n6xmz)
         ┌──────────┼──────────┐
         ▼          ▼          ▼
  10.0.0.10     10.0.0.30    10.0.0.40
  (server)      (txy)        (aly)
  [Leader]      [Replica]    [Replica]
  [K3s CP]      [K3s CP]     [K3s CP]
```

**设计要点：**

- **Keepalived** 通过 VRRP 通告（本实践为单播）管理 VIP，选择一台节点作为 MASTER，其余为 BACKUP。接口故障（如 `ztpp6n6xmz` down）会立即触发降级，避免等待超时。
- **HAProxy** 仅在 MASTER 节点上运行，监听 VIP 的三个端口，根据后端健康检查动态路由流量。
- 健康检查直接调用 Patroni REST API（`/master`、`/replica`），实现完全自动化的读写分离。

---

## 三、基础准备

### 3.1 加入 ZeroTier 网络

在所有节点上安装 ZeroTier 并加入同一个网络（示例网络 ID 为 `8056c2e21c000001`，实际使用您的网络 ID）：

```bash
curl -s https://install.zerotier.com | sudo bash
sudo zerotier-cli join <network_id>
# 在 ZeroTier Central 管理后台授权节点，并确保它们获得预期的 IP（如 10.0.0.10、10.0.0.30、10.0.0.40）
sudo zerotier-cli listnetworks   # 查看接口名称，通常为 zt<网络ID前10位>
```

假设生成的接口名为 `ztpp6n6xmz`，后续所有配置均使用该名称。

### 3.2 安装 HAProxy 与 Keepalived

```bash
sudo apt update
sudo apt install -y haproxy keepalived

# 允许绑定非本机 IP（HAProxy 需要监听 VIP）
echo "net.ipv4.ip_nonlocal_bind=1" | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

# 停止并禁用这两个服务，后续由 keepalived 控制 HAProxy 启停
sudo systemctl stop haproxy keepalived
sudo systemctl disable haproxy keepalived
```

---

## 四、HAProxy 配置：实现读写分离

**文件：`/etc/haproxy/haproxy.cfg`** （三台节点相同）

```bash
global
    log /dev/log local0
    maxconn 4096
    user haproxy
    group haproxy
    daemon

defaults
    mode tcp
    timeout connect 5s
    timeout client 30m
    timeout server 30m

# ---------- PostgreSQL 读写分离 ----------
frontend psql_write
    bind 10.0.0.100:5432
    mode tcp
    default_backend pg_write

frontend psql_read
    bind 10.0.0.100:5433
    mode tcp
    default_backend pg_read

# ---------- K3s API Server ----------
frontend k8s_api
    bind 10.0.0.100:6443
    mode tcp
    default_backend k3s_servers

# ---------- 后端定义 ----------
backend pg_write   # 写库：只有 Patroni Leader 存活
    mode tcp
    option httpchk GET /master
    http-check expect status 200
    default-server inter 3s fall 3 rise 2
    server pg10 10.0.0.10:5432 check port 8008
    server pg30 10.0.0.30:5432 check port 8008
    server pg40 10.0.0.40:5432 check port 8008

backend pg_read    # 读库：所有 Replica（Leader 会自动被 /replica 剔除）
    mode tcp
    option httpchk GET /replica
    http-check expect status 200
    default-server inter 3s fall 3 rise 2
    server pg10 10.0.0.10:5432 check port 8008
    server pg30 10.0.0.30:5432 check port 8008
    server pg40 10.0.0.40:5432 check port 8008

backend k3s_servers
    mode tcp
    balance roundrobin
    option tcp-check
    server srv10 10.0.0.10:6443 check
    server srv30 10.0.0.30:6443 check
    server srv40 10.0.0.40:6443 check
```

**关键机制：**

- Patroni 默认在 `8008` 端口提供 REST API，`/master` 仅在 Leader 返回 200，`/replica` 仅在 Replica 返回 200。
- HAProxy 利用 `httpchk` 动态探测，自动将写请求导向 Leader，读请求分发到所有副本。
- K3s 后端仅使用 TCP 端口检查，保证 API Server 可达。

---

## 五、Keepalived 配置：VIP 高可用与 HAProxy 联动

ZeroTier 是**二层虚拟以太网**，理论上原生支持多播、可直接使用默认的 VRRP 多播模式。但本实践为稳定起见采用**单播 VRRP**：通过 `unicast_src_ip` 指定本机源 IP，`unicast_peer` 列出对端节点 IP，三个节点间单播互发通告。这样不依赖多播包在 ZeroTier 中的传播，排障更直观。

### 5.1 健康检查脚本

**文件：`/etc/keepalived/chk_haproxy.sh`** （三台节点相同，需 `chmod +x`）

```bash
#!/bin/bash
# 检查 haproxy 进程是否存活
if systemctl is-active --quiet haproxy; then
  exit 0
else
  exit 1
fi
```

该脚本供 `track_script` 调用，如果 haproxy 意外停止，Keepalived 会降低本节点优先级，促使 VIP 漂移到其他健康节点。

### 5.2 通知脚本

**文件：`/etc/keepalived/notify.sh`** （三台节点相同，需 `chmod +x`）

```bash
#!/bin/bash
VIP="10.0.0.100"
DEV="ztpp6n6xmz"   # 使用 ZeroTier 接口名

case "$1" in
    master)
        sleep 1
        ip addr show $DEV | grep -q $VIP || exit 1
        systemctl start haproxy
        # 发送 gratuitous ARP，通知同网段其他节点 VIP 已漂移到本机 MAC
        # 避免其他节点 ARP 缓存残留旧 MASTER 的 MAC，导致 ICMP Redirect 或短暂不通
        ip neigh flush dev $DEV
        arping -c 5 -A -I $DEV $VIP 2>/dev/null || \
        arping -c 5 -U -I $DEV $VIP 2>/dev/null || true
        logger "keepalived: transition to MASTER, haproxy started, gratuitous ARP sent"
        ;;
    backup)
        systemctl stop haproxy
        logger "keepalived: transition to BACKUP, haproxy stopped"
        ;;
    fault)
        systemctl stop haproxy
        logger "keepalived: transition to FAULT, haproxy stopped"
        ;;
    *)
        echo "Usage: $0 {master|backup|fault}"
        exit 1
        ;;
esac
```

> **注意**：`arping` 由 `iputils-arping` 提供，需先安装：`sudo apt install -y iputils-arping`。`-A` 为免费 ARP（announce），`-U` 为更新通告，部分版本需用其一。

该脚本确保 **VIP 到达哪个节点，哪个节点的 HAProxy 就启动**，避免多个节点同时监听 VIP 导致端口冲突。

### 5.3 Keepalived 主配置

三台节点的配置结构完全相同，仅 `priority` 不同。
下面以 **hyperbola-server (10.0.0.10)** 为例，配置中包含了详细注释。

**`/etc/keepalived/keepalived.conf`：**

```nginx
# 定义健康检查脚本，供 track_script 引用
vrrp_script chk_haproxy {
    script "/etc/keepalived/chk_haproxy.sh"   # 检查 haproxy 是否存活
    interval 2                                # 每 2 秒执行一次
    weight -20                                # 失败时优先级减 20，让其他节点更容易抢占
    fall 3                                    # 连续失败 3 次才认为故障
    rise 2                                    # 连续成功 2 次才恢复健康
}

vrrp_instance VI_PG {
    state BACKUP                   # 所有节点都设为 BACKUP，依靠优先级竞选 Master
    interface ztpp6n6xmz          # ZeroTier 虚拟网卡接口
    virtual_router_id 51           # 同一 VRRP 组必须相同
    priority 100                   # 最高优先级，默认成为 Master
    advert_int 1                   # 通告间隔（秒）
    unicast_src_ip 10.0.0.10       # 本节点发送 VRRP 通告的源 IP
    unicast_peer {
        10.0.0.30                  # 对端节点 IP
        10.0.0.40
    }
    authentication {
        auth_type PASS
        auth_pass 51275127         # 所有节点必须一致
    }
    virtual_ipaddress {
        10.0.0.100/32 dev ztpp6n6xmz  # 虚拟 IP，仅 Master 持有
    }
    track_interface {
        ztpp6n6xmz                 # 监控 ZeroTier 接口，若 down 立即降级
    }
    track_script {
        chk_haproxy                # 引用上方健康检查脚本
    }
    notify "/etc/keepalived/notify.sh"  # 状态变化时调用通知脚本
}
```

**其他节点修改示例：**

- **hyperbola-txy**：`priority 90`，`unicast_src_ip 10.0.0.30`，`unicast_peer { 10.0.0.10 10.0.0.40 }`
- **hyperbola-aly**：`priority 80`，`unicast_src_ip 10.0.0.40`，`unicast_peer { 10.0.0.10 10.0.0.30 }`

> **重要**：所有节点上必须创建 `chk_haproxy.sh` 和 `notify.sh` 并赋予执行权限（`chmod +x`），否则 Keepalived 会因为脚本缺失而进入 FAULT 状态。

---

## 六、启动与调优

### 6.1 启动服务

在三台机器上执行：

```bash
sudo systemctl start keepalived
```

不要手动启动 HAProxy，它会被 `notify.sh` 自动拉起。

查看 VIP 所在节点：

```bash
ip addr show ztpp6n6xmz | grep 10.0.0.100
```

正常情况下只有优先级最高的节点显示该 IP。

### 6.2 ZeroTier 的网络特性

与 WireGuard 不同，ZeroTier 提供的是二层以太网，VIP 的 ARP 能被所有节点学习，无需额外配置路由或允许 IP 段。本实践 Keepalived 使用单播 VRRP（`unicast_src_ip` + `unicast_peer`），节点间直接互发通告，不依赖多播。仍需确保：

- 所有节点的 ZeroTier 接口已加入同一网络且 IP 规划正确。
- ZeroTier 后台管理页面已授权所有节点通信（默认桥接模式即可）。

### 6.3 解决 K3s 证书信任问题

虽然四层代理已经可以转发流量到 API Server，但 TLS 证书未包含 VIP `10.0.0.100`，kubectl 会报 `x509: certificate is valid for ... not 10.0.0.100` 错误。需要在三台 K3s 节点的配置中添加 SAN：

```bash
sudo mkdir -p /etc/rancher/k3s
cat <<EOF | sudo tee /etc/rancher/k3s/config.yaml
tls-san:
  - 10.0.0.100
EOF

# 删除动态证书缓存并逐台重启 K3s（注意保持 etcd quorum）
sudo rm -f /var/lib/rancher/k3s/server/tls/dynamic-cert.json
sudo systemctl restart k3s
```

---

## 七、验证与测试

### 7.1 PostgreSQL 读写分离

```bash
# 写库测试（应返回 f）
psql -h 10.0.0.100 -p 5432 -U postgres -c "select pg_is_in_recovery();"

# 读库测试（应返回 t）
psql -h 10.0.0.100 -p 5433 -U postgres -c "select pg_is_in_recovery();"
```

实际测试结果：

```
pg_is_in_recovery
-------------------
 f
(1 row)

pg_is_in_recovery
-------------------
 t
(1 row)
```

证明写请求准确路由到 Leader，读请求落到了某个 Replica。

### 7.2 K3s API 高可用

```bash
kubectl get nodes --server https://10.0.0.100:6443
```

能够正常列出节点，无证书错误。也可将 kubeconfig 中的 server 地址永久改为 `https://10.0.0.100:6443`。

### 7.3 故障模拟

- **停止当前 MASTER 的 haproxy**：`sudo systemctl stop haproxy`  
  → 健康检查失败，优先级降低，VIP 漂移到次高优先级节点，新 MASTER 自动启动 haproxy，服务恢复。
- **断开当前 MASTER 的 ZeroTier 连接**（如 `sudo zerotier-cli leave <network_id>` 或关闭接口）  
  → 接口监控立即触发降级，VIP 秒级漂移，整个过程对客户端透明。

---

## 八、踩坑记录与最佳实践

1. **ZeroTier 是 VRRP 的理想承载层**  
   WireGuard 是三层隧道，不支持多播和 ARP 广播，导致 VIP 必须通过单播 VRRP 和额外的路由配置才能工作(sudo wg set)，且客户端解析 VIP 时容易出问题。切换为 ZeroTier 后这些问题缓解；本实践沿用**单播 VRRP**（`unicast_src_ip` + `unicast_peer`），比多播更稳定可控。

2. **Keepalived 配置必须完整**  
   缺少 `track_interface` 会导致接口 down 时无法立即切换；缺少健康检查脚本或 `track_script` 引用会使实例进入 FAULT；未配置 `notify` 指令则通知脚本永远不会执行。三要素缺一不可。

3. **接口名称一致性**  
   ZeroTier 的接口名称由网络 ID 决定，不同设备上可能不同（如 `zt7ufxgkl3`），建议在每台机器上确认接口名，并统一写入 keepalived 配置。或者通过 ZeroTier 的 `local.conf` 固定接口名称。

4. **VIP 单点存在是正常现象**  
   所有 BACKUP 节点不会持有 VIP，这是 VRRP 的正常表现，不必担心。

5. **证书规划**  
   如果 K3s 部署时未预知 VIP 地址，后期添加 SAN 需重启集群，建议在部署初期就规划好所有可能的访问入口。

6. **etcd 依赖 ZeroTier 接口：服务已启动不代表地址已就绪**
   在把 WSL2 节点 `10.0.0.20` 加入 Patroni 后，出现了一个容易误判的故障：`patronictl list` 中没有 `pg-20`，而 Patroni 本身只显示依赖失败。

   ```text
   Dependency failed for patroni.service - Patroni for PostgreSQL HA.
   patroni.service: Job patroni.service/start failed with result 'dependency'.
   ```

   `patroni.service` 配置了 `Requires=etcd.service`，继续检查 etcd 才找到真正的错误：

   ```text
   creating peer listener failed
   listen tcp 10.0.0.20:3380: bind: cannot assign requested address
   etcd.service: Main process exited, code=exited, status=1/FAILURE
   ```

   对照本次启动的 monotonic 日志可以还原竞态过程：
   - 开机约 12.2 秒时，etcd 开始绑定 `10.0.0.20:3380`；
   - 约 12.4 秒时绑定失败，Patroni 随即因 etcd 依赖失败而停止启动；
   - 约 13.9 秒时，ZeroTier 接口 `ztpp6n6xmz` 才 Link UP 并获得地址；
   - etcd 原配置为 `Restart=on-abnormal`，退出码 1 不属于该策略覆盖的异常终止，因此之后没有自动重试。

   这里有两个不同层次的就绪条件：
   1. `zerotier-one.service` 进入 active；
   2. ZeroTier 完成控制面连接、创建虚拟接口并分配 `10.0.0.x`。

   `After=zerotier-one.service` 只能保证第一层，不能保证第二层。最终在所有 etcd 节点上使用 systemd drop-in：既声明强依赖，也在启动前等待本机的 ZeroTier 地址。

   ```ini
   # /etc/systemd/system/etcd.service.d/zerotier.conf
   [Unit]
   Requires=zerotier-one.service
   After=zerotier-one.service

   [Service]
   ExecStartPre=/bin/sh -c 'for i in $(seq 1 60); do /usr/sbin/ip -4 address show dev ztpp6n6xmz 2>/dev/null | /usr/bin/grep -q "inet 10.0.0.20/" && exit 0; sleep 1; done; echo "Timed out waiting for ZeroTier address 10.0.0.20 on ztpp6n6xmz" >&2; exit 1'
   Restart=on-failure
   RestartSec=3s
   ```

   `10.0.0.20` 应替换为各节点在 `/etc/default/etcd` 的 `ETCD_LISTEN_PEER_URLS` 中配置的地址。使用 drop-in 而不是直接编辑 `/usr/lib/systemd/system/etcd.service`，可以避免软件包升级覆盖修改；systemd 会将 drop-in 合并进原 unit，依赖语义完全相同。

   本集群通过 Ansible 的 `servers` 组统一发布。由于 etcd 依赖多数派，不能同时重启所有成员，play 必须设置 `serial: 1`，每次仅处理一台，并确认本地端点恢复健康后再继续下一台：

   ```yaml
   ---
   - name: Make etcd wait for the ZeroTier address
     hosts: servers
     become: true
     serial: 1
     tasks:
       - name: Read etcd peer address
         ansible.builtin.shell: |
           set -o pipefail
           sed -n 's|^ETCD_LISTEN_PEER_URLS="http://\([^:]*\):.*|\1|p' /etc/default/etcd
         args:
           executable: /bin/bash
         register: etcd_peer_address
         changed_when: false
         failed_when: not (etcd_peer_address.stdout is match('^[0-9]+(\.[0-9]+){3}$'))

       - name: Create etcd systemd drop-in directory
         ansible.builtin.file:
           path: /etc/systemd/system/etcd.service.d
           state: directory
           owner: root
           group: root
           mode: "0755"

       - name: Install ZeroTier readiness drop-in
         ansible.builtin.copy:
           dest: /etc/systemd/system/etcd.service.d/zerotier.conf
           owner: root
           group: root
           mode: "0644"
           content: |
             [Unit]
             Requires=zerotier-one.service
             After=zerotier-one.service

             [Service]
             ExecStartPre=/bin/sh -c 'for i in $(seq 1 60); do /usr/sbin/ip -4 address show dev ztpp6n6xmz 2>/dev/null | /usr/bin/grep -q "inet {{ etcd_peer_address.stdout }}/" && exit 0; sleep 1; done; echo "Timed out waiting for ZeroTier address {{ etcd_peer_address.stdout }} on ztpp6n6xmz" >&2; exit 1'
             Restart=on-failure
             RestartSec=3s
         register: etcd_dropin

       - name: Reload systemd configuration
         ansible.builtin.systemd_service:
           daemon_reload: true
         when: etcd_dropin.changed

       - name: Restart etcd
         ansible.builtin.systemd_service:
           name: etcd.service
           state: restarted
           enabled: true
         when: etcd_dropin.changed

       - name: Wait for etcd health
         ansible.builtin.uri:
           url: http://127.0.0.1:3379/health
           return_content: true
         register: etcd_health
         retries: 20
         delay: 1
         until:
           - etcd_health.status == 200
           - "'\"health\":\"true\"' in etcd_health.content"
   ```

   发布后检查 systemd 合并结果和集群状态：

   ```bash
   systemctl show etcd -p Requires -p After -p Restart -p ExecStartPre
   curl -fsS http://127.0.0.1:3379/health
   sudo patronictl -c /etc/patroni/config.yml list
   ```

   最终四台节点的 `zerotier-one`、`etcd`、`patroni` 均为 `active`，etcd 健康检查全部返回 `{"health":"true"}`；`pg-20` 重新以 Replica 身份加入，状态为 `streaming`，复制延迟为 0 MB。

7. **VIP 消失：keepalived 服务被禁用 + notify.sh 残留旧接口名**  
   现象：集群中三台主机的 keepalived 均已安装配置，但 `ip addr show ztpp6n6xmz` 上看不到 VIP `10.0.0.100`，访问 `10.0.0.100:5432`（写）、`:5433`（读）、`:6443`（K3s API）全部失败。

   排查过程：
   - 三台 `systemctl is-active keepalived` 均为 `inactive`，`is-enabled` 为 `disabled` —— **keepalived 服务根本没运行**；
   - 配置文件和脚本（`keepalived.conf`、`chk_haproxy.sh`、`notify.sh`）都完好，权限正确；
   - 启动 keepalived 后 VIP 出现，但 haproxy 未被自动拉起，`5432` 仍不通。

   根因有三个：
   - **keepalived 服务被禁用**：历史操作中（如文档"停止并禁用 haproxy keepalived，由 keepalived 控制 HAProxy 启停"的某次执行）把 keepalived 也停用且未再启用，导致 VRRP 从未运行；
   - **`notify.sh` 中 `DEV="wg0"` 残留**：从 WireGuard（接口 `wg0`）迁移到 ZeroTier（接口 `ztpp6n6xmz`）后，notify.sh 里的 `DEV` 没同步更新。进入 MASTER 状态时执行 `ip addr show wg0` 失败 → `exit 1` → **永远不会启动 haproxy**；
   - **`priority` 配置与设计不符**：实际为 server=100、txy=100（平级）、aly=30，无法保证 server 优先。应改为 server=100、txy=90、aly=80。

   修复步骤：

   ```bash
   # 1. 修正三台 notify.sh 的接口名（wg0 → ztpp6n6xmz）
   sudo sed -i 's/DEV="wg0"/DEV="ztpp6n6xmz"/' /etc/keepalived/notify.sh

   # 2. 修正优先级（server=100、txy=90、aly=80）
   #    在 txy 上：sed -i 's/priority 100/priority 90/' /etc/keepalived/keepalived.conf
   #    在 aly 上：sed -i 's/priority 30/priority 80/' /etc/keepalived/keepalived.conf

   # 3. 启动并启用三台 keepalived
   sudo systemctl start keepalived
   sudo systemctl enable keepalived

   # 4. 解除 chk_haproxy 与 haproxy 绑定的双重死锁
   #    (a) haproxy 监听 VIP，只有持有 VIP 的节点能启动它；
   #    (b) chk_haproxy 检查 haproxy，haproxy 未起则优先级被降低、丢失 MASTER。
   #    因此需先手动在目标 MASTER 节点绑定 VIP 并启动 haproxy，再重启 keepalived：
   sudo ip addr add 10.0.0.100/32 dev ztpp6n6xmz   # 在期望的 MASTER 节点上
   sudo systemctl reset-failed haproxy              # 清除之前 bind 失败累积的 failed 状态
   sudo systemctl start haproxy                     # 现在能绑定 VIP，正常启动
   sudo systemctl restart keepalived                # server(100) 重新竞选并稳定持有 VIP
   ```

   验证：

   ```bash
   # MASTER 节点应持有 VIP（应为 server/10.0.0.10）
   ip addr show ztpp6n6xmz | grep 10.0.0.100
   # 三个端口均通
   timeout 3 bash -c "cat < /dev/null > /dev/tcp/10.0.0.100/5432" && echo "5432 通"
   timeout 3 bash -c "cat < /dev/null > /dev/tcp/10.0.0.100/5433" && echo "5433 通"
   timeout 3 bash -c "cat < /dev/null > /dev/tcp/10.0.0.100/6443" && echo "6443 通"
   ```

   > [!IMPORTANT]
   >
   > **网络方案变更后必须检查所有引用旧接口名的脚本**。从 WireGuard 切换到 ZeroTier 时，`notify.sh`、`keepalived.conf`、`haproxy.cfg` 中的 `wg0` 都可能残留，逐一替换为 `ztpp6n6xmz`。
   >
   > **`chk_haproxy`、`notify`、haproxy 绑定 VIP 三者存在循环依赖**：haproxy 靠 notify 启动，chk_haproxy 又检查 haproxy，而 haproxy 只监听 VIP（无 VIP 绑定即启动失败）。首次部署时需手动 `ip addr add` VIP + `systemctl start haproxy` 打破死锁，此后 keepalived 即可自行管理。
   >
   > **priority 必须严格递减且不相等**：三台节点优先级需各不相同（如 100/90/80），保证明确的竞选顺序；出现平级时，谁先启动/先恢复健康谁就赢得 MASTER，无法保证指定节点优先。

8. **VIP 漂移后其他节点 ARP 缓存残留，出现 ICMP Redirect**  
   现象：VIP 从旧 MASTER 漂移到新 MASTER（如从 txy 到 server）后，新加入集群的节点（如 WSL2 的 `10.0.0.20`）`ping 10.0.0.100` 能通，但输出中出现大量：

   ```
   64 bytes from 10.0.0.100: icmp_seq=2 ttl=64 time=32.1 ms
   From 10.0.0.30 icmp_seq=2 Redirect Host(New nexthop: 10.0.0.100)
   ```

   原因：`notify.sh` 的 master 分支只启动了 haproxy，**没有发送免费 ARP（gratuitous ARP）**。VIP 漂移后，其他节点的 ARP 缓存仍残留旧 MASTER 的 MAC，数据包先发给旧 MASTER，旧 MASTER 回 ICMP Redirect 告知"VIP 同网段，直接发"。`ip neigh` 中 `10.0.0.100` 甚至显示 `FAILED`，直到缓存自然过期（STALE→FAILED→重新解析）才恢复。

   解决：在 notify.sh 的 master 分支加入免费 ARP 通告：

   ```bash
   # 安装 arping（iputils-arping 提供）
   sudo apt install -y iputils-arping

   # notify.sh master 分支中加入（见 5.2 完整脚本）：
   ip neigh flush dev $DEV
   arping -c 5 -A -I $DEV $VIP 2>/dev/null || \
   arping -c 5 -U -I $DEV $VIP 2>/dev/null || true
   ```

   验证：VIP 漂移后，其他节点 `ip neigh` 应立即指向新 MASTER 的 MAC（REACHABLE），`ping 10.0.0.100` 无 ICMP Redirect、0% 丢包。

   > [!IMPORTANT]
   >
   > **VIP 漂移后必须主动通告 ARP**。Keepalived 自身在 master 时会发免费 ARP，但 ZeroTier 二层网络 + 单播 VRRP 环境下可能不可靠，建议在 notify.sh 显式 `arping` 通告，确保所有节点 ARP 缓存即时更新，避免短暂不通或 ICMP Redirect。

9. **系统重启后 keepalived 因 ZeroTier 接口未就绪而启动失败**  
   现象：主机重启后，三台 keepalived 全部 `failed`，VIP 消失，日志报：

   ```
   Non-existent interface specified in configuration
   pid <PID> exited with permanent error CONFIG. Terminating
   ```

   原因：keepalived 依赖 ZeroTier 接口 `ztpp6n6xmz` 存在才能通过配置校验。但 keepalived 的 systemd unit 只依赖 `network-online.target`，**没有声明对 `zerotier-one.service` 的依赖**。重启时 ZeroTier 尚未把接口创建出来，keepalived 先启动即报接口不存在，随后因 CONFIG 错误退出（`status=2/INVALIDARGUMENT`）。

   解决：为 keepalived 添加对 zerotier-one 的启动依赖（drop-in 方式，三台节点均需）：

   ```bash
   sudo mkdir -p /etc/systemd/system/keepalived.service.d
   sudo tee /etc/systemd/system/keepalived.service.d/zerotier.conf << 'EOF'
   [Unit]
   After=zerotier-one.service network-online.target
   Wants=zerotier-one.service network-online.target
   Requires=zerotier-one.service
   EOF
   sudo systemctl daemon-reload
   ```

   > [!IMPORTANT]
   >
   > **依赖 ZeroTier 接口的服务都需声明启动顺序**。与踩坑记录 6（etcd）同理：`keepalived`、`patroni`、`etcd` 等绑定 `10.0.0.x` 或依赖 `ztpp6n6xmz` 的服务，都应通过 drop-in 添加 `After=zerotier-one.service` + `Requires=zerotier-one.service`，否则重启后可能因接口未就绪而启动失败。
   >
   > **首启竞态**：即使依赖配好，keepalived 首次进入 MASTER 时，`chk_haproxy` 仍可能在 haproxy 就绪前失败，导致 notify 的 `systemctl start haproxy` 失败。若 VIP 端口不通，手动 `systemctl start haproxy` 一次即可，后续 keepalived 自行管理。

---

## 九、总结

通过切换到 ZeroTier 并配合 **Keepalived + HAProxy**，我们在三节点虚拟二层网络上成功构建了一个更简洁、更稳定的接入层：

- **PostgreSQL 读写分离** 完全自动化，无需应用修改连接逻辑，跟随 Patroni 角色动态调整。
- **K3s API Server 高可用** 隐藏了后端节点细节，任意节点宕机不影响 kubectl 访问。
- **VIP 高可用** 利用 ZeroTier 的二层多播能力，直接使用标准 VRRP，无需单播，配置极简，毫秒级切换。

这套方案轻量、无外部依赖，非常适合中小规模的自建高可用集群。如果后续需要增强读一致性，还可以基于 Patroni 的 `/sync` 端点添加同步读端口。希望本文能帮助你在类似场景下快速落地。
