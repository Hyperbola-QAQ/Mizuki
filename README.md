# Shirone-Strapi

基于 `shirones@0.1.5` 的 Astro 混合渲染站点，使用 Strapi 5 管理文章并由 Meilisearch 提供搜索。内容路由从服务端读取已发布内容，后台编辑后不需要重新构建站点。项目仍处于迁移和部署验证阶段，不能直接替换生产站点。

## 本地开发和验证

使用支持的 Node.js 版本和 pnpm，依照锁文件安装依赖。站点需要能访问 Strapi；`LIVE_PROBE_FILE` 只用于隔离测试，不能用于生产。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm --dir cms install --frozen-lockfile
pnpm --dir cms test
```

Strapi 所需的数据库、密钥和渲染服务变量见 [cms/.env.example](cms/.env.example)；站点需要 `STRAPI_URL`、仅供服务端使用的 `STRAPI_API_TOKEN`、`MEILI_URL`、搜索专用 `MEILI_SEARCH_KEY` 和 `INTERNAL_RENDER_TOKEN`。实际密钥由受保护的部署配置提供，禁止写入 Git。

## 内容与安全

Strapi 以 Markdown 和原 frontmatter 保存内容；仅发布的内容会被页面读取。保存时使用受认证的内部渲染服务，服务暂不可用时清除旧快照并在请求时重新渲染。动态内容禁用本地文件 include。搜索索引排除加密和草稿内容，搜索结果及上传资源会重新核对当前发布状态。不要将 Strapi 的整个上传目录直接公开。

旧站内容迁移入口及 dry-run 说明在 [cms/README.md](cms/README.md)；生产部署、数据恢复和切换的前置条件见 [deploy/k8s/README.md](deploy/k8s/README.md) 与 [deploy/k8s/RECOVERY.md](deploy/k8s/RECOVERY.md)。执行生产迁移前必须重新核对最新 `archive/mizuki`、媒体和草稿，并完成真实恢复演练。

Shirone 的路由和运行时适配保存在 [patches/shirones@0.1.5.patch](patches/shirones@0.1.5.patch)，升级主题时需重新验证补丁。中文字体按 Unicode 范围分片，生成方法见 [字体说明](src/assets/fonts/yozai-shards/README.md)。
