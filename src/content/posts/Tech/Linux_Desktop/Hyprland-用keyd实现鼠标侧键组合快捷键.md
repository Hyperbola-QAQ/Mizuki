---
title: Hyprland 用 keyd 实现鼠标侧键组合快捷键
published: 2026-10-30
updated: 2026-10-30
pinned: false
description: 在 Hyprland 0.57 与 Omarchy Lua 配置下，把鼠标侧键做成修饰键：为什么 F13 + mouse:272 同样非法，如何用 keyd 在 evdev 层改写成 F13/F14/F15，以及 code: 绑定与探测方法上的三个坑。
tags: [Linux, Desktop, Hyprland, keyd, Evdev]
category: Desktop
author: Hyperbola
draft: false
---

# Hyprland 用 keyd 实现鼠标侧键组合快捷键

# 目标与环境

目标是让鼠标侧键（`BTN_EXTRA`，Hyprland 里显示为 `mouse:276`）充当修饰键：侧键 + 左键快退，侧键 + 中键播放/暂停，侧键 + 右键快进，同时不破坏鼠标本身的移动、滚轮与三颗主键。

环境：Hyprland `0.57.0`，Omarchy 的 Lua 配置接口（`~/.config/hypr/*.lua`），keyd `2.6.0`，鼠标为 MCHOSE G3 V2（`3837:418c`）。

直接写 `o.bind("mouse:276 + mouse:272", …)` 会报：

```
External events cannot be combined with other keys
```

直觉上会以为「Hyprland 不支持鼠标键作修饰键，但键盘修饰键 + 鼠标键是可以的」，于是自然想到把侧键先映射成一个虚拟键盘键（F13），再写 `F13 + mouse:272`。**这一步在 0.57 上是错的**，也是本文花时间最多的地方。

# 为什么把侧键变成 F13 也没用

Hyprland `0.57` 重写了绑定解析，一个绑定被当成键序列处理。源码 `src/keybinds/Bind.cpp` 里的校验是：

```cpp
if (externalKeys > 1 || (externalKeys && ordinaryKeys))
    return std::unexpected("External events cannot be combined with other keys");
```

解析时，真正的修饰键（`SUPER`、`CTRL`、`ALT`、`SHIFT` 等）走 `modifierFromString` 进入 `modmask`，其余一律算作 `ordinaryKeys`；鼠标按键算 `externalKeys`。所以规则是：**鼠标事件只能单独成键，既不能和另一个鼠标事件组合，也不能和任何普通键组合**。`F13` 是 `ordinaryKeys`，一样被拒。

除了 `modmask` 里的修饰键，没有别的办法让「某个键 + 鼠标键」成立。这也意味着网上常见的「侧键改成 F13 然后绑 F13 + 鼠标」在 0.57 上不成立——它只在更早的版本或 X11 工具链里成立。

顺带确认过 F13 本身没有被占用：`hyprctl binds -j` 的 252 条绑定里没有任何 F13，用到的 F 键最高只到 F12，`~/.config` 也没有引用。也就是说 F13 是干净的，问题不在键位冲突。

# 正确的位置：evdev 层

既然 Hyprland 只接受单键绑定，那就让**组合逻辑发生在 Hyprland 之下**：按住侧键时，把左/中/右键在内核事件层改写成三个不同的普通键，Hyprland 只负责绑这三个单键。

keyd 常被当成纯键盘工具，实际 `2.6.0` 已经能管理鼠标：源码里定义了 `CAP_MOUSE`，虚拟指针设备带 `REL_X/Y/WHEEL/HWHEEL` 与 `BTN_LEFT..BTN_TASK`，即抓取鼠标后指针、滚轮、三颗主键仍能透传。官方文档把鼠标支持标为 experimental，主要限制是 `REL_WHEEL_HI_RES` 没有实现（高精度滚轮事件会被丢弃，多数鼠标同时发普通 `REL_WHEEL`，影响不大）。

`/etc/keyd/default.conf`：

```ini
[ids]
m:3837:418c

[main]
mouse2 = layer(mside)

[mside]
leftmouse   = f13
middlemouse = f14
rightmouse  = f15
```

几个要点：

- keyd 的命名反直觉：`mouse1` 是 `BTN_SIDE`（275，后退键），`mouse2` 才是 `BTN_EXTRA`（276，前进键）。
- `layer()` 不产生按键输出，所以侧键单独按下时什么也不做；按住期间进入 `mside` 层，层内未绑定的键（移动、滚轮）自动回落到 `[main]`。
- `[ids]` 必须精确到 `vid:pid`，不要用 `*`。这台机器上有三个设备都会发 `BTN_EXTRA`（鼠标本体、2.4G 接收器的 Mouse 接口、键盘的 Mouse 接口），通配会全部抓走。
- `m:` 前缀的真实判定是「设备具备相对轴能力」，而该鼠标的 Keyboard 节点也带 `REL=1040`，因此日志里会看到它把 Mouse / Keyboard / Consumer Control 三个节点一起抓了。功能上没有影响，但 keyd 的 `[ids]` 只能按 `vid:pid` 匹配，无法只挑其中一个节点。

改完用 `keyd check /etc/keyd/default.conf` 离线校验语法，再 `systemctl restart keyd`。

# 绑定的坑：必须用 code:

Hyprland 侧最终写成：

```lua
o.bind("code:191", "侧键+左键：快退 10 秒", "playerctl position 10-")
o.bind("code:192", "侧键+中键：播放/暂停", "playerctl play-pause")
o.bind("code:193", "侧键+右键：快进 10 秒", "playerctl position 10+")
```

这里有两个容易翻车的地方。

## code: 用的是 xkb keycode，不是 evdev 码

Hyprland 的 `code:` 前缀取的是 xkb keycode，等于 **evdev 码 + 8**。`F13`/`F14`/`F15` 的 evdev 码是 183/184/185，对应 `code:191`/`192`/`193`；同理 `KEY_GRAVE` 是 41，所以 grave 键要写 `code:49`。

## 同一颗键上不要同时挂名字绑定和键码绑定

先写了 `o.bind("F13", …)`，又想稳妥补一条 `o.bind("code:191", …)`。结果两个都不触发，`hyprctl binds -j` 里两条都在列表里，日志却永远是空的。只保留 `code:` 那一条之后立刻生效。

这套环境对 keysym 名字本来就不太友好（配置里早已有「`grave` 没注册生效、改用 `code:49`」的先例），遇到可疑的键位直接上 `code:` 是最省事的做法。

# 探测方法：怎么确认问题出在哪一段

这类问题横跨核心、守护进程、合成器三层，靠猜会绕很久。可以用两个不依赖额外工具的观测点。

## keyd 侧

```bash
sudo keyd monitor
```

按组合键时应看到：

```
keyd virtual keyboard   0fac:0ade:bea394c0      f13 down
keyd virtual keyboard   0fac:0ade:bea394c0      f13 up
keyd virtual pointer    0fac:1ade:d2b36ae6      leftmouse
```

`monitor` 打印的是 keyd 内部键名，但 keyd 内部编号 `KEYD_F13 = 183` 恰好就是 evdev 的 `KEY_F13`，所以看到 `f13` 基本可以认为线路上发的就是标准 F13。单独点左键时出现 `leftmouse`，说明未参与组合的点击仍然透传给虚拟指针。

## Hyprland 侧

把绑定临时换成探针，直接看它有没有被触发：

```lua
o.bind("code:191", "probe", "echo probe-f13 >> $HOME/probe.log; hyprctl notify 1 4000 0 \"F13 ok\"")
```

这台机器没有通知守护进程（`mako`/`swaync`/`dunst` 都没运行），`notify-send` 弹不出来，用 Hyprland 自带的 `hyprctl notify` 更可靠。另外 `hyprctl keyword bind …` 在 0.57 的 Lua 配置模式下会返回 `unknown request`，想改绑定只能改文件再 `hyprctl reload`。

## 探针本身的两个陷阱

- **命令顺序**：`playerctl previous; echo …` 这种串行写法里，只要 `playerctl` 卡在 D-Bus 上，后面的 `echo` 就永远不执行，日志为空会被误读成「键没到」。探针要把写日志放在最前面，或者干脆只写日志。
- **对照项**：同时绑一个普通键（例如 F11）做对照，能立刻区分「探测链路不通」和「这颗键没到」。

# 需求语义：快进快退不等于上一首下一首

这条坑是需求层面的。最初的绑定用了 `playerctl previous` / `next`，实测在 Firefox 上是 **no-op**：退出码 0，播放位置不动（从 108 秒读到 116 秒只是自然播放）。

区分两类语义：

- **上/下一首**：`playerctl previous` / `next`，需要播放器有播放列表概念，单视频页面上没有意义。
- **位置跳转**：`playerctl position 10-` / `10+`，对浏览器视频有效。实测 5s → 11s → 7s，方向正确；读数的 1~2 秒抖动来自 Firefox 的 MPRIS 位置上报延迟，不是跳转失败。

如果目标只是「看视频时拖进度」，就别用 `previous`/`next`。

# 最终状态与回滚

```ini
# /etc/keyd/default.conf
[ids]
m:3837:418c

[main]
mouse2 = layer(mside)

[mside]
leftmouse   = f13
middlemouse = f14
rightmouse  = f15
```

```lua
-- ~/.config/hypr/bindings.lua
o.bind("code:191", "侧键+左键：快退 10 秒", "playerctl position 10-")
o.bind("code:192", "侧键+中键：播放/暂停", "playerctl play-pause")
o.bind("code:193", "侧键+右键：快进 10 秒", "playerctl position 10+")
```

验证要点：`hyprctl configerrors` 为空；`hyprctl binds -j` 中三条绑定的 `keycode` 为 191/192/193 且 `modmask` 为 0。

回滚只需一条命令：

```bash
sudo systemctl disable --now keyd
```

因为只抓了鼠标、没有抓任何键盘，即使 keyd 出问题也能用键盘操作；服务一停，`EVIOCGRAB` 随进程退出释放，侧键立刻恢复原来的「前进」功能，Hyprland 里那三条绑定变成死键，无副作用。

代价是侧键失去了浏览器前进功能——把一颗键改作修饰键，这几乎是必然的取舍。不建议「同时输出 `BTN_EXTRA` 和 F13」，那样每次按侧键都会真的前进一步。

# 总结

三条结论：

1. Hyprland 0.57 里**鼠标事件不能与任何非修饰键组合**，把侧键转成 F13 并不能绕开这条限制；可行的形态是「evdev 层改写 + Hyprland 绑单键」。
2. keyd 2.6.0 能管鼠标：`layer()` 挂在鼠标键上可用，指针与滚轮照常透传，代价是高精度滚轮事件不转发。
3. Hyprland 侧用 `code:191/192/193`（evdev + 8），并且不要在同一颗键上同时挂名字绑定和键码绑定——两者会互相顶掉。

排障顺序应该是自下而上：先看 `keyd monitor` 有没有输出目标键，再看 Hyprland 的探针有没有被触发，最后才怀疑命令本身。这次绕的最大一圈，恰恰是最后一步——`playerctl previous` 在 Firefox 上「成功但什么也没做」，看起来和绑定失效一模一样。
