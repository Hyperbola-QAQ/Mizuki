---
title: WSL2 桥接模式实战：配置静态 IP、开启 IPv6 与 Systemd 避坑指南
published: 2026-08-09
updated: 2026-08-09
pinned: false
description: 在 Windows 11 下将 WSL2 配置为桥接模式并设置静态 IP、开启 IPv6 的完整指南，涵盖虚拟交换机创建、Systemd 启用及常见避坑点
tags: [Networking, Virtualization]
category: Networking
author: Hyperbola
draft: false
series: WSL2 实战
---

# 前言

在使用 WSL2 进行开发或部署服务时，默认的 NAT 模式往往会导致端口映射繁琐、IP 地址变动等问题。将 WSL2 配置为桥接模式（Bridged）并设置静态 IP，可以让 WSL2 像局域网内的一台独立物理机一样工作。

本文基于 Windows 11 + Debian 13 (Trixie) 环境，记录从网络打通到服务配置的完整流程，并重点解决了 systemd 未启动及虚拟交换机配置不生效等常见"坑点"。

---

# 环境准备

- 操作系统：Windows 11
- WSL 发行版：Debian 13 (Trixie)（安装于 `D:\WSL\Debian`）
- 目标 IP：
  - Windows 宿主机 (虚拟交换机)：`192.168.86.21`
  - WSL2 Debian：`192.168.86.22`

---

# 第一步：创建外部虚拟交换机

WSL2 的桥接模式依赖于 Hyper-V 的外部虚拟交换机。

1. 打开 Hyper-V 管理器（若为家庭版系统，需先通过脚本开启 Hyper-V 功能）。
2. 点击右侧的 "虚拟交换机管理器"。
3. 选择 "新建虚拟网络交换机" -> "外部" -> "创建虚拟交换机"。
4. 命名为 `WSL_Bridge`（名称需与后续配置文件一致），并在 "连接类型" 中选择你正在使用的物理网卡（如 Realtek PCIe GbE Family Controller）。
5. 点击确定。此时你的物理网络可能会短暂断开，属正常现象。

---

# 第二步：配置 WSL2 全局网络参数

编辑 Windows 用户目录下的 `.wslconfig` 文件（路径通常为 `C:\Users\<用户名>\.wslconfig`），添加以下内容以启用桥接和 IPv6：

```ini
[wsl2]
networkingMode=bridged
vmSwitch=WSL_Bridge
ipv6=true
```

> [!NOTE]
>
> `vmSwitch` 的值必须与第一步中创建的虚拟交换机名称完全一致。

保存后，在 PowerShell 中执行 `wsl --shutdown` 重启 WSL 使配置生效。

---

# 第三步：启用 Systemd (关键步骤)

Debian 13 等现代发行版推荐使用 systemd-networkd 管理网络，但 WSL2 默认不使用 systemd 作为初始化系统。直接运行 `systemctl` 会报错：

```txt
System has not been booted with systemd as init system (PID 1). Can't operate.
```

解决方法：

1. 进入 WSL2，编辑 `/etc/wsl.conf`：

```bash
sudo vim /etc/wsl.conf
```

添加以下配置：

```ini
[boot]
systemd=true
```

2. 在 PowerShell 中再次执行 `wsl --shutdown`，然后重新进入 WSL2。
3. 验证：执行 `ps -p 1 -o comm=`，若输出 `systemd` 则说明成功。

---

# 第四步：配置 WSL2 静态 IP 与 IPv6

启用 systemd 后，即可使用 systemd-networkd 配置网络。

创建网络配置文件：

```bash
sudo vim /etc/systemd/network/10-static-eth0.network
```

写入以下内容（根据你的实际网关修改 Gateway 和 DNS）：

```ini
[Match]
Name=eth0

[Network]
Address=192.168.86.22/24
Gateway=192.168.86.1
DNS=223.5.5.5
DNS=2400:3200::1
IPv6AcceptRA=yes
```

启用并重启网络服务：

```bash
sudo systemctl enable systemd-networkd
sudo systemctl restart systemd-networkd
```

验证：执行 `ip a`，确认 `eth0` 已获取 `192.168.86.22` 及 IPv6 地址。

---

# 第五步：配置 Windows 宿主机静态 IP (避坑指南)

为了让宿主机和 WSL2 在同一网段通信，需要给虚拟交换机对应的适配器设置静态 IP。

1. 打开 Windows "网络连接" 面板 (`ncpa.cpl`)。
2. 找到名为 "vEthernet (WSL_Bridge)" 的适配器。
3. 右键 -> 属性 -> 双击 "Internet 协议版本 4 (TCP/IPv4)"。
4. 手动设置 IP 为 `192.168.86.21`，子网掩码 `255.255.255.0`，网关留空或指向主路由。

> [!WARNING]
>
> Windows 虚拟交换机 IP 修改生效机制：在修改 vEthernet 适配器的 IP 地址后，Windows 往往不会立即应用新配置，导致 ping 不通或路由异常。必须手动"禁用"该适配器，等待几秒后再"启用"，新的 IP 设置才会真正生效。

---

# 验证测试

完成上述所有步骤后，进行双向测试：

- WSL2 内 ping 宿主机：

```bash
ping 192.168.86.21
```

- Windows PowerShell ping WSL2：

```powershell
ping 192.168.86.22
```

- IPv6 测试（需在 WSL2 内测试）：

```bash
ping ipv6.baidu.com
```

如果全部通畅，恭喜你，你的 WSL2 现在已经是一台完美的局域网独立服务器了！

---

# 结尾

至此，WSL2 已成功配置为桥接模式并获得了静态 IP 与 IPv6 地址。相比默认的 NAT 模式，桥接模式下的 WSL2 不再需要繁琐的端口映射，能够以独立主机的身份直接对外提供服务，非常适合作为局域网内的开发或部署环境。
