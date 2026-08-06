---
title: Zen Browser 开启 NVIDIA 硬解(VA-API)实战记录
published: 2026-08-06
updated: 2026-08-06
pinned: false
description: 记录 Zen Browser 在 Wayland + NVIDIA 环境下从软件解码切换到 VA-API 硬件解码的完整排查与配置过程
tags: [Hardware, Desktop]
category: Desktop
author: Hyperbola
draft: false
---

> 环境: Omarchy(Arch + Hyprland,Wayland),NVIDIA RTX 4070 SUPER(nvidia-utils 610 + libva-nvidia-driver),Zen Browser 1.21.10b

## 背景

在 Wayland 下用 Zen 浏览器看 B 站,想要确认视频是 GPU 硬解还是 CPU 软解,并把它从软解改到硬解。

## 一、如何检测当前是软解还是硬解

### 方法 1:查看 MOZ_LOG(最可靠)

关闭浏览器后,用带日志参数的方式启动并打开 B 站首页:

```bash
MOZ_DISABLE_RDD_SANDBOX=1 \
MOZ_LOG="PlatformDecoderModule:5,FFmpegVideo:4,VA-API:4,VAAPI:4" \
zen-browser --no-remote "https://www.bilibili.com/" 2>/tmp/zen.log
```

然后检查日志关键行。

**软解的特征:**

```
[RDD xxx]: D/PlatformDecoderModule Hw codec disabled by gfxVars for AV_CODEC_ID_H264
[RDD xxx]: D/FFmpegVideo FFMPEG: Using preferred software codec h264
```

硬解被 `gfxVars` 禁用,随后全部走 `software codec`,即 CPU 软解。

**硬解的特征:**

```
[RDD xxx]: D/FFmpegVideo FFMPEG: Using preferred hardware codec h264
[Parent xxx]: D/PlatformDecoderModule Broadcast support from 'RDD', support=H264 SWDEC HWDEC
```

出现 `HWDEC` 表示硬件解码支持已打开。

### 方法 2:监控 GPU 解码引擎(实测)

播放视频时轮询 NVIDIA 解码引擎利用率,非零即硬解在跑:

```bash
watch -n1 'nvidia-smi --query-gpu=utilization.decoder --format=csv,noheader'
```

软解时该值恒为 0%;硬解播放时通常在 2%~5% 波动(低码率视频数值不大,但非零)。

## 二、为什么默认是软解

排查过程用 `vainfo` 确认系统 VA-API 完全正常(NVDEC 后端支持 H264/VP9/AV1/HEVC 全系),硬件驱动没问题,问题出在浏览器端:

- Firefox 内核默认会对部分 GPU 关闭硬件视频解码(走 gfxVars blocklist / 功能开关判定)。
- 日志里 `Hw codec disabled by gfxVars` 就是被浏览器侧开关掐掉了。

## 三、开启硬解的配置

### 1. about:config 手动设置(临时验证)

地址栏输入 `about:config` → 接受风险 → 搜索并双击设为 `true`:

- `gfx.webrender.all`
- `gfx.webrender.compositor`
- `layers.acceleration.force-enabled`
- `media.hardware-video-decoding.force-enabled`

以及设 `gfx.webrender.software` 为 `false`(设 true 会退回纯 CPU 渲染)。

> 这些设置写入的是配置文件目录下的 `prefs.js`,about:config 里改的是它。

### 2. 写 user.js 固化(持久生效)

`about:config` 只改 `prefs.js`,不写 `user.js`。而 `user.js` 每次启动都会把同名项强制覆盖回其设定值,所以最稳妥的做法是把手动验证有效的项固化到 `user.js`:

配置文件位于 `~/.zen/<ProfileName>/user.js`,完整内容:

```js
user_pref("media.hardware-video-decoding.enabled", true);
user_pref("media.hardware-video-decoding.force-enabled", true);
user_pref("media.ffmpeg.vaapi.enabled", true);
user_pref("media.vaapi.enabled", true);
user_pref("media.ffmpeg.low-power", false);
user_pref("gfx.webrender.all", true);
user_pref("gfx.webrender.compositor", true);
user_pref("gfx.webrender.software", false);
user_pref("layers.acceleration.force-enabled", true);
user_pref("media.rdd-process.enabled", true);
```

### 3. NVIDIA 专属: RDD 沙箱豁免

NVIDIA 闭源驱动无法在 Firefox 的 RDD(远程数据解码器)沙箱内直接访问,需要环境变量:

```bash
export MOZ_DISABLE_RDD_SANDBOX=1
```

若缺少该项,硬解开关即使开了也可能无法真正创建解码器。Intel / AMD 核显走标准 VA-API,不需要这个变量。

## 四、关于 user.js 与 about:config 的关系

| 项 | 存储位置 | 说明 |
|---|---|---|
| `about:config` 修改 | `prefs.js` | 运行时即时生效,会被 user.js 覆盖 |
| `user.js` | 配置文件目录下手动编辑 | 每次启动强制生效,最高优先级 |

- `user.js` 只能手动编辑,`about:config` 不会回写它。
- 有重叠项的设置(如 `gfx.webrender.all`),两边值要一致,否则 user.js 会覆盖 about:config 的改动。
- 注意区分 `media.hardware-video-decoding.enabled` 与 `.force-enabled` 两个 pref,含义不同,可并存。

## 五、配置存储位置与多 profile 说明

Zen/Firefox 的每个配置文件目录在 `~/.zen/` 或 `~/.mozilla/firefox/` 下,如 `by7xh645.Default (release)-1/`,其中:

- `prefs.js` — 运行时偏好(about:config 写入这里)
- `user.js` — 手动固化的启动覆盖项

一台机器出现多个 `*.Default*` 目录是正常的: Zen 每次以新方式安装会新建一个默认 profile,重名会加 `-1` 后缀;只有 `profiles.ini` 里标记当前生效的那个才是实际在用的。

## 六、验证结果

修复前日志全部是 `Using preferred software codec`,修复后变为 `Using preferred hardware codec`,且 RDD 广播 `H264/VP9/VP8/AV1/HEVC SWDEC HWDEC`;实测 `nvidia-smi` 解码引擎在播放时持续 2%~5% 活跃。

**结论: 成功从软解切换为硬解,视频解码由 GPU 完成。**
