---
title: 三节点 ZeroTier 内网下，基于 Keepalived + HAProxy 的 PostgreSQL 读写分离与 K3s 高可用实践
published: 2026-07-28
updated: 2026-08-06
pinned: false
description: 在三台 Debian 云主机间用 ZeroTier 建立二层网络，部署 Patroni 管理的 PostgreSQL 流复制集群与 K3s 控制平面，再用 Keepalived 与 HAProxy 实现虚拟 IP 入口、读写分离和 API Server 高可用
tags: [Networking, High Availability]
category: Networking
author: Hyperbola
draft: false
---

在多云、跨地域的轻量级高可用场景中，我们经常需要将分散的云主机通过隧道组成一个虚拟内网，并在此之上搭建数据库集群和容器编排系统。本文记录了一次完整实践：在三台 Debian 云主机之间使用 **ZeroTier** 建立二层网络，部署 Patroni 管理的 PostgreSQL 流复制集群以及 K3s 控制平面，然后**利用 Keepalived 和 HAProxy 构建一个虚拟 IP 入口，同时实现 PostgreSQL 读写分离和 K3s API Server 高可用代理**。

与常见的 WireGuard 方案不同，ZeroTier 原生提供二层以太网，支持 ARP 和多播，这使得 VRRP 虚拟 IP 可以直接工作，无需额外的单播配置和路由调整。

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

- **Keepalived** 通过 VRRP 多播通告管理 VIP，选择一台节点作为 MASTER，其余为 BACKUP。接口故障（如 `ztpp6n6xmz` down）会立即触发降级，避免等待超时。
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

由于 ZeroTier 是**二层虚拟以太网**，原生支持多播，因此 Keepalived **无需使用单播**，可以直接使用默认的 VRRP 多播模式，配置更简洁。

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
        logger "keepalived: transition to MASTER, haproxy started"
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

vrrp_instance VI_CLUSTER {
    state BACKUP                   # 所有节点都设为 BACKUP，依靠优先级竞选 Master
    interface ztpp6n6xmz          # ZeroTier 虚拟网卡接口
    virtual_router_id 51           # 同一 VRRP 组必须相同
    priority 100                   # 最高优先级，默认成为 Master
    advert_int 1                   # 通告间隔（秒）
    authentication {
        auth_type PASS
        auth_pass your_password    # 所有节点必须一致
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

- **hyperbola-txy**：`priority 90`
- **hyperbola-aly**：`priority 80`

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

与 WireGuard 不同，ZeroTier 提供的是二层以太网，**VRRP 多播包可以正常传播**，VIP 的 ARP 也能被所有节点学习，因此无需额外配置路由或允许 IP 段。但仍需确保：

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
   WireGuard 是三层隧道，不支持多播和 ARP 广播，导致 VIP 必须通过单播 VRRP 和额外的路由配置才能工作(sudo wg set)，且客户端解析 VIP 时容易出问题。切换为 ZeroTier 后，所有这些问题自然消失，配置量大幅减少。

2. **Keepalived 配置必须完整**  
   缺少 `track_interface` 会导致接口 down 时无法立即切换；缺少健康检查脚本或 `track_script` 引用会使实例进入 FAULT；未配置 `notify` 指令则通知脚本永远不会执行。三要素缺一不可。

3. **接口名称一致性**  
   ZeroTier 的接口名称由网络 ID 决定，不同设备上可能不同（如 `zt7ufxgkl3`），建议在每台机器上确认接口名，并统一写入 keepalived 配置。或者通过 ZeroTier 的 `local.conf` 固定接口名称。

4. **VIP 单点存在是正常现象**  
   所有 BACKUP 节点不会持有 VIP，这是 VRRP 的正常表现，不必担心。

5. **证书规划**  
   如果 K3s 部署时未预知 VIP 地址，后期添加 SAN 需重启集群，建议在部署初期就规划好所有可能的访问入口。

---

## 九、总结

通过切换到 ZeroTier 并配合 **Keepalived + HAProxy**，我们在三节点虚拟二层网络上成功构建了一个更简洁、更稳定的接入层：

- **PostgreSQL 读写分离** 完全自动化，无需应用修改连接逻辑，跟随 Patroni 角色动态调整。
- **K3s API Server 高可用** 隐藏了后端节点细节，任意节点宕机不影响 kubectl 访问。
- **VIP 高可用** 利用 ZeroTier 的二层多播能力，直接使用标准 VRRP，无需单播，配置极简，毫秒级切换。

这套方案轻量、无外部依赖，非常适合中小规模的自建高可用集群。如果后续需要增强读一致性，还可以基于 Patroni 的 `/sync` 端点添加同步读端口。希望本文能帮助你在类似场景下快速落地。