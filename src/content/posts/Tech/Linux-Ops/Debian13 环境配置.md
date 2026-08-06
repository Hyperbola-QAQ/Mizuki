---
title: Debian13 环境配置
published: 2026-02-27
updated: 2026-02-27
pinned: false
description: Debian13服务器环境配置指南，包括网络、安全、开发环境等基础设置
tags: [Linux]
category: DevOps
author: Hyperbola
draft: false
series: Linux服务器运维
---

# 写在开头

## 废话

2026.2.27 将家里服务器PVE改为单Debian故再次重装

于是接着25年的一个基础配置文章部署环境


# 调整root下的一些配置

> [!WARNING]
>
> 注意：该章默认为root账户，如果是非root账户遇到权限相关的提示，请使用sudo进行提权

## 网络相关

1.  **链路聚合 (Bonding)**：将 `eno1` 和 `enp3s0` 绑定为 `bond0` (模式 802.3ad/LACP)。
2.  **网桥 (Bridging)**：创建 `br0` 网桥，并将 `bond0` 作为端口加入。
3.  **网络接入**：宿主机和未来的 KVM 虚拟机都通过 `br0` 获取 IP 并上网。

---

### systemd-networkd 实现 Bond + Bridge

#### 1. 准备工作：禁用 NetworkManager
如果你之前使用 NetworkManager，必须先停止并禁用它，以免冲突。

```bash
sudo systemctl stop NetworkManager
sudo systemctl disable NetworkManager
sudo systemctl enable --now systemd-networkd
```

#### 2. 清理旧配置
建议先清空 `/etc/systemd/network/` 目录下的旧配置，避免文件名冲突或逻辑干扰。
```bash
sudo rm /etc/systemd/network/*.network
sudo rm /etc/systemd/network/*.netdev
```

#### 3. 创建配置文件

请在 `/etc/systemd/network/` 目录下创建以下 **6个文件**。你可以直接复制粘贴内容。

##### ① 定义 Bond 设备 (`10-bond0.netdev`)
定义逻辑接口 `bond0` 及其聚合模式。
```ini
[NetDev]
Name=bond0
Kind=bond

[Bond]
Mode=802.3ad
TransmitHashPolicy=layer3+4
MIIMonitorSec=100ms
LACPTransmitRate=fast
MinLinks=1
```

##### ② 定义 Bridge 设备 (`20-br0.netdev`)
定义逻辑网桥 `br0`。
```ini
[NetDev]
Name=br0
Kind=bridge
```

##### ③ 配置物理网卡 eno1 (`30-eno1.network`)
将物理网卡 `eno1` 加入 `bond0`。
```ini
[Match]
Name=eno1

[Network]
Bond=bond0
```

##### ④ 配置物理网卡 enp3s0 (`30-enp3s0.network`)
将物理网卡 `enp3s0` 加入 `bond0`。
```ini
[Match]
Name=enp3s0

[Network]
Bond=bond0
```

##### ⑤ 配置 Bond0 加入网桥 (`40-bond0.network`)
**关键点**：这里**不要**配置 IP 地址，只负责把 `bond0` 桥接到 `br0`。IP 将在下一步配置给 `br0`。
```ini
[Match]
Name=bond0

[Network]
Bridge=br0
# 注意：这里不要写 Address 或 DHCP，IP 由 br0 负责
```

##### ⑥ 配置网桥 IP 地址 (`50-br0.network`)
这是整个系统的网络出口配置。宿主机和虚拟机都将通过这个接口通信。
*(请根据你的实际网络环境修改 IP、网关和 DNS)*

```ini
[Match]
Name=br0

[Network]
# --- 选项 A: 使用 DHCP 自动获取 IP (推荐测试用) ---
DHCP=yes

# --- 选项 B: 使用静态 IP (生产环境推荐) ---
# 如果要使用静态 IP，请删除上面的 DHCP=yes，并取消下面几行的注释，修改为你的真实 IP
# Address=192.168.86.3/24
# Gateway=192.168.86.1
# DNS=223.5.5.5
# DNS=8.8.8.8
```

#### 4. 应用配置

保存所有文件后，重启网络服务：

```bash
sudo systemctl restart systemd-networkd
```

#### 5. 验证状态

等待几秒钟，然后运行以下命令检查状态：

1.  **检查接口状态**：
    ```bash
    ip addr show br0
    ```
    *成功标志*：`br0` 应该显示 `state UP` 和 `LOWER_UP`，并且有 IP 地址。不再有 `NO-CARRIER`。

2.  **检查 Bond 状态**：
    ```bash
    cat /proc/net/bonding/bond0
    ```
    *成功标志*：能看到 `Bonding Mode: IEEE 802.3ad Dynamic link aggregation` 且 `Slave Interface` 列表中的 `eno1` 和 `enp3s0` 状态都是 `up`。

3.  **检查桥接成员**：
    ```bash
    bridge link
    ```
    *成功标志*：能看到 `bond0` 的 `master` 是 `br0`。

现在，宿主机和 OpenWrt 虚拟机都将通过 `br0` -> `bond0` -> `物理网卡` 的路径上网，享受链路聚合带来的带宽叠加和高可用性。


### 主机名

如果安装引导的主机名你不喜欢又忘记了修改

修改/etc/hosts以及/etc/hostname的内容,重启后即可生效

使用 hostnamectl 将会输出主机名信息

```sh
hyperbola@Hyperbola-Server:~$ hostnamectl
 Static hostname: Hyperbola-Server
       Icon name: computer-desktop
         Chassis: desktop 🖥️
      Machine ID: c3902bd0d425420381eb440b7f83ef8f
         Boot ID: 7407b394c16a4e7c9bc041f614ea281d
Operating System: Debian GNU/Linux 13 (trixie)    
          Kernel: Linux 6.12.63+deb13-amd64
    Architecture: x86-64
 Hardware Vendor: MECHREVO
  Hardware Model: IMINI Series
Firmware Version: IMINI Series 1.12
   Firmware Date: Thu 2025-02-20
    Firmware Age: 1y 1w
```

# 环境部署

## Clash Verge Rev

```shell
wget https://github.com/clash-verge-rev/clash-verge-rev/releases/download/v2.4.6/Clash.Verge_2.4.6_amd64.deb
```



## zsh终端环境

我比较习惯使用zsh，因此以zsh为例进行演示

### 安装zsh以及前置软件

```sh
sudo apt install zsh git curl wget thefuck
sh -c "$(wget -O- https://install.ohmyz.sh/)"
git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
git clone https://github.com/zdharma-continuum/fast-syntax-highlighting.git \
  ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/plugins/fast-syntax-highlighting

```

设置默认终端为 zsh（注意：不要使用 sudo）。

```sh
chsh -s /bin/zsh
```

提示输入的密码为用户密码而非root密码

## 同步点文件

安装同步工具chezmoi

```shell
wget https://github.com/twpayne/chezmoi/releases/download/v2.69.4/chezmoi_2.69.4_linux_amd64.deb
sudo apt install ./chezmoi_2.69.4_linux_amd64.deb
chezmoi init --apply git@github.com:Hyperbola-QAQ/dotfiles.git
```

> git@github.com:Hyperbola-QAQ/dotfiles.git 为我的点文件同步私有仓库

## 开启ZRAM

```shell
sudo apt update sudo apt install zram-tools
sudoedit /etc/default/zramswap
```

修改占比为30%

## 一些常用的软件的安装

```shell
sudo apt install btop tmux byobu starship kitty ripgrep eza nginx bat
```

### uv miniforge
```shell
curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install jupyterlab
uv tool install nb-cli 
uv tool install ty
uv tool install ruff
wget https://github.com/conda-forge/miniforge/releases/download/26.1.0-0/Miniforge3-26.1.0-0-Linux-x86_64.sh | sh

```

### yazi rust
```
sudo apt install ffmpeg 7zip jq poppler-utils fd-find ripgrep fzf zoxide imagemagick
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup update
cargo install --force yazi-build
```
### mise
```
sudo apt update -y && sudo apt install -y curl
sudo install -dm 755 /etc/apt/keyrings
curl -fSs https://mise.jdx.dev/gpg-key.pub | sudo tee /etc/apt/keyrings/mise-archive-keyring.asc 1> /dev/null
echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.asc] https://mise.jdx.dev/deb stable main" | sudo tee /etc/apt/sources.list.d/mise.list
sudo apt update -y
sudo apt install -y mise
```

### ddns-go
```ini
wget https://github.com/jeessy2/ddns-go/releases/download/v6.15.0/ddns-go_6.15.0_linux_x86_64.tar.gz
x ./ddns-go_6.15.0_linux_x86_64.tar.gz
sudo mv ./ddns-go_6.15.0_linux_x86_64/ddns-go /usr/bin
echo "[Unit]
Description=The DDNS-GO Process Manager
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/ddns-go -c /etc/ddns-go/config.yaml
ExecStop=/bin/killall ddns-go

[Install]
WantedBy=multi-user.target" | sudo tee /etc/systemd/system/ddns-go.service
sudo systemctl enable --now ddns-go
```

### Jenkins
```shell
sudo wget -O /etc/apt/keyrings/jenkins-keyring.asc \
  https://pkg.jenkins.io/debian/jenkins.io-2026.key
echo "deb [signed-by=/etc/apt/keyrings/jenkins-keyring.asc]" \
  https://pkg.jenkins.io/debian binary/ | sudo tee \
  /etc/apt/sources.list.d/jenkins.list > /dev/null
sudo apt update
sudo apt install jenkins
```
### Docker

**步骤 1：更新系统软件包**

```
sudo apt update
sudo apt upgrade -y
```

**步骤 2：安装必要的依赖**

安装 Docker 需要一些依赖项。运行以下命令安装它们：

```
sudo apt install -y apt-transport-https ca-certificates curl gnupg lsb-release
```

**步骤 3：添加 Docker 官方 GPG 密钥**

为了验证 Docker 软件包的真实性，您需要添加 Docker 的官方 GPG 密钥。由于网络原因，直接从 Docker 官方获取可能不稳定，我们可以尝试通过 `keyrings.debian.org` 或者 `keyserver.ubuntu.com` 获取，或者直接下载。这里我们尝试先通过 `curl` 方式：

```
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
```

如果 `curl` 命令失败，可以尝试手动下载 GPG 密钥并放置到 `/etc/apt/keyrings/` 目录下。

**步骤 4：添加 Docker APT 仓库**

接下来，您需要添加 Docker 的 APT 仓库。为了在中国大陆获得更好的下载速度，我们可以考虑使用国内的镜像源。

**选项 A：使用 Docker 官方仓库（如果网络状况良好）**

```
echo \
  "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
 "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

**选项 B：使用国内镜像源（推荐，例如阿里云）**

首先，您可能需要将官方仓库注释掉或删除。然后添加国内镜像源的配置。 请注意，不同镜像源提供的仓库地址可能有所不同，这里以阿里云为例。请替换为您 Debian 版本的代号（例如 `bookworm`）。

```
# 首先移除或注释掉之前的docker.list文件，如果存在的话
# sudo rm /etc/apt/sources.list.d/docker.list
 
# 添加阿里云镜像源
# 请将 "$(lsb_release -cs)" 替换为您的 Debian 版本代号，例如 bookworm
echo \
  "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://mirrors.aliyun.com/docker-ce/linux/debian \
 "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

请注意，阿里云等国内镜像站通常会同步 Docker 官方的 GPG 密钥，因此步骤 3 的密钥添加仍然是必需的。

**步骤 5：安装 Docker 引擎**

更新 APT 软件包索引，然后安装 Docker Engine、Containerd 和 Docker Compose。

```
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

**步骤 6：验证 Docker 安装**

安装完成后，您可以运行一个简单的 `hello-world` 容器来验证 Docker 是否正确安装并运行：

```
sudo docker run hello-world
```

如果一切正常，您应该会看到一条消息，表明您的安装工作正常。

**步骤 7：配置非 root 用户使用 Docker (可选但推荐)**

默认情况下，运行 `docker` 命令需要 `sudo` 权限。如果您想让非 root 用户也能运行 Docker 命令，可以将该用户添加到 `docker` 组中：

```
sudo usermod -aG docker $USER
```

然后，您需要退出并重新登录，或者运行 `newgrp docker` 命令使更改生效。

```
newgrp docker
```

之后，您就可以不带 `sudo` 运行 `docker` 命令了。

**步骤 8：配置 Docker 镜像加速器 (可选但推荐)**

在中国大陆使用 Docker 时，从 Docker Hub 下载镜像可能会很慢。配置镜像加速器可以显著提高下载速度。您可以选择阿里云、腾讯云等提供的免费镜像加速服务。

1. 登录您的云服务商控制台（例如阿里云），找到容器镜像服务，通常会有提供一个专属的镜像加速器地址。

2. 编辑 Docker 的配置文件 `/etc/docker/daemon.json`。如果文件不存在，则创建它。

   ```
   sudo nano /etc/docker/daemon.json
   ```

3. 添加以下内容，将 `YOUR_MIRROR_ACCELERATOR` 替换为您获取到的镜像加速器地址。

   ```
   {
     "registry-mirrors": ["https://YOUR_MIRROR_ACCELERATOR"]
   }
   ```

   例如，使用阿里云的公共加速器（请替换为您的专属加速器地址）：

   ```
   {
     "registry-mirrors": ["https://<您的ID>.mirror.aliyuncs.com"]
   }
   ```

   或者尝试一些通用的公共加速器，但稳定性可能不如专属加速器：

   ```
   {
     "registry-mirrors": ["https://hub-mirror.c.163.com", "https://mirror.baidubce.com"]
   }
   ```

4. 保存并关闭文件 (Ctrl+X, Y, Enter)。

5. 重启 Docker 服务以使配置生效：

   ```
   sudo systemctl daemon-reload
   sudo systemctl restart docker
   ```

至此，您应该已经成功在 Debian 13 上安装并配置了 Docker，并且针对中国大陆的网络环境进行了优化。

## acme.sh自动签发HTTPS

参考配置Nginx




# 虚拟机部署

## 检查并创建 libvirt 网络

### 创建网络定义文件

在终端运行以下命令（直接复制粘贴即可）：

```shell
cat > /tmp/br0-bond.xml <<EOF
<network>
  <name>br0-bond</name>
  <forward mode="bridge"/>
  <bridge name="br0"/>
</network>
EOF
```

### 定义并启动该网络

依次运行以下三条命令：

```
# 1. 将 XML 定义导入 libvirt
sudo virsh net-define /tmp/br0-bond.xml

# 2. 启动该网络
sudo virsh net-start br0-bond

# 3. 设置开机自启（可选，但推荐）
sudo virsh net-autostart br0-bond
```

### 验证网络是否存在：

运行以下命令，你应该能在列表中看到 `br0-bond` 且状态为 `active`：

```shell
sudo virsh net-list --all
```

```txt
Name         State      Autostart   Persistent
------------------------------------------------
br0-bond     active     yes         yes
default      active     yes         yes
```

## 确认主机网桥 `br0` 已就绪

libvirt 的网络只是逻辑定义，它依赖于主机上真实存在的网桥接口 `br0`。

运行以下命令检查主机是否有 `br0`：

```
ip addr show br0
```

- **如果有输出**（显示 IP 地址等信息）：说明主机网络配置正确，可以直接进行第三步。
- **如果报错 `Device "br0" does not exist`**：
  说明你还没有在 Debian 主机上配置好网桥。你需要先配置主机的 `/etc/network/interfaces` 或使用 NetworkManager 创建 `br0` 并绑定到你的物理网卡（或 bond0），然后重启网络服务。**虚拟机无法连接到一个不存在的宿主网桥。**

## 创建 KVM 虚拟机

一旦 `br0` 状态正常（UP），你就可以重新运行之前的 `virt-install` 命令了。 libvirt 定义的 `br0-bond` 网络（桥接宿主机的 `br0`）将能正常工作。

```bash
wget https://fw20.koolcenter.com/iStoreOS/x86_64_efi/istoreos-24.10.5-2025123110-x86-64-squashfs-combined-efi.img.gz

x ./istoreos-24.10.5-2025123110-x86-64-squashfs-combined-efi.img.gz

qemu-img convert -f raw -O qcow2 istoreos-24.10.5-2025123110-x86-64-squashfs-combined-efi.img openwrt.qcow2

sudo mkdir /var/lib/libvirt/images/openwrt

sudo mv openwrt.qcow2 /var/lib/libvirt/images/openwrt/

# 启动安装
sudo virt-install \
  --name openwrt \
  --ram 512 \
  --vcpus 1 \
  --disk path=/var/lib/libvirt/images/openwrt/openwrt.qcow2,format=qcow2,bus=virtio \
  --import \
  --network network=br0-bond,model=virtio \
  --boot uefi \
  --os-variant generic \
  --graphics none \
  --console pty,target_type=serial
```



# 其他

如果出现usermod无法找到的情况将下面的添加进./.zshrc

```sh
export PATH="/usr/local/sbin:/usr/sbin:/sbin:$PATH"
```



# 结尾

到此基础环境就搭建完成了

接下来需要开发环境、生产环境等环境的部署