# Agent Note: 共享文件类型图标

Status: implemented

[English](2026-09-08-shared-file-type-icons.md) | 中文

## 问题

客户端功能插件只能通过 `@deepseek-ai/dsh-client-ui-primitives` 共享 React 组件，但文件卡片没有共享的文件类型呈现。`LinkIcon` 拥有唯一一份扩展名表，并有意把路径折叠为六种链接类别；附件卡片、已发送消息附件、排队文件和工作区文件行则统一使用一个通用文档图形。其中两个消费方还各自带着一份扩展名展示辅助函数。在其他位置增加精细文件图标，需要再复制一份扩展名表或让功能插件之间产生运行时 import。

## 决策

`ui-primitives` 统一拥有一套 Cordis-free 的文件分类与渲染 API。`fileExtension(path)` 对两种路径分隔符采用共享的 basename 与最终点号语义。`classifyFileType(path)` 不区分大小写，并返回闭合的 `FileType` 联合：传统的 `code`、`excel`、`folder`、`html`、`image`、`markdown`、`other`、`pdf`、`ppt`、`video`、`word` 类别，以及由 `CodeFileIcon` 渲染的细分 `CodeFileType` 集合。解析按完整文件名、文件名前缀、文件名后缀、可选项目上下文、扩展名的顺序执行。路径分类器返回 `folder` 之外的全部成员；调用方确认条目是目录时，通过 `FileTypeIcon` 的显式 `kind` 覆盖指定目录。未知扩展名、无扩展名和末尾点号回退到 `other`，但共享表识别 `Dockerfile`、`Makefile`、`package.json`、`.gitignore`、`README`、`CHANGELOG` 等具名文件。

`FileTypeIcon` 接受路径、共享 `IconProps`、显式 `kind`和可选的项目文件快照。传统文件类型把所提供的 28px 文档与文件夹轮廓渲染为 inline SVG。Excel、Markdown、PDF、PPT、Word 的前景标记围绕自身视觉中心缩放至 122%，其余带标记的传统图形使用 112%；文件底板与折角保持源图几何，通用文件不凭空增加中心标记。底板使用实色分类颜色，前景标记与普通折角使用白色，通用文件使用较深的灰色折角。CSS 通过静态设计 token 分配所提供的分类调色板：code/HTML/Markdown 使用 DeepSeek 蓝，Word 使用较浅的 DeepSeek 蓝，Excel 使用绿色，folder/PPT 使用两档琥珀色，PDF 使用红色，未知文件使用中性灰。image 与 video 通过组件本地变量共用所提供的紫色，因为设计平台没有匹配的紫色 token。调用方可通过 `--dsh-file-type-icon-color` 覆盖传统底板颜色。

已识别的代码与配置文件把对应的 20px 方形图稿缩放到请求的图标尺寸。内嵌静态表只包含现有 48 个 `CodeFileType` 条目；资源包中额外的图稿不会新增类别，相邻 manifest 记录负责的设计归属方与来源摘要。测试会拒绝该表中的脚本、事件属性、外部引用与重复 id。`CodeFileIcon` 在插入前为本地 SVG id 加上组件实例前缀，使重复渐变与裁剪路径互不干扰。这些技术标记保留自身内嵌的多色填充，是普通 current-color 图标规则的明确例外。映射让 React 优先于 TypeScript/JavaScript、Angular 文件名后缀优先于基础扩展名，并按文件名识别 Docker/Node/Git/Make/CMake；只有可选项目快照包含内容带 `flutter:` 的 `pubspec.yaml` 时才选择 Flutter。Markdown 与 SVG 仍由传统 Markdown 和图片类别拥有。CSV 和 TSV 在文件卡片、文件行及预览标题中使用 code 图标，其可点击链接也使用 code。`.env` 和以 `.env` 结尾的文件名均使用环境配置图标。所有传统与技术 SVG 都是 `aria-hidden` 的，拥有文件身份的卡片、行或按钮提供无障碍名称。

`LinkIcon` 委托 `classifyFileType` 做扩展名分类，再把精细结果折叠进原有链接词汇：code 与 HTML 使用 `code`，图片使用 `image`，PDF/Word/Excel/PPT 使用 `document`，Markdown、video 与未知文件使用 `other`。无扩展名文件在链接语境中仍是 `other`，因此[可点击链接决策](2026-09-04-web-clickable-link-styles.zh.md)定义的 14px 外观不变。

附件上传卡片、已发送消息文件卡片、排队文件行和工作区文件行渲染 `FileTypeIcon`。Files 标签页标题使用显式的 `folder` 类别，尺寸为 16px。显式交付卡片使用 20px 的 `FileTypeIcon`，并通过 `fileExtension` 提供默认元数据。两处元数据行使用 `fileExtension`，不再保留本地解析器；`.env` 这样的前导点 basename 会显示 `ENV`，无后缀或末尾点号则不显示扩展名 label。图片内容继续渲染为预览而不是文件类型图形，产物文件链接与 Markdown 文件提及继续使用 `LinkIcon`，因为它们属于链接表面。

## 备选方案

**所有文件表面都使用 `LinkIcon`。** 否决。它的六种类别和 14px outline 图形用于在文字尺寸下表达链接目标；28px 文件卡片有空间表达所提供的 HTML、Markdown、PDF、Word、Excel、PPT 与 video 身份。

**在 `LinkIcon` 旁保留第二份扩展名表。** 否决。任一列表增长后，同一路径可能漂移到不同类别。一份精细表加一个显式的精细到链接适配，能同时保住两类消费方的语义。

**把所提供的传统文件颜色直接写入每一条 SVG path。** 否决。传统 SVG 几何保持可复用，并遵守图标集的 `currentColor` 规则；组件样式表拥有默认分类调色板，渲染点只需一个 CSS 变量即可覆盖颜色，不需要重写 path 填充。技术图稿是例外，因为其内嵌的多色标记用于识别语言或工具，而不是装饰通用文件轮廓。

**为了对称增加 archive、audio 与 data 类别。** 否决。提供的图稿与当前消费方都不需要这些图形。新增 `FileType` 成员必须有已发布的渲染点，以及在 28px slot 中仍可辨认的图稿。

## 测试

`ui-primitives` 测试覆盖不区分大小写的后缀、两种路径分隔符、前导点文件、无后缀与末尾点号、常见具名文件、未知回退、全部细分代码映射、规则优先级、Flutter 上下文、精确的 48 键图稿集、被拒绝的资源包额外类别、静态 markup 安全性、实例安全的 SVG id 与引用、`aria-hidden`、尺寸/class 转发、不同图稿、112% 与 122% 前景标记变换，以及不含 SVG 字面颜色的传统实色底板/对比标记层。样式表测试钉住每一项传统类别到颜色的映射、调用方覆盖变量与本地紫色值。既有 `LinkIcon` 分类表钉住它的粗粒度输出，包括 `Makefile` 仍为 `other`。附件、聊天、队列和侧边栏组件测试覆盖迁移后的渲染路径；由于图形仍是装饰性的，其无障碍输出不变。

## 后果

- 客户端包使用一个文件名解析器与一份精细文件类型表，不再 import 或重新实现功能包本地逻辑。
- 新后缀只在已有图形能准确表达它时加入精细表。若它的链接类别与当前适配不同，这次改动还必须决定是否改变 14px 链接外观。
- 代码与配置图稿保留内嵌调色板，不接受传统图形的 `--dsh-file-type-icon-color` 覆盖。
- 固定的 48 项图稿表为共享浏览器 bundle 增加约 35 kB 未压缩体积和 17 kB gzip 体积；新增类别必须证明这份静态基线成本是必要的。
- primitive 不拥有文案，但拥有默认文件类型调色板。消费方继续拥有无障碍 label 与周围文字，并可通过 `--dsh-file-type-icon-color` 替换分类颜色。
- 精细类别名称描述展示意图，不是 MIME 校验。后缀只是展示提示，不能证明文件内容或可信度。
