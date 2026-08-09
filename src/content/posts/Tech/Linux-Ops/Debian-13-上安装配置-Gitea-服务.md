---
title: Debian 13 上安装配置 Gitea 服务
published: 2026-03-01 21:57:00
updated: 2026-08-09
pinned: false
description: 详细记录在 Debian 13 系统上安装和配置 Gitea 的完整流程，包括系统准备、服务配置和数据库设置
tags: [DevOps]
category: DevOps
author: Hyperbola
draft: false
series: Linux服务器运维
---

# 前言
在软件开发过程中，自建 Git 服务是团队协作的基础。相比 GitHub 等公共平台，自建 Gitea 服务能提供更高的数据安全性和灵活性，尤其适合私有项目开发。本文将详细记录在 Debian 13 系统上从零开始安装和配置 Gitea 的完整流程，包括系统环境准备、数据库配置、服务部署等关键步骤，帮助您快速搭建属于自己的 Git 服务。

# 一、准备工作

## 安装依赖

```bash
apt update
apt install -y wget git postgresql supervisor
```

## 创建 Git 系统用户

```bash
adduser \
  --system \
  --shell /bin/bash \
  --gecos 'Git Version Control' \
  --group \
  --disabled-password \
  --home /home/git \
  git
```

## 创建 Gitea 目录结构

```bash
mkdir -p /var/lib/gitea/{custom,data,log}
chown -R git:git /var/lib/gitea/
chmod -R 750 /var/lib/gitea/
mkdir /etc/gitea
chown root:git /etc/gitea
chmod 775 /etc/gitea
```

# 二、安装 Gitea 二进制文件

## 拉取二进制文件并移动

```bash
wget -O gitea https://dl.gitea.com/gitea/1.25.4/gitea-1.25.4-linux-amd64
chmod +x gitea
mv gitea /usr/local/bin/
```

# 三、配置 PostgreSQL 数据库

## 修改 PostgreSQL 配置

编辑 `/etc/postgresql/15/main/postgresql.conf`：

```ini
listen_addresses = 'localhost, 127.0.0.1'  # 根据需要添加您的IP
password_encryption = scram-sha-256
```

重启 PostgreSQL：

```bash
systemctl restart postgresql
```

## 创建 Gitea 数据库和用户

```bash
sudo -u postgres psql
```

在 PostgreSQL 控制台中执行：

```sql
CREATE ROLE gitea WITH LOGIN PASSWORD 'gi******tea';
CREATE DATABASE giteadb WITH OWNER gitea TEMPLATE template0 ENCODING UTF8 LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8';
```

## 配置 pg_hba.conf

编辑 `/etc/postgresql/15/main/pg_hba.conf`：

```ini
local    giteadb    gitea    scram-sha-256
host    giteadb    gitea    127.0.0.1/32    scram-sha-256
```

重启 PostgreSQL：

```bash
sudo systemctl restart postgresql
```

# 四、配置 Gitea 服务

## 创建 systemd 服务文件

```bash
sudo wget https://raw.githubusercontent.com/go-gitea/gitea/master/contrib/systemd/gitea.service -P /etc/systemd/system/
```

或者手动创建 `/etc/systemd/system/gitea.service` 文件，内容如下：

```ini
[Unit]
Description=Gitea (Git with a cup of tea)
After=network.target
###
# Don't forget to add the database service dependencies
###
#
#Wants=mysql.service
#After=mysql.service
#
#Wants=mariadb.service
#After=mariadb.service
#
Wants=postgresql.service
After=postgresql.service
#
#Wants=memcached.service
#After=memcached.service
#
#Wants=redis.service
#After=redis.service
#
###
# If using socket activation for main http/s
###
#
#After=gitea.main.socket
#Requires=gitea.main.socket
#
###
# (You can also provide gitea an http fallback and/or ssh socket too)
#
# An example of /etc/systemd/system/gitea.main.socket
###
##
## [Unit]
## Description=Gitea Web Socket
## PartOf=gitea.service
##
## [Socket]
## Service=gitea.service
## ListenStream=<some_port>
## NoDelay=true
##
## [Install]
## WantedBy=sockets.target
##
###

[Service]
# Uncomment the next line if you have repos with lots of files and get a HTTP 500 error because of that
# LimitNOFILE=524288:524288
RestartSec=2s
Type=simple
User=git
Group=git
WorkingDirectory=/var/lib/gitea/
# If using Unix socket: tells systemd to create the /run/gitea folder, which will contain the gitea.sock file
# (manually creating /run/gitea doesn't work, because it would not persist across reboots)
#RuntimeDirectory=gitea
ExecStart=/usr/local/bin/gitea web --config /etc/gitea/app.ini
Restart=always
Environment=USER=git HOME=/home/git GITEA_WORK_DIR=/var/lib/gitea
# If you install Git to directory prefix other than default PATH (which happens
# for example if you install other versions of Git side-to-side with
# distribution version), uncomment below line and add that prefix to PATH
# Don't forget to place git-lfs binary on the PATH below if you want to enable
# Git LFS support
#Environment=PATH=/path/to/git/bin:/bin:/sbin:/usr/bin:/usr/sbin
# If you want to bind Gitea to a port below 1024, uncomment
# the two values below, or use socket activation to pass Gitea its ports as above
###
#CapabilityBoundingSet=CAP_NET_BIND_SERVICE
#AmbientCapabilities=CAP_NET_BIND_SERVICE
###
# In some cases, when using CapabilityBoundingSet and AmbientCapabilities option, you may want to
# set the following value to false to allow capabilities to be applied on gitea process. The following
# value if set to true sandboxes gitea service and prevent any processes from running with privileges
# in the host user namespace.
###
#PrivateUsers=false
###

[Install]
WantedBy=multi-user.target
```

## 创建 Gitea 配置目录

```bash
sudo mkdir /etc/gitea
sudo touch /etc/gitea/app.ini
sudo chown root:git /etc/gitea/app.ini
sudo chmod 660 /etc/gitea/app.ini
```

## 启动 Gitea 服务

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now gitea.service
```

# 五、验证安装

## 检查服务状态

```bash
sudo systemctl status gitea
```

## 测试数据库连接

```bash
psql -U gitea -d giteadb
```

## 访问 Gitea Web 界面

打开浏览器，访问 `http://<服务器IP>:3000`，按照向导完成初始化配置。

# 六、添加法律页面和备案信息

一些法域（例如中国大陆）要求在网站上添加特定的法律页面和备案信息。按照以下步骤将它们添加到你的 Gitea 实例中。

## 添加隐私政策页面

### 获取隐私政策模板

Gitea 源代码附带了示例页面，位于 contrib/legal 目录中。将它们复制到 custom/public/assets/ 目录下：

```bash
# 创建必要的目录
sudo -u git mkdir -p /var/lib/gitea/custom/public/assets

# 下载隐私政策模板
sudo -u git wget -O /var/lib/gitea/custom/public/assets/privacy.html \
  https://raw.githubusercontent.com/go-gitea/gitea/main/contrib/legal/privacy.html.sample
```

### 编辑隐私政策页面

现在，你需要编辑该页面以满足你的需求。特别是，你必须更改电子邮件地址、网址以及与 "Your Gitea Instance" 相关的引用，以匹配你的情况：

```bash
sudo -u git vim /var/lib/gitea/custom/public/assets/privacy.html
```

请务必不要放置会暗示 Gitea 项目对你的服务器负责的一般服务条款或隐私声明。

## 添加备案信息

### 创建自定义页脚链接模板

创建或编辑页脚链接模板文件：

```bash
# 创建必要的目录
sudo -u git mkdir -p /var/lib/gitea/custom/templates/custom

# 创建页脚链接模板
sudo -u git tee /var/lib/gitea/custom/templates/custom/extra_links_footer.tmpl << 'EOF'
<a class="item" href="AppSubUrl/assets/privacy.html">隐私政策</a>
<a class="item" href="https://beian.miit.gov.cn/">湘ICP备2024072853号-1</a>
<a class="item" href="https://www.beian.gov.cn/portal/registerSystemInfo?recordcode=43010402002198">湘公网安备43010402002198号</a>
EOF
```

### 验证模板文件内容

```bash
sudo -u git cat /var/lib/gitea/custom/templates/custom/extra_links_footer.tmpl
```

预期输出应该类似于：
```
<a class="item" href="AppSubUrl/assets/privacy.html">隐私政策</a>
<a class="item" href="https://beian.miit.gov.cn/">湘ICP备2024072853号-1</a>
<a class="item" href="https://www.beian.gov.cn/portal/registerSystemInfo?recordcode=43010402002198">湘公网安备43010402002198号</a>
```

## 6.3 重启 Gitea 服务

应用所有更改后，重启 Gitea 服务以使配置生效：

```bash
sudo systemctl restart gitea
```

## 6.4 验证配置

### 检查服务状态

```bash
sudo systemctl status gitea
```

### 在浏览器中验证

1. 打开浏览器访问你的 Gitea 实例
2. 滚动到底部页脚区域
3. 确认能看到"隐私政策"、"湘ICP备2024072853号-1"和"湘公网安备43010402002198号"链接
4. 点击"隐私政策"链接验证页面是否正常显示

# 七、补充：使用 Supervisor 管理 Gitea

如果您更喜欢使用 Supervisor 而不是 systemd，可以创建 Supervisor 配置：

```bash
sudo -u git mkdir -p /home/git/gitea/log/supervisor
vim /etc/supervisor/conf.d/gitea.conf
```

在配置文件中添加：

```ini
[program:gitea]
command=/usr/bin/gitea web --config /etc/gitea/app.ini
directory=/var/lib/gitea
user=git
autostart=true
autorestart=true
redirect_stderr=true
stdout_logfile=/home/git/gitea/log/supervisor/gitea.log
```

然后启动 Supervisor：

```bash
systemctl enable --now supervisor
```

# 结语

通过以上步骤，您已成功在 Debian 13 系统上安装并配置了 Gitea 服务。Gitea 提供了完整的 Git 服务功能，包括代码仓库管理、Issue 跟踪、Pull Request 等，非常适合团队内部使用。相比其他 Git 服务，Gitea 以其轻量级、易部署和丰富的功能受到广泛欢迎。

下一步，您可以根据团队需求配置更多功能，如 SSH 密钥管理、邮件通知、CI/CD 集成等，进一步提升开发协作效率。同时，确保定期备份数据库和重要配置文件，以保障服务的稳定运行。