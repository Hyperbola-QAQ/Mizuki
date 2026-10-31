import { defineConfig } from "astro/config";
import shirones from "shirones";
import node from "@astrojs/node";

export default defineConfig({
  adapter: node({ mode: "standalone" }),
  integrations: [
    {
      name: "shirone-strapi-endpoints",
      hooks: {
        "astro:config:setup": ({ injectRoute }) => {
          for (const extension of ["png", "jpg", "jpeg", "webp", "avif", "gif", "svg", "mp4", "webm", "mp3", "ogg", "wav", "pdf"]) {
            injectRoute({ pattern: `/uploads/[...path].${extension}`, entrypoint: new URL("./src/uploads/endpoint.ts", import.meta.url), prerender: false });
          }
          injectRoute({ pattern: "/api/protected-media/session", entrypoint: new URL("./src/uploads/session-endpoint.ts", import.meta.url), prerender: false });
          injectRoute({ pattern: "/api/internal/render", entrypoint: new URL("./src/strapi/render-endpoint.ts", import.meta.url), prerender: false });
          injectRoute({ pattern: "/api/search", entrypoint: new URL("./src/search/endpoint.ts", import.meta.url), prerender: false });
          for (const pattern of ["/sitemap-index.xml", "/sitemap-0.xml"]) {
            injectRoute({ pattern, entrypoint: new URL("./src/sitemap/endpoint.ts", import.meta.url), prerender: false });
          }
        },
      },
    },
    shirones({ excludeRoutes: ["/[...permalink]"] }),
  ],
});
