---
title: OBS 回放缓存与 QSV HEVC 编码调优：CPU 占用从 81.9% 降到 21.8%
published: 2026-10-31
updated: 2026-10-31
pinned: false
description: 把 OBS 的回放缓存从 x264 软编码切到 QSV HEVC 硬编码,并把码率、关键帧间隔、容器格式一起调到位,附 recordEncoder.json 各字段含义与实测 CPU 占用对比
tags: [Linux, Desktop, OBS, Video, Hardware]
category: Desktop
author: Hyperbola
draft: false
series: OBS录屏调优
---

> 环境: Omarchy(Arch + Hyprland, Wayland), Intel Core i5-13500H(Iris Xe 核显, i915 + xe 双驱动), OBS Studio 33.0.1, ffmpeg 9.0.2, eDP-1 2880x1800@scale=2, AVerMedia Live Gamer Ultra 2.1 采集卡

## 背景

常驻开着回放缓存(Replay Buffer),打完一段想留就按快捷键把最近 10 分钟存下来。默认配置是 x264 软编码 + 6000 Kbps,1080p60 采集卡画面加本地桌面一起录的时候,CPU 直接顶到 80% 以上,游戏本身开始掉帧。

目标很简单: 画质够看、CPU 占用低、后面切片方便。

## 一、回放缓存到底存在哪

Replay Buffer 是纯内存环形缓冲,平时不落盘,只有按下保存键才把最近 N 秒写成一个文件出来。三个参数决定它的行为,都在 `[AdvOut]` 段:

| 键 | 当前值 | 含义 |
|---|---|---|
| `RecRB` | `true` | 开启回放缓存 |
| `RecRBTime` | `600` | 缓冲区覆盖的**时长**(秒) |
| `RecRBSize` | `2048` | 缓冲区占用的**内存上限**(MB) |

两个上限是"谁先到谁生效"。按 4000 Kbps 视频 + 4 条 160 Kbps 音频算,总码率约 4640 Kbps ≈ 580 KB/s:

- 按时间算: 600 s × 580 KB/s ≈ 340 MB
- 按内存算: 2048 MB 够装约 3500 秒

所以现在实际是**时长先到**,只保留最近 10 分钟,内存只用掉六分之一。想回溯半小时就把 `RecRBTime` 调成 `1800`,占用约 1 GB,内存还够。

> ⚠️ 别只把 `RecRBSize` 调大就以为能录更久 —— 时间上限卡在那儿,内存给再多也只是闲置。

## 二、换编码器: x264 → QSV HEVC

i5-13500H 的 Iris Xe 核显带 QSV,HEVC 编码器是白捡的性能。设置路径: 设置 → 输出 → 输出模式「高级」→ 录像 → 编码器。

改完 `[AdvOut]` 里是这样:

```ini
RecEncoder=obs_qsv11_hevc
RecFormat2=hybrid_mp4
RecAudioEncoder=libfdk_aac
RecTracks=15
```

实测对同一场景(1080p60 采集卡 + 桌面):

| | x264 | QSV HEVC |
|---|---|---|
| CPU 总占用 | 81.9% | 21.8% |
| 谁在干活 | CPU 单核接近满载 | 核显 Media Engine |
| 掉帧 | 有 | 无 |

代价是同码率下 QSV 的细节不如 x264 slow,但 4000 Kbps 的 1080p60 对"录个回放看看"完全够用。

### 编码器参数不在 basic.ini 里

这点最容易找错地方。「高级」模式 + 标准录像时,编码器参数存在**同目录下的另一个文件**:

```bash
cat ~/.config/obs-studio/basic/profiles/CaptureCard/recordEncoder.json
```

```json
{
    "rate_control": "CBR",
    "bitrate": 4000,
    "keyint_sec": 1,
    "profile": "main",
    "target_usage": "TU4",
    "bframes": 3,
    "latency": "normal"
}
```

几项的含义:

- `rate_control: CBR` — 恒定码率。回放缓存必须用它,否则 10 分钟的缓冲大小算不准
- `keyint_sec: 1` — **关键帧间隔按秒算**,1 秒一个 IDR。这一项对无损切片是决定性的
- `target_usage: TU4` — QSV 的速度/质量档。QSV 里 TU1 质量最好、TU7 最快,TU4 在中间。想更省 CPU 往 TU5/TU6 走,想更好看往 TU2 走
- `profile: main` — HEVC Main(8bit 4:2:0),和 `[Video]` 里的 `ColorFormat=NV12` 对得上

## 三、关键帧为什么要从 250 帧改成 1 秒

原来 x264 的 GOP 是 250 帧,60 fps 下等于 **4.17 秒一个关键帧**。

这直接决定后面怎么切片段。`ffmpeg -c copy` 只能从关键帧起切,4 秒一个关键帧意味着切片起点误差最大 4 秒,基本没法用。

改成 1 秒之后:

- 无损切片的起点误差 ≤ 1 秒
- 代价是 I 帧变密、同码率下画质略降。4000 Kbps CBR 下实测可接受
- 顺带让播放器拖进度条更跟手

> ⚠️ `keyint_sec` 是**秒**,不是帧。OBS 的 QSV 界面里只暴露秒,想按帧精确设得走自定义 FFmpeg 输出,不值得。

## 四、容器选 hybrid_mp4

OBS 33 的容器下拉里 `hybrid_mp4` 是一个相对新的选项(OBS 31 之后才有)。它本质是"带 frag 索引的可恢复 MP4":

- 崩溃/断电后文件仍然能播,不像老 mp4 那样 moov 没写完整个报废
- 兼容性比 mkv 好,剪辑软件和播放器都认
- 多音轨完整保留 —— 这一点对四轨录制是前提

用 ffmpeg 读它的时候会看到这么一行:

```
[in#0 @ 0x557a8df88d40] UDTA parsing failed retrying raw
```

这是 `hybrid_mp4` 往 udta box 里塞了非标准元数据,ffmpeg 解析失败后自动回退到 raw 模式,**不影响解码**。同一份文件用 VA-API 硬解 10 秒只花 0.38 秒(26x 实时),没有任何报错。

哪天要进 DaVinci 这类对容器挑剔的软件,`ffmpeg -i in.mp4 -c copy out.mp4` 重封装一次即可,不掉画质。

## 五、完整配置对照

`~/.config/obs-studio/basic/profiles/CaptureCard/basic.ini`:

```ini
[Output]
Mode=Advanced

[AdvOut]
RecType=Standard
RecFilePath=/home/hyperbola/Videos/Recordings/OBS_Replays
RecFormat2=hybrid_mp4
RecEncoder=obs_qsv11_hevc
RecAudioEncoder=libfdk_aac
RecTracks=15
RecRB=true
RecRBTime=600
RecRBSize=2048
Track1Bitrate=160
Track2Bitrate=160
Track3Bitrate=160
Track4Bitrate=160

[Video]
BaseCX=2560
BaseCY=1440
OutputCX=1920
OutputCY=1080
FPSCommon=60
ScaleType=bicubic
ColorFormat=NV12
ColorSpace=709
ColorRange=Partial
```

`BaseCX/BaseCY` 是画布(2560×1440,和 2880×1800 屏幕在 scale=2 下的逻辑分辨率对得上),`OutputCX/OutputCY` 是实际输出。采集卡本身给的就是 1080p,这一步不算二次损失。

## 六、验证

```bash
F=~/Videos/Recordings/OBS_Replays/"Replay 2026-10-31 14-40-34.mp4"

ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,bit_rate \
  -of default=nw=1 "$F"
```

```
codec_name=hevc
profile=Main
pix_fmt=yuv420p
width=1920
height=1080
r_frame_rate=60/1
bit_rate=1887517
```

注意 `bit_rate` 只有 1.88 Mbps,配置写的却是 CBR 4000 —— 这是**这段内容本身简单**(画面变化少)导致的。CBR 是上限不是填充,静态画面不会硬凑码率。

确认关键帧密度:

```bash
ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags \
  -of csv=p=0 "$F" | grep "K_" | head -10
```

一秒钟应该出现一个带 `K` 标记的包。

## 七、小结

几个容易走错的地方:

- **编码器参数不在 basic.ini**,在 `recordEncoder.json`。改错文件会以为没生效
- **`RecRBTime` 和 `RecRBSize` 谁先到谁生效**,默认是时间先到
- **关键帧间隔要按用途定**,录的时候就得想清楚后面要不要切片
- **QSV 的收益是数量级的** —— 21.8% 和 81.9% 的差别,对笔记本就是"能不能边录边玩"

同系列的另外三篇: 音频四轨拆分、DockState 布局逆向、回放切片与硬解播放。
