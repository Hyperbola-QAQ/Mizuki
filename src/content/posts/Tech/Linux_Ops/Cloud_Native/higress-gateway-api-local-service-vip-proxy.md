---
title: 使用 Higress Gateway API 将本地 HTTP 服务经 VIP 发布到 HTTPS 域名
published: 2026-09-09
updated: 2026-09-09
pinned: false
description: 在 Kubernetes 高可用集群中，以无选择器 Service、EndpointSlice、浮动 VIP 与全局响应缓冲，将各节点的本地 HTTP 服务安全发布到 Higress Gateway。
tags: [Kubernetes, Higress, Gateway API, EndpointSlice, EnvoyFilter, Keepalived, DDNS]
category: 云原生
author: Hyperbola
draft: false
series: Kubernetes 高可用实践
---

# 使用 Higress Gateway API 将本地 HTTP 服务经 VIP 发布到 HTTPS 域名

Kubernetes 中的 Higress Gateway Pod 不能直接把 `127.0.0.1:9876` 当作节点上的本地服务。对 Pod 而言，`127.0.0.1` 始终是 **Pod 自己的网络命名空间**，不是宿主机。本实践将部署在控制面节点上的 ddns-go HTTP 服务，经 Keepalived 浮动 VIP 接入 Kubernetes，再由 Higress HTTPS Gateway 发布为 `ddns.example.com`。

本文适用于以下模式：每个边缘节点都独立运行同一个本地 HTTP 服务；Keepalived 在节点间漂移一个 VIP；外部用户只应访问一个稳定域名。文中的域名和地址均为脱敏示例。

# 目标与链路

本次要把节点本地监听的 `9876/TCP` 端口发布为 HTTPS：

```text
浏览器
  │ https://ddns.example.com
  ▼
VIP:443 上的 HAProxy / Higress NodePort
  ▼
Higress Gateway（TLS 终止、按 Host 路由）
  ▼
Kubernetes Service（无 selector）
  ▼
EndpointSlice: 192.0.2.100:9876（Keepalived 浮动 VIP）
  ▼
当前持有 VIP 的节点本地 ddns-go:9876
```

这里的关键不是“让 Gateway Pod 访问宿主机 localhost”，而是给本地服务提供一个可从 Pod 网络访问、又能随节点故障漂移的稳定下一跳。`192.0.2.100` 仅为文档保留地址；实际应替换为已由 Keepalived 管理的 IPv4 VIP。

# 前提与边界

开始前需要确认以下条件：

1. Higress 已启用 Gateway API，现有 HTTPS `Gateway` 已配置能覆盖业务域名的证书。
2. 对外的 `443/TCP` 已能进入 Higress，例如 VIP 上的 HAProxy 已转发至 Higress HTTPS NodePort。
3. 每台可能持有 VIP 的节点都运行本地服务，或至少当前持有 VIP 的节点在 `VIP:9876` 上可达。
4. Gateway Pod 到 VIP 的回程路由、ARP/VRRP 与宿主机防火墙允许 TCP `9876`。这是 Pod 访问本地服务时最容易被忽略的一段链路。
5. 已评估暴露该管理界面的认证、访问控制和审计要求。本文只解决转发，不替代认证与授权。

若服务只运行在一个固定节点，应将 EndpointSlice 指向该节点的稳定地址，或把服务容器化为 Deployment/DaemonSet；不应使用不承载该服务的 VIP。

# 为什么使用无选择器 Service 与 EndpointSlice

`HTTPRoute.backendRefs` 通常引用 Kubernetes `Service`，而不是裸 IP。对于不在 Kubernetes 内创建 Pod 的后端，最合适的建模方式是：

- 建立一个 **没有 selector** 的 `Service`；Kubernetes 不会替它自动生成端点。
- 自行创建带 `kubernetes.io/service-name` 标签的 `EndpointSlice`，把 VIP 和端口声明为该 Service 的端点。
- 让 `HTTPRoute` 引用 Service，Gateway 控制器再从 EndpointSlice 解析真正的上游地址。

它保留了 Gateway API 对 Service 后端的标准语义，也使 VIP、端口、路由域名都成为可审阅、可幂等应用的 Kubernetes 资源。

# 定义可审阅的变量

将地址、端口和命名集中到变量中。VIP 与具体节点地址不同：它必须是 Keepalived 已管理且可由 Pod 网络到达的地址。

```yaml
# group_vars/all.yml
higress_ddns_enabled: true
higress_ddns_namespace: "ddns"
higress_ddns_service_name: "ddns-local"
higress_ddns_route_name: "ddns"
higress_ddns_hostname: "ddns.example.com"
higress_ddns_backend_ip: "192.0.2.100" # 替换为 Keepalived 浮动 VIP
higress_ddns_backend_port: 9876
```

把端口写成变量并在 playbook 中检查 `1–65535`，可避免模板错误地生成不可用的 Service。若当前项目已有统一的 `k8s_api_vip`，可以将 `higress_ddns_backend_ip` 引用该变量，防止 API VIP 与业务后端地址分别维护后漂移。

# 创建 VIP 后端和 HTTPRoute

下面的清单是最小实现。现有 HTTPS Gateway 名为 `higress-gateway`，位于 `higress-system` 命名空间，并将 `https` 作为监听器名称；这些名称须与实际 Gateway 保持一致。

```yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: ddns
  labels:
    # 必须匹配 Gateway.spec.listeners[].allowedRoutes 的 namespace selector。
    monitoring-gateway-access: "true"
---
apiVersion: v1
kind: Service
metadata:
  name: ddns-local
  namespace: ddns
spec:
  # 故意不写 selector：端点由下方 EndpointSlice 显式维护。
  ports:
    - name: http
      protocol: TCP
      port: 9876
      targetPort: 9876
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: ddns-local-vip
  namespace: ddns
  labels:
    kubernetes.io/service-name: ddns-local
    endpointslice.kubernetes.io/managed-by: ansible
addressType: IPv4
ports:
  - name: http
    protocol: TCP
    port: 9876
endpoints:
  - addresses:
      - 192.0.2.100
    conditions:
      ready: true
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ddns
  namespace: ddns
spec:
  parentRefs:
    - name: higress-gateway
      namespace: higress-system
      sectionName: https
  hostnames:
    - ddns.example.com
  rules:
    - backendRefs:
        - name: ddns-local
          port: 9876
```

Service 的 `port` 与 EndpointSlice 的端口应相同，并且名称也应匹配。`conditions.ready: true` 表示该静态端点可被转发；它不等价于对本地服务进行主动健康检查。若本地服务可能在 VIP 所在节点不可用，应另外提供监控告警或在 VIP 切换逻辑中纳入服务健康状态。

# Gateway 的命名空间授权

跨命名空间附加 `HTTPRoute` 不只取决于 Route 本身。Gateway 的 HTTPS listener 必须允许 `ddns` 命名空间创建路由。例如以下 selector 要求命名空间带有 `monitoring-gateway-access: "true"` 标签：

```yaml
listeners:
  - name: https
    protocol: HTTPS
    port: 443
    hostname: "*.example.com"
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            monitoring-gateway-access: "true"
      kinds:
        - kind: HTTPRoute
```

这是有意的隔离边界：不要将 `allowedRoutes.namespaces.from` 改为 `All` 来图省事。应只为确实需要公开的业务命名空间添加匹配标签，并通过代码审查维护这份授权名单。

# 用 Ansible 幂等应用

本实践将清单做成 `roles/higress_gateway/templates/ddns-route.yaml.j2`，并由独立入口只协调这条业务路由：

```bash
ansible-playbook -i inventory/hosts.yml configure_higress_ddns.yml
```

独立入口的价值是避免调整一个小型反向代理时重跑集群初始化、CNI 或监控 Helm release。模板渲染后使用 server-side apply：

```bash
kubectl --kubeconfig=/etc/kubernetes/admin.conf \
  apply --server-side --force-conflicts \
  -f /etc/kubernetes/higress-ddns-route.yaml
```

`--force-conflicts` 只适合该清单由同一自动化系统拥有的场景。如果其他团队会手工维护同一资源，应移除它，先处理 field-manager 冲突，再决定字段归属。

# 分层验证

不要只看到 `HTTPRoute` 已创建就认为链路可用。至少按以下顺序检查：

**1. 验证 EndpointSlice。** 确认它指向预期 VIP 和端口，而不是某台节点的管理地址。

```bash
kubectl -n ddns get service ddns-local
kubectl -n ddns get endpointslice ddns-local-vip -o yaml
```

**2. 验证 Gateway API 资源状态。** `Accepted=True` 表示 Gateway 接纳了路由；`ResolvedRefs=True` 才表示 Service 引用已成功解析。

```bash
kubectl -n ddns get httproute ddns \
  -o jsonpath='{.status.parents[*].conditions}{"\n"}'
```

**3. 比较入口与后端响应。** 在能够访问 VIP 的节点上，先检查后端 HTTP，再以 SNI 方式检查 HTTPS Gateway。示例中的 `192.0.2.100` 需要替换为实际 VIP。

```bash
curl -i -H 'Host: ddns.example.com' http://192.0.2.100:9876/
curl -ik --resolve ddns.example.com:443:192.0.2.100 https://ddns.example.com/
```

管理页面通常会从 `/` 重定向到 `/login`，因此 `307` 后跟 `200` 是正常结果。还应抽查至少一个相对静态资源，确认其 MIME 类型和响应体没有变化：

```bash
curl -ik --resolve ddns.example.com:443:192.0.2.100 \
  https://ddns.example.com/static/common.css
```

本次排查中，入口页一度表现为样式缺失。最初单次对比 HTTPS Gateway 与直连 VIP 的 `static/common.css` 时，两侧都返回 `200`、`text/css; charset=utf-8`，且响应体大小相同；这只能排除持续性的后端内容差异，不能证明链路稳定。随后进行连续请求，才复现部分请求 `200` 但响应体为零，客户端报错：

```text
curl: (18) end of response with 160347 bytes missing
```

因此，验证必须检查**响应体是否完整**，不能只看 HTTP 状态码。

# 踩坑复盘：默认响应缓冲让 CSS 间歇性截断

**触发条件。** Higress 全局启用了 WAF。WAF 需要暂停 HTTP filter chain 以检查响应体；新建的 DDNS 路由没有纳入原有的响应缓冲策略。`bootstrap.min.css` 的大小为 `160347` 字节，超过了该路由实际生效的默认缓冲能力。

**现象与证据。** 失败请求的 Gateway access log 包含以下特征：

```text
response_code: 200
bytes_sent: 0
response_code_details: response_payload_too_large
```

这解释了“有时样式正常、有时样式缺失”：应用和路由本身都返回 `200`，但 Envoy 在将完整响应体写回客户端前耗尽缓冲，浏览器只得到中断的样式表。日志中同时可观察到 WAF 处理响应体时的内存告警；它说明响应体检查会放大对缓冲配置的依赖，但本次 CSS 截断的直接证据是 `response_payload_too_large`。

**无效尝试。** 仅通过一次 `curl` 比较 HTTPS 入口与直连 VIP，会得到两个看似正常的 `200`。这不能捕获间歇性截断；必须连续下载完整响应体，并把 `curl` 的退出状态而非状态码作为成功条件。

**修复。** 不再维护“某几个域名例外”的白名单，而是为带有 Higress Gateway 标签的工作负载内所有虚拟主机统一设置 `4 MiB`。这与全局响应体检查的运行方式一致，也避免未来新增域名再次落回较小默认值。

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: higress-gateway-response-buffer
  namespace: higress-system
spec:
  workloadSelector:
    labels:
      ansible.kubernetes.io/higress-gateway: "true"
  configPatches:
    - applyTo: VIRTUAL_HOST
      match:
        context: GATEWAY
      patch:
        operation: MERGE
        value:
          request_body_buffer_limit: 4194304 # 4 MiB
```

这里的 `match` 不再指定 route configuration 或 vhost，因此同一 Gateway 工作负载服务的全部虚拟主机都匹配。`4 MiB` 是每个需要缓冲响应的并发请求的上界，不是 Gateway 的总内存上界；提高该值前应按并发量评估 Gateway 内存余量。若存在数十 MiB 以上的下载或流式响应，更合适的方案是为其跳过响应体检查或使用专用下载入口，而非无上限提高缓冲。

**回归验证。** 应用全局策略后，对同一 CSS 经 HTTPS Gateway 连续完整下载 30 次，结果为 `success=30 failed=0`。这比“页面刷新一次看起来正常”更接近实际故障条件。

# 常见错误与取舍

**将后端写为 `127.0.0.1:9876`。** 这是最常见的错误。它会让 Higress Pod 回连自身，通常得到连接拒绝或错误服务。应使用宿主机可路由地址、hostNetwork 设计，或如本文一样使用 VIP。

**把 EndpointSlice 固定到单台节点。** 这样在该节点故障后即使 VIP 已切换，Gateway 仍继续访问旧节点。对于边缘自治且由 VIP 选主的服务，应让 EndpointSlice 指向 VIP；对于单实例服务则应使用 Deployment/Service 或配套的端点自动化。

**忽略 HTTPS 证书和 HTTP 重定向。** 后端是 HTTP 并不意味着公网入口也必须是 HTTP。TLS 应在 Higress 终止；明文 `80` 可以由单独的 HTTPRoute 重定向到同主机名的 HTTPS，避免管理密码在链路上裸露。

**把 HTTP `200` 当作静态资源成功。** 页面 HTML、CSS、JavaScript 的路径、Cookie 的 `Secure`/`SameSite` 属性、浏览器缓存、CSP、证书错误与响应缓冲耗尽都会造成相似现象。除 URL、状态码和 `Content-Type` 外，还要验证字节数、客户端退出状态及 Gateway 的 `response_code_details`；`200` 加 `bytes_sent: 0` 已经是失败。

# 总结

将宿主机本地端口暴露给 Gateway API 的核心判断是：**Gateway 的后端必须是 Pod 网络可达且具有正确故障语义的地址，而不是 Pod 的 localhost。** 对于由 Keepalived 管理、各节点独立运行的服务，使用无选择器 Service 加 EndpointSlice 指向浮动 VIP，能够把节点自治、VIP 故障切换和 Higress 的 TLS/域名路由衔接起来。启用会检查响应体的 WAF 后，还必须为所有 Gateway 虚拟主机设置与业务响应大小相匹配的缓冲。最后用 `Accepted`、`ResolvedRefs`、完整响应体与连续采样分层验证，才能确认“资源已创建”真正等价于“用户可用”。
