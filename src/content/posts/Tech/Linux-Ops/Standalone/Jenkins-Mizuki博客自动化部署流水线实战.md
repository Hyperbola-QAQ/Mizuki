---
title: Jenkins-Mizuki博客自动化部署流水线实战
published: 2026-03-01
updated: 2026-03-03 19:09:00
pinned: false
description: Debian13安装Jenkins实现代码提交后自动构建并部署到远程服务器的完整流程
tags: [DevOps]
category: DevOps
author: Hyperbola
draft: false
series: Linux服务器运维
---

# 前言
在开发现代前端项目（如 Vue/React/Next.js）时，手动打包、上传服务器不仅效率低下，还容易出错。本文将详细记录如何在一台 Linux 服务器上，从零开始配置 **Jenkins**，结合 **Node.js**、**PNPM** 和 **GitHub SSH**，实现代码提交后自动构建并部署到远程服务器的完整流程。

我们将解决以下核心痛点：
1.  **环境隔离**：如何在 Jenkins 中正确管理 Node.js 版本。
2.  **网络难题**：解决国内服务器访问 GitHub 和 Node 源的网络波动与 SSL 错误。
3.  **权限陷阱**：处理 Git SSH 密钥验证及部署时的文件权限问题。
4.  **部署可靠性**：**为什么弃用 `scp` 而选择 `rsync`？** 解决隐藏文件丢失、目录层级错误及增量同步效率低下的问题。

---

## 🛠️ 环境
*   **操作系统**: Linux (Debian)
*   **CI/CD 工具**: Jenkins (安装在 `/var/lib/jenkins`)
*   **运行时**: Node.js (通过 Jenkins 插件自动管理)
*   **包管理器**: PNPM
*   **代码仓库**: GitHub (私有/公有均可)
*   **部署工具**: **Rsync** (替代传统的 SCP)

# 安装Jenkins

### Debian

```shell
sudo wget -O /etc/apt/keyrings/jenkins-keyring.asc \
  https://pkg.jenkins.io/debian/jenkins.io-2026.key
echo "deb [signed-by=/etc/apt/keyrings/jenkins-keyring.asc]" \
  https://pkg.jenkins.io/debian binary/ | sudo tee \
  /etc/apt/sources.list.d/jenkins.list > /dev/null
sudo apt update
sudo apt install jenkins
```

# 安装必要插件与配置 Node.js

Jenkins 默认不包含 Node.js 支持，需要手动安装。

1.  **安装插件**：
    进入 `系统管理` -> `插件管理`，搜索并安装 **NodeJS** 插件。
2.  **配置全局工具**：
    进入 `系统管理` -> `全局工具配置`：
    * 找到 **NodeJS** 部分，点击“新增 NodeJS”。

    * **名称**: 填入 `Node25` (需与 Pipeline 代码一致)。

    * **自动安装**: 勾选，并选择版本（建议 LTS，如 20.x 或 22.x，本例使用 25.x）。
    
    *   **关键技巧**: 如果下载失败（SSL 错误），请在 `系统管理` -> `系统` -> `全局属性` 中添加环境变量：
        * `NODEJS_ORG_MIRROR`: `https://npmmirror.com/mirrors/node/`
        
          如果问题依旧,则取消自动安装,手动下载后上传

---

## 配置 Git SSH 凭证

为了拉取私有仓库，我们需要配置 SSH 密钥。

1.  **生成密钥** (在 Jenkins 服务器上)：
    ```bash
    sudo -u jenkins ssh-keygen -t ed25519 -C "jenkins-deploy" -f /var/lib/jenkins/.ssh/id_ed25519 -N ""
    ```
2.  **添加公钥到 GitHub**：
    将 `/var/lib/jenkins/.ssh/id_ed25519.pub` 的内容复制到 GitHub 账户的 `Settings` -> `SSH and GPG keys` 中。
3.  **首次连接验证**：
    手动执行一次连接以接受主机指纹，避免流水线卡死：
    ```bash
    sudo -u jenkins ssh -T git@github.com
    # 输入 yes 确认
    ```
    *(可选但推荐)*：如果部署目标服务器 (`txy.hyperbola.cc`) 未配置免密，也需在此步骤配置 Jenkins 用户到目标服务器的 SSH 免密登录：
    ```bash
    sudo -u jenkins ssh-copy-id hyperbola@txy.hyperbola.cc
    ```

4.  **在 Jenkins 中添加凭证**：
    *   路径：`凭证` -> `全局` -> `添加凭证`。
    *   种类：`SSH Username with private key`。
    *   ID: `github-ssh-key`。
    *   用户名：`git`。
    *   私钥：粘贴 `/var/lib/jenkins/.ssh/id_ed25519` 的内容。

---

## 编写 Jenkinsfile

这是流水线的核心。我们采用 Declarative Pipeline 语法。

### ⚠️ 关键避坑指南：为什么弃用 `scp` 改用 `rsync`？

在早期的尝试中，我们使用 `scp` 进行部署，但在生产环境中遇到了几个无法忽视的严重问题：

| 问题现象 | `scp` 的原因分析 | `rsync` 的解决方案 |
| :--- | :--- | :--- |
| **隐藏文件丢失** | `scp -r dist/* ...` 中的通配符 `*` **默认不匹配**以 `.` 开头的文件（如 `.htaccess`, `.env`）。若不加 `*` 直接传 `dist`，又会多出一层目录。 | `rsync -a dist/ ...` 默认传输所有文件（包括隐藏文件），且通过末尾斜杠 `/` 精确控制只同步**内容**。 |
| **目录层级错误** | `scp -r dist user@host:/target/` 当目标目录存在时，往往会变成 `/target/dist/...`，导致网站路径错误。 | `rsync` 对源路径末尾的 `/` 语义定义清晰：`dist/` 表示同步目录内的内容，直接覆盖到目标目录根下，**绝不多创建一层**。 |
| **全量复制效率低** | `scp` 每次都会重新传输所有文件，即使只改了一个字。 | `rsync` 采用**增量算法**，只传输变化的部分，大幅减少网络带宽和部署时间。 |
| **权限保留差** | `scp` 默认可能丢失部分文件属性。 | `rsync -a` (归档模式) 完美保留权限、时间戳、软链接等属性。 |
| **清理旧文件难** | `scp` 无法自动删除远程已存在但本地已删除的文件，导致垃圾文件堆积。 | 配合 `--delete` 参数，自动清理远程目录中多余的文件，保持两端严格一致。 |

**结论**：`rsync` 是专为同步设计的工具，而 `scp` 仅为安全拷贝设计。在 CI/CD 部署场景中，`rsync` 是事实上的标准最佳实践。

### 📄 最终 Jenkinsfile 代码

```groovy
pipeline {
    agent any
    
    // 引用之前配置的 Node.js 工具
    tools {
        nodejs 'Node25'
    }
    
    stages {
        stage('Checkout') {
            steps {
                script {
                    // 使用 SSH 凭证拉取代码
                    git credentialsId: 'github-ssh-key', 
                        branch: 'my-customization', // 替换为你的分支名
                        url: 'git@github.com:Hyperbola-QAQ/Mizuki.git'
                }
            }
        }
        
        stage('Setup PNPM') {
            steps {
                script {
                    sh 'which node' // 验证 Node 环境
                    sh 'npm install -g pnpm' // 全局安装 pnpm
                }
            }
        }
        
        stage('Install Dependencies') {
            steps {
                script {
                    sh 'pnpm store prune || true' // 清理缓存
                    // 注意：不使用 --frozen-lockfile 以避免配置不匹配错误
                    sh 'pnpm install' 
                }
            }
        }
        
        stage('Build') {
            steps {
                script {
                    sh 'pnpm build' // 执行构建
                }
            }
        }
        
        stage('Post Build') {
            steps {
                script {
                    // 显示构建产物
                    sh 'ls -la dist/'
                    
                    // 可选：运行类型检查
                    sh 'pnpm type-check || true'

                    // 复制构建产物到/var/www/blog.hyperbola.cc/html/
                    sh 'cp -rT dist/ /var/www/blog.hyperbola.cc/html/'
                    sh 'rsync -avz --delete dist/ hyperbola@txy.hyperbola.cc:/var/www/blog.hyperbola.cc/html/'
                }
            }
        }
    }
    
    post {
        success {
            echo '🎉 构建与部署完成！'
        }
        failure {
            echo '💥 构建失败，请检查日志。'
        }
    }
}
```

---

## 配置轮询构建 (可选)

如果你希望定期自动构建（例如每小时同步一次），可以在 Jenkins 任务配置中勾选 **"Discard old builds"** 下方的 **"Build periodically"**。

**Cron 表达式示例**：
每小时执行一次：
```text
H * * * *
```
---

## 🎯 常见问题排查 (Troubleshooting)

| 错误现象 | 可能原因 | 解决方案 |
| :--- | :--- | :--- |
| `Invalid tool type "nodejs"` | 未安装 NodeJS 插件或未配置全局工具 | 安装插件并在“全局工具配置”中定义 `Node25` |
| `SSLHandshakeException` | 无法连接 nodejs.org | 配置 `NODEJS_ORG_MIRROR` 环境变量指向国内镜像 |
| `Permission denied (publickey)` | Git SSH 密钥未配置或指纹未接受 | 检查凭证 ID，手动执行 `ssh -T git@github.com` 接受指纹 |
| `npm: not found` | PATH 被错误覆盖 | 不要在 `environment` 中硬编码 PATH，让 `tools` 自动注入 |
| `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` | pnpm 配置与 lockfile 不符 | 移除 `--frozen-lockfile` 参数 |
| `rsync: command not found` | 远程服务器未安装 rsync | 登录远程服务器执行 `sudo apt install rsync` |
| `Permission denied (publickey)` (rsync 阶段) | Jenkins 用户未配置到远程服务器的 SSH 免密 | 在 Jenkins 服务器上执行 `sudo -u jenkins ssh-copy-id user@host` |
| `403 Forbidden` (部署后网站无法访问) | 文件权限不正确，Web 服务器用户无权读取 | 检查 Pipeline 中的 `chown/chmod` 步骤是否成功执行，确保归属权为 `www-data` 或对应 Web 用户 |
| `dist` 目录多出一层 (`/html/dist/...`) | 源路径漏了末尾斜杠 `/` | 确保 `rsync` 命令中源路径是 `dist/` 而不是 `dist` |

## 结语

通过以上步骤，我们成功构建了一个健壮、自动化的前端部署流水线。现在，只需将代码推送到 GitHub 的 `my-customization` 分支，Jenkins 就会自动接管后续的所有工作：拉取代码、安装依赖、构建打包，并最终将产物同步到生产服务器。

这不仅解放了双手，更保证了每次部署环境的一致性和可靠性。Happy Coding! 🚀
