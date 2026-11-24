# Agent Note: 按 bundle 选中的包加载 bundle 的插件行

Status: implemented

[English](2026-11-23-bundle-plugin-rows-load-bundle-selected-packages.md) | 中文

## Problem

profile 把多个 bundle 层组合成一棵根配置树，Loader 按名字从这棵树唯一的基地址（profile 目录）导入每一行。对 profile 内发出的请求，runtime resolution 先读 profile 目录里的物理副本，再读拦截层上的条目（[查找顺序](2026-09-19-profile-resolution-lookup-order.zh.md)）。profile 用平铺布局安装，三方插件在 `dependencies` 里写死某个 DSH 包的旧版本时，旧副本落在 `<profile>/node_modules`，`@deepseek-ai/dsh-base` 插入的同名行就加载这份旧副本。兼容性准入随后禁用该行，依赖它的服务一直等待，DSH 仍然照常启动（#8476）。

请求到达拦截时只带行名和 importer，不带插入这一行的 bundle。计算 resolution 时这项信息是齐的：`profile.layers` 里每个 bundle 层都带着解析好的 patch 和它自己的包目录，层与层之间有先后。

## Decision

bundle 为自己声明为依赖的包插入的行，加载的是该 bundle 自己 import 这个包时加载的那份。`createRuntimeResolution` 按顺序读各个 bundle 层，把每个这样的插件包名绑定到第一个插入它的 bundle。绑定存进 resolution 的 `bundlePlugins`。拦截时，importer 是当前 profile 目录本身的请求，对已绑定的包名先从它的 bundle 重新解析，再走其他路由。patch 的读取与应用、Loader、现有的依赖表都不变。

### 绑定

| 输入 | 来源 |
|---|---|
| 插件包名 | `ProfileLayer.patches`：这一层插入的行，按配置顺序，包括所插入 group 的子行，以及所插入的行在 `config.plugins` 下列出的行；取每个行名里的裸包名 |
| 插入这一行的 bundle 的目录 | `ProfileLayer.packageDir`，按层给出的写法 |
| bundle 声明的包 | 该目录下 `package.json` 的 `dependencies` 和 `optionalDependencies` |

- resolution 读层上已经解析好的 patch 列表，不读 patch 文件，不应用 patch。
- agent preset 把它的行列在 `config.plugins` 下，所以这些行属于插入该 preset 的 bundle。`plugins` 列表里不是行的成员不计入，其他配置键不读。
- 带 `group` 标记的行，以及名为 `cordis:group` 或 `@deepseek-ai/cordis-plugin-group` 的行都是 group；无论有没有标记，group 插件都把它的数组配置当作行挂载。
- 按 id 定位的 patch 不插入行。它的 `name` 是对目标行名字的断言，它的 `config` 不读。
- 行名不是裸包名时不绑定：路径、URL、内建名，或者不是字符串的值。
- profile 自己的 patch 文件不是 bundle 层，不绑定。

各层按 `profile.layers` 的顺序读，也就是 `dsh.profile.bundles` 的顺序。对一层插入的每个包名：

| 情况 | 结果 |
|---|---|
| bundle 没有把这个包名声明为依赖 | 这个 bundle 不绑定它。peer、开发依赖、没有声明的包、bundle 自己的包名都属于这种 |
| bundle 声明了这个包名，包名还没有绑定 | 把包名绑定到这个 bundle 的目录 |
| bundle 声明了这个包名，包名已绑定到另一个 bundle | 保留先绑定的。两个 bundle 声明的版本范围相同时，视为够到同一份副本。范围不同、并且两个 bundle 够到不同的真实目录时，记一条警告，内容是包名、两个 bundle、两个目录和两个版本；不抛错 |

声明为依赖表示这份副本是 bundle 自己选的。声明为 peer 表示包由宿主提供，[发布指南](../../../../docs/user/develop/basic/publish.zh.md)要求插件这样声明 DSH 的包；只插入 Host 行而不声明这个包的 bundle 则没有表态。对这些包名，bundle 的目录说明不了这一行用哪一份，所以这一行沿用现有查找。

绑定时不查找任何包：每个 bundle 层只读一次 manifest（元数据清单）。只有被两个 bundle 绑定、且两边声明的版本范围不同的包名，才从两边各解析一次，用来比较副本。警告记在 `ProfileRuntimeResolution.bundlePluginWarnings` 上。计算 resolution 时不打印；`dsh` 启动器每次启动时通过 `reportBundlePluginWarnings` 打印一次。

### 匹配

配置树从 profile 目录的 URL 请求它的行。加载一行、对它做兼容性准入、查询它的包元数据，传入的 importer 都是这个 URL。agent preset 从声明它的配置树的基地址挂载它的行，也是这个 URL。

| importer | 是否从绑定的 bundle 解析 |
|---|---|
| 当前 profile 目录本身 | 是 |
| profile 内的文件或子目录，包括它的 `node_modules` 里的包 | 否 |
| 其他 profile、链接目录、profiles 树之外的路径 | 否 |

- 已绑定的包名按来自该 bundle 的 manifest 的请求来路由：这样的 import 在拦截层有条目时用那个条目，否则由 Node 从 bundle 出发自己查找。`exports`、conditions、子路径和错误码仍由 Node 处理。匹配先于本地包名和 profile `node_modules` 里的物理副本。
- 交给 Node 的 importer 是 bundle 的 manifest 的真实路径，在这一行被请求时才读取。[源码启动器](2026-07-29-dsh-source-launch-tsx-esm.zh.md)只对 `node_modules` 之外的 importer 把 workspace 包映射到源码，而源码检出是经过那里的链接到达它的 bundle 的。
- bundle 够不着这个包时，这一行加载失败。请求不会退回 profile 目录的查找。
- CommonJS 请求的来源总是一个文件，所以不使用绑定。
- 三方插件 import 它写死的那个包时，仍然得到自己的副本，与这一行运行的副本并存。

### 后继代

重新计算 resolution 时重新绑定。`publish()` 把 `bundlePlugins` 和其他表一起比较，所以只有绑定不同的后继代也会发布。绑定可以新增、移除或换到另一个 bundle，不要求重启：已加载的模块继续运行，直到所属插件重新加载。

## Alternatives considered

**在读 patch 的地方收集行名，挂到层上交给 resolution。** 要改 `loadOverlayPatches`、`parsePatchList` 和 `loadProfileDirectory`，还要给 `ProfileLayer` 加字段。层上已经带着解析好的 patch 和 bundle 目录。

**绑定时就解析出每一行的包。** 每次启动要为每个行名查找一次包、取一次真实路径、读一次 manifest，`web` profile 约 720 次文件系统调用，并且查找要照抄 Node 的规则。绑定只需要说明包名属于哪个 bundle；包由 Node 在这一行被请求时解析。

**把每一行的包记进 `entries`。** 条目在拦截层上占据包名位置，对 profile 内的所有 importer 生效，并且排在 profile 内的物理副本之后。并进去之后，要么平铺的旧副本仍然先被找到，要么让条目先于物理副本、覆盖插件为自己的 import 安装的版本，[查找顺序](2026-09-19-profile-resolution-lookup-order.zh.md#alternatives-considered)已经否决后一种做法。`entries` 为每个包名也只记一个目录，由依赖能到达它的第一个 bundle 决定，而不是由插入这一行的 bundle 决定。

**对所有 importer 使用绑定。** 三方插件自己 import 的包会被换成 bundle 的那份，它写死的依赖不再生效。

**对 profile 内 `node_modules` 之外的所有文件使用绑定。** 每个 importer 都要做一次路径判断。加载一行、对它做准入、查询它的元数据已经共用同一个 importer，即 profile 目录。

**bundle 没有声明为 peer 的包名一律绑定。** 从 profile 之外链接进来的 bundle 只插入 Host 行而不声明这个包时，这一行会从它自己的目录解析，那里够不着宿主的包，这一行就不再能加载。bundle 自己的包名也会绑定到它自己。

**把声明为 peer 的包绑定到安装目录自带的包。** 绑定要读安装目录的依赖遍历结果，而且这一行加载安装目录的包时，它的 bundle 自己的 import 得到的是最近的物理副本。它解决的情况需要同时满足：三方 bundle 插入一个没有内置 bundle 插入的行、把它声明为 peer，并且同一个 profile 里另有插件写死了这个包。

**安装目录自带的包，所有行都加载安装目录那份。** bundle 自带一份这样的包并把它列在 `dependencies` 下时，它的行运行的副本会与它自己 import 到的副本不同。

**先读 installation 的 bundle，再读 profile 的 bundle。** 绑定时要区分每个 bundle 来自哪里。`dsh.profile.bundles` 把随安装的 bundle 排在前面，新安装的 bundle 追加在末尾，按层的顺序读结果相同。

**让后面的层替换绑定。** 排在最后的三方 bundle 插入同名行就能替换内置行的包，#8476 会换一种形式重现。

**跳过有冲突的 bundle，或让启动失败。** 一个写死的依赖会让该 bundle 的其他行一起消失，或者让整个 profile 无法启动。保留先绑定的，受影响的只有同名的行。

**修改 Loader，把发起请求的行传给导入。** 这样每一行可以从自己的 bundle 解析，两个 bundle 也能加载同一插件的不同版本。它要求修改 vendor 的 Loader。

## Consequences

- 一个包名只有一个绑定。两个 bundle 不能加载同一插件包的不同版本：同名的行都加载第一个 bundle 自己 import 时加载的那份。
- 一行加载的是它的 bundle 所依赖的包，与三方插件在 profile 里平铺了什么无关。`<profile>/node_modules` 里不兼容的副本不再导致内置行或内置 agent preset 里的行被禁用。
- 在 profile 里另装一份已绑定的包，不再能替换 bundle 的行。profile 自己的 patch 文件里的行写下已绑定的包名时，同样从该 bundle 解析。按路径指名某个副本的行加载那个副本（[升级说明](../../../../docs/upgrade-guide/v0.2.3-alpha.2/bundle-row-package-selection/guide.zh.md)）。
- 三方 bundle 排在随安装的 bundle 之前、又插入并声明了同名行时，包名绑定到它。新安装的 bundle 追加在列表末尾，手工调整顺序才会出现这种排法。
- profile 内的 bundle 把声明的包放在自己的 `node_modules` 里时，它的行运行这份副本。现有查找从 profile 目录开始，读不到这份副本。
- 没有 bundle 声明的包名沿用现有查找：其他插件平铺进 profile 的副本先于安装目录自带的包被读到。这包括 bundle 声明为 peer 或完全没有声明的行、bundle 自己的行、profile 自己的 patch 文件里的行，以及插件列在 `config.plugins` 以外的配置键下的行。
- bundle 声明了一个自己够不着的依赖时，即使 profile 目录能找到副本，它的行也无法加载。
- 链接进 profile 的开发检出目录在 `peerDependencies` 下声明宿主的包时，它的行沿用现有查找，它自己的 import 得到的也是安装目录的包。把这个包列在 `dependencies` 下的检出目录，它的行运行它自己的副本。
- 每次启动为每个 bundle 层读一次 manifest。被两个 bundle 绑定、且声明的版本范围不同的包名，两边各做一次查找和一次取真实路径；副本不同时再读两次 manifest。
- 两个 bundle 声明的版本范围相同、却装了不同副本时，不记警告。
- 运行中重新计算的 resolution 只记录警告、不打印；用户在下次启动时看到。
