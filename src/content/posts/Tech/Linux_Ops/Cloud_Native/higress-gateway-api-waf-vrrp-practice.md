---
title: Kubernetes 高可用集群部署 Higress Gateway API、WAF 观察模式与 VRRP 亲和
published: 2026-09-08
updated: 2026-09-09
pinned: false
description: 记录在 kubeadm 高可用集群中以 hostNetwork 部署双副本 Higress、启用 IPv6 直连入口、Gateway API 与 WAF DetectionOnly 的实践和排障过程。
tags: [Kubernetes, Higress, Gateway API, Calico, Keepalived, WAF]
category: 云原生
author: Hyperbola
draft: false
series: Kubernetes 高可用实践
---

# 前言

目标是在三控制面 kubeadm 集群中部署 Higress，并完成四件事：启用 Gateway API、以 OWASP CRS 观察模式启用 WAF、让 Gateway 直接绑定宿主机的公网 `80/443`，以及让 API VIP 更倾向漂移到承载健康 Gateway Pod 的控制面节点。

这不是单纯安装一个 Helm Chart。Gateway Pod 分布到多个节点后，会立即验证集群的跨节点 Pod 网络、ClusterIP、CoreDNS 外部解析和镜像下载链路。本文记录最终配置，也保留实际遇到的 Calico 与 CoreDNS 故障，避免把“Pod Running”误判为网关已经可用。

# 环境与版本

本文环境已脱敏，节点和地址仅用于说明拓扑。

```text
Kubernetes: v1.36.4
Higress: 2.2.4
Gateway API CRD: v1.6.2
Calico: v3.28.2，VXLAN
控制面: 3 个节点，其中 2 个可混部并调度 Gateway，1 个带 NoSchedule 污点
API VIP: 192.0.2.100（示例地址）
Higress Gateway: 2 个副本
```

Higress 官方说明中，`2.2.4` 及以上版本支持 Gateway API `1.6.0`；因此使用同一稳定分支的 `v1.6.2` CRD。版本确认不能只看 Kubernetes 版本，还要看 Gateway 控制器支持的 API 版本。[Higress Helm 部署文档](https://higress.io/docs/latest/ops/deploy-by-helm/) 是最终依据。

# 部署 Gateway API 与 Higress

先安装 Gateway API CRD，再部署 Higress。Higress Controller 必须在 CRD 已建立后才能正确处理 `GatewayClass`、`Gateway` 和 `HTTPRoute`。

```yaml
# group_vars/all.yml 的关键变量
higress_enabled: true
higress_chart_version: "2.2.4"
higress_gateway_api_version: "v1.6.2"
higress_namespace: "higress-system"
higress_gateway_class: "higress"
higress_gateway_replicas: 2
higress_gateway_host_network: true
higress_gateway_ipv6_enabled: true
```

本集群保留 `NodePort` Service 以兼容既有 TCP Gateway 使用场景，但它**不是** Web 公网入口。HTTP/HTTPS Gateway 使用 `hostNetwork`：Pod 调度到哪台节点，Envoy 就直接在那台宿主机监听 `80/443`。这样无需让 API VIP 的 HAProxy 代理 Web 流量，也避免把控制面负载均衡器扩展成应用入口。

Higress 使用 Helm 部署，值文件至少包含：

```yaml
global:
  enableGatewayAPI: true
  enableIPv6: true
  o11y:
    enabled: false

higress-core:
  global:
    enableIPv6: true
  gateway:
    replicas: 2
    hostNetwork: true
    rollingMaxSurge: 0
    rollingMaxUnavailable: 1
    affinity:
      podAntiAffinity:
        requiredDuringSchedulingIgnoredDuringExecution:
          - labelSelector:
              matchLabels:
                ansible.kubernetes.io/higress-gateway: "true"
            topologyKey: kubernetes.io/hostname
    service:
      type: "NodePort"
    podLabels:
      ansible.kubernetes.io/higress-gateway: "true"
```

强制反亲和会让两个副本分别落在两个可调度节点；带 `NoSchedule` 污点的第三台控制面没有为 Gateway 添加 toleration，因此不会成为日常入口节点。`rollingMaxSurge: 0` 同样重要：hostNetwork 新副本不能与同节点的旧副本并存，升级必须先释放一个旧副本、再启动一个新副本。为 Gateway Pod 加稳定标签还能使 Keepalived 健康脚本和 PDB 不依赖 Chart 内部的临时标签或 ReplicaSet 名称。

# 公网入口与 IPv6 排障

最初错误地把 Higress 部署为 Web `NodePort` 入口，并给原本只服务 API VIP 的 HAProxy 增加了 `443` 前端。这并不是本环境所需的生产入口架构。外部域名只有 AAAA 记录，访问的是节点原生 IPv6 `:80`；NodePort 是 IPv4 单栈 Kubernetes Service 的高端口，既不会自动绑定宿主机 `:80`，也不能由 IPv6 客户端访问。

故障现象如下：

```text
curl: (7) Failed to connect to <public-ipv6> port 80: Could not connect to server
```

节点检查确认 HAProxy 当时只错误监听了 IPv6 `:443`，没有 `:80`；即使直接访问 IPv6 NodePort 也被拒绝。Kubernetes 的 IPv6 NodePort NAT 链为空，说明 Service 网络仍是 IPv4 单栈。这个现象发生在请求到达 Higress 之前，因此 `HTTPRoute` 的 `RequestRedirect` 不可能生效。

最终改为 hostNetwork 后，两个 Gateway Pod 直接绑定各自节点的双栈端口；HAProxy 只保留 API VIP 的 `6443`：

```text
可调度节点 A: Envoy 监听 0.0.0.0:80、[::]:80、0.0.0.0:443、[::]:443
可调度节点 B: Envoy 监听 0.0.0.0:80、[::]:80、0.0.0.0:443、[::]:443
受污点节点 C: 不调度 Gateway，不监听 Web 端口
HAProxy: 仅监听 API VIP:6443
```

Higress `2.2.4` 的 IPv6 开关位于子 Chart 的 `higress-core.global.enableIPv6`。只设置父 Chart 的 `global.enableIPv6` 不足以让 Gateway 监听 IPv6；修正子 Chart 字段并逐个滚动重启后，`ss -lntp` 才出现 `[::]:80` 和 `[::]:443`。这是实际验证得出的配置层级差异。

公网 HTTP 到 HTTPS 的重定向使用 Gateway API 标准过滤器：

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: http-to-https
  namespace: higress-system
spec:
  parentRefs:
    - name: higress-gateway
      sectionName: http
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            port: 443
            statusCode: 301
```

实际从节点 IPv6 访问带 Host 头的 HTTP 请求，返回 `301`，`Location` 保持原 Host 与路径并切换到 HTTPS。应同时检查 Route 的 `Accepted=True`、`ResolvedRefs=True` 及 Gateway 的 `Programmed=True`。

为避免维护操作同时驱逐两个入口副本，增加 PDB：

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: higress-gateway
  namespace: higress-system
spec:
  minAvailable: 1
  selector:
    matchLabels:
      ansible.kubernetes.io/higress-gateway: "true"
```

PDB 仅约束自愿驱逐，例如节点排空；它不能替代节点故障恢复，也不阻止错误的并行删除。滚动升级仍应保持 `maxUnavailable: 1`。

**高可用边界。** hostNetwork 让 Gateway Pod 可以在两个节点上独立提供入口，但域名必须指向可漂移的独立 IPv6 VIP，才能在节点故障时自动切换。若 AAAA 指向某一台节点的固定地址，那个节点故障后域名仍不可达；这不是 Gateway 副本或 VRRP 加权能单独解决的问题。

部署后的最小验证：

```bash
kubectl --kubeconfig=/etc/kubernetes/admin.conf \
  get crd gatewayclasses.gateway.networking.k8s.io \
  -o jsonpath='{.metadata.annotations.gateway\.networking\.k8s\.io/bundle-version}{"\n"}'

kubectl --kubeconfig=/etc/kubernetes/admin.conf \
  get gatewayclass higress

kubectl --kubeconfig=/etc/kubernetes/admin.conf \
  get pods -n higress-system \
  -l ansible.kubernetes.io/higress-gateway=true -o wide
```

预期 CRD 版本为 `v1.6.2`，`GatewayClass` 的 `Accepted` 条件为 `True`，并且两个 Gateway Pod 均为 `1/1 Running`。

# 让 VRRP 偏向健康 Gateway 节点

Keepalived 原本仅检查 HAProxy。增加一个咨询性 `vrrp_script`：如果本机存在 Ready 的 Higress Gateway Pod，给当前节点增加正权重；Kubernetes API 暂不可用或 Higress 还未部署时，脚本返回成功但不加分，不能破坏 API VIP 的基础高可用。

```conf
vrrp_script chk_higress_gateway {
  script "/usr/local/libexec/keepalived/check-higress-gateway.sh"
  interval 5
  fall 2
  rise 2
  weight 20
}

vrrp_instance VI_K8S_API {
  state BACKUP
  priority 110

  track_script {
    chk_haproxy
    chk_higress_gateway
  }
}
```

脚本查询本机节点名上的带标签 Pod，仅在 Ready 时返回零：

```bash
kubectl --kubeconfig=/etc/kubernetes/admin.conf \
  --request-timeout=3s \
  get pods -n higress-system \
  -l ansible.kubernetes.io/higress-gateway=true \
  --field-selector spec.nodeName="$NODE" \
  -o 'jsonpath={range .items[*]}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}' \
  | grep -qx True
```

**抢占取舍。** `nopreempt` 会阻止高优先级节点主动接管现有 MASTER，因此它与“Gateway 节点更容易成为 MASTER”的目标矛盾。本文默认允许抢占；如果业务更在意避免 VIP 回切，可显式设置 `keepalived_nopreempt: true`，此时加分只影响下一次故障选举。

应用前应在每台控制面验证：

```bash
keepalived -t -f /etc/keepalived/keepalived.conf
ip -4 -o addr show | grep '192.0.2.100'
```

任一时刻只能有一个节点持有 VIP。网络变更必须保留控制台或带外访问。

# 踩坑一：Calico 选中了 Tailscale 地址

首次部署后，一个 Gateway Pod 在第一台控制面 Ready，另一个位于第二台控制面却持续 `Running 0/1`。日志显示它无法连接 Higress Controller 的 ClusterIP：

```text
failed to sign CSR: connection error: dial tcp 10.x.x.x:15012: i/o timeout
readiness probe failed: connect: connection refused
```

节点和 Calico Pod 都显示 Ready，所以不能仅以 `kubectl get nodes` 判断跨节点网络正常。进一步从第二台节点测试 Controller Pod IP 与 ClusterIP，均超时；检查 VXLAN 发现本地端点使用了 VPN 接口地址。

```text
vxlan.calico ... local 100.64.x.x dev tailscale0
```

**根因。** Calico 默认 `first-found` 自动探测选中了 `tailscale0`，而非 Kubernetes Node 的 InternalIP。三个节点并不能经由该地址正常承载 VXLAN。

**修复。** 在 Tigera `Installation` 中声明 Kubernetes NodeInternalIP，并同时把 DaemonSet 的运行时变量固定为官方对应值。后者是为了应对已运行 Operator 未立即更新 DaemonSet 的情况。

```yaml
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    bgp: Disabled
    nodeAddressAutodetectionV4:
      kubernetes: NodeInternalIP
```

```bash
kubectl set env daemonset/calico-node -n calico-system \
  --containers=calico-node \
  IP_AUTODETECTION_METHOD=kubernetes-internal-ip

kubectl rollout status daemonset/calico-node -n calico-system --timeout=10m
```

DaemonSet 使用 `RollingUpdate` 且 `maxUnavailable=1` 时才应执行此滚动。完成后核对每个 Calico Node 都使用 Kubernetes 管理网地址：

```bash
calicoctl --allow-version-mismatch get nodes -o wide
```

这一步恢复了跨节点 Pod、Service 和 DNS 流量，第二个 Higress Gateway 随即 Ready。

# 启用 WAF 观察模式

Higress WAF 使用 Coraza/ModSecurity 规则语义，支持 OWASP CRS。上线初期不应直接开启阻断，而应先观察真实业务命中。`SecRuleEngine DetectionOnly` 会执行规则、生成审计信息，但不会执行 `deny`、`block`、`redirect` 等破坏性动作。[Higress WAF 插件文档](https://higress.io/docs/latest/plugins/security/waf/) 给出了相同的观察模式配置。

```yaml
apiVersion: extensions.higress.io/v1alpha1
kind: WasmPlugin
metadata:
  name: higress-waf-detection
  namespace: higress-system
spec:
  defaultConfig:
    useCRS: true
    secRules:
      - "SecRuleEngine DetectionOnly"
  failStrategy: FAIL_OPEN
  phase: AUTHZ
  priority: 330
  url: "oci://higress-registry.cn-hangzhou.cr.aliyuncs.com/plugins/go-waf:1.0.1"
```

`FAIL_OPEN` 的含义是 WAF 模块自身无法加载时不阻断业务流量。它不是安全模式替代品；应在日志和监控中对插件加载失败告警。

# 踩坑二：WAF OCI 插件无法下载

WAF 资源创建后，Gateway 日志出现：

```text
could not fetch Wasm OCI image
dial tcp: lookup higress-registry... on 10.96.0.10:53: no such host
```

初看宿主机可以解析仓库域名，容易误判为镜像仓库故障。实际链路是：Gateway Pod → CoreDNS Service → CoreDNS 上游。CoreDNS 的 `forward . /etc/resolv.conf` 继承了被 Tailscale 写入的 MagicDNS 地址，外部 OCI 域名解析不稳定。

**修复。** 对集群外部 DNS 使用显式、可达的上游，不再继承节点 `/etc/resolv.conf`。以下地址只作示例，生产环境应替换为组织认可的递归 DNS 或内部 DNS 转发器。

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |-
    .:53 {
        errors
        health
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
          pods insecure
          fallthrough in-addr.arpa ip6.arpa
        }
        forward . 223.5.5.5 8.8.8.8 {
          max_concurrent 1000
        }
        cache 30
        loop
        reload
        loadbalance
    }
```

修改 CoreDNS 会影响全体 Pod 的 DNS。应用前应评估 DNS 合规、内网私有域名和网络出口策略；应用后滚动 CoreDNS，并从 Gateway Pod 内验证仓库域名。

```bash
kubectl apply -f coredns-configmap.yaml
kubectl rollout restart deployment/coredns -n kube-system
kubectl rollout status deployment/coredns -n kube-system --timeout=5m

kubectl exec -n higress-system <gateway-pod> -- \
  getent hosts higress-registry.cn-hangzhou.cr.aliyuncs.com
```

最后滚动 Higress Gateway，让两个实例重新拉取 WAF：

```bash
kubectl rollout restart deployment/higress-gateway -n higress-system
kubectl rollout status deployment/higress-gateway -n higress-system --timeout=10m
kubectl logs -n higress-system \
  -l ansible.kubernetes.io/higress-gateway=true \
  --since=5m --prefix=true | grep -Ei 'go-waf|waf|wasm'
```

# WAF 日志、误报与拦截页

观察期应从 Gateway 日志中提取命中的规则 ID、URI、Host、方法和业务上下文，再决定是否豁免。不要只因一个请求命中就全局关闭 CRS。

```bash
kubectl logs -n higress-system \
  -l ansible.kubernetes.io/higress-gateway=true \
  --since=1h --prefix=true | grep -Ei 'waf|coraza|modsecurity|rule'
```

发现明确误报后，可在 `secRules` 加入精确 Rule ID 豁免；保持观察模式继续验证。

```yaml
secRules:
  - "SecRuleRemoveById 941160" # 示例：替换为日志中确认的规则 ID
  - "SecRuleEngine DetectionOnly"
```

若未来改为 `SecRuleEngine On`，务必先在预发布环境回归关键接口。WAF 默认不是一套品牌化“拦截页”产品；阻断时通常返回拒绝响应。要提供自定义用户页面，应另行设计网关错误响应或由应用层处理，不应把观察模式直接切到阻断模式。

# 验证清单

- [ ] 三个 Kubernetes Node 均为 `Ready`。
- [ ] `calicoctl get nodes -o wide` 的 IPv4 地址均为 Kubernetes NodeInternalIP。
- [ ] Gateway API CRD 注解版本为 `v1.6.2`。
- [ ] `GatewayClass/higress` 的 `Accepted=True`。
- [ ] 两个 Higress Gateway Pod 均为 `1/1 Running`，并分布在预期节点。
- [ ] 两个可调度节点均由 Envoy 监听 `0.0.0.0:80`、`[::]:80`、`0.0.0.0:443`、`[::]:443`；受污点节点不监听这些端口。
- [ ] API HAProxy 仅监听 API VIP 的 `6443`，不再占用 `80/443`。
- [ ] IPv6 HTTP 请求返回 `301`，且 `Location` 为同一 Host、同一路径的 HTTPS URL。
- [ ] `PodDisruptionBudget/higress-gateway` 显示 `minAvailable: 1` 且至少允许一个副本存活。
- [ ] Gateway Pod 内可解析 Higress OCI 仓库和镜像层下载域名。
- [ ] Gateway 日志没有 Wasm 插件下载或 DNS 错误。
- [ ] Keepalived 配置可通过 `keepalived -t`，且仅一个节点持有 API VIP。
- [ ] `higress-waf-detection` 的规则引擎为 `DetectionOnly`。

# 总结

这次实践中最重要的不是 Helm 命令，而是把“资源已经创建”“Pod Running”“网关真正可用”分开验证。Higress 的第二个副本揭露了 Calico 的错误隧道端点；WAF 的 OCI 拉取又揭露了 CoreDNS 继承 Tailscale MagicDNS 的问题；而公网 IPv6 的 `Connection refused` 则证明 Gateway API 的重定向规则不能弥补宿主机端口、Service IP 栈或入口架构的缺口。

可迁移的经验是：裸机集群若要让 Higress 直接成为 Web 入口，应明确选择 hostNetwork、LoadBalancer 或外部四层负载均衡器之一，不要只创建 NodePort 就假设公网 `80/443` 可达；为控制面高可用增加 Gateway 亲和时，健康检查必须是咨询性的；为 WAF 上线时，先使用 `DetectionOnly`；所有依赖 OCI/Wasm 的网关组件都必须从 Pod 视角验证 DNS、网络和镜像拉取链路。最后，Gateway 多副本与公网地址高可用属于两个层次：没有独立可漂移的 IPv6 VIP，固定节点 AAAA 仍是单点。
