---
kind: upgrade-guide
description: "安装进 profile 的包不再替换 bundle 以同名插入的插件行所加载的包。"
---

# bundle 的插件行加载它的 bundle 的包

[English](guide.md) | 中文

## 变更

在 0.2.3-alpha.2 中，profile 的每个插件行加载离它最近的同名包，从 profile 目录开始查找。因此，安装进 `<profile>/node_modules` 的副本（直接安装，或作为其他插件的依赖）会替换 `@deepseek-ai/dsh-base` 这类 bundle 所插入的行的包。升级后，bundle 插入的行（包括它插入的 agent preset 里的行），当该 bundle 的 `package.json` 在 `dependencies` 或 `optionalDependencies` 下声明了这个包时，加载的是该 bundle 自己 import 时加载的那份。多个 bundle 插入并声明同一个包名时，由 `dsh.profile.bundles` 里排在最前的 bundle 决定。profile 自己的 `cordis.patch.yml` 里写下同一包名的行也加载这个包。

bundle 把包声明在 `peerDependencies` 或 `devDependencies` 下、或者完全没有声明时，它的行不变：`<profile>/node_modules` 里有副本就加载那份，否则加载 `dsh` 自带的包。已安装插件自己的 import 不变：插件仍然得到它声明的副本。

受影响的有三类。为了改变 bundle 的行所运行的内容而安装了第二份副本的 profile，不再得到那份副本。bundle 声明了依赖、又把它放在自己的 `node_modules` 里时（包括链接的开发检出目录），这一行改为运行这份副本，而不是 profile 顶层的副本或 `dsh` 自带的包。bundle 声明了依赖却没有安装时，它的行不再能从 profile 里的副本加载。三方插件写死了旧版 DSH 包的 profile 朝相反方向变化：内置行不再因不兼容而被禁用。

## 迁移

要在 profile 里替换 bundle 的行所用的包：

1. 找到要替换的行：运行 `dsh --profile <name> --dump-config`，记下它的 `id`。
2. 在 `<profile>/cordis.patch.yml` 里禁用这一行，并插入一行按路径指名你的副本。路径选中的就是那个文件；包名选中的是 bundle 的包。

   ```yaml
   - id: storage-domain
     disabled: true
   - insert:
       - id: my-storage-domain
         name: ./node_modules/@deepseek-ai/dsh-storage-domain/lib/index.js
   ```

3. 启动 profile，确认输出里没有针对该行的 `disabling profile plugin row`，并且你的插件的行为已经生效。

要让 bundle 的行继续使用 `dsh` 自带的包：

1. 在 bundle 的 `package.json` 里，把这个包从 `dependencies` 移到 `peerDependencies` 和 `devDependencies`。
2. 重新安装 bundle，启动 profile，确认这一行的行为来自 `dsh` 自带的包。
