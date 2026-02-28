---
title: Arch Fcitx5+Rime+Rime-ice从0开始的输入法配置
published: 2025-12-08
updated: 2026-02-22
pinned: false
description: 解决Linux桌面环境下Clash Verge Rev频繁弹出Polkit认证对话框的方法
tags:
  - Linux
  - Rime
  - Fcitx
  - 桌面环境
category: Linux桌面
author: Hyperbola
draft: false
series: Linux输入法问题解决
---
%%  %%# 🍵 前提准备：添加 ArchlinuxCN 源（可选但强烈推荐）

> ⚠️ 本指南默认你**已启用 [ArchlinuxCN](https://github.com/archlinuxcn/repo) 源**。  
> 若未添加，遇到 `error: target not found` 时，请改用 `yay -S 包名` 安装。

## 添加源步骤：

```bash
sudo nvim /etc/pacman.conf
```

在文件末尾追加：

```ini
[archlinuxcn]
Server = https://mirrors.aliyun.com/archlinuxcn/$arch
# 或使用其他镜像，如：https://repo.archlinuxcn.org/$arch
```

保存后，安装签名密钥并同步：

```bash
sudo pacman -Sy archlinuxcn-keyring
```

> 💡 镜像加速小贴士：国内用户推荐阿里云、清华源；海外用户可用官方 `repo.archlinuxcn.org`。

---

# 🧸 第一步：安装 Fcitx5 输入法框架

```bash
sudo pacman -S fcitx5 fcitx5-qt fcitx5-gtk fcitx5-configtool
```

## 📦 各包作用速览：

| 包名                | 用途                                    |
| ------------------- | --------------------------------------- |
| `fcitx5`            | 核心输入法引擎                          |
| `fcitx5-qt`         | 支持 Qt 应用（如 Telegram、KDE 软件）   |
| `fcitx5-gtk`        | 支持 GTK 应用（如 Firefox、GNOME 软件） |
| `fcitx5-configtool` | 图形化配置界面（超好用！）              |

> 🎁 可选美化包：`fcitx5-material-color`（后面会用到）

---

# 🧊 第二步：安装 Rime 引擎 + 雾凇拼音(rime-ice)

```bash
# Rime 的 Fcitx5 前端（官方仓库）
sudo pacman -S fcitx5-rime

# 雾凇拼音（社区维护，功能超全）
yay -S rime-ice-git
```

> 💡 如果你用的是 `paru`，也可以写成 `paru -S rime-ice-git`。  
> `rime-ice` 内置：全拼/双拼、Emoji、农历、错音提示、中英混输、简易计算器等，开箱即用！

---

# 🌈 第三步：设置环境变量

## 让所有程序都能用 Fcitx5

创建系统级环境变量配置：

```bash
mkdir -p ~/.config/environment.d
nvim ~/.config/environment.d/fcitx.conf
```

填入以下内容：

```sh
INPUT_METHOD=fcitx
GTK_IM_MODULE=fcitx
QT_IM_MODULE=fcitx
XMODIFIERS=@im=fcitx
SDL_IM_MODULE=fcitx
```

> ✅ 这个方法适用于 **X11 和大多数 Wayland 桌面**（如 GNOME、KDE）。  
> 对于 **纯 Wayland 环境**（如 Sway/Hyprland），还需在启动脚本中导入 DBus 环境（见下文补充）。

## 🔧 Wayland 用户额外配置（Hyprland / Sway）

在你的窗口管理器配置中加入：

```ini
# Hyprland: ~/.config/hypr/hyprland.conf
exec-once = systemctl --user import-environment GTK_IM_MODULE QT_IM_MODULE XMODIFIERS
exec-once = dbus-update-activation-environment --systemd GTK_IM_MODULE QT_IM_MODULE XMODIFIERS
exec-once = fcitx5 -d
```

> 💡 修改后需**重启会话**（logout → login）才能完全生效。

---

# 🎀 第四步：启动 Fcitx5 并添加 Rime 输入法

1. **首次手动启动（调试用）**：
   ```bash
   fcitx5 -d
   ```

2. **打开配置工具**：
   ```bash
   fcitx5-configtool
   ```

3. **添加 Rime**：
   - 点击左下角 `+`
   - 搜索 `Rime` → 添加
   - ❗**务必保留 `Keyboard - English (US)`**！这是切换中英文的保底方案，删了可能卡住。

4. **设置开机自启**：
   - GNOME/KDE：通常自动识别
   - Sway/Hyprland：已在上一步配置 `exec-once fcitx5 -d`

---

# ❄️ 第五步：启用「雾凇拼音」作为默认方案

进入用户配置目录：

```bash
cd ~/.local/share/fcitx5/rime
```

创建 `default.custom.yaml`：

```yaml
# default.custom.yaml
patch:
  __include: rime_ice_suggestion:/
  menu/page_size: 10

  __patch:
    key_binder/bindings/+:
      # 用逗号和句号翻页，更符合直觉！
      - { when: paging, accept: comma, send: Page_Up }
      - { when: has_menu, accept: period, send: Page_Down }
```

> ✨ `__include: rime_ice_suggestion:/` 会加载雾凇拼音提供的完整方案列表（全拼、各种双拼等）。

## 🔄 重新部署输入法

> ⚠️ 经实测，**`fcitx5 -rd` 是可靠命令**，而 `fcitx5-remote -r` 在某些环境下无效。

```bash
fcitx5 -rd
```

> 💡 你也可以右键任务栏 Fcitx5 图标 → **Restart**，效果相同。

---

# 🎨 第六步：美化 Fcitx5

```bash
sudo pacman -S fcitx5-material-color
```

然后打开 `fcitx5-configtool` → **Addons** → **Classic User Interface** → **Theme**

推荐主题：
- `Material-Color-SakuraPink`（樱花粉 💕）

也可以使用ssfenv将搜狗皮肤转换为适用于fcitx5的主题

---

# 🛠️ 第七步：常见问题排查小贴士

| 问题                 | 解决方案                                                     |
| -------------------- | ------------------------------------------------------------ |
| 打不出中文           | 检查环境变量是否生效；确认 Rime 已添加；重启 Fcitx5          |
| Qt/GTK 软件无法输入  | 确保安装了 `fcitx5-qt` 和 `fcitx5-gtk`                       |
| 没看到“雾凇拼音”选项 | 确认 `rime-ice-git` 已安装；卸载冲突包（如 `rime-luna-pinyin`） |
| 部署失败             | 检查 YAML 缩进（必须用空格，不能用 Tab！）                   |
| Fcitx5 图标不显示    | 安装 `fcitx5-module-x11`（X11）或确保 Wayland 兼容           |

> 🚫 **重要提醒**：如果你之前安装过 `rime-luna-pinyin`（朙月拼音），它会和 `rime-ice` 冲突！建议卸载：
> ```bash
> sudo pacman -R rime-luna-pinyin
> ```

---

# 🧩 高级玩法——自定义词库（萌娘百科 + 维基百科！）

> ⚠️ **切勿直接修改 `/usr/share/rime-data/` 下的文件**！pacman 更新时会被覆盖！

## 步骤 1：创建用户级 schema 补丁

```bash
cd ~/.local/share/fcitx5/rime
nvim rime_ice.custom.yaml
```

内容：

```yaml
# rime_ice.custom.yaml
patch:
  translator/dictionary: rime_ice_custom
```

## 步骤 2：安装第三方词库

```bash
sudo pacman -S rime-pinyin-moegirl rime-pinyin-zhwiki
```

## 步骤 3：创建自定义词典

```bash
cp /usr/share/rime-data/rime_ice.dict.yaml rime_ice_custom.dict.yaml
```

编辑 `rime_ice_custom.dict.yaml`，**只修改头部元信息**，保留原有词库引用：

```yaml
# rime_ice_custom.dict.yaml
---
name: rime_ice_custom
version: "2025-12-13"
import_tables:
  - zhwiki        # 维基百科
  - moegirl       # 萌娘百科（二次元浓度↑↑）
  - cn_dicts/8105
  - cn_dicts/base
  - cn_dicts/ext
  - cn_dicts/tencent  # 大词库，部署稍慢但更全
...
```

> ❓“为什么不能直接在 `import_tables` 里加 `rime_ice`？”  
> 实测发现反正是不行,推测是：**`rime_ice.dict.yaml` 本身是“组合型”词库**，直接引用会导致解析异常。  
> 最稳妥的方式是 **复制原文件并在此基础上扩展**。

## 步骤 4：重新部署！

```bash
fcitx5 -rd
```

> 🎉 现在你可以愉快地输入：“赛博朋克”、“绝绝子”、“初音未来”、“量子纠缠”啦！

---

# 📚 参考资料（知识小书架）

- [Fcitx5 Arch Wiki](https://wiki.archlinux.org/title/Fcitx5)
- [Rime 官方文档](https://github.com/rime/home/wiki)
- [雾凇拼音 GitHub](https://github.com/iDvel/rime-ice)
- [Arch Linux CN Wiki - Rime](https://wiki.archlinuxcn.org/wiki/Rime)

---

# 🌟 结语

恭喜你！🎉  
你现在拥有一个 **功能强大、颜值爆表、词库丰富、支持全拼/双拼/Emoji/农历/中英混输** 的中文输入法！

快去试试这些彩蛋吧：
- `nl` → 当前农历
- `cC1+2*3` → 计算结果
- `[` / `]` → 以词定字
- `uU木` → 拆字反查

打字，也可以很浪漫 💖

> 🥟 如果你觉得雾凇拼音太香，别忘了 [请作者吃个煎饼馃子](https://github.com/iDvel/rime-ice#%E8%B5%9E%E5%8A%A9-)！  
> 开源不易，爱要大声说出来 ❤️

---

✅ **本指南已通过 Arch Linux + Hyprland + Fcitx5 + Rime-ice 实机验证（2025年12月）**