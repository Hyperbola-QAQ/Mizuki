---
title: Mise 懒加载开发环境：Python 和 Node 独立控制指南
published: 2026-02-19
updated: 2026-02-19
pinned: false
description: 使用Mise工具实现Python和Node.js开发环境的懒加载配置与独立版本管理
tags: [Development]
category: Development
author: Hyperbola
draft: false
series: 开发环境配置
---

> **声明**：本文档记录的方案已不再是作者当前在生产环境中使用的方案。本文仅作历史演进参考。

# Mise 懒加载开发环境：Python 和 Node 独立控制指南

> **摘要**：本文介绍如何通过懒加载和自定义变量，实现 Mise 对 Python 和 Node 的独立控制。新终端默认使用系统版本，执行 `mise use` 时自动启用管理，互不干扰。

---

# 🎯 实施思路

```
┌─────────────────────────────────────────────────────────┐
│  新终端                                                  │
│  ↓                                                       │
│  MY_DISABLE_PYTHON=1, MY_DISABLE_NODE=1                 │
│  ↓                                                       │
│  MISE_DISABLE_TOOLS=python,node                          │
│  ↓                                                       │
│  which python → /usr/bin/python (系统)                  │
│  which node   → /usr/bin/node (系统)                    │
│                                                          │
│  执行 mise use python@3.14                               │
│  ↓                                                       │
│  unset MY_DISABLE_PYTHON                                 │
│  MISE_DISABLE_TOOLS=node  ← 只禁用 node                  │
│  ↓                                                       │
│  which python → ~/.local/share/mise/.../python          │
│  which node   → /usr/bin/node (保持系统)                │
└─────────────────────────────────────────────────────────┘
```

---

# 📦 完整配置

## 1. 创建配置文件

```bash
# 创建目录
mkdir -p ~/.config/mise

# 创建配置文件
nano ~/.config/mise/mise.zsh
```

## 2. 写入配置内容

```bash
# ~/.config/mise/mise.zsh

# ============================================
# Mise 配置 - 独立控制 Python 和 Node
# ============================================

# 自定义开关（默认禁用）
export MY_DISABLE_PYTHON=1
export MY_DISABLE_NODE=1

# ============================================
# 核心函数：根据开关更新 MISE_DISABLE_TOOLS
# ============================================

mise-update-disable-tools() {
    local tools=""
    
    [ -n "$MY_DISABLE_PYTHON" ] && tools="python"
    [ -n "$MY_DISABLE_NODE" ] && tools="${tools:+$tools,}node"
    
    if [ -n "$tools" ]; then
        export MISE_DISABLE_TOOLS="$tools"
    else
        unset MISE_DISABLE_TOOLS
    fi
}

# 初始化
mise-update-disable-tools

# ============================================
# Mise 函数包装
# ============================================

mise() {
    local cmd="$1"
    shift
    
    if [ "$cmd" = "use" ]; then
        # 检测 python
        if echo "$@" | grep -qE "^python(@|[[:space:]]|$)"; then
            if [ -n "$MY_DISABLE_PYTHON" ]; then
                unset MY_DISABLE_PYTHON
                mise-update-disable-tools
                echo "⚡ 启用 Python 管理"
            fi
        fi
        
        # 检测 node
        if echo "$@" | grep -qE "^node(@|[[:space:]]|$)"; then
            if [ -n "$MY_DISABLE_NODE" ]; then
                unset MY_DISABLE_NODE
                mise-update-disable-tools
                echo "⚡ 启用 Node 管理"
            fi
        fi
    fi
    
    command mise "$cmd" "$@"
}

# ============================================
# 手动控制函数
# ============================================

mise-python-enable() {
    unset MY_DISABLE_PYTHON
    mise-update-disable-tools
    echo "✅ Python 管理已启用"
}

mise-python-disable() {
    export MY_DISABLE_PYTHON=1
    mise-update-disable-tools
    echo "🚫 Python 管理已禁用"
}

mise-node-enable() {
    unset MY_DISABLE_NODE
    mise-update-disable-tools
    echo "✅ Node 管理已启用"
}

mise-node-disable() {
    export MY_DISABLE_NODE=1
    mise-update-disable-tools
    echo "🚫 Node 管理已禁用"
}

mise-status() {
    echo "=== Mise 状态 ==="
    [ -n "$MY_DISABLE_PYTHON" ] && echo "🚫 Python: 禁用" || echo "✅ Python: 启用"
    [ -n "$MY_DISABLE_NODE" ] && echo "🚫 Node:   禁用" || echo "✅ Node:   启用"
    echo ""
    echo "MISE_DISABLE_TOOLS=${MISE_DISABLE_TOOLS:-<unset>}"
    echo ""
    echo "Python: $(which python 2>/dev/null)"
    echo "Node:   $(which node 2>/dev/null)"
}

# ============================================
```

### 3. 在 `.zshrc` 中懒加载

```bash
# ~/.zshrc

# Mise 懒加载
[[ -f "$HOME/.config/mise/mise.zsh" ]] && source "$HOME/.config/mise/mise.zsh"
```

> ⚠️ **注意**：确保 `eval "$(mise activate zsh)"` 只执行一次，已在 `mise.zsh` 中激活则无需重复。

---

# 🧪 使用效果

## 场景 1：新终端窗口（默认禁用）

```bash
$ mise-status
=== Mise 状态 ===
🚫 Python: 禁用
🚫 Node:   禁用

MISE_DISABLE_TOOLS=python,node

Python: /usr/bin/python
Node:   /usr/bin/node
```

## 场景 2：只启用 Python

```bash
$ mise use python@3.14
⚡ 启用 Python 管理
mise ~/.config/mise/config.toml tools: python@3.14

$ mise-status
=== Mise 状态 ===
✅ Python: 启用
🚫 Node:   禁用

MISE_DISABLE_TOOLS=node

Python: ~/.local/share/mise/installs/python/3.14/bin/python
Node:   /usr/bin/node
```

## 场景 3：只启用 Node

```bash
# 新开终端
$ mise use node@20
⚡ 启用 Node 管理
mise ~/.config/mise/config.toml tools: node@20

$ mise-status
=== Mise 状态 ===
🚫 Python: 禁用
✅ Node:   启用

MISE_DISABLE_TOOLS=python

Python: /usr/bin/python
Node:   ~/.local/share/mise/installs/node/20/bin/node
```

## 场景 4：同时启用

```bash
$ mise use python@3.14 node@20
⚡ 启用 Python 管理
⚡ 启用 Node 管理

$ mise-status
=== Mise 状态 ===
✅ Python: 启用
✅ Node:   启用

MISE_DISABLE_TOOLS=<unset>
```

## 场景 5：手动控制

```bash
$ mise-python-disable
🚫 Python 管理已禁用

$ mise-node-enable
✅ Node 管理已启用

$ mise-status
=== Mise 状态 ===
🚫 Python: 禁用
✅ Node:   启用

MISE_DISABLE_TOOLS=python
```

---

# 📋 状态对照表

| 操作                           | **MY_DISABLE_PYTHON** | **MY_DISABLE_NODE** | **MISE_DISABLE_TOOLS** |
| ------------------------------ | --------------------- | ------------------- | ---------------------- |
| 新终端                         | `1`                   | `1`                 | `python,node`          |
| `mise use python@3.14`         | `unset`               | `1`                 | `node`                 |
| `mise use node@20`             | `1`                   | `unset`             | `python`               |
| `mise use python@3.14 node@20` | `unset`               | `unset`             | `unset`                |
| `mise-python-disable`          | `1`                   | `unset`             | `python`               |
| `mise-node-disable`            | `unset`               | `1`                 | `node`                 |

---

## 🔧 扩展其他工具

如需控制更多工具（Bun、Go 等），按相同模式扩展：

```bash
# 添加自定义开关
export MY_DISABLE_BUN=1
export MY_DISABLE_GO=1

# 更新函数
mise-update-disable-tools() {
    local tools=""
    [ -n "$MY_DISABLE_PYTHON" ] && tools="python"
    [ -n "$MY_DISABLE_NODE" ] && tools="${tools:+$tools,}node"
    [ -n "$MY_DISABLE_BUN" ] && tools="${tools:+$tools,}bun"
    [ -n "$MY_DISABLE_GO" ] && tools="${tools:+$tools,}go"
    [ -n "$tools" ] && export MISE_DISABLE_TOOLS="$tools" || unset MISE_DISABLE_TOOLS
}

# 在 mise 函数中添加检测
if echo "$@" | grep -qE "^bun(@|[[:space:]]|$)"; then
    [ -n "$MY_DISABLE_BUN" ] && unset MY_DISABLE_BUN && mise-update-disable-tools && echo "⚡ 启用 Bun"
fi
```
---

# ⚠️ 注意事项

| 问题           | **解决方案**                                        |
| -------------- | --------------------------------------------------- |
| 配置不生效     | 检查 `mise.zsh` 路径是否正确                        |
| 函数未定义     | 确保 `source` 在 `eval "$(mise activate zsh)"` 之后 |
| 变量不更新     | 检查 `mise-update-disable-tools` 是否被调用         |
| 与其他工具冲突 | 只包装 `mise` 函数，不影响原生命令                  |
| 想恢复默认     | 删除 `~/.config/mise/mise.zsh` 重新配置             |

---

## 📚 参考链接

- [Mise 官方文档](https://mise.jdx.dev/)
- [MISE_DISABLE_TOOLS 环境变量](https://mise.jdx.dev/configuration/settings.html#disable-tools)
- [Zsh 函数编写指南](https://zsh.sourceforge.net/Doc/Release/Functions.html)

---
2025-2-19 23:41
