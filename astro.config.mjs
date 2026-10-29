import { defineConfig } from "astro/config";
import shirones from "shirones";
import node from "@astrojs/node";

export default defineConfig({
  adapter: node({ mode: "standalone" }),
  integrations: [shirones({ excludeRoutes: ["/[...permalink]"] })],
});
