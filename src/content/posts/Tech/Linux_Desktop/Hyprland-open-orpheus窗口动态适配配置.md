---
title: Hyprland open-orpheus 窗口动态适配配置
published: 2026-08-19
updated: 2026-08-19
pinned: false
description: 根据显示器分辨率动态调整 open-orpheus 窗口尺寸与位置的 Hyprland 配置实践
tags: [Linux, Desktop, Hyprland]
category: Desktop
author: Hyperbola
draft: true
---

# Hyprland 窗口动态配置实战：以 open-orpheus 为例

## 引言

在使用 Hyprland 作为窗口管理器时，我们经常需要对特定应用程序的窗口进行精细控制。本文将分享一个实际案例：如何根据显示器分辨率动态调整 `open-orpheus` 窗口的尺寸和位置，让同一配置在不同显示器上都能获得最佳体验。

---

## 第一步：捕获窗口信息

`open-orpheus` 是一个特殊的菜单类应用，**鼠标移开窗口就会自动消失**，手动用 `hyprctl clients` 根本来不及。所以第一步是**捕获窗口信息**。

### 实时监控命令

```bash
watch -n 0.2 'hyprctl clients -j | jq ".[] | select(.mapped == true)"'
```

这条命令每 0.2 秒刷新一次，列出所有当前可见的窗口。窗口出现的瞬间就会被捕获。

### 只过滤 open-orpheus

```bash
watch -n 0.2 'hyprctl clients -j | jq ".[] | select(.class == \"open-orpheus\")"'
```

### 精简输出（只看关键字段）

```bash
watch -n 0.2 'hyprctl clients -j | jq ".[] | select(.class == \"open-orpheus\") | {class, title, size, at, workspace, floating}"'
```

### 捕获到的信息示例

```json
{
  "class": "open-orpheus",
  "title": "Open Orpheus Menu",
  "size": [749, 814],
  "at": [775, 38],
  "workspace": { "id": 2 },
  "floating": false
}
```

这些信息就是我们配置窗口规则的依据。

---

## 第二步：配置加载时机的问题

Hyprland 的 `hl.window_rule` 在配置加载时执行，`size` 和 `move` 参数是**静态计算**的，不会在窗口创建时重新评估。

```lua
-- 这个值在配置加载时就固定了
local size_config = { 229, 341 }
hl.window_rule({
    match = { class = "open-orpheus" },
    size = size_config,  -- 固定值
})
```

---

## 第三步：通过 `hl.get_monitors()` 获取显示器信息

```lua
local monitors = hl.get_monitors()
local current_monitor = nil
for _, mon in ipairs(monitors) do
    if mon.focused then
        current_monitor = mon
        break
    end
end
```

---

## 第四步：最终配置文件

```lua
-- open_orpheus.lua
-- 在配置加载时检测当前显示器分辨率，生成对应的窗口规则

-- 1. 获取当前聚焦的显示器
local monitors = hl.get_monitors()
local current_monitor = nil
for _, mon in ipairs(monitors) do
    if mon.focused then
        current_monitor = mon
        break
    end
end

-- 2. 根据分辨率设置尺寸和位置
local size_config, move_config
if current_monitor then
    if current_monitor.width == 2560 then
        -- 2560x1440 显示器（HDMI-A-1）
        size_config = { 229, 341 }
        move_config = { 1175, 38 }
    elseif current_monitor.width == 1920 then
        -- 1920x1080 显示器（HDMI-A-2）
        size_config = { 232, 256 }
        move_config = { 806, 28 }
    end
end

-- 3. 应用窗口规则（带回退值）
hl.window_rule({
    match = {
        class = "open-orpheus",
        title = "Open Orpheus Menu",
    },
    float = true,
    size = size_config or { 309, 341 },
    move = move_config or { 1075, 38 },
})
```

---

## 配置效果

| 显示器分辨率 | 窗口尺寸 | 窗口位置 |
|------------|---------|---------|
| 2560×1440 | 229×341 | (1175, 38) |
| 1920×1080 | 232×256 | (806, 28) |
| 其他（回退） | 309×341 | (1075, 38) |

---

## 局限性

| 问题 | 说明 |
|------|------|
| 配置加载时固定 | `size` 和 `move` 在 Hyprland 启动或 `hyprctl reload` 时确定 |
| 切换显示器需重新加载 | 使用中切换到不同分辨率的显示器，需要手动重新加载配置（`Super + Shift + R`） |
| 无法实现真正的动态 | `hl.event("windowCreated")` 在当前 Omarchy 版本中不可用，无法在窗口创建时实时检测 |

---

## 完整工作流总结

```
1. watch 捕获窗口信息
   ↓
2. 获取 class、title、size、at
   ↓
3. 在配置中用 hl.get_monitors() 检测分辨率
   ↓
4. 根据分辨率设置不同的 size 和 move
   ↓
5. 用 hl.window_rule 应用配置
   ↓
6. 切换显示器时按 Super+Shift+R 重新加载
```

---

## 参考资料

- Hyprland Wiki: https://wiki.hypr.land/Configuring/Start/
- `hyprctl clients` 文档
- `jq` JSON 处理工具

---

*本文基于 Hyprland + Omarchy 环境编写，具体 API 可能因版本而异，请根据实际环境调整。*
