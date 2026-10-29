# Shirone-Strapi（原型）

当前仅验证 Shirone 0.1.5 注入的首页可以在 Node 运行时读取动态数据。尚未接入 Strapi、Meilisearch、文章迁移或生产部署，不能用于替换现有站点。

项目使用 `patches/shirones@0.1.5.patch` 让首页注入为 SSR，并用本地 JSON 模拟实时数据。该补丁暂时将第一篇静态示例文章与一条模拟记录合并，只用于验证路由和渲染，不代表完整数据模型或迁移方案。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

生产模式运行原型时设置 `LIVE_PROBE_FILE` 为 `live-data/posts.json` 的绝对路径。测试使用独立临时文件，不修改站点内容。已知后续必须验证远程图片、文章详情和所有内容聚合页的实时行为、实际 Markdown 渲染及缓存失效。
