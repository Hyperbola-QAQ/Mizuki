---
title: K3s 部署 Jenkins 与 Kubernetes 动态 Agent 实战
published: 2026-08-20 21:00:00
updated: 2026-08-20
pinned: false
description: 在 K3s 中部署持久化 Jenkins，通过 Traefik HTTPS 发布，并使用最小权限的 Kubernetes 动态 Agent 执行流水线
tags: [Jenkins, Kubernetes, K3s, Traefik, CI/CD, DevOps]
category: DevOps
author: Hyperbola
draft: false
series: K3s Traefik 与 Zabbix 部署实践
---

把 Jenkins 从单机服务迁入 K3s，真正要处理的不是「启动一个容器」，而是持久化、入口 TLS、Controller 的最小权限，以及构建任务与 Controller 的隔离。本文以 K3s 默认 `local-path` 存储和 Traefik 为例，部署 Jenkins Controller，并让 Kubernetes 插件按需创建、使用后自动回收 Agent Pod。

## 目录

- [部署前检查](#部署前检查)
- [TLS Secret 的命名空间边界](#tls-secret-的命名空间边界)
- [部署 Jenkins Controller](#部署-jenkins-controller)
- [初始化与验证](#初始化与验证)
- [配置 Kubernetes 动态 Agent](#配置-kubernetes-动态-agent)
- [接入 WAF 时的精确排除](#接入-waf-时的精确排除)
- [用 Pipeline Graph View 替换 Blue Ocean](#用-pipeline-graph-view-替换-blue-ocean)
- [维护与小结](#维护与小结)

## 部署前检查

本文环境已由 Traefik 统一承接公网 HTTP/HTTPS，并在入口层完成 HTTP 到 HTTPS 的跳转。Jenkins 使用 `jenkins.hyperbola.cc`，默认 StorageClass 为 `local-path`。先确认集群、存储和入口资源均处于可用状态：

```bash
kubectl get nodes -o wide
kubectl get storageclass
kubectl get ingress -A
kubectl -n kube-system get secret hyperbola-cc-wildcard-tls
```

`local-path` 的卷存储在被调度节点的本地磁盘。它适合单副本 Jenkins，但不具备跨节点高可用能力；节点迁移、节点故障或升级前都应先备份 `/var/jenkins_home` 对应的数据卷。生产环境若需要跨节点恢复与快照，应改用 Longhorn、NFS 或其他满足 RWO/RWX 需求的存储。

## TLS Secret 的命名空间边界

Ingress 的 `spec.tls[].secretName` 只能引用**同一命名空间**的 Secret。即使集群已经在 `kube-system` 中维护通配符证书，`jenkins` 命名空间的 Ingress 也不能直接使用它。

创建命名空间并复制证书时，必须删除源对象的服务端元数据：

```bash
kubectl create namespace jenkins

kubectl -n kube-system get secret hyperbola-cc-wildcard-tls -o json \
  | jq 'del(
      .metadata.creationTimestamp,
      .metadata.resourceVersion,
      .metadata.uid,
      .metadata.managedFields,
      .metadata.ownerReferences
    ) | .metadata.namespace="jenkins"' \
  | kubectl apply -f -

kubectl -n jenkins get secret hyperbola-cc-wildcard-tls
```

这份证书副本不会随源 Secret 自动更新。更可靠的方案是在目标命名空间由 cert-manager 单独签发，或部署 Secret 同步控制器。若集群已经配置 Traefik `TLSStore/default` 作为默认证书，也可以让业务 Ingress 不再声明 `tls.secretName`，避免副本续期漂移；应以当前入口架构为准，不要混用两种策略。

## 部署 Jenkins Controller

下面的清单创建 10 GiB PVC、受限 ServiceAccount/RBAC、单副本 Controller、集群内 Service 和 HTTPS Ingress。`Recreate` 可以避免升级时两个 Pod 同时读写同一个 RWO 卷；`fsGroup: 1000` 则让 Jenkins 进程能够写入持久卷。

保存为 `jenkins.yaml`：

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: jenkins
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: jenkins-home-10gi
  namespace: jenkins
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: local-path
  resources:
    requests:
      storage: 10Gi
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: jenkins
  namespace: jenkins
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: jenkins-agent-manager
  namespace: jenkins
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log", "pods/exec"]
    verbs: ["create", "delete", "get", "list", "watch", "patch"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: jenkins-agent-manager
  namespace: jenkins
subjects:
  - kind: ServiceAccount
    name: jenkins
    namespace: jenkins
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: jenkins-agent-manager
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jenkins
  namespace: jenkins
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels:
      app: jenkins
  template:
    metadata:
      labels:
        app: jenkins
    spec:
      serviceAccountName: jenkins
      securityContext:
        fsGroup: 1000
        fsGroupChangePolicy: OnRootMismatch
      containers:
        - name: jenkins
          image: jenkins/jenkins:latest
          imagePullPolicy: IfNotPresent
          env:
            # Jenkins 使用中国标准时间（UTC+8）显示构建记录和日志
            - name: TZ
              value: Asia/Shanghai
            - name: JAVA_OPTS
              value: -Duser.timezone=Asia/Shanghai
          ports:
            - name: http
              containerPort: 8080
            - name: agent
              containerPort: 50000
          volumeMounts:
            - name: jenkins-home
              mountPath: /var/jenkins_home
          startupProbe:
            httpGet: { path: /login, port: http }
            periodSeconds: 10
            failureThreshold: 60
          readinessProbe:
            httpGet: { path: /login, port: http }
            periodSeconds: 10
            failureThreshold: 6
          livenessProbe:
            httpGet: { path: /login, port: http }
            periodSeconds: 20
            failureThreshold: 3
      volumes:
        - name: jenkins-home
          persistentVolumeClaim:
            claimName: jenkins-home-10gi
---
apiVersion: v1
kind: Service
metadata:
  name: jenkins
  namespace: jenkins
spec:
  selector:
    app: jenkins
  ports:
    - name: http
      port: 8080
      targetPort: http
    - name: agent
      port: 50000
      targetPort: agent
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: jenkins
  namespace: jenkins
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.priority: "1000"
spec:
  ingressClassName: traefik
  tls:
    - hosts: [jenkins.hyperbola.cc]
      secretName: hyperbola-cc-wildcard-tls
  rules:
    - host: jenkins.hyperbola.cc
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: jenkins
                port:
                  name: http
```

镜像标签应在生产环境固定为已验证的 LTS 版本或 digest，不能长期依赖 `latest`。端口 `50000` 只保留给集群内通信；本文后续使用 WebSocket Agent，因此无需把它暴露到公网。

应用并等待首次启动完成：

```bash
kubectl apply -f jenkins.yaml
kubectl -n jenkins rollout status deployment/jenkins --timeout=10m
kubectl -n jenkins get pod,pvc,svc,ingress -o wide
```

### 设置 Jenkins 时区

Jenkins 的时间由 JVM 时区决定。若未显式设置，容器通常使用 UTC，页面中的构建时间、计划任务和日志会比中国标准时间早 8 小时。为统一显示 UTC+8，在 Controller 容器中同时设置系统时区变量和 JVM 参数：

```yaml
env:
  - name: TZ
    value: Asia/Shanghai
  - name: JAVA_OPTS
    value: -Duser.timezone=Asia/Shanghai
```

已运行的 Deployment 可以直接更新并等待滚动发布：

```bash
kubectl -n jenkins set env deployment/jenkins \
  TZ=Asia/Shanghai \
  JAVA_OPTS='-Duser.timezone=Asia/Shanghai'
kubectl -n jenkins rollout status deployment/jenkins --timeout=5m
```

验证容器时区：

```bash
kubectl -n jenkins exec deployment/jenkins -- \
  date '+%Y-%m-%d %H:%M:%S %Z %z'
```

预期结果包含 `CST +0800`。将环境变量写入 Deployment 清单，后续重建或升级 Jenkins 时不会恢复为 UTC。

## 初始化与验证

Jenkins 初次启动会在 PVC 中生成初始管理员密码。它只应显示在受控终端中，绝不能写入文章、Git 仓库或构建日志：

```bash
kubectl -n jenkins exec deployment/jenkins -- \
  cat /var/jenkins_home/secrets/initialAdminPassword
```

完成初始化向导、创建正式管理员后，验证入口和日志：

```bash
curl -I http://jenkins.hyperbola.cc/
curl -I https://jenkins.hyperbola.cc/login
kubectl -n jenkins logs deployment/jenkins --tail=100
```

前者应由入口返回 `308` 并跳转至 HTTPS；后者正常应返回 `200`。若 Jenkins 未 Ready，不要急于调大 liveness 探针：优先检查 PVC 是否 `Bound`、镜像是否已拉取、`fsGroup` 是否解决了卷权限，再查看 Controller 日志。

## 配置 Kubernetes 动态 Agent

Controller 负责调度和保存状态，不适合直接执行构建。安装 Jenkins Kubernetes 插件后，进入 `Manage Jenkins → Clouds → New cloud → Kubernetes`，使用以下关键值：

| 配置项 | 值 |
| --- | --- |
| Name | `kubernetes` |
| Kubernetes URL | `https://kubernetes.default.svc.cluster.local` |
| Kubernetes Namespace | `jenkins` |
| Credentials | 留空，使用 Controller 的 ServiceAccount |
| Jenkins URL | `http://jenkins.jenkins.svc.cluster.local:8080` |
| WebSocket | 启用 |
| Container Cap | `5` |

先确认所授予的权限确实受限于 `jenkins` 命名空间：

```bash
kubectl -n jenkins get deployment jenkins \
  -o jsonpath='{.spec.template.spec.serviceAccountName}{"\n"}'

kubectl auth can-i create pods \
  --as=system:serviceaccount:jenkins:jenkins \
  -n jenkins
```

下面的 Pipeline 会创建一个临时 Alpine Pod。任务结束后 Kubernetes 插件会回收 Pod：

```groovy
podTemplate(yaml: '''
apiVersion: v1
kind: Pod
spec:
  serviceAccountName: jenkins
  containers:
    - name: shell
      image: alpine:3.22
      command: [sleep]
      args: [99d]
      tty: true
''') {
    node(POD_LABEL) {
        container('shell') {
            sh 'echo "Agent Pod: $(hostname)" && uname -a'
        }
    }
}
```

运行时观察资源：

```bash
kubectl -n jenkins get pods -w
```

构建 Pod 通常包含 `jnlp` 和工作容器两部分。若 Pipeline 需要 Maven、Node.js 或 Kaniko，应按任务在 Pod Template 中声明相应镜像；不要为了某个构建扩大 Controller 的 Role。需要访问 Kubernetes API 的构建也应使用另一个权限更小的 ServiceAccount。

## 接入 WAF 时的精确排除

若 Jenkins Ingress 接入 ModSecurity OWASP CRS，Pipeline 编辑器和 Stapler 的特殊媒体类型可能触发误报。正确处理方式是依据审计日志的 Host、Method、Path、参数与规则号创建**精确排除**，而不是关闭 Jenkins 整站 WAF。

### Jenkins `checkScript` 的 932110/932115 精确排除

以下示例仅放行 Stapler `render` 请求的 `920420`，以及 Pipeline `checkScript` 中 `oldScript`/`value` 参数被 RCE 规则误判的情况：

```apache
SecRule REQUEST_HEADERS:Host "@streq jenkins.hyperbola.cc" \
  "id:1001001,phase:1,pass,nolog,chain"
  SecRule REQUEST_METHOD "@streq POST" "chain"
    SecRule REQUEST_URI "@rx ^/\$stapler/bound/[0-9A-Fa-f-]+/render$" \
      "ctl:ruleRemoveById=920420"

SecRule REQUEST_HEADERS:Host "@streq jenkins.hyperbola.cc" \
  "id:1001002,phase:1,pass,nolog,chain"
  SecRule REQUEST_METHOD "@streq POST" "chain"
    SecRule REQUEST_URI "@rx ^/job/[^/]+/descriptorByName/org\.jenkinsci\.plugins\.workflow\.cps\.CpsFlowDefinition/checkScript$" \
      "ctl:ruleRemoveTargetById=932100;ARGS:oldScript,ctl:ruleRemoveTargetById=932100;ARGS:value,ctl:ruleRemoveTargetById=932105;ARGS:oldScript,ctl:ruleRemoveTargetById=932105;ARGS:value,ctl:ruleRemoveTargetById=932110;ARGS:oldScript,ctl:ruleRemoveTargetById=932110;ARGS:value,ctl:ruleRemoveTargetById=932115;ARGS:oldScript,ctl:ruleRemoveTargetById=932115;ARGS:value,ctl:ruleRemoveTargetById=932130;ARGS:oldScript,ctl:ruleRemoveTargetById=932130;ARGS:value,ctl:ruleRemoveTargetById=932150;ARGS:oldScript,ctl:ruleRemoveTargetById=932150;ARGS:value"
```

一次实际排障中，Request ID 关联的审计事务确认 `932110` 与 `932115`（Windows Command Injection）继续扫描 `checkScript` 的 `oldScript`/`value`，两条规则累计 20 分后由 `949110` 阻断。原先的 `1001002` 只收窄了 `932100`、`932105`、`932130` 与 `932150`，漏掉这两个规则，因而修复必须同步补齐它们。

该排除仍被严格限制为 `jenkins.hyperbola.cc`、`POST`、`CpsFlowDefinition/checkScript` 精确路径，以及两个指定参数；其他 Jenkins 路径、参数与 RCE 规则不受影响。每次新增排除都应先以服务端 dry-run 验证清单，再验证正常编辑、恶意请求和相邻路径。修改通过 `subPath` 挂载的 ConfigMap 后必须滚动重启 WAF Deployment，单纯 `kubectl apply` 不会让运行中的容器读到新文件。

## 用 Pipeline Graph View 替换 Blue Ocean

Blue Ocean 已停止功能演进。可以安装 `pipeline-graph-view`，在 Pipeline 构建详情中使用 `Pipeline Overview` 查看嵌套 Stage、并行分支和实时日志。

清理 Blue Ocean 前先检查其反向依赖；不要直接删除运行中容器的插件文件。确认无其他插件依赖后，停机、备份插件目录，再删除所有 `blueocean*` `.jpi`、`.bak` 和展开目录：

```bash
kubectl -n jenkins scale deployment/jenkins --replicas=0
kubectl -n jenkins wait --for=delete pod -l app=jenkins --timeout=5m

# 在 PVC 实际挂载位置执行；先核对输出，再删除。
find /var/jenkins_home/plugins -mindepth 1 -maxdepth 1 \
  -name 'blueocean*' -print

kubectl -n jenkins scale deployment/jenkins --replicas=1
kubectl -n jenkins rollout status deployment/jenkins --timeout=10m
```

恢复后检查日志没有插件加载错误，并确认原有 Pipeline、Kubernetes Cloud 与 HTTPS 入口仍可用。

## 维护与小结

日常维护命令如下：

```bash
kubectl -n jenkins get all
kubectl -n jenkins logs -f deployment/jenkins
kubectl -n jenkins rollout restart deployment/jenkins
kubectl -n jenkins rollout status deployment/jenkins
```

这套方案把 Jenkins 状态固定在 PVC，把构建计算交给短生命周期 Agent，并将 Kubernetes API 权限限制在一个命名空间内。最容易被忽略的三个边界是：TLS Secret 不能跨命名空间直接引用、`local-path` 不是高可用存储、WAF 误报必须精确收窄。把这三点处理好，Jenkins 才能成为可维护的 K3s CI 基础设施，而不只是一个能打开登录页的容器。
