# Agent Note: 插件自有的多语言展示元信息

Status: implemented

[English](2026-09-18-localized-package-metadata.md) | 中文

## 问题

Plugin Manager 需要为已安装的 bundle 与各个插件展示可读的标题和描述，包括尚未启用的插件。同一个 npm 包可以导出多个用途不同的插件，包级介绍无法分别描述它们。依赖激活来注册介绍，也会让禁用或加载失败的插件缺少展示文案。

## 决策

每个插件从 `locale/en.json` 开始，在自己的 `locale/<language>.json` 资源中提供可选的 `meta.title` 与 `meta.description` 字符串。这些字符串直接提供展示标题和描述。locale 的其他顶级内容仍归现有消费方所有，不进入元信息响应。

```json
{
  "meta": {
    "title": "File Search",
    "description": "Search files in your workspace."
  }
}
```

资源地址归 Cordis 配置中的插件名所有。Node 模块解析通过适用的 profile 和包 exports 选择文件，不执行插件代码：

| 插件形式 | locale 资源 |
|---|---|
| npm 包 `my-plugins` | 请求 `my-plugins/locale/en.json`，由 `./locale/*.json` 导出 |
| npm 子路径 `my-plugins/search` | 请求 `my-plugins/search/locale/en.json`，由 `./search/locale/*.json` 导出 |
| JavaScript 路径 `./plugins/search.js` | 不查找同级资源；配置中的路径名作为标题的最终回退 |

locale 地址不从解析后的 JavaScript 文件名或所属包目录推导。文件路径与文件 URL（包括 Windows 盘符路径和 UNC 路径）跳过资源解析，返回无元信息；文件地址本身不构成元信息错误。它们既不提供同级 locale 元信息，也不提供旁边的包 manifest（元数据清单）。目录示例、exports 声明、发布条目与作者验证步骤由[添加包实操手册](../../../../docs/cookbook/adding-a-package.zh.md#plugin-display-metadata)维护。

同一插件的语言文件放在同一目录。Host 解析 `en.json`，从所在目录发现语言文件名，再用同一插件模块名与父 URL 解析各个资源。英文资源作为发现入口，但任何语言都可以省略任一展示字段。语言标识不区分大小写，重复标识拒绝。locale 中声明的展示字段必须是非空字符串。

Host 读取已安装 bundle 及其声明的插件行，不 import 或激活它们。Remote 携带两个展示字段的多语言值或纯文本回退值。Client 在渲染时复用现有 locale 的语言选择与回退链，不增加语言注册、插件级默认语言或另一套语言回退规则。

每个字段先独立回退，再按页面规则格式化技术名称：

| 字段 | 现有 locale 语言回退链 | 同地址包字段回退 | 最终回退 |
|---|---|---|---|
| 标题 | `meta.title` | `<插件模块名>/package.json` 中非空的 `name` | Cordis 配置中的完整插件名 |
| 描述 | `meta.description` | `<插件模块名>/package.json` 中非空的 `description` | 不提供包描述 |

包字段回退遵守资源 exports，并且仍属于同一插件地址，子路径不继承所属包的介绍。字段有其他语言译文但没有英文值时，Host 将包字段或最终值放入英文回退位，保持现有 Client locale API 不变。资源不存在、未导出或缺少字段时使用上述回退；locale 字段无效或文件格式损坏时明确诊断，不静默回退，同时保留管理操作。

插件管理页在已安装 bundle 的卡片和详情、组件列表、组件配置详情中使用这些元信息，保留完整技术名回退。设置中的插件清单也使用它，包括预设内插件，但会移除字面包名和模块名回退值的 npm scope 与 Cordis/DSH 前缀。两个页面都原样展示翻译标题；完整模块名、条目 id、搜索身份与操作目标保持不变。具体前缀规则由[设置插件清单 README](../../../../packages/client/ui-settings-plugin-inventory/README.zh.md#use-this-package)维护。

行配置页仅在插件没有展示描述时使用注册组件的 `summary` 视图。组合包原始的 `description` 字段仍供 Host 与模型消费方使用，不作为绕过资源 exports 的额外 UI 回退。这些规则只展示一份描述，同时保留无描述插件的配置摘要。

禁用插件不需要激活即可读取。Install 界面仍使用 `pnpm view` 返回的 registry 信息，不用 locale 元信息替换。安装前的 registry、Git 和 tarball 查询不为翻译读取远程包内容。模型工具结果保留现有包信息，不携带供 UI 使用的多语言字典。Session 事件不变。

内置 bundle 的介绍放在其导出的语言文件中。beta 标记、页面分组、配置槽归属与启停目标保持原样。插件介绍和组件自身的交互文案各自保持所有权。

## 现有决策

[公共包声明](../../implemented/architecture/2026-09-10-public-package-manifest.zh.md) 继续约束 manifest 类型和读取者的职责；[locale-owned UI copy](../../implemented/architecture/2026-08-23-locale-owned-client-ui-copy.zh.md) 继续约束组件文案和展示身份；[插件配置页](../../implemented/architecture/2026-09-16-plugin-configuration-on-the-plugins-page.zh.md) 继续决定配置槽归属。插件元信息只扩展展示数据，不取代这些决策。

## 考虑过的替代方案

**在 Plugin Manager 中继续维护内置包词典。** 每增加一个包都需要修改管理器，而且外部插件无法独立提供翻译。

**在 package.json 中声明引用。** 将声明重复放在 manifest 与 locale 文件中，而且一份包级声明无法区分包内导出的插件。

**从解析后的 JavaScript 文件旁读取 locale。** 构建工具可能把多个插件入口放在同一目录。资源 exports 让各插件的身份独立于编译产物布局。

**由被展示插件激活时注册文案。** 未启用包、无 Client 半边的包和加载失败的包仍然需要可读的介绍。

**增加 base.json 或包级 fallback。** 会与现有 locale 的英文兜底和扩展语言回退链产生第二套规则。

**为安装前预览下载远程包。** 扩大查询成本及需要处理的包内容；本期只处理已经存在于本地的文件。

## 验证

- bundle、子插件与只读 inventory 展示本地元信息；禁用包不需要激活即可读取。
- 切换语言更新标题和描述；设置页仅缩短字面技术名回退，不缩短翻译标题，也不改变模块身份和操作目标。
- 直接元信息、无关 locale 内容、缺失资源、损坏 JSON、缺失展示字段及语言标识冲突均有针对性覆盖。
- 同包的不同 exports，以及不同父目录中的同名包，各自保持独立元信息，读取不执行插件入口。
- Windows 盘符路径、UNC 路径、相对与绝对文件路径及文件 URL 均不调用资源解析，直接返回无元信息。
- locale 资源或个别字段缺失时，各字段独立回退到该插件地址的包字段，再回退到完整模块名且不显示描述。
- 发布检查要求资源 exports 可解析且包含语言文件，内置文案不在管理器和插件中双份维护。
- 管理工具保留现有模型输出，安装前查询不增加包内容探查。
- 针对性测试以及完整 `pnpm run build` 通过。

## 影响

遗漏语言文件或 exports 会使发布后的元信息不可用，因此验证覆盖解析与打包后的文件。元信息错误作为单插件诊断呈现，不能让整个管理页失去修复入口；文件诊断保留绝对路径。展示元信息按请求读取，不设元信息缓存。查询保留完整模块名及其解析父地址；只按包名缓存无法区分导出插件或不同安装目录。
