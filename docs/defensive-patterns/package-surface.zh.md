# 包面规则

[English](package-surface.md) | 中文

关于包导出什么、怎么构建、如何声明依赖的规则。布局本身见 [development.zh.md](../development.zh.md#typescript-project-layout)；常设条款见 [packages/AGENTS.md](../../packages/AGENTS.md)。

## 插件包导出 Loader 所需的东西

插件包的入口取两种形态之一，两者不得混用。**函数插件**具名导出 `name`、`inject`、`Config`、`apply`：`name`、`inject`、`apply` 全小写，`Config` 首字母大写，且同时以 `interface` 与 Schemastery schema 值两种形态出现。**服务插件**默认导出它的服务类，Loader 就是这么加载它的；在四件套旁边再加一个默认导出，会让 Loader 丢弃函数插件的命名空间。除这两者之外，Host 入口可以导出供其他包 `extends` 或 `throw` 的 Service Definition 类与错误类型——能力接缝消费的正是这些——但绝不导出测试便利值。UI 插件包的 `/client` 入口更严，[packages/client/AGENTS.md](../../packages/client/AGENTS.md) 是那条纪律的正家：同包测试用相对 `../src/...` 路径或 `./src/*` 子路径触达内部，测试专用的需要因此永远不会变成常驻导出。

- Loader 四件套及其准确形态见 [cordis-primer.zh.md](../cordis-primer.zh.md#loader-configuration)。
- 判定条件：函数插件的入口（`src/index.ts`）导出了四件套以外的实体；在四件套旁边加了默认导出，或两种形态被混用；`/client` 入口导出了实现值、或让另一个功能插件导入了实现值；fixture 用相对路径引用其他包。
- 边界：只约束 Loader 插件入口。内部模块、工具函数与 hooks 照常导出值；Host 入口的 Service Definition 类与错误类型是应有的导出；测试 fixture 也留在本包内——用相对路径伸进别的包的 `src` 会绕过 `exports` 映射与包边界检查。
- 例外：无默认例外；确需破例须经对应领域专家确认。

合规的入口——四件套，同包测试路径以注释记录，而不是加出第五个导出。

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

// The plugin entry: the Loader four, and no fifth value
export const name = 'web-app'
export const inject = ['webServer']
export interface Config { /* … */ }
export const Config = z.object({ /* … */ })
export function apply(ctx: Context, config: Config): void { /* … */ }

// A same-package test imports '../src/internal/header.ts' instead of this entry
```

三种写法都会让入口多出不该有的导出；三种都能在 diff 里看到。

```ts ignore-check
// The entry widened so a test could reach one helper
export { isHeaderLine } from './internal/header.ts'

// Both plugin forms on one entry: the Loader discards the four
export default class WebApp {}

// A fixture reaching into another package by relative path
import { isSurfaceEligibleType } from '../../core/session/src/surface.ts'
```

## 包只有两类，且两类都是动态插件包

新增包要么是 Host 包，要么是 Host + Client 包，两类都是动态插件包；没有第三种形态可选，也没有例外。shell 经 [packages/client/web/src/platform.ts](../../packages/client/web/src/platform.ts) 的 `PLATFORM_MODULES` 播种的静态客户端库——`client-store`、`ui-slots`、`ui-primitives`、`ui-dockkit`——以及 [packages/util/](../../packages/util/) 下的零依赖库先于本条规则存在，且**已关闭**：它们照原样继续工作，新增包永不加入其中。只有真正的双面包才拆编译面，生成物进 `lib`，`include`、`external` 与 roster 清单由扫描 workspace 得出，不手写。手写清单或新造编译面会让构建产物与清单不再一致，此后每个新增包都得各自维护清单。

- 判定条件：新增包未按动态插件包形态构建（static link 打包、手写的全 external 清单）；出现第三种 `tsconfig` 变体；手写 `include`、`external` 或 roster 清单。
- 形态不要照抄数字，就地复算：先列 `packages/*/*` 下的 `tsconfig.json`，再列同时带 `tsconfig.client.json` 与 `tsconfig.host.json` 的包，最后列声明 `dsh.client` 的包。
- 边界：双面包允许被 `include` 或 `exclude`。
- 例外：无；没有审批通道。包的形态或编译面变更须先改正家文档，并须经对应领域专家确认。
- 正家：[development.zh.md](../development.zh.md#typescript-project-layout) 管编译面，[packages/README.zh.md](../../packages/README.zh.md) 管包分组，[adding-a-package.zh.md](../cookbook/adding-a-package.zh.md) 管步骤。

属于两类之一的包：使用标准清单字段，没有手写 external 清单。

```json
{
  "name": "@deepseek-ai/dsh-example",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" }
  }
}
```

手写的 `external` 清单——以及在它旁边为单个包新造的 `tsconfig.foo.json`——让扫描无从推导，构建产物与清单随之不再一致。

```json
{ "name": "@deepseek-ai/dsh-example", "external": ["@deepseek-ai/*"] }
```

## `package.json` `exports` 使用标准键集合

`package.json` 的 `exports` 只使用标准键集合，集合中每个键在全仓已经只有一个含义，包不得为自己的局部用途开键。只有少数几个包在用、又没有文档正家的键不构成先例：把某个键正式化（包括下面那些未记录在案的键）意味着在同一次改动里改正家文档与检查。键集合小且共享，消费者才能从键名推断用途，扫描也才有可能判定导出映射。

- 标准键，每个键在全仓只有一个含义，统计口径是 `packages/*/*/package.json` 与 `apps/*/package.json`：`.`（包主入口）、`./package.json`（工具链访问，不是语义导出）、`./src/*`（测试与工具的源码透传，文档状态仍待定）、`./client`（浏览器入口，与 `dsh.client` 声明配对）、`./types`（类型入口）、`./typert`（typert 类型运行时）、`./remote`（`@Remote` 调用面）、`./locale/*.json`（本地化资源）、`./cordis.patch.yml`（`dsh.bundle` 声明的 bundle 补丁层）。这里不列各键的包数，因为下一个包就会让它过期；下面的复算命令会打印当前数字。
- 集合之外的键（`./brand` 5 个包、`./worker` 4 个、`./startup`、`./runner`、`./protocol` 各 2 个，另有大量一次性键）没有文档含义，属待核项，不是可照抄的先例。
- 判定条件：改动是否新增了标准集合以外的 export 键？
- 例外：无默认例外；新增键须先改正家文档与检查，并取得对应领域专家确认。
- 复算分布：

```sh
python3 -c "import json,glob,collections; c=collections.Counter(); [c.update(json.load(open(p)).get('exports',{}).keys()) for p in glob.glob('packages/*/*/package.json')+glob.glob('apps/*/package.json') if isinstance(json.load(open(p)).get('exports'),dict)]; print(c.most_common())"
```

合规的映射——三个标准键各按全仓含义使用，该包同时声明了 client 入口。

```json
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./types": { "types": "./lib/types/types.d.ts", "default": "./lib/types/types.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  }
}
```

为单个包的局部用途开的键——这里是文档地位待核的 `./brand` 与 `./worker`——让导出映射退化为各包自便的约定，消费者与扫描都读不懂。

```json
{
  "exports": {
    ".": "./lib/index.js",
    "./brand": "./lib/brand.js",
    "./worker": "./lib/worker.js"
  }
}
```

## 依赖声明与版本一致性由依赖扫描门禁保证

依赖声明与版本一致性由依赖扫描机械保证；本页既不复述 `devDependencies` 与 `peerDependencies` 的字段规则，也不另立包准入清单。扫描失败时，在本地复现并修正它指名的清单，因为规则的正家是扫描与其策略文件。为了让改动落地而修改扫描或放宽策略不属于常规改动，须经对应领域专家确认。

- 入口：[verify-package-dependencies.ts](../../scripts/verify-package-dependencies.ts)，以 `pnpm run verify-package-dependencies` 运行，被 `scripts/run-gates.ts` 作为 `package-dependencies` 门禁调用，`.github/workflows/release.yml` 也直接运行它。
- 策略正家：[package-dependency-policy.ts](../../scripts/package-dependency-policy.ts) 导出 `PACKAGE_DEPENDENCY_POLICY`；声明面、版本形态与豁免都在该文件定义，包级背景见 [packages/README.zh.md](../../packages/README.zh.md)。
- 边界：本页不列包清单、字段规则或阈值，只指向正家文件。
- 查接线：`grep -rn "verify-package-dependencies" package.json .github/workflows scripts/run-gates.ts`。
- 例外：修改扫描或策略须经对应领域专家确认，并在改动上记录理由。

可重复的流程：复现、读诊断、修正它指名的清单。

```sh
# 1. Reproduce what CI reports
pnpm run verify-package-dependencies

# 2. The diagnostic names the manifest, the section, the dependency, and the expected range
#    packages/example/package.json: dependencies.@deepseek-ai/dsh-base must use workspace:*, found workspace:~

# 3. The fix goes into the manifest, never into the policy file or the scan
#    "dependencies": { "@deepseek-ai/dsh-base": "workspace:*" }

# 4. Re-run the scan until every package matches the published policy
pnpm run verify-package-dependencies
```

失去机械保证的两种做法：改检查而不改清单，或者把规则复述到本页、从此与正家漂移。

```text
Relaxing PACKAGE_DEPENDENCY_POLICY, or dropping the scanned section that fails, to go green
Restating a required-devDependency package list or the field rules on this page instead of linking the policy file
```

## 内部依赖写法按包族保证

内部依赖写法按包族决定：`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 用 `workspace:*`，其余内部包用 `workspace:~`，`workspace:^` 已退出。同一个依赖名在所有 workspace 内写法一致，不一致是扫描硬失败，不是评审可以放行的警告。写法统一才能保持一条解析路径，避免同一个依赖出现重复实例以及随之而来的解析差异。

- 判定在 [verify-package-dependencies.ts](../../scripts/verify-package-dependencies.ts) 的 `workspaceRange()`：`@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 包族取 `workspace:*`，其余内部包取 `workspace:~`；扫描遍历受管清单，比对同一依赖名的每一处声明。
- 边界：同命名空间但不是 workspace 成员的包按普通第三方版本范围声明，不受包族规则约束——`@deepseek-ai/libreoffice-kit` 在 `apps/desktop-host/package.json`（dependencies）、`packages/bundle/web-app/package.json`（devDependencies）、`packages/document/office-to-pdf/package.json`（dependencies）、`packages/skill/skill-office/package.json`（dependencies）中声明为 `^0.1.5`。
- 分布不在此复述；下面的复算命令会打印 `workspace:*`、`workspace:~`、`workspace:^` 的当前数量，以及族规则之外的精确版本声明。
- 例外：门禁机械判定；确需例外意味着修改扫描与策略文件，并须经对应领域专家确认、在改动上说明理由。
- 复算：

```sh
python3 -c "import json,glob,collections; c=collections.Counter(); [c.update([r]) for p in glob.glob('apps/*/package.json')+glob.glob('packages/*/*/package.json')+glob.glob('vendor/*/package.json') for s in ('dependencies','devDependencies','optionalDependencies','peerDependencies') for n,r in (json.load(open(p)).get(s) or {}).items() if n.startswith('@deepseek-ai/')]; print(c.most_common())"
```

每个包族各用其写法，非成员的例外保持普通版本范围。

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-base": "workspace:*",
    "@deepseek-ai/cordis": "workspace:~",
    "@deepseek-ai/libreoffice-kit": "^0.1.5"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-typert-registry": "workspace:*"
  }
}
```

`dsh-*` 包写成 `workspace:~`，以及把 workspace 成员钉到外部版本范围——两者都是扫描硬失败，已退出的「一律钉精确版本」旧口径不能作为替代写法。

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-base": "workspace:~",
    "@deepseek-ai/cordis": "^4.0.0"
  }
}
```

## 新增 resolve 钩子直接禁止

新增 `resolve` 钩子默认被拒——这是确定性禁止，不是「尽量不」。确有需要时，两个前置条件必须同时成立：整体重审 resolve 策略，而不是给触发本次改动的那个 specifier 打补丁；以及在任何内容落地之前取得对应领域专家的确认。开发者自行判断「这次特殊」不构成确认。

- 判定条件：改动是否新增 `resolve` 钩子，包括包装既有钩子、改写同一批 specifier 的等价写法？
- 边界：本条只管能否新增钩子；解析、热更新与插件管理三者的职责划分另行治理，并不因此允许新增钩子。
- 唯一的解析路径是 `dsh` 源码启动注册的 tsx ESM 钩子，其理由见[源码启动 Agent Note](../../.agents/notes/implemented/architecture/2026-07-29-dsh-source-launch-tsx-esm.zh.md)。
- 例外：只有上述两个前置条件，且都要记录在改动上。

确有新的解析需求时的合规路径，按顺序。

```text
A new resolve hook is allowed only after both preconditions hold:

1. Re-audit the resolve strategy as a whole — resolution, hot reload, and plugin
   management responsibilities together, not only the specifier at hand.
2. Record the domain owner's confirmation on the change.
3. Only then add the hook, linking both records from the change.

Until both hold, the answer is no; "this case is special" is the author's judgment,
not a confirmation.
```

为了让某个 specifier 落到本包期望的位置而加的钩子，或包装既有钩子达到同样效果的等价写法——解析路径多出一个分支，resolver 的返回与 `node_modules` 实况不再对应。

```ts ignore-check
// Added so one specifier resolves to the local source copy
export async function resolve(specifier: string, parentURL: string, importAttributes: object) {
  if (specifier === '@deepseek-ai/dsh-example') return { url: localSourceUrl, shortCircuit: true }
  return defaultResolve(specifier, parentURL, importAttributes)
}

// The equivalent shape: wrapping the hook that already exists
const previous = hooks.resolve
hooks.resolve = (specifier, context, next) =>
  pinned.has(specifier) ? pinned.get(specifier) : previous(specifier, context, next)
```
