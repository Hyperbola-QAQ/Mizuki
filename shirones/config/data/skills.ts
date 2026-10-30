import type { SkillItem } from "@/types/skillsConfig";

export const skillsData: SkillItem[] = [
  {
    "name": "Python",
    "description": "Python 全栈开发，覆盖 Web 服务、数据清洗、爬虫与 AI 应用。",
    "icon": "simple-icons:python",
    "category": "backend",
    "level": "advanced"
  },
  {
    "name": "FastAPI",
    "description": "基于 FastAPI 构建高性能异步 API 服务与后端业务逻辑。",
    "icon": "simple-icons:fastapi",
    "category": "backend",
    "level": "advanced"
  },
  {
    "name": "PostgreSQL",
    "description": "使用 Patroni + etcd 搭建 PostgreSQL 高可用集群，支持自动故障转移。",
    "icon": "simple-icons:postgresql",
    "category": "database",
    "level": "intermediate"
  },
  {
    "name": "Redis",
    "description": "Redis Sentinel 高可用与缓存层架构设计。",
    "icon": "simple-icons:redis",
    "category": "database",
    "level": "intermediate"
  },
  {
    "name": "Kafka",
    "description": "消息队列实现业务异步解耦，处理 IM 消息与事件流。",
    "icon": "simple-icons:apachekafka",
    "category": "database",
    "level": "intermediate"
  },
  {
    "name": "Kubernetes",
    "description": "K3s 高可用集群搭建、Kustomize 灰度发布与混沌工程韧性验证。",
    "icon": "simple-icons:kubernetes",
    "category": "tooling",
    "level": "intermediate"
  },
  {
    "name": "Docker",
    "description": "容器化构建、镜像仓库（Harbor）管理与自动化部署。",
    "icon": "material-symbols:code-rounded",
    "category": "tooling",
    "level": "intermediate"
  },
  {
    "name": "Jenkins",
    "description": "CI/CD 流水线构建，实现自动化构建、镜像推送与部署。",
    "icon": "simple-icons:jenkins",
    "category": "tooling",
    "level": "intermediate"
  },
  {
    "name": "Git",
    "description": "分布式版本控制与 GitOps 工作流实践。",
    "icon": "material-symbols:code-rounded",
    "category": "tooling",
    "level": "advanced"
  },
  {
    "name": "Linux",
    "description": "长期使用 Arch / Debian，熟悉服务器运维与 Shell 脚本。",
    "icon": "material-symbols:code-rounded",
    "category": "tooling",
    "level": "advanced"
  },
  {
    "name": "Nginx",
    "description": "Web 服务器与反向代理配置，涵盖 SSL、虚拟主机与负载均衡。",
    "icon": "simple-icons:nginx",
    "category": "tooling",
    "level": "intermediate"
  },
  {
    "name": "WireGuard",
    "description": "基于 WireGuard 构建跨网段 VPN 内网，支撑高可用集群通信。",
    "icon": "simple-icons:wireguard",
    "category": "tooling",
    "level": "intermediate"
  },
  {
    "name": "网络工程",
    "description": "持有软考网络工程师资格，熟悉防火墙、IPv6 与网络排障。",
    "icon": "material-symbols:code-rounded",
    "category": "other",
    "level": "advanced"
  },
  {
    "name": "LangChain / Agent",
    "description": "LangChain Agent 编排框架，实现语音助手与机械臂联动控制。",
    "icon": "simple-icons:langchain",
    "category": "other",
    "level": "intermediate"
  },
  {
    "name": "RAG 知识库",
    "description": "检索增强生成，构建医疗知识库问答链路。",
    "icon": "material-symbols:code-rounded",
    "category": "other",
    "level": "intermediate"
  }
];

export function getSkillsList(): SkillItem[] { return skillsData; }
