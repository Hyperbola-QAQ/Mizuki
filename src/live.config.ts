import { defineLiveCollection } from "astro:content";
import { z } from "astro:content";
import { readFile } from "node:fs/promises";

/**
 * 模拟 Strapi：从可变的外部数据源拉取内容（这里用本地 JSON 文件代替 HTTP）。
 * 关键点——每次请求都重新读取，不依赖构建期快照。
 */
async function readAll() {
	const raw = await readFile(
		process.env.LIVE_PROBE_FILE ?? new URL("../live-data/posts.json", import.meta.url),
		"utf-8",
	);
	const items = JSON.parse(raw) as Array<{
		slug: string;
		title: string;
		body: string;
		published: string;
		tags: string[];
	}>;

	// 演示：运行时把 markdown 渲染成 HTML 塞进 rendered.html，
	// 这样 renderEntry() 无需构建期模块即可产出 Content 组件。
	return items.map((item) => ({
		id: item.slug,
		data: {
			title: item.title,
			published: new Date(item.published),
			tags: item.tags,
		},
		body: item.body,
		rendered: {
			html: `<p>${item.body}</p>`,
			metadata: {
				headings: [],
				frontmatter: { words: item.body.length, minutes: 1 },
			},
		},
	}));
}

const postsLoader = {
	name: "strapi-stub",
	loadCollection: async ({ filter }: { filter?: Record<string, unknown> }) => {
		const entries = await readAll();
		const filtered = filter?.tag
			? entries.filter((e) => e.data.tags.includes(String(filter.tag)))
			: entries;
		return { entries: filtered };
	},
	loadEntry: async ({ filter }: { filter: { id?: string; slug?: string } }) => {
		const entries = await readAll();
		const id = filter.id ?? filter.slug;
		return { entry: entries.find((e) => e.id === id) };
	},
};

export const collections = {
	livePosts: defineLiveCollection({
		loader: postsLoader,
		schema: z.object({
			title: z.string(),
			published: z.date(),
			tags: z.array(z.string()).default([]),
		}),
	}),
};
