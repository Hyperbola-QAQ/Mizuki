---
title: Hyprland 中屏蔽 xfreerdp 全局快捷键
published: 2026-08-23
updated: 2026-08-23
pinned: false
description: 在 Hyprland 0.56.2 的 Lua 配置中，按活动 xfreerdp 窗口切换 Submap，以避免全局快捷键干扰远程桌面。
tags: [Linux, Desktop, Hyprland, Remote Desktop, xfreerdp]
category: Desktop
author: Hyperbola
draft: false
---

# Hyprland 中屏蔽 xfreerdp 全局快捷键

# 场景与边界

使用 `xfreerdp` 时，`SUPER + 数字` 等组合键可能先被 Hyprland 捕获，导致远程桌面无法收到按键。本文的目标是：活动窗口为 `xfreerdp` 时进入一个专用 Submap，从而屏蔽普通全局绑定；离开窗口时恢复默认键位；并保留一个始终可用的切换键作为逃生出口。

配置在 Hyprland `0.56.2` 的 Lua 配置接口中验证。Lua API、窗口 class 和事件名都可能随版本或客户端包装方式而变化，部署前应先检查实际窗口信息。

# 确认窗口识别条件

使远程桌面窗口获得焦点后执行：

```bash
hyprctl activewindow -j | jq '{class, title}'
```

本文用 `win.class == "xfreerdp"` 匹配。如果输出不同，应替换成真实 class；不要仅凭窗口标题匹配，标题会随远程主机或会话变化。

# 配置实现

Submap 内需要至少一个绑定才能注册。`CTRL + ALT + ESCAPE` 同时作为全局、通用的切换键：当进入屏蔽模式时它仍可工作，避免把自己锁在空 Submap 中。

```lua
-- ~/.config/hypr/apps/xfreerdp.lua
local blocked = false

hl.define_submap("xfreerdp_block", function()
    -- 占位绑定使 submap 被注册；实际切换由 universal 绑定处理。
    hl.bind("CTRL + ALT + ESCAPE", function() end)
end)

local function update_xfreerdp_submap()
    local win = hl.get_active_window()
    local is_xfreerdp = win and win.class == "xfreerdp"

    if is_xfreerdp and not blocked then
        hl.dispatch(hl.dsp.submap("xfreerdp_block"))
        blocked = true
    elseif not is_xfreerdp then
        hl.dispatch(hl.dsp.submap("reset"))
        blocked = false
    end
end

hl.on("window.active", update_xfreerdp_submap)
update_xfreerdp_submap()

hl.bind("CTRL + ALT + ESCAPE", function()
    local win = hl.get_active_window()
    if not win or win.class ~= "xfreerdp" then
        return
    end

    if blocked then
        hl.dispatch(hl.dsp.submap("reset"))
    else
        hl.dispatch(hl.dsp.submap("xfreerdp_block"))
    end
    blocked = not blocked
end, { submap_universal = true })
```

在主配置加载模块：

```lua
-- ~/.config/hypr/hyprland.lua
require("apps.xfreerdp")
```

# 工作流程

```text
xfreerdp 获得焦点 → 进入 xfreerdp_block → 普通全局绑定失效
CTRL + ALT + ESCAPE → 切换 reset / xfreerdp_block
焦点离开 xfreerdp → reset → 默认绑定恢复
```

这里的 `blocked` 只是配置进程内的状态。调用 `update_xfreerdp_submap()` 的初始检查很重要：重载配置时若焦点已经在远程桌面窗口，状态也应立即同步。

# 验证与恢复

先重载配置：

```bash
hyprctl reload
```

随后验证四件事：进入 `xfreerdp` 后，`SUPER + 数字` 不再切换 Hyprland 工作区；按 `CTRL + ALT + ESCAPE` 后该行为恢复；再次按下后重新屏蔽；切换到其他窗口后默认快捷键自动恢复。

若重载后提示 Submap 不存在，检查定义中是否留有至少一个绑定、模块是否被 `require`。若无法触发切换键，优先在普通窗口确认该组合键未被其他配置覆盖，并检查本版本是否支持 `submap_universal`。修改配置前保留可用副本；无法恢复时可从 TTY 或备用会话移除该模块引用后再重载。

# 总结

这个方案把快捷键屏蔽限定在 `xfreerdp` 获焦期间，并为临时解锁和离窗恢复分别提供明确路径。它的关键不是“吞掉所有按键”，而是先可靠识别窗口、始终保留退出键，并在 Hyprland 或客户端升级后重新验证 Lua API 与 class 匹配。
