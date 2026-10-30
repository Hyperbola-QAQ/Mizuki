import type { ProjectItem } from "@/types/projectsConfig";

export const projectsData: ProjectItem[] = [
  {
    "key": "imbot-platform",
    "title": "IMBot 及 DevOps 一体化平台",
    "summary": "基于 K3s、FastAPI 的高可用 IMBot 与 DevOps 安全平台，实现校园智能化服务、自动化交付与韧性验证。",
    "category": "web",
    "phase": "building",
    "technologies": [
      "K3s",
      "FastAPI",
      "Kafka",
      "Patroni",
      "WireGuard",
      "SafeLine"
    ],
    "icon": "material-symbols:deployed-code-outline-rounded",
    "featured": true,
    "year": "2024"
  },
  {
    "key": "stroke-rehab",
    "title": "脑卒中康复评估与训练系统",
    "summary": "基于 AIoT 多模态感知的康复评估与训练系统：LangChain Agent 编排语音助手与机械臂联动，RAG 构建医疗知识库问答。",
    "category": "other",
    "phase": "shipped",
    "technologies": [
      "LangChain",
      "RAG",
      "Agent",
      "模型部署",
      "Python"
    ],
    "icon": "material-symbols:deployed-code-outline-rounded",
    "featured": true,
    "year": "2024–2025"
  }
];

export function getProjectsList(): ProjectItem[] { return projectsData; }
