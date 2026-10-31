# Hyprland-CapsLock后首键被吞：鼠标HID键盘接口污染按键状态

## 现象

在 ThinkBook（LENOVO 21HW）上，**切换 CapsLock 后，紧随其后的第一个按键没有输出**，必须再按一次才能打出来。

特征：

- 不限于字母，a / b / c 任意键都一样
- 不限于某个应用，终端、编辑器、浏览器一致
- **间歇性**：有时突然出现，有时又自己好了
- 切到 TTY（Ctrl+Alt+F3）完全正常
- 同一版本（Hyprland 0.57.0）的台式机完全正常

初看像是输入法吞键、键盘硬件故障，或者 Hyprland 版本回退。实际都不是。

## 环境

| 项 | 值 |
|---|---|
| 机器 | LENOVO 21HW（ThinkBook） |
| 系统 | Arch Linux + Omarchy 4.0.3 |
| 合成器 | Hyprland 0.57.0（Lua 配置） |
| 输入法 | fcitx5 5.1.23 + Rime（systemd 用户服务 `omarchy-fcitx5.service`） |
| 键盘 | 内置 PS/2（`AT Translated Set 2 keyboard`，isa0060/serio0） |
| 鼠标 | EWEADN E7（USB，`a8a5:2255`） |
| libinput | 1.32.0 |

## 结论

**元凶是 EWEADN 鼠标。**

它作为鼠标，却在系统里额外注册了 **3 个 HID 键盘接口**。这些接口的按键状态会残留「按下未释放」的记录，而 Hyprland 自 v0.51.0 起在 `shareKeyFromAllKBs()` 中**合并所有键盘设备的按键状态**——只要任一键盘仍报告某键被按住，真实键盘的同键事件就会被丢弃。

拔掉鼠标 → 问题立即消失。禁用那 3 个接口 → 鼠标照样能用，键盘恢复正常。

## 排查过程

按「从底层到上层」逐层排除，每一步都有实测依据。

### 1. 硬件与内核层：TTY 正常

切到 TTY 后按键完全正常。TTY 走内核 keymap，不经过 Hyprland。这一步直接排除了键盘硬件、atkbd 驱动、EC 固件。

### 2. 版本通用性：台式机同版本正常

台式机（Gigabyte B650M AORUS PRO AX）同样是 Hyprland 0.57.0 + Omarchy + fcitx5，一切正常。所以不是 0.57 的通用回归，而是这台笔记本的特定条件触发。

### 3. 配置层：全部干净

```bash
hyprctl getoption input:kb_options   # str: （空），set: true
hyprctl configerrors                 # 空
hyprctl devices -j                   # 所有键盘 keymap 均为 us / English (US)
```

- 没有 keyd / kanata / xremap / interception
- 没有自定义 udev 规则、没有 hwdb 覆盖
- `~/.config/hypr/input.lua` 里显式写了 `kb_options = ""`，把 Omarchy 默认的 `compose:caps,shift:both_capslock_cancel` 覆盖掉了

> 顺带排除一个常见的坑：网上流传很广的「Omarchy 把 Caps 改成 Compose 键导致吞键」并不适用，因为这里的 `kb_options` 已经是空字符串。

### 4. keybind 与 submap

```bash
hyprctl submap                      # default
hyprctl binds -j                    # 250 条，无 CAPS / SHIFT 组合
                                    # 无修饰键的 bind 只有媒体键和 PRINT
```

不是快捷键劫持。

### 5. 输入法层：停掉 fcitx5 仍复现

```bash
systemctl --user stop omarchy-fcitx5
```

停掉后问题依旧。**fcitx5 / Rime 完全无罪**，之前怀疑的 librime `ascii_composer` 处理 Caps_Lock 的已知问题与本次无关。

### 6. libinput quirks

```bash
grep -rl "21HW\|ThinkBook\|LENOVO" /usr/share/libinput/
```

`50-system-lenovo.quirks` 里全是 ThinkPad 的触摸板/指点杆规则，没有匹配 ThinkBook 键盘的；HP 那些按 `AT Translated Set 2 keyboard` 名称匹配的规则同时受 `MatchDMIModalias` 限制，不会误伤。

### 7. 关键一步：用 wev 抓 Wayland 层事件

前面所有排除都是间接证据，真正定性靠的是 `wev`——它作为 Wayland 客户端，能直接显示**合成器实际转发了什么**。

安装与启动（通过 SSH 启动时有两个坑）：

```bash
sudo pacman -S wev

export XDG_RUNTIME_DIR=/run/user/1000
export WAYLAND_DISPLAY=wayland-1
export XDG_SESSION_TYPE=wayland

# 必须加 stdbuf -o0，否则 stdout 重定向到文件后变成全缓冲，日志一直是空的
setsid nohup stdbuf -o0 wev > /tmp/wev.log 2>&1 < /dev/null &
```

在 wev 窗口里操作，然后读日志：

```bash
grep -E "wl_keyboard\] (key|modifiers)" -A3 /tmp/wev.log
```

**实测结果**（fcitx5 已停止，焦点全程在 wev）：

```
key: 66; state: 1 (pressed)   sym: Caps_Lock
modifiers: depressed: Lock; locked: Lock Mod2      ← Caps 正常生效
key: 66; state: 0 (released)  sym: Caps_Lock
modifiers: locked: Mod2                             ← 正常解除

（此后再无任何 key 事件 —— a / b / c 全部消失）
```

连做 3 组「CapsLock → 字母」，**3 个字母一个都没到达客户端**，而 3 次 CapsLock 的按下/释放全部完整。

### 8. 两个判读技巧（很重要）

**技巧一：用时间间隔判断用户是否重按了。**

早期日志里看到「Caps 后第一个字母正常出现」，差点误判为没问题。但看时间戳：

```
Caps 释放 (6729475) → 第一个 a 按下 (6732768)   间隔 3293 ms
第一个 a 释放       → 第二个 a 按下 (6733885)   间隔  983 ms
```

正常打字不可能隔 3.3 秒才按第一个键。真实情况是**第一下被吞了，用户等了三秒发现没出来才重按**——日志里那个「第一个」其实是用户的第二次按键。

修复后同样的操作间隔是 **313 ms**，这才正常。

**技巧二：必须核对焦点事件。**

有一次测试出现「组1 的按键全丢、只有最后一个字母到达」，看似严重。查 `enter`/`leave` 发现：

```
leave: serial 3216     ← 用户按 Super 切走了窗口
enter: serial 3813
key: 40 (D) state: 0   ← 只有 release 没有 press，典型的跨焦点现象
```

那段时间焦点不在 wev 上，按键都发给了别的窗口，**测试数据无效**。判断任何「事件丢失」前，先确认期间没有 `leave`。

### 9. 锁定鼠标：拔掉即恢复

```bash
# 拔掉鼠标后
hyprctl devices -j | jq '.keyboards | length'   # 12 → 8
```

拔掉 EWEADN 后立刻测试 CapsLock → a：

```
Caps 释放 → a 按下：313 ms
sym: A (65), utf8: 'A'          ← 正常到达
```

**问题消失。** 插回去复现，拔掉恢复——因果关系确凿。

## 根因分析

设备拓扑上，这台机器有 12 个「键盘」：

```
at-translated-set-2-keyboard      ← 唯一真正的键盘（内置 PS/2）
yjx-chip-eweadn-e7                ← EWEADN 鼠标接口 1
yjx-chip-eweadn-e7-keyboard       ← EWEADN 鼠标接口 2
yjx-chip-eweadn-e7-1              ← EWEADN 鼠标接口 3
nuvoton-hid-keyboard              ← USB 0416:0123
ideapad-extra-buttons
intel-hid-events
intel-hid-5-button-array
power-button / sleep-button
video-bus
hl-virtual-keyboard-fcitx5
```

EWEADN 是鼠标（`a8a5:2255`），但它向系统注册了三个 HID 键盘接口——常见于带宏键的游戏鼠标。

Hyprland 自 v0.51.0（PR #11214）引入的 `shareKeyFromAllKBs()`，会遍历所有启用的键盘，检查该键是否被按下：

```cpp
// src/managers/input/InputManager.cpp
bool CInputManager::shareKeyFromAllKBs(uint32_t key, bool pressed) {
    bool finalState = pressed;
    if (finalState) return finalState;
    for (auto const& kb : m_keyboards) {
        if (!kb->shareStates()) continue;
        if (kb->isVirtual() && shouldIgnoreVirtualKeyboard(kb)) continue;
        if (!kb->m_enabled) continue;
        if (kb->getPressed(key)) return true;   // 别的键盘还按着 → 视为仍在按下
    }
    return finalState;
}
```

一旦某个鼠标接口的 `m_pressed` 里残留了某键（宏键状态未清、或丢过一次 release），这个 stale 记录**永远不会自己消失**，于是真实键盘的同键事件被持续吞掉，直到该设备被移除。

这也解释了所有「反常」：

| 现象 | 解释 |
|---|---|
| 间歇性出现/消失 | 取决于鼠标接口何时残留了 stale 状态、何时被重新枚举清掉 |
| 切 TTY 正常 | TTY 不经过 Hyprland |
| 台式机正常 | 台式机没接这个鼠标 |
| 只有 Caps 后明显 | Caps 切换放大了问题（锁定态变化后紧跟的按键最容易踩中） |
| 所有键都可能丢 | stale 的不止一个键 |

上游有同源报告：[hyprwm/Hyprland#16275](https://github.com/hyprwm/Hyprland/discussions/16275)（自 v0.51.0 起）。该 issue 记录的症状是「键卡住持续重复」（release 被吞），本机表现为「press 被吞」，但根因是同一个函数对多键盘状态的合并逻辑。

## 解决方案

在 `~/.config/hypr/input.lua` 末尾追加：

```lua
-- EWEADN mouse (a8a5:2255) exposes 3 extra HID keyboard interfaces whose
-- pressed-key state goes stale. Hyprland merges key state across all keyboards
-- (shareKeyFromAllKBs, v0.51.0+), so a stale entry there makes the real keyboard
-- lose same-key events -- symptom: first key after CapsLock toggle is swallowed.
-- Disable only those interfaces; the mouse is a separate pointing device.
hl.device({ name = "yjx-chip-eweadn-e7", enabled = false })
hl.device({ name = "yjx-chip-eweadn-e7-keyboard", enabled = false })
hl.device({ name = "yjx-chip-eweadn-e7-1", enabled = false })
```

然后：

```bash
hyprctl reload
hyprctl configerrors      # 应为空
```

**为什么这样有效**：`shareKeyFromAllKBs()` 里有 `if (!kb->m_enabled) continue;`，被禁用的键盘会被直接跳过，不再污染共享状态。

**为什么鼠标还能用**：鼠标走的是独立的 pointing 设备 `yjx-chip-eweadn-e7-mouse`，与这三个键盘接口无关。左中右键、滚轮、DPI 全部不受影响。唯一可能的代价是宏键/侧键——如果它们依赖键盘接口上报，会失效。

**设备名确认**：插拔后 Hyprland 可能给同名设备加 `-1`、`-2` 后缀，务必用实际名字：

```bash
hyprctl devices -j | jq -r '.keyboards[].name'
```

## 验证

修复后在鼠标插回的状态下：

1. `hyprctl configerrors` 为空
2. `hyprctl devices -j` 中 EWEADN 的三个键盘接口不再参与输入
3. 连续做「CapsLock → 字母」，用 wev 确认 key 事件完整、间隔在数百毫秒量级

实测：Caps 释放到字母按下 **313 ms**，`sym: A` 正常到达。

## 方法论沉淀

这次排查真正的价值不在结论，而在方法：

1. **先分层再猜**。TTY / 图形界面一做对比，就能把问题锁在某几层里，比读源码猜快得多。
2. **停止某个组件是最廉价的排除手段**。`systemctl --user stop omarchy-fcitx5` 一条命令就排掉了整条输入法链路。
3. **用真工具看真数据**。`wev` 显示的是合成器实际转发的事件，比任何日志推测都可靠。装一个 200KB 的小工具，胜过两小时的推理。
4. **警惕「看起来正常」的日志**。时间间隔是判断「是否重按」的隐形证据；`leave`/`enter` 是判断「数据是否有效」的前提。这两点各救了这次排查一次。
5. **同类问题优先怀疑「设备伪装」**。鼠标注册键盘接口、键盘注册鼠标接口、双接口设备丢 release——这类固件行为是 Linux 输入栈里高频的坑源。

## 附：SSH 远程调试要点

```bash
# 必须在 SSH 里补齐 Wayland 环境，否则 wev 连不上
export XDG_RUNTIME_DIR=/run/user/1000
export WAYLAND_DISPLAY=wayland-1
export XDG_SESSION_TYPE=wayland

# Hyprland 的实例签名会变，动态获取
SIG=$(ls /run/user/1000/hypr | head -1)
hyprctl -i "$SIG" devices -j
```

`stdbuf -o0` 不能省，否则重定向后输出被全缓冲，日志为空，会误以为程序没工作。

## 参考

- [hyprwm/Hyprland#16275 — Key release dropped for every keyboard while another device holds the key](https://github.com/hyprwm/Hyprland/discussions/16275)
- [Hyprland Wiki — Input variables](https://wiki.hypr.land/Configuring/Basics/Variables/#input)
- [Omarchy — disabled-input-device.lua](https://github.com/basecamp/omarchy)
