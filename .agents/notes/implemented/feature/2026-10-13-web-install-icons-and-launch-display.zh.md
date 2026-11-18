# Agent Note: Web 安装图标与启动显示

Status: implemented

[English](2026-10-13-web-install-icons-and-launch-display.md) | 中文

## Problem

启动器会自行选择放到桌面上的图标，并对它套用蒙层。安装 manifest 使用的却是鲸鱼 favicon：一个铺满整张画布、背景透明的 SVG 标记，既没有底板，也没有自己的背景。交给蒙层后，标记会丢掉尾鳍，并且以错误的比例填满图标。iOS 完全不读 manifest 图标，此前又没有 `apple-touch-icon` 可回退，因此安装后的 web app 只显示通用图标。manifest 还请求了 `display: "fullscreen"`，这在 Android 上会同时移除两条系统栏，让一个对话界面失去时钟、电量和导航。

## Decision

`apps/web/public/` 承载四个安装图标：192px 与 512px 的 `any` 位图、512px 的 `maskable` 位图，以及 180px 的 `apple-touch-icon`。[`render-app-icons.ts`](../../../../apps/web/scripts/render-app-icons.ts) 从 `apps/desktop/resources/icon.svg` 的官方应用底板渲染这四个文件，`pnpm --filter @deepseek-ai/dsh-web-frontend run render:app-icons` 重新生成已提交的文件。每个变体都保留鲸鱼的几何路径、渐变、透明度和滤镜。渲染先生成不小于源图 1024px、且边长至少为输出尺寸四倍的位图，再以 Lanczos3 下采样。分开的栅格化步骤在平滑小图标曲线的同时保留原有明暗细节。每个变体都会裁掉底板的桌面投影。maskable 变体围绕底板中心按 `MASKABLE_ARTWORK_SCALE` 缩放鲸鱼，而底板渐变保持自身范围，因此可能被蒙层裁掉的那圈边框仍是真实底板，而不是与其相接的纯色。

[`pwa-manifest.e2e.ts`](../../../../apps/web/tests/pwa-manifest.e2e.ts) 使用浏览器图像解码器测量已提交 maskable 图标的鲸鱼墨迹半径，拒绝越出平台安全区或小于预期比例的图案。未缩放图块超出该安全区，用作反向对照。

manifest 请求 `display: "standalone"`，把 `theme_color` 与 `background_color` 定为 `#ffffff`，并列出三个位图。`apps/web/index.html` 增加 `apple-touch-icon` 链接、`mobile-web-app-capable` 与 `apple-mobile-web-app-title`。它不添加 `theme-color`：该节点由 `ThemePresenter` 独占并跟随解析后的应用内主题，这是静态媒体查询做不到的。标签页 favicon 保持不变。

本决策取代[已归档的 Web 安装 manifest 记录](../../archived/feature/2026-08-06-web-install-manifest.md)中的图标条目与显示模式；其指向 manifest 的链接、产品名、简称与根路径身份仍然有效。

## Alternatives considered

**只保留 `favicon.svg` 作为图标。** 这会让不读 manifest 图标的 iOS 只显示通用图标，而该标记已经抵达自身边界，启动器的蒙层必然裁切它。`pwa-manifest.e2e.ts` 把未缩放图块的越界保留为浏览器像素反向对照。

**不使用生成器，直接提交位图。** 底板素材随桌面应用图标变化。手工导出的图标集会静默漂移，也无法记录使其可安装的裁剪方式与安全区缩放。

**另画一个浏览器专用标记。** 产品只有一个已批准的底板。第二个标记需要设计师批准，并且无法与旁边已安装的桌面应用保持一致。

**保留 `display: "fullscreen"`。** 隐藏两条系统栏适合沉浸式界面，而不适合用户对着时钟阅读、并从应用切换器返回的对话；`fullscreen` 也无法在不滑动的情况下恢复系统栏。

**为离线启动引入 service worker。** 安装、启动与重连都不需要它。离线使用是独立能力，有自己的缓存失效约定，当前没有需求要求它。

## Consequences

仓库携带四张已提交的栅格图，均由同一个脚本从 `apps/desktop/resources/icon.svg` 渲染。桌面图块变化时，需要重新运行该脚本并审查 PNG diff。单元测试直接检查已提交 PNG 的尺寸，不加载原生渲染器。浏览器测试执行生成器，并解码生成结果和全部四张构建后的 PNG，以两个像素的栅格化容差检查声明边长、不透明角落及相对于源图块的图案范围。maskable 检查同时限制图案范围的上界和下界，并以未缩放图块作为安全区反向对照。测试也将 Apple 图标曲线边缘的部分像素覆盖与直接小尺寸渲染的 SVG 对比；后者保留源图的硬像素边缘。

manifest 的 `theme_color` 是单个值，无法跟随应用内主题；因此当用户选择的主题与系统方案不同时，该值会一直生效，直到 `ThemePresenter` 在启动后不久写入同步节点。该 presenter 仍是 `meta[name="theme-color"]` 的唯一所有者：第二个静态节点会在文档顺序上胜出，使周边浏览器界面与已渲染的配色脱节，这一点由 `settings-chrome.e2e.ts` 固定。

iOS 忽略 `background_color`，并用自己的圆角矩形裁切触摸图标；底板自带的留白使鲸鱼避开该蒙层。Android 为桌面选择 maskable 位图，为安装界面选择 `any` 位图。安装图标不是 service worker：安装后的 Web App 仍要求 Host 可达。

真机安装、启动显示与窗口模式仍属设备检查。
