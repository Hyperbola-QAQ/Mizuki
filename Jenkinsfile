pipeline {
    agent any
    
    tools {
        nodejs 'Node25'
    }
    
    environment {
        PNPM_HOME = "${HOME}/.local/share/pnpm"
        PATH = "${PNPM_HOME}:${PATH}"
    }
    
    stages {
        stage('Checkout') {
            steps {
                script {
                    // 使用 credentialsId 指定刚才创建的凭证
                    git credentialsId: 'github-ssh-key', 
                        branch: 'my-customization',
                        url: 'git@github.com:Hyperbola-QAQ/Mizuki.git'
                }
            }
        }
        
        stage('Setup PNPM') {
            steps {
                script {
                    // 验证 pnpm 安装
                    sh 'pnpm --version'
                }
            }
        }
        
        stage('Install Dependencies') {
            steps {
                script {
                    // 清理缓存并安装依赖
                    sh 'pnpm store prune || true'
                    sh 'pnpm install --frozen-lockfile'
                }
            }
        }
        
        stage('Build') {
            steps {
                script {
                    // 执行构建命令
                    sh 'pnpm build'
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
                }
            }
        }
    }
    
    post {
        success {
            echo 'Build completed successfully!'
        }
        failure {
            echo 'Build failed!'
        }
    }
}