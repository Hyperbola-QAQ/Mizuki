// Skill data configuration file
// Used to manage data for the skill display page

export interface Skill {
	id: string;
	name: string;
	description: string;
	icon: string; // Iconify icon name
	category: "frontend" | "backend" | "database" | "tools" | "other";
	level: "beginner" | "intermediate" | "advanced" | "expert";
	experience: {
		years: number;
		months: number;
	};
	projects?: string[]; // Related project IDs
	certifications?: string[];
	color?: string; // Skill card theme color
}

export const skillsData: Skill[] = [
	// Backend Skills
	{
		id: "python",
		name: "Python",
		description:
			"Python 全栈开发，覆盖 Web 服务、数据清洗、爬虫与 AI 应用。",
		icon: "logos:python",
		category: "backend",
		level: "advanced",
		experience: { years: 2, months: 6 },
		projects: ["imbot-platform", "stroke-rehab"],
		color: "#3776AB",
	},
	{
		id: "fastapi",
		name: "FastAPI",
		description: "基于 FastAPI 构建高性能异步 API 服务与后端业务逻辑。",
		icon: "logos:fastapi",
		category: "backend",
		level: "advanced",
		experience: { years: 1, months: 6 },
		projects: ["imbot-platform", "stroke-rehab"],
		color: "#009688",
	},

	// Database Skills
	{
		id: "postgresql",
		name: "PostgreSQL",
		description: "使用 Patroni + etcd 搭建 PostgreSQL 高可用集群，支持自动故障转移。",
		icon: "logos:postgresql",
		category: "database",
		level: "intermediate",
		experience: { years: 1, months: 6 },
		projects: ["imbot-platform"],
		color: "#336791",
	},
	{
		id: "redis",
		name: "Redis",
		description: "Redis Sentinel 高可用与缓存层架构设计。",
		icon: "logos:redis",
		category: "database",
		level: "intermediate",
		experience: { years: 1, months: 0 },
		projects: ["imbot-platform"],
		color: "#DC382D",
	},
	{
		id: "kafka",
		name: "Kafka",
		description: "消息队列实现业务异步解耦，处理 IM 消息与事件流。",
		icon: "simple-icons:apachekafka",
		category: "database",
		level: "intermediate",
		experience: { years: 1, months: 0 },
		projects: ["imbot-platform"],
		color: "#231F20",
	},

	// Tools
	{
		id: "kubernetes",
		name: "Kubernetes",
		description: "K3s 高可用集群搭建、Kustomize 灰度发布与混沌工程韧性验证。",
		icon: "logos:kubernetes",
		category: "tools",
		level: "intermediate",
		experience: { years: 1, months: 6 },
		projects: ["imbot-platform"],
		color: "#326CE5",
	},
	{
		id: "docker",
		name: "Docker",
		description: "容器化构建、镜像仓库（Harbor）管理与自动化部署。",
		icon: "logos:docker-icon",
		category: "tools",
		level: "intermediate",
		experience: { years: 1, months: 6 },
		projects: ["imbot-platform"],
		color: "#2496ED",
	},
	{
		id: "jenkins",
		name: "Jenkins",
		description: "CI/CD 流水线构建，实现自动化构建、镜像推送与部署。",
		icon: "devicon:jenkins",
		category: "tools",
		level: "intermediate",
		experience: { years: 1, months: 0 },
		projects: ["imbot-platform"],
		color: "#D24939",
	},
	{
		id: "git",
		name: "Git",
		description: "分布式版本控制与 GitOps 工作流实践。",
		icon: "logos:git-icon",
		category: "tools",
		level: "advanced",
		experience: { years: 2, months: 0 },
		color: "#F05032",
	},
	{
		id: "linux",
		name: "Linux",
		description: "长期使用 Arch / Debian，熟悉服务器运维与 Shell 脚本。",
		icon: "logos:linux-tux",
		category: "tools",
		level: "advanced",
		experience: { years: 2, months: 6 },
		color: "#FCC624",
	},
	{
		id: "nginx",
		name: "Nginx",
		description: "Web 服务器与反向代理配置，涵盖 SSL、虚拟主机与负载均衡。",
		icon: "logos:nginx",
		category: "tools",
		level: "intermediate",
		experience: { years: 1, months: 6 },
		color: "#009639",
	},
	{
		id: "wireguard",
		name: "WireGuard",
		description: "基于 WireGuard 构建跨网段 VPN 内网，支撑高可用集群通信。",
		icon: "simple-icons:wireguard",
		category: "tools",
		level: "intermediate",
		experience: { years: 1, months: 6 },
		projects: ["imbot-platform"],
		color: "#88171A",
	},

	// Other Skills
	{
		id: "networking",
		name: "网络工程",
		description: "持有软考网络工程师资格，熟悉防火墙、IPv6 与网络排障。",
		icon: "mdi:lan",
		category: "other",
		level: "advanced",
		experience: { years: 2, months: 6 },
		certifications: ["软考中级 · 网络工程师"],
		color: "#2563EB",
	},
	{
		id: "langchain",
		name: "LangChain / Agent",
		description: "LangChain Agent 编排框架，实现语音助手与机械臂联动控制。",
		icon: "logos:langchain",
		category: "other",
		level: "intermediate",
		experience: { years: 1, months: 0 },
		projects: ["stroke-rehab"],
		color: "#1C3C3C",
	},
	{
		id: "rag",
		name: "RAG 知识库",
		description: "检索增强生成，构建医疗知识库问答链路。",
		icon: "mdi:database-search",
		category: "other",
		level: "intermediate",
		experience: { years: 1, months: 0 },
		projects: ["stroke-rehab"],
		color: "#7C3AED",
	},
];
