import type { FooterConfig } from "../types/config";

// 页脚配置
export const footerConfig: FooterConfig = {
	enable: true, // 是否启用Footer HTML注入功能
	customHtml: `
		<div class="flex items-center justify-center gap-4">
			<a
				href="https://ipw.wsmdn.top/ipv6webcheck/?site=hyperbola.cc"
				title="本站支持IPv6访问"
				target="_blank"
				><img
					style="display: inline-block; vertical-align: middle"
					alt="本站支持IPv6访问"
					src="https://ipw.wsmdn.dpdns.org/ipv6-s1.svg"
			/></a>
			<a
				href="https://ipw.wsmdn.top/ssl/?site=hyperbola.cc"
				title="本站支持SSL安全访问"
				target="_blank"
				><img
					style="display: inline-block; vertical-align: middle"
					alt="本站支持SSL安全访问"
					src="https://ipw.wsmdn.dpdns.org/ssl-s1.svg"
			/></a>
		</div>

		<div class="mt-2">
			<a
				class="transition link text-[var(--primary)] font-medium"
				target="_blank"
				href="https://beian.miit.gov.cn/"
				>湘ICP备2024072853号-1</a
			>
			<a
				class="transition link text-[var(--primary)] font-medium flex items-center justify-center"
				target="_blank"
				href="https://beian.mps.gov.cn/#/query/webSearch?code=43010402002198"
			>
				<img
					src="/BeiAn.png"
					alt="公安联网备案"
					class="inline-block h-4 mr-1"
				/>
				湘公网安备43010402002198号
			</a>
		</div>
	`.trim(),
};
