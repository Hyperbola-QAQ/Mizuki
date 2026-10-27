---
title: Hyprland 下的原神体验改善：薇斯纳空中回体力与 BetterGI 鼠标越界排障
published: 2026-10-27
updated: 2026-10-27
pinned: false
description: 在 Omarchy、Hyprland 与 DWProton 环境中验证低帧率触发薇斯纳空中回体力，记录限帧切换、Lua 配置和 BetterGI 遮罩导致的鼠标越界；越界问题尚未彻底解决。
image: "https://upload-bbs.miyoushe.com/upload/2026/10/22/291110358/dfa6368d10bca0336eec4ba9d8f45678_8134309817149677466.jpg?x-oss-process=image//resize,s_600/quality,q_80/auto-orient,0/interlace,1/format,jpg"
tags: [Linux, Omarchy, Hyprland, Wine, 原神, BetterGI, MangoHud]
category: Desktop
author: Hyperbola
draft: false
---

# 限帧可用，鼠标越界没有彻底解决

这次折腾最初只是想控制原神的“后台模式”：切走工作区时可以继续正常渲染，游戏仍显示在屏幕上时又能用快捷键主动降低帧率。

具体利用的是**薇斯纳在空中回复体力的低帧率特性**。最初以为必须让游戏进入后台，后来通过对照实验发现，在这套环境里，不隐藏游戏、只把帧率限制到足够低，也能触发。

限帧切换最终保留了下来，Win + F9 和鼠标后退侧键共用一个处理函数，在 1 FPS 与正常帧率之间切换。鼠标问题则没有得到完整修复：BetterGI 遮罩开关或切屏后，鼠标仍可能越过主屏进入右侧副屏。

**最终退回的是“允许指针越界，但尽量让键盘和鼠标按键继续作用于原神”的缓解配置。它不是鼠标捕获问题的根治方案。** 最后一次回滚时游戏已经退出，规则通过了配置检查，但重新启动游戏后的效果还需要继续验证。

# 环境与最初现象

排查时记录的环境如下，结论首先适用于这组版本与显示器拓扑。

| 项目 | 实际环境 |
| --- | --- |
| 桌面 | Omarchy、Hyprland 0.56.2，使用 Lua 配置 |
| 运行器 | DWProton 11.0-15 |
| 窗口协议 | 原神与 BetterGI 通过 XWayland 运行 |
| XWayland | 24.1.14-1 |
| 限帧工具 | MangoHud 0.8.4 |
| 显示器 | 主屏在左，副屏在右 |
| 缩放 | 主屏约 1.6667 倍，副屏 1 倍；启用 XWayland 零缩放选项 |
| 游戏窗口 | `class = "steam_proton"`，标题为 `原神` |
| 遮罩窗口 | 同一 class，标题为 `MaskWindow` |

主屏显示原神时，把焦点移到副屏聊天，并不会触发最初观察到的后台特性。必须把**原神所在的主屏切到另一个工作区**，效果才会出现。

这已经说明，不能把“失去焦点”和“窗口不再显示”混为一谈。副屏获得焦点时，原神仍然显示在主屏；切走主屏工作区后，原神才真正不可见。

# 从“后台特性”定位到低帧率

已有的操作经验是：手机上可以通过返回键卡出空中回体力的效果；Windows 上常见的操作是切到窗口模式，再右键窗口标题栏，利用窗口菜单期间的停顿获得类似效果。

这些是寻找触发条件的背景。本文没有对手机和 Windows 的进程、线程做跟踪，因此不把这些现象一概表述为“整个游戏进程被暂停”。本次新增的实测结果是：**Linux 下不必依赖这些操作，只锁帧率也可以触发薇斯纳的空中回体力。**

实验分两步进行。

**第一步：只改变隐藏窗口的渲染频率。**

为原神开启 `render_unfocused`，让窗口不可见时仍继续渲染，再通过 `misc.render_unfocused_fps` 调整后台渲染上限。Hyprland 对这两个设置的定义分别见[窗口规则](https://wiki.hypr.land/Configuring/Basics/Window-Rules/)和[配置选项](https://wiki.hypr.land/configuring/core/config-options/)。

| 条件 | 实测结果 |
| --- | --- |
| 原神仍显示在主屏，只把焦点移到副屏 | 不触发最初观察到的特性 |
| 切走主屏工作区，隐藏时继续以最高 60 FPS 渲染 | 特性不触发 |
| 同样隐藏，但把后台上限降到 1 FPS | 特性触发 |

**第二步：不隐藏窗口，直接限制游戏渲染帧率。**

Hyprland 的后台渲染参数并不是可见窗口的通用单独限帧器，因此改用已经加载到游戏中的 MangoHud。

| MangoHud 限制 | 实测结果 |
| --- | --- |
| 1 FPS | 画面可见时也能触发，效果与 Hyprland 隐藏时限制到 1 FPS 接近 |
| 2 FPS | 有效果，但弱于 1 FPS |
| 4 FPS | 做过配置试验，没有得到足以单列结论的效果反馈 |
| 10 FPS | 确认无法触发目标效果 |

最终恢复到 1 FPS。1 FPS 与 2 FPS 的帧间隔分别约为 1000 ms 和 500 ms，差异足以影响某些按帧推进、计时或状态检查逻辑。

不过，**这些实验只能证明效果与极低帧率密切相关，不能证明游戏全部逻辑都与渲染同步，也不能直接把原因定为“逻辑帧率和渲染帧率冲突”**。具体是哪一段体力、动作或空中状态逻辑受到影响，仍未通过游戏内部实现验证。

# 限帧切换踩过的坑

MangoHud 支持按应用配置。Wine 应用的文件名使用 `wine-程序名.conf`，不带 `.exe` 后缀，因此原神使用：

```text
~/.config/MangoHud/wine-YuanShen.conf
```

配置格式和优先级可以参考 [MangoHud 官方说明](https://github.com/flightlessmango/MangoHud#hud-configuration)。本机最终使用的关键配置是：

```ini
# 0 表示不施加 MangoHud 的帧率上限，仍保留游戏自身的限制。
fps_limit=0
show_fps_limit
reload_cfg=F11
```

切换脚本修改 `fps_limit`，然后触发重载。这里不是把环境变量写入已经运行的游戏进程，也没有重启游戏。

最初尝试过 MangoHud 的左 Shift + F1 切换，以及通过 Hyprland 转发瞬时重载按键，但没有可靠生效。排查时一度只看见命令返回 `ok`，就误以为配置已经加载，这是整个过程里应该纠正的一点：**按键发送成功与游戏实际限帧，是两个验证目标。**

后续通过截图检查 HUD，才确认限制为 1 FPS 时出现约 1000 ms 的帧时间，恢复正常后回到约 99 FPS。`FPS limit` 字段与实际帧率也要区分，统计值可能需要经过后续几帧才刷新。

还尝试过 `mangohudctl set reload_config true`。当时曾把随后出现的限帧效果归因于它，但后续检查发现消息没有被当前游戏可靠消费；同期还做了原生按键重载，不能把成功单独归功于这条命令。最终没有把它留在切换脚本中。

**为什么最初会“卡手”？**

早期重载组合键设成了 Ctrl + Shift + F11，脚本会模拟按住这组键约 1.2 秒。它与用户真正按着的修饰键存在冲突风险，连续触发时还可能重叠。后来做了几项调整：

- 重载改成单独的 F11，不再模拟 Ctrl、Shift。
- 快捷键在松开后触发。
- 用 `flock` 防止两次切换并发执行。
- 先确认原神窗口存在，再执行切换。

仍保留约 1.2 秒的按键保持时间，是因为 MangoHud 这个版本在渲染路径中轮询按键，1 FPS 时短促按键可能落在两个检查点之间。这是当前脚本的局限，**不能把它宣传成瞬时、完全顺滑的切换实现**。它也依赖 F11 仍被保留为 MangoHud 的重载键。

本机的实现拆成三个职责，而不是让 Lua 回调等待外部命令：

| 文件 | 职责 |
| --- | --- |
| `~/.config/hypr/apps/genshin_impact.lua` | 窗口规则与快捷键入口 |
| `~/.config/hypr/apps/genshin-toggle-fps.sh` | 查找游戏、串行切换 `fps_limit=0/1` |
| `~/.config/hypr/apps/genshin-reload-fps.py` | 通过 XTest 短期保持并释放 F11 |

Python 脚本使用 `ctypes` 调用系统已有的 `libX11` 与 `libXtst`，在 `finally` 中释放按键。它是按键模拟，不是向游戏注入代码。普通游戏操作不应依赖这个脚本；它只负责限帧配置重载。

# BetterGI 遮罩引出的鼠标越界

限帧问题之外，又遇到了一个独立问题：**正常帧率下，向左转视角正常，向右靠近副屏方向转动时会出现越界或不顺滑。**

稳定复现的操作有两种：

1. 开关 BetterGI 遮罩后，向右转动视角，鼠标可能进入副屏。
2. 遮罩开启时，切屏再切回原神，随后向右转动也可能出现同样问题。

最初给遮罩设置 `no_focus`、`no_follow_mouse` 等规则，阻止它获取焦点，再给原神加 `confine_pointer`，让指针留在游戏区域。这样确实阻止了跨屏，但右转变得“卡手”。

撤掉 `confine_pointer` 后，转动恢复顺滑，鼠标又可以越界。这说明**把指针硬限制在窗口边界，不等于恢复游戏原来的鼠标捕获方式**。

后续使用仅在原神已聚焦时匹配的 `stay_focused`，取得了部分进展：鼠标仍可能跑到副屏，但键盘、鼠标按键继续作用于原神。主动切到其他应用时，这条规则会解除。它保住的是输入焦点，而不是指针捕获。

# 从窗口属性查到 Wine 的 ClipCursor

`hyprctl clients -j` 能看到窗口标题、class、焦点等信息，但不能仅凭其中的 `acceptsInput` 判断透明遮罩有没有实际截获鼠标。

为了确认这一点，编写了临时 Python 脚本，通过 `ctypes` 调用 X11 Shape 接口。读到 `MaskWindow` 的输入区域为空，表明它在 X11 层已经配置了鼠标透传。于是“遮罩没有做透传”这个初始怀疑不能继续当作结论。

接下来需要区分三个状态：

```text
Hyprland 窗口焦点
        ↓
Wine / Win32 的鼠标限制状态（GetClipCursor）
        ↓
X11 抓取请求及 XWayland 对指针约束的实现
```

这里的箭头只表示排查涉及的层次，不表示三者是一条单向、没有反馈的调用链。

**X11 请求跟踪。**

临时 Python 脚本使用 `libX11`、`libXtst` 提供的 RECORD 扩展，观察 `GrabPointer`、`UngrabPointer`、`WarpPointer` 请求，并增加抓取返回值和限制窗口几何信息。跟踪在 `/tmp` 下通过独立 tmux 会话运行，设置超时结束，没有安装常驻服务。

日志中，正常状态下会出现位于游戏中心、大小为 1×1 的抓取窗口，抓取请求返回成功。故障相关操作中可以观察到释放抓取的请求，Alt 恢复后中心抓取重新出现。由于多个操作相邻发生，单靠请求序列仍不足以断言具体是哪一段应用代码主动清除了限制。

**直接读取 Windows 侧状态。**

又用本机编译器生成了一个临时 PE 小程序，在同一 DWProton、同一 Wine prefix 中调用 `GetClipCursor`，读取前台窗口和遮罩样式。它没有显示窗口，也没有附加调试器或向游戏注入代码。

读到的关键输出经过删去进程号、窗口句柄后如下：

```text
正常：clip=1280,720,1280,720
故障：clip=0,0,4480,1440
```

正常时限制在游戏中心点，X11 侧对应 1×1 的抓取窗口；故障时限制区域变成整个双屏桌面。同时，原神在 Hyprland 和 Wine 两边都仍是前台窗口。

这比“感觉失焦了”更具体：**在已经捕捉到的故障现场，Wine 的逻辑鼠标限制确实被清掉了。** 因此不能简单归因于 Hyprland 拒绝了一条正常的限制请求，也没有证据把它定为主副屏缩放不一致导致的坐标错误。

但这仍不是完整根因。究竟是 BetterGI 的显示、隐藏、置顶行为触发了 Wine 的某条状态转换，还是运行器与窗口管理交互存在缺陷，还需要更精确的调用链证据。`GetClipCursor` 的结果本身不提供清除者的身份。

关于 API 语义，微软的 [ClipCursor 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-clipcursor)说明它限制屏幕上的鼠标移动区域；这与改变窗口焦点是不同操作。

# 尝试过但没有保留的修复

下面这些实验很容易被整理成“最终解决方案”，但实际结果不支持这么写。

| 尝试 | 结果与取舍 |
| --- | --- |
| 强制限制原神指针边界 | 阻止越界，但右转卡顿；撤回 |
| 关闭鼠标经过窗口时自动切焦点 | 没有解决指针越界；全局设置已恢复 |
| 让原神真正失焦再重新聚焦 | 未恢复目标捕获状态 |
| 短按并松开左 Alt | 用户验证能恢复，但只是触发游戏自身重建捕获 |
| 自动在聚焦、遮罩开关后模拟 Alt | 做过实现，随后撤回；没有把补偿当成根治 |
| 直接调用 Windows `ClipCursor` 恢复中心限制 | API 返回成功且读回状态恢复；遮罩再次切换后仍可能失效 |
| 给遮罩添加 `WS_EX_NOACTIVATE` | 一轮切屏验证正常，遮罩开关仍失败；不能推导为完整修复 |
| 把遮罩实际挂为原神子窗口 | 遮罩不再显示，立即还原 |
| 去掉 `WS_CHILD`，改为独立不激活弹窗 | 截图确认遮罩仍显示，但没有获得完整成功验证；最后也按回滚要求还原 |

临时查询还发现，遮罩带有 `WS_CHILD` 样式，实际父窗口却是 Wine 桌面。这个组合值得继续研究，但把它直接改成游戏子窗口造成了可见的显示退化，因此不能只因鼠标状态看起来更好就保留。

所有改变父窗口、Windows 样式的实验都没有做成持久配置。停止排查时，遮罩的原始父窗口与样式已经恢复，临时跟踪也已停止。

# 最终保留的 Lua 配置

下面是回滚后保留的配置。它放在用户目录，由本机主配置加载；不是修改 Omarchy 的系统默认文件。

```text
~/.config/hypr/apps/genshin_impact.lua
```

这是针对本机窗口标题、class 和 Omarchy `o.bind` 辅助函数的示例。直接使用 Hyprland 的环境需要改用自己的加载方式或 `hl.bind`，不能假设存在 `o`。

```lua
local toggle_fps_command = "/bin/bash " .. os.getenv("HOME") .. "/.config/hypr/apps/genshin-toggle-fps.sh"

hl.window_rule({
  match = {
    class = "steam_proton",
    title = "原神",
  },
  no_dim = true,
  render_unfocused = true,
})

-- 只在原神已经获得焦点时保持输入，不裁剪指针坐标。
hl.window_rule({
  match = {
    class = "steam_proton",
    title = "原神",
    focus = true,
  },
  stay_focused = true,
})

hl.config({ misc = { render_unfocused_fps = 30 } })

hl.window_rule({
  match = {
    class = "steam_proton",
    title = "MaskWindow",
  },
  no_focus = true,
  no_follow_mouse = true,
  focus_on_activate = false,
})

local function toggle_fps()
  local window = hl.get_active_window()
  if window and window.class == "steam_proton" and (window.title == "原神" or window.title == "MaskWindow") then
    hl.dispatch(hl.dsp.exec_cmd(toggle_fps_command))
    return { ok = true }
  else
    return { ok = false }
  end
end

for _, keys in ipairs({ "SUPER + F9", "mouse:275" }) do
  o.bind(keys, "原神：切换 1 FPS / 正常帧率", toggle_fps, { release = true, auto_consuming = true })
end
```

这里仍然会注册两个输入入口，这是为了让键盘和侧键都可用；统一的是处理函数和注册代码，不是把两个实际按键变成一个绑定。侧键只在匹配到游戏窗口时消费，其他应用保留原有后退行为。`mouse:275` 是本机的后退侧键编号，其他硬件应检查实际事件。

后台上限在最初对照实验中使用的是 60 FPS，最终文件保留为 30 FPS。不能把“60 FPS 下未触发特性”的实验结果无条件外推到所有后台帧率与场景；这个参数还会影响其他启用了 `render_unfocused` 的隐藏窗口。

当前配置有意不包含 `confine_pointer`，也没有自动 Alt、自动 `ClipCursor` 或循环回中逻辑。

修改前先备份涉及的用户文件，修改后执行：

```bash
hyprctl reload
hyprctl configerrors
```

这会重载当前桌面配置。配置检查通过只说明加载没有报告错误，仍需要在实际游戏内验证左右转动、遮罩开关、切屏以及限帧恢复。回滚时恢复自己修改前的文件并再次重载，不要直接重置整套用户配置。

# 从 .conf 转向 .lua，是极其好的设计

经历这次排查，我认为 **Hyprland 把配置从 `.conf` 转向 `.lua`，是一个极其好的设计**。

更准确地说，旧 `.conf` 使用的是 Hyprlang；官方文档说明，从 Hyprland 0.55 起，Hyprlang 被弃用并转向 Lua。这里讨论的不是改了文件扩展名，而是配置表达能力的变化。

这次最直接的收益有三个。

**第一，重复配置可以真正抽象。** Win + F9 与鼠标侧键共用处理函数、命令变量和注册循环。修复一次条件判断，就能同时作用于两个入口，而不是靠复制粘贴保持一致。

**第二，条件可以在触发时判断。** 使用 `hl.get_active_window()` 检查当前窗口，再决定执行命令还是把按键交回应用。相比拼接一层层 shell 分支，行为更容易读清楚，也更容易核对绑定数量。

**第三，规则和自动化能在同一种语言里组织。** 焦点条件、事件回调、定时器可以放在一致的配置结构中。虽然这次的自动 Alt 补偿最终撤掉了，但它的触发条件与去重逻辑仍然可以直接表达，不必为一次桌面事件启动一个常驻轮询服务。

Lua 也不会自动消除坏设计。最初重复定义入口、不断叠加补丁的做法仍然很差；把阻塞操作搬进 Lua 回调还可能影响合成器响应。因此限帧脚本通过 `hl.dsp.exec_cmd` 异步执行，Lua 只负责判断和派发，不在桌面事件回调里等待 1.2 秒。

更好的配置语言让逻辑更容易表达、复用与检查，但它不能替 Wine 或游戏内部修复一个已经被清除的捕获状态。

# 这次排查留下的边界

可以确认的是：本机通过极低渲染帧率触发了薇斯纳空中回体力，隐藏工作区与可见窗口的 1 FPS 效果接近；无需把“进入后台”当成唯一条件。

可以保留的是：MangoHud 的 1 FPS 切换，以及 Hyprland 中按当前焦点匹配的输入保持规则。

**尚未解决的是 BetterGI 遮罩相关的鼠标越界。** 已观察到 Wine 的限制区域从中心点变成整个桌面，但还没有定位到能够稳定阻止这次状态丢失的修复。最终配置只是保住输入焦点，不能保证指针不进入副屏，也不能保证所有窗口切换路径都完全一致。

这篇记录因此是一份有明确回滚结果的排障复盘，而不是“彻底解决原神双屏鼠标问题”的教程。后续继续排查时，应该沿着 BetterGI 的遮罩显示、隐藏与置顶行为，以及 Wine 的捕获状态转换深入，而不是继续叠加边界限制来掩盖问题。
