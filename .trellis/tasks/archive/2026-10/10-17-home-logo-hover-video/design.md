# 技术设计：首页 logo 120px 与 hover 动态视频

## 边界

- 只改 `packages/studio/src/features/agent/ui/HomeWelcome.tsx` 中 hero 处的那一个 `Avatar`，以及对应的 `agentChat.css`。
- 只新增品牌资源：`packages/distribution/public/brand/logo-loop.mp4`；`brand.ts` 增加 `LOGO_LOOP_SRC` 常量。
- 不动 `AppFrame`、`AboutPage`、`TopicSidebar` 中的 `LOGO_SRC`。

## 资源

| 项 | 值 |
|---|---|
| 源 | 768×768 / 24 fps / 5.17 s / H.264 + AAC / 640 KB |
| 产出 | 360×360 / 24 fps / 5.17 s / H.264 / 无音轨 / 目标 ≤ 200 KB |
| 路径 | `/brand/logo-loop.mp4?v=20261017` |

为什么 360：120 CSS px 在 2× / 3× DPR 下需要 240 / 360 设备像素，360 是上限覆盖点。再大只增加体积，1024 原尺寸没有必要。

处理方式：本机无 ffmpeg，用 AVFoundation（`AVAssetExportSession` + `AVMutableVideoComposition`）缩放并丢弃音轨。缩放用 `AVVideoScalingModeResizeAspect`，源为正方形，输出仍正方形，无裁切。

## 组件

`HomeWelcome` 的 hero 处替换为一个小型本地组件 `HeroLogo`（同文件内或 `HeroLogo.tsx`）：

```
<div class="agent-home-logo-wrap" onMouseEnter onMouseLeave>
  <img  class="agent-home-logo" src={LOGO_SRC} />
  <video class="agent-home-logo-video" src={LOGO_LOOP_SRC} muted playsInline preload="none" />
</div>
```

行为：

- `mouseenter`：`video.play()`；播放结束后（`onEnded`）不重置，保持最后一帧；`.is-active` 使 video 淡入。
- `mouseleave`：`.is-active` 移除，video 淡出；暂停播放。若未播完，下次 hover 从暂停处继续（不再 `play()` 之外重置）；若已播完，`currentTime = 0` 后 `play()`。
- `prefers-reduced-motion: reduce`：不挂事件，video 不渲染。
- 触摸设备：用 `(hover: hover) and (pointer: fine)` 媒体查询控制 video 是否参与布局；不满足时不渲染 video（避免 iOS 上 `preload` 行为差异）。

## 黑底处理

视频无 alpha，背景是 `#000000`，页面 `--surface-app` 是 `#101010`。

- 静态 logo 是透明镂空，直接铺在页面背景上。
- 视频需要黑色当透明：`mix-blend-mode: lighten`（取视频与页面底色中较亮者，纯黑和圆盘 #0D 都变成 #101010）。`screen` 会把圆盘抬到 #202020，圆形 clip-path 会留下黑环，均已否决。播放时静态图需淡出，否则 lighten 会保留两层造成重影。
- wrapper 不能设 `isolation`，否则混合不到页面背景。

若后续出现浅色主题，需要改成带 alpha 的 WebM；当前不处理。

## 交叉淡入

两个元素叠在同一个 120×120 盒子里，绝对定位。`opacity` 过渡 200ms，`visibility` 延后切换，避免淡出时不可见。

- 淡入：video opacity 0→1，img 仍在下层（img 一直可见，video 覆盖）。
- 淡出：video opacity 1→0，露出 img。
- 这样无需给 img 做淡出，减少一次重绘。

## 兼容与降级

| 情况 | 行为 |
|---|---|
| `prefers-reduced-motion` | 静态 logo |
| 触摸 / 不支持 hover | 静态 logo，不请求视频 |
| 视频加载失败 / 解码失败 | `onError` 隐藏 video，静默回落到静态 logo |
| 首次 hover 尚未缓冲 | 静态 logo 继续显示，video 就绪后自然出现 |

## 测试

- `tests/brandAssets.test.ts`：文件集合加入 `logo-loop.mp4`；新增断言：MP4 `ftyp` 头、宽高 360×360、无音轨（`mdat` 内不解析轨道，改用文件大小上限 + 头校验）。
- 头校验读 `moov` 太重；改为断言文件头 `ftypisom`/`ftypmp42`、大小 < 250 KB。
- 不新增组件测试（仓库现有测试偏资源与逻辑层，无 DOM 测试基建）。

## 回滚

新增资源与一处组件改动，回滚即删除资源、还原 `HomeWelcome.tsx` / `agentChat.css` / `brand.ts` / 测试。
