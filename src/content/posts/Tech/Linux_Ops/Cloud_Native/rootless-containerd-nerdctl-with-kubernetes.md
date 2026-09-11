---
title: Kubernetes 节点上部署 Rootless containerd 与 nerdctl 的实践
published: 2026-09-08
updated: 2026-09-08
pinned: false
description: 在既有 Kubernetes rootful containerd 运行时旁，为普通运维用户建立隔离的 rootless containerd 与 nerdctl 工作环境。
tags: [Kubernetes, containerd, nerdctl, Rootless, Ansible]
category: 技术实践
author: Hyperbola
draft: false
---

# Kubernetes 节点上部署 Rootless containerd 与 nerdctl 的实践

在 Kubernetes 控制平面或工作节点上，`nerdctl` 是排查容器运行时的好工具；但直接让普通用户访问系统级 containerd，等价于授予其接近 root 的容器运行时控制权。本文记录一个更稳妥的方案：保留 Kubernetes 使用的 rootful containerd，同时为普通运维用户部署独立的 rootless containerd，让其无需 `sudo` 即可使用 `nerdctl` 管理自己的容器。

# 结论先行

rootless containerd 不会替换 Kubernetes 的容器运行时，也不会与 kubelet 使用的 rootful containerd 共享容器、镜像、网络命名空间或数据目录。它更适合普通用户进行镜像验证、临时容器调试和开发测试。

Kubernetes 的业务容器仍由系统级 containerd 管理。需要检查 Kubernetes 容器时，仍应通过受控的提权命令访问 rootful 运行时，例如：

```bash
sudo nerdctl --namespace k8s.io ps
```

普通用户运行的 `nerdctl ps` 则只显示其 rootless 环境中的容器。这种边界是预期行为，不是配置错误。

# 两套运行时的边界

部署完成后的关系如下：

```text
Kubernetes / kubelet
        |
        v
系统级 rootful containerd
        |
        +-- k8s.io 命名空间中的 Pod 容器

普通运维用户
        |
        v
nerdctl
        |
        v
用户级 rootless containerd（systemd --user）
        |
        +-- 该用户自行创建的容器与镜像
```

rootless 运行时通常使用用户自己的运行时目录和数据目录，并借助 RootlessKit、用户命名空间与 Slirp4netns 实现非特权运行。它不会接管 `/run/containerd/containerd.sock`，也不应改动 kubelet 的 CRI 配置。

# 为什么不让普通用户直接操作 rootful containerd

最初看起来可行的做法，是将系统级 containerd socket 的组设置为专用组，再把普通用户加入该组。虽然这能放宽 socket 的文件访问权限，却并不能构成安全的“无 sudo 运维模式”。任何可以完全控制 rootful containerd 的主体，都可以创建特权容器、挂载主机路径或获得等价的主机管理能力。

此外，nerdctl 会根据当前用户身份选择 rootless 行为。普通用户即使有权限读取 rootful socket，也不会自然获得 Docker 式的“加入某个组后自动操作 rootful daemon”的体验。因此，单纯调整 socket 组并不能可靠满足“普通用户无 sudo 使用 nerdctl”的目标。

另一种接近该目标的方式是给 `nerdctl` 设置 setuid 权限，但 nerdctl 官方 FAQ 明确不推荐这样做：它会把 root 级容器运行时能力交给普通用户。对于承载 Kubernetes 的生产节点，这个风险不值得接受。

# 部署前置条件

目标主机需要已有可用的系统级 containerd 与 Kubernetes。为 rootless 运行时补齐以下依赖：

```yaml
- name: 安装 rootless containerd 依赖
  ansible.builtin.apt:
    name:
      - rootlesskit
      - slirp4netns
      - uidmap
      - dbus-user-session
    state: present
```

还应确认目标用户在 `/etc/subuid` 和 `/etc/subgid` 中拥有子 UID/GID 映射。`containerd-rootless-setuptool.sh` 会依赖这些映射创建用户命名空间；若映射缺失，应先由系统管理员分配，而不是绕过该限制。

本文使用 nerdctl 的 minimal 发布包安装客户端。minimal 包不含 BuildKit，因此执行部分命令时可能出现无法识别 `buildctl` 版本的提示；如果需要 `nerdctl build`，应改用完整发布包或单独部署 BuildKit。

# 使用 Ansible 部署用户级运行时

部署顺序很重要：先安装依赖和 nerdctl，再为目标用户启用 linger，最后在该用户的会话环境中安装并启动 rootless containerd。

`linger` 让用户退出 SSH 会话后，其 `systemd --user` 服务仍能继续运行：

```yaml
- name: 为运维用户启用 linger
  ansible.builtin.command:
    cmd: loginctl enable-linger {{ rootless_containerd_user }}
  args:
    creates: /var/lib/systemd/linger/{{ rootless_containerd_user }}
```

安装过程必须以目标普通用户身份执行，并显式提供用户级 systemd 所需的环境变量：

```yaml
- name: 安装 rootless containerd
  become: true
  become_user: "{{ rootless_containerd_user }}"
  environment:
    XDG_RUNTIME_DIR: "/run/user/{{ rootless_containerd_uid }}"
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/{{ rootless_containerd_uid }}/bus"
  ansible.builtin.command:
    cmd: /usr/local/bin/containerd-rootless-setuptool.sh install
  args:
    creates: "{{ rootless_containerd_home }}/.config/systemd/user/containerd.service"
```

其中 `rootless_containerd_user`、UID 和 home 目录应由 inventory 或 facts 推导，不能将某个实际用户名写死在角色中。安装器会生成用户级 `containerd.service`，随后由用户自己的 systemd 管理。

# 常见故障与复盘

第一次以普通用户执行 `nerdctl ps` 时，常见报错类似：

```text
FATA rootless containerd not running? ...
```

这通常不是 Kubernetes containerd 故障，而是 rootless 运行时尚未安装、尚未启动，或命令缺少 `XDG_RUNTIME_DIR`。应先确认用户级服务状态：

```bash
systemctl --user is-active containerd
```

如果 Ansible 通过 `become_user` 执行该检查，还必须传入对应的 `XDG_RUNTIME_DIR` 与 D-Bus 地址。否则 systemd 可能找不到用户总线，导致“服务不存在”或“无法连接 bus”的假象。

另一个容易误判的问题是：普通用户的 `nerdctl ps` 成功但列表为空，而 `sudo nerdctl ps` 能看到内容。这说明 rootless 和 rootful 已正确隔离。请不要为了让两者显示相同容器而改用 setuid 或把 Kubernetes 运行时暴露给普通用户。

# 验收步骤

以普通用户登录后，依次执行：

```bash
systemctl --user is-active containerd
nerdctl version
nerdctl ps
```

预期用户级 containerd 返回 `active`，nerdctl 能显示客户端与服务端版本，`nerdctl ps` 即使为空也应正常退出。

随后验证 Kubernetes 未受影响：

```bash
sudo kubectl --kubeconfig=/etc/kubernetes/admin.conf get nodes
sudo nerdctl --namespace k8s.io ps
```

节点应保持 `Ready`，并且 rootful 的 `k8s.io` 命名空间能够列出 Kubernetes 容器。两个检查都通过，才能说明新增 rootless 环境没有干扰生产运行时。

# 运行与安全建议

rootless containerd 适合给普通运维用户提供有限、可审计的容器操作能力，但它仍会消耗主机 CPU、内存、磁盘与端口资源。生产环境中建议为这类用户容器建立镜像来源、资源配额、端口占用和清理策略。

不要把 rootless 运行时用于 Kubernetes 的 CRI，也不要修改 kubelet 的运行时 endpoint 指向用户级 socket。Kubernetes 需要稳定的系统级 CRI 服务；把它切换到 rootless 环境会破坏节点服务模型、权限边界和重启恢复路径。

如需下线该能力，应先停止用户级服务，再删除对应用户配置；在删除前确认该用户没有仍在运行的业务容器。不要删除系统级 containerd 数据目录，也不要影响 `k8s.io` 命名空间。

# 参考资料

- [nerdctl v2.3.5 Release](https://github.com/containerd/nerdctl/releases/tag/v2.3.5)
- [nerdctl FAQ：rootful 与 rootless 使用说明](https://github.com/containerd/nerdctl/blob/main/docs/faq.md)
- [nerdctl Rootless 文档](https://github.com/containerd/nerdctl/blob/main/docs/rootless.md)
