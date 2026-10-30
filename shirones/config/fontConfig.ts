import type { FontConfig, ResolvedFontOptions } from "@/types/fontConfig.ts";
import { withUserConfig } from "@/utils/config-overlay.ts";
import { resolveFontOptions as resolve } from "@/utils/font-options.ts";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Shirone 全站字体配置指南
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 博客的字体分为 3 种角色（Role），每个角色各司其职：
 *  1. `body`：西文与默认基础正文字体（英文字母、数字、基础标点）
 *  2. `cjk` ：中日韩字体（汉字、日文平假名/片假名、韩文）
 *  3. `mono`：等宽代码字体（文章代码块、行内代码、终端输出）
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 【常见修改场景】
 * ─────────────────────────────────────────────────────────────────────────────
 * 场景 A：完全使用系统默认字体（零字体打包，极速加载，最省流量）
 *   - 将 `mode` 设置为 `"system"`，并将 `fontFamilies` 设为空数组 `[]`。
 *
 * 场景 B：更换本地中文字体或英文字体（.woff2 文件）
 *   1. 准备你的 `.woff2` 字体文件，放入项目 `src/assets/fonts/` 目录下；
 *   2. 找到对应角色的配置（如 `role: "cjk"` 或 `role: "body"`）；
 *   3. 设置 `source: "local"`，并在 `file` 中填入你的字体路径（例如 `"src/assets/fonts/MyFont.woff2"`）；
 *   4. 将 `family` 设为该字体的真实族名称。
 *
 * 场景 C：使用 npm 的 Fontsource 字体包
 *   1. 安装字体包（如 `pnpm.cmd add @fontsource/inter`）；
 *   2. 设置 `source: "local"`，并在 `file` 中填入对应的 CSS 路径（如 `"@fontsource/inter/400.css"`）；
 *   3. 将 `family` 设为对应的字体名称（如 `"Inter"`）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 【修改后的验证命令】
 *   在终端依次执行：
 *   1. `npx.cmd astro check`  -> 校验配置与页面语法
 *   2. `pnpm.cmd build`        -> 执行生产构建与字体打包
 *   3. `pnpm.cmd fonts:check`  -> 校验字体格式与体积预算
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const fontConfig: FontConfig = withUserConfig("font", {
	/**
	 * 构建模式：
	 * - `"custom"`: 启用自定义字体（加载下方 fontFamilies 中配置的字体）
	 * - `"system"`: 纯系统字体模式（不打包任何自定义字体文件，完全依赖访客设备）
	 */
	mode: "custom",

	/**
	 * 字体清单列表（按需配置 body、cjk、mono 角色）
	 */
	fontFamilies: [
		// ---------------------------------------------------------------------
		// 1. 正文字体（现代几何圆润西文字体 Outfit，与 M3E 大圆角及悠哉圆体绝配）
		// ---------------------------------------------------------------------
		{
			id: "outfit-body",
			family: "Outfit",
			role: "body",
			source: "local",
			variants: [
				{
					file: "src/assets/fonts/local/outfit-latin-400-normal.woff2",
					weight: 400,
					style: "normal",
				},
				{
					file: "src/assets/fonts/local/outfit-latin-500-normal.woff2",
					weight: 500,
					style: "normal",
				},
				{
					file: "src/assets/fonts/local/outfit-latin-700-normal.woff2",
					weight: 700,
					style: "normal",
				},
			],
			fallback: ["ui-sans-serif", "system-ui", "sans-serif"],
			display: "swap",
			preload: false,
		},

		// ---------------------------------------------------------------------
		// 2. 中文 / 日文 CJK 字体（悠哉圆体 Yozai Medium，全量简繁中日韩 100% 覆盖）
		// ---------------------------------------------------------------------
		{
			id: "yozai-cjk",
			family: "Yozai Medium",
			role: "cjk",
			source: "local",
			variants: [
				{ file: "src/assets/fonts/yozai-shards/yozai-000.woff2", weight: 500, style: "normal", unicodeRange: "U+0-FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-001.woff2", weight: 500, style: "normal", unicodeRange: "U+1000-1FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-002.woff2", weight: 500, style: "normal", unicodeRange: "U+2000-2FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-003.woff2", weight: 500, style: "normal", unicodeRange: "U+3000-3FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-004.woff2", weight: 500, style: "normal", unicodeRange: "U+4000-4FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-005.woff2", weight: 500, style: "normal", unicodeRange: "U+5000-5FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-006.woff2", weight: 500, style: "normal", unicodeRange: "U+6000-6FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-007.woff2", weight: 500, style: "normal", unicodeRange: "U+7000-7FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-008.woff2", weight: 500, style: "normal", unicodeRange: "U+8000-8FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-009.woff2", weight: 500, style: "normal", unicodeRange: "U+9000-9FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-00f.woff2", weight: 500, style: "normal", unicodeRange: "U+F000-FFFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-020.woff2", weight: 500, style: "normal", unicodeRange: "U+20000-20FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-021.woff2", weight: 500, style: "normal", unicodeRange: "U+21000-21FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-022.woff2", weight: 500, style: "normal", unicodeRange: "U+22000-22FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-023.woff2", weight: 500, style: "normal", unicodeRange: "U+23000-23FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-024.woff2", weight: 500, style: "normal", unicodeRange: "U+24000-24FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-025.woff2", weight: 500, style: "normal", unicodeRange: "U+25000-25FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-026.woff2", weight: 500, style: "normal", unicodeRange: "U+26000-26FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-027.woff2", weight: 500, style: "normal", unicodeRange: "U+27000-27FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-028.woff2", weight: 500, style: "normal", unicodeRange: "U+28000-28FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-029.woff2", weight: 500, style: "normal", unicodeRange: "U+29000-29FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-02a.woff2", weight: 500, style: "normal", unicodeRange: "U+2A000-2AFFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-02b.woff2", weight: 500, style: "normal", unicodeRange: "U+2B000-2BFFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-02c.woff2", weight: 500, style: "normal", unicodeRange: "U+2C000-2CFFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-02d.woff2", weight: 500, style: "normal", unicodeRange: "U+2D000-2DFFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-02e.woff2", weight: 500, style: "normal", unicodeRange: "U+2E000-2EFFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-02f.woff2", weight: 500, style: "normal", unicodeRange: "U+2F000-2FFFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-030.woff2", weight: 500, style: "normal", unicodeRange: "U+30000-30FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-031.woff2", weight: 500, style: "normal", unicodeRange: "U+31000-31FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-032.woff2", weight: 500, style: "normal", unicodeRange: "U+32000-32FFF" },
				{ file: "src/assets/fonts/yozai-shards/yozai-0ff.woff2", weight: 500, style: "normal", unicodeRange: "U+FF000-FFFFF" },
			],
			fallback: ["system-ui", "sans-serif"],
			display: "swap",
			preload: false,
		},

		// ---------------------------------------------------------------------
		// 3. 代码等宽字体（渲染代码块与终端文本，对应 CSS 变量 --font-mono）
		// ---------------------------------------------------------------------
		{
			id: "jetbrains-mono",
			family: "JetBrains Mono",
			role: "mono",
			source: "local",
			variants: [
				{
					file: "src/assets/fonts/local/jetbrains-mono-latin-wght-normal.woff2",
					weight: "100 800",
					style: "normal",
				},
				{
					file: "src/assets/fonts/local/jetbrains-mono-latin-wght-italic.woff2",
					weight: "100 800",
					style: "italic",
				},
			],
			fallback: [
				"ui-monospace",
				"SFMono-Regular",
				"Menlo",
				"Monaco",
				"Consolas",
				"monospace",
			],
			display: "swap",
			preload: false,
		},
	],

	/**
	 * 字体子集化配置（生产构建时自动从文章、i18n、配置及 Meting 歌曲中提取字符，生成极速精简版 .woff2）
	 * - Dev 开发环境：自动加载完整原字体，任意输入新汉字实时可见，极速 HMR 零等待；
	 * - Build 生产构建：自动执行子集裁剪，将几十兆大字体压缩为几百 KB 的专属子集，秒开加载。
	 */
	subsetting: {
		enable: false, // Live content needs glyphs beyond the build-time subset.
		includeContent: true, // 扫描 src/content/ 下所有文章
		includeI18n: true, // 扫描全部 10 种语言词典
		includeConfig: true, // 扫描站点配置与导航
		includeCommon: true, // 包含常用标点与基础字符
		allowRemoteText: false, // No build-time remote text collection.
	},

	/**
	 * 字体打包体积预算限制（子集化后通常仅 300KB ~ 1MB）
	 */
	budget: {
		maxTotalBytes: 6 * 1024 * 1024, // 全站引用自定义字体总大小上限：6MB
		maxFamilyBytes: 4 * 1024 * 1024, // 单个字体族文件大小上限：4MB
	},
});

/** 经过校验与标准化处理后的字体配置对象，由 Astro 模板与 CSS 消费 */
export const resolvedFontOptions: ResolvedFontOptions = resolve(fontConfig);

/** 字体配置解析与校验函数 */
export const resolveFontOptions: (config: FontConfig) => ResolvedFontOptions =
	resolve;
