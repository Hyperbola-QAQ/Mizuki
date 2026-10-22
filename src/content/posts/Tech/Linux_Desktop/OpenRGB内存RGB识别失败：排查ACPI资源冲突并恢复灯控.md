---
title: OpenRGB 内存 RGB 识别失败：排查 ACPI 资源冲突并恢复灯控
published: 2026-10-22
updated: 2026-10-22
pinned: false
description: 在技嘉 B650M AORUS PRO AX 与 Omarchy Linux 上，通过内核日志定位 ACPI 资源冲突，恢复 SMBus 内存灯控并保存粉色恒亮配置。
tags: [Linux, Omarchy, OpenRGB, RGB, ACPI, SMBus]
category: Desktop
author: Hyperbola
draft: false
---

# 此前的排障弯路

同一台电脑，内存 RGB 在 Windows 的特定版本 OpenRGB 和技嘉 GCC 中都能被识别，到了 Linux 却消失了。

此前尝试过安装 `it87-dkms`，也翻阅过主板文档，但都没有解决内存 RGB 无法识别的问题。后续检查本机日志时，才找到 ACPI 资源冲突这一关键线索。

差别在于排查顺序。之前我一直围绕“是不是缺少某个驱动”“主板是不是不支持”找答案；这次先确认内存灯控依赖的总线有没有被 Linux 成功创建，再沿着内核日志查原因。

# 环境和最初现象

本次实际环境：

- 系统：Omarchy / Arch Linux。
- 内核：`7.2.11-zen1-1-zen`。
- 主板：技嘉 `B650M AORUS PRO AX`。
- BIOS：`FB8`。
- OpenRGB 软件包：`1.1-1`。
- 恢复后识别的内存控制器：两条 `ENE DRAM`，版本均为 `AUDA0-E6K5-0101`。这不是内存商品型号，不能据此推断品牌和完整型号。

Windows 能识别，说明灯和控制器至少在 Windows 环境下可以工作，但不能证明 Linux 下的驱动链路也已正常。OpenRGB 官方文档说明，DDR4/DDR5 内存 RGB 通过 SMBus 访问，因此应先检查 SMBus，而不是只盯着应用界面。

# 从“模块加载了”查到“总线根本没出现”

先检查模块与总线：

```bash
lsmod | rg 'i2c|spd'
i2cdetect -l
lspci -nnk | rg -A4 -i 'smbus'
```

第一次检查时，`i2c_piix4`、`i2c_smbus` 和 `i2c_dev` 都在模块列表里，但 `i2cdetect -l` 只有 DesignWare、NVIDIA 和 AMDGPU 接口，没有任何 `SMBus PIIX4 adapter`。

这里使用的 `i2cdetect -l` 只列出适配器，不是扫描设备地址，也没有对内存 SPD 做读写。

PCI 列表能看到 AMD FCH SMBus 控制器，却没有显示正在使用的内核驱动。OpenRGB 日志也只枚举了显卡等接口。两边共同指向同一件事：模块虽已加载，控制器并没有成功提供可访问的 SMBus 总线。

已有 I²C 设备的 ACL 中，当前用户具备读写权限，因此没有先去修改权限或把 OpenRGB 改成 root 运行。权限不会凭空创建缺失的总线。

# 内核日志给出了关键证据

检查本次启动的内核日志：

```bash
journalctl -k -b --no-pager | rg -i 'piix4|smbus|resource conflict|ACPI.*conflict'
```

找到以下原始错误：

```text
ACPI Warning: SystemIO range 0x0000000000000B00-0x0000000000000B08 conflicts with OpRegion 0x0000000000000B00-0x0000000000000B0F (\GSA1.SMBI) (20260408/utaddress-204)
ACPI: OSL: Resource conflict; ACPI support missing from driver?
```

BIOS 的 ACPI 表声明占用了 `0x0B00` 附近的 I/O 资源，而 SMBus 驱动也需要访问这个区域。Linux 默认检查资源冲突，阻止驱动使用已被 ACPI 声明占用的资源。

这就解释了“模块存在，但总线不存在”的现象。准确地说，这是当前 BIOS 资源声明与 Linux 驱动访问之间的冲突；仅凭这些日志还不能给 BIOS 或内核单方面判定一个具体 bug。

此前尝试 `it87-dkms` 和翻阅主板文档没有解决问题，也不能说明那些方向在所有机器上都无用。只是本机有更直接的证据：资源冲突先把内存 RGB 所需的 SMBus 挡住了，继续更换其他驱动无法替代对这条链路的验证。包名 `it87-dkms` 已由我事后确认；本次 Agent 没有核对当时的安装历史。先前安装操作和文档阅读没有完整现场记录，因此这里不补写命令、错误输出或具体文档结论。

# 先临时放行，再用重启结果验证

测试参数是：

```text
acpi_enforce_resources=lax
```

它允许驱动访问 ACPI 已声明占用的资源。这个开关放宽的是系统级资源保护，并非只针对 OpenRGB；ACPI 固件代码与驱动可能同时访问硬件，因此不应把它当作所有内存灯控问题的通用答案。

本机使用 Limine。临时验证时，复制正常启动项的协议、EFI 路径和命令行，新增 `OpenRGB-SMBus-Test`，仅在测试项追加参数，再通过以下命令指定下一次启动选中它：

```bash
sudo bootctl set-oneshot OpenRGB-SMBus-Test
```

这条命令的前提是已经创建同名的测试项，不能在没有该项的机器上直接照搬。默认启动项保持原样；一次性选择被消费后，后续启动仍回到原配置。测试项本身仍留在菜单中，后续需要清理。

重启后，`/proc/cmdline` 确认参数实际生效，`i2cdetect -l` 新增了三条总线：

```text
i2c-15  smbus  SMBus PIIX4 adapter port 0 at 0b00
i2c-16  smbus  SMBus PIIX4 adapter port 2 at 0b00
i2c-17  smbus  SMBus PIIX4 adapter port 1 at 0b20
```

总线编号可能随设备和启动顺序变化，应以名称判断。OpenRGB 随后识别到了：

```text
0: ENE DRAM
1: ENE DRAM
2: MSI GeForce RTX 4070 SUPER Gaming X Slim MLG
3: B650M AORUS PRO AX
4: AULA F87 Pro
```

两条内存分别位于 PIIX4 port 0 的 `0x71` 和 `0x73`，各有 8 颗可控灯珠。这次对照实验支持根因判断：放宽 ACPI 资源限制后，总线和内存 RGB 设备一起恢复。

# 永久配置：修改源配置并重建启动镜像

验证有效后，新建独立文件 `/etc/limine-entry-tool.d/openrgb-smbus.conf`：

```bash
# Allow SMBus access on B650M AORUS PRO AX (ACPI OpRegion conflict).
KERNEL_CMDLINE[default]+=" acpi_enforce_resources=lax"
```

使用独立 drop-in，方便以后识别、撤销，也避免只编辑自动生成的 `/boot/limine.conf` 后被更新覆盖。本机的 Limine 工具会从这些配置生成内核命令行。

随后删除临时测试启动项，重建当前内核的统一启动镜像（UKI）：

```bash
sudo limine-mkinitcpio linux-zen
```

终端中的人工操作使用 `sudo`；本次 Agent 从后台执行时使用 `pkexec` 弹出认证，两者目的是完成同一项需要管理员权限的操作。

重建成功，工具报告 UKI 已生成并复制到 `/boot/EFI/Linux/omarchy_linux-zen.efi`，同时更新 `/boot/limine.conf`。生成的正常启动项中已经包含 `acpi_enforce_resources=lax`，临时测试项已移除，历史快照启动项保持原参数。

这里没有换内核、刷 BIOS 或安装新的内存灯控驱动。`i2c-dev` 已由软件包的 modules-load 配置加载，`i2c_piix4` 也已自动加载，不必重复添加。

# 所有已识别灯光设为粉色恒亮

选用粉色 `#FF69B4`。先用 `openrgb --list-detailed` 检查每个设备支持的模式，内存和主板使用 `Static`，显卡和键盘使用 `Direct` 输出固定颜色。Direct 在这里没有持续变化的动画，同样实现恒亮。

本机实际执行：

```bash
openrgb \
  --device 0 --mode Static --color FF69B4 \
  --device 1 --mode Static --color FF69B4 \
  --device 2 --mode Direct --color FF69B4 \
  --device 3 --mode Static --color FF69B4 \
  --device 4 --mode Direct --color FF69B4 \
  --save-profile Pink-Static
```

这些编号仅对应上面列出的本机设备，其他机器或硬件变化后应重新核对，不能盲目套用。保存的配置位于 `~/.config/OpenRGB/profiles/Pink-Static.json`。

通过 OpenRGB 自带功能设置登录自动加载：

```bash
openrgb --autostart-enable '--profile Pink-Static'
```

生成的 `~/.config/autostart/OpenRGB.desktop` 包含：

```ini
Exec=/usr/bin/openrgb --profile Pink-Static
```

它在用户登录桌面时应用配色，并非保证从按下电源到登录前都显示粉色。配置应用后 OpenRGB 可以退出，不需要为了恒亮持续运行一个灯效服务。

重新加载配置返回 `Profile loaded successfully`，模式列表中两条内存和主板均为 Static，显卡与键盘为 Direct。配置文件也保存了对应粉色；主板 Static 模式把颜色存在模式颜色字段中，其逐灯颜色数组为零不代表 Static 颜色未设置。

后续现场反馈发现，主板连接的三个 ARGB 风扇仍没有应用粉色。之前两个接口显示 0 颗灯珠，不能把主板 Static 配置写入成功当作风扇也已经配置完成。

确认风扇为“棱镜 6 Pro”，三把连接在同一个主板接口后，查询到[丛林豹 Prism 6 Pro 厂家页面](https://www.jlcpucooler.com/zh/prism-6pro-12025-case-fan-3-sided-infinite-mirror-product/)标注每把 29 颗灯珠。但同名产品存在不同品牌版本，且外观上的串接不保证地址连续，实际品牌、地址数和所接接口仍未确认。

因此追加了一次可恢复的测试：先将原配置备份为 `Pink-Static.before-argb.json`，在已有 Pink-Static 配置基础上，将主板 zone 0（D_LED1）和 zone 1（D_LED2）均临时设为 87 个地址、Static、FF69B4，再保存回 Pink-Static。87 是按 29 × 3 得到的测试值，不是软件检测出的物理灯珠数量。两个接口同时设置，是因为尚未确认风扇实际接在哪一个接口。该测试值目前随登录配置加载，待现场确认后再调整为实际接线配置。

配置文件已核对两个 zone 均保存为 87、Static 和粉色；三个风扇是否全部呈现粉色，仍待现场目视确认。如果风扇接头实际复制相同数据信号，各把可能共享地址，不能把三把风扇一概按独立连续地址处理。

# 验证范围与回滚

当前已验证：临时参数重启后恢复 SMBus；两条内存被识别；粉色配置保存、重新加载成功；长期配置生成的启动项包含参数；UKI 重建成功；桌面自动启动文件已生成。

尚待下一次正常启动验证的是永久启动项和登录自动加载的端到端结果。实体灯光的实际颜色和所有外接灯带覆盖情况，需要现场目视确认，不能用配置文件读取结果代替。

如果需要撤销，先删除本次新增的 `/etc/limine-entry-tool.d/openrgb-smbus.conf`，再运行 `sudo limine-mkinitcpio linux-zen` 重建，重启后检查 `/proc/cmdline` 不再包含参数。停止登录自动配色可以执行：

```bash
openrgb --autostart-disable
```

启动配置备份保存在 `/boot/limine.conf.before-openrgb-test`，清理临时项前另保存了 `/boot/limine.conf.with-openrgb-test`。它们是回看用的配置备份，不能替代 UKI 重建，也不要在内核更新后直接用旧配置覆盖当前文件。

# 这次排障留下的方法

“模块已加载”和“硬件接口可用”是两回事。下一次遇到类似问题，先看应用依赖哪条总线，再确认总线是否创建、权限是否允许访问，最后才排查应用版本和设备支持。

此前的弯路主要是过早围绕驱动安装和主板资料展开，没有先确认 SMBus 是否可用。把应用日志、总线列表和内核报错连起来后，排查方向才明确。随后通过临时启动对照验证：同一台机器加上参数后，总线出现，内存也出现了。

# 参考资料

- [OpenRGB 官方 SMBus 访问说明](https://github.com/CalcProgrammer1/OpenRGB/blob/master/Documentation/SMBusAccess.md)
- [Linux 内核参数说明：acpi_enforce_resources](https://kernel.org/doc/html/latest/admin-guide/kernel-parameters.html)
- [Linux i2c-piix4 驱动说明](https://www.kernel.org/doc/html/latest/i2c/busses/i2c-piix4.html)
- [Limine 配置说明](https://github.com/limine-bootloader/limine/blob/trunk/CONFIG.md)

# 正常重启后发现自动启动没有加载配色

正常重启验证中，内核参数仍然生效，OpenRGB 日志也成功识别了全部五个控制器，但键盘在启动时黑掉，登录后未恢复预设配色。检查发现自动启动项变成了 `Exec=/usr/bin/openrgb --startminimized`，缺少 `--profile Pink-Static`。同时 ProfileManager 中普通启动的 `open_profile.enabled` 为 false，仅服务启动的 `service_startup_profile.enabled` 为 true，不能代替普通 GUI 启动加载方案。无法根据当前文件确定自动启动项具体在哪次操作中被改写。

修正为：

```bash
openrgb --autostart-enable '--startminimized --profile Pink-Static'
openrgb --profile Pink-Static
```

这会让登录时最小化打开并明确加载配色。启动检测阶段的短暂黑灯与登录后未加载方案应分开判断；前者尚未确认发生在固件初始化还是 OpenRGB 探测阶段，不能把后者的修复当作保证从按下电源开始始终亮灯。
