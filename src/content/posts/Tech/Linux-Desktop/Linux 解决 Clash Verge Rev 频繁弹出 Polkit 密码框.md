---
title: 解决 Clash Verge Rev 频繁弹出 Polkit 密码框
published: 2026-02-19
updated: 2026-02-19
pinned: false
description: 解决Linux桌面环境下Clash Verge Rev频繁弹出Polkit认证对话框的方法
tags: [Linux, Desktop]
category: Desktop
author: Hyperbola
draft: false
series: Linux桌面问题解决
---

在使用 **Clash Verge Rev**（基于 Mihomo 内核的代理客户端）时，启用 **TUN 模式** 需要提权安装系统服务。每次开机时，系统都会弹出 Polkit 认证对话框要求输入密码，非常影响使用体验。

更糟糕的是，即使输入密码授权后，程序可能会在几十秒内**反复请求多次**，导致密码框弹窗不停出现。

```bash
# 系统日志中频繁出现
Feb 19 18:01:42 pkexec[18056]: pam_unix(polkit-1:session): session opened for user root(uid=0) by hyperbola(uid=1000)
Feb 19 18:02:01 pkexec[19304]: pam_unix(polkit-1:session): session opened for user root(uid=0) by hyperbola(uid=1000)
Feb 19 18:02:30 pkexec[20312]: pam_unix(polkit-1:session): session opened for user root(uid=0) by hyperbola(uid=1000)
```

**根本原因**：Clash Verge Rev 在启用 TUN 模式时会调用 `pkexec` 执行 `/usr/bin/clash-verge-service-install` 脚本，但 Polkit 没有缓存授权，导致每次操作都要求重新认证。

---

# 解决方案：配置 Polkit 规则免密

## 步骤 1：创建 Polkit 规则文件

```bash
sudo touch /etc/polkit-1/rules.d/99-clash-verge-service.rules
sudoedit /etc/polkit-1/rules.d/99-clash-verge-service.rules
```

**添加以下规则**：

```javascript
polkit.addRule(function(action, subject) {
    // 只针对当前用户 hyperbola
    if (subject.user == "hyperbola" && action.id == "org.freedesktop.policykit.exec") {
        
        // 获取完整的命令字符串 (例如："/usr/bin/sh -c /usr/bin/clash-verge-service-install")
        var commandLine = action.lookup("command_line");
        
        // 获取直接执行的程序路径 (例如："/usr/bin/sh")
        var program = action.lookup("program");

        // 调试日志：帮助你在 journalctl 中看到实际获取到的值
        polkit.log("DEBUG clash-verge: commandLine=" + commandLine + ", program=" + program);

        // 策略 1: 匹配完整命令行字符串中包含 clash-verge-service
        // 这能覆盖 "sh -c /usr/bin/clash-verge-service-install" 这种情况
        if (commandLine && commandLine.indexOf("clash-verge-service") !== -1) {
            return polkit.Result.YES;
        }

        // 策略 2: 如果是通过 sh/bash 执行，且命令行中包含 clash-verge
        // 防止某些情况下命令路径略有不同
        if (program && (program.endsWith("/sh") || program.endsWith("/bash"))) {
             if (commandLine && commandLine.indexOf("clash-verge") !== -1) {
                 return polkit.Result.YES;
             }
        }
    }
});
```

**关键点说明**：

| 要点                          | **说明**                                |
| ----------------------------- | --------------------------------------- |
| 文件名 `99-` 开头             | 确保最高优先级，最后执行                |
| `subject.user == "hyperbola"` | 只针对特定用户，更安全                  |
| `action.id` 匹配              | 只拦截 `org.freedesktop.policykit.exec` |
| `command_line` 查找           | 匹配被 `sh -c` 包裹的完整命令           |
| 双重策略                      | 防御性编程                              |

---

### 步骤 2：重新加载 Polkit

```bash
# 重启 polkit 服务使规则生效
sudo systemctl restart polkit

# 验证服务状态
systemctl status polkit --no-pager
```

---

### 步骤 3：验证规则是否生效

1. 打开 Clash Verge Rev
2. 点击 TUN 模式开关
3. **观察是否还弹密码框**

---

## 常见问题排查

### ❓ 问题 1：规则不生效

**检查清单**：
```bash
# 1. 规则文件是否存在
ls -la /etc/polkit-1/rules.d/99-clash-verge.rules

# 2. 检查 polkit 是否有加载错误
sudo journalctl -u polkit -n 20 --no-pager | grep -i "error\|fail"

# 3. 验证 polkit 已重启
sudo systemctl restart polkit

# 4. 检查用户名是否正确
whoami
# 确保规则中的 subject.user 与实际用户名一致
```

### ❓ 问题 2：pkcheck (验证规则用)带 detail 参数报错

```bash
# 错误信息：
# Only trusted callers can use CheckAuthorization() and pass details

# 原因：这是 Polkit 安全设计，普通用户不能传递 detail 参数
# 解决：直接用实际程序测试，或用 sudo 运行 pkcheck
sudo pkcheck -a org.freedesktop.policykit.exec -p $$ -d command "..."
```

### ❓ 问题 3：polkit.log() 不输出

**原因**：Polkit 默认以 `--no-debug` 启动

**解决**：按照步骤 1 启用调试模式

---

## 安全注意事项

| 风险       | **说明**                       
| ---------- | ------------------------------- 
| ⚠️ 免密范围 | 规则只针对特定用户和特定命令    |
| ⚠️ 命令匹配 | 使用 `indexOf` 模糊匹配         |
| ⚠️ 用户限制 | 只允许 `hyperbola` 用户         |

---


配置完成后，Clash Verge Rev 启用 TUN 模式时将**不再弹出密码框**，开机自启也会更加顺畅！🎉

**参考链接**：

- [Polkit 官方文档](https://www.freedesktop.org/software/polkit/docs/latest/)
- [Arch Wiki - Polkit](https://wiki.archlinux.org/title/Polkit)
- ##### [Clash Verge Rev GitHub](https://github.com/clash-verge-rev/clash-verge-rev)