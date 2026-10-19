# 小光点 Cuepoint · Logo 资产包 v7

主标：青蛙帽少年 + 镜头光点，镂空圆盘。源文件是你选定的 `source/logo-source-stencil-1254.png`。

## 内容

| 目录 | 内容 |
|---|---|
| `svg/` | `mark-black.svg` `mark-white.svg` `mark-color.svg`。矢量，自动描摹得到 |
| `mark/` | 透明底 PNG，`black` / `white` / `color` 三色，1024 / 512 / 256 |
| `app-icon/` | 三种底板：`cream`（奶白 + 彩色标）、`green`（青蛙绿 + 黑标）、`dark`（深色 + 白标）。每种有 `1024-rounded`（macOS 样式，带边距和透明圆角）、`1024-square`（满版不透明，交给平台自己裁圆角），以及 512 到 16 的 rounded 尺寸 |
| `favicon/` | `favicon.ico`（16/32/48）、`favicon-16/32/48/64.png`、`apple-touch-icon-180.png`、`icon-192.png`、`icon-512.png` |
| `preview-sizes-and-variants.png` | 各变体和小尺寸（16/32/64/128）在亮、暗底上的对比 |
| `_work/` | `build.py`（PNG 全部由它生成）和 `trace.py`（SVG 描摹，需要 `pip install potracer numpy pillow`） |

## 色值（提案，不是最终品牌色板）

墨色 `#111111` · 青蛙绿 `#7FB53B` · 奶白 `#FFF1D6` · 浅底板 `#F4F0E8` · 深底板 `#101010`

## 决定与依据

- **favicon 用无底板的彩色标，不用带底板的。** 在 16px 下带底板版本糊成一块，无底板彩色版在亮、暗标签栏上都还能认出一只青蛙。深色背景下黑圆盘会融进去，只剩绿帽和脸，依然清晰。
- **`apple-touch-icon` 和 PWA 图标用奶白底板满版。** 这些位置要求不透明。
- 镂空设计让一个文件可以放在任意底色上，`white` 版用于深色界面。

## 已验证

- 黑色 SVG 在 Edge 中渲染后与源图逐像素对比：差异超过 96/255 的像素占 0.041%，平均差 6.9（边缘抗锯齿）。第一次描摹颜色整个反了，是靠这个对比发现并修正的。
- 彩色 SVG 肉眼检查无缝隙、无杂边。
- `favicon.ico` 内含 16、32、48 三个尺寸。

## 局限，请注意

1. **SVG 是自动描摹，不是设计师手工母版。** 锚点可能偏多，曲线不够"干净"。正式商标注册或印刷前，建议人工整理一版。
2. **源图是 AI 生成的位图。** 版权归属不确定。注册商标前建议矢量重绘，并做一次相似性检查。
3. **16px 是降采样的结果，没有手工优化。** 识别靠绿色帽子，脸部细节已基本丢失。需要更好的小尺寸可再做一版手调的 16/32 专用图。
4. **未生成：** macOS `.icns`、Windows `.ico` 桌面图标集、PWA maskable 图标、带中英文名的横版 lockup（需要先定字体）。
5. **没有修改仓库。** 仓库里的品牌资源（`packages/distribution/public/brand/`、`apps/desktop/src-tauri/icons/`）原样未动。
6. 角色以相机代替了耳机，偏向"拍摄/视频"，产品还包含音频和音乐。这是品牌叙事上的选择，尚未定论。
