---
title: OBS 多音轨录制：把桌面、麦克风与采集卡拆成四条独立轨道
published: 2026-10-31
updated: 2026-10-31
pinned: false
description: 讲清 OBS 音频的"全局设备"与"场景内源"两套概念、mixers 位掩码怎么算四条轨,以及一套能真正证明四条轨互不串音的验证方法(含 -ss 位置与 amix 负权重的坑)
tags: [Linux, Desktop, OBS, Audio]
category: Desktop
author: Hyperbola
draft: false
series: OBS录屏调优
---

> 环境: Omarchy(Arch + Hyprland, Wayland), OBS Studio 33.0.1, PipeWire(pulse 兼容层), 内置声卡 `skl_hda_dsp_generic`(Speaker + Mic1), AVerMedia Live Gamer Ultra 2.1 采集卡

## 背景

默认 OBS 录出来只有一条音轨,桌面声、麦克风、采集卡的 HDMI 音频全糊在一起。后期想单独压低游戏声、或者把麦克风降噪,完全没得救。

目标: 录出来的文件里有四条独立音轨 —— 轨1 全混、轨2 桌面、轨3 麦克风、轨4 采集卡。轨1 留着是为了某些只认单轨的平台能直接丢进去。

## 一、"设备"和"源"是两套东西

这是把自己坑进去最深的一处。

OBS 里管音频的东西分两套:

| | 存在哪 | 例子 |
|---|---|---|
| **全局设备** | 场景集合 JSON(`basic/scenes/*.json`)的**顶层键** | `DesktopAudioDevice1`、`AuxAudioDevice1` |
| **场景内源** | 同一个 JSON 的 `sources` 数组 | 「音频输入采集(PulseAudio)」 |

全局设备不管你切到哪个场景都存在,混音器里固定那几条;场景内的音频源跟着场景走,可以有多条、可以单独加重采样/增益滤镜。

关键点: **全局设备的具体设备 ID 又存在 `basic.ini` 的 `[Audio]` 段**,键名和 JSON 里一样:

```ini
[Audio]
DesktopAudioDevice1=alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Speaker__sink
AuxAudioDevice1=alsa_input.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Mic1__source
MonitoringDeviceId=default
SampleRate=48000
ChannelSetup=Stereo
```

也就是说**两处都要有**:

1. `basic.ini` 的 `[Audio]` 段给出设备 ID(用哪个声卡/接口)
2. 场景集合 JSON 的顶层给出这个源的 `mixers`(进哪些轨)和显示名

> ⚠️ 一开始我只改了 `[Audio]` 段,以为配好了。实际上 OBS 在 JSON 里找不到 `DesktopAudioDevice1` 这个键时,会**回退到系统默认设备** —— 表现是"能出声",看起来像成功,实际用的不是你以为的那个设备。这类静默回退最难查。
>
> 键名是从二进制里确认的: `strings /usr/bin/obs | grep -i "DesktopAudioDevice"`。除了 `...Device1`,还支持 `AuxAudioDevice1` 到 `AuxAudioDevice4`,最多四路全局辅助音频。

## 二、混音器里为什么冒出 3 条

`Desktop Audio`(全局桌面)+ `Mic/Aux`(全局麦克风)+ 场景里那条「音频输入采集(PulseAudio)」(走采集卡的 HDMI 音频)= 3 条。

这里有个容易搞错的推论: **混音器有几条,不等于录出来有几条轨**。混音器是"有哪些声源",轨道是"这些声源往哪几个文件流里写"。两者靠下面的位掩码连起来。

采集卡的音频我特意用**场景内的源**而不是全局辅助设备 —— 因为采集卡拔插后设备号会变,场景内源可以单独禁用/重选,不影响其他场景。

## 三、轨道位掩码 mixers

每个声源在 UI 的「高级音频属性」里有一列「音轨」勾选框。存到 JSON 里就是 `mixers`,一个位掩码:

| 轨 | 位值 |
|---|---|
| 1 | 1 |
| 2 | 2 |
| 3 | 4 |
| 4 | 8 |
| 5 | 16 |
| 6 | 32 |

勾几条就按位或。当前配置:

| 声源 | `mixers` | 二进制 | 进哪几轨 |
|---|---|---|---|
| Desktop Audio | `3` | `0011` | 轨1 + 轨2 |
| Mic/Aux | `5` | `0101` | 轨1 + 轨3 |
| 音频输入采集(采集卡) | `9` | `1001` | 轨1 + 轨4 |

对应的 JSON 片段:

```json
"DesktopAudioDevice1": {
  "id": "pulse_output_capture",
  "name": "Desktop Audio",
  "mixers": 3
},
"AuxAudioDevice1": {
  "id": "pulse_input_capture",
  "name": "Mic/Aux",
  "mixers": 5
}
```

场景里那条:

```json
{
  "id": "pulse_input_capture",
  "name": "音频输入采集(PulseAudio)",
  "mixers": 9
}
```

顺带说一句 `mixers` 的上限: UI 里那个 `mixers=255` 的默认值只表示"**允许**进全部 6 条轨",和"实际录几条"毫无关系。录几条由 `RecTracks` 决定。

## 四、RecTracks 与两个陷阱

```ini
[AdvOut]
RecTracks=15          ; 1111 = 录轨1~轨4
RecEncoder=obs_qsv11_hevc
RecAudioEncoder=libfdk_aac
Track1Bitrate=160
Track2Bitrate=160
Track3Bitrate=160
Track4Bitrate=160
```

`RecTracks=15` 必须和上面的位掩码对得上: 只要有一个声源勾了轨4,而 `RecTracks` 没包含第 4 位,轨4 就是空文件。

> ⚠️ **陷阱一: 同一个 profile 里有两处 `RecTracks`。**
>
> ```
> 39: [SimpleOutput]  RecTracks=1
> 53: [AdvOut]        RecTracks=15
> ```
>
> 现在 `Mode=Advanced`,生效的是 `[AdvOut]` 的 15。但哪天在界面上切回「简单」输出模式,录制会**直接掉回单轨** —— 因为 `[SimpleOutput]` 那份还是 `1`。切模式前记得同步改。
>
> 顺便,`grep RecTracks` 会同时命中两行,别看错行号。

> ⚠️ **陷阱二: 千万不要在场景里再手动加一条 "音频输入采集(桌面)"。**
>
> 全局 `Desktop Audio` 已经在抓桌面了,再加一条就会有两个同名声源同时进轨1,音量翻倍、还可能出现回声。混音器里看到 4 条就该警觉。

## 五、验证: 怎么证明四条轨真的分开了

光看 `ffprobe` 列出 4 条 aac 流是不够的 —— 四条轨可能内容一模一样。要证明"分开",必须看电平。

### 第一步: 有几条流

```bash
F=~/Videos/Recordings/OBS_Replays/"Replay 2026-10-31 14-40-34.mp4"
ffprobe -v error -show_entries stream=index,codec_type,codec_name,channels -of csv=p=0 "$F"
```

```
0,hevc,video
1,aac,audio,2
2,aac,audio,2
3,aac,audio,2
4,aac,audio,2
```

四轨到位。

### 第二步: 对齐取段(这一步决定成败)

```bash
for i in 0 1 2 3; do
  ffmpeg -v error -y -i "$F" -ss 300 -t 12 -map 0:a:$i -c:a pcm_s16le /tmp/m$i.wav
done
```

> ⚠️ **`-ss` 必须放在 `-i` 后面。**
>
> 放在前面是"输入侧 seek",每条音频流会各自 seek 到自己附近的关键帧/AAC 帧边界上,四条轨之间会错开几十毫秒。这个错位在听感上完全听不出来,但会让后面任何相减/相关性计算彻底失效 —— 我第一轮就是这么误判的,四条轨全被算成"互不相关",看起来像四路不同的声音,其实只是没对齐。

输出侧 seek(`-ss` 在 `-i` 之后)会从头解码再丢弃,慢一点但四条轨严格同起点。12 秒的片段对这个文件也就多花一两秒。

### 第三步: 各轨电平

```bash
for i in 0 1 2 3; do
  printf "轨%d " $((i+1))
  ffmpeg -hide_banner -nostats -i /tmp/m$i.wav \
    -af volumedetect -f null - 2>&1 | grep -oE "mean_volume: [-0-9.]+ dB"
done
```

实测两个窗口:

| 窗口 | 轨1 全混 | 轨2 桌面 | 轨3 麦克风 | 轨4 采集卡 |
|---|---|---|---|---|
| 0–12 s | -27.0 dB | -36.3 dB | **-91.0(静音)** | -27.0 dB |
| 300–312 s | -26.6 dB | **-91.0(静音)** | -35.0 dB | -27.3 dB |

`-91.0 dB` 是 volumedetect 的下限,即数字静音。

这两行数据就是最强的证据:

- 300 秒处**桌面轨全静音**,而麦克风和采集卡还在录 —— 说明桌面声没有串进轨3/轨4
- 0 秒处**麦克风轨全静音**,而桌面和采集卡有声音 —— 反向也成立
- 轨4 的电平一直比其他轨低 7~10 dB,符合采集卡 HDMI 音量的实际水平

### 第四步: 证明轨1 就是另外三条之和

```bash
ffmpeg -hide_banner -nostats -i /tmp/m1.wav -i /tmp/m2.wav -i /tmp/m3.wav -i /tmp/m0.wav \
  -filter_complex "[0][1][2]amix=inputs=3:normalize=0[s];[s][3]amerge=inputs=2,pan=stereo|c0=c0-c2|c1=c1-c3,volumedetect" \
  -f null -
```

```
mean_volume: -43.4 dB      # 残差
max_volume: -19.4 dB
```

轨1 自身是 -26.6 dB,残差降到 -43.4 dB,抵消了 16.8 dB。剩下的这点残差正好是**三条独立 AAC 编码的量化噪声底之和** —— 轨1 是对混音整体编一次码,另外三条是分别编码后再相加,两者不可能逐比特相同。所以这个量级的残差反而说明配置是对的。

> ⚠️ **`amix` 的 `weights` 不接受负数。**
>
> 写 `weights=1 -1` 期望做减法,实际会被夹成正值,变成**求和**。表现是残差比原信号还高 6 dB(我第一次得到 -20.6 dB,而轨1 是 -26.6 dB,正好 +6 dB —— 那就是求和的特征)。要真的相减只能用 `amerge` + `pan` 做通道级减法。

## 六、副作用: 轨1 在瞬态处削顶

全片 `astats` 的峰值:

| 轨 | Peak level |
|---|---|
| 轨1 全混 | +1.6 dBFS |
| 轨2 桌面 | +1.8 dBFS |
| 轨3 麦克风 | +1.9 dBFS |
| 轨4 采集卡 | -13.6 dBFS |

前三条都超过 0 dBFS。超过的部分主要是 AAC 在瞬态处的解码过冲(有损编码的固有现象,不代表源就削了),但三个源都贴着满刻度说明**增益本来就偏高**,叠起来进轨1 确实有真实削顶风险。

两种处理,任选:

- 给桌面源和麦克风各加一个 -3 dB 的「增益」滤镜
- 或者开「限幅」(Limiter),阈值设 -1 dB

采集卡那路还有 13 dB 余量,不用动。

## 七、小结

- **全局设备的 ID 在 `basic.ini [Audio]`,`mixers` 在场景集合 JSON 顶层** —— 两处都要有,缺一处就静默回退系统默认
- **`mixers` 是位掩码**(1/2/4/8/16/32),`RecTracks` 是"录哪几轨"的另一个掩码,两者必须对得上
- **`[SimpleOutput]` 里还留着 `RecTracks=1`**,切回简单模式会掉回单轨
- **验证必须对齐**: `-ss` 放 `-i` 后面;相减不能用 `amix` 的负权重
- **"某轨在某个窗口全静音、同时其他轨有声音"** 比"四条轨电平不同"更有说服力

同系列的另外三篇: 编码与回放缓存、DockState 布局逆向、回放切片与硬解播放。
