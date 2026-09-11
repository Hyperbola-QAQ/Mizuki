---
title: 使用 Ansible 批量初始化 Debian 服务器
published: 2026-09-07
updated: 2026-09-09
pinned: false
description: 从保底网络接入开始，使用 Ansible 初始化 Debian 服务器，并配置开发工具、虚拟化、用户级服务与 systemd-networkd 网络
tags: [Ansible, Debian, DevOps, Linux]
category: DevOps
author: Hyperbola
draft: false
series: Linux 服务器运维
---

# 前言

这篇文章记录一次真实的 Debian 服务器初始化过程：使用 Ansible 对两台带有有线链路聚合、Wi-Fi 备用链路和 Thunderbolt 直连需求的主机进行部署，同时为另一台旧服务器复用通用初始化流程。

最终的 Playbook 不仅安装常用工具，还处理了 locale、zram、FUSE、Git LFS、QEMU/KVM、libvirt、zsh、chezmoi、DDNS-Go 和 systemd 用户服务等内容。

文中的参考格式来自一篇 Nginx 配置文章，但其中的 Nginx 配置说明与本文的 Ansible 部署代码相互独立；下面的命令和配置只针对本文的 Debian 初始化项目。

# 主机规划

本文使用文档专用地址展示拓扑。发布前或复制代码时，应将 inventory 中的示例值替换为自己的实际值。

| 主机 | Ansible 接入地址 | br0 有线地址 | wlan0 备用地址 | 说明 |
| --- | --- | --- | --- | --- |
| `server-a` | `192.0.2.10` | `192.0.2.11/24` | `192.0.2.10/24` | 有线 bond、Wi-Fi 和 Thunderbolt |
| `server-b` | `192.0.2.20` | `192.0.2.21/24` | `192.0.2.20/24` | 有线 bond、Wi-Fi 和 Thunderbolt |
| `server-old` | `192.0.2.51` | 不配置 | 不配置 | 只执行通用初始化 |

前两台主机通过 Wi-Fi 保底地址连接，避免初始化阶段切换有线网络后失去 SSH。旧服务器只执行通用初始化，不执行 network role，也不安装 iwd、bolt、Impala 和 Thunderbolt 相关配置。

# 执行方式

控制端需要安装 Ansible 和 `sshpass`。inventory 使用部署用户登录，再通过 `-b` 使用 sudo 提权。

# 检查 Playbook

```sh
cd ~/Work/ansible-debian-base
ansible-playbook -b -i inventory/hosts.yml --syntax-check site.yml
```

# 为远端构建任务临时使用代理

控制端执行 Ansible 时，可以把代理变量放在当前 shell 会话中：

```sh
export HTTP_PROXY=http://proxy.example.invalid:7897
export HTTPS_PROXY=http://proxy.example.invalid:7897
ansible-playbook -b -i inventory/hosts.yml site.yml
```

Playbook 会读取当前会话中的代理变量并传给远端任务；代理不会写入服务器持久配置。需要注意，Ansible 控制端的环境变量不会自动改变远端网络；Playbook 必须使用 `environment` 显式传递，具体工具还可能受 sudo 环境过滤影响。

# 只部署指定主机

使用 `--limit`，避免每次执行所有主机：

```sh
ansible-playbook -b -i inventory/hosts.yml site.yml --limit server-old
ansible-playbook -b -i inventory/hosts.yml site.yml --limit server-a
ansible-playbook -b -i inventory/hosts.yml site.yml --limit 'server-a,server-b'
```

# 网络设计中的几个关键点

# systemd-networkd 只写配置，重启后切换

有线 bond、br0、Wi-Fi 命名规则以及路由全部写入 `/etc/systemd/network/`。Playbook 不主动重启网络服务，也不在当前 SSH 会话中重命名接口；这样可以降低远程部署时断联的风险。handler 只输出“需要整机重启”的提示。

有线接口使用 IEEE 802.3ad（LACP）bond：`eno1` 和 `eno2` 作为从接口，`bond0` 再接入 `br0`。交换机端必须使用匹配的 802.3ad/LACP 配置。`10-bond0.netdev` 的参数为 `TransmitHashPolicy=layer3+4`、`MIIMonitorSec=100ms`、`LACPTransmitRate=fast` 和 `MinLinks=1`，不再配置 `PrimarySlave`。br0 的 IPv6 使用 SLAAC 获取地址，同时通过 DHCPv6 获取 DNS，不接受 DHCPv6 地址。

两张有线网卡都通过 systemd.link 规则固定命名：第一张网卡即使原本已经叫 `eno1`，也用 `00-eno1.link` 按原始名称和 MAC 地址再次明确保持为 `eno1`；第二张网卡由 `00-eno2.link` 统一命名为 `eno2`。这样可以让 bond 的从接口命名和配置结构保持对称。

Wi-Fi 使用 iwd 完成认证和自动连接，IP 地址由 systemd-networkd 设置。由于它只是备用链路，`wlan0.network` 设置了 `RequiredForOnline=no`，避免 `systemd-networkd-wait-online.service` 因等待 Wi-Fi 连接而拖慢启动。

# 一次真实的链路聚合断联复盘

初始化服务器上架前，交换机已经配置为 802.3ad/LACP，但 Playbook 中的 bond 却使用了 `active-backup`。两端模式不匹配，服务器上架后有线管理网络完全无法连接。这不是 Thunderbolt 专线的 XDomain 问题，而是交换机与服务器链路聚合模式配置不一致。

修正后的 bond 配置必须与交换机保持一致：

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

这次改动涉及网卡从接口、bond 和 br0 的创建顺序。为了避免远程 SSH 会话在切换过程中断开，Playbook 只负责写入配置和提示，不直接重启网络服务。特别是从其他 bond 模式切换到 `802.3ad` 后，必须整机重启才能让配置稳定生效，不能只重启 `systemd-networkd`。执行前应确认串口、带外控制台或 Wi-Fi 保底入口可用，并使用 `serial: 1` 一台一台切换和验证。

# 802.3ad 重启后的验证

重启后先确认内核实际加载的是 LACP 模式，而不是只检查配置文件内容：

```sh
cat /proc/net/bonding/bond0
networkctl status bond0
ip -br link show bond0 br0
ip -4 route
```

重点检查 `/proc/net/bonding/bond0` 中出现以下状态：`Bonding Mode: IEEE 802.3ad`、`Transmit Hash Policy: layer3+4`、`MII Polling Interval (ms): 100`、`LACP rate: fast`，以及预期的活动从接口。若 bond 没有正常协商，应同时检查交换机端口聚合组、LACP 状态和两条物理链路，而不是直接在远端反复重启网络服务。

# systemd-resolved

networkd 下发的 DNS 需要由本机 resolver 使用，因此 Playbook 安装并启动 `systemd-resolved`，并将 `/etc/resolv.conf` 链接到 `/run/systemd/resolve/stub-resolv.conf`。

# Thunderbolt XDomain 故障：驱动不支持，问题尚未解决

**截至本文发布，这一问题仍未解决，不能把 Thunderbolt 专线当作可用链路。** 最终确认的原因是：在本文使用的 AMD USB4 主机与 Debian 13 当前内核组合中，AMD USB4 驱动尚不支持 Thunderbolt 网桥（XDomain）功能。Playbook 只是预先写入 `tb0` 的命名、地址和路由配置；驱动能力缺失时，系统不会创建对应的网络接口，所以 `tb0.network` 中的专线路由也不会生效。

**触发条件。** 使用 Thunderbolt 线直接连接两台 Linux 主机，并确认两端已经加载 `thunderbolt_net` 模块。

**已观察到的现象。** 两端执行 `boltctl list` 和 `boltctl monitor` 都没有输出；`lsmod` 可以看到 `thunderbolt_net` 已加载，但 `ip link` 中没有 `thunderbolt0` 或 `tb0`。同一条线缆分别连接手机时可以触发 boltd 事件，这只能说明手机连接场景能够被识别，不能证明两台 Linux 主机之间的 XDomain 网络握手成功。

**根因与边界。** 这里的 XDomain 握手失败是驱动不支持 Thunderbolt 网桥功能的结果，而不是 `boltd` 授权配置错误。由于系统没有发现对端，也没有可用于登记的 UUID，因此执行 `boltctl enroll` 不能解决问题。手机等其他雷电设备可以触发 `boltd` 事件，也不能改变 AMD USB4 主机间网桥功能缺失这一限制。

**后续 TODO。** 等待 Debian 内核或 AMD USB4 驱动补充 Thunderbolt 网桥支持，或改用已支持该功能的内核、操作系统和硬件组合。在此之前，重新插拔线缆时仍可通过以下命令记录内核行为，但这些命令不能绕过驱动能力限制：

```sh
journalctl -kf | grep -Ei 'thunderbolt|usb4|typec|xdomain'
boltctl domains
boltctl list
ip -d link show
```

在问题解决并实际出现网络接口之前，本节配置和专线路由都属于待验收状态；管理流量仍应依赖 `br0` 或 `wlan0`。

# chezmoi 与 LazyVim

首次运行时初始化 dotfiles。已有源目录时，Playbook 每次先进入 chezmoi 源目录执行 `git pull --ff-only`，然后再执行 `chezmoi apply --force --no-tty`，避免旧配置导致交互等待。

LazyVim Starter 会在 chezmoi apply 前浅克隆到 `~/.config/nvim`，随后删除 Starter 的 `.git` 元数据。若目标目录已经存在，则不会删除或覆盖它。

# DDNS-Go 用户服务

DDNS-Go 在 chezmoi 应用完成后执行：

1. 安装 `golang-go`；
2. 克隆 DDNS-Go 源码；
3. 在编译前执行 `git pull --ff-only`；
4. 执行 `make`；
5. 写入 `~/.config/systemd/user/ddns-go.service`；
6. 使用 `systemctl --user` 等价的 Ansible 模块 reload、启动并启用服务。

为了让服务器无需交互式登录就能运行用户级服务，Playbook 启用了 `loginctl enable-linger deploy_user`。如果项目要求只在用户登录后启动，可以移除这一步。

# 安全说明

博客代码没有保存真实密码，而是使用以下 Ansible Vault 变量：

```yaml
vault_deploy_user_password: "替换为 SSH 和 sudo 密码"
vault_wifi_password: "替换为 Wi-Fi 密码"
vault_wifi_iwd_profile_filename: "替换为根据实际 SSID 编码后的 iwd 配置文件名"
```

建议创建加密变量文件：

```sh
ansible-vault create inventory/group_vars/debian_servers/vault.yml
ansible-playbook -b --ask-vault-pass -i inventory/hosts.yml site.yml
```

不要把真实 SSH、sudo、Wi-Fi 密码、Token、MAC 地址或内网地址提交到 Git 仓库或博客。

# 完整 Playbook 代码

以下代码与项目当前目录结构对应。inventory 中的密码、网络地址、主机名、MAC 地址和 SSID 已替换为占位值；部署前请统一替换这些变量。

# `ansible.cfg`

```ini
[defaults]
inventory = inventory/hosts.yml
host_key_checking = True
interpreter_python = auto_silent
retry_files_enabled = False

[ssh_connection]
pipelining = True

```

# `inventory/hosts.yml`

```yaml
---
all:
  children:
    debian_servers:
      hosts:
        hyqaq-imini:
          ansible_host: 192.0.2.10
          first_nic_original_name: eno1
          first_nic_mac: "02:00:00:00:00:01"
          second_nic_original_name: enp4s0
          second_nic_mac: "02:00:00:00:00:02"
          br0_address: 192.0.2.11/24
          tb_ipv4_address: 198.18.0.0/31
          tb_ipv6_address: fd00:db8:128::0/64
          tb_peer_ipv4: 198.18.0.1
          tb_peer_ipv6: fd00:db8:128::1
          tb_peer_management_ipv4: 192.0.2.21
          tb_peer_hostname: server-b.example.invalid
          wlan0_address: 192.0.2.10/24
        hyqaq-laiku:
          ansible_host: 192.0.2.20
          first_nic_original_name: eno1
          first_nic_mac: "02:00:00:00:00:02"
          second_nic_original_name: enp3s0
          second_nic_mac: "02:00:00:00:00:03"
          br0_address: 192.0.2.21/24
          tb_ipv4_address: 198.18.0.1/31
          tb_ipv6_address: fd00:db8:128::1/64
          tb_peer_ipv4: 198.18.0.0
          tb_peer_ipv6: fd00:db8:128::0
          tb_peer_management_ipv4: 192.0.2.11
          tb_peer_hostname: server-a.example.invalid
          wlan0_address: 192.0.2.20/24
        hyqaq-oldsrv:
          ansible_host: 192.0.2.51
          skip_network: true
          skip_impala: true
          skip_iwd: true
          skip_bolt: true
          package_exclusions:
            - iwd
            - bolt
      vars:
        ansible_user: deploy_user
        ansible_password: "{{ vault_deploy_user_password }}"
        ansible_become_password: "{{ vault_deploy_user_password }}"
        ansible_python_interpreter: /usr/bin/python3
        br0_gateway: 192.0.2.1
        br0_dns:
          - 1.1.1.1
          - 8.8.8.8
        wifi_ssid: YOUR_WIFI_SSID
        wifi_password: "{{ vault_wifi_password }}"
        wifi_iwd_profile_filename: '{{ vault_wifi_iwd_profile_filename }}'
        wifi_route_metric: 600
        # Leave empty until the Thunderbolt peer is physically connected and
        # its UUID has been verified with `sudo boltctl list` on this host.
        # Set a different UUID under each host if boltctl reports one.
        thunderbolt_peer_uuid: ''
```

# `site.yml`

```yaml
---
- name: Initialize Debian servers
  hosts: debian_servers
  gather_facts: true
  serial: 1
  become_flags: -E
  environment:
    HTTP_PROXY: "{{ lookup('ansible.builtin.env', 'HTTP_PROXY') }}"
    HTTPS_PROXY: "{{ lookup('ansible.builtin.env', 'HTTPS_PROXY') }}"

  pre_tasks:
    - name: Verify target is Debian
      ansible.builtin.assert:
        that:
          - ansible_facts.distribution == 'Debian'
        fail_msg: "This playbook only supports Debian."

    - name: Verify required network variables are defined
      ansible.builtin.assert:
        that:
          - first_nic_original_name | length > 0
          - first_nic_mac | length > 0
          - second_nic_original_name | length > 0
          - second_nic_mac | length > 0
          - br0_address | length > 0
          - br0_gateway | length > 0
        fail_msg: "Network variables are incomplete for {{ inventory_hostname }}."
      when: not (skip_network | default(false))

  roles:
    - base
    - packages
    - role: network
      when: not (skip_network | default(false))
```

# `roles/base/files/ensure-en-us-utf8.sh`

```sh
#!/bin/sh
set -eu

target='en_US.UTF-8'
current=''

if [ -r /etc/default/locale ]; then
    current="$(sed -n 's/^LANG=//p' /etc/default/locale | tail -n 1 | tr -d '"')"
fi

if [ -z "$current" ]; then
    current="$(locale 2>/dev/null | sed -n 's/^LANG=//p' | tr -d '"')"
fi

if [ "$current" = "$target" ]; then
    exit 0
fi

if ! locale -a 2>/dev/null | tr '[:upper:]' '[:lower:]' | grep -qx 'en_us\.utf8'; then
    if [ -f /etc/locale.gen ]; then
        sed -i 's/^# *\(en_US.UTF-8 UTF-8\)$/\1/' /etc/locale.gen
    else
        printf '%s\n' 'en_US.UTF-8 UTF-8' > /etc/locale.gen
    fi
    locale-gen en_US.UTF-8
fi

update-locale LANG=en_US.UTF-8
printf '%s\n' changed
```

# `roles/base/handlers/main.yml`

```yaml
---
- name: Zram reboot required
  ansible.builtin.debug:
    msg: >-
      zram configuration was staged on {{ inventory_hostname }}. Reboot this
      host to create zram0 with a size equal to physical memory.
```

# `roles/base/tasks/main.yml`

```yaml
---
- name: Install locale package
  ansible.builtin.apt:
    name:
      - locales
      - systemd-zram-generator
    state: present
    update_cache: true
    cache_valid_time: 3600

- name: Copy locale initialization script
  ansible.builtin.copy:
    src: ensure-en-us-utf8.sh
    dest: /usr/local/sbin/ensure-en-us-utf8
    owner: root
    group: root
    mode: '0755'

- name: Ensure system locale is en_US.UTF-8
  ansible.builtin.command: /usr/local/sbin/ensure-en-us-utf8
  register: locale_result
  changed_when: "'changed' in locale_result.stdout"

- name: Configure zram swap at 100 percent of physical memory
  ansible.builtin.copy:
    dest: /etc/systemd/zram-generator.conf
    owner: root
    group: root
    mode: '0644'
    content: |
      [zram0]
      zram-size = ram
      compression-algorithm = zstd
      swap-priority = 100
  notify: Zram reboot required
```

# `roles/network/handlers/main.yml`

```yaml
---
- name: Network reboot required
  ansible.builtin.debug:
    msg: >-
      Network configuration was staged on {{ inventory_hostname }}. The bond is
      configured for IEEE 802.3ad/LACP and requires a full system reboot to
      apply. Do not only restart systemd-networkd; reboot this host during a
      maintenance window after confirming console or fallback access.
```

# `roles/network/tasks/main.yml`

```yaml
---
- name: Prevent a newly installed iwd service from starting in this run
  ansible.builtin.systemd_service:
    name: iwd.service
    masked: true

- name: Install systemd-networkd prerequisites
  ansible.builtin.apt:
    name:
      - systemd
      - iproute2
      - iwd
    state: present

- name: Disable legacy wpa_supplicant services for the next boot
  ansible.builtin.systemd_service:
    name: "{{ item }}"
    enabled: false
    masked: true
  loop:
    - wpa_supplicant.service
    - wpa_supplicant@wlan0.service
  failed_when: false

- name: Remove legacy wlan0 wpa_supplicant configuration
  ansible.builtin.file:
    path: /etc/wpa_supplicant/wpa_supplicant-wlan0.conf
    state: absent

- name: Configure iwd to leave IP configuration to systemd-networkd
  ansible.builtin.copy:
    dest: /etc/iwd/main.conf
    owner: root
    group: root
    mode: '0644'
    content: |
      [General]
      EnableNetworkConfiguration=false
      UseDefaultInterface=true
  register: iwd_configuration

- name: Create iwd state directory
  ansible.builtin.file:
    path: /var/lib/iwd
    state: directory
    owner: root
    group: root
    mode: '0700'

- name: Install iwd known-network profile for the next boot
  ansible.builtin.template:
    src: iwd-network.psk.j2
    dest: "/var/lib/iwd/{{ wifi_iwd_profile_filename }}"
    owner: root
    group: root
    mode: '0600'
  no_log: true
  notify: Network reboot required

- name: Remove incorrectly encoded legacy iwd profile
  ansible.builtin.file:
    path: /var/lib/iwd/=e8=af=a5=e7=bd=91=e7=bb=9c=e4=b8=8d=e5=ae=89=e5=85=a8.psk
    state: absent
  no_log: true

- name: Create systemd-networkd configuration directory
  ansible.builtin.file:
    path: /etc/systemd/network
    state: directory
    owner: root
    group: root
    mode: '0755'

- name: Load Thunderbolt networking driver on future boots
  ansible.builtin.copy:
    dest: /etc/modules-load.d/thunderbolt-net.conf
    owner: root
    group: root
    mode: '0644'
    content: |
      # Thunderbolt/USB4 point-to-point networking
      thunderbolt_net
  notify: Network reboot required

- name: Detect Wi-Fi interfaces from gathered interface facts
  ansible.builtin.shell:
    cmd: |
      set -eu
      for iface in {{ ansible_facts.interfaces | map('quote') | join(' ') }}; do
        if [ -d "/sys/class/net/$iface/wireless" ]; then
          printf '%s\n' "$iface"
        fi
      done
    executable: /bin/sh
  register: wifi_detection
  changed_when: false

- name: Require exactly one Wi-Fi interface
  ansible.builtin.assert:
    that:
      - wifi_detection.stdout_lines | length == 1
    fail_msg: >-
      Expected exactly one Wi-Fi interface, detected:
      {{ wifi_detection.stdout_lines | join(', ') | default('none', true) }}.
      Interfaces seen: {{ ansible_facts.interfaces | join(', ') }}.

- name: Save Wi-Fi interface facts
  ansible.builtin.set_fact:
    wifi_interface: "{{ wifi_detection.stdout_lines[0] }}"
    wifi_mac: "{{ ansible_facts[wifi_detection.stdout_lines[0]].macaddress }}"

- name: Detect Thunderbolt network interface from gathered interface facts
  ansible.builtin.shell:
    cmd: |
      set -eu
      for iface in {{ ansible_facts.interfaces | map('quote') | join(' ') }}; do
        case "$iface" in
          lo|eno1|eno2|bond0|br0|wlan0|{{ second_nic_original_name }}|{{ wifi_interface }}) continue ;;
        esac
        device="/sys/class/net/$iface/device"
        [ -e "$device" ] || continue
        driver="$(basename "$(readlink -f "$device/driver")" 2>/dev/null || true)"
        path="$(readlink -f "$device" 2>/dev/null || true)"
        vendor="$(cat "$device/vendor" 2>/dev/null || true)"
        case "$iface:$driver:$path:$vendor" in
          *[Tt]hunderbolt*|*:thunderbolt-net:*|*:0x8086)
            printf '%s\n' "$iface"
            exit 0
            ;;
        esac
      done
      exit 1
    executable: /bin/sh
  register: thunderbolt_detection
  changed_when: false
  failed_when: false

- name: Report deferred Thunderbolt interface matching
  ansible.builtin.debug:
    msg: >-
      No active Thunderbolt network interface was detected on {{ inventory_hostname }}.
      A driver-based .link rule will rename it to tb0 when the device appears.
  when: thunderbolt_detection.rc != 0

- name: Save Thunderbolt interface facts
  ansible.builtin.set_fact:
    thunderbolt_interface: "{{ thunderbolt_detection.stdout | trim }}"
    thunderbolt_mac: >-
      {{ ansible_facts[thunderbolt_detection.stdout | trim].macaddress }}
  when: thunderbolt_detection.rc == 0

- name: Install systemd-networkd configuration
  ansible.builtin.template:
    src: "{{ item }}.j2"
    dest: "/etc/systemd/network/{{ item }}"
    owner: root
    group: root
    mode: '0644'
  loop:
    - 00-eno1.link
    - 00-eno2.link
    - 01-tb0.link
    - 02-wlan0.link
    - 10-bond0.netdev
    - 20-br0.netdev
    - 30-eno1.network
    - 30-eno2.network
    - 40-bond0.network
    - br0.network
    - tb0.network
    - wlan0.network
  notify: Network reboot required

- name: Remove superseded br0 network filename
  ansible.builtin.file:
    path: /etc/systemd/network/50-br0.network
    state: absent
  notify: Network reboot required

- name: Enable iwd for the next boot without starting it now
  ansible.builtin.systemd_service:
    name: iwd.service
    enabled: true
    masked: false

- name: Add deploy_user to netdev group for iwd management
  ansible.builtin.user:
    name: deploy_user
    groups: netdev
    append: true

- name: Replace legacy interfaces configuration for next boot
  ansible.builtin.copy:
    dest: /etc/network/interfaces
    owner: root
    group: root
    mode: '0644'
    backup: true
    content: |
      # Managed by Ansible. Networking is provided by systemd-networkd.
  notify: Network reboot required

- name: Disable legacy networking services without stopping current connection
  ansible.builtin.systemd_service:
    name: "{{ item }}"
    enabled: false
  loop:
    - networking.service
    - dhcpcd.service
  failed_when: false
  notify: Network reboot required

- name: Enable systemd-networkd for next boot without starting it now
  ansible.builtin.systemd_service:
    name: systemd-networkd.service
    enabled: true
  notify: Network reboot required
```

# `roles/network/templates/00-eno1.link.j2`

```ini
[Match]
OriginalName={{ first_nic_original_name }}
MACAddress={{ first_nic_mac }}

[Link]
Name=eno1
```

# `roles/network/templates/00-eno2.link.j2`

```ini
[Match]
OriginalName={{ second_nic_original_name }}
MACAddress={{ second_nic_mac }}

[Link]
Name=eno2

```

# `roles/network/templates/01-tb0.link.j2`

```ini
[Match]
{% if thunderbolt_mac is defined %}
MACAddress={{ thunderbolt_mac }}
{% else %}
Driver=thunderbolt-net
{% endif %}

[Link]
Name=tb0
```

# `roles/network/templates/02-wlan0.link.j2`

```ini
[Match]
MACAddress={{ wifi_mac }}

[Link]
Name=wlan0

```

# `roles/network/templates/10-bond0.netdev.j2`

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

# `roles/network/templates/20-br0.netdev.j2`

```ini
[NetDev]
Name=br0
Kind=bridge

[Bridge]
STP=true
ForwardDelaySec=4s

```

# `roles/network/templates/30-eno1.network.j2`

```ini
[Match]
Name=eno1

[Network]
Bond=bond0
LinkLocalAddressing=no

```

# `roles/network/templates/30-eno2.network.j2`

```ini
[Match]
Name=eno2

[Network]
Bond=bond0
LinkLocalAddressing=no

```

# `roles/network/templates/40-bond0.network.j2`

```ini
[Match]
Name=bond0

[Network]
Bridge=br0
LinkLocalAddressing=no

```

# `roles/network/templates/br0.network.j2`

```ini
[Match]
Name=br0

[Network]
Address={{ br0_address }}
Gateway={{ br0_gateway }}
{% for dns_server in br0_dns %}
DNS={{ dns_server }}
{% endfor %}
IPv6AcceptRA=yes
DHCP=ipv6
LinkLocalAddressing=ipv6

[DHCPv6]
UseAddress=no
UseDNS=yes
UseDomains=yes
UseDelegatedPrefix=no

[IPv6AcceptRA]
UseAutonomousPrefix=yes
UseOnLinkPrefix=yes
UseGateway=yes
UseDNS=yes
UseDomains=yes
```

# `roles/network/templates/iwd-network.psk.j2`

```ini
[Security]
Passphrase={{ wifi_password }}

[Settings]
AutoConnect=true
```

# `roles/network/templates/tb0.network.j2`

```ini
[Match]
Name=tb0

[Network]
Address={{ tb_ipv4_address }}
Address={{ tb_ipv6_address }}
DHCP=no
IPv6AcceptRA=no
LinkLocalAddressing=ipv6

# The peer management IPv4 route is more specific than br0's /24 route.
# It disappears with tb0, allowing automatic fallback through br0.
[Route]
Destination={{ tb_peer_management_ipv4 }}/32
Gateway={{ tb_peer_ipv4 }}
Metric=100

# Hostnames cannot be used as Destination= values. Resolve
# {{ tb_peer_hostname }} to {{ tb_peer_ipv6 }} to use this directly-connected ULA.
[Route]
Destination=fd00:db8:128::/64
Scope=link
Metric=100

```

# `roles/network/templates/wlan0.network.j2`

```ini
[Match]
Name=wlan0

[Link]
# Wi-Fi is only the fallback management path; never delay boot waiting for it.
RequiredForOnline=no

[Network]
DNS={{ br0_dns | join(' ') }}
IPv6AcceptRA=no
DHCP=no
LinkLocalAddressing=ipv6

[Address]
Address={{ wlan0_address }}
AddPrefixRoute=no

[Route]
Destination=192.0.2.0/24
Scope=link
Metric={{ wifi_route_metric }}

[Route]
Destination=0.0.0.0/0
Gateway={{ br0_gateway }}
Metric={{ wifi_route_metric }}
```

# `roles/packages/defaults/main.yml`

```yaml
---
griffo_repository_url: https://deb.griffo.io/apt
griffo_key_url: https://deb.griffo.io/EA0F721D231FDD3A0A17B9AC7808B4DD62C41256.asc
griffo_keyring_path: /etc/apt/keyrings/deb.griffo.io.gpg
nvim_appimage_version: 0.12.5
nvim_appimage_url: >-
  https://github.com/neovim/neovim/releases/download/v{{ nvim_appimage_version }}/nvim-linux-x86_64.appimage
nvim_appimage_path: /usr/local/bin/nvim
tailscale_install_script_url: https://tailscale.com/install.sh
tailscale_install_script_path: /usr/local/src/install-tailscale.sh
chezmoi_version: 2.72.1
chezmoi_deb_url: >-
  https://github.com/twpayne/chezmoi/releases/download/v{{ chezmoi_version }}/chezmoi_{{ chezmoi_version }}_linux_amd64.deb
chezmoi_deb_path: "/var/cache/apt/archives/chezmoi_{{ chezmoi_version }}_linux_amd64.deb"
impala_git_url: https://github.com/pythops/impala
impala_git_revision: 7587092ef84e3a9f59750e4adf0180301a53a77e
impala_install_root: /usr/local
rustup_init_url: https://sh.rustup.rs
rustup_init_path: /usr/local/src/rustup-init.sh
rustup_home: /opt/rustup
cargo_home: /opt/cargo
ddns_go_repository: https://github.com/Hyperbola-QAQ/ddns-go
ddns_go_path: /home/deploy_user/ddns-go
ddns_go_binary: /home/deploy_user/ddns-go/ddns-go

common_packages:
  - wget
  - curl
  - git
  - git-lfs
  - zsh
  - systemd-resolved
  - golang-go
  # Required to mount the Neovim AppImage on Debian 13.
  - fuse3
  - libfuse2t64
  - fd-find
  - bat
  - fzf
  - zoxide
  - build-essential
  - cloc
  - fastfetch
  - iperf3
  - bash-completion
  - bolt
  - btop
  - dnsutils
  - ethtool
  - htop
  - jq
  - lsof
  - net-tools
  - ncdu
  - openssh-client
  - rsync
  - pkg-config
  - picocom
  - socat
  - tcpdump
  - tmux
  - traceroute
  - tree
  - unzip
  - bridge-utils
  - cpu-checker
  - libvirt-clients
  - libvirt-daemon-driver-qemu
  - libvirt-daemon-system
  - ovmf
  - qemu-system-x86
  - qemu-utils
  - swtpm
  - virtinst
  - zip

package_exclusions: []

griffo_packages:
  - zig
  - ghostty
  - lazygit
  - yazi
  - viu
  - eza
  - uv
  - bun
  - tigerbeetle
  - deno
  - forgejo
  - forgejo-runner
  - helix
  - jujutsu
  - zellij
  - starship
  - atuin
  - k9s
  - headscale
  - garage
  - just
  - nushell
  - duckdb
  - herdr
  - ripgrep
  - fish
```

# `roles/packages/tasks/main.yml`

```yaml
---
- name: Configure APT network timeouts and retries
  ansible.builtin.copy:
    dest: /etc/apt/apt.conf.d/80ansible-network-timeouts
    owner: root
    group: root
    mode: '0644'
    content: |
      Acquire::Retries "5";
      Acquire::http::Timeout "30";
      Acquire::https::Timeout "30";

- name: Install APT repository prerequisites
  ansible.builtin.apt:
    name:
      - ca-certificates
      - curl
      - gnupg
    state: present
    update_cache: true
    cache_valid_time: 3600

- name: Install common system tools
  ansible.builtin.apt:
    name: "{{ common_packages | difference(package_exclusions | default([])) }}"
    state: present
    update_cache: true
    cache_valid_time: 3600

- name: Enable and start systemd-resolved
  ansible.builtin.systemd_service:
    name: systemd-resolved.service
    enabled: true
    state: started

- name: Link resolv.conf to systemd-resolved stub resolver
  ansible.builtin.file:
    src: /run/systemd/resolve/stub-resolv.conf
    dest: /etc/resolv.conf
    state: link
    force: true

- name: Install zsh
  ansible.builtin.apt:
    name: zsh
    state: present

- name: Set deploy_user login shell to zsh
  ansible.builtin.user:
    name: deploy_user
    shell: /bin/zsh

- name: Enable Git LFS for deploy_user
  ansible.builtin.command: git lfs install
  become: true
  become_user: deploy_user
  environment:
    HOME: /home/deploy_user
  changed_when: false

- name: Check whether Oh My Zsh is already installed for deploy_user
  ansible.builtin.stat:
    path: /home/deploy_user/.oh-my-zsh
  register: oh_my_zsh_directory

- name: Download Oh My Zsh installer
  ansible.builtin.get_url:
    url: https://gitee.com/pocmon/ohmyzsh/raw/master/tools/install.sh
    dest: /tmp/oh-my-zsh-install.sh
    owner: root
    group: root
    mode: '0755'
  when: not oh_my_zsh_directory.stat.exists

- name: Install Oh My Zsh for deploy_user on first deployment
  ansible.builtin.command: /tmp/oh-my-zsh-install.sh
  become: true
  become_user: deploy_user
  environment:
    HOME: /home/deploy_user
    SHELL: /bin/zsh
    RUNZSH: 'no'
    CHSH: 'no'
  when: not oh_my_zsh_directory.stat.exists

- name: Install zsh-autosuggestions plugin
  ansible.builtin.git:
    repo: https://gh.xmly.dev/https://github.com/zsh-users/zsh-autosuggestions
    dest: /home/deploy_user/.oh-my-zsh/custom/plugins/zsh-autosuggestions
    version: HEAD
    update: false
  become: true
  become_user: deploy_user

- name: Install fast-syntax-highlighting plugin
  ansible.builtin.git:
    repo: https://gh.xmly.dev/https://github.com/zdharma-continuum/fast-syntax-highlighting
    dest: /home/deploy_user/.oh-my-zsh/custom/plugins/fast-syntax-highlighting
    version: HEAD
    update: false
  become: true
  become_user: deploy_user

- name: Add deploy_user to libvirt and dialout groups
  ansible.builtin.user:
    name: deploy_user
    groups:
      - libvirt
      - dialout
    append: true

- name: Create deploy_user libvirt client configuration directory
  ansible.builtin.file:
    path: /home/deploy_user/.config/libvirt
    state: directory
    owner: deploy_user
    group: deploy_user
    mode: '0755'

- name: Default virsh to the system libvirt instance
  ansible.builtin.copy:
    dest: /home/deploy_user/.config/libvirt/libvirt.conf
    owner: deploy_user
    group: deploy_user
    mode: '0644'
    content: |
      # Managed by Ansible: use the host's system libvirt daemon by default.
      uri_default = "qemu:///system"

- name: Verify on-demand Thunderbolt device manager is available
  ansible.builtin.command: boltctl list
  changed_when: false
  when: not (skip_bolt | default(false))

- name: Enroll the configured Thunderbolt peer for automatic authorization
  ansible.builtin.command:
    argv:
      - boltctl
      - enroll
      - --policy
      - auto
      - "{{ thunderbolt_peer_uuid }}"
  when: not (skip_bolt | default(false)) and thunderbolt_peer_uuid | default('') | length > 0
  changed_when: true

- name: Verify amd64 binary architecture
  ansible.builtin.assert:
    that:
      - ansible_facts.architecture == 'x86_64'
    fail_msg: >-
      The configured Neovim and chezmoi artifacts only support x86_64, but this
      host reports {{ ansible_facts.architecture }}.

- name: Create APT keyring directory
  ansible.builtin.file:
    path: /etc/apt/keyrings
    state: directory
    owner: root
    group: root
    mode: '0755'

- name: Download deb.griffo.io signing key
  ansible.builtin.get_url:
    url: "{{ griffo_key_url }}"
    dest: /etc/apt/keyrings/deb.griffo.io.asc
    owner: root
    group: root
    mode: '0644'
  register: griffo_key_download

- name: Check whether deb.griffo.io binary keyring exists
  ansible.builtin.stat:
    path: "{{ griffo_keyring_path }}"
  register: griffo_keyring

- name: Convert deb.griffo.io signing key to GPG keyring
  ansible.builtin.command:
    argv:
      - gpg
      - --dearmor
      - --yes
      - --output
      - "{{ griffo_keyring_path }}"
      - /etc/apt/keyrings/deb.griffo.io.asc
  when: griffo_key_download.changed or not griffo_keyring.stat.exists
  register: griffo_key_conversion
  changed_when: griffo_key_conversion.rc == 0

- name: Set deb.griffo.io keyring permissions
  ansible.builtin.file:
    path: "{{ griffo_keyring_path }}"
    owner: root
    group: root
    mode: '0644'

- name: Configure deb.griffo.io APT repository
  ansible.builtin.copy:
    dest: /etc/apt/sources.list.d/deb.griffo.io.list
    owner: root
    group: root
    mode: '0644'
    content: >-
      deb [signed-by={{ griffo_keyring_path }}]
      {{ griffo_repository_url }} {{ ansible_facts.distribution_release }} main
  register: griffo_repository

- name: Refresh APT cache after repository changes
  ansible.builtin.apt:
    update_cache: true
  when: griffo_repository.changed

- name: Install requested packages
  ansible.builtin.apt:
    name: "{{ griffo_packages }}"
    state: present
    update_cache: true
    cache_valid_time: 3600

- name: Check whether Neovim AppImage is already installed
  ansible.builtin.stat:
    path: "{{ nvim_appimage_path }}"
  register: nvim_binary

- name: Install Neovim AppImage for LazyVim
  ansible.builtin.get_url:
    url: "{{ nvim_appimage_url }}"
    dest: "{{ nvim_appimage_path }}"
    owner: root
    group: root
    mode: '0755'
    timeout: 120
  register: nvim_download
  until: nvim_download is succeeded
  retries: 3
  delay: 5
  when: not nvim_binary.stat.exists

- name: Create local source directory
  ansible.builtin.file:
    path: /usr/local/src
    state: directory
    owner: root
    group: root
    mode: '0755'

- name: Download Tailscale installation script
  ansible.builtin.get_url:
    url: "{{ tailscale_install_script_url }}"
    dest: "{{ tailscale_install_script_path }}"
    owner: root
    group: root
    mode: '0755'

- name: Install Tailscale
  ansible.builtin.command:
    argv:
      - sh
      - "{{ tailscale_install_script_path }}"
    creates: /usr/bin/tailscale

- name: Enable and start Tailscale service
  ansible.builtin.systemd_service:
    name: tailscaled.service
    enabled: true
    state: started

- name: Check whether chezmoi package is already downloaded
  ansible.builtin.stat:
    path: "{{ chezmoi_deb_path }}"
  register: chezmoi_package

- name: Download chezmoi Debian package
  ansible.builtin.get_url:
    url: "{{ chezmoi_deb_url }}"
    dest: "{{ chezmoi_deb_path }}"
    owner: root
    group: root
    mode: '0644'
    timeout: 120
  register: chezmoi_download
  until: chezmoi_download is succeeded
  retries: 3
  delay: 5
  when: not chezmoi_package.stat.exists

- name: Install chezmoi Debian package
  ansible.builtin.apt:
    deb: "{{ chezmoi_deb_path }}"
    state: present

- name: Check whether deploy_user Chezmoi source is already initialized
  ansible.builtin.stat:
    path: /home/deploy_user/.local/share/chezmoi/.git
  register: chezmoi_source

- name: Initialize deploy_user Chezmoi source
  ansible.builtin.command:
    argv:
      - chezmoi
      - init
      - https://github.com/Hyperbola-QAQ/dotfiles.git
  become: true
  become_user: deploy_user
  environment:
    HOME: /home/deploy_user
  when: not chezmoi_source.stat.exists

- name: Update deploy_user Chezmoi source before applying dotfiles
  ansible.builtin.command: git pull --ff-only
  args:
    chdir: /home/deploy_user/.local/share/chezmoi
  become: true
  become_user: deploy_user
  environment:
    HOME: /home/deploy_user
  when: chezmoi_source.stat.exists

- name: Check whether LazyVim Starter configuration already exists
  ansible.builtin.stat:
    path: /home/deploy_user/.config/nvim
  register: lazyvim_configuration

- name: Clone LazyVim Starter before applying Chezmoi
  ansible.builtin.git:
    repo: https://github.com/LazyVim/starter
    dest: /home/deploy_user/.config/nvim
    depth: 1
    version: HEAD
    update: false
  become: true
  become_user: deploy_user
  when: not lazyvim_configuration.stat.exists
  register: lazyvim_starter_clone

- name: Remove LazyVim Starter Git metadata
  ansible.builtin.file:
    path: /home/deploy_user/.config/nvim/.git
    state: absent
  when: lazyvim_starter_clone is changed

- name: Apply deploy_user Chezmoi dotfiles
  ansible.builtin.command: chezmoi apply --force --no-tty
  become: true
  become_user: deploy_user
  environment:
    HOME: /home/deploy_user
  changed_when: false

- name: Clone Hyperbola DDNS-Go repository
  ansible.builtin.git:
    repo: "{{ ddns_go_repository }}"
    dest: "{{ ddns_go_path }}"
    version: HEAD
    update: false
  become: true
  become_user: deploy_user

- name: Update Hyperbola DDNS-Go source before building
  ansible.builtin.command: git pull --ff-only
  args:
    chdir: "{{ ddns_go_path }}"
  become: true
  become_user: deploy_user

- name: Build Hyperbola DDNS-Go
  ansible.builtin.command: make
  args:
    chdir: "{{ ddns_go_path }}"
    creates: "{{ ddns_go_binary }}"
  become: true
  become_user: deploy_user

- name: Create deploy_user user systemd unit directory
  ansible.builtin.file:
    path: /home/deploy_user/.config/systemd/user
    state: directory
    owner: deploy_user
    group: deploy_user
    mode: '0755'

- name: Install DDNS-Go user systemd service
  ansible.builtin.copy:
    dest: /home/deploy_user/.config/systemd/user/ddns-go.service
    owner: deploy_user
    group: deploy_user
    mode: '0644'
    content: |
      [Unit]
      Description=DDNS-Go Service (User Level)
      After=network-online.target nss-lookup.target
      Wants=network-online.target

      [Service]
      Type=simple
      ExecStart={{ ddns_go_binary }}
      Restart=on-failure
      RestartSec=10s
      StandardOutput=journal
      StandardError=journal
      SyslogIdentifier=ddns-go
      WorkingDirectory={{ ddns_go_path }}

      [Install]
      WantedBy=default.target

- name: Enable persistent user manager for deploy_user
  ansible.builtin.command: loginctl enable-linger deploy_user
  changed_when: false

- name: Reload deploy_user user systemd manager
  ansible.builtin.systemd_service:
    name: ddns-go.service
    scope: user
    daemon_reload: true
  become: true
  become_user: deploy_user
  environment:
    HOME: /home/deploy_user
    XDG_RUNTIME_DIR: /run/user/1000

- name: Enable and start DDNS-Go user service
  ansible.builtin.systemd_service:
    name: ddns-go.service
    scope: user
    enabled: true
    state: started
  become: true
  become_user: deploy_user
  environment:
    HOME: /home/deploy_user
    XDG_RUNTIME_DIR: /run/user/1000

- name: Create local source directory for installers
  ansible.builtin.file:
    path: /usr/local/src
    state: directory
    owner: root
    group: root
    mode: '0755'

- name: Check whether rustup installer is already downloaded
  ansible.builtin.stat:
    path: "{{ rustup_init_path }}"
  register: rustup_installer

- name: Download rustup installer
  ansible.builtin.get_url:
    url: "{{ rustup_init_url }}"
    dest: "{{ rustup_init_path }}"
    owner: root
    group: root
    mode: '0755'
    timeout: 120
  register: rustup_download
  until: rustup_download is succeeded
  retries: 3
  delay: 5
  when: not rustup_installer.stat.exists

- name: Install stable Rust and Cargo with rustup
  ansible.builtin.command:
    argv:
      - sh
      - "{{ rustup_init_path }}"
      - -y
      - --no-modify-path
      - --profile
      - minimal
      - --default-toolchain
      - stable
    creates: "{{ cargo_home }}/bin/cargo"
  environment:
    RUSTUP_HOME: "{{ rustup_home }}"
    CARGO_HOME: "{{ cargo_home }}"

- name: Expose Rust tools in /usr/local/bin
  ansible.builtin.file:
    src: "{{ cargo_home }}/bin/{{ item }}"
    dest: "/usr/local/bin/{{ item }}"
    state: link
    force: true
  loop:
    - cargo
    - rustc
    - rustup

- name: Build and install Impala from its Git repository
  ansible.builtin.command:
    argv:
      - "{{ cargo_home }}/bin/cargo"
      - install
      - --locked
      - --git
      - "{{ impala_git_url }}"
      - --rev
      - "{{ impala_git_revision }}"
      - --root
      - "{{ impala_install_root }}"
      - impala
    creates: "{{ impala_install_root }}/bin/impala"
  register: impala_install
  until: impala_install is succeeded
  retries: 3
  delay: 10
  environment:
    RUSTUP_HOME: "{{ rustup_home }}"
    CARGO_HOME: "{{ cargo_home }}"
    CARGO_NET_GIT_FETCH_WITH_CLI: 'true'
    CARGO_HTTP_TIMEOUT: '120'
  when: not (skip_impala | default(false))
```

# 部署后的验证

网络配置写入磁盘后，按计划手动重启。重启后分别检查：

```sh
networkctl status br0
networkctl status bond0
networkctl status wlan0
networkctl status tb0
ip -brief address
cat /proc/net/bonding/bond0
ip -4 route
ip -6 route
resolvectl status
iwctl station wlan0 show
```

检查软件和服务：

```sh
locale
zramctl
swapon --show
virsh list --all
git lfs env
chezmoi --version
systemctl --user status ddns-go
journalctl --user -u ddns-go -n 100 --no-pager
```

Tailscale 只安装并启动服务，不自动加入 tailnet；需要时再执行：

```sh
sudo tailscale up
```

# 总结

这类服务器初始化最重要的是把“通用软件安装”和“高风险网络切换”分开。Playbook 可以先通过稳定的 Wi-Fi 地址完成软件和配置落盘，network role 只负责准备下一次启动的 systemd-networkd 文件，最后再人工确认并重启。本文中的 AMD USB4 驱动尚不支持 Thunderbolt 网桥（XDomain），因此该问题截至发布时仍未解决，相关配置只能作为待验收实验项，不能误认为已经提供了可用的专线。
