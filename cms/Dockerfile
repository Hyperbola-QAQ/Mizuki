# Build with the same major Node version as production. Override NODE_IMAGE with
# a verified local/registry mirror image when building inside the cluster.
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /opt/app
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com/
RUN npm install -g pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY config ./config
COPY src ./src
COPY public ./public
RUN pnpm build
RUN chown -R 2000:2000 /opt/app
ENV NODE_ENV=production HOME=/tmp
USER 2000:2000
EXPOSE 1337
CMD ["pnpm", "start"]
