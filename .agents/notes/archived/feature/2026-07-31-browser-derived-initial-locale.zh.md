# Agent Note: 全新浏览器打开的设置语言由浏览器决定

Status: implemented
Archived: 2026-09-04

[English](2026-07-31-browser-derived-initial-locale.md) | 中文

## Problem

设置里的语言行在每一次首访时都以中文开场：`LocaleRuntime` 从 localStorage 读取 `dsh.locale`，读不到就直接回落到 `zh`。浏览器本已声明其使用者阅读哪些语言——`navigator.languages` 就是这份声明——而应用对此视而不见，于是英文读者迎面撞上一个中文产品，还得先找到一行中文标签的设置项才能脱身。回落值当时同时承担两份职责：既是无法解析出 locale 时的最后兜底，也是所有从未做过选择的用户拿到的答案。

读取浏览器可以让浏览器声明了已注册语言的读者获得对应界面，但当当前目录没有匹配项时，产品仍需一个稳定的最终选择。若目录中只有内置语言，请求既非 `zh` 也非 `en` 的浏览器（`fr`、`de`）就会进入这种情形，而这些读者恰恰最不可能阅读中文。

## Decision

**暂定 locale 先经浏览器、再经 `FALLBACK_LOCALE`（`en`）解析；显式 Host 偏好会实时替换它。** `packages/client/locale/src/client/index.ts` 中的 `resolveInitialLocale()` 在服务构造时和每次语言目录变化后运行，依据当时已注册的定义表达浏览器／回落顺序。随后，非阻塞 settings 生命周期会应用 `$DSH_HOME/settings.yaml` 中可选的 `locale.preference`；若该值缺失，则继续使用由浏览器派生的值；若已保存的 id 暂不可用，则保留待采用状态，并在对应语言注册后生效。

**开场时的最终回落与字典链终点共用一个常量。** `FALLBACK_LOCALE` 同时回答「浏览器未声明任何已注册语言时，界面以哪种语言开场」与「每条已声明的字典 fallback 链必须在哪里结束」。这是两个不同的问题，若其中任一答案必须不同，拆成两个常量才是对的。外部语言可以贡献不完整字典并声明中间 fallback，但每条链最终仍到达 `en`。每一对内置 `zh`／`en` 字典都声明完全相同的 key 集合，因此最后一次回落能够解析；`scripts/locale-dictionary-parity.spec.ts` 会拒绝只加在内置一侧的 key，避免它日后在运行中的界面里显现为形如 `list.aria` 的裸 key。

**浏览器匹配使用已注册目录和浏览器的有序列表。** `detectBrowserLocale()` 遍历 `[...(navigator.languages ?? []), navigator.language]`。每个浏览器标签先精确匹配已注册 id，再按主子标签匹配，因此已注册的 `pt-BR` 会响应同名请求；`zh-Hans-CN` 与未精确命中的 `zh-TW` 会落到内置 `zh`，`en-GB` 会落到 `en`。若浏览器只请求未注册语言（在只有内置目录时如 `fr`、`de`），匹配不会产生结果，并由 `FALLBACK_LOCALE` 接管。语言注册或移除时会重新计算这一暂定结果。`navigator.language` 排在列表之后，并兜住那些 Navigator 上没有 `languages` 的宿主；容忍该运行时缺失与 `localStorage` 守卫表达的环境边界不信任同源。

**判定浏览器用的是 `window` 而非 `navigator`。** Node ≥ 21 暴露全局 `navigator` 并报告机器自身语言，因此以 `navigator` 把关会让 node 启动客户端树时解析成机器语言，而非文档约定的回落值。以 `window` 把关可使所有非浏览器运行都停留在 `FALLBACK_LOCALE`。

**显式选择具有持久性。** `setLocale` 通过 Host settings API 写入，因此选过语言的用户可在共享同一 DSH home 的不同浏览器 origin 与系统语言之间保留原选择。没有任何代码把探测到的 locale 写回：探测在每次启动时重新推导，对「用户是否做过选择」这一问题始终不可见。

**`<html lang>` 跟随解析出的 locale，而所服务的 markup 做不到这一点。** `apps/web/index.html` 是一份静态文件，服务所有访问者，因此它声明什么都必然对某些人是错的：解析发生在客户端，在文档被解析之后。于是由 locale 插件依据当前 locale 设置 `document.documentElement.lang`——激活时设置一次，因为探测结果或已采纳的 Host 偏好可能已与 markup 不一致；此后每次切换再设置一次。markup 声明产品默认值（`en`），使启动前的文档不至于主动误导。无障碍技术与浏览器功能（发音规则、翻译提示、字体回退、拼写检查）都读取该属性，因此陈旧的值是在误报文档语言，而不只是看起来不整齐。外部语言 id 本身就是 BCP 47 标签，会原样进入该属性；内置 `zh` 简写是唯一例外，它声明为 `zh-CN`，因为单独的 `zh` 会使文字（script）含义不明。

**浏览器 e2e 车道固定浏览器语言。** 断言中文文案的场景（`access-confirmation`、`models-settings`、`onboarding-deepseek-config`、`settings-chrome`）以 `apps/web/tests/support.ts` 的 `locale: ZH_BROWSER_LOCALE` 打开页面；`newEnglishPage` 声明 `en-US`。`settings-chrome.e2e.ts` 两次使用没有显式 locale 的全新 Host home：`en-US` 浏览器与 `fr-FR` 浏览器都会抵达英文界面。真正钉住回落值的是 `fr-FR` 那个场景——`en-US` 浏览器无论走探测还是走回落都会落在英文，因此只有本应用不提供的语言才能区分二者，而中文场景则证明探测仍然覆盖回落值。

## Alternatives considered

- **`Intl.DateTimeFormat().resolvedOptions().locale` 或单读 `navigator.language`**：两者都把用户的有序偏好列表塌缩成一个标签，于是 `['de', 'en', 'zh']` 的读者拿到的是 zh 而非 en。列表恰恰是浏览器这份声明里最值得读的部分。
- **首次启动即持久化探测结果**：那会把探测变成一次性事件，让一次陈旧的首访凌驾于此后改变的浏览器语言之上，也摧毁了整个解析顺序所依赖的区分——存储值将不再意味着「用户选了它」。
- **完整的 BCP 47 协商（`Intl.LocaleMatcher` 式查找、地区与文字权重）**：语言注册会提供明确的 id，字典 fallback 也有独立的显式配置。先精确匹配 id、再匹配主子标签，既保留了内置行为，也无需在外部注册的变体之间虚构隐式距离策略。
- **为回落 locale 增加一个 Cordis 配置键**：此处部署之间并无差异——回落值是产品对「完全没有信号」给出的答案，不是旋钮。仓库策略把 `Config` 字段留给有当前消费方、且随部署变化的选择。
- **拆成两个常量，一个管开场 locale、一个管字典回落**：它区分了两个确实不同的问题，若两个答案不同也确有必要。但它们并不不同：字典是对称的，因此两者都是 `en`，第二个常量只会是同一个值的两个名字，外加一条无人强制的规则。对称性本身值得强制，所以直接为它设门禁。
- **开场用 `en`、字典回落仍保留 `zh`**：这看起来是保守选择，但在字典对称的前提下，它能解析的 key 与 `en` 完全相同，因此毫无收益；而在它真正会起作用的情形——某个 key 只存在于 `zh`——在整体英文的界面里渲染出中文文本，比让 reviewer 一眼看见裸 key 更糟。
- **让 e2e 车道的中文场景继续钉存储项（`dsh.locale=zh`）**：那会让套件保持绿色，却抹掉浏览器推导路径在组装后应用中唯一的运行处；改钉浏览器语言才能端到端地演练新的解析过程。
- **按请求服务 `<html lang>`，或干脆不管这个静态属性**：在服务端计算它需要用请求的 `Accept-Language` 去重新推导客户端本就会解析的结果，使同一条规则在两处重复，而且仍会输给服务端并不读取的存储偏好。放任其保持静态，正是该属性对某一种语言永远错误的原因。依据解析出的 locale 来设置，可保持单一真源。

## Consequences

- 首次访问会从浏览器的有序列表中选择第一个匹配的已注册语言。若目录中只有内置语言，英文浏览器进入英文界面，中文浏览器进入中文界面，两者皆未声明的浏览器则进入英文而非中文界面；外部注册项会加入同一个语言行与匹配过程。
- 字典解析最终到达 `en`：内置 `zh` 缺失 key 时直接到达它，外部语言则先按自己声明的链逐 key 回落。内置字典对称性保证已提供的文案完整，这正是对称性门禁存在的原因。
- `<html lang>` 现在在两个方向上都如实报告屏幕上的语言，这也关闭了 [#2160](https://github.com/deepseek-harness/deepseek-harness/issues/2160)。若某个客户端从未激活 locale 插件，则保留所服务的默认值，因此该属性退化为旧的静态行为，而不会退化为空值。
- 客户端树的非浏览器运行（node 启动、非 jsdom 单测车道）现在以 `en` 开场。断言已提供中文文案的用例必须在其构造的 runtime 上显式调用 `setLocale('zh')`；套件级的 `usePinnedBrowserLanguages('zh-CN')` 仅在同时声明了 `@vitest-environment jsdom` 的文件中生效，因为没有 `window` 时探测路径根本不会读取 `navigator`。此前有七个 `*.client.spec.ts` 文件带着这样一条失效的固定语句，实际依赖的是旧的 `zh` 回落值。
- 探测的代价是每次服务构造或语言目录变化时遍历一次数组，且不会隐式写入 settings；插件激活后或待采用语言注册时，显式 Host 偏好可能引发一次实时收敛。
