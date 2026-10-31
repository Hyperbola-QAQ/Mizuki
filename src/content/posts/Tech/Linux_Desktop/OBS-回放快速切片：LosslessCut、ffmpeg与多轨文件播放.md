---
title: OBS 回放快速切片：LosslessCut、ffmpeg 与多轨文件播放
published: 2026-10-31
updated: 2026-10-31
pinned: false
description: 实测 ffmpeg -c copy 切片的真实精度(mp4 与 mkv 表现完全不同)、.llc 项目文件到底是什么、接触表快速摸片,以及四音轨回放的切换方法与三端硬解验证
tags: [Linux, Desktop, OBS, Video]
category: Desktop
author: Hyperbola
draft: false
series: OBS录屏调优
---

> 环境: Omarchy(Arch + Hyprland, Wayland), OBS Studio 33.0.1, ffmpeg 9.0.2, mpv 0.41.0, VLC 3.0.24, LosslessCut 3.70.2, Intel Iris Xe(i915 + xe)

## 背景

回放缓存存下来的是 8 分钟一整段,真正要留的往往只有几十秒。需求很朴素: 从一段满是垃圾的录像里挑几秒,切出来,不重新编码、不损失画质、别等。

顺带解决几个具体疑问: 导出的目录里为什么会多出一个 `.llc` 文件?四音轨的文件在播放器里怎么只听得到一条?

## 一、`.llc` 是什么

LosslessCut 的**项目文件**(LosslessCut Project),JSON 格式,记录你标好的切割区间:

```json
{
  "cutSegments": [
    { "start": 38, "end": 368.101 }
  ]
}
```

它跟成品的关系就一个: 下次打开 LosslessCut 时能接着上次的标记继续改。导出时文件名里那串 `-00.00.38.000-00.06.08.101.mp4` 就是这段区间的起止时间码,和 `.llc` 里的数字一一对应。

**删掉 `.llc` 不影响已导出的视频**,只是标记丢了。留着的好处是以后想改切点,不用重新对时间轴。

## 二、LosslessCut: 可视化切片的省事选择

```bash
pacman -S losslesscut-bin      # 3.70.2,装到 /usr/share/losslesscut
```

工作流就是拖进来 → 按 `[` `]` 标起止 → `E` 导出。它的两个关键设置:

- **关键帧对齐切割**(默认开): 和 `ffmpeg -c copy` 一个原理,不重编码,快,起点吸附到关键帧
- **智能切割**: 关掉对齐,改成重编码首尾少数帧 —— 精确但慢,而且 HEVC 重编码一次画质就掉一次

多音轨文件它也能正确处理: 导出时默认全轨保留,不需要额外设置。

适合的场景: 边看边标,一次切好几个片段。不适合的场景: 批量、脚本化。

## 三、命令行切片: `-c copy` 到底精确到哪

网上流传的说法是"`-ss` 放在 `-i` 前面会吸附到前一关键帧"。这句话**只对了一半**,而且对错取决于输出容器。实测一下。

先准备素材(从原片无损截 6 秒,顺便验证关键帧密度):

```bash
F=~/Videos/Recordings/OBS_Replays/"Replay 2026-10-31 14-40-34.mp4"
ffmpeg -v error -ss 100 -t 6 -i "$F" -map 0 -c copy t.mp4

ffprobe -v error -select_streams v:0 -show_entries packet=pts_time,flags \
  -of csv=p=0 t.mp4 | grep "K_" | head
```

```
0.000000,K__
1.000000,K__
2.000000,K__
3.000000,K__
4.000000,K__
5.000000,K__
6.000000,K__
```

一秒一个关键帧,和 `keyint_sec: 1` 对上了。

现在从 300.7 秒(故意落在关键帧中间)切 3 秒,分别输出 mp4 和 mkv:

```bash
ffmpeg -v error -y -ss 300.7 -t 3 -i "$F" -map 0 -c copy d.mp4
ffmpeg -v error -y -ss 300.7 -t 3 -i "$F" -map 0 -c copy e.mkv
```

结果差得很远:

| 输出 | 首包 pts | flags | 首帧实际内容 |
|---|---|---|---|
| `d.mp4` | `-0.700000` | `KD_` | **正好是 300.7 那一帧** |
| `e.mkv` | `0.053000` | `K__` | 是 300.0 那一帧(退回关键帧) |

首帧内容是用 md5 逐一比对的,不是靠眼睛:

```bash
ffmpeg -v error -y -i d.mp4 -frames:v 1 d0.png
ffmpeg -v error -y -ss 300.7 -i "$F" -frames:v 1 o3007.png
ffmpeg -v error -y -ss 300.0 -i "$F" -frames:v 1 o3000.png
md5sum d0.png o3007.png o3000.png
```

```
f01ee9b9...  d0.png        ← 和 o3007 相同
f01ee9b9...  o3007.png
6c5e5ef9...  o3000.png
```

所以真实机制是:

**mp4 输出时**,ffmpeg 从上一个关键帧(300.0)开始取包,但把 300.0~300.7 这段标成 `D`(discard),再通过 MP4 的 edit list 告诉播放器"从 0.7 秒开始播"。文件里带着 0.7 秒不会被显示的前导 GOP,所以**看起来多了一点体积**,但播放起点是精确的。

**mkv 没有 edit list 这种机制**,同样的命令就真的从关键帧起切了,起点误差最大等于一个 GOP(这里 0.7 秒)。

> ⚠️ 这就是"网上说会吸附到关键帧"的来源 —— 那个结论对 mkv 成立,对 mp4 不成立。选容器之前先想清楚要不要精确起点。
>
> 推论: `keyint_sec: 1` 在 mp4 输出下让切片精度直接变成帧级;如果容器是 mkv,1 秒关键帧意味着最大 1 秒误差。

### 顺带一个数字: 有多快

3 秒 1080p60 素材,`-c copy` 的 CPU 时间是 **0.005 秒**。基本等于"文件拷贝",这个量级下纠结批量脚本的性能没有意义。

## 四、要帧精确就重编码

`-c copy` 的尾部(`-t` 的结束点)只能落在包边界,理论上会差一帧。真要帧精确,或者需要去掉 mp4 里那段前导 GOP,就得重编码:

```bash
# -ss 放在 -i 后面 = 解码后精确切;首尾各重编码,中间仍然 copy
ffmpeg -y -i in.mp4 -ss 1.5 -t 2 -c:v hevc_qsv -global_quality 22 -c:a copy out.mp4
```

实测 2 秒素材的 CPU 时间是 **1.66 秒**,大部分花在 QSV 编码器初始化上 —— 切长片段时这个开销会被摊薄。

`-ss` 放 `-i` 之后是"解码侧 seek": 从头解码到目标点再丢弃,慢但精确;放前面是"输入侧 seek",快但依赖关键帧/edit list 机制。

有 QSV 就别用 `libx265`。同画质下 `hevc_qsv -global_quality 22` 的速度是 `libx265` 的十几倍,而这个片子本来就是 QSV 编的,重编一遍画质损失也最小。

## 五、快速摸清一段录像: 接触表

8 分钟里哪一段值得留?一帧帧拖太慢。生成一张缩略图墙,一眼扫完:

```bash
ffmpeg -v error -y -i "$F" \
  -vf "fps=1/20,scale=320:-1,tile=4x3" \
  -frames:v 1 sheet.png
```

- `fps=1/20` — 每 20 秒取一帧
- `tile=4x3` — 排成 4 列 3 行,一张图覆盖 12 × 20 = 240 秒
- 输出 1280×540,一张图就能定位"要的那段在第几格"

想覆盖整段 8 分钟就调成 `fps=1/40,tile=4x3`,或者干脆 `tile=6x4` 一次 24 格。

另一个思路是场景切换检测,只挑画面明显变化的时刻:

```bash
ffmpeg -hide_banner -i "$F" -vf "select=gt(scene\,0.4),showinfo" -f null - 2>&1 \
  | grep -oE "pts_time:[0-9.]+"
```

阈值 `0.4` 偏保守,适合"镜头切换"明显的素材;游戏录像这种画面一直在动的,得调到 `0.6` 以上才有意义,否则全是误报。

## 六、硬解播放

### 先确认硬解真的在工作

不装 `vainfo` 也有办法,直接用 ffmpeg 走一遍 VA-API:

```bash
ffmpeg -hide_banner -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 \
  -hwaccel_output_format vaapi -i "$F" -t 10 -f null -
```

```
frame=  600 fps=0.0 q=-0.0 Lsize=N/A time=00:00:10.00 bitrate=N/A speed= 26x
```

10 秒 1080p60 只需 0.38 秒,**26 倍实时**,说明 `hevc Main / yuv420p` 这个组合被核显完整支持。

开头那行 `UDTA parsing failed retrying raw` 是 `hybrid_mp4` 往 udta box 里塞了非标准元数据,ffmpeg 解析失败后自动回退 raw 模式,不影响解码,不用管。

### mpv

`~/.config/mpv/mpv.conf`:

```ini
hwdec=auto-safe
```

`auto-safe` 只在确定安全的解码器上启用硬件路径,比 `auto` 稳。想确认实际用了哪个:

```bash
mpv --hwdec=vaapi --msg-level=vd=v in.mp4 2>&1 | grep -i "using hardware decoding"
```

```
Using hardware decoding (vaapi).
```

> ⚠️ 别用 `--vo=null` 验证硬解。null 输出不接受硬件帧,mpv 会**退回软解**,日志里能看到它在 `Looking at hwdec hevc-vaapi...` 之后仍然选了 `yuv420p` 的软件格式。必须在图形会话里跑才准。

### VLC

```bash
vlc --avcodec-hw=vaapi in.mp4
```

界面上对应 工具 → 偏好设置 → 输入/编解码器 → 硬件加速解码 → `VA-API 视频解码器`。

### 四音轨文件怎么只听一条

这是拿到多轨录像后第一个会踩的坑: 播放器默认只播第一条音轨(全混),听起来没事,但你想单独听麦克风时就找不到入口。

| 播放器 | 切换方式 |
|---|---|
| mpv | 命令行 `--aid=3`(第 3 条音轨);播放中按 `#` 循环切换 |
| ffplay | `-ast 3` |
| VLC | 菜单 音频 → 音轨 → 选「Track 3」 |
| LosslessCut | 右侧音轨列表直接点选 |

调完之后实际听一遍,比看 `ffprobe` 输出靠谱 —— 比如轨 2 是桌面、轨 3 是麦克风,一听就分得出来。

## 七、一条实际的工作流

1. **接触表**扫一遍,定位大概区间
2. **LosslessCut** 拖进去精确标点(能实时听到每一条音轨)
3. 导出 `mp4`(不是 mkv),享受 edit list 带来的精确起点
4. 需要发给别人的话,`-map 0:a:0` 只留全混那条轨,文件小一半

第 4 步的命令:

```bash
ffmpeg -v error -ss 38 -t 330 -i in.mp4 -map 0:v -map 0:a:0 -c copy out.mp4
```

`-map 0:a:0` 只保留第一条音轨(全混),其余三条丢掉。

## 八、小结

- **`.llc` 是 LosslessCut 的项目文件**,删了不影响成品
- **`-c copy` 的精度取决于容器**: mp4 靠 edit list 能做到帧级精确(代价是带一段前导 GOP),mkv 会退回关键帧起点
- **`-ss` 在 `-i` 前还是后**,是"快而不准"和"准而慢"的分界
- **接触表比拖进度条快一个数量级**,`fps` + `tile` 两个参数就够
- **四音轨文件默认只播轨1**,切轨入口各播放器不同(mpv 按 `#`,VLC 走音频菜单)

同系列的另外三篇: 编码与回放缓存、音频四轨拆分、DockState 布局逆向。
