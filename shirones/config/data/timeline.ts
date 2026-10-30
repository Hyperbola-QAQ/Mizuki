import type { TimelineItem } from "@/types/timelineConfig";

export const timelineData: TimelineItem[] = [
  {
    "title": "全日制本科",
    "date": "2023-09-01",
    "category": "education",
    "subtitle": "湖南中医药大学 · 计算机科学与技术 · 本科",
    "location": "长沙",
    "description": "本科在读，主攻云原生与网络运维，专业排名前 15%。",
    "highlights": [
      "专业排名前 15%",
      "校三等奖学金"
    ],
    "tags": [
      "Python",
      "Kubernetes",
      "网络工程",
      "AI"
    ],
    "icon": "material-symbols:school",
    "featured": true
  },
  {
    "title": "IMBot 及 DevOps 一体化平台",
    "date": "2024-06-01",
    "category": "project",
    "description": "基于 K3s、FastAPI 的高可用 IMBot 与 DevOps 安全平台，覆盖校园智能服务、自动化交付与韧性验证。",
    "highlights": [
      "Patroni + etcd 实现 PostgreSQL 高可用，Redis Sentinel 自动故障转移",
      "AstrBot 接入 QQ/微信校园通道，提供 RAG 知识库问答与成绩/课表查询",
      "Pipeline 构建并推送 Harbor，Kustomize 灰度发布，生产部署成功率 100%",
      "雷池 WAF 拦截率 99.2%，混沌工程下服务自愈、业务零中断"
    ],
    "tags": [
      "K3s",
      "FastAPI",
      "Kafka",
      "Patroni",
      "WireGuard",
      "SafeLine"
    ],
    "icon": "material-symbols:code",
    "featured": true
  },
  {
    "title": "脑卒中康复评估与训练系统",
    "date": "2024-09-01 – 2025-11-01",
    "category": "project",
    "subtitle": "湖南省大学生计算机程序设计竞赛",
    "description": "第二十一届湖南省大学生计算机程序设计竞赛项目，基于 AIoT 多模态感知的康复评估与训练系统。",
    "highlights": [
      "LangChain Agent 编排语音助手与机械臂联动控制",
      "RAG 构建医疗知识库问答链路，提升康复知识回答准确度",
      "负责数据库、Web 服务器与 GPU 服务器的整体部署运维"
    ],
    "tags": [
      "LangChain",
      "RAG",
      "Agent",
      "模型部署"
    ],
    "icon": "material-symbols:code"
  },
  {
    "title": "绿盟科技 产品交付工程师",
    "date": "2026-03-01 – 2026-06-30",
    "category": "career",
    "subtitle": "绿盟科技集团长沙分公司 · 产品交付工程师（实习）",
    "location": "长沙",
    "description": "湖南代表处工程交付部实习，负责安全设备交付、巡检与应急响应。",
    "highlights": [
      "独立完成 3 个项目共 10 台安全设备（含 5 台虚拟化设备）安装交付全流程",
      "协助 4 个项目 26 台设备实施，参与大型防火墙项目割接",
      "开展设备深度巡检 12 次，处理 NTP 不同步、内存占用过高等隐患",
      "参与出口防火墙策略路由故障应急响应，快速恢复业务"
    ],
    "tags": [
      "WAF",
      "NIPS",
      "EDR",
      "防火墙",
      "堡垒机"
    ],
    "icon": "material-symbols:work",
    "featured": true
  },
  {
    "title": "湖南省大学生计算机程序设计竞赛 · 一等奖",
    "date": "2025-11-01",
    "category": "milestone",
    "subtitle": "湖南省大学生计算机程序设计竞赛",
    "description": "第二十一届湖南省大学生计算机程序设计竞赛应用开发类一等奖。",
    "tags": [
      "LangChain",
      "RAG",
      "AIoT"
    ],
    "icon": "material-symbols:emoji-events"
  },
  {
    "title": "软考中级 · 网络工程师",
    "date": "2025-11-01",
    "category": "milestone",
    "description": "取得计算机技术与软件专业技术资格（中级）网络工程师证书。",
    "tags": [
      "网络工程",
      "路由交换",
      "网络安全"
    ],
    "icon": "material-symbols:verified"
  },
  {
    "title": "中国大学生服务外包大赛（区域赛）· 三等奖",
    "date": "2025-06-01",
    "category": "milestone",
    "subtitle": "中国大学生服务外包创新创业大赛",
    "description": "中国大学生服务外包创新创业大赛区域赛三等奖。",
    "icon": "material-symbols:emoji-events"
  },
  {
    "title": "中国大学生计算机设计大赛 · 三等奖",
    "date": "2025-06-01",
    "category": "milestone",
    "subtitle": "中国大学生计算机设计大赛",
    "description": "中国大学生计算机设计大赛三等奖。",
    "icon": "material-symbols:emoji-events"
  }
];

export function getTimelineList(): TimelineItem[] { return timelineData; }
