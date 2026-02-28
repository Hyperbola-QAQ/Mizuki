---
title: 解决Docker与Libvirt网络冲突问题
published: 2025-11-14
updated: 2025-11-14
pinned: false
description: 通过systemd服务解决Docker设置FORWARD DROP策略后导致libvirt和Waydroid无法联网的问题
tags:
  - Docker
  - Libvirt
  - 网络配置
  - systemd
category: Linux运维
author: Hyperbola
draft: false
series: 网络运维解决方案
---

当然可以！下面是**完整版的 systemd 服务单元文件**，它会在系统启动时自动为 `virbr0`（libvirt）和 `waydroid0`（Waydroid）添加必要的 `FORWARD` 链规则，确保它们在 Docker 设置了 `FORWARD DROP` 策略后仍能正常联网。

------

### ✅ 最终版本：`/etc/systemd/system/network-forward-fix.service`

```ini
[Unit]
Description=Fix FORWARD rules for libvirt and Waydroid after Docker
After=libvirtd.service docker.service network.target
Before=network-online.target
Wants=libvirtd.service docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/iptables -I FORWARD -i virbr0 -j ACCEPT
ExecStart=/usr/bin/iptables -I FORWARD -o virbr0 -m state --state RELATED,ESTABLISHED -j ACCEPT
ExecStart=/usr/bin/iptables -I FORWARD -i waydroid0 -j ACCEPT
ExecStart=/usr/bin/iptables -I FORWARD -o waydroid0 -m state --state RELATED,ESTABLISHED -j ACCEPT
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

------

### 🔧 安装并启用服务

1. **创建服务文件**：

   ```bash
   sudo tee /etc/systemd/system/network-forward-fix.service <<'EOF'
   [Unit]
   Description=Fix FORWARD rules for libvirt and Waydroid after Docker
   After=libvirtd.service docker.service network.target
   Before=network-online.target
   Wants=libvirtd.service docker.service
   
   [Service]
   Type=oneshot
   ExecStart=/usr/bin/iptables -I FORWARD -i virbr0 -j ACCEPT
   ExecStart=/usr/bin/iptables -I FORWARD -o virbr0 -m state --state RELATED,ESTABLISHED -j ACCEPT
   ExecStart=/usr/bin/iptables -I FORWARD -i waydroid0 -j ACCEPT
   ExecStart=/usr/bin/iptables -I FORWARD -o waydroid0 -m state --state RELATED,ESTABLISHED -j ACCEPT
   RemainAfterExit=yes
   
   [Install]
   WantedBy=multi-user.target
   EOF
   ```

2. **重载 systemd 并启用服务**：

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now network-forward-fix.service
   ```

3. **验证是否生效**（可选）：

   ```bash
   sudo systemctl status network-forward-fix
   sudo iptables -L FORWARD -v -n | grep -E 'virbr0|waydroid0'
   ```

------

### 🔄 为什么这样设计？

- `After=libvirtd.service docker.service`：确保在 Docker 和 libvirt 启动后再加规则（避免被覆盖）
- `Before=network-online.target`：在网络完全就绪前完成配置
- 多个 `ExecStart=` 会按顺序执行，等价于逐条运行 iptables 命令
- 使用 `-I`（插入）而不是 `-A`（追加），确保规则在 Docker 的 `DROP` 之前匹配

> 💡 即使 `waydroid0` 或 `virbr0` 接口尚未存在，`iptables` 也不会报错，规则仍会被加入。当接口 later 出现时，规则自动生效。

------

### 🛡 可选增强：仅当接口存在时才添加规则（更健壮）

如果你希望更严谨（避免日志中出现“设备不存在”警告），可以用脚本包装：

```bash
sudo tee /usr/local/bin/fix-forward-rules.sh <<'EOF'
#!/bin/sh
for iface in virbr0 waydroid0; do
    if ip link show "$iface" >/dev/null 2>&1; then
        iptables -C FORWARD -i "$iface" -j ACCEPT 2>/dev/null || iptables -I FORWARD -i "$iface" -j ACCEPT
        iptables -C FORWARD -o "$iface" -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || iptables -I FORWARD -o "$iface" -m state --state RELATED,ESTABLISHED -j ACCEPT
    fi
done
EOF

sudo chmod +x /usr/local/bin/fix-forward-rules.sh
```

然后服务文件改为：

```ini
[Service]
Type=oneshot
ExecStart=/usr/local/bin/fix-forward-rules.sh
RemainAfterExit=yes
```

但对大多数用户来说，直接用上面的简单版本就足够了。

------

重启测试一下，你的虚拟机和 Waydroid 应该都能稳定联网了！如果还有问题，欢迎继续交流 😊