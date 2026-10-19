# 首页 logo 120px 与 hover 动态视频

## Goal

把首页创作助手（`HomeWelcome`）顶部的 logo 从 48px 放大到 120px，并在鼠标悬停时用品牌动画视频替换静态图。动画结束后停在最后一帧，鼠标移开后淡回静态 logo。

## Requirements

- 静态 logo 继续使用 `LOGO_SRC`（`/brand/logo.webp`），不新增静态变体。
- 首页 hero 的 logo 显示尺寸 120×120，与标题、说明文字的垂直间距保持现有视觉节奏。
- hover 时淡入并播放品牌动画视频；视频首帧即静态 logo 构图，因此淡入不应产生跳变。
- 动画播放到结尾后停住，不自动回到静态图、不循环。
- `mouseleave` 时淡出视频并回到静态 logo；淡出时长与淡入一致。
- 再次 hover：若上次已播完，从头播放；若中途移开，从暂停处继续。
- 触摸设备与不支持 hover 的环境保持静态 logo，不加载视频。
- `prefers-reduced-motion: reduce` 下不播放动画，保持静态 logo。
- 视频资源随 `packages/distribution/public/brand/` 一起分发，命名与 `?v=` 查询参数与现有 brand 资源一致。
- 视频文件必须去除音轨并降到适合 120px 展示的尺寸，避免为一个小动效加载 640 KB。

## Constraints

- 视频由外部工具生成，画面为纯黑背景（`#000000`），不含 alpha 通道。
- 应用只有深色主题，`--surface-app` 为 `#101010`；纯黑方块不能出现在页面上。
- 现有 `tests/brandAssets.test.ts` 会枚举 brand 目录文件集合，新增资源必须同步更新测试。
- 不改动其他使用 `LOGO_SRC` 的位置（顶栏、侧栏、关于页、话题列表）。

## Acceptance Criteria

- [ ] 首页 hero logo 渲染为 120×120，其他位置的 logo 尺寸不变。
- [ ] hover 播放动画，视频从静态 logo 构图开始，画面黑底在页面背景上不可见。
- [ ] 动画结束停在最后一帧；`mouseleave` 后 200ms 内回到静态 logo。
- [ ] 首次 hover 前不下载视频（`preload="none"`，hover 时才触发加载）。
- [ ] `prefers-reduced-motion: reduce` 与触摸设备下不播放视频。
- [ ] `pnpm test` 中 `brandAssets` 通过，新增视频资源有尺寸/格式断言。
- [ ] 视频文件已去音轨、尺寸 ≤ 360×360，且体积显著小于原始 640 KB。

## Notes

- 原始素材：`~/Downloads/9998207770236612-…-video_task_…mp4`，768×768、24 fps、5.17 s、H.264 + AAC，首帧与 `logo.webp` 差异 0.13% 像素。
- 素材收尾为青蛙帽压下来遮住眼睛，与首帧不同，所以不循环；按"停在最后一帧"处理。
