---
title: 在 Linux 上运行 world.execute(me) PV 项目：字体、Chromium 与 Python 3.14 排障记录
published: 2026-10-25
updated: 2026-10-25
pinned: false
description: 记录一次代码渲染音乐 PV 的完整运行过程，包括 Linux 字体替换、Playwright 浏览器路径、Python 3.14 audioop 兼容和断点续跑。
tags: [Python, Linux, Playwright, FFmpeg]
category: Development
author: Hyperbola
draft: false
---

# 这次跑的是什么

10 月 22 日，我在 Linux 上运行了 [MisakaZentai/world-execute-me-dsh-pv](https://github.com/MisakaZentai/world-execute-me-dsh-pv)，最后生成一段约 3 分 32 秒的音乐 PV。这篇文章在 10 月 25 日整理，记录当时的环境和实际遇到的问题。

这个项目不是打开一个网页播放动画，而是把歌曲时间映射成画面，再编码成视频。左侧聊天窗口由 HTML 页面和 Playwright 截图生成，右侧 TUI 画面使用 Pillow 绘制，最后交给 FFmpeg 合成。

本次使用的仓库提交是 `a598092a1b1db91fa43961a81269353d13419f6f`。代码默认考虑了 Windows 字体，在 Linux 上运行还需要配置字体和浏览器。重建版本使用项目提供的替身舞者，与作者发布的原片存在差异。

最终产物为 1280×720、24 fps 的 H.264/AAC 视频，容器时长 211.900 秒，文件大小 82,399,696 字节，约 78.6 MiB。另有约 630 MiB 的无损视频母版。

# 环境和输入

这次实际用到了以下组件：

| 组件 | 本次环境或用途 |
| --- | --- |
| Python | 3.14.8，通过 uv 创建项目虚拟环境 |
| Python 依赖 | Pillow 13.0.0、NumPy 2.5.4 |
| Node.js | 26.12.1 |
| Playwright | 项目固定为 1.63.0 |
| Chromium | 复用本机已有的 Playwright Chromium 缓存 |
| FFmpeg / ffprobe | 音频转换、视频编码和产物检查 |
| tmux | 保持一次性构建任务在后台运行 |

项目要求自备 `input/song.mp3`，不附带歌曲与完整歌词。我本地已有对应歌曲的 FLAC，时长为 211.906667 秒，与项目记录的 211.913 秒接近，因此用 FFmpeg 转为 320 kbps MP3：

```bash
ffmpeg -i /path/to/song.flac \
  -codec:a libmp3lame -b:a 320k input/song.mp3
```

这里的输入路径需要替换成自己的合法音频文件。转换后文件的 SHA-256 与项目原始音频不同，检查脚本会提示，但允许继续运行。**时长接近不能证明起唱点或每一处歌词都对齐**，这次没有做逐字音画验收。

# 准备依赖和字体

项目克隆到 `~/Projects/world-execute-me-dsh-pv`，Python 依赖装进 `.venv`，没有安装到系统 Python 环境：

```bash
mkdir -p ~/Projects
git clone https://github.com/MisakaZentai/world-execute-me-dsh-pv.git \
  ~/Projects/world-execute-me-dsh-pv
cd ~/Projects/world-execute-me-dsh-pv

uv venv .venv
uv pip install --python .venv/bin/python -r requirements.txt
npm install
```

上面使用项目当前分支；要对照本文代码，应检查提交号是否与前文一致。重新安装时，应优先使用已经配置的可信国内镜像，确认版本和完整性要求不变；镜像缺少对应版本或连接失败，再回退官方源。本次实际从 npm 官方源安装，过程出现了下载停顿和连接重置，显式设置代理后最终完成。这只能证明那次下载恢复，不能据此断定所有停顿都由代理配置引起。

Python 渲染器默认寻找 Consolas、微软雅黑和 Segoe UI Symbol 等 Windows 字体。在 Linux 上通过环境变量指定替代文件即可，本次使用：

```bash
export PV_F_MONO=/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf
export PV_F_MONO_B=/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Bold.ttf
export PV_F_CJK=/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc
export PV_F_SYM=/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf
```

这些是本机路径，不能直接当成其他发行版的标准路径。可以先用 `fc-list :lang=zh file` 查找中文字体，再检查所选文件是否存在。

`PV_F_SYM` 这次也指向了等宽字体；成片抽查通过，但没有逐个核对全部数学符号。对符号覆盖有要求时，应另选覆盖对应字符的字体。Chromium 页面使用系统字体回退，其换行和字宽也可能与 Windows 原片不同。

# Chromium 路径只改一处，会在后段再次失败

按 README 安装浏览器的命令是：

```bash
npx playwright install chromium
```

这次下载较慢，而本机已有 Chromium 缓存，于是先尝试复用已有浏览器。截图脚本原来直接调用：

```javascript
const browser = await chromium.launch();
```

我将它改成允许通过环境变量传入路径：

```javascript
const browser = await chromium.launch({
  executablePath: process.env.PV_CHROMIUM_PATH || undefined,
});
```

随后把 `PV_CHROMIUM_PATH` 指向本机已有浏览器的可执行文件，并用 Playwright 实际启动、创建页面和关闭浏览器。这个最小验证通过后，前面的截图也顺利生成。

但第一次构建仍在 `batch_g.py` 停止。日志显示，Python 在 `measure()` 中通过 `subprocess.run()` 执行了一段内嵌 JavaScript，最终抛出 `CalledProcessError`。这个脚本也启动 Chromium，却没有读取前面设置的路径。

因此，**单独验证截图入口可用，并不能覆盖整个构建的浏览器调用链**。随后搜索所有启动位置：

```bash
rg -n 'chromium.launch|playwright' \
  film/pv_dsh_frontend_20260927 \
  --glob '*.py' --glob '*.mjs'
```

当时找到三个位置：`seg_shot.mjs`、`batch_g.py` 的内嵌 JavaScript，以及 `mem_shot.mjs`。后两处也改为读取 `PV_CHROMIUM_PATH`，修复后 G 段完成，日志输出了光标测量结果和 `done 5087`。

已有缓存与 Playwright 1.63.0 预期下载的浏览器版本不同。本次启动和截图实际通过，不代表任意缓存版本都兼容。长期复现仍应优先安装项目对应版本的浏览器；指定路径属于这次经过验证的本机方案。

# Python 3.14 的 audioop 兼容层不能漏掉

修复 G 段后，我直接执行后续脚本续跑，又在 `batch_f.py` 遇到：

```text
ModuleNotFoundError: No module named 'audioop'
```

调用链最终进入 `film/tui_pv_world_execute_20260926/full/music.py` 的 `import audioop`。这次虚拟环境使用 Python 3.14.8，系统标准库里没有该模块。

仓库已经提供 `film/pv_dsh_frontend_20260927/gpu_shim/audioop.py`，`build.py` 也会在较新 Python 环境下，把这个目录加入子进程的 `PYTHONPATH`。问题出在手动续跑：直接启动 `batch_f.py` 绕过了这一层环境设置。

修复方法是在续跑脚本里显式导出兼容层路径，确保路径是绝对路径：

```bash
export PYTHONPATH="$PWD/film/pv_dsh_frontend_20260927/gpu_shim${PYTHONPATH:+:$PYTHONPATH}"
```

这条命令应在项目根目录执行，再进入子目录运行脚本。修复后 F 段生成 708 帧描述，截图阶段输出 `done 4247`，随后成功进入母版渲染。

这次没有必要重新安装一个同名模块，也没有修改业务渲染逻辑。先看构建入口如何准备环境，比直接根据异常安装依赖更有用。

# 歌词接口返回 503 时，保留同一条目和内容校验

项目默认从 LRCLIB 的条目 `36914646` 获取歌词。直接请求该条目时返回 HTTP 503，重试、增加查询参数以及绕过代理直连，仍然失败。

后续尝试搜索接口成功，返回结果中包含同一个条目。处理时按 ID 精确选取，写入 `input/lyrics.lrc`，再交给项目合成：

```bash
.venv/bin/python build.py lyrics
```

这一步没有换成其他版本的歌词。脚本输出显示，生成的两份文件都与项目记录的哈希一致：

```text
lyrics_synced.lrc: identical to the film's file (sha256 29ae04a89b13...)
word_timeline.json: identical to the film's file (sha256 82ad7af9d28f...)
```

这些结果验证了合成数据与项目预期一致，不能替代对本地音频时间偏移的检查。503 的服务端原因没有进一步确认，能确定的是：当时详情接口失败，搜索接口可以取回同一个条目的数据。

# 从失败步骤续跑

首次启动采用 `build.py all --workers 12`，但一条命令包含检查、歌词、舞者、页面和视频多个阶段。某个阶段失败后，不必把已经完成的缓存全部重做。

第一次失败前，前段页面截图已经生成。修复浏览器路径后，先运行 G 段及其截图，再继续 F 段。F 段修复兼容层后，最终续跑的主要步骤如下，前提是前面的页面和舞者缓存已经完整存在：

```bash
cd ~/Projects/world-execute-me-dsh-pv
project_root="$PWD"
export PYTHONPATH="$project_root/film/pv_dsh_frontend_20260927/gpu_shim${PYTHONPATH:+:$PYTHONPATH}"

# 还需要保留前文的字体和 PV_CHROMIUM_PATH 环境变量。
cd film/pv_dsh_frontend_20260927
"$project_root/.venv/bin/python" batch_f.py
node seg_shot.mjs f_frames.json

cd "$project_root"
.venv/bin/python build.py render --workers 12
```

运行时将命令放进 `/tmp` 下的一次性脚本，通过独立的 tmux 会话启动，并记录日志和退出码。这样关闭终端不会直接终止任务，也能在任务退出后判断成功或失败。机器重启后，tmux 和 `/tmp` 都不能当作可靠的恢复机制。

这次前两个后台任务确实失败退出过。只看到“后台任务已启动”就结束观察，会把失败误认为还在计算。后续同时检查进程、日志和产物，才确认进入真正的渲染阶段。

12 个分段完成后，`build.py` 生成无损母版，再混入歌曲和提示音，转换为 H.264/AAC 播放版本。最终日志为：

```text
done: .../out/film.mp4
```

退出码为 `0`。

# 如何确认这次确实完成了

除了构建退出码，我还检查了容器和流信息：

```bash
ffprobe -v error \
  -show_entries format=duration,size:stream=codec_name,codec_type,width,height,r_frame_rate,duration \
  -of json out/film.mp4
```

实际结果是视频 H.264、1280×720、24 fps、211.875 秒，音频 AAC、211.900 秒，容器时长 211.900 秒。

再把整个文件解码到空输出，检查是否存在解码错误：

```bash
ffmpeg -v error -i out/film.mp4 -f null -
```

命令退出码为 `0`，没有错误输出。另抽查了第 10 秒的聊天窗口画面和第 60 秒的字符舞者画面，确认不是空白视频，中文、终端文字和主要画面元素能够显示。

验证范围止于完整解码、流信息和这两个时刻的画面抽查。没有逐帧审片，也没有逐字确认音画同步，不能把“成功出片”写成与作者原片完全一致。

# 清理与复盘

体验结束后，我删除了这次克隆的项目目录，其中包括 `.venv`、`node_modules`、字体环境之外的本地脚本修改、下载到项目内的歌词、音频副本、截图缓存和两份视频；原音乐库文件保留。临时任务文件也一并清理，博客只保留操作记录，不附带歌曲、歌词、截图或成片。

如果照着复现后也要清理，先确认目标目录只属于这次体验，并检查是否有需要保留的源码或产物。删除整个目录无法靠该目录内的 Git 恢复未提交文件，需要事先另存；不要把这里的清理范围套用到已有开发项目。

这次最有用的经验是：跨平台运行要检查完整调用链；手动续跑要继承构建入口准备的环境；后台任务要以进程和退出码判断状态。最终是否完成，则要回到实际文件、解码结果和画面本身验证。
