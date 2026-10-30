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
          injectRoute({ pattern: "/api/search", entrypoint: new URL("./src/search/endpoint.ts", import.meta.url), prerender: false });
        },
      },
    },
    shirones({ excludeRoutes: ["/[...permalink]"] }),
  ],
});
