---
title: 配置Linux服务器基本环境（Debian13为例）
published: 2025-08-15
updated: 2025-08-15
pinned: false
description: 以Debian13为例，详细介绍Linux服务器基础环境配置，包括安全设置、用户管理、服务配置等
tags:
  - Linux
  - Debian
  - 服务器配置
  - 安全设置
  - 用户管理
category: Linux运维
author: Hyperbola
draft: false
series: Linux服务器运维
---

# 写在开头

## 废话

这是我2025.09.07打算将腾讯云服务器由debian12改为debian13进行同意测试与部署流程的记录，由于备份问题最开始升级失败，反正也没有部署啥业务，就索性重装（截止2025.09.07腾讯云没有默认提供debian13的镜像）debian12，再升级

2026.2.27 将家里服务器PVE改为单Debian故再次重装

### Debian12升级Debian13参考链接

```
https://www.sysgeek.cn/upgrade-debian-13/
```

### 升级成功标志

```sh
root@VM-20-4-debian:~# cat /etc/debian_version
13.1
```

# 调整root下的一些配置

> [!WARNING]
>
> 注意：该章默认为root账户，如果是非root账户遇到权限相关的提示，请使用sudo进行提权

## 网络相关

### 主机名

首先修改腾讯云默认主机名VM-20-4-debian

修改/etc/hosts和/etc/hostname的内容

```sh
vim /etc/hosts

root@hyperbola-txy:~# cat /etc/hosts
#
127.0.1.1 localhost.localdomain hyperbola-txy
127.0.0.1 localhost

::1 ip6-localhost ip6-loopback
fe00::0 ip6-localnet
ff00::0 ip6-mcastprefix
ff02::1 ip6-allnodes
ff02::2 ip6-allrouters
ff02::3 ip6-allhosts
```

重启后即可生效

使用 hostnamectl 将会输出主机名信息

```sh
root@hyperbola-txy:~# hostnamectl
 Static hostname: hyperbola-txy
       Icon name: computer-vm
         Chassis: vm 🖴
      Machine ID: 4963856e9b0d4c66a1561cd31bf609fa
         Boot ID: 64f4195ec0274c16959dfb29a624e53d
    Product UUID: 4963856e-9b0d-4c66-a156-1cd31bf609fa
    AF_VSOCK CID: 1
  Virtualization: kvm
Operating System: Debian GNU/Linux 13 (trixie)
          Kernel: Linux 6.12.43+deb13-amd64
    Architecture: x86-64
 Hardware Vendor: Tencent Cloud
  Hardware Model: CVM
 Hardware Serial: 4963856e-9b0d-4c66-a156-1cd31bf609fa
Firmware Version: seabios-1.9.1-qemu-project.org
   Firmware Date: Tue 2014-04-01
    Firmware Age: 11y 5month 1w	
```



# 调整用户配置

> [!WARNING]
>
> 注意：该章切换用户前默认为root账户，如果是非root账户请使用sudo su -进行切换为root账户

由于使用root用户进行业务部署并不安全，因此应当手动创建一个用户

## 删除默认用户（可选）

由于腾讯云自带了一个默认用户，出于安全考虑应该删除

可以通过ls /home的方法简单查看当前用户列表

```sh
root@hyperbola-txy:~# ls /home
lighthouse
```

删除用户

```sh
sudo deluser --remove-home lighthouse
```

##  创建并配置新用户

### 1. 创建用户并自动创建主目录

使用 `useradd` 命令创建名为 `hyperbola` 的用户，并通过 `-m` 选项自动创建其主目录 `/home/hyperbola`：

```sh
sudo useradd -m hyperbola
```

> ⚠️ 注意：该命令不会为用户设置密码。你需要手动设置密码才能允许登录。

------

### 2. 为新用户设置登录密码

```sh
sudo passwd hyperbola
```

系统会提示你输入并确认密码。请设置一个安全的密码。

示例输出：

```sh
root@hyperbola-txy:~# sudo passwd hyperbola
New password:
Retype new password:
passwd: password updated successfully
```

------

3. 验证用户是否创建成功

检查用户信息：

```sh
id hyperbola
uid=1001(hyperbola) gid=1001(hyperbola) groups=1001(hyperbola)
```

查看 `/home` 目录，确认主目录已创建：

```
ls /home
```

你应该能看到 `<你的用户名>` 目录。

------

### 4. 将新用户添加到 `sudo` 组（启用 sudo 权限）

在大多数基于 Red Hat 的系统（如 CentOS、Fedora）中，`wheel` 组用于授予管理员权限。在 Debian 系统中，默认使用 `sudo` 组，但 `wheel` 也可能存在。

#### 使用 `usermod` 添加到 `root` 组

```sh
usermod -aG sudo hyperbola
```

> - `-aG` 表示“追加到组”，避免覆盖原有组成员关系。

或者

```sh
usermod -aG wheel hyperbola
```

#### 验证组成员身份

```
groups hyperbola
```

或：

```
id hyperbola
```

输出应包含 `wheel` 或 `sudo`。

------

### 5. 切换到新用户进行测试

```
su - hyperbola
```

> 使用 `-` 选项可以切换到该用户的完整登录环境（加载 profile 和主目录变量）。

登录后可以通过以下命令确认当前用户：

```sh
whoami
pwd
```

我的输出为：

```
hyperbola
/home/hyperbola
```

------

### 6. 测试 sudo 权限

切换回 `hyperbola` 用户后，尝试执行需要管理员权限的命令：

```sh
sudo ls /root
```

如果配置正确，输入密码后应能执行命令（或根据系统策略免密执行）。

>  注意：sudoers文件需要确保系统已配置 `wheel` 或 `sudo` 组具有 sudo 权限。（我的腾讯云需修改sudoers文件）
>
>  通常 `/etc/sudoers` 文件中已有如下行（不要手动编辑，除非使用 `visudo`）：
>
> ```
> %wheel  ALL=(ALL) ALL
> ```
>
> 或
>
> ```
> %sudo   ALL=(ALL) ALL
> ```

## 停用ssh密码登录

为安全考虑建议关闭ssh密码登录，改为ssh密钥登录

```sh
sudo vim /etc/ssh/sshd_config
```

```
# 禁用密码认证
PasswordAuthentication no

# 禁用交互式密码认证（如 PAM）
ChallengeResponseAuthentication no

# 确保 Pubkey 认证开启
PubkeyAuthentication yes

# 强烈建议：禁用 root 密码登录
PermitRootLogin prohibit-password
```



# 环境部署

## zsh终端环境

我比较习惯使用zsh，因此以zsh为例进行演示

### 安装zsh以及前置软件（git curl）

```sh
sudo apt install zsh git curl
```

设置默认终端为 zsh（注意：不要使用 sudo）。

```sh
chsh -s /bin/zsh
```

提示输入的密码为用户密码而非root密码

### 安装 oh-my-zsh

官网：http://ohmyz.sh/。 安装方式任选一个即可。

| Method                                       | Command                                                                              |
| :------------------------------------------- | :----------------------------------------------------------------------------------- |
| **curl**                                     | `sh -c "$(curl -fsSL https://install.ohmyz.sh/)"`                                    |
| **wget**                                     | `sh -c "$(wget -O- https://install.ohmyz.sh/)"`                                      |
| **fetch**                                    | `sh -c "$(fetch -o - https://install.ohmyz.sh/)"`                                    |
| 国内curl[镜像](https://gitee.com/pocmon/ohmyzsh) | `sh -c "$(curl -fsSL https://gitee.com/pocmon/ohmyzsh/raw/master/tools/install.sh)"` |
| 国内wget[镜像](https://gitee.com/pocmon/ohmyzsh) | `sh -c "$(wget -O- https://gitee.com/pocmon/ohmyzsh/raw/master/tools/install.sh)"`   |

注意：同意使用 Oh-my-zsh 的配置模板覆盖已有的 .zshrc。

### 配置 oh-my-zsh主题

#### 推荐使用 powerlevel10k

```sh
git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k

# 中国用户可以使用 gitee.com 上的官方镜像加速下载
git clone --depth=1 https://gitee.com/romkatv/powerlevel10k.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k
```

主题众多，这里就不过多阐释了具体可以参考文章

https://www.haoyep.com/posts/zsh-config-oh-my-zsh/

#### 修改~/.zshrc

```sh
vim ~/.zshrc

# 修改这一行 ZSH_THEME="powerlevel10k/powerlevel10k"

source ~/.zshrc
```

source后即可按照提示进行配置主题

### 配置zsh插件

#### zsh内置的插件

`oh-my-zsh` 内置了 `z` 插件。`z` 是一个文件夹快捷跳转插件，对于曾经跳转过的目录，只需要输入最终目标文件夹名称，就可以快速跳转，避免再输入长串路径，提高切换文件夹的效率。

`oh-my-zsh` 内置了 `extract` 插件。`extract` 用于解压任何压缩文件，不必根据压缩文件的后缀名来记忆压缩软件。使用 `x` 命令即可解压文件

oh-my-zsh 内置了 `web-search` 插件。`web-search` 能让我们在命令行中使用搜索引擎进行搜索。使用`搜索引擎关键字+搜索内容` 即可自动打开浏览器进行搜索。

#### [zsh-autosuggestions](https://github.com/zsh-users/zsh-autosuggestions) 

[zsh-autosuggestions](https://github.com/zsh-users/zsh-autosuggestions) 是一个命令提示插件，用于命令补全

```sh
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions

# 中国用户可以使用下面加速下载
git clone https://gh.xmly.dev/https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
```



#### zsh-syntax-highlighting

[zsh-syntax-highlighting](https://github.com/zsh-users/zsh-syntax-highlighting) 是一个命令语法校验插件，在输入命令的过程中，若指令不合法，则指令显示为红色，若指令合法就会显示为绿色。

```sh
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting

# 中国用户可以使用下面加速下载
git clone https://gh.xmly.dev/https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
```

或者可以使用fast-syntax-highlighting，性能可能更好

```sh
git clone https://github.com/zdharma-continuum/fast-syntax-highlighting.git \
  ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/plugins/fast-syntax-highlighting
```

#### 按需启用插件

```sh
vim ~/.zshrc

# 修改这一行 ZSH_THEME="powerlevel10k/powerlevel10k"

source ~/.zshrc
```

我启用的为

```
plugins=(git zsh-autosuggestions fast-syntax-highlighting z extract)
```

## 一些常用的命令行的安装

以下是根据我的一些习惯用的软件

### 软件介绍

#### eza

ls的替代品，推荐添加别名

#### neovim

vim的现代化版本

#### btop

top的现代化版本

#### 。。..



### 示例安装：eza

```sh
sudo apt install eza
```

在.zshrc添加别名

```sh
 echo "alias ls='eza -l'" >> ./.zshrc
```

# 其他

如果出现usermod无法找到的情况将下面的添加进./.zshrc

```sh
export PATH="/usr/local/sbin:/usr/sbin:/sbin:$PATH"
```



# 结尾

到此基础环境就搭建完成了

接下来需要开发环境，生成环境等环境的部署

