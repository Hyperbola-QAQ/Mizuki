# 构建阶段
FROM harbor.hyperbola.cc/k3s/node:26-alpine AS builder

# 安装必要工具
RUN apk add --no-cache git bash && \
    npm install -g pnpm@11.5.3

WORKDIR /app

# 复制依赖文件
COPY package.json pnpm-lock.yaml ./

# 安装依赖（使用 --ignore-scripts 跳过所有构建脚本）
RUN pnpm install --frozen-lockfile --ignore-scripts

# 复制所有源代码
COPY . .

# 构建项目（设置环境变量允许 esbuild）
ENV NODE_ENV=production
RUN pnpm build

# 生产阶段
FROM harbor.hyperbola.cc/k3s/nginx:latest

# 复制构建产物
COPY --from=builder /app/dist /usr/share/nginx/html/

# 配置 nginx
RUN echo 'server { \
    listen 80; \
    server_name localhost; \
    root /usr/share/nginx/html; \
    index index.html; \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|webp)$ { \
        expires 1y; \
        add_header Cache-Control "public, immutable"; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80