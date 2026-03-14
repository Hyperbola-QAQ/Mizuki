---
title: 聊天机器人大型项目开发环境部署一：Arch Linux 下 UML 可视化开发环境搭建
published: 2026-03-14 18:51:00
updated: 2026-03-14 18:51:00
pinned: false
description: Arch Linux 下 UML 可视化开发环境搭建
tags:
  - Linux
  - PlantUML
  - Arch
  - DevOps
  - Architecture
category: 开发
author: Hyperbola
draft: false
series: 聊天机器人大型项目开发
---

# 前言

在启动“ATRI”聊天机器人大型项目之前，构建一个高效的**可视化架构设计环境**至关重要。传统的绘图工具（如 Visio, Draw.io）在版本控制和代码协作上存在短板。

本系列第一篇将记录如何在 **Arch Linux** 上从零搭建基于 **PlantUML** 的现代化 UML 开发环境。我们将配置 Java 运行时、Graphviz 渲染引擎，并集成 VS Code 实现“所写即所得”的实时预览。同时，本文将正式发布我毕设系统的**初版云原生架构全景图**，该架构采用 K8s Native 设计，摒弃了传统注册中心，全面拥抱 Service Mesh。

# 环境准备

PlantUML 基于 Java 运行，并依赖 Graphviz 进行图形渲染。在 Arch Linux 上，我们可以通过包管理器快速安装。

## 1. 安装核心依赖

打开终端，执行以下命令：

```bash
# 更新源并安装 OpenJDK, Graphviz 和 PlantUML
sudo pacman -S jdk-openjdk graphviz plantuml
```

## 2. 验证安装

检查版本以确保安装成功：

```bash
java -version
plantuml -version
dot -V
```

> **提示**：如果 `plantuml` 命令无法直接调用，可能需要手动下载 `plantuml.jar` 并配置别名，但 Arch 官方源通常已配置好可执行文件。

# 编辑器集成 (推荐方案)

虽然命令行可以生成图片，但在开发过程中，我们需要**实时预览**和**错误高亮**。手动编写脚本监听文件变化已过时，推荐使用 **VS Code** 插件生态。

## 1. 安装 VS Code 及插件

如果你尚未安装 VS Code：
```bash
sudo pacman -S code
# 或者使用 AUR 安装 insiders 版本
# yay -S visual-studio-code-bin
```

在 VS Code 扩展商店中搜索并安装：
*   **PlantUML** (作者: jebbs) - *核心插件，提供预览、导出和语法支持*
*   **PlantUML Server** (可选) - *如果需要更复杂的渲染*

## 2. 配置实时预览

打开 VS Code 设置 (`Ctrl+,`)，搜索 `PlantUML`，确保以下配置项已启用（或直接写入 `settings.json`）：

```json
{
  "plantuml.render": "PlantUMLServer", 
  "plantuml.previewAutoRefresh": true,
  "plantuml.exportFormat": "svg",
  "plantuml.server": "https://www.plantuml.com/plantuml"
}
```

> **体验提升**：配置完成后，打开 `.puml` 文件，按下 `Alt+D` (或 `Cmd+Option+D` on Mac)，右侧将自动分屏显示架构图。修改代码后，图片将**毫秒级自动刷新**，无需任何手动脚本。

# ATRI 系统架构全景图 (初稿)

基于云原生理念，我们设计了 ATRI 的后端架构。该架构移除了冗余的 Nacos 组件，全面利用 Kubernetes 原生能力（Service, ConfigMap, Istio）进行服务治理。

将以下代码保存为 `architecture.puml`，即可在编辑器中查看效果。

```plantuml
@startuml architecture
' 设置样式，使其看起来更像现代架构图
skinparam componentStyle rectangle
skinparam monochrome false
skinparam defaultFontName "Microsoft YaHei"
skinparam shadowing false
skinparam linetype ortho

title ATRI后端系统架构全景图 (K8s Native 版)

' --- 1. 入口层 ---
package "入口层" as EntryLayer {
    component "NapCat\n(机器人入口)" as NapCat
    component "QQ 官方\n(机器人入口)" as QQOfficial
    component "React\n(网页入口)" as React
}
component "APISIX\n(API Gateway)" as APISIX

' --- 2. 负载均衡 ---
component "云厂商 SLB\n(Load Balancer)" as SLB

' --- 3. 容器集群 TKE (K8s) ---
node "容器集群 TKE (K8s)\n<color:red>HPA / VPA 自动扩缩容</color>" as TKE {
    
    ' 内部微服务组
    package "FastAPI 微服务组\n(Deployment + Service)" as MicroServices {
        component "用户模块" as UserSvc
        component "权限模块" as AuthSvc
        component "日志模块" as LogSvc
        component "教务信息模块" as EduSvc
        component "爬虫微服务" as CrawlerSvc
        component "机器人微服务" as BotSvc
        component "大模型微服务" as LLMsvc
    }

    ' 配置管理 (原生替代 Nacos Config)
    package "K8s 配置中心" as K8sConfig {
        component "ConfigMap\n<应用配置>" as ConfigMap
        component "Secret\n<敏感密钥>" as Secret
    }

    ' 服务网格 (原生替代 Nacos Discovery)
    component "Istio Sidecar\n<mTLS, 流量治理, 熔断>" as Sidecar
    component "Istio Control Plane\n<服务发现 & 路由规则>" as IstioCP
}

' --- 4. 消息中间件 ---
package "消息中间件" as MQ {
    component "Kafka\n(Schema Registry)" as Kafka
}

' --- 5. 数据存储层 ---
package "数据存储层" as DataLayer {
    database "PostgreSQL (RDS)\n<主业务数据>" as PG
    database "Redis (DTS)\n<缓存 & 会话>" as Redis
    database "MongoDB (DDS)\n<非结构化数据>" as Mongo
    database "Elasticsearch\n<日志检索>" as ES
    database "ClickHouse\n<实时分析>" as CH
}

' --- 6. 可观测性体系 ---
package "可观测性体系" as Observability {
    component "TLS / Loki\n<日志收集>" as LogSys
    component "Prometheus + Grafana\n<指标监控>" as Promo
    component "SkyWalking / Jaeger\n<分布式追踪>" as Trace
    component "Sentry\n<错误 & 性能>" as Sentry
    component "告警中心\n(钉钉/企微/邮件)" as Alert
}

' --- 7. 安全与网络 ---
package "安全与网络" as Security {
    component "WAF + DDoS" as WAF
    component "Cloud Secrets Manager\n<云厂商密钥托管>" as CloudSecrets
}

' --- 8. CI/CD & GitOps ---
package "CI/CD & GitOps" as CICD {
    component "Gitea Actions\n<构建镜像>" as Build
    component "Git Repository\n<配置即代码 (Helm/Kustomize)>" as GitRepo
    component "ArgoCD / Flux\n<自动同步集群状态>" as GitOps
}

' ================= 关系连接 =================

' 流量主线
NapCat --> APISIX
QQOfficial --> APISIX
React --> APISIX
APISIX --> WAF : 流量清洗
WAF --> SLB
SLB --> TKE :  ingress

' TKE 内部逻辑
MicroServices ..> Sidecar : 所有流量经过 Sidecar
Sidecar ..> Kafka : 消息收发
Sidecar ..> MicroServices : 内部服务调用 (Service Name)
IstioCP ..> Sidecar : 下发路由/策略

' 配置管理 (替代 Nacos)
MicroServices ..> ConfigMap : 挂载/读取配置
MicroServices ..> Secret : 挂载敏感信息
CloudSecrets ..> Secret : 同步外部密钥
GitOps --> ConfigMap : 自动同步配置变更
GitOps --> MicroServices : 部署新版本

' 数据流向
Kafka --> DataLayer
MicroServices ..> DataLayer : 读写数据

' 可观测性
TKE ..> LogSys : 日志上报
TKE ..> Promo : 指标抓取
MicroServices ..> Trace : 链路埋点
MicroServices ..> Sentry : 错误上报
Alert <-- Promo
Alert <-- Trace
Alert <-- LogSys
Alert <-- Sentry

' CI/CD 流程
Build --> GitRepo : 推送镜像 Tag
GitRepo --> GitOps : 触发同步
GitOps --> TKE : 应用变更 (Deployment/ConfigMap)

hide empty members
@enduml
```

### 架构设计要点说明

1.  **原生配置服务**：
    *   利用 **K8s Service + CoreDNS** 替代服务发现。
    *   利用 **ConfigMap/Secret + GitOps** 替代配置中心，实现配置版本化和审计。
2.  **服务网格 (Service Mesh)**：
    *   引入 **Istio Sidecar**，将流量治理（熔断、限流、mTLS）从业务代码中剥离，由基础设施层统一处理。
3.  **可观测性闭环**：
    *   集成了 **Sentry** 用于代码级错误追踪，弥补了传统日志系统（ELK/Loki）在堆栈分析上的不足。
    *   **SkyWalking** 负责全链路追踪，定位跨服务延迟。

# 结语

通过本文，我们不仅在 Arch Linux 上构建了高效的 UML 开发工作流，还确立项目“云原生、可观测、自动化”的技术基调。摒弃手动脚本，拥抱现代工具链，将让我们更专注于业务逻辑的实现。
