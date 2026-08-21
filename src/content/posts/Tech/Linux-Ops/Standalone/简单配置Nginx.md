---
title: Nginx基础配置指南
published: 2025-03-05
updated: 2025-03-05
pinned: false
description: Nginx Web服务器的基础配置教程，包括虚拟主机、SSL证书、反向代理等常用配置
tags: [DevOps]
category: DevOps
author: Hyperbola
draft: false
series: Web服务器配置
---

# 前言

## 说明

示例使用的版本为Debian13.1

反向代理服务器为nginx

https使用的是 [acme脚本](https://github.com/acmesh-official/acme.sh)进行自动续约证书

# Nginx相关部署

## 安装nginx

```sh
sudo apt install nginx
```

## 立即启动nginx并开机自启

```sh
sudo systemctl enable --now nginx
```

此时直接访问服务器ip应该可以看见Welcome to nginx!的页面

# 设置nginx相关权限

#### 1. 创建网站目录（如果不存在）

```sh
sudo mkdir -p /var/www/html
```

#### 2. 设置所有者为 `www-data`，但允许你管理

```sh
# 将你加入 www-data 组（推荐）
sudo /usr/sbin/usermod -aG www-data $USER
```

然后重新登录或执行：

```sh
newgrp www-data
```

#### 3. 设置目录权限

```sh
# 设置配置文件夹所有者与权限
sudo chown -R root:www-data /etc/nginx/
sudo chmod -R 775 /etc/nginx/

# 设置所有者
sudo chown -R www-data:www-data /var/www/html

# 设置权限：目录 755，文件 644
sudo find /var/www/html -type d -exec chmod 755 {} \;
sudo find /var/www/html -type f -exec chmod 644 {} \;

# 特别：如果你要上传文件，确保你有写权限
sudo chmod 775 /var/www/html
sudo chgrp www-data /var/www/html
```

# 配置Nginx使用https

## 安装acme脚本

```sh
curl https://get.acme.sh | sh -s email=my@example.com
```

添加别名方便使用

```sh
echo 'alias acme.sh=~/.acme.sh/acme.sh' >> ~/.zshrc
```

## DNS 方式添加证书

### 获取DNS服务商的Token

请自行查阅您的dns服务商的token获取教程或查看[acme文档](https://github.com/acmesh-official/acme.sh/wiki/%E8%AF%B4%E6%98%8E)

### 导入DNS的Token

```sh
export CF_Token="St63AUb****************************79"
export CF_Account_ID="250*****c********************ed"
```

### 签发通配符证书

具体命令需要根据dns服务商更改，参考：[acme文档](https://github.com/acmesh-official/acme.sh/wiki/%E8%AF%B4%E6%98%8E)

```sh
acme.sh --issue --dns dns_cf -d hyperbola.cc -d '*.hyperbola.cc'
```

注意：使用zsh时*会被识别为zsh语法，需要使用''引用

### 修改默认 CA

acme.sh 脚本默认 CA 服务器是 `ZeroSSL`，有时可能会导致获取证书的时候一直出现：`Pending，The CA is processing your order，please just wait.`

只需要把 CA 服务器改成 `Let's Encrypt` 即可，虽然更改以后还是有概率出现 pending，但基本 2-3 次即可成功

```sh
acme.sh --set-default-ca --server letsencrypt
```

## 复制证书

证书生成好以后，我们需要把证书复制给对应的 Nginx 或其他服务器去使用。

**必须使用** `--install-cert` 命令来把证书复制到目标文件，请勿直接使用 `~/.acme.sh/` 目录下的证书文件，这里面的文件都是内部使用，而且目录结构将来可能会变化。

```sh
acme.sh --install-cert -d hyperbola.cc -d '*.hyperbola.cc' \
--key-file       /etc/nginx/tls/key.pem  \
--fullchain-file /etc/nginx/tls/cert.pem \
--reloadcmd     "service nginx reload"
```

# 配置Nginx静态页面

## 创建静态站点

我的静态站点为 `blog.hyperbola.cc`。

### 1. 创建网站根目录

```sh
sudo mkdir -p /var/www/blog.hyperbola.cc/html
```

### 设置权限

```sh
sudo chown -R $USER:www-data /var/www/blog.hyperbola.cc/html
sudo chmod -R 775 /var/www/blog.hyperbola.cc/html
sudo chmod g+s /var/www/blog.hyperbola.cc/html  # setgid
```

## 上传网站文件

```sh
scp -r ./dist/* hyperbola@x.x.x.x:/var/www/blog.hyperbola.cc/html/
```



## 创建 Nginx 站点配置

```sh
sudo vim /etc/nginx/sites-available/blog.hyperbola.cc
```

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name blog.hyperbola.cc hyperbola.cc www.hyperbola.cc;

    ssl_certificate /etc/nginx/tls/cert.pem;      # 证书路径
    ssl_certificate_key /etc/nginx/tls/key.pem;    # 私钥路径


    # 启用现代 TLS 配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    root /var/www/blog.hyperbola.cc/html;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }

    # 安全增强
    add_header X-Content-Type-Options "nosniff";
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-XSS-Protection "1; mode=block";
}
# HTTP 80 端口跳转配置
server {
    listen 80;
    listen [::]:80;
    server_name blog.hyperbola.cc hyperbola.cc www.hyperbola.cc;

    # 主域名强制跳转
    if ($host = hyperbola.cc) {
        return 301 https://$host$request_uri;
    }

    # 处理 www 子域名
    if ($host = www.hyperbola.cc) {
        return 301 https://$host$request_uri;
    }

    # 处理 blog 子域名
    if ($host = blog.hyperbola.cc) {
        return 301 https://$host$request_uri;
    }

    # 默认跳转（兜底规则）
    return 301 https://$host$request_uri;
}
```

------

## 启用站点

```
# 创建符号链接到 sites-enabled
sudo ln -s /etc/nginx/sites-available/blog.hyperbola.cc /etc/nginx/sites-enabled/
```

> ✅ Nginx 默认会加载 `sites-enabled` 下的所有配置。

------

## 测试并重载 Nginx

```sh
# 测试配置语法
sudo nginx -t

# 如果输出 "syntax is ok"，则重载
sudo systemctl reload nginx
```

如果出现nginx无法找到的情况将下面的添加进./.zshrc

```sh
export PATH="/usr/local/sbin:/usr/sbin:/sbin:$PATH"
```

# 配置Nginx部署反向代理

## 配置参考

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;          # 监听所有 IPv6 地址的 443 端口
    http2 on;

    server_name gitea.hyperbola.cc;

    client_max_body_size 200m;

    ssl_certificate /etc/nginx/tls/cert.pem;      # 证书路径
    ssl_certificate_key /etc/nginx/tls/key.pem;    # 私钥路径

    # 启用现代 TLS 配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;

    location / {
        proxy_pass http://[::1]:30000;  # 将请求转发到本地 IPv6 的 30000 端口
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 安全增强
    add_header X-Content-Type-Options "nosniff";
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-XSS-Protection "1; mode=block";


}
```

