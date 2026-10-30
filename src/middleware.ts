import { defineMiddleware } from "astro:middleware";
import { withCmsRequestScope } from "./strapi/client";

export const onRequest = defineMiddleware((_context, next) => withCmsRequestScope(() => next()));
