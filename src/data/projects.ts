// Project data configuration file
// Used to manage data for the project display page

export interface Project {
	id: string;
	title: string;
	description: string;
	image: string;
	category: "web" | "mobile" | "desktop" | "other";
	techStack: string[];
	status: "completed" | "in-progress" | "planned";
	liveDemo?: string;
	sourceCode?: string;
	visitUrl?: string;
	startDate: string;
	endDate?: string;
	featured?: boolean;
	tags?: string[];
	showImage?: boolean;
}

export const projectsData: Project[] = [
	{
		id: "imbot-platform",
		title: "IMBot 及 DevOps 一体化平台",
		description:
			"基于 K3s、FastAPI 的高可用 IMBot 与 DevOps 安全平台，实现校园智能化服务、自动化交付与韧性验证。",
		image: "",
		category: "web",
		techStack: ["K3s", "FastAPI", "Kafka", "Patroni", "WireGuard", "SafeLine"],
		status: "in-progress",
		startDate: "2024-06-01",
		featured: true,
		tags: ["Kubernetes", "AI", "DevOps", "高可用"],
		showImage: false,
	},
	{
		id: "stroke-rehab",
		title: "脑卒中康复评估与训练系统",
		description:
			"基于 AIoT 多模态感知的康复评估与训练系统：LangChain Agent 编排语音助手与机械臂联动，RAG 构建医疗知识库问答。",
		image: "",
		category: "other",
		techStack: ["LangChain", "RAG", "Agent", "模型部署", "Python"],
		status: "completed",
		startDate: "2024-09-01",
		endDate: "2025-11-01",
		featured: true,
		tags: ["AI", "IoT", "竞赛项目"],
		showImage: false,
	},
];

// Get project statistics
export const getProjectStats = () => {
	const total = projectsData.length;
	const completed = projectsData.filter((p) => p.status === "completed").length;
	const inProgress = projectsData.filter(
		(p) => p.status === "in-progress",
	).length;
	const planned = projectsData.filter((p) => p.status === "planned").length;

	return {
		total,
		byStatus: {
			completed,
			inProgress,
			planned,
		},
	};
};

// Get projects by category
export const getProjectsByCategory = (category?: string) => {
	if (!category || category === "all") {
		return projectsData;
	}
	return projectsData.filter((p) => p.category === category);
};

// Get featured projects
export const getFeaturedProjects = () => {
	return projectsData.filter((p) => p.featured);
};

// Get all tech stacks
export const getAllTechStack = () => {
	const techSet = new Set<string>();
	projectsData.forEach((project) => {
		project.techStack.forEach((tech) => {
			techSet.add(tech);
		});
	});
	return Array.from(techSet).sort();
};
