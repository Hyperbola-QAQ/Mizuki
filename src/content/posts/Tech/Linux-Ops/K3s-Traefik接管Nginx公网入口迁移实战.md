---
title: K3s Traefik 接管 Nginx 公网入口迁移实战
published: 2026-08-19
updated: 2026-08-20
pinned: false
description: 使用 Ansible 恢复 K3s 默认 Traefik，将宿主机 Nginx 迁移至高位端口，并通过 Service 与 EndpointSlice 接入集群外服务的完整实践
tags: [Kubernetes, DevOps, Networking]
category: DevOps
author: Hyperbola
draft: false
series: K3s Traefik 与 Zabbix 部署实践
---

# K3s Traefik 接管 Nginx 公网入口迁移实战

本文是系列第一篇：让 k3s 默认 Traefik 接管公网 80/443，把宿主机 Nginx 临时迁移为 HTTP 30080 后端，同时保留原有静态网站和反向代理。

这是一套过渡架构，不是最终形态。后续会把大部分通用静态文件迁入 k3s，由 Deployment 配合镜像、ConfigMap 或持久卷托管；少数只属于某台节点的静态页面仍留在该节点，并继续通过本文的 Service + EndpointSlice 方式接入 Traefik。

## 1. 环境和目标

- `server`：10.0.0.10，承载 Blog、Gitea、Jenkins、Worldexec；
- `wsl`：10.0.0.20，k3s agent；
- `txy`：10.0.0.30，承载 Twikoo、Umami；
- `aly`：10.0.0.40，k3s control-plane/etcd；
- Traefik：统一监听 80/443、终止 TLS、执行 Host 路由；
- Nginx：统一监听 30080，只提供纯 HTTP 服务。

```mermaid
flowchart LR
    U["公网用户"] -->|"80/443"| T["k3s Traefik"]
    T -->|"HTTP 30080 + Host"| S["server Nginx\n10.0.0.10"]
    T -->|"HTTP 30080 + Host"| X["txy Nginx\n10.0.0.30"]
    S --> A["Blog/Gitea/Jenkins/Worldexec"]
    X --> B["Twikoo/Umami"]
```

## 2. 分步实施

### 2.1 修正 Ansible 基础环境

实际 inventory 位于 `~/.config/ansible/inventory.yml`。远端解释器应使用通用路径：

```ini
[defaults]
interpreter_python = /usr/bin/python3
inventory = /home/hyperbola/.config/ansible/inventory.yml
```

部分主机的 sudo PATH 没有 `/usr/sbin`，所以：

- play 显式设置标准 root PATH；
- Nginx 校验使用 `/usr/sbin/nginx -t`；
- 部署前用 `setup` 模块确认远端 Python。

### 2.2 安装 Nginx，但禁止 postinst 抢占 80

```yaml
- name: Install Nginx
  ansible.builtin.apt:
    name: nginx
    state: present
    update_cache: true
    cache_valid_time: 3600
    policy_rc_d: 101
  notify: Restart nginx
```

`policy_rc_d: 101` 会阻止新安装的 Nginx 使用默认配置立即启动。完整顺序是：

1. 安装软件包；
2. 渲染 30080 虚拟主机；
3. 删除默认 80 站点；
4. 执行 `/usr/sbin/nginx -t`；
5. 校验通过后 restart。

### 2.3 把旧 TLS 站点降为纯 HTTP 后端

```nginx
server {
    listen 30080;
    listen [::]:30080;
    server_name gitea.hyperbola.cc;

    location / {
        proxy_pass http://[::1]:30000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
    }
}
```

需要删除：

- `listen 80` 和 `listen 443 ssl`；
- 证书、TLS cipher/session/protocol；
- Nginx 内部 80→443 重定向；
- `/etc/nginx/sites-enabled/default`。

Traefik 会保留 Host，Nginx 的 name-based virtual host 仍然有效。

### 2.4 审计遗漏的 Nginx 配置

最终检查发现 `txy` 还有 Twikoo/Umami 占用 80/443。定位命令：

```bash
/usr/sbin/nginx -T 2>&1 | awk '
  /^# configuration file / { file=$4; sub(/:$/, "", file) }
  /^[[:space:]]*listen[[:space:]]/ { print file ": " $0 }
'
```

额外站点需要按主机过滤：

- Twikoo：仅部署到 `txy`，回源 `10.0.0.10:28080`；
- Umami：仅部署到 `txy`，回源 `10.0.0.10:23000`。

### 2.5 恢复 k3s 默认 Traefik

k3s 原配置包含：

```yaml
disable:
  - traefik
```

只删除 `- traefik`，不能重写整个 `config.yaml`，否则可能破坏 token、节点地址、Flannel、TLS SAN 和 etcd 设置。之后：

1. 重启 k3s；
2. 等待 `/readyz`；
3. apply k3s 生成的 packaged `traefik.yaml`；
4. 等待 `deployment/traefik` rollout。

### 2.6 在 EntryPoint 层全局跳转 HTTPS

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    additionalArguments:
      - --entryPoints.web.http.redirections.entryPoint.to=:443
      - --entryPoints.web.http.redirections.entryPoint.scheme=https
      - --entryPoints.web.http.redirections.entryPoint.permanent=true
```

必须使用 `to=:443`。本次故障中，线上参数是 `to=websecure`，而 `websecure` EntryPoint 在 Traefik 容器内监听 `:8443`，因此 Traefik 实际返回了 `Location: https://hyperbola.cc:8443/`。改成显式外部端口 `:443` 后，跳转恢复为 `https://hyperbola.cc/`。自动化还应等待 Deployment 参数出现 `--entryPoints.web.http.redirections.entryPoint.to=:443`，不能只确认 HelmChartConfig 已写入。

### 2.7 安装 cert-manager

公网入口统一由 Traefik 终止 TLS，证书管理也属于入口基础设施。使用 k3s `HelmChart` 安装 cert-manager，并等待 controller、cainjector、webhook 全部 Ready：

```yaml
apiVersion: helm.cattle.io/v1
kind: HelmChart
metadata:
  name: cert-manager
  namespace: kube-system
spec:
  chart: cert-manager
  repo: https://charts.jetstack.io
  version: v1.21.1
  targetNamespace: cert-manager
  createNamespace: true
  valuesContent: |-
    crds:
      enabled: true
    prometheus:
      enabled: false
```

### 2.8 配置 Cloudflare DNS-01

角色从 `/home/hyperbola/.acme.sh/account.conf` 读取已有 Cloudflare API Token，以 `no_log: true` 写入 `cert-manager` namespace 的 Secret，再由 `ClusterIssuer` 引用。Token 不进入 Git，也不能出现在 Ansible 输出中。

这里踩过的坑是错误是root下~/导致文件读取 `/root/.acme.sh/account.conf`。自动化应先用 `stat` 确认真实路径，并对读取、解析和写 Secret 的全部任务启用 `no_log`。

### 2.9 签发 ECDSA 通配符证书并全局使用

证书覆盖根域名和一级子域名，私钥算法使用 ECDSA：

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: hyperbola-cc-wildcard
  namespace: kube-system
spec:
  secretName: hyperbola-cc-wildcard-tls
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: letsencrypt-prod-cloudflare
    kind: ClusterIssuer
  dnsNames:
    - hyperbola.cc
    - "*.hyperbola.cc"
```

Kubernetes Secret 不能跨 namespace 直接引用，所以这里的“全局共享”发生在 Traefik TLS 终止层，而不是 Secret 层。在 `kube-system` 创建 Traefik 默认 TLSStore：

```yaml
apiVersion: traefik.io/v1alpha1
kind: TLSStore
metadata:
  name: default
  namespace: kube-system
spec:
  defaultCertificate:
    secretName: hyperbola-cc-wildcard-tls
```

工作链路为：cert-manager 签发 `Certificate` → 写入同 namespace 的 `hyperbola-cc-wildcard-tls` Secret → `TLSStore/default` 引用 Secret → Traefik 的 `websecure` EntryPoint 向各 namespace 的 HTTPS 路由提供默认证书。业务 Ingress 不声明 `tls.secretName`，因此 `default` 中的旧 Nginx 路由和 `zabbix` 中的 Web 路由都使用同一张证书，也不会产生多份 Secret 的续期状态漂移。

`*.hyperbola.cc` 只覆盖一级子域名，例如 `zabbix.hyperbola.cc`；它不覆盖 `a.b.hyperbola.cc`。

### 2.10 配置 Docker Hub mirror

Traefik Helm Job、CoreDNS 和 metrics-server 曾因无法拉取 pause 镜像卡在 `ContainerCreating`。四个节点统一配置：

```yaml
---
mirrors:
  docker.io:
    endpoint:
      - "https://docker.m.daocloud.io"
```

文件路径是 `/etc/rancher/k3s/registries.yaml`，使用 `serial: 1` 逐台重启 `k3s`/`k3s-agent`。

### 2.11 把集群外 Nginx 注册为 Kubernetes 后端

Nginx 没有 Pod label，所以使用无 selector Service + EndpointSlice。此类过渡资源属于入口迁移层，应放在 `default`，不能塞进 `zabbix` 业务 namespace：

```yaml
apiVersion: v1
kind: Service
metadata:
  name: host-nginx-server
  namespace: default
spec:
  ports:
    - name: http
      port: 30080
      targetPort: 30080
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: host-nginx-server
  namespace: default
  labels:
    kubernetes.io/service-name: host-nginx-server
addressType: IPv4
ports:
  - name: http
    protocol: TCP
    port: 30080
endpoints:
  - addresses:
      - 10.0.0.10
```

`addressType/ports/endpoints` 位于 EndpointSlice 顶层，不在 `spec` 下。不同主机必须使用独立 EndpointSlice：Twikoo/Umami 指向 10.0.0.30，不能复用 server 的后端。`host-nginx-aly` 当前仅预留无 selector Service，不设置地址和域名，因此不会接收流量；以后补齐 `address` 与 `hosts` 即可启用。以后迁入 k3s 的站点应删除对应外部 EndpointSlice；节点特有页面则保留独立后端，避免把节点本地文件错误地复制成共享内容。

## 3. 踩坑清单

1. 误以为安装过 ingress-nginx，实际上应直接恢复 k3s Traefik。
2. apt 安装 Nginx 时自动启动，可能抢占 Traefik 的 80。
3. sudo PATH 缺少 `/usr/sbin`，导致已存在的 Nginx 被误判为不存在。
4. 只迁移预想站点会遗漏其他 `sites-enabled` 文件。
5. `to=websecure` 会按容器内 `websecure=:8443` 生成错误跳转；外部 HTTPS 端口应显式写成 `to=:443`。
6. Docker Hub 不通会影响全部系统 Pod，不只是 Traefik。
7. 只 apply HelmChartConfig 不保证主 HelmChart 存在。
8. EndpointSlice 字段误放到 `spec` 会导致 strict decoding error。
9. 多台宿主机后端不能共用同一个 EndpointSlice 地址。
10. Kubernetes Secret 不能跨 namespace 共享，必须由 Traefik 默认 TLSStore 间接提供全局证书。
11. acme.sh 账户文件路径不能想当然；Cloudflare Token 相关任务必须完整使用 `no_log`。

## 4. 验收

```bash
ss -lntp | grep -E ':(80|443|30080) '
k3s kubectl -n kube-system rollout status deployment/traefik
k3s kubectl -n kube-system wait --for=condition=Ready \
  certificate/hyperbola-cc-wildcard --timeout=600s
k3s kubectl -n kube-system get tlsstore/default
k3s kubectl -n default get ingress,endpointslices
curl -I -H 'Host: zabbix.hyperbola.cc' http://10.0.0.10/
```

验收标准：

- Nginx 仅监听 30080；
- Traefik Ready；
- HTTP Location 不含 `:8443`；
- 每组域名指向正确的宿主机 EndpointSlice。

建议直接验证重定向头：

```bash
curl -v http://hyperbola.cc -H 'Host: hyperbola.cc' 2>&1 \
  | grep -E '< HTTP|< Location'
# Location: https://hyperbola.cc/
```

## 5. 完整顶层 Playbook

```yaml
---
- name: Move host Nginx away from Traefik ports
  hosts: server:txy:aly
  become: true
  gather_facts: false

  roles:
    - role: host_nginx_high_port

- name: Configure the container registry mirror on k3s nodes
  hosts: servers
  become: true
  gather_facts: false
  serial: 1

  roles:
    - role: k3s_registry_mirror

- name: Restore Traefik and deploy Zabbix Server in k3s
  hosts: server
  become: true
  gather_facts: false
  serial: 1

  roles:
    - role: k3s_traefik
    - role: zabbix_server_k3s

- name: Install and configure Zabbix Agent 2 on servers
  hosts: servers
  become: true
  gather_facts: true
  environment:
    PATH: /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

  roles:
    - role: zabbix_agent2
```

```bash
ANSIBLE_CONFIG="$HOME/.config/ansible/ansible.cfg" \
  ansible-playbook --syntax-check playbook.yml

ANSIBLE_CONFIG="$HOME/.config/ansible/ansible.cfg" \
  ansible-playbook playbook.yml
```
