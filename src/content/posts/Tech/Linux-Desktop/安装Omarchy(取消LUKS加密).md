---
title: 安装Omarchy系统（取消LUKS加密版本）
published: 2025-12-06
updated: 2025-12-06
pinned: false
description: Omarchy Arch Linux发行版的安装指南，特别说明如何取消LUKS磁盘加密配置
tags: [Linux]
category: DevOps
author: Hyperbola
draft: true
series: Linux系统安装
---

# 移除 Omarchy 的 LUKS 加密（安装后解密指南）

## 背景

Omarchy 是一个优秀的 Arch Linux 衍生发行版，但默认启用了 LUKS 全盘加密。若你希望取消加密以简化启动流程或提升性能，可按本指南操作。

Omarchy version:3.2.2

> ⚠️ **警告**：此操作涉及磁盘数据重加密，过程耗时较长且存在风险，请确保已完整备份重要数据。

---

## 操作步骤

### 1. 启动到 Arch Live 环境

使用 Arch 安装 ISO 启动系统。

### 2. 执行原位解密

运行以下命令对加密分区进行原位解密（以 `nvme0n1p2` 为例）：

```bash
cryptsetup reencrypt \
  --decrypt \
  --header /mnt/luks_header.bak \
  /dev/nvme0n1p2
```

> 🕒 此过程可能需要数小时，具体取决于磁盘大小与 I/O 性能，请勿中断。

### 3. 更新引导配置

#### 修改 Limine 默认配置
挂载原有 Omarchy 根分区（假设已挂载至 `/mnt`）

编辑 `/mnt/etc/default/limine`（若未 chroot，则路径为 `/mnt/@/etc/default/limine`,自行随机应变），移除内核命令行中的 `cryptdevice` 参数：

```diff
< KERNEL_CMDLINE[default]="cryptdevice=PARTUUID=a1678c68-c503-4a66-982d-8af66a0f63d1:root root=/dev/mapper/root zswap.enabled=0 rootflags=subvol=@ rw rootfstype=btrfs"
---
> KERNEL_CMDLINE[default]="root=PARTUUID=a1678c68-c503-4a66-982d-8af66a0f63d1 zswap.enabled=0 rootflags=subvol=@ rw rootfstype=btrfs"
```

> 💡 注意：`/etc/default/limine` 是 Omarchy 快照同步机制的源文件，若仅修改 `/boot/limine.conf`，下次快照更新时会被覆盖。

#### 同步更新 `/boot/limine.conf`

确保 `/boot/limine.conf` 中的内核参数也同步更新。

---

## 完成

完成上述步骤并重启后，系统将不再提示输入 LUKS 密码，直接进入未加密的 Btrfs 根文件系统。

---

*创建时间：2025-12-06 23:20*

最后更新：2025-12-06 23:20