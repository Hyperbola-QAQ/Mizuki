---
title: WSL2-USB透传与串口调试
published: 2026-03-17 21:33:00
updated: 2026-03-17 21:33:00
pinned: false
description: WSL2 环境下通过 usbipd-win 实现 USB 设备透传与串口调试的完整指南
tags: [WSL2, USB, Windows, Linux]
category: 杂项
author: Hyperbola
draft: false
series: 杂项
---

# 前言
WSL2 运行在轻量级虚拟机中，默认无法直接访问宿主机的 USB 设备。通过 `usbipd-win` 工具，我们可以将 Windows 宿主的 USB 设备“绑定”并“附加”到 WSL2 内部，使其表现为 WSL2 本地的 USB 设备（如 `/dev/ttyUSB0`），从而使用 `picocom` 等 Linux 原生工具进行调试。

---

# 第一步：宿主机 (Windows) 设置

### **1. 安装 usbipd-win**

使用 `winget` 安装官方推荐的 USBIP 守护进程。

```powershell
# 在 PowerShell 或 CMD 中运行 (需管理员权限)
winget install dorssel.usbipd-win
```
*安装完成后，建议重启终端以确保 `usbipd` 命令可用。*

### **2. 查找并绑定 USB 设备**

查看已连接的 USB 设备列表，找到目标设备的 `BUSID`（例如 `2-1`）。

```powershell
# 列出所有 USB 设备
usbipd list

# 绑定目标设备 (将 <BUSID> 替换为你实际的 ID，如 2-1)
# 注意：此命令通常需要管理员权限
sudo usbipd bind --busid <BUSID>
```
> **提示**：如果不确定哪个是串口设备，可以拔掉设备前后对比 `list` 的结果，或者查看 `DESCRIPTION` 列中包含 "Serial"、"FTDI"、"CP210x" 等关键词的设备。
> *注：`bind` 操作只需执行一次，除非重启了 `usbipd` 服务或解绑了设备。*

---

# 第二步：WSL2 (Linux) 设置

### **1. 安装必要工具**

根据你的发行版安装 `usbutils` 和 `linux-tools`.
*注：你之前的命令使用了 `pacman`，以下以 **Arch Linux** 为例，同时也提供了 Ubuntu/Debian 的命令。*

**对于 Arch Linux / Manjaro:**

```bash
sudo pacman -Sy usbutils linux-tools
```

**对于 Ubuntu / Debian:**

```bash
sudo apt update
sudo apt install usbutils linux-tools-generic linux-tools-$(uname -r)
```

### **2. 配置内核模块自动加载 (关键步骤)**

为了让 WSL2 每次启动时自动加载虚拟主机控制器驱动 (`vhci_hcd`)，无需手动执行 `modprobe`，请执行以下操作：

```bash
# 将 vhci_hcd 添加到 modules 加载列表中
echo "vhci_hcd" | sudo tee /etc/modules-load.d/vhci_hcd.conf
```
*执行完上述命令后，你可以立即手动加载一次以生效（无需重启 WSL）：*
```bash
sudo modprobe vhci_hcd
```
> **验证**：重启 WSL (`wsl --shutdown` 然后重新进入) 后，运行 `lsmod | grep vhci`，如果有输出则说明自动加载成功。

**3. 附加 USB 设备**
从宿主机拉取设备。你需要知道宿主机的 IP 地址。
*技巧：使用 `ip r` 命令查看默认路由，其 gateway 即为宿主机 IP。*

```bash
ip r | grep default | awk '{print $3}'

# 附加设备 (将 <BUSID> 替换为你的实际 ID)
sudo usbip attach -r <HOST_IP> -b <BUSID>
```
*执行成功后，终端通常会显示 `Attach Device` 成功的信息。*

**4. 验证设备**
检查设备是否识别为串口设备。
```bash
ls -l /dev/ttyUSB*
# 或者查看内核日志
dmesg | tail
```
此时应该能看到 `/dev/ttyUSB0` (或其他编号)。

---

# 第三步：进行串口调试 (picocom)

现在设备已透传，可以像操作本地 Linux 一样使用 `picocom`。

```bash
# 波特率设为 115200，连接设备
# 建议先将用户加入 dialout 组以避免每次都用 sudo (见下文注意事项)
picocom -b 115200 /dev/ttyUSB0
```

**常用 picocom 快捷键：**
*   `Ctrl+A` 然后 `Ctrl+X` : 退出 picocom
*   `Ctrl+A` 然后 `Ctrl+H` : 查看帮助菜单

---

### 常见问题与优化建议

#### 1. 权限问题 (推荐永久解决)
如果在 WSL 中运行 `picocom` 提示 `Permission denied`，是因为当前用户不在 `dialout` 组。
Arch为 `uucp` 组
```bash
# 将当前用户加入 dialout 组
sudo usermod -aG dialout $USER
```
*注意：更改组后，必须**完全注销并重新登录** WSL 会话（或重启 WSL）才能生效。之后即可直接使用 `picocom` 而无需 `sudo`。*

#### 2. 设备被占用
确保在 Windows 宿主机上没有其他程序（如 Putty, 串口助手, IDE 的串口监视器）占用该 COM 口，否则 `bind` 或 `attach` 会失败。

#### 3. 断开连接
如果需要断开设备以便在 Windows 上使用：
```bash
# 列出已附加的设备
usbip list -l

# 分离设备 (需要知道端口号，通常是 0)
sudo usbip detach -p 0
```