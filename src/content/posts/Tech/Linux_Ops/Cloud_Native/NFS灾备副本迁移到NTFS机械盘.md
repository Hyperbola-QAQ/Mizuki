---
title: Debian NFS 灾备副本迁移到 NTFS 机械盘的实践
published: 2026-10-05
updated: 2026-10-05
pinned: false
description: 将系统盘上的 NFS 异步灾备副本迁入 NTFS 机械盘中的 256GiB ext4 镜像，记录挂载保护、同步验证和回滚方法。
tags: [Debian, NFS, NTFS, ext4, Ansible, Kubernetes]
category: DevOps
author: Hyperbola
draft: false
---

# 为什么迁移灾备副本

NFS 主备节点通过 lsyncd 将文件复制到第三台灾备节点。灾备节点不持有 NFS VIP，也不向集群导出 NFS，但其副本目录 `/data/nfs-share` 位于约 119GiB 的系统盘上。备份增长会挤占系统、容器和控制面服务的空间，因此需要把副本迁入约 932GiB 的机械盘。

机械盘已经挂载到 `/data/ntfs`，文件系统是 NTFS，迁移前约有 478GiB 可用空间。盘上已有约 454GiB 数据，本次保留这些数据，不重分区、不格式化整个分区。

本文的节点名、地址、账户 `replicauser` 和示例 UUID 均为占位符。命令片段需要按实际环境替换，尤其不能把格式化命令指向现有磁盘分区。文中的格式化对象始终是新建的镜像文件。

# 保留访问路径，改变底层存储

直接把目录搬到 NTFS 会遇到两个问题：NTFS 当前按普通用户 UID/GID 1000 挂载，而复制账户使用 UID/GID 2000；文件级复制还需要保留 Linux 属主、权限和硬链接关系。只建立软链接并不能解决这些问题。

本次采用 ext4 文件系统镜像：把一个 **256GiB 镜像文件**放在 NTFS 分区中，再通过 loop 设备将镜像挂载到原路径 `/data/nfs-share`。

```text
当前 NFS 主节点
    │ lsyncd / rsync，异步复制
    ▼
灾备节点 /data/nfs-share
    │ ext4，保留 Linux 文件元数据
    ▼
loop 设备
    ▼
/data/ntfs/nfs-backup.ext4
    ▼
NTFS 机械盘
```

这样主节点的复制目标路径、NFS VIP、StorageClass 和现有 PVC 都不需要改动。镜像增加了一层存储管理，后续需要同时监控镜像内 ext4 和外层 NTFS 的剩余空间。

# 迁移前检查

在灾备节点检查实际文件系统与空间，而不是根据目录名判断磁盘：

```bash
lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINTS
findmnt -T /data/nfs-share
findmnt -T /data/ntfs
df -hT /data/nfs-share /data/ntfs
sudo du -sh /data/nfs-share
sudo find /data/nfs-share -xdev -printf '%U:%G\n' | sort | uniq -c
```

本次副本约为 11GiB，检查时约有 13.6 万个目录和文件，属主均为复制账户。镜像选用 256GiB，为现有副本留出增长空间，但这不是自动扩容方案。

**automount 的输出需要特别处理。** 本机 `/data/ntfs` 使用 systemd automount，`findmnt` 可能同时返回 `autofs` 和 `ntfs3` 两行。最初用整个输出与 `ntfs3` 比较时，前置检查直接退出，尚未创建镜像。后续改为按文件系统类型过滤：

```bash
findmnt -rn -M /data/ntfs -t ntfs3 -o FSTYPE
```

检查失败时应先解释输出，而不是移除保护条件。

# 镜像初始化遇到的 I/O 阻塞

首次尝试创建的是 64GiB 镜像，随后容量要求调整为 256GiB。初次运行 `mkfs.ext4` 时，进程长时间等待磁盘 I/O；内核日志出现 NTFS 文件的 `fallocate(0x10) is not supported`。在这一期间，灾备节点的 Kubernetes 心跳中断，节点进入 `NotReady`。

这说明初始化操作对宿主机产生了实际影响。日志与时间上的关联支持 discard 或初始化路径存在开销的判断，但不能仅凭这条日志断言完整内核根因。排查时还发现系统盘有 Btrfs 校验错误记录，应该独立核查，不能将其全部归因于本次镜像创建。

处置顺序是停止未完成的镜像初始化，确认生产 NFS 和另外两台控制面仍健康，恢复灾备节点，再继续迁移。初次操作尚未切换原副本目录，原始数据仍在系统盘上。

进一步检查发现，进程累计写入达到数十 GB，脏页一度约 13GiB，内存压力指标很高。发送 SIGINT、SIGTERM 和 SIGKILL 后，信号仍等待内核路径返回；降低初始化进程优先级后继续观察，最终进程退出。没有强制重启服务器。删除这个未完成、未挂载的 64GiB 文件后，脏页和内存压力下降，灾备节点恢复 `Ready`。

最终修复同时处理文件属性和格式化参数：先在空文件上设置 NTFS sparse 属性，再扩展逻辑容量；格式化使用 `-E nodiscard,lazy_itable_init=1,lazy_journal_init=1`。`nodiscard` 的含义见 [Debian mke2fs 手册](https://manpages.debian.org/trixie/e2fsprogs/mkfs.ext4.8.en.html)。NTFS 属性设置入口可对照 [Linux 6.12 的 NTFS3 xattr 实现](https://github.com/torvalds/linux/blob/v6.12/fs/ntfs3/xattr.c)。这些配置针对镜像，不用于改变整个分区的挂载策略。

# 分阶段迁移

**1. 创建并挂载镜像。**

在确认目标文件不存在、外层空间充足之后，创建 256GiB 镜像，并只格式化该文件。示例初始化命令如下，实际分配方式应以本机 NTFS 驱动能力为准：

```bash
sudo python3 - <<'PYTHON'
import os
import struct

image = "/data/ntfs/nfs-backup.ext4"
fd = os.open(image, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.close(fd)
flags = struct.unpack("<I", os.getxattr(image, "system.ntfs_attrib"))[0]
os.setxattr(image, "system.ntfs_attrib", struct.pack("<I", flags | 0x200))
assert struct.unpack("<I", os.getxattr(image, "system.ntfs_attrib"))[0] & 0x200
os.truncate(image, 256 * 1024**3)
assert os.stat(image).st_size == 274877906944
PYTHON
sudo filefrag -v /data/ntfs/nfs-backup.ext4
sudo mkfs.ext4 -F -E nodiscard,lazy_itable_init=1,lazy_journal_init=1 \
  -m 1 -L nfs-cold-backup /data/ntfs/nfs-backup.ext4
sudo mkdir -p /mnt/nfs-backup-stage
sudo mount -o loop,nodev,nosuid \
  /data/ntfs/nfs-backup.ext4 /mnt/nfs-backup-stage
```

这里明确设置 NTFS sparse 属性，逻辑容量不等于实际占用。本机设置属性并扩展后，`stat` 和 `du` 一度仍显示 256GiB，导致用 `st_blocks` 判断稀疏性的保护检查失败；但 `filefrag` 显示 0 个 extent，外层 NTFS 可用空间也未减少。这是实际观察到的统计差异，不能只凭 `du` 判断物理占用。后续结合属性位、extent 和外层 `df` 验证。

稀疏镜像并未预留完整的 256GiB 物理空间。外层 NTFS 空间不足仍会导致镜像写入失败，需要为其增长保留预算。

**2. 预复制。**

由 root 保存原副本的文件元数据：

```bash
sudo rsync -aHAX --numeric-ids --bwlimit=40000 \
  /data/nfs-share/ /mnt/nfs-backup-stage/
```

本次预复制返回码为 0，共复制约 136,084 个对象，文件总大小约 11.46GB。使用约 40MiB/s 的带宽上限控制复制开销。此阶段允许上游继续同步，完成不等于切换完成，因为源目录仍可能变化。

**3. 阻止新的复制会话，完成最终复制。**

在灾备节点对复制账户安装接收端保护，并设置维护标记 `/run/nfs-replica-blocked`。确认在途 rsync 已退出后，再执行最终增量复制和差异检查。维护期间生产 NFS 保持运行，灾备副本会暂时滞后。

**4. 切换挂载点。**

保留原目录作为回滚副本，将镜像从临时目录卸载，再挂载到 `/data/nfs-share`。未挂载时的底层空目录应禁止复制账户写入。镜像内的根目录仍使用复制账户 UID/GID 2000 和原有权限。

# 挂载依赖与接收端保护

仅在 `/etc/fstab` 增加一个挂载条目并不充分。若机械盘缺失或镜像挂载失败，复制程序可能把空挂载点当成普通目录，重新将副本写回系统盘。

因此需要两层保护：

- systemd 挂载单元依赖 `/data/ntfs` 的真实挂载，并随外层挂载停止。
- 复制账户的 SSH 公钥使用强制命令。强制命令检查维护标记、目标挂载点和预期 ext4 UUID，只允许 rsync 接收端命令。

挂载单元文件名应按实际路径生成：

```bash
systemd-escape --path --suffix=mount /data/nfs-share
```

示例配置如下：

```ini
[Unit]
Description=Cold NFS replica on mechanical disk
RequiresMountsFor=/data/ntfs
BindsTo=data-ntfs.mount
After=data-ntfs.mount

[Mount]
What=/data/ntfs/nfs-backup.ext4
Where=/data/nfs-share
Type=ext4
Options=loop,nodev,nosuid
TimeoutSec=120

[Install]
WantedBy=multi-user.target
```

UUID 检查针对内层 ext4 文件系统，而不是外层 NTFS。由于保护位于接收端，两台可能成为主节点的机器，以及自动同步和手动 rsync 入口，都受同一检查约束。

Ansible 仓库同步管理挂载单元、强制命令、主机级镜像路径及 UUID，并清除原有不带保护的复制公钥条目。留下旧公钥行会绕过新保护。

本次对两个 playbook 做了语法检查。完整仓库的 check mode 因缺少 Vault 解密凭据而中止，因此从仓库读取公开的 inventory 和 NFS 参数，在临时目录中建立仅包含存储任务的隔离入口。首次隔离 check mode 在 systemd 任务处失败：模板在检查模式下不会真正创建新单元，后续服务模块自然找不到该单元。修复后 check mode 跳过实际启用和启动操作，挂载模板与公钥保护变更均完成审核；实际服务状态在部署后单独验收。

镜像文件的 Ansible `stat` 检查设置 `get_checksum: false`、`get_mime: false` 和 `get_attributes: false`，只检查文件类型与逻辑容量，避免为了查看元数据而读取整个 256GiB 镜像。

# 追平时发现的源端读取权限问题

切换挂载后，原有 `sync-now` 返回 23。日志包含 45 条 `Permission denied`，检查主节点发现除了 UID/GID 2000 的文件，还存在 UID/GID 1000 和 65534 的业务文件。lsyncd 同样以复制账户运行，因此这不仅影响手动追平，也影响后续自动复制。

问题在源端：复制账户无法读取应用创建的部分文件。不能通过放宽灾备目标目录权限修复源端读取失败，也不宜把所有业务文件统一改为复制账户所有。

先通过临时读取能力验证：以原复制账户启动 rsync，增加 `CAP_DAC_READ_SEARCH` 后，向灾备节点的追平返回码为 0。随后在明确批准这项权限扩展之后，为两台可能成为 NFS 主节点的机器持久化配置：

```ini
[Service]
User=replicauser
Group=replicauser
AmbientCapabilities=CAP_DAC_READ_SEARCH
CapabilityBoundingSet=CAP_DAC_READ_SEARCH
```

这项能力可以绕过主机文件的 DAC 读取和目录搜索限制，其范围不局限于 NFS 目录。它不提供 DAC 写入绕过能力，但会扩大同步进程及其子进程的读取范围，应将其视为明确的安全边界调整。systemd 的行为见 [Debian systemd.exec 手册](https://manpages.debian.org/trixie/systemd/systemd.exec.5.en.html)。

手动同步入口通过 root 调用 `setpriv`，降为原复制账户，并保留所需读取能力：

```bash
setpriv --reuid=replicauser --regid=replicauser --init-groups \
  --inh-caps=+dac_read_search --ambient-caps=+dac_read_search -- \
  rsync <经过审核的同步参数>
```

两台机器都更新配置，仅重启当前 NFS 主节点的 lsyncd，NFS 服务继续运行。实际进程仍为 UID 2000，`CapEff` 和 `CapAmb` 均为 `0x4`；更新后观察到 lsyncd 的复制任务返回 0。灾备接收账户没有增加 capability，现有副本文件仍由该账户持有，因此不能把这套复制方式解释为已完整保存源节点所有 UID/GID。

# 验证与回滚

验收时分别检查底层位置、文件一致性和同步行为：

```bash
findmnt -rn -M /data/nfs-share -t ext4 -o SOURCE,FSTYPE,UUID
sudo losetup -l
df -hT /data/nfs-share /data/ntfs
sudo stat -c '%u:%g %a %n' /data/nfs-share
systemctl is-active 'data-nfs\x2dshare.mount'
```

本次实际验证结果如下：

| 验证项 | 结果 |
| --- | --- |
| 镜像逻辑容量 | 274,877,906,944 字节，即 256GiB |
| 底层位置 | loop 设备的 backing file 位于 `/data/ntfs/nfs-backup.ext4` |
| 文件一致性 | 阻止源副本继续变化后，全量 checksum dry-run 无差异 |
| 内层文件系统 | 切换前卸载，`e2fsck -fn` 五个检查阶段通过 |
| 挂载目录权限 | UID/GID 2000，模式 2770 |
| 镜像内空间 | 约 251GiB 可用文件系统容量，已用约 12GiB，剩余约 238GiB |
| 外层空间 | NTFS 剩余约 467GiB |
| 配置核对 | 存储 playbook 实际执行完成，`changed=0` |
| 持久化挂载 | systemd 单元为 active、enabled；停止后可重新启动 |
| 维护保护 | 实际 SSH 复制密钥被拒绝，返回 75 |
| 缺挂载保护 | 停止内层挂载且移除维护标记后，实际 SSH 复制密钥仍被拒绝，返回 75 |
| 底层空目录 | root 所有、模式 0000，复制账户不可写 |
| 自动复制探针 | 普通文件创建、修改、删除传播成功，符号链接目标正确 |
| 受限文件自动复制 | UID/GID 1000、模式 0600 的探针修改与删除传播成功；源权限保持不变 |
| 最终手动追平 | 更新后的同步入口向两台目标复制，返回码 0 |
| 集群状态 | 三个控制面节点均恢复 Ready，API 健康检查通过 |

**硬链接有额外边界。** 初次同时复制探针和硬链接时，目标 inode 相同；只修改其中一个路径后，lsyncd 的增量过滤只发送了该路径，rsync 的临时文件替换使目标硬链接关系断开。探针随后全部删除，检查现有生产源目录未发现其他多硬链接文件。`-H` 不能保证事件过滤下持续维护所有硬链接关系，不应将首次验证推广为此项长期保证。

为了避免 systemd 单元依赖检查误判，验证时同时传入 `/run/systemd/generator/data-ntfs.mount`。仅验证新单元时，检查工具最初报告找不到该生成单元；实际父挂载处于 active 状态，加入生成单元后验证通过。

没有进行整机重启，因此开机依赖已配置，但完整重启演练仍待执行。

业务持续写入时，跨主机全量 checksum 可能观察到不断变化的文件。不能把这种环境下的一次差异输出解释为全量一致性证明。需要将静态迁移数据校验与持续同步探针验证分别说明。

回滚前先阻止复制，卸载镜像并恢复 `/data/nfs-share.pre-migration-20261005`，再从当前 NFS 主节点追平。原复制公钥保存在灾备节点 root 专用备份目录内；恢复原系统盘目录时，需要同时恢复原接收方式，或调整接收端 guard，否则 ext4 UUID 检查会继续拒绝复制。原目录在切换后会逐渐变旧，不能直接视为最新副本。保留至少一个完整备份周期后，才考虑删除它并释放系统盘空间。

# 适用边界

本次范围是 NFS 文件副本，不能据此推断 PostgreSQL、Valkey 的 Local PV 已迁移。数据库自身的数据目录、WAL、备份仓库和一致性备份策略需要分别检查。

lsyncd 是异步文件复制，`--delete` 也会传播误删。它提供副本，不提供历史版本或零 RPO 保证。可恢复的数据库冷备仍需要数据库原生备份、保留周期和恢复演练。

# 经验小结

迁移的核心是改变副本的实际落盘位置，同时保存文件语义，并让缺盘时的复制明确失败。初始化也会影响宿主机，需要限制其 I/O 开销并观察节点健康；验收必须区分“已经配置”“已经测试”和“仍待验证”的项目。
