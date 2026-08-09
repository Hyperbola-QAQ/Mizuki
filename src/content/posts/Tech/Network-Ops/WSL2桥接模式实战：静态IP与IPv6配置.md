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

编辑 Windows 用户目录下的 `.wslconfig` 文件（路径通常为 `C:\Users\<用户名>\.wslconfig`），添加以下内容以启用桥接、IPv6，并禁用 WSL 自带的 DHCP：

```ini
[wsl2]
vmSwitch=WSL_Bridge
ipv6=true
networkingMode=Bridged
firewall=false
memory=10647240704
dhcp=false
```

> [!NOTE]
>
> `vmSwitch` 的值必须与第一步中创建的虚拟交换机名称完全一致。
>
> `dhcp=false` 是关键：在桥接模式下禁用 WSL 自带的 DHCP 自动配置，避免 eth0 上出现 Hyper-V 下发的动态 IP。`memory` 可按需调整，`firewall=false` 可选。

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

写入以下内容（根据你的实际网关修改 Gateway）：

```ini
[Match]
Name=eth0

[Network]
Address=192.168.86.22/24
Gateway=192.168.86.1
IPv6AcceptRA=yes
DHCP=no
```

> [!NOTE]
>
> - `DHCP=no` 用于显式禁用 eth0 上的 DHCP 客户端，避免接口同时持有静态 IP 与 DHCP 动态 IP 两套地址。
> - 不再在 `.network` 中配置 `DNS=`：WSL2 没有 systemd-resolved，systemd-networkd 写入的 DNS 不会生效，域名解析改为手工维护 `/etc/resolv.conf`（见下文）。

启用并重启网络服务：

```bash
sudo systemctl enable systemd-networkd
sudo systemctl restart systemd-networkd
```

验证：执行 `ip a`，确认 `eth0` 已获取 `192.168.86.22` 及 IPv6 地址。

### 配置 DNS：手工维护 /etc/resolv.conf

WSL2 默认没有 systemd-resolved，systemd-networkd 的 `DNS=` 配置不会生效，需要手工维护 `/etc/resolv.conf`。同时需在 `/etc/wsl.conf` 的 `[network]` 段设置 `generateResolvConf = false`（见第六步），否则 WSL 每次启动会覆盖该文件。

手工写入 DNS：

```bash
sudo tee /etc/resolv.conf << 'EOF'
nameserver 223.5.5.5
nameserver 114.114.114.114
nameserver 8.8.8.8
EOF
```

验证解析：

```bash
nslookup baidu.com
```

> [!WARNING]
>
> **现象：eth0 上静态 IP 与动态 IP 并存**
>
> 如果 `ip a` 输出中 eth0 除了静态地址外，还有一个 `scope global secondary dynamic` 的动态地址（形如 `192.168.86.119/24`），这**不是** systemd-networkd 或某个 DHCP 客户端（dhclient/dhcpcd）造成的 —— 配置里 `DHCP=no` 且系统中没有 dhclient 进程，NAT 模式下的排查思路在这里并不适用。
>
> **根本原因**：桥接模式下，动态地址由 **Windows 侧的 Hyper-V 虚拟交换机直接下发**到 WSL 的虚拟网卡，并不经过 WSL 内部网络栈的 DHCP 客户端。`DHCP=no` 只对 systemd-networkd 自身的 DHCP 生效，拦不住 Hyper-V 的这一层。

### 彻底解决办法

静态 IP 与 Hyper-V 下发的动态 IP 并存，虽然静态地址仍为主地址，但双地址共存可能带来**路由冲突、网络不稳定**，或某些场景下的连接问题。彻底解决需在 `.wslconfig` 中禁用 WSL 自带的 DHCP。

**在 `.wslconfig` 中添加 `dhcp=false`**

编辑 Windows 用户目录下的 `.wslconfig`，在 `[wsl2]` 段加入 `dhcp=false`（见第二步）：

```ini
[wsl2]
vmSwitch=WSL_Bridge
ipv6=true
networkingMode=Bridged
firewall=false
dhcp=false
```

> [!NOTE]
>
> `dhcp=false` 需要在 `wsl --shutdown` 后才会生效，这是禁用 Hyper-V 向 WSL 虚拟网卡下发动态 IP 的正确方式。

修改后重启 WSL 使配置生效：

```powershell
wsl --shutdown
```

重新进入 WSL2 后执行 `ip a`，确认 eth0 上仅保留静态地址 `192.168.86.22`，动态地址不再出现。

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

# 第六步：配置主机名并禁用 hosts 自动同步

WSL2 默认每次启动都会根据 `hostname` 自动生成并覆盖 `/etc/hosts`，导致桥接模式下自定义的解析记录被重置。可以通过 `/etc/wsl.conf` 禁用该行为并自定义主机名。

进入 WSL2，编辑 `/etc/wsl.conf`：

```bash
sudo vim /etc/wsl.conf
```

添加以下内容（`hostname` 仅支持字母、数字和横杠）：

```ini
[network]
hostname = HyQAQ-WSL
generateHosts = false
generateResolvConf = false
```

- `hostname`：自定义主机名，替换为你想要的名称
- `generateHosts`：`false` 表示禁用 WSL 自动同步/覆盖 `/etc/hosts`，之后可以手动维护 `/etc/hosts` 中的解析记录
- `generateResolvConf`：`false` 表示禁用 WSL 自动生成 `/etc/resolv.conf`，配合第四步手工维护 DNS

保存后在 PowerShell 中执行 `wsl --shutdown`，重新进入 WSL2 后执行 `hostname` 验证新主机名已生效。

---

# 第七步：配置 Windows 宿主机 OpenSSH

桥接模式下，WSL2 与宿主机处于同一网段，可通过 OpenSSH 从外部直接 SSH 登录 Windows 宿主机。

在 PowerShell（管理员）中安装 OpenSSH Server：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

启动服务并设为开机自启：

```powershell
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
```

验证服务状态与防火墙规则（安装时通常已自动放行 22 端口）：

```powershell
Get-Service sshd
Get-NetFirewallRule -Name *OpenSSH*
```

测试从局域网内其他机器 SSH 登录宿主机：

```powershell
ssh 用户名@192.168.86.21
```

### 配置默认 shell 为 PowerShell

Windows OpenSSH 默认使用的 shell 是 `cmd.exe`，SSH 登录后直接是命令行窗口。可以通过注册表将默认 shell 改为 PowerShell。

> [!WARNING]
>
> 以下命令需在**管理员权限的 PowerShell** 中运行（右键 PowerShell -> "以管理员身份运行"），否则写入 `HKLM` 会报权限错误。

```powershell
New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force
```

重启 `sshd` 服务后生效：

```powershell
Restart-Service sshd
```

> [!TIP]
>
> 若希望 SSH 登录后直接进入 WSL，可将 `DefaultShell` 指向 WSL 的入口：
>
> ```
> wsl.exe -d Debian
> ```

> [!TIP]
>
> 若需要同时将 SSH 转发到 WSL2，可在 Windows 上配置端口代理（如 `netsh interface portproxy`）或直接 SSH 到 WSL2 的 `192.168.86.22`。

---

# 第八步：WSL2 开机自启动

## 方式一：任务计划程序（推荐）

以管理员身份打开"任务计划程序"，创建基本任务：

- 触发器：**计算机启动时**（或"登录时"）
- 操作：启动程序 `wsl.exe`，参数 `-d Debian -u root`
- 勾选"使用最高权限运行"

或使用命令行直接创建：

```powershell
schtasks /Create /TN "WSL2_Startup" /TR "wsl.exe -d Debian -u root" /SC ONSTART /RU SYSTEM /RL HIGHEST
```

## 方式二：启动文件夹快捷方式

按 `Win + R` 输入 `shell:startup` 打开启动文件夹，创建一个指向 `wsl.exe` 的快捷方式，目标设为：

```txt
wsl.exe -d Debian -u root
```

> [!NOTE]
>
> WSL2 的发行版名可通过 `wsl --list` 查看，Debian 需替换为你实际的发行版名称。

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
