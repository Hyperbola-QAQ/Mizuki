---
title: MangoHud 不显示 CPU 功耗排查：RAPL 权限与 capability 的边界
published: 2026-10-30
updated: 2026-10-30
pinned: false
description: 定位 MangoHud 在 AMD Ryzen 上 CPU 功耗空缺的两个原因——配置未启用与 /sys/class/powercap energy_uj 的 0400 权限,并解释 btop 为何能读、setcap 为何对 MangoHud 无效
tags: [Hardware, Desktop, Kernel]
category: Desktop
author: Hyperbola
draft: false
---

> 环境: Omarchy(Arch + Hyprland, Wayland), AMD Ryzen 9 9950X(仅 k10temp, 无 zenpower), AMD GPU(amdgpu), MangoHud 0.8.4, Steam/Proton 运行原神

## 背景

原神的 HUD 里 GPU 功耗正常出数,CPU 功耗那一行却没有。不是显示 0,是整行不存在或者空着。

一开始最容易误判的方向是"驱动不支持"、"AMD 读不到 package power"。实际排查下来,数据源一直是好的,卡在两处和硬件无关的地方。

## 一、先确认数据源在不在

```bash
ls /sys/class/powercap/
# intel-rapl  intel-rapl:0  intel-rapl:0:0

lsmod | grep rapl
# intel_rapl_msr  intel_rapl_common  rapl

cat /sys/class/powercap/intel-rapl:0/name
# package-0

cat /sys/class/powercap/intel-rapl:0/max_energy_range_uj
# 65532610987
```

有个容易误解的点:**AMD 平台上这个目录也叫做 `intel-rapl`**。RAPL 的 MSR 接口是 Intel 定义的通用方案,Zen 架构同样实现了,所以驱动名和路径都沿用 `intel_rapl_msr`。看到 `intel` 前缀不要以为加载错了驱动。

`max_energy_range_uj` 是 65.5 kJ,符合正常量级(计数器溢出回绕的上限)。两个域 `package-0`(整包)和 `core`(核心域)都在。

**结论:驱动、内核接口、域划分全都正常。问题不在这里。**

## 二、两个独立的原因

### 原因 1:配置里根本没有这一项

MangoHud 的功耗行不是默认显示的。实测这台机器上:

```bash
ls ~/.config/MangoHud/
# wine-YuanShen.conf      ← 只有这个

cat ~/.config/MangoHud/wine-YuanShen.conf
# fps_limit=0
# no_display=0
# show_fps_limit
# reload_cfg=F11
```

全局的 `MangoHud.conf` 不存在,所以除了这四行以外的所有字段都走 MangoHud 内置的默认值,而**默认值里不含 `cpu_power` 也不含 `gpu_power`**。

Steam 的启动选项是 `mangohud %command%`,没有用 `MANGOHUD_CONFIG` 环境变量覆盖,所以配置完全由那个 `wine-YuanShen.conf` 决定。也就是说功耗行从一开始就没有被请求渲染过。

### 原因 2:数据文件对普通用户不可读

```bash
$ ls -l /sys/class/powercap/intel-rapl:0/energy_uj
-r-------- 1 root root 4096 /sys/class/powercap/intel-rapl:0/energy_uj

$ ls -l /sys/class/hwmon/hwmon3/power1_input
-r--r--r-- 1 root root 4096 /sys/class/hwmon/hwmon3/power1_input
```

这两行放在一起就把问题说完了:

- CPU 功耗走 RAPL 的 `energy_uj`,权限 **0400,只有 root 可读**
- GPU 功耗走 amdgpu hwmon 的 `power1_input`,权限 **0444,人人可读**

同一套 MangoHud 代码,GPU 那个能工作、CPU 这个不能,差的就是这两个文件的 mode。内核默认把 RAPL 计数器设成 root-only,是出于能耗侧信道(energy side channel)的安全考虑。

## 三、读源码确认 MangoHud 的查找顺序

与其猜,不如看 0.8.4 的 `src/cpu.cpp`。`InitCpuPowerData()` 的探测顺序是这样的:

```text
1. 遍历 /sys/class/hwmon/*
     name == "k10temp"  → init_cpu_power_data_k10temp()
     name == "zenpower" → init_cpu_power_data_zenpower()   (找到即 break)
     name == "zenergy"  → init_cpu_power_data_zenergy()    (找到即 break)
     name == "apm_xgene"→ init_cpu_power_data_xgene()      (找到即 break)

2. 仍为空 → 遍历可用 GPU,若是 AMD APU 且 apu_cpu_power > 0
     → CPU_POWER_AMDGPU

3. 仍为空 → 遍历 /sys/class/powercap/*,取 name == "package-0"
     → init_cpu_power_data_rapl()
```

在 9950X 上,第 1 步必然失败。`k10temp` 那条路径**不是读功耗,是算功耗**:它要求 hwmon 里有以下 label 之一

```cpp
// 优先:zenpower 风格的功率值
find_input(path, "power", corePowerInput, "Pcore")
find_input(path, "power", socPowerInput,  "Psoc")

// 退化:电压 × 电流
find_input(path, "in",   coreVoltageInput, "Vcore")
find_input(path, "curr", coreCurrentInput, "Icore")
find_input(path, "in",   socVoltageInput,  "Vsoc")
find_input(path, "curr", socCurrentInput,  "Isoc")
```

而 `k10temp` 只暴露 `temp1_input` / `temp3_input` / `temp4_input`,没有任何 power/curr 属性,`find_input` 返回 nullptr,直接出局。zenpower / zenergy 需要额外装模块且对新 Zen 的支持情况不稳定。

第 2 步,9950X 虽然带核显,但 `apu_cpu_power` 只对真正的 APU(核显与计算核心共享功耗预算)有意义,读出来是 0。

于是只剩第 3 步 RAPL。而这一步死在权限上:

```cpp
static CPUPowerData_rapl* init_cpu_power_data_rapl(const std::string path) {
    std::string energyCounterPath = path + "/energy_uj";
    if (!file_exists(energyCounterPath)) return nullptr;

    powerData->energyCounterFile = fopen(energyCounterPath.c_str(), "r");
    if (!powerData->energyCounterFile) {
        SPDLOG_DEBUG("Rapl: energy_uj is not accessible");   // ← 权限不足时打的就这一条
        return nullptr;
    }
    return powerData.release();
}
```

### 一个很坑的实现细节

```cpp
bool CPUStats::InitCpuPowerData() {
    if (m_cpuPowerData != nullptr) return true;

    static int retries = 0;
    if (retries >= 5) return true;      // ← 悄悄放弃,并且返回 true
    retries++;
    ...
}
```

重试上限 5 次,用完就永久返回 `true`(注意不是 `false`),但 `m_cpuPowerData` 依然是空的,`UpdateCpuPower()` 里 `if (!m_cpuPowerData) return false;` 照样静默。这意味着:

**即使中途把权限放开了,正在运行的游戏也不会恢复,必须重启游戏进程。** 按 `reload_cfg` 热重载配置也没用——那只是重新解析参数,不会重新探测功耗数据源。

### 计算方式是差分

```cpp
power = energyCounterDiff / timeDiffMicro;   // uJ / us == W
```

单位正好抵消(1 µJ / 1 µs = 1 W)。并且有一层保护:只有 `新值 > 旧值` 才更新,所以计数器回绕的那一帧会短暂显示 0,不会出现巨大的负数尖峰。

## 四、那 btop 为什么能读?

这是整个排查里最有意思的反例。btop 的 `show_cpu_watts` 在这台机器上是正常工作的,而它读的是**同一个文件**——btop 二进制里硬编码着 `/sys/class/powercap/intel-rapl:0/energy_uj`。

答案在 capability:

```bash
$ getcap /usr/bin/btop
/usr/bin/btop cap_dac_read_search,cap_perfmon=ep
```

`cap_dac_read_search` 的作用就是**跳过文件读写权限检查**。文件对 btop 来说依然是 0400,它是靠这个能力绕过 DAC 校验的,而不是文件被放开了。

btop 自己的配置注释就把这事说明白了:

```ini
#* Shows the CPU package current power consumption in watts.
#* Requires running `make setcap` or `make setuid` or running with sudo.
show_cpu_watts = true
```

所以 btop 能用,是因为装的时候执行过 `make setcap`。

### 为什么这招对 MangoHud 不管用

网上给 MangoHud 找这个问题的帖子里,经常能看到这样的建议:

```bash
sudo setcap cap_dac_read_search+ep /usr/lib/mangohud/libMangoHud.so   # 无效
```

**在 Proton/Wine 场景下这条命令没用。** 原因是 capability 的生效时机:

- `btop` 是独立可执行文件,运行时经过 `execve`,内核在这一刻把 file capability 提升为进程的 effective set
- MangoHud 是 `LD_PRELOAD` 注入到游戏进程里的**共享库**,加载走的是 `dlopen`,`execve` 发生于游戏主程序(而它没有被赋予 capability),库本身也就拿不到

file capability 是绑定在**可执行文件**上的属性,对被动加载的 `.so` 无意义。

## 五、修复

既然绕不过 DAC,那就把文件的读权限放开。两条路:

**临时(重启或驱动重载后失效)**

```bash
sudo chmod o+r /sys/class/powercap/intel-rapl:0/energy_uj
```

**持久(udev 规则)**

`sysfs` 属性的 mode 由内核在设备注册时赋值,`chmod` 只是覆盖当前值。要跨重启,用 udev 在 `add` 事件时补一次:

```bash
sudo tee /etc/udev/rules.d/99-powercap-readable.rules >/dev/null <<'EOF'
SUBSYSTEM=="powercap", ACTION=="add|change", RUN+="/bin/sh -c 'chmod o+r /sys/class/powercap/%k/energy_uj'"
EOF

sudo udevadm control --reload
sudo udevadm trigger --subsystem-match=powercap
```

`%k` 是内核设备名,`intel-rapl:0` 和 `intel-rapl:0:0` 都会被匹配到。注意 `MODE=` 在这里无效——`MODE` 只能作用于设备节点,`energy_uj` 是设备属性文件,必须用 `RUN+=` 执行 chmod。

然后把配置补上:

```ini
# ~/.config/MangoHud/wine-YuanShen.conf
cpu_power
gpu_power
```

最后**重启游戏**。

## 六、验证

不依赖 HUD,直接用 shell 自己算一遍:

```bash
a=$(cat /sys/class/powercap/intel-rapl:0/energy_uj); sleep 1
b=$(cat /sys/class/powercap/intel-rapl:0/energy_uj)
awk -v a=$a -v b=$b 'BEGIN{printf "%.1f W\n",(b-a)/1000000}'
# 93.7 W
```

能出这个数量级的数字,说明权限这一关过了、数据是实时的。剩下的就是 HUD 里那一行会不会渲染。

## 七、小结

排查这类"某个监控项不显示"的问题,值得按这个顺序走一遍:

1. **数据源是否存在** — 驱动加载了吗?域在吗?数值量级合理吗?
2. **程序是否被要求显示它** — 默认配置往往不含,`<exe>.conf` 会整体覆盖
3. **能否读到** — 对比同一程序里**能工作**的相邻指标(GPU 功耗),权限差异会立刻暴露
4. **读不到时程序怎么处理** — 很多程序是静默降级,不报错,日志级别还只有 DEBUG

三个具体的坑,记在这里:

- AMD 上的 RAPL 目录叫 `intel-rapl`,别被前缀误导
- `energy_uj` 默认 0400,`power1_input` 默认 0444,同一个 HUD 里两种权限并存
- MangoHud 的 `InitCpuPowerData()` 有 5 次重试上限,**改完必须重启游戏**,热重载无效

以及一条边界:**capability 只属于可执行文件,不属于 `dlopen` 进来的共享库**。这条决定了「btop 能读」不能推出「mangohud 也能这么修」。
