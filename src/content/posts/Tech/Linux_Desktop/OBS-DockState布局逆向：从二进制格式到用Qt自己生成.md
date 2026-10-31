---
title: OBS DockState 布局逆向：从二进制格式到用 Qt 自己生成
published: 2026-10-31
updated: 2026-10-31
pinned: false
description: 拆开 OBS 存在 user.ini 里的 DockState 二进制,搞清 QMainWindow::saveState 的序列化结构,再用一个 Qt 小程序让框架自己生成合法布局,附带金丝雀定位法与三个假阴性陷阱
tags: [Linux, Desktop, OBS, Reverse_Engineering, Qt]
category: Desktop
author: Hyperbola
draft: false
series: OBS录屏调优
---

> 环境: Omarchy(Arch + Hyprland, Wayland), OBS Studio 33.0.1, qt6-base 6.12.0, eDP-1 2880x1800@scale=2, g++ 16.2.1

## 背景

OBS 的默认工作区是这样的: 左栏只有 152 px 宽,来源名字全被截断;底栏 259 px 高,混音器、转场、控制按钮一字排开;中间预览区只剩 1260×527,16:9 的画面只占 937×527,左右各浪费 160 多像素的黑边。

想在界面里拖?可以拖,但拖不出"左栏固定 210、场景和来源按 1:2 分、统计和转场合并成标签页"这种结构 —— Qt 的拖拽只给你相邻分隔条,标签页要右键菜单一个个点。更麻烦的是每次不小心点到「重置界面」就全没了。

于是决定直接改配置文件。`user.ini` 里那行 `[BasicWindow] DockState=` 就是整个布局,一个 base64 字符串。

## 一、OBS 把布局存在哪

```ini
# ~/.config/obs-studio/user.ini
[BasicWindow]
DockState=AAAA/wAAAAD9AAAAAgAAAAAAAADSAAADFvwCAAAAAvsAAAAU...
geometry=AdnQywADAAAAAAAAAAAAAAAAArwAAANR...
```

OBS 启动时读它:

```cpp
// OBSBasic.cpp:1118
const char *dockStateStr = config_get_string(App()->GetUserConfig(), "BasicWindow", "DockState");

if (!dockStateStr) {
    on_resetDocks_triggered(true);
} else {
    QByteArray dockState = QByteArray::fromBase64(QByteArray(dockStateStr));
    if (!restoreState(dockState)) {
        on_resetDocks_triggered(true);
    }
}
```

这里藏着最坑的一点: **格式不对不会报错,直接静默重置成默认布局。**

`restoreState` 返回 `false` 就走 `on_resetDocks_triggered(true)`,日志里只有一行几乎看不见的 debug。你改了半天重启一看"没变化",其实是配置被丢掉了 —— 而且退出时它还会把重置后的布局写回去,看起来像是你的修改被覆盖。

关闭时写回:

```cpp
// OBSBasic.cpp:1750
config_set_string(App()->GetUserConfig(), "BasicWindow", "DockState",
                  saveState().toBase64().constData());
```

**这两段合起来决定了操作顺序: 必须等 OBS 完全退出后再改文件**,否则它退出时会拿内存里的旧布局盖掉你的。

## 二、DockState 的二进制格式

它没有自己的格式,就是 Qt `QMainWindow::saveState()` 的原始输出,大端 `QDataStream` 序列化。Qt 6.12 用的标记值(`StateMarkers`):

| 标记 | 含义 |
|---|---|
| `0xfd` | Widget — 主布局 / 区域主体 |
| `0xfc` | Sequence — 顺序排列;也用于嵌套子区域 |
| `0xfb` | Widget — 单个停靠面板 |
| `0xfa` | Tab — 标签组,后跟一个 int 表示当前页 |

主体结构:

```
u32  0xff                         标记
u32  version
u8   0xfd, u32 area_count         主布局 + 区域数
for each area:
    u32 dock_pos                  0=Left 1=Right 2=Top 3=Bottom
    i32 size_w, size_h            区域尺寸(左栏宽 / 底栏高就靠它)
    body
i32  central_w, central_h         中央控件尺寸
i32  corners[4]                   Qt::DockWidgetArea: 1=Left 2=Right 4=Top 8=Bottom
剩余字节                            工具栏等
```

其中 `body`:

```
[0xfa + i32 当前页 | 0xfc]        标签组 / 普通序列
u8   orient                        1=横 2=竖
u32  item_count
items:
    0xfb + QString(UTF-16BE, u32 长度前缀) + u8 flags + 4×i32
    0xfc + 4×i32 + body            嵌套标签组
```

`flags` 的两位有用: `0x01` 是否可见,`0x02` 是否浮动窗口。

## 三、一个能读懂它的解析器

只读解析比生成容易得多,先写这个把现状摸清楚:

```python
#!/usr/bin/env python3
"""读取 OBS DockState(Qt QMainWindow::saveState 的二进制)。"""
import struct, sys

POS    = {0: "Left", 1: "Right", 2: "Top", 3: "Bottom"}
CORNER = {1: "Left", 2: "Right", 4: "Top", 8: "Bottom"}
MAIN, SEQ, WIDGET, TAB = 0xFD, 0xFC, 0xFB, 0xFA


def i32(d, p):
    return struct.unpack_from(">i", d, p)[0]


def read_body(d, p):
    if d[p] == TAB:                      # 标签组
        p += 1
        cur = i32(d, p); p += 4
        tabbed = True
    else:                                # 普通序列
        assert d[p] == SEQ, "期望 0xfc/0xfa, 实际 0x%02x @%d" % (d[p], p)
        p += 1
        cur = None
        tabbed = False
    orient = d[p]; p += 1
    cnt = i32(d, p); p += 4
    items = []
    for _ in range(cnt):
        m = d[p]
        assert m in (WIDGET, SEQ), "期望 0xfb/0xfc, 实际 0x%02x @%d" % (m, p)
        p += 1
        if m == WIDGET:
            ln = i32(d, p); p += 4
            name = d[p:p + ln].decode("utf-16-be"); p += ln
            flags = d[p]; p += 1
            vals = [i32(d, p + 4 * k) for k in range(4)]; p += 16
            items.append({"name": name, "flags": flags, "vals": vals, "sub": None})
        else:
            vals = [i32(d, p + 4 * k) for k in range(4)]; p += 16
            sub, p = read_body(d, p)
            items.append({"name": "<标签组>", "flags": 0, "vals": vals, "sub": sub})
    return {"tabbed": tabbed, "cur": cur, "orient": orient, "items": items}, p


def parse(d):
    assert i32(d, 0) == 0xFF, "marker 不对"
    p = 8
    assert d[p] == MAIN
    p += 1
    n = i32(d, p); p += 4
    areas = []
    for _ in range(n):
        apos = i32(d, p); p += 4
        w, h = i32(d, p), i32(d, p + 4); p += 8
        body, p = read_body(d, p)
        body.update({"pos": apos, "size": [w, h]})
        areas.append(body)
    central = [i32(d, p), i32(d, p + 4)]; p += 8
    corners = [i32(d, p + 4 * k) for k in range(4)]; p += 16
    return areas, central, corners, d[p:]


if __name__ == "__main__":
    d = open(sys.argv[1], "rb").read()
    areas, central, corners, tail = parse(d)
    for a in areas:
        print("区域 %d (%s) size=%dx%d %s orient=%d" % (
            a["pos"], POS.get(a["pos"], "?"), a["size"][0], a["size"][1],
            ("标签组 cur=%s" % a["cur"]) if a["tabbed"] else "序列", a["orient"]))
        for it in a["items"]:
            if it["sub"]:
                print("   标签组 尺寸=%s" % (it["vals"][:2],))
                for s in it["sub"]["items"]:
                    print("      %-16s %s" % (s["name"], s["vals"]))
            else:
                print("   %-16s flags=0x%02x %s" % (it["name"], it["flags"], it["vals"]))
    print("中央 %dx%d" % tuple(central))
    print("corners=%s -> %s" % (corners, [CORNER.get(c, c) for c in corners]))
    print("尾部 %d 字节: %s" % (len(tail), tail.hex()))
    print("总长 %d 字节" % len(d))
```

用法:

```bash
grep "^DockState=" ~/.config/obs-studio/user.ini | sed 's/^DockState=//' | base64 -d > /tmp/dock.bin
python3 dockstate.py /tmp/dock.bin
```

OBS 的默认布局解析出来是这样:

```
区域 0 (Left) size=152x790
  序列 orient=2
    scenesDock       停靠 flags=0x01(visible) [26, 393, 135, 16777215]
    sourcesDock      停靠 flags=0x01(visible) [423, 393, 135, 16777215]
区域 3 (Bottom) size=1260x259
  序列 orient=1
    mixerDock        停靠 flags=0x01(visible) [156, 542, 243, 16777215]
    transitionsDock  停靠 flags=0x01(visible) [702, 303, 130, 16777215]
    controlsDock     停靠 flags=0x01(visible) [1009, 407, 175, 16777215]
    statsDock        浮窗 flags=0x02(HIDDEN) [370, 350, 700, 200]
中央 1260x527
corners=[1, 2, 1, 2] -> ['Left', 'Right', 'Left', 'Right']
尾部 5 字节: fc00000000
总长 342 字节
```

一眼就能看出问题在哪儿: 左栏 152、底栏 259、统计面板居然是个**隐藏的浮窗**、中央只剩 527 高。

四个 i32 依次是: 停靠状态下是 `[位置, 尺寸, 最小尺寸, 最大尺寸]`,浮窗状态下是 `[x, y, w, h]`。`16777215`(`0xFFFFFF`)就是"无最大尺寸限制"。

## 四、手拼二进制为什么不可靠

第一版我按上面的结构自己拼了一个 369 字节的 blob,自检脚本逐字节回放,解析结果完全符合预期。丢进 `user.ini`,重启 OBS——**布局没变**。

日志显示写进去了,退出后又被覆盖成 466 字符的默认值。也就是 `restoreState` 返回了 false。

结构能自洽但 Qt 不认,说明有些字段的含义比表格里写的更严格 —— 比如 `flags` 里那些看起来恒定的位(隐藏位、浮动位)、区域的序号、嵌套 `orient` 的取值,组合起来必须和 Qt 内部的 `DockAreaLayout` 状态一致。这些没法只靠"读一个样例"反推出来。

### 金丝雀定位法

与其继续猜,不如切片验证。做法是拿**默认布局**当底,一次只改一处,重启后回读,看改动能活下来几条:

1. 只把左栏 152 → 200,场景/来源 393/393 → 258/526 → **回读是 200 / 258 / 526,改动生效**
2. 再在底部把「统计」和「混音器」`tabify` 成标签组 → **回读退回默认,被拒**

结论很干净: **尺寸随便改都行,标签组才是被拒的原因**。这不是 `restoreState` 失败,是整份 blob 被拒了 —— 因为一个非法的标签组会连带整份作废。

换成「转场 + 统计」组成标签组(而不是「统计 + 混音器」),就被接受了。差别在于混音器本身是底部区域里最先被 `addDockWidget` 的那个,拿它当标签组的一员会改变区域的根节点结构。

## 五、让 Qt 自己生成

手拼的边界摸清之后就明白: **别跟二进制较劲,让框架自己写。**

OBS 的 DockState 本质就是 `QMainWindow::saveState()`,那我自己起一个 `QMainWindow`,摆出想要的布局,调 `saveState()`,拿到的就是合法产物 —— 同一套 Qt,同版本,不存在兼容问题。

```cpp
// obs-layout.cpp —— 用 Qt 自己生成 / 校验 OBS 的 DockState
// g++ -O1 -fPIC obs-layout.cpp -o obs-layout $(pkg-config --cflags --libs Qt6Widgets)
// QT_QPA_PLATFORM=offscreen ./obs-layout gen
// QT_QPA_PLATFORM=offscreen ./obs-layout verify <base64>

#include <QApplication>
#include <QDockWidget>
#include <QLabel>
#include <QMainWindow>
#include <QTextStream>

namespace {

struct Cfg {
    int leftW    = 210;   // 左栏总宽
    int scenesH  = 260;   // 场景面板高
    int sourcesH = 530;   // 来源面板高
    int bottomH  = 140;   // 底栏高度
    int mixerW   = 470;   // 混音器宽
    int transW   = 330;   // 转场(+统计 标签页)宽
    int ctrlW    = 402;   // 控制按钮宽
};

QDockWidget *mkDock(QMainWindow *w, const QString &name, const QSize &minSize)
{
    auto *d = new QDockWidget(name, w);
    d->setObjectName(name);          // 必须和 OBS 的 objectName 一模一样
    auto *l = new QLabel(name);
    l->setMinimumSize(minSize);
    d->setWidget(l);
    return d;
}

QMainWindow *build(const Cfg &c)
{
    auto *w = new QMainWindow;
    w->setObjectName("OBSBasic");

    // 关键点 1: 不加工具栏。OBS 自己写出的串尾部是 fc00000000,加工具栏就不是了

    auto *central = new QLabel("preview");
    central->setMinimumSize(160, 90);
    w->setCentralWidget(central);

    auto *scenes  = mkDock(w, "scenesDock",      QSize(120, 120));
    auto *sources = mkDock(w, "sourcesDock",     QSize(120, 120));
    auto *mixer   = mkDock(w, "mixerDock",       QSize(220, 90));
    auto *trans   = mkDock(w, "transitionsDock", QSize(126, 90));
    auto *ctrl    = mkDock(w, "controlsDock",    QSize(170, 50));
    auto *stats   = mkDock(w, "statsDock",       QSize(160, 90));

    // 关键点 2: 显式设 4 个 corner,否则左下/右下归底部区域,左栏不占满整列
    w->setCorner(Qt::TopLeftCorner,     Qt::LeftDockWidgetArea);
    w->setCorner(Qt::BottomLeftCorner,  Qt::LeftDockWidgetArea);
    w->setCorner(Qt::TopRightCorner,    Qt::RightDockWidgetArea);
    w->setCorner(Qt::BottomRightCorner, Qt::RightDockWidgetArea);

    w->addDockWidget(Qt::LeftDockWidgetArea, scenes);
    w->splitDockWidget(scenes, sources, Qt::Vertical);

    w->addDockWidget(Qt::BottomDockWidgetArea, mixer);
    w->splitDockWidget(mixer, trans, Qt::Horizontal);
    w->splitDockWidget(trans, ctrl, Qt::Horizontal);
    w->tabifyDockWidget(trans, stats);     // 转场 + 统计 组成标签组
    trans->raise();                        // 默认显示转场那一页

    // 关键点 3: 窗口尺寸要让"中部布局矩形"等于 OBS 的实际值 1202x790
    w->resize(1418, 790);
    w->show();                             // offscreen 平台,不弹窗

    w->resizeDocks({scenes}, {c.leftW}, Qt::Horizontal);
    w->resizeDocks({scenes, sources}, {c.scenesH, c.sourcesH}, Qt::Vertical);
    w->resizeDocks({mixer}, {c.bottomH}, Qt::Vertical);
    w->resizeDocks({mixer, trans, ctrl}, {c.mixerW, c.transW, c.ctrlW}, Qt::Horizontal);
    QApplication::processEvents();
    return w;
}

} // namespace

int main(int argc, char **argv)
{
    QApplication app(argc, argv);
    QTextStream out(stdout);
    const QString mode = argc > 1 ? argv[1] : "gen";

    if (mode == "gen") {
        auto *w = build(Cfg{});
        QByteArray state = w->saveState();
        out << "字节数 " << state.size() << "\n";
        out << "BASE64 " << QString::fromLatin1(state.toBase64()) << "\n";
        return 0;
    }
    if (mode == "verify") {
        auto blob = QByteArray::fromBase64(QByteArray(argv[2]));
        auto *w = build(Cfg{});
        bool ok = w->restoreState(blob);
        out << "restoreState: " << (ok ? "OK" : "失败") << "\n";
        return ok ? 0 : 1;
    }
    return 2;
}
```

三个关键点都要挨个踩过才知道:

- **不加工具栏**。加了之后 `saveState` 尾部会多出工具栏记录,OBS 那份没有,结构对不上
- **显式 `setCorner`**。Qt 默认把左下角给「底部区域」,结果是左栏只占上半截,场景面板量出来 210×197 而不是 210×790
- **窗口尺寸要凑**。`QMainWindow` 的内容区 = 窗口减工具栏减状态栏。OBS 的主布局矩形是 1202×790,对应窗口 1416×850(减 26 工具栏 + 34 状态栏)。生成器里不画工具栏,就得把窗口设成 1418×790,让内容区正好落在 1202×790

`resizeDocks` 之后必须 `processEvents()`,否则尺寸还没结算就去 `saveState()`,拿到的是初始比例。

## 六、写入与生效时机

生成出来 492 字符(369 字节),`md5 0da65957a8551e78202ef86b63be55ed`。写进 `user.ini`:

```python
# obs-apply.py —— 只替换 DockState 行,其余原样保留
import os, sys, tempfile

ini = os.path.expanduser("~/.config/obs-studio/user.ini")
b64 = open(sys.argv[1]).read().strip()
lines = open(ini).read().splitlines(keepends=True)
out = ["DockState=%s\n" % b64 if l.startswith("DockState=") else l for l in lines]

fd, tmp = tempfile.mkstemp(dir=os.path.dirname(ini))
with os.fdopen(fd, "w") as f:
    f.writelines(out)
os.replace(tmp, ini)          # 原子替换,避免半截文件
```

用 `os.replace` 做原子替换,不要原地 `open(...,"w")` —— OBS 崩在中途就得到一个空 ini。

> ⚠️ **顺序是硬性的: 先关 OBS,再写文件,再启动。**
>
> 只要 OBS 还活着,它退出时会用内存里的布局盖掉你写的东西(见第一节那段 `config_set_string`)。第一轮我就是只把文件传上去了、等用户自己关 OBS,结果被覆盖,看起来"改了没效果"。
>
> 需要自动化的场合,可以用 `pgrep -x obs` 轮询到进程消失后再写入:
>
> ```bash
> while pgrep -x obs >/dev/null; do sleep 2; done
> python3 obs-apply.py ~/.cache/tab.b64
> obs &
> ```

## 七、踩坑合集

### Hyprland 平铺造成的假阴性

用 `hyprctl dispatch` 在宿主会话里启动 OBS 验证时,新窗口被 dwindle 平铺成半屏(701 px 宽)。Qt 在窗口太窄时会**按比例压缩所有停靠面板**,回读出来的"左栏 161"根本不是我写的 210 —— 数据看着像配置没生效,实际是窗口尺寸不对。

验证前先确认窗口状态:

```bash
hyprctl clients -j | jq '.[] | select(.class=="obs") | {size, floating}'
```

`floating: false` 且 `size` 明显小于预期,就先把它浮起来或手动 resize,再谈布局。

### geometry 是另一套数据

`user.ini` 里还有一行 `geometry=`(`QWidget::saveGeometry` 的 base64,magic `01d9d0cb` + version 3),记录窗口的位置和尺寸。它和 DockState 完全独立 —— 改 DockState 不会动它。

但两者要**量级对得上**: DockState 里的值是绝对像素,当窗口实际宽度远小于这些像素之和时,Qt 会等比压缩。测试期间被杀掉的进程把 700×849 写了进去,得手动把它改回 1416:

```python
# 把 geometry 里的 0x2bc(700) 换成 0x588(1416)
import base64
s = open("geom.b64").read().strip()
b = base64.b64decode(s)
print(base64.b64encode(b.replace(b"\x00\x00\x02\xbc", b"\x00\x00\x05\x88")).decode())
```

### 别指望截图自证

`grim` 在这台机器的 Hyprland 0.57 上直接挂死(ssh 里 timeout、宿主会话里也 timeout)。想靠截图对比布局这条路走不通,老老实实回读 DockState + `hyprctl clients -j` 对尺寸,比截图可靠也快得多。

## 八、成果对照

| 项目 | 默认 | 现在 |
|---|---|---|
| 左栏宽 | 152 | **210** |
| 场景面板高 | 393 | 258 |
| 来源面板高 | 393 | **526**(来源列表看得全) |
| 底栏高 | 259 | **140** |
| 混音器宽 | 542 | 465 |
| 转场 / 控制 | 303 / 407 | **327(转场+统计 标签组)** / 398 |
| 统计面板 | 隐藏浮窗 | 并入标签组,可切换 |
| 中央预览区 | 1260×527 | 1202×644 |
| 16:9 画面实占 | 937×527 | **1145×644**(+49% 面积) |
| 左右黑边 | 323 px | 57 px |

预览区宽度从 1260 降到 1202 是让给左栏的代价,但高度从 527 涨到 644,画面尺寸反而大了近一半 —— 因为默认布局里黑边实在太浪费。

## 九、小结

- **OBS 的布局就是 Qt 的 `saveState()`**,没有私有格式。理解这一点之后整件事就简单了
- **`restoreState` 失败是静默的**,直接重置成默认。改完必须回读验证,不能靠"重启看看"
- **手拼二进制不划算**。结构能读懂不等于能写对,让同版本 Qt 生成才是正解
- **改文件必须在 OBS 退出后**,否则被退出时的写回覆盖
- **窗口尺寸会按比例压缩面板**,测量前先确认 OBS 窗口没被平铺

同系列的另外三篇: 编码与回放缓存、音频四轨拆分、回放切片与硬解播放。
