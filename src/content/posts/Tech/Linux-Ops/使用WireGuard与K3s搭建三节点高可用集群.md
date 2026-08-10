---
title: 使用 WireGuard + K3s 搭建 Kubernetes 集群
published: 2026-07-25
updated: 2026-08-10
pinned: false
description: 通过 IPv6 公网直连的 WireGuard VPN，在三台主机上构建高可用的 K3s 集群，采用内置 etcd 实现控制平面高可用
tags: [Kubernetes, High Availability]
category: DevOps
author: Hyperbola
draft: false
---

> 在三台主机（物理机 + 云服务器）环境下，通过 IPv6 公网直连的 WireGuard VPN，构建一个高可用、稳定易管理的 K3s 集群，并采用内置 etcd 实现控制平面高可用。

> [!NOTE]
>
> 本文记录的是集群初期基于 **WireGuard + Flannel VXLAN** 的部署。后续为支持 Keepalived 的 VRRP 与 Flannel **host-gw**（均需要二层网络），集群已迁移到 **ZeroTier** 二层内网（接口 `ztpp6n6xmz`），Flannel 后端同步从 VXLAN 改为 **host-gw**，K3s 节点 IP、角色、拓扑均保持不变。迁移详见《ZeroTier 下基于 Keepalived 与 HAProxy 的 HA 实践》。

---

## 背景与目标

我拥有三台机器：

- **主机 1**（物理机）：32GB 内存，原 IP 10.0.0.1 现改为 10.0.0.10
- **主机 2**（云服务器）：4GB 内存，IP 10.0.0.30
- **主机 3**（云服务器）：4GB 内存，IP 10.0.0.40

所有机器均有公网 IPv6，但 **主机 1 的公网 IPv6 是动态分配的**。为了简化网络规划并保证通信安全，我决定在 IPv6 公网之上搭建 WireGuard VPN，让三台机器在一个安全的私有 IPv4 网络中通信。在此基础上，部署 K3s 高可用集群，使用内置 etcd 作为存储后端，确保控制平面冗余。

本文将完整记录从零开始安装 WireGuard、部署三节点 K3s 控制平面（全部为 server 角色）、验证集群高可用的全过程，并针对多节点场景下网络方案的选择给出实用建议。

---

## 网络方案选择：独立 WireGuard + Flannel VXLAN

原方案采用了 Flannel **host-gw** 后端，它需要节点间二层可达，并在 VPN 中正确处理 Pod 子网路由。但在三节点及以上的场景下，host‑gw 要求 WireGuard 的 `AllowedIPs` 必须包含所有对端节点的 Pod CIDR，而 Pod CIDR 是在集群启动后动态分配的，手动配置繁琐且易出错。为简化配置并保持灵活性，我将 Flannel 后端改为 **VXLAN**（即 K3s 默认后端）。理由如下：

1. **规避路由冲突**  
   VXLAN 将 Pod 流量封装在 UDP 包中，外层目标 IP 为节点自身的 VPN IP。WireGuard 只需处理节点 IP（`10.0.0.x/32`）的流量，无需关心 Pod 子网，配置简洁且不易出错。

2. **性能仍可接受**  
   虽然 VXLAN 比 host‑gw 多一层封装，但独立 WireGuard 已经提供了加密和隧道，多一层 UDP 封装对现代 CPU 影响不大，且集群规模较小（三节点），性能开销完全可接受。

3. **与独立 WireGuard 完美协同**  
   Flannel 的 VXLAN 流量通过 `wg-k3s` 接口传输，WireGuard 负责对节点间通信进行加密，两者职责清晰，排错直观。

因此，最终方案为：**独立 WireGuard + Flannel VXLAN**，所有节点均为 K3s Server，使用嵌入式 etcd 实现高可用。

---

## 环境准备

| 角色   | 主机名  | 公网 IPv6（示例） | 私有 VPN IP    |
| ------ | ------- | ----------------- | -------------- |
| Server | `node1` | `2001:db8:1::10`  | `10.0.0.10/24` |
| Server | `node2` | `2001:db8:2::30`  | `10.0.0.30/24` |
| Server | `node3` | `2001:db8:3::40`  | `10.0.0.40/24` |

操作系统均为 **Debian 13 (Trixie)**，内核 ≥ 6.0。

> 公网 IPv6 地址实际可能动态变化，后续 WireGuard 配置中可通过 DDNS 域名来应对。

---

## 第一步：配置 WireGuard VPN

### 1.1 安装 WireGuard

在三台机器上分别执行：

```bash
sudo apt update
sudo apt install wireguard -y
sudo modprobe wireguard
lsmod | grep wireguard
```

### 1.2 生成密钥对

每台机器生成自己的私钥和公钥：

```bash
sudo mkdir -p /etc/wireguard
sudo chmod 700 /etc/wireguard
wg genkey | sudo tee /etc/wireguard/private.key > /dev/null
sudo sh -c 'wg pubkey < /etc/wireguard/private.key' | sudo tee /etc/wireguard/public.key > /dev/null
```

记录每台机器的公钥，配置对端时使用。

### 1.3 编写 WireGuard 配置文件

#### 节点 1（10.0.0.10）的 `/etc/wireguard/wg-k3s.conf`

```ini
[Interface]
Address = 10.0.0.10/24
PrivateKey = <NODE1_PRIVATE_KEY>
ListenPort = 51820

[Peer]
PublicKey = <NODE2_PUBLIC_KEY>
AllowedIPs = 10.0.0.30/32
Endpoint = [2001:db8:2::30]:51820   # 可替换为 DDNS 域名
PersistentKeepalive = 25

[Peer]
PublicKey = <NODE3_PUBLIC_KEY>
AllowedIPs = 10.0.0.40/32
Endpoint = [2001:db8:3::40]:51820
PersistentKeepalive = 25
```

#### 节点 2（10.0.0.30）的 `/etc/wireguard/wg-k3s.conf`

```ini
[Interface]
Address = 10.0.0.30/24
PrivateKey = <NODE2_PRIVATE_KEY>
ListenPort = 51820

[Peer]
PublicKey = <NODE1_PUBLIC_KEY>
AllowedIPs = 10.0.0.10/32
Endpoint = [2001:db8:1::10]:51820
PersistentKeepalive = 25

[Peer]
PublicKey = <NODE3_PUBLIC_KEY>
AllowedIPs = 10.0.0.40/32
Endpoint = [2001:db8:3::40]:51820
PersistentKeepalive = 25
```

#### 节点 3（10.0.0.40）的 `/etc/wireguard/wg-k3s.conf`

```ini
[Interface]
Address = 10.0.0.40/24
PrivateKey = <NODE3_PRIVATE_KEY>
ListenPort = 51820

[Peer]
PublicKey = <NODE1_PUBLIC_KEY>
AllowedIPs = 10.0.0.10/32
Endpoint = [2001:db8:1::10]:51820
PersistentKeepalive = 25

[Peer]
PublicKey = <NODE2_PUBLIC_KEY>
AllowedIPs = 10.0.0.30/32
Endpoint = [2001:db8:2::30]:51820
PersistentKeepalive = 25
```

> **注意**：`AllowedIPs` 仅包含对端节点的 VPN IP（/32），无需包含 Pod 网段，因为 VXLAN 封装后外层目标 IP 就是节点 IP。

### 1.4 启动 WireGuard 并设置开机自启

每台机器执行：

```bash
sudo wg-quick up wg-k3s
sudo systemctl enable wg-quick@wg-k3s
```

验证互通（例如在 node1 上）：

```bash
ping -c 4 10.0.0.30
ping -c 4 10.0.0.40
```

全部通顺则 VPN 就绪。

---

## 第二步：安装 K3s Server（三节点高可用）

### 2.1 规划网络参数

- Pod CIDR：`10.42.0.0/16`（默认）
- Service CIDR：`10.43.0.0/16`（默认）
- Flannel 后端：**VXLAN**（默认，无需显式指定，但需指定接口 `wg-k3s`）
- 所有节点均以 Server 角色运行，使用嵌入式 etcd 集群。

### 2.2 编写 K3s 配置文件

使用 `/etc/rancher/k3s/config.yaml` 持久化配置，避免环境变量干扰。

#### 节点 1（初始 server）的 config.yaml

在 node1 上创建：

```bash
sudo mkdir -p /etc/rancher/k3s
sudo tee /etc/rancher/k3s/config.yaml << 'EOF'
advertise-address: 10.0.0.10
bind-address: 0.0.0.0
node-ip: 10.0.0.10
node-external-ip: 10.0.0.10
disable: traefik
flannel-iface: wg-k3s
cluster-init: true
token: "my-shared-secret"   # 自定义一个强密码，后续节点加入时使用
EOF
```

参数说明：
- `advertise-address`：API Server 公告地址，生成 kubeconfig 时使用。
- `bind-address`：监听所有接口。
- `node-ip` / `node-external-ip`：节点通信 IP。
- `disable: traefik`：可选的，禁用默认 Ingress。
- `flannel-iface: wg-k3s`：指定 Flannel 使用该接口承载 VXLAN 流量。
- **`cluster-init: true`**：启用嵌入式 etcd 并初始化为集群的第一个节点。
- **`token`**：集群认证令牌，所有节点必须一致。

#### 节点 2 和节点 3 的 config.yaml

在 node2 和 node3 上分别创建（替换各自的 IP）：

```bash
sudo mkdir -p /etc/rancher/k3s
sudo tee /etc/rancher/k3s/config.yaml << 'EOF'
advertise-address: 10.0.0.30   # node3 改为 10.0.0.40
bind-address: 0.0.0.0
node-ip: 10.0.0.30             # node3 改为 10.0.0.40
node-external-ip: 10.0.0.30    # node3 改为 10.0.0.40
disable: traefik
flannel-iface: wg-k3s
server: https://10.0.0.10:6443
token: "my-shared-secret"
EOF
```

> **关键**：后续节点通过 `server` 指向第一个节点的 API 地址，`token` 与第一个节点保持一致，**不设置** `cluster-init`。

### 2.3 安装 K3s Server

在三台机器上分别执行官方安装脚本（无需额外参数，配置均在 config.yaml 中）：

```bash
curl -sfL https://get.k3s.io | sh -
```

安装完成后，服务自动启动。

### 2.4 验证集群状态

在任意节点上（例如 node1）使用 `kubectl` 查看节点：

```bash
sudo kubectl get nodes
```

应看到三个节点均处于 `Ready` 状态，且角色均为 `control-plane,master`。

检查 etcd 集群状态：

```bash
sudo kubectl get nodes -o wide   # 查看内部 IP 是否正确
sudo kubectl -n kube-system get pods | grep etcd   # etcd Pod 应都 Running
```

查看 kubeconfig 中的 server 地址：

```bash
sudo grep ^server /etc/rancher/k3s/k3s.yaml
# 应输出：server: https://10.0.0.10:6443
```

如果发现 server 地址不是预期的 `10.0.0.10`，可删除该文件并重启 `k3s` 服务，K3s 会依据 config.yaml 重新生成。

检查 Flannel 是否使用 VXLAN 并绑定了 `wg-k3s` 接口：

```bash
ip a show flannel.1   # 应存在 VXLAN 设备
sudo journalctl -u k3s | grep flannel   # 查看日志确认接口
```

---

## 第三步：验证集群高可用性

### 3.1 部署测试应用

```bash
kubectl create deployment nginx --image=nginx
kubectl expose deployment nginx --port=80 --type=NodePort
kubectl get svc nginx
```

通过任一节点的 VPN IP 和 NodePort 访问，确认服务正常。

### 3.2 模拟节点故障

将 node1 的 K3s 服务停止：

```bash
sudo systemctl stop k3s
```

此时在其他节点上执行 `kubectl get nodes`，会看到 node1 状态变为 `NotReady`，但集群仍然可用（因为 etcd 集群有多个节点）。重新启动 node1 的 K3s，它会自动重新加入集群。

> 若要测试 etcd 容错，可参考官方文档，确保至少两个节点保持运行。

---

## 第四步：外部访问 API Server（可选）

由于没有负载均衡器，`kubectl` 默认连接 node1 的 API Server。若 node1 故障，需要手动切换 kubeconfig 中的 server 地址到其他节点。建议使用一个简单的 TCP 负载均衡（如 HAProxy）或 DNS 轮询来提供稳定的访问入口。

如果使用 HAProxy，可将其部署在任意节点上，监听 `10.0.0.10:6443`（虚拟 IP）并转发到三个节点的 6443 端口。配置方法本文略。

---

## 常见问题与解决方案

### Q1：Flannel 创建了 `flannel-wg` 接口而非 `flannel.1`

原因：可能配置中错误指定了 `flannel-backend: host-gw` 或 `wireguard-native`，或系统有残留。  
解决：确认 config.yaml 中 **不包含** `flannel-backend`（或显式设为 `vxlan`），并清理旧接口：

```bash
sudo ip link delete flannel-wg 2>/dev/null || true
sudo systemctl restart k3s
```

### Q2：节点加入后一直处于 `NotReady`

检查日志：

```bash
sudo journalctl -u k3s -n 50 --no-pager
```

常见原因：
- WireGuard 未打通，节点间无法 ping 通 VPN IP。
- Token 不匹配。
- 第一个节点的 `cluster-init` 未正确启用，导致 etcd 未启动。

### Q3：etcd 集群无法形成

确保所有节点的 config.yaml 中 `token` 一致，且后续节点的 `server` 指向第一个节点的 API 地址（注意端口 6443）。检查防火墙是否允许 6443 端口（在 VPN 内一般无需额外开放，但需确认 WireGuard 允许该 IP 的流量）。

### Q4：kubeconfig 中 server 地址为 `0.0.0.0`

原因同原博客，确保 `advertise-address` 正确设置，并清空可能干扰的环境变量（如 `/etc/systemd/system/k3s.service.env`）。

### Q5：修改主机名后出现新旧节点、NotReady、etcd 成员异常

**现象**：把主机名从 `hyperbola-*` 改为 `hyqaq-*` 后，`kubectl get nodes` 出现两套节点记录——旧名（NotReady）和新名（Ready），且部分节点 NotReady、内嵌 etcd 成员异常。

**根因**：K3s 用主机名注册节点对象和 etcd 成员名。主机名变更后：
- agent 用新主机名重新注册 → 产生 `hyqaq-*` 新节点
- 旧主机名的节点对象残留 → `hyperbola-*` 一直 NotReady
- 删除旧节点对象时，若该节点是 control-plane（etcd 成员），会**连带把它的内嵌 etcd 成员从集群移除**，产生 tombstone 标记，导致该节点的 K3s 重启后内嵌 etcd 无法启动

**排查关键命令**：
```bash
# 列出所有节点（注意新旧两套）
kubectl get nodes -o wide
# 查看内嵌 etcd 成员（用 K3s 生成的证书）
ETCDCTL_ENDPOINTS=https://127.0.0.1:2379 \
ETCDCTL_CACERT=/var/lib/rancher/k3s/server/tls/etcd/server-ca.crt \
ETCDCTL_CERT=/var/lib/rancher/k3s/server/tls/etcd/server-client.crt \
ETCDCTL_KEY=/var/lib/rancher/k3s/server/tls/etcd/server-client.key \
etcdctl member list
# 检查 tombstone（存在说明该成员已被移除）
ls /var/lib/rancher/k3s/server/db/etcd/tombstone
```

**修复步骤**：
```bash
# 1. 删除旧主机名的残留节点对象
kubectl delete node hyperbola-server hyperbola-txy hyperbola-aly

# 2. 对每个内嵌 etcd 成员被移除的节点（2379 未监听 + 有 tombstone）：
systemctl stop k3s
# 备份并清空内嵌 etcd 数据
mv /var/lib/rancher/k3s/server/db/etcd /var/lib/rancher/k3s/server/db/etcd.bak.$(date +%Y%m%d)
# 确认 config.yaml 为加入模式（server: + token:，初始节点 cluster-init: true）
systemctl start k3s   # 会以新主机名重新加入集群
```

**注意事项**：
- **初始节点（`cluster-init: true`）的 config.yaml 不能包含 `server:` / `token:`**（那是 agent/加入型 server 的字段）。两者混写会让 K3s 同时按初始节点和加入节点处理，导致内嵌 etcd 异常；
- 删除节点对象时，control-plane 的 etcd 成员会被连带移除，**需逐个节点清理 tombstone 并重新加入**，保持 quorum（3 节点 quorum = 2）；
- etcd 成员名在创建时固化（`hyperbola-server-18ba1d35`），被移除后重新加入会使用新主机名（`hyqaq-server-xxx`），这是正常现象。

---

## 总结

通过独立 WireGuard 在三台机器间构建安全隧道，并部署 K3s 高可用集群（嵌入式 etcd），我们得到了一个稳定、可容错的控制平面。本方案使用 Flannel VXLAN 后端，避免了多节点下 host‑gw 路由配置的复杂性，同时利用独立 WireGuard 解决了动态 IPv6 的难题。所有配置均通过 `config.yaml` 持久化，便于管理和维护。

最终，我们拥有了一个生产可用的轻量级 Kubernetes 集群，可进一步部署 Ingress、存储、监控等组件。

---

**附录：关键命令速查**

- 启动 WireGuard：`sudo wg-quick up wg-k3s`
- 查看 WireGuard 状态：`sudo wg show`
- 重启 K3s Server：`sudo systemctl restart k3s`
- 查看 K3s 日志：`sudo journalctl -u k3s -f`
- 获取集群 token：`sudo cat /var/lib/rancher/k3s/server/node-token`（若未在 config 中指定）
- 删除节点：`kubectl delete node <node-name>`

> 本文所有配置基于 Debian 13，其他发行版可能需要调整，但核心思路通用。