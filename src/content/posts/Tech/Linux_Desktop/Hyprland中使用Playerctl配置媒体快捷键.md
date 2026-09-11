---
title: Hyprland 中使用 Playerctl 配置媒体快捷键
published: 2026-08-22
updated: 2026-08-22
pinned: false
description: 在 Hyprland 0.56.2 中使用 playerctl 控制 MPRIS 媒体播放器，并区分默认选择、精确指定与最近活动策略。
tags: [Linux, Desktop, Hyprland, Audio, MPRIS]
category: Desktop
author: Hyperbola
draft: false
---

# Hyprland 中使用 Playerctl 配置媒体快捷键

# 目标与环境

本文在 Hyprland `0.56.2` 与 `playerctl 2.4.1` 中配置媒体快捷键，目标是从窗口管理器直接控制支持 MPRIS 的播放器和浏览器媒体会话。`playerctl` 经由 D-Bus 控制 MPRIS 播放器；是否能控制某个网页视频，取决于浏览器及其媒体会话是否暴露 MPRIS，而不是 Hyprland 本身。

先安装并确认当前会话能发现播放器：

```bash
sudo pacman -S playerctl
playerctl --list-all
```

# 快捷键配置

以下示例适用于本文使用的 Omarchy Lua 配置接口。将模块保存为 `~/.config/hypr/apps/media.lua`，再由主配置加载。改动前请确认所选组合键没有被现有规则占用。

```lua
-- ~/.config/hypr/apps/media.lua
o.bind("CTRL + ALT + RIGHT", "下一曲", "playerctl next")
o.bind("CTRL + ALT + LEFT", "上一曲", "playerctl previous")
o.bind("CTRL + ALT + SPACE", "播放/暂停", "playerctl play-pause")

-- 这是当前播放器的内部音量，而非系统默认输出设备音量。
o.bind("CTRL + ALT + UP", "播放器音量增加", "playerctl volume 0.1+")
o.bind("CTRL + ALT + DOWN", "播放器音量降低", "playerctl volume 0.1-")
```

```lua
-- ~/.config/hypr/hyprland.lua
require("apps.media")
```

重载后依次播放音乐与浏览器视频，并按下绑定键验证：

```bash
hyprctl reload
playerctl --list-all
playerctl status
```

# 多播放器时的选择规则

直接执行 `playerctl next` 时，未指定播放器的默认目标是列表中的第一个可用播放器，不能假定它一定是最后播放或最后聚焦的窗口。需要稳定地控制某个播放器时，显式传入 `--player`：

```bash
playerctl --player=spotify next
playerctl --player=firefox play-pause
playerctl --all-players pause
```

实例名可通过 `playerctl --list-all` 取得，例如 `firefox.instance_1_60`。`--player=firefox` 可以匹配该类实例名，但浏览器重启、标签页或发行版补丁都可能改变实际名称，因此应以本机输出为准。

如果需要“最近活动的播放器”语义，应额外启动 `playerctld`：

```bash
playerctld daemon
playerctl --player=playerctld play-pause
```

`playerctld` 是一个单独的用户守护进程，负责跟踪可控播放器活动；它不是 `playerctl` 单次调用自动提供的行为。[playerctl 2.4.1 手册](https://manpages.debian.org/unstable/playerctl/playerctl.1.en.html)

# 系统音量与播放器音量

`playerctl volume` 调整的是 MPRIS 播放器暴露的音量。若需求是修改 PipeWire 的默认输出设备，应使用系统音频工具，例如：

```lua
o.bind("CTRL + ALT + UP", "系统音量增加", "wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%+")
o.bind("CTRL + ALT + DOWN", "系统音量降低", "wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-")
o.bind("CTRL + ALT + M", "系统静音", "wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle")
```

两类绑定使用同一按键会冲突，只保留其中一组。播放器没有实现音量属性时，`playerctl volume` 也可能失败；这时系统音量方案更符合预期。

# 常见问题与验证

`playerctl --list-all` 没有列出浏览器时，先确认浏览器正在实际播放媒体，再刷新页面并重新检查。浏览器或发行版是否启用 MPRIS 属于其自身实现差异，不能仅凭“Chrome/Firefox”名称作保证。

当多个音源同时存在，优先选择以下策略：固定目标用 `--player`；要全部暂停用 `--all-players`；确实需要按最近活动切换时部署 `playerctld` 并明确指定它。这样能避免快捷键偶尔控制到非预期播放器。

# 总结

Hyprland 只负责触发命令，媒体控制的关键在 MPRIS 发现与目标选择。先用 `--list-all` 看见什么，再决定是控制固定播放器、所有播放器，还是引入 `playerctld`；将这些模式区分开，配置的行为才是可预测的。
