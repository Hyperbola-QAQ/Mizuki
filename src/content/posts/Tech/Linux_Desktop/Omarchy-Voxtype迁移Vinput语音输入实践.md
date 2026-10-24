---
title: Omarchy 从 Voxtype 迁移到 Vinput：语音输入、LLM 场景与快捷键排障
published: 2026-10-25
updated: 2026-10-25
pinned: false
description: 在 Omarchy 与 Fcitx5 环境中通过 AUR 替换语音输入，复盘麦克风、LLM 场景绑定和修饰键冲突，并说明双机同步的验证边界。
tags: [Linux, Omarchy, Fcitx5, Vinput, 语音输入]
category: Desktop
author: Hyperbola
draft: false
---

# 为什么替换语音输入

这次迁移从 Omarchy 自带的 Voxtype 转向 `fcitx5-vinput`，希望语音输入直接接入现有 Fcitx5，同时支持选中文字后的语音修改。桌面与笔记本都已经安装 Fcitx5 和 Rime，不需要更换中文键盘输入法。

实际迁移安装的是 AUR `fcitx5-vinput-bin 2.4.2-1`。本文记录这个版本的操作与排障，不把后续版本的能力当作当时已有的功能。初始方案采用本地识别，后来又试用了其他 ASR 提供商；因此“安装了离线模型”不等于“当前所有识别都在本地”。

# 先分清三个部分

Vinput 的输入链路可以拆成三个部分：Fcitx5 插件接收输入上下文与快捷键，守护进程处理录音和识别，LLM 场景决定是否改写文字。GUI 是这些配置的入口，不必一直打开。

相关位置如下，均是用户目录：

| 内容 | 位置 |
| --- | --- |
| 快捷键 | `~/.config/fcitx5/conf/vinput.conf` |
| ASR、LLM 与场景 | `~/.config/vinput/config.json` |
| 本地模型 | `~/.local/share/vinput/models/` |
| 用户服务 | `vinput-daemon.service` |

Fcitx5 的快捷键不会自动变成 Hyprland 绑定。应用接入输入法后，插件能在普通输入法处理前收到按键；不需要先打一个字母，也不依赖候选框已经出现。但应用若没有正常接入 Fcitx5，不能只凭“桌面快捷键可用”推断文字一定能上屏。

# 通过 AUR 安装并启用

在两台机器分别执行安装，而不是把另一台机器的系统目录直接复制过来：

```bash
omarchy pkg aur add fcitx5-vinput-bin
```

当时的 Omarchy 包装层最终调用 yay，并带有 `--noconfirm --needed`，再检查包是否真正安装成功。它仍使用 AUR 的 PKGBUILD 和校验流程，并不是另一种软件来源。直接使用 `yay -S fcitx5-vinput-bin` 则更方便保留交互审阅步骤。

安装时先检查 PKGBUILD、下载来源和校验结果。下载应优先使用已配置的可信国内镜像；镜像缺版本、连接失败或校验不通过时才回退上游。不要为了换下载地址而跳过校验。本次原始安装通过上游发布包完成，并通过 PKGBUILD 中的 SHA-256 校验。

安装后在 Fcitx5 配置工具的附加组件中确认 Vinput 已启用，再启动服务并重新加载输入法：

```bash
systemctl --user enable --now vinput-daemon.service
fcitx5 -r
```

`enable` 配置的是用户会话启动，不代表登录前就持续监听麦克风。重启 Fcitx5 会短暂中断当前输入，应该先结束正在编辑的输入法组合文本。

打开管理界面使用：

```bash
vinput-gui
```

GUI 不需要设置为自启动。验证后台服务即可：

```bash
systemctl --user is-enabled vinput-daemon.service
systemctl --user is-active vinput-daemon.service
vinput -j daemon status
```

本次两台机器分别确认了 `enabled` 和 `active`。服务运行只说明进程活着，模型和录音链路还需要单独检查。

# 本地模型与默认麦克风的坑

初始选择了支持中英与标点的 `onnx-xasr-zh-en-punct-int8-off`。模型 ID 应以当前注册表为准，先列出，再下载并激活：

```bash
vinput model list -a
vinput model add onnx-xasr-zh-en-punct-int8-off
vinput model use onnx-xasr-zh-en-punct-int8-off
```

本机第一次通过命令开始录音时，CLI 报告已开始，但守护进程日志出现：

```text
PipeWire stream error: no target node available
```

最初保持了 Vinput 的 `default` 录音设备。检查 `wpctl status` 后发现系统存在模拟输入源，但查询默认录音设备不能得到有效节点。也就是说，不能把“存在麦克风设备”和“默认麦克风解析正常”当成同一个条件。

排查先看设备和日志，而不是反复更换识别模型：

```bash
vinput device list
wpctl status
wpctl inspect @DEFAULT_AUDIO_SOURCE@
journalctl --user -u vinput-daemon.service -n 50 --no-pager
```

本次修复是给 Vinput 明确指定已枚举出的模拟输入源。下面的名称是占位符，需要替换为本机 `device list` 的结果，不能直接照抄：

```bash
vinput device use '<本机输入源名称>'
vinput daemon restart
```

之后日志确认格式协商成功，录音状态能够进入 `recording` 并恢复 `idle`。笔记本的默认源工作正常，因此没有照搬桌面的硬件设备名。双机同步应同步功能选择，不应机械复制硬件标识。

当时的自动化测试没有实际说话，日志出现过 VAD 未发现语音、跳过过短音频的结果。这能验证无语音分支，不足以证明麦克风拾音质量、中文准确率或最终文字上屏。真实验收仍应在常用编辑器和聊天框里说一句话。

# 添加 LLM 为什么还不能修改文字

配置服务商后，连通性测试能获取模型列表，但语音修改仍不可用。检查发现 `__command__` 场景只有默认提示词，没有绑定服务商和模型。

这里容易混淆两个层次：服务商保存 API 连接信息，场景决定用哪个服务商、哪个模型以及什么提示词。服务商存在不会自动补全所有场景。

下面用脱敏后的服务商 ID 举例。先在 GUI 中添加自己的服务商和密钥，再检查连接并绑定命令场景：

```bash
vinput llm test example-provider
vinput scene edit __command__ --provider example-provider --model deepseek-flash
vinput scene list
```

本次服务商返回的模型列表包含 `deepseek-flash`，所以使用这个名称；其他接口是否支持，应以其实际模型列表为准。列表可读只能确认连接和枚举能力，不等于已经验证了一次完整的文本改写请求。

命令模式的输入是“选中的文字 + 口述修改要求”，例如选中一段话后说“翻译成英文”。普通听写仍使用 `__raw__`，不会因为配置了命令场景就自动润色，也无需把当前普通场景切换成 `__command__`。

如果希望每次听写都自动去掉语气词，需要另外创建并选择固定润色场景。口述“口语整理”只是给命令模式的一条自然语言指令，不会自动按场景名称查找一段预设提示词。

# 从右 Ctrl 改成 Shift 加右 Alt

默认命令键是右 Ctrl，但它会参与日常 `Ctrl+Enter` 操作，使用中存在冲突。曾考虑让右 Ctrl 按住两秒才生效；检查当时安装版本暴露的配置，没有找到可配置的两秒延迟选项，因此没有实现这个方案，也没有维护自定义补丁。

最后选择保留右 Alt 普通听写，把命令键改成 `Shift+Alt_R`。在 `~/.config/fcitx5/conf/vinput.conf` 中修改对应段落，保留其他已有配置：

```ini
[CommandKeys]
0=Shift+Alt_R
```

这里用 `Shift` 修饰，不限定左或右 Shift。删除原先的 `Control_R` 条目，避免旧键继续生效。普通 `TriggerKey` 仍保持 `Alt_R`。

重载插件配置，无需额外增加 Hyprland 绑定：

```bash
busctl --user call org.fcitx.Fcitx5 /controller \
  org.fcitx.Fcitx.Controller1 ReloadAddonConfig s vinput
```

检查实际加载值，而不是只看文件是否保存：

```bash
busctl --user call org.fcitx.Fcitx5 /controller \
  org.fcitx.Fcitx.Controller1 GetConfig s fcitx://config/addon/vinput
```

本次两台机器都读到了 `CommandKeys` 中的 `Shift+Alt_R`。操作设计是先按 Shift，再按右 Alt 说话，先松开右 Alt，最后松开 Shift。

**这一步只完成配置加载验证，尚未实测左右 Shift 的完整录音、文本选择和上屏链路。** 尤其默认右 Shift 还承担命令面板入口，需要分别验证“右 Shift 单独按”和“右 Shift 加右 Alt”，不能直接宣称没有冲突。若有异常，可以在 GUI 改回已验证的键位，并重新读取加载值。

# 彻底卸载旧方案，但不破坏 Omarchy

新服务与模型就绪后，再停止旧服务并删除软件包：

```bash
systemctl --user disable --now voxtype.service
omarchy pkg drop voxtype-bin
```

删除会失去旧方案的本地模型与配置；通常应先备份再迁移。本次明确选择不保留迁移备份，因此按确认后的清单清除了 Voxtype 专属文件，而不是建议所有读者递归删除整个配置目录。

清理清单包括用户配置和模型、旧用户服务与自启动、Voxtype 快捷键及注释示例、包含旧配置的历史备份、专属安装包缓存，以及用户自定义菜单和状态组件。另一个容易遗漏的位置是 chezmoi 源目录：只删运行配置却保留受管理源文件，后续应用 dotfiles 时可能恢复旧配置。

还检查并删除了用户目录中的 Voxtype 安装邀请 hook，避免继续提示安装。收尾确认旧包已不存在、没有旧进程、用户服务不再注册。修改过 Hyprland 用户配置后，重载并检查错误：

```bash
hyprctl reload
hyprctl configerrors
```

清理范围不包括 Omarchy 软件包附带的安装脚本、默认菜单定义或项目源码里的 Voxtype 支持代码；这些属于发行版自身。也不删除共享依赖。以后发行版更新是否重新提供相关入口，需要按更新后的实际状态判断。

# 双机同步与密钥边界

迁移按“桌面先完成，笔记本再处理”的顺序执行。同步模型后比较了文件 SHA-256，确认两边一致；安装包也分别经过 AUR 校验。用户服务、录音设备与输入法状态则在各自机器检查。

同步 LLM 时只同步对应服务商和命令场景，保留目标机器已有的 ASR、麦克风及其他场景。不要把整个 `config.json` 无差别覆盖过去，更不能把包含密钥的完整配置作为教程附件。

Vinput 的 API 密钥在本次配置中是明文写入 `~/.config/vinput/config.json` 的。SSH 保护传输，不能让落盘文件变成加密存储。可以限制文件权限：

```bash
chmod 600 ~/.config/vinput/config.json
```

这只限制其他普通用户读取，不能阻止同一用户权限下的程序读取。还应避免把密钥提交到 dotfiles、公开仓库或无保护备份；本文没有执行密钥环迁移，也没有把它描述成已有功能。

本地 ASR 与远程 LLM 是两个独立选择。即使识别在本地，调用远程 LLM 时仍会发送待处理文字，命令模式还涉及选中文字；若切换远程 ASR，则应另行了解音频发送范围。

# 验证结果与下一步

本次确认了两台机器的安装版本、模型文件一致性、服务启用和运行状态、右 Alt 在空白终端直接触发录音，以及录音结束后没有 Vinput 麦克风流残留。本机还验证了普通右 Alt 长按录音。LLM 连接测试通过，命令场景绑定和新组合键加载值均已检查。

仍需在真实应用中完成三组测试：普通听写准确率及文字上屏；选中文字后调用 LLM 的结果与替换行为；左右 Shift 分别搭配右 Alt，确认不误触普通听写或右 Shift 面板。服务健康和配置正确不能代替这些交互验收。

# 总结

这次迁移最有用的经验，是把输入法按键、录音设备、识别引擎和 LLM 场景分开检查：录音命令成功不代表默认麦克风可用，服务商连通不代表命令场景已绑定，组合键写入也不代表所有应用都通过了验证。按层定位问题，比反复重装或更换模型更容易得到明确结论。

参考资料：[Vinput 快速开始](https://xifan2333.github.io/fcitx5-vinput/guide/)、[场景与 LLM](https://xifan2333.github.io/fcitx5-vinput/scenes/)、[2.4.2 按键处理源码](https://github.com/xifan2333/fcitx5-vinput/blob/v2.4.2/src/addon/input/vinput_keyevent.cpp)。在线文档可能随上游更新，复现旧环境应结合版本标签和本机 `--help` 核对。
