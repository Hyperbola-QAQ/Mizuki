import type { ProfileConfig } from "../types/config";

// 个人资料配置
export const profileConfig: ProfileConfig = {
	avatar: "assets/images/avatar.jpg", // 相对于 /src 目录。如果以 '/' 开头，则相对于 /public 目录
	name: "Hyperbola",
	bio: "AVG TOUHOU",
	typewriter: {
		enable: true, // 启用个人简介打字机效果
		speed: 80, // 打字速度（毫秒）
	},
	links: [
		{
			name: "QQ",
			icon: "fa7-brands:qq",
			url: "https://wpa.qq.com/msgrd?v=3&uin=2656131980&site=qq&menu=yes",
		},
		{
			name: "Bilibli",
			icon: "fa7-brands:bilibili",
			url: "https://space.bilibili.com/113599922",
		},
		// {
		// 	name: "Gitee",
		// 	icon: "mdi:git",
		// 	url: "https://gitee.com/matsuzakayuki",
		// },
		{
			name: "GitHub",
			icon: "fa7-brands:github",
			url: "https://github.com/Hyperbola-QAQ",
		},
		{
			name: "Steam",
			icon: "fa7-brands:steam",
			url: "https://steamcommunity.com/id/Hyperbola_QAQ/",
		},
		{
			name: "网易云",
			icon: "fa7-solid:music",
			url: "https://music.163.com/#/playlist?id=2449824719",
		},
	],
};
