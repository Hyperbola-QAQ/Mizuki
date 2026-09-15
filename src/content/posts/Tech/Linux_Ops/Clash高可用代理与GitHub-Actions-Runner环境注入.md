---
title: 使用 Keepalived 与 HAProxy 为 GitHub Actions Runner 提供高可用代理
published: 2026-09-15
updated: 2026-09-15
pinned: false
description: 基于双节点 Clash、Keepalived、HAProxy 与 systemd drop-in，为自托管 GitHub Actions Runner 提供稳定且可自动切换的 HTTP(S) 代理。
tags: [Clash, Keepalived, HAProxy, GitHub Actions, Ansible, systemd]
category: 运维实践
author: Hyperbola
draft: false
---

# 前言

自托管 GitHub Actions Runner 往往需要稳定访问 GitHub、软件包仓库和第三方依赖源。直接把代理配置为某一台 Clash 主机很简单，但该机器或 Clash 进程不可用时，新的 CI 任务就会失去网络出口。

这套方案将两个 Clash 节点组合成一个高可用 TCP 代理入口，并通过 systemd 的服务级环境变量，把该入口注入 GitHub Actions Runner。Runner 及其启动的 job 会自动拥有：

```bash
export HTTP_PROXY=http://<PROXY_VIP>:7897
export HTTPS_PROXY=http://<PROXY_VIP>:7897
```

关键点在于：Runner 只依赖一个虚拟 IP，不需要知道当前到底是哪台服务器在承载代理。

# 目标与适用范围

本文适用于有两台 Linux 服务器、两端均已运行 Clash 或 Mihomo，并且希望为 systemd 托管的 GitHub Actions Runner 提供自动故障切换 HTTP(S) 代理的场景。

本文不讨论 Clash 订阅、规则集和鉴权策略；重点是代理入口的可用性，以及 Runner 如何安全继承代理环境。

# 整体架构

```text
GitHub Actions job
        │
        │ HTTP_PROXY / HTTPS_PROXY
        ▼
   <PROXY_VIP>:7897
        │
        ▼
  Keepalived / VRRP
   ┌────┴────┐
   │         │
节点 A      节点 B
  │           │
HAProxy     HAProxy
  │           │
127.0.0.1   127.0.0.1
 :7897       :7897
  │           │
Clash/Mihomo Clash/Mihomo
```

两个节点各自只让 Clash/Mihomo 监听本机回环地址的 `7897` 端口。持有虚拟 IP 的节点由 HAProxy 对外监听 `<PROXY_VIP>:7897`，再将 TCP 连接转发至本地 Clash。

外部客户端始终使用同一个地址；HAProxy 不跨节点转发，持有 VIP 的机器只访问自己的本地 Clash。

# Clash 高可用实现

**固定本地监听端口。** 部署会检查 Clashctl 生成的运行时配置和 mixin 配置是否存在，再通过 mixin 持久设置 `mixed-port`：

```yaml
mixed-port: 7897
```

不直接修改运行时生成的 `runtime.yaml`。它通常由 Clashctl 合并生成，直接修改容易在下次重启或更新订阅时被覆盖。修改 mixin 后再调用 Clashctl 的合并流程，端口配置才会持续生效。

配置完成后，应确认本机端口可用：

```bash
nc -z -w 2 127.0.0.1 7897
```

**HAProxy 只做本地 TCP 转发。** 其前端绑定 VIP，后端指向本机回环地址：

```haproxy
frontend clash_proxy
    bind <PROXY_VIP>:7897
    default_backend local_clash

backend local_clash
    option tcp-check
    default-server inter 2s fall 2 rise 2
    server clash 127.0.0.1:7897 check
```

TCP 模式能够透明处理 HTTP 代理的 CONNECT 隧道和 SOCKS5 的 TCP 流量，但并不转发 UDP。为允许 HAProxy 在 VIP 被 Keepalived 接管前启动，节点启用了：

```conf
net.ipv4.ip_nonlocal_bind = 1
```

**Keepalived 负责 VIP 归属与切换。** 两节点通过单播 VRRP 协商 VIP 所有权；高优先级节点默认持有 VIP，另一节点备用。关键配置如下：

```conf
vrrp_script check_clash {
    script "/usr/local/libexec/check-clash-ha"
    interval 2
    timeout 3
    fall 2
    rise 2
    weight -100
}

vrrp_instance VI_CLASH {
    interface <INTERFACE>
    virtual_router_id <VRID>
    priority <PRIORITY>
    advert_int 1

    unicast_src_ip <LOCAL_NODE_IP>
    unicast_peer {
        <PEER_NODE_IP>
    }

    virtual_ipaddress {
        <PROXY_VIP>/24 dev <INTERFACE> label <INTERFACE>:clash
    }

    track_script {
        check_clash
    }
}
```

健康检查脚本只检查本地端口：

```sh
#!/bin/sh
exec /usr/bin/nc -z -w 2 127.0.0.1 7897
```

连续失败时，Keepalived 会降低当前节点的 VRRP 优先级，备用节点接管 VIP。客户端无须修改配置，新的连接会自动进入另一台机器。

# 将代理注入 GitHub Actions Runner

Runner 不是交互式 shell；将 `export HTTP_PROXY=...` 写入 `.bashrc`、`.zshrc` 或 `/etc/profile`，不能保证 systemd 启动的 Runner 会读取它们。

因此为每个 Runner 服务创建 systemd drop-in：

```ini
# /etc/systemd/system/<RUNNER_SERVICE>.d/proxy.conf
[Service]
Environment="HTTP_PROXY=http://<PROXY_VIP>:7897"
Environment="HTTPS_PROXY=http://<PROXY_VIP>:7897"
```

这使变量只作用于该 Runner，不会污染其他 systemd 服务；Runner 重启后，主进程与其派生的 job 进程都会继承这些变量。drop-in 也独立于原始 unit 文件，Runner 更新时通常不会被覆盖。

写入后需要执行：

```bash
systemctl daemon-reload
systemctl restart <RUNNER_SERVICE>
```

重启会中断该 Runner 当前正在执行的任务，应在空闲窗口操作，或在多 Runner 环境中逐台处理。

# 使用 Ansible 批量管理

项目中的 `github-actions-runner-proxy.yml` 调用 `github_actions_runner` role，完成以下工作：

1. 校验 Runner 服务名与两个代理地址；
2. 创建 `/etc/systemd/system/<service>.d/`；
3. 写入 `proxy.conf`；
4. 仅在配置变化时重新加载 systemd；
5. 仅重启配置发生变化的 Runner；
6. 使用 `serial: 1` 逐台执行，避免同时下线全部 Runner。

执行命令：

```bash
ANSIBLE_LOCAL_TEMP=/tmp/ansible-local \
ansible-playbook -b -i inventory/hosts.yml github-actions-runner-proxy.yml
```

inventory 中应声明 Runner 服务名和代理地址：

```yaml
github_actions_runner_services:
  - "actions.runner.<ORG>.<RUNNER_NAME>.service"

github_actions_runner_http_proxy: http://<PROXY_VIP>:7897
github_actions_runner_https_proxy: http://<PROXY_VIP>:7897
```

# 验证方法

**验证 VIP 与代理链路。** 先确认当前节点是否持有 VIP：

```bash
ip -4 addr show dev <INTERFACE>
```

再从客户端经 VIP 发起请求：

```bash
curl -x http://<PROXY_VIP>:7897 https://api.ipify.org
```

可在受控环境中临时停止当前主节点的 Clash/Mihomo，再检查 VIP 是否切换，并重新执行代理请求。此操作会影响经过该节点的代理连接。

**验证 Runner 环境。**

```bash
systemctl show \
  --property=ActiveState \
  --property=Environment \
  <RUNNER_SERVICE>
```

期望看到：

```text
ActiveState=active
Environment=HTTP_PROXY=http://<PROXY_VIP>:7897 HTTPS_PROXY=http://<PROXY_VIP>:7897
```

还可创建一个临时 workflow：

```yaml
steps:
  - name: Verify proxy
    run: |
      env | grep -E '^(HTTP|HTTPS)_PROXY='
      curl -I https://github.com
```

不要在日志中输出包含认证信息的代理 URL。若代理需要账号密码，应改用 secret 或受限凭据文件，避免直接写入 inventory。

# 注意事项

- VIP 需要位于 VRRP 可达的网络范围内；
- 此方案只为 TCP 代理提供高可用，UDP 不会经 HAProxy 转发；
- 端口健康检查只确认本地 Clash 可接受连接，不能代表订阅、DNS、上游网络和具体站点均可用；若需要更严格保障，可扩展为经代理请求可信探测地址；
- 对不应走代理的内网地址，可按实际需求为 Runner 补充 `NO_PROXY`；
- 本文示例已脱敏，发布时不要暴露真实内网地址、VRRP 密码、Token 或代理认证信息。

# 总结

高可用代理的关键是用 Keepalived 提供稳定 VIP、用 HAProxy 本地转发给 Clash，并借助健康检查让故障节点主动让出 VIP。

Runner 侧不依赖 shell 初始化文件，而是通过 systemd drop-in 继承代理环境。这样所有新启动的 GitHub Actions job 都使用稳定的高可用代理入口，同时配置影响范围保持在 Runner 服务本身。
