import type { ProfileConfig } from "@/types/config";
import { withUserConfig } from "@/utils/config-overlay.ts";

/**
 * 博主资料：头像 / 名称 / 简介 / 社交链接（侧栏 Profile 卡片、页脚、RSS 作者等消费）。
 * 类型见 src/types/config.ts。
 */
export const profileConfig: ProfileConfig = withUserConfig("profile", {
	avatar: "/assets/profile/avatar.jpg",
	name: "Hyperbola",
	bio: "AVG TOUHOU",
	links: [
		{ name: "QQ", icon: "fa6-brands:qq", url: "https://wpa.qq.com/msgrd?v=3&uin=2656131980&site=qq&menu=yes" },
		{ name: "Bilibili", icon: "fa6-brands:bilibili", url: "https://space.bilibili.com/113599922" },
		{ name: "GitHub", icon: "fa6-brands:github", url: "https://github.com/Hyperbola-QAQ" },
		{ name: "Steam", icon: "fa6-brands:steam", url: "https://steamcommunity.com/id/Hyperbola_QAQ/" },
		{ name: "网易云", icon: "fa6-solid:music", url: "https://music.163.com/#/playlist?id=2449824719" },
	],
});
