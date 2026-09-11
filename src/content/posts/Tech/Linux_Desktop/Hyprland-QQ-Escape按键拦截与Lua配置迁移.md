---
title: Hyprland QQ Escape 按键拦截与 Lua 配置迁移
published: 2026-08-19
updated: 2026-08-19
pinned: false
description: 在 Hyprland 0.56.2 中根据活动窗口动态拦截 QQ 的 Escape 键，并记录从 Bash 监听迁移到纯 Lua 配置的过程
tags: [Linux, Desktop, Hyprland]
category: Desktop
author: Hyperbola
draft: false
---

# Hyprland QQ Escape 按键拦截与 Lua 配置迁移

## 问题背景

在 QQ 主窗口获得焦点时，误按 `Escape` 可能关闭窗口或触发非预期行为。我的目标是：

- QQ 主窗口处于活动状态时，拦截 `Escape`；
- 切换到其他窗口后，恢复 `Escape` 的正常行为；
- 不启动长期驻留的外部监听脚本；
- 将 QQ、微信等社交应用的窗口规则集中维护。

这套配置经历了三个阶段：传统 `hyprland.conf`、Bash 调用 Lua，以及最终的纯 Lua 实现。本文保留前两种方案作为迁移记录，实际使用以第三种为准。

## 环境信息

本文配置在以下版本中验证：

```text
$ hyprctl version
Hyprland 0.56.2 built from branch v0.56.2 at commit
efb50993780079460b0cbed1363e2166a2de1d9f clean
([gha] Nix: update inputs).

Date: Wed Aug 5 14:13:21 2026
Tag: v0.56.2, commits: 7661

Libraries:
Hyprgraphics: built against 0.5.1, system has 0.5.1
Hyprutils: built against 0.14.0, system has 0.14.1
Hyprcursor: built against 0.1.13, system has 0.1.13
Hyprlang: built against 0.6.8, system has 0.6.8
Aquamarine: built against 0.14.0, system has 0.14.0

Version ABI string:
efb50993780079460b0cbed1363e2166a2de1d9f_aq_0.14_hu_0.14_hg_0.5_hc_0.1_hlg_0.6

no flags were set
```

> 本文使用的是 Hyprland Lua 配置解析器 API。不同版本的事件名称、窗口规则字段和绑定接口可能发生变化，升级后应先检查 `hyprctl version` 和配置加载日志。

## 窗口识别条件

首先用 `hyprctl activewindow` 确认 QQ 主窗口的 `class` 和 `title`：

```bash
hyprctl activewindow -j | jq '{class, title}'
```

本文环境中的 QQ 主窗口特征为：

```json
{
  "class": "QQ",
  "title": "QQ"
}
```

同时匹配 `class` 和 `title`，可以避免 QQ 的图片查看器、设置页等子窗口错误触发按键拦截。

## 方案演进

| 阶段 | 监听方式 | 配置方式 | 适用情况 |
|---|---|---|---|
| 传统配置 | Socket2 + Bash | `hyprctl keyword` | 旧版 `.conf` 解析器 |
| 迁移过渡 | Socket2 + Bash | `hyprctl eval` | 已切换 Lua，但暂时保留脚本 |
| 最终方案 | `hl.on()` | 纯 Lua API | 当前使用方式 |

## 方案一：传统配置解析器

旧版配置可以监听 Hyprland 的 Socket2，在活动窗口改变时动态绑定或解绑 `Escape`：

```bash
#!/usr/bin/env bash

QQ_CLASS="QQ"
QQ_TITLE="QQ"

socat -u \
  UNIX-CONNECT:"$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock" \
  STDOUT |
while read -r line; do
    [[ "$line" == activewindow* ]] || continue

    active_class=$(hyprctl activewindow -j 2>/dev/null | jq -r '.class')
    active_title=$(hyprctl activewindow -j 2>/dev/null | jq -r '.title')

    if [[ "$active_class" == "$QQ_CLASS" && "$active_title" == "$QQ_TITLE" ]]; then
        hyprctl keyword bind ,Escape,exec,true 2>/dev/null
    else
        hyprctl keyword unbind ,Escape 2>/dev/null
    fi
done
```

该方案依赖 `socat`、`jq` 和后台进程。切换到非传统配置解析器后，`hyprctl keyword` 会提示：

```text
keyword can't work with non-legacy parsers. Use eval.
```

## 方案二：Bash 调用 Lua API

过渡阶段仍由 Bash 监听事件，但通过 `hyprctl eval` 读取窗口信息并修改绑定：

```bash
#!/usr/bin/env bash

QQ_CLASS="QQ"
QQ_TITLE="QQ"

socat -u \
  UNIX-CONNECT:"$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock" \
  STDOUT |
while read -r line; do
    [[ "$line" == activewindow* ]] || continue

    active_class=$(hyprctl eval \
      'local win = hl.get_active_window(); return win and win.class or ""' \
      2>/dev/null)
    active_title=$(hyprctl eval \
      'local win = hl.get_active_window(); return win and win.title or ""' \
      2>/dev/null)

    if [[ "$active_class" == "$QQ_CLASS" && "$active_title" == "$QQ_TITLE" ]]; then
        hyprctl eval \
          'hl.bind("Escape", hl.dsp.no_op(), { replace = true })' \
          2>/dev/null
    else
        hyprctl eval 'hl.unbind("Escape")' 2>/dev/null
    fi
done
```

这种写法解决了配置解析器兼容问题，但 Bash、Socket 和频繁的 `hyprctl eval` 调用仍然存在，因此只适合作为迁移过渡。

## 方案三：纯 Lua 实现

最终配置集中在 `~/.config/hypr/apps/social.lua` 中，不再启动外部监听进程。

### 完整配置

```lua
-- ~/.config/hypr/apps/social.lua

-- QQ 与微信统一进入 workspace 10，并自动加入窗口组。
local app_classes = { "QQ", "wechat" }

for _, class in ipairs(app_classes) do
    hl.window_rule({
        match = {
            class = "^(" .. class .. ")$",
        },
        no_initial_focus = true,
        workspace = "10",
        group = "set",
    })
end

-- 仅在 QQ 主窗口获得焦点时拦截 Escape。
local function update_qq_escape_binding()
    local win = hl.get_active_window()
    local is_qq_main_window = win
        and win.class == "QQ"
        and win.title == "QQ"

    if is_qq_main_window then
        hl.bind("Escape", hl.dsp.no_op(), { replace = true })
    else
        hl.unbind("Escape")
    end
end

hl.on("window.active", update_qq_escape_binding)
update_qq_escape_binding()

-- 微信普通窗口去除装饰，但排除需要保留完整界面的子窗口。
local wechat_exclude = "朋友圈|设置|聊天文件|预览|图片和视频"

hl.window_rule({
    match = {
        class = "^(wechat)$",
        title = "negative:^(" .. wechat_exclude .. ")\\W*",
    },
    no_blur = true,
    border_size = 0,
    no_shadow = true,
})

-- “微信发送给”窗口单独去除装饰。
hl.window_rule({
    match = {
        class = "^wechat$",
        title = "^微信发送给$",
    },
    no_blur = true,
    border_size = 0,
    no_shadow = true,
})
```

在主配置中加载模块：

```lua
-- ~/.config/hypr/hyprland.lua
require("apps.social")
```

### 执行流程

```text
活动窗口发生变化
        ↓
读取当前窗口 class 与 title
        ↓
是否为 QQ 主窗口？
   ├─ 是：用 no-op dispatcher 覆盖 Escape
   └─ 否：移除临时 Escape 绑定
```

脚本加载时还会主动调用一次 `update_qq_escape_binding()`，避免 Hyprland 重载配置后必须切换窗口才能获得正确状态。

## 关键踩坑

### `group` 不能使用自定义名称

错误写法：

```lua
group = "social"
```

窗口规则需要使用合法动作，例如：

```lua
group = "set"
```

### 解绑不能传入 `nil`

下面的写法不可用：

```lua
hl.bind("Escape", nil)
```

应显式解绑：

```lua
hl.unbind("Escape")
```

### 使用精确的窗口条件

只判断 `class == "QQ"` 会影响 QQ 的其他子窗口。增加 `title == "QQ"` 后，拦截范围只覆盖主窗口。

### 注意已有的全局 Escape 绑定

`{ replace = true }` 会覆盖同键绑定，`hl.unbind("Escape")` 也会移除当前自定义绑定。如果你的主配置原本就定义了全局 `Escape` 快捷键，需要在离开 QQ 后显式恢复原绑定，而不能简单调用 `hl.unbind()`。

## 验证方法

重载配置：

```bash
hyprctl reload
```

然后依次检查：

1. 聚焦 QQ 主窗口，按下 `Escape`，窗口不应关闭；
2. 聚焦 QQ 图片查看器或设置窗口，`Escape` 应保持应用自身行为；
3. 切换到其他应用，`Escape` 应恢复正常；
4. 反复切换窗口，确认不会出现重复绑定或失效；
5. 查看 Hyprland 日志，确认 Lua 模块加载时没有报错。

## 总结

最终方案把“事件监听、窗口判断、按键拦截”全部放入 Hyprland Lua 配置：

- 不再依赖 `socat`、`jq` 和后台 Bash 进程；
- 直接使用 `hl.get_active_window()` 获取窗口状态；
- 使用 `hl.on("window.active", ...)` 响应焦点变化；
- 使用 `hl.dsp.no_op()` 拦截按键；
- 将 QQ 与微信规则集中在一个模块中维护。

这套配置基于 Hyprland 0.56.2。升级 Hyprland 后，应重新确认 Lua API、事件名称和窗口规则字段是否仍然兼容。
