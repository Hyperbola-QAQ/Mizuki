---
title: Python安装使用-Miniconda篇
published: 2025-05-01
updated: 2025-05-01
pinned: false
description: Windows与Linux环境下Miniconda的安装教程及实际使用案例
tags: [Python, Miniconda, 环境管理, 安装教程, 虚拟环境]
category: Python
author: Hyperbola
draft: false
series: Python环境配置
---

# **介绍Miniconda**

Miniconda是一个轻量级的Anaconda发行版，它仅包含Python和`conda`包管理系统。以下是Miniconda的一些优势：

- **不干涉系统**：Miniconda不会干扰系统的其他部分，可以轻松地在不同的环境中管理依赖项。
- **灵活配置**：用户可以根据需要创建多个独立的环境，并且每个环境都可以拥有自己独立的Python版本和包集合。

# Python安装

## **Miniconda安装**

### 清华镜像源

为了加速下载过程，建议使用清华大学的镜像源： [**https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/**](https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/)

### Linux

根据您的操作系统架构选择合适的安装脚本。以下为适用于大多数Linux发行版的示例：

#### 下载安装脚本

```shell
 wget https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-py312_24.1.2-0-Linux-x86_64.sh
```

#### 运行安装脚本

```shell
 bash Miniconda3-py312_24.1.2-0-Linux-x86_64.sh
```

按照提示完成安装即可。

### Windows

从清华大学镜像源下载Windows安装程序并运行：

- [**Miniconda3-py311_25.3.1-1-Windows-x86_64.exe**](https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/Miniconda3-py311_25.3.1-1-Windows-x86_64.exe)

双击下载的`.exe`文件，按照安装向导完成安装。

## **添加环境变量**

### Linux

安装过程中会询问是否自动将Miniconda添加到PATH环境变量中。如果选择了“否”，则需要手动添加。可以通过运行以下命令来实现：

```shell
 source ~/.bashrc
```

或者直接编辑`~/.bashrc`文件，在末尾添加以下内容：

```shell
 export PATH="/home/your_username/miniconda3/bin:$PATH"
```

然后执行`source ~/.bashrc`使更改生效。

### Windows

安装完成后，Miniconda会自动添加到系统路径中。也可以手动添加路径（如果未勾选相关选项）：

1. 打开“系统属性” -> “高级系统设置” -> “环境变量”。

2. 在“系统变量”部分找到`Path`，点击“编辑”。

3. 点击“新建”，依次添加以下路径：

   ```shell
    C:\ProgramData\miniconda3
    C:\ProgramData\miniconda3\Scripts
    C:\ProgramData\miniconda3\Library\bin
   ```

## **验证**

打开终端或命令提示符，输入以下命令验证安装是否成功：

```shell
 conda --version     
 python --version
```

正常情况下，上述命令应返回相应的版本信息。

## **配置pip镜像源**

为了加快Python包的下载速度，可以配置国内的镜像源。以下是几个常用的国内镜像源配置命令：

- 清华大学镜像源

  ```shell
   pip config set global.index-url https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple
  ```

- 阿里云镜像源

  ```shell
   pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/
  ```

- 中科大镜像源

  ```shell
   pip config set global.index-url https://mirrors.ustc.edu.cn/pypi/simple/
  ```

## **新建Conda环境并激活**

您可以使用`conda`命令来创建和管理虚拟环境。以下是如何创建一个名为`test_env`的新环境，并将其激活的方法：

```shell
 conda create -n test_env python=3.12
 conda activate test_env
```

现在，您已经进入了一个新的Python环境`test_env`，其中包含了Python 3.12版本。

**验证**

```shell
 python --version
```



## **使用uv进行库管理(可选)**

`uv`是一个用于简化包管理的操作工具。虽然`conda`本身已经非常强大，但`uv`提供了额外的功能。以下是不同操作系统的安装方法：
通用安装

### 安装pipx

```shell
 python -m pip install --user pipx
 python -m pipx ensurepath
```

通过pipx安装uv

```shell
 pipx install uv
```

### Linux

对于基于Debian的系统（如Ubuntu），可以使用以下命令安装`uv`：

```shell
 sudo apt install uv
```

对于基于Red Hat的系统（如CentOS），可以使用以下命令安装`uv`：

```shell
 sudo yum install uv
```

对于Arch Linux，可以使用以下命令安装`uv`：

```shell
 sudo pacman -S uv
```

### Windows

通过PowerShell运行以下命令来安装`uv`：

```shell
 irm https://astral.sh/uv/install.ps1 | iex
```

# Python使用案例

## **算法案例简单实现**

输入正整数N

输出N的二进制数中的1的个数

```python
 print(bin(int(input())).count('1')))
```

## **批量处理图片文件**

### 安装常用库

如果安装了uv使用uv pip。这里以安装`numpy`和`opencv-python`为例：

```shell
 (uv) pip install numpy opencv-python
```

- **OpenCV（Open Source Computer Vision Library）**

  一个开源的计算机视觉和图像处理库，广泛用于图像识别、视频分析、物体检测等领域。`cv2` 是 OpenCV 的 Python 接口。

- **NumPy（Numerical Python）**

  是 Python 中用于科学计算的核心库之一。它提供了对大型多维数组和矩阵的支持，并包含大量的数学函数来对这些数组进行高效操作。`numpy` 极大地简化了数值计算任务，是数据分析、机器学习、图像处理等领域不可或缺的工具。

- **os -> Python 标准库中的模块**

  用于与操作系统进行交互，常用于文件和目录操作。

```python
 import os
 import cv2
 
 def crop_to_aspect_ratio(img, target_ratio=(16, 9)):
     """裁剪图片为指定宽高比（默认16:9），居中裁剪。"""
     height, width = img.shape[:2]
     target_w, target_h = target_ratio
     current_ratio = width / height
     target_ratio_val = target_w / target_h
 
     if current_ratio > target_ratio_val:
         # 图片太宽，裁剪宽度
         new_width = int(height * target_ratio_val)
         x1 = (width - new_width) // 2
         img_cropped = img[:, x1:x1 + new_width]
     else:
         # 图片太高，裁剪高度
         new_height = int(width / target_ratio_val)
         y1 = (height - new_height) // 2
         img_cropped = img[y1:y1 + new_height, :]
     return img_cropped
 
 def process_images(input_folder, output_folder):
     """批量处理文件夹下的图片，裁剪为16:9比例并转为黑白图片"""
     if not os.path.exists(output_folder):
         os.makedirs(output_folder)
 
     i = 0
     for filename in os.listdir(input_folder):
         if filename.lower().endswith(('.jpg', '.png')):
             i += 1
             img_path = os.path.join(input_folder, filename)
             img = cv2.imread(img_path)
             if img is None:
                 continue
 
             # 裁剪为16:9
             img_cropped = crop_to_aspect_ratio(img, (16, 9))
 
             # 转为灰度图
             img_gray = cv2.cvtColor(img_cropped, cv2.COLOR_BGR2GRAY)
 
             # 重命名
             ext = os.path.splitext(filename)[1]
             new_filename = f'素材{i}{ext}'
 
             cv2.imwrite(os.path.join(output_folder, new_filename), img_gray)
 
 def main():
     input_folder = './input_images'
     output_folder = './output_images'
     process_images(input_folder, output_folder)
 
 if __name__ == '__main__':
     main()
```

## **Yolo v11简单目标检测**

创建新的conda环境

```shell
 conda create -n pytorch-cpu python=3.11
```

激活新创建的conda环境

```shell
 conda activate pytorch-cpu
```

安装pytorch和ultralytics库(pytorch库包含numpy，opencv-python等机器学习常用库)

```shell
 （uv） pip install ultralytics --no-warn-script-location
```

#### linux

```shell
 （uv） pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
```

#### Windows

```shell
 （uv） pip install torch torchvision torchaudio --no-warn-script-location
 from ultralytics import YOLO
 import cv2
 import subprocess
 import sys
 import os
 
 def visualize_results(image, results, class_names):
     """在图像上绘制检测结果"""
     for result in results:
         boxes = result.boxes.cpu().numpy()
         for box in boxes:
             xyxy = box.xyxy[0].astype(int)   # 边界框坐标
             conf = box.conf.item()           # 置信度
             cls = int(box.cls.item())        # 类别索引
             label = f'{class_names[cls]} {conf:.2f}'
             cv2.rectangle(image, (xyxy[0], xyxy[1]), (xyxy[2], xyxy[3]), (0, 255, 0), 2)
             cv2.putText(image, label, (xyxy[0], xyxy[1] - 10),
                         cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
     return image
 
 def open_image(output_path):
     """使用系统默认图片查看器打开图片"""
     if sys.platform.startswith('darwin'):
         subprocess.run(['open', output_path])
     elif os.name == 'nt':
         os.startfile(output_path)
     elif os.name == 'posix':
         subprocess.run(['xdg-open', output_path])
 
 def main():
     # 加载YOLOv11预训练模型
     model = YOLO('yolo11n.pt')  # 确保路径正确
 
     # 读取图像
     image_path = './test.png'
     image = cv2.imread(image_path)
     if image is None:
         print(f"无法读取图片: {image_path}")
         return
 
     # 使用模型进行预测
     results = model(image)
     class_names = model.names
 
     # 可视化检测结果
     image = visualize_results(image, results, class_names)
 
     # 保存结果图像
     output_path = 'detected_objects.jpg'
     cv2.imwrite(output_path, image)
 
     # 打开图片预览
     open_image(output_path)
 
 if __name__ == "__main__":
     main()
```