```yaml
title: Jenkins-Mizuki博客自动化部署流水线实战
published: 2026-02-27
updated: 2026-02-27
pinned: false
description: Debian13安装Jenkins实现代码提交后自动构建并部署到远程服务器的完整流程
tags:
  - Linux
  - Debian
  - Jenkins
  - Ops
category: Linux运维
author: Hyperbola
draft: false
series: Linux服务器运维
```

# 前言
在开发现代前端项目（如 Vue/React/Next.js）时，手动打包、上传服务器不仅效率低下，还容易出错。本文将详细记录如何在一台 Linux 服务器上，从零开始配置 **Jenkins**，结合 **Node.js**、**PNPM** 和 **GitHub SSH**，实现代码提交后自动构建并部署到远程服务器的完整流程。

我们将解决以下核心痛点：
1.  **环境隔离**：如何在 Jenkins 中正确管理 Node.js 版本。
2.  **网络难题**：解决国内服务器访问 GitHub 和 Node 源的网络波动与 SSL 错误。
3.  **权限陷阱**：处理 Git SSH 密钥验证及部署时的文件权限问题。

---

## 🛠️ 环境
*   **操作系统**: Linux (Debian)
*   **CI/CD 工具**: Jenkins (安装在 `/var/lib/jenkins`)
*   **运行时**: Node.js (通过 Jenkins 插件自动管理)
*   **包管理器**: PNPM
*   **代码仓库**: GitHub (私有/公有均可)

---

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

## 第二步：配置 Git SSH 凭证

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
4.  **在 Jenkins 中添加凭证**：
    *   路径：`凭证` -> `全局` -> `添加凭证`。
    *   种类：`SSH Username with private key`。
    *   ID: `github-ssh-key`。
    *   用户名：`git`。
    *   私钥：粘贴 `/var/lib/jenkins/.ssh/id_ed25519` 的内容。

---

## 第三步：编写 Jenkinsfile

这是流水线的核心。我们采用 Declarative Pipeline 语法。

### ⚠️ 关键避坑指南
在编写过程中，我们遇到了几个典型问题并已解决：
*   **PATH 覆盖问题**: 不要在 `environment` 块中直接重写 `PATH`，这会覆盖掉 Jenkins 自动注入的 Node.js 路径。应在 `script` 块中动态追加。
*   **PNPM 锁文件错误**: `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` 是因为本地锁文件配置与 CI 环境不一致。解决方法是移除 `--frozen-lockfile` 
*   **部署权限**: 使用 `scp` 配合具有权限的中间用户，比在本地配置 `sudo` 更安全优雅。

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
        
        stage('Post Build & Deploy') {
            steps {
                script {
                    echo '--- 检查构建产物 ---'
                    sh 'ls -la dist/'
                    
                    echo '--- 运行类型检查 (可选) ---'
                    sh 'pnpm type-check || true'

                    echo '--- 部署到远程服务器 ---'
                    // 方案：使用 scp 递归复制 dist 目录内容到远程
                    // 假设 hyperbola 用户有权限写入远程的 /var/www/... 目录
                    // -r: 递归, -o StrictHostKeyChecking=no: 避免首次连接交互
                    sh '''
                        if [ -d "dist" ]; then
                            scp -r -o StrictHostKeyChecking=no dist/ hyperbola@txy.hyperbola.cc:/var/www/blog.hyperbola.cc/html/
                            echo "✅ 部署成功！"
                        else
                            echo "❌ 错误：dist 目录不存在"
                            exit 1
                        fi
                    '''
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

## 第四步：配置轮询构建 (可选)

如果你希望定期自动构建（例如每小时同步一次），可以在 Jenkins 任务配置中勾选 **"Discard old builds"** 下方的 **"Build periodically"**。

**Cron 表达式示例**：
每小时执行一次：
```text
H/60 * * *
```
---

## 🎯 常见问题排查 (Troubleshooting)

| 错误现象                                            | 可能原因                           | 解决方案                                                |
| :-------------------------------------------------- | :--------------------------------- | :------------------------------------------------------ |
| `Invalid tool type "nodejs"`                        | 未安装 NodeJS 插件或未配置全局工具 | 安装插件并在“全局工具配置”中定义 `Node25`               |
| `SSLHandshakeException`                             | 无法连接 nodejs.org                | 配置 `NODEJS_ORG_MIRROR` 环境变量指向国内镜像           |
| `Permission denied (publickey)`                     | Git SSH 密钥未配置或指纹未接受     | 检查凭证 ID，手动执行 `ssh -T git@github.com` 接受指纹  |
| `npm: not found`                                    | PATH 被错误覆盖                    | 不要在 `environment` 中硬编码 PATH，让 `tools` 自动注入 |
| `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`                 | pnpm 配置与 lockfile 不符          | 移除 `--frozen-lockfile` 参数                           |
| `cp: cannot create regular file: Permission denied` | Jenkins 用户无写入 Web 目录权限    | 改用 `scp` 传输到有权限的远程用户，或配置 `sudo`        |

---

## 结语

通过以上步骤，我们成功构建了一个健壮、自动化的前端部署流水线。现在，只需将代码推送到 GitHub 的 `my-customization` 分支，Jenkins 就会自动接管后续的所有工作：拉取代码、安装依赖、构建打包，并最终将产物同步到生产服务器。

这不仅解放了双手，更保证了每次部署环境的一致性和可靠性。Happy Coding! 🚀
