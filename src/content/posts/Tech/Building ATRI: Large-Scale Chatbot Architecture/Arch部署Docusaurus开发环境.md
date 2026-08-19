---
title: 聊天机器人大型项目开发环境部署二：Arch部署Docusaurus开发环境
published: 2026-03-14 19:55:00
updated: 2026-03-14 20:29:00
pinned: false
description: 在 Arch Linux 上从零搭建 Docusaurus 文档开发环境的完整流程
tags:
  - Development
category: Development
author: Hyperbola
draft: true
series: 聊天机器人大型项目开发
---


# 前言

本文是“聊天机器人大型项目开发”系列的第二篇。在完成了项目架构设计后，我们需要搭建文档站点的基础设施。

本项目的文档站点采用 **Docusaurus v4** 构建，运行在 **Arch Linux** 环境下。

本文旨在介绍如何在 Arch Linux 上从零搭建一套高效、现代化的文档开发环境。

# 环境准备

## 1. 系统更新与基础工具

在开始之前，确保您的 Arch Linux 系统是最新的，并安装必要的构建工具。

```bash
sudo pacman -Syu
sudo pacman -S --needed base-devel git curl unzip
```

## 2. 安装 运行时环境

Docusaurus 基于 React，需要 Node.js 环境。虽然可以使用 `pacman` 安装，但为了获得更好的版本控制和性能，推荐使用 **Bun**（一个极速的 JavaScript 运行时，兼容 npm 生态且安装更简单）。

### 方案 A：使用 Bun
Bun 的安装速度极快，且内置了包管理器，非常适合 Docusaurus 项目。

```bash
# 使用官方脚本安装 Bun
curl -fsSL https://bun.sh/install | bash
sudo pacman -S bun

# 加载环境变量 (根据提示添加到 ~/.bashrc 或 ~/.zshrc)
source ~/.bashrc 
# 或 source ~/.zshrc

# 验证安装
bun --version
```

### 方案 B：使用 Node.js (传统方式)

如果您更习惯使用 npm/pnpm，可以通过 `fnm` (Fast Node Manager) 或直接安装 LTS 版本。

```bash
# 通过 pacman 安装 Node.js (可能版本稍旧，但稳定)
sudo pacman -S nodejs npm

# 或者使用 nvm/fnm 管理版本
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc
fnm use --install-if-missing 20 # 安装 Node.js 20 LTS
```

## 3. 安装 PlantUML 及 Java 环境

本项目架构图大量使用 **PlantUML** (`.puml` 文件)。Docusaurus 本身不直接支持 `.puml` 渲染，我们需要在本地安装 PlantUML 以便：
1. 在 VS Code 中预览。
2. (可选) 编写脚本在构建时将 `.puml` 转换为图片。

Arch Linux 的安装非常简便：

```bash
# 安装 JRE (PlantUML 依赖 Java)
sudo pacman -S jre-openjdk

# 安装 PlantUML
sudo pacman -S plantuml

# 验证安装
plantuml -version
```

> **💡 提示**：安装完成后，建议在 VS Code 中安装 **"PlantUML"** 插件，并配置 `plantuml.jar` 路径（通常 pacman 安装的可以直接识别，若不行需手动指定 jar 路径）。

## 4. 项目初始化与依赖安装

假设您已经按照 Monorepo 结构创建了目录：
```text
ATRI-Server/
├── docs/              # 文档源码
├── website/           # Docusaurus 站点
```

进入 `website` 目录并安装依赖：

```bash
cd website

# 如果使用 Bun (推荐)
bun install

# 如果使用 npm
npm install
```

## 5. 关键配置检查

确保 `website/docusaurus.config.ts` 已正确指向根目录的 `docs` 文件夹（参考前文配置）：

```typescript
// website/docusaurus.config.ts
presets: [
  ['classic', {
    docs: {
      path: '../docs', // 👈 关键点：指向外部 docs
      sidebarPath: './sidebars.ts',
      // ...
    },
  }],
],
```

同时，删除 `website` 目录下自动生成的 `docs` 和 `blog` 文件夹（如果不需要博客功能），避免路径冲突：

```bash
cd website
rm -rf docs blog
```

## 6. 启动开发服务器

一切就绪后，启动本地开发服务器：

```bash
# 使用 Bun
bun run start

# 使用 npm
npm run start
```

浏览器将自动打开 `http://localhost:3000`。此时您应该能看到 `../docs` 目录下的 Markdown 内容已被成功渲染。

# 常见问题 (FAQ)

## Q1: PlantUML 图片如何在网站显示？
Docusaurus 默认不支持直接解析 `.puml` 代码块。
*   **短期方案**：使用 VS Code 插件将 `.puml` 导出为 `.png` 或 `.svg`，放入 `website/static/img/arch/`，然后在 Markdown 中引用 `![架构图](/img/arch/design.png)`。
*   **长期方案**：编写一个 Node.js 脚本，在 `bun run build` 之前遍历 `../docs`，调用本地的 `plantuml` 命令批量生成图片到 `website/static` 目录。

## Q2: 端口被占用怎么办？
如果 3000 端口被占用，可以指定其他端口：
```bash
bun run start --port 3001
```

## Q3: 热更新不生效？
修改 `docs` 下的文件后，Docusaurus 通常会自动热重载。如果未生效，请检查 `docusaurus.config.ts` 中的 `path` 是否正确，或尝试重启服务。
