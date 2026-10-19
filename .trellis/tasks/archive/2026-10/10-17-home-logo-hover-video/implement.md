# 执行计划

## 1. 视频资源

- [ ] 用 AVFoundation 脚本把源 MP4 缩到 360×360、丢音轨，输出到
      `packages/distribution/public/brand/logo-loop.mp4`
- [ ] 校验：尺寸 360×360、无音轨、时长 5.17 s、体积 < 250 KB
- [ ] 抽首帧与 `logo.webp` 对比，确认缩放后构图一致

## 2. 品牌常量

- [ ] `packages/distribution/src/brand.ts` 增加
      `export const LOGO_LOOP_SRC = "/brand/logo-loop.mp4?v=20261017";`

## 3. 首页组件

- [ ] `HomeWelcome.tsx` hero 处：48px `Avatar` → `HeroLogo` 120px
- [ ] `HeroLogo` 实现 hover 播放 / 移开淡出 / ended 停帧 / reduced-motion / 触摸降级
- [ ] 其他两处 `agent-home-logo` 的小尺寸头像不受影响（沿用原类名或另设类名）

## 4. 样式

- [ ] `agentChat.css` 新增 `.agent-home-logo-wrap`（120×120、relative、isolation）、
      `.agent-home-logo-video`（absolute、inset 0、object-fit contain、mix-blend-mode screen、opacity 过渡）
- [ ] `(hover: hover) and (pointer: fine)` 与 `prefers-reduced-motion` 媒体查询

## 5. 测试

- [ ] `tests/brandAssets.test.ts`：文件集合加入 `logo-loop.mp4`，新增 MP4 头 / 尺寸 / 体积断言

## 6. 验证

- [ ] `pnpm test -- brandAssets`
- [ ] `pnpm lint` / `pnpm typecheck`（按仓库脚本实际名称）
- [ ] 本地起 web 应用，肉眼确认 hover 淡入、停帧、移开回落、黑底不可见

## 回滚点

每一步独立可回滚；第 1 步只加文件，第 3–4 步是单组件改动。
