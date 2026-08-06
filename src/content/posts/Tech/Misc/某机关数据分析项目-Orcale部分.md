---
title: 某机关数据分析项目-Oracle部分
published: 2025-06-01
updated: 2025-06-01
pinned: false
description: 某机关数据分析项目的Oracle数据库部分实现，包括数据建模、查询优化等内容
tags: [Database]
category: Database
author: Hyperbola
draft: false
series: 数据分析项目
---

# 一、背景说明

目标数据由某机关提供，采用 Oracle 私有格式导出为 .dmp 文件（Data Pump 格式），需通过 Oracle 数据库系统完成解析并转换为通用分析格式CSV以便后续使用Polars处理。

### 关键挑战

- 导出文件大小约为 50GB，超出 Oracle XE 免费版默认限制（12GB）

  > 后续按照2种分类4个年份给出了8份不超过12G的dmp文件

- 原始数据库为 Oracle 19c，生成的 DMP 文件不兼容低版本直接导入

- Linux 版本生成的 DMP 文件在 Windows 上被识别为符号链接，无法正常导入

- 高版本 Oracle 支持导入低版本 DMP 文件，但需显式设置 VERSION 参数；反之则受限

- 默认导入会同时载入数据与索引，导致实际占用空间远超原始 DMP 大小（7G → >12G）

  > 后续导出的某份dmp虽不超过12G但也有11.7G过大，无法直接导入

- 按照性别字段分半导入时无法在终端向Oracle传递参数

- Oracle 在非 Red Hat 系发行版安装复杂，推荐使用 Oracle Linux

- 提供的 DMP 文件编码为 GBK，而 Oracle XE 默认字符集为 UTF-8，需提前配置

- 虚拟机默认分区策略可能导致 /home 占用过多空间，影响数据库运行

- 用户名 oracle 可能引发权限异常问题

- 默认配置后的Oracle开机不自动启动

- 导出时表空间为自定义的，需要手动指定导出表空间

# 二、解决方案概览

| 任务 | 方案 |
|------|------|
| 运行环境 | 使用 KVM 虚拟机部署 Oracle Linux 8 |
| 数据库选择 | Oracle Database XE 21c（支持更大容量及高版本兼容） |
| 字符集处理 | 重建数据库并设定字符集为 ZHS16GBK（GBK） |
| 存储管理 | 手动分区避免 /home 分离造成空间浪费 |
| 权限控制 | 创建非 oracle 名称的管理员账户，加入 DBA 组 |
| 文件传参 | 创建par文件并写入参数后向impdp文件传递参数 |

# 三、详细操作步骤

## 1. 虚拟机配置（KVM）

使用 KVM 创建虚拟机，操作系统选择：Oracle Linux 8

- 硬盘分配建议 ≥100GB（预留充足空间用于导入与临时操作）
- 内存建议 ≥8GB（Oracle XE 最低要求 2GB，推荐 4GB+）

> ⚠️ 注意：确保宿主机有足够的存储资源支撑大型 DMP 文件操作。
>

## 2. 安装 Oracle Linux 8

#### 分区策略（关键！）

在安装过程中，手动配置磁盘分区：

- `/` → 尽可能大（例如 90GB）
- `/boot` → 1GB
- `swap` → 4~8GB（根据内存调整）

> ❌ 避免使用默认分区方案（自动创建 /home），防止 / 分区空间不足。
>

#### 用户命名注意事项

创建管理员用户时，不要命名为 oracle（易引起脚本冲突或权限问题）
示例用户名： datauser

#### 安装后初始化

```bash
sudo dnf update
```

## 3.安装 Oracle Database XE 21c

### 下载安装包

```bash
wget https://download.oracle.com/otn-pub/otn_software/db-express/oracle-database-xe-21c-1.0-1.ol8.x86_64.rpm
```

### 安装 RPM 包

```bash
sudo dnf install ./oracle-database-xe-21c-1.0-1.ol8.x86_64.rpm
```

### 初始化数据库实例

```bash
sudo /etc/init.d/oracle-xe-21c configure
```

此过程将提示设置 SYS 和 SYSTEM 用户密码，并启动服务。

### 配置环境变量

为方便命令行工具调用，添加以下环境变量至当前用户的 shell 配置文件（如 ~/.bashrc ），或者直接执行：

```bash
export ORACLE_HOME=/opt/oracle/product/21c/dbhomeXE
export PATH=$ORACLE_HOME/bin:$PATH
export ORACLE_SID=XE
```

立即生效：

```bash
source ~/.bashrc
```

### 授予当前用户 DBA 权限

使当前用户可通过 sqlplus / as sysdba 登录：

```bash
sudo usermod -aG dba $USER
```

🔄 重启终端或重新登录以应用组权限变更。

## 4.修改数据库字符集为 GBK（ZHS16GBK）

由于源 DMP 文件为 GBK 编码，必须将数据库字符集设为 ZHS16GBK 才能正确导入中文内容。

### 登录

```bash
sqlplus / as sysdba
```

### 删除并重建数据库

⚠️ Oracle 不允许直接修改字符集，需通过 INTERNAL_USE 强制修改。

```sql
SHUTDOWN IMMEDIATE;
STARTUP MOUNT;
ALTER SYSTEM ENABLE RESTRICTED SESSION;
ALTER SYSTEM SET JOB_QUEUE_PROCESSES=0;
ALTER SYSTEM SET AQ_TM_PROCESSES=0;
ALTER DATABASE OPEN;
ALTER DATABASE CHARACTER SET INTERNAL_USE ZHS16GBK;
SHUTDOWN IMMEDIATE;
STARTUP;
```

### 验证

```sql
SELECT VALUE FROM NLS_DATABASE_PARAMETERS WHERE PARAMETER='NLS_CHARACTERSET';
-- 应返回 ZHS16GBK
```

## 5.创建数据库用户

```sql
CREATE USER A2022
  IDENTIFIED BY "password"
  DEFAULT TABLESPACE USERS
  TEMPORARY TABLESPACE TEMP
  QUOTA UNLIMITED ON USERS;

CREATE USER A2023
  IDENTIFIED BY "password"
  DEFAULT TABLESPACE USERS
  TEMPORARY TABLESPACE TEMP
  QUOTA UNLIMITED ON USERS;

CREATE USER A2024
  IDENTIFIED BY "password"
  DEFAULT TABLESPACE USERS
  TEMPORARY TABLESPACE TEMP
  QUOTA UNLIMITED ON USERS;

CREATE USER A2025
  IDENTIFIED BY "password"
  DEFAULT TABLESPACE USERS
  TEMPORARY TABLESPACE TEMP
  QUOTA UNLIMITED ON USERS;

CREATE USER B2022
  IDENTIFIED BY "password"
  DEFAULT TABLESPACE USERS
  TEMPORARY TABLESPACE TEMP
  QUOTA UNLIMITED ON USERS;

CREATE USER B2023
  IDENTIFIED BY "password"
  DEFAULT TABLESPACE USERS
  TEMPORARY TABLESPACE TEMP
  QUOTA UNLIMITED ON USERS;

CREATE USER B2024
  IDENTIFIED BY "password"
  DEFAULT TABLESPACE USERS
  TEMPORARY TABLESPACE TEMP
  QUOTA UNLIMITED ON USERS;

CREATE USER B2025
  IDENTIFIED BY "password"
  DEFAULT TABLESPACE USERS
  TEMPORARY TABLESPACE TEMP
  QUOTA UNLIMITED ON USERS;
```

### 给予dba权限

```sql
-- 授予 A 类用户 DBA 权限
GRANT DBA TO A2022;
GRANT DBA TO A2023;
GRANT DBA TO A2024;
GRANT DBA TO A2025;

-- 授予 B 类用户 DBA 权限
GRANT DBA TO B2022;
GRANT DBA TO B2023;
GRANT DBA TO B2024;
GRANT DBA TO B2025;
```

通过为每年数据创建独立的数据库用户（如 A2022），可在完成 DMP 导入和 CSV 导出后，使用 

`DROP USER A2022 CASCADE;` 一键删除该用户及其所有关联数据，便于数据清理与环境重置。

## 6.导入DMP文件

### 创建目录/opt/oracle/dump

```bash
sudo mkdir -p /opt/oracle/dump
```

### 权限设置

```bash
sudo chown $USER:dba /opt/oracle/dump
sudo chmod 777 /opt/oracle/dump
```

直接设置为777方便导入

### 登录

```bash
sqlplus / as sysdba
```

### 切换为可插拔式数据泵（XEPDB1）

```sql
ALTER SESSION SET CONTAINER = XEPDB1;
```

### 创建DUMP_DIR为/opt/oracle/dump

```sql
CREATE DIRECTORY DUMP_DIR AS '/opt/oracle/dump';

-- 授予读写权限给目标用户
GRANT READ, WRITE ON DIRECTORY DUMP_DIR TO A2025;
GRANT READ, WRITE ON DIRECTORY DUMP_DIR TO A2022;
GRANT READ, WRITE ON DIRECTORY DUMP_DIR TO A2023;
GRANT READ, WRITE ON DIRECTORY DUMP_DIR TO A2024;
GRANT READ, WRITE ON DIRECTORY DUMP_DIR TO B2025;
GRANT READ, WRITE ON DIRECTORY DUMP_DIR TO B2022;
GRANT READ, WRITE ON DIRECTORY DUMP_DIR TO B2023;
GRANT READ, WRITE ON DIRECTORY DUMP_DIR TO B2024;

-- 退出
EXIT;
```

### 导入DMP文件到虚拟机

```bash
scp -r ./data oracleuser@192.168.123.123:/opt/oracle/dump
```

### 导入一般DMP文件到Oracle

适用于常规数据导入场景，通过 impdp 命令直接导入指定的表和用户，并进行 schema 与表空间映射。

```bash
impdp ZYJC2025/<password>@localhost/XEPDB1 \
  DIRECTORY=DUMP_DIR \
  DUMPFILE=A2025.dmp \
  REMAP_SCHEMA=_NEW:A2025 \
  TABLES=IRPT_NEW.A,_NEW.B \
  LOGFILE=DUMP_DIR:import_A2025.log \
  TABLE_EXISTS_ACTION=REPLACE \
  VERSION=19.0 \
  REMAP_TABLESPACE=IRPT_NEW:USERS \
  EXCLUDE=INDEX
```

🔍 参数说明：

​    REMAP_SCHEMA: 将源 Schema _NEW 映射为目标 Schema A2025
​    TABLES: 指定仅导入特定表（可提升效率）
​    REMAP_TABLESPACE: 将原表空间 IRPT_NEW 映射为当前数据库的 USERS
​    EXCLUDE=INDEX: 跳过索引导入，避免超出 Oracle XE 12GB 限制
​    TABLE_EXISTS_ACTION=REPLACE: 若表已存在则删除后重新导入

### 导入特例 DMP 文件到 Oracle（大容量分批导入）

#### 问题背景

某 DMP 文件（如 XYYB2023.dmp）虽未超过 12GB，但其完整导入后数据量会超出 Oracle XE 的 12GB 存储限制。为规避此问题，需使用 QUERY 参数按条件分批导入。

但由于 QUERY 参数包含单引号 ' 和双引号 "，在 Shell 命令行中直接传参会导致：

    Bash 提前解析引号，破坏参数结构
    报错：LRM-00101: unknown parameter name 'E2'
    
    ❌ 错误示例（禁止使用）：
    impdp ... QUERY=IRPT_NEW.XYYB_XXB:"WHERE E2 = '1'"

#### 解决方案：使用参数文件（.par）

Oracle 推荐将复杂参数写入 参数文件（Parameter File），避免 Shell 解析干扰。

##### 步骤 1：创建参数文件

vim /opt/oracle/dump/import_XYYB2023.par

##### 步骤 2：编辑参数文件内容

```par
DIRECTORY=DUMP_DIR
DUMPFILE=B2023.dmp
REMAP_SCHEMA=IRPT_NEW:B2023
TABLES=_NEW.B
LOGFILE=DUMP_DIR:import_B2023_male.log
TABLE_EXISTS_ACTION=REPLACE
VERSION=19.0
REMAP_TABLESPACE=_NEW:USERS
EXCLUDE=INDEX
QUERY=_NEW.B_XXB:"WHERE E2 = '1'"
```

✅ 说明：

​    E2 = '1'： E2 为性别字段，1 表示男性
​    使用双引号包裹 WHERE 条件，是 Oracle impdp 对 QUERY 参数的标准语法
​    日志文件路径使用 DUMP_DIR:filename.log 格式，表示存放在 DUMP_DIR 目录下

##### 步骤 3：执行导入命令（引用参数文件）

```bash
impdp XYYB2023/<password>@localhost/XEPDB1 PARFILE=import.par
```



🔄 导入另一半数据（由于存在异常数据等情况，不能直接使用E2 = '2'）：

修改 .par 文件中的 QUERY 行：

```par
DIRECTORY=DUMP_DIR
DUMPFILE=B2023.dmp
REMAP_SCHEMA=IRPT_NEW:B2023
TABLES=_NEW.B
LOGFILE=DUMP_DIR:import_B2023_nomale.log
TABLE_EXISTS_ACTION=REPLACE
VERSION=19.0
REMAP_TABLESPACE=_NEW:USERS
EXCLUDE=INDEX
QUERY=_NEW.B_XXB:"WHERE E2 <> '1'"
```

## 7.导出

由于一开始计划导出为sql，所以使用的SQL Developer

#### 下载SQL Developer

```bash
wget https://download.oracle.com/otn_software/java/sqldeveloper/sqldeveloper-24.3.1-347.1826.noarch.rpm
```

#### 安装SQL Developer和JDK（SQL Developer需要使用JER打开）

```bash
sudo dnf install ./sqldeveloper-24.3.1-347.1826.noarch.rpm java-17-openjdk
```

#### 打开SQL Developer连接到本地Oracle

| 字段            | 值                                      |
| --------------- | --------------------------------------- |
| Connection Name | A2025_XEPDB1（可自定义，如“本地A2025”） |
| Username        | A2025                                   |
| Password        | password                                |
| Save Password   | ✅ 勾选（可选，方便下次登录）            |
| Connection Type | Basic（默认）                           |
| Role            | Default                                 |
| Port            | 1521                                    |
| Service name    | XEPDB1                                  |

⚠️ 注意：

​    不要填 SID，要填 Service name（因为 XEPDB1 是服务名，不是 SID）。
​    Oracle XE 的 CDB（容器数据库）SID 通常是 XE，但 PDB（如 XEPDB1）必须通过 服务名 连接。

#### 导出为csv

取消导出DDL，仅勾选导出DATA，导出csv还需导出Header

# 四、总结

整个过程前前后后花费一周，由于目标只是转换DMP文件，故而很多操作并不符合实际Oracle生产环境的标准