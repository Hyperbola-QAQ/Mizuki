---
title: 解决 Fcitx5 在 XWayland 下缩放异常：设定X DPI
published: 2026-02-12
updated: 2026-02-12
pinned: false
description: 解决Fcitx5输入法在XWayland环境下出现缩放异常问题的方案，通过正确设定X DPI参数
tags:
  - Linux
  - Fcitx5
  - XWayland
  - DPI
  - 缩放问题
category: Linux桌面
author: Hyperbola
draft: false
series: Linux桌面问题解决
---
# 前言

> 本文适用于使用 **Hyprland / Sway 等 Wayland 合成器** 的用户，特别是遇到 **Fcitx5 候选窗在 XWayland 应用中太小、在原生 Wayland 中太大** 的问题。

---

# 🔍 问题简述

- **XWayland 应用**（如微信、Steam）中 Fcitx5 候选窗太小；
- **原生 Wayland 应用**中又太大；
- 根本原因：**XWayland 默认使用 96 DPI，而 Fcitx5 在 Wayland 下会自动按显示器 scale 放大 UI**。

---

# 解决方案：根据环境变量动态设置 DPI(以`GDK_SCALE`为例)

## 1. 安装 `xrdb`（如未安装）
```bash
sudo pacman -S --needed xorg-xrdb
```

## 2. 设置开机自动执行

###  **Hyprland**为例（在 `~/.config/hypr/hyprland.conf` 中）：
```ini
exec-once = dpi=$(awk "BEGIN {print (${GDK_SCALE:-1}) * 96}");echo "Xft.dpi: $dpi" | xrdb -merge
```

```ini
#如果使用的zsh的话
exec-once = dpi=$((${GDK_SCALE:-1} * 96)); echo "Xft.dpi: $dpi" | xrdb -merge
```

> 💡 说明：
> - `${GDK_SCALE:-1}` 表示：如果 `GDK_SCALE` 未设置，默认为 `1`；
> - 若你使用的是 2x 缩放屏幕，通常 `GDK_SCALE=2`，则 DPI = `2 × 96 = 192`；
> - 此命令**不依赖任何配置文件**，直接通过管道写入 X resource 数据库。

## 3. 重启 Fcitx5
```bash
fcitx5 -rd
```

---

# 🧪 验证是否生效

```bash
xrdb -query | grep Xft.dpi
```

应输出类似：
```
Xft.dpi: 192
```

同时确认你的显示器缩放因子（例如在 Hyprland 中）：
```bash
hyprctl monitors | grep scale
```

---

# ⚠️ 注意事项

- 如果你**没有设置 `GDK_SCALE`**，但实际使用了 2x 缩放，请确保在登录前或合成器配置中导出它：
  ```ini
  env = GDK_SCALE,2
  ```
  （Hyprland 示例；Sway 可在 `sway/config` 中用 `env GDK_SCALE=2`）

- `取消`原来对XWayland的缩放,因为设置DPI后会导致`双倍缩放`

  但是如果`QQ`使用了XWayland(这是解决复制问题),请保留缩放设置

  (因为QQ会发疯般的变大但是force-device-scale-factor参数可以覆盖DPI的设置有弥补了这一点)

  ```ini
  Exec=sh -c 'exec linuxqq --ozone-platform-hint=x11 --force-device-scale-factor="${GDK_SCALE:-1}" "$@"' sh %U
  ```

  ```ini
  exec-once = sh -c 'exec uwsm-app -- linuxqq --ozone-platform-hint=x11 --force-device-scale-factor="${GDK_SCALE:-1}"'
  ```

  ```ini
  Exec=env GDK_SCALE=1 SDL_VIDEODRIVER=x11 LANG=zh_CN.UTF-8 /usr/bin/steam %U
  ```

  

- `QT_SCALE_FACTOR` 不影响此设置，因为 `xrdb` 是 X11 层的标准，Qt/GTK 应用都会读:取 `Xft.dpi`。
