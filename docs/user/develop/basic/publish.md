# Package and install a plugin

English | [中文](publish.zh.md)

The previous tutorials loaded a local plugin through a `--patch` overlay. This tutorial packages it as an installable **bundle**, installs it into a **profile** with `dsh plugin add`, and explains the layer order that determines the composed configuration. It assumes the `dsh` CLI is installed. Complete [plugin configuration](./config.md) first.

To use a fresh source checkout instead, complete the [run-from-source section](../../../../README.md#run-from-source), keep this tutorial's `hello-plugin` directory at the repository root, and run the remaining `dsh ...` commands from there as `pnpm dsh ...`. See [source execution](../../../../apps/cli/reference/README.md#source-execution) for build and launcher behavior.

## Two concepts, two manifests

Installation is built on two concepts. Both are described by a `package.json`, but they carry different kinds of manifest under the `dsh` key, and they answer different questions:

- A **bundle** is an npm package that ships a configuration layer. Its manifest declares `dsh.bundle`, answering "what does this package contribute?": a patch file that inserts or overrides plugin rows.
- A **profile** is a directory under `$DSH_HOME/profiles/<name>` describing one runnable composition. Its manifest declares `dsh.profile`, answering "which bundles compose this setup, in what order?".

A bundle is what you author and distribute; a profile is what a user boots with `dsh --profile <name>`. Nothing is both.

### The bundle manifest

Create the package directory:

```sh
mkdir -p hello-plugin
```

```
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # the layer applied when a profile lists this bundle
└── index.js           # plugin modules the patch rows reference
```

Create `hello-plugin/package.json`:

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

Create `hello-plugin/index.js` with the plugin entry point:

```js
export const name = 'hello-plugin'

export function apply() {
  console.log('[hello-plugin] plugin loaded!')
}
```

Create `hello-plugin/cordis.patch.yml`. The patch is a YAML array like the `--patch` overlays you wrote, except plugin rows reference the package by name instead of a relative source path so Node resolution finds the installed code:

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

`patch` also accepts an ordered list of files, for example `["./base.patch.yml", "./web.patch.yml"]`; the launcher applies them in that order as one layer, and each file's relative plugin paths resolve beside that file. A package without the `dsh.bundle` declaration still installs, but only as a plain dependency: `dsh plugin` prints a warning and activates no layer. Use that package format for a library that plugin packages import rather than a plugin users enable.

### The profile manifest

A profile directory holds two files:

- `package.json` — the profile's out-of-tree plugin dependencies (managed by pnpm) plus the `dsh.profile` manifest with its ordered `bundles` list.
- `cordis.patch.yml` — the user's own patch layer, applied after every bundle layer.

You never write a profile manifest by hand: `dsh --profile <name> --from-default-profile <template>` can create one from a shipped application template, while `dsh plugin` creates a base-backed profile and maintains its installed bundle list. The [CLI behavior reference](../../../../apps/cli/reference/README.md#profile-boot) owns the creation rules; the next section shows the plugin path.

## Install into a profile

`dsh plugin --profile <name> <args...>` forwards to pnpm in the profile directory, so every pnpm verb works. From the directory that contains `hello-plugin`, install the package checkout:

```sh
dsh plugin --profile demo add ./hello-plugin
```

The first use initializes the profile (with `@deepseek-ai/dsh-base` as its first bundle), pnpm links the checkout, and `dsh` appends the bundle to `dsh.profile.bundles` because the package declares `dsh.bundle`:

```json
{
  "name": "dsh-profile-demo",
  "private": true,
  "dependencies": {
    "dsh-hello-plugin": "link:/path/to/hello-plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-hello-plugin"
      ]
    }
  }
}
```

A linked checkout keeps its own `node_modules`. Declare dsh packages whose instances the plugin must share with the host under both `peerDependencies` and `devDependencies`, as the harness packages do. At that manifest's lookup position, peers present in the running dsh's runtime resolution use the installation's copy; the devDependency copy serves your type checker and standalone tests. Keep independently versioned third-party dependencies and stateless dsh utilities under `dependencies`.

Ordinary linked imports follow Node's ancestor order and check each directory's current peer declarations. A nearer physical package wins before a higher peer declaration. A link target can lack `package.json`; ancestor peers still apply, even without a physical `node_modules` beside that manifest. Explicit `require.resolve(..., { paths })` is always native, including paths inside a profile. These rules are shared by npm, Desktop, and source launches; they do not invalidate loaded modules or validate peer version ranges. See the [resolution rules](../../../../.agents/notes/implemented/architecture/2026-09-19-profile-resolution-lookup-order.md) for scope and file-query behavior.

Linking a broad checkout does not apply peer interception to the running installation's own package directories. Links whose targets stay inside the profile, including its pnpm store, remain profile-owned installation content rather than external linked roots. Overlapping external links do not change lookup order: each request still starts from its importer's directory.

Verify the layer without booting, then boot:

```sh
dsh --profile demo --dump-config   # shows a "# == dsh-hello-plugin" layer
dsh --profile demo
```

`dsh plugin --profile demo remove dsh-hello-plugin` removes both the dependency and the layer.

## The loading order

The effective configuration composes over an empty root by applying, in order:

1. Each bundle patch named in the profile's `dsh.profile.bundles` list, in list order — `@deepseek-ai/dsh-base` first, then each installed bundle in the order it was added.
2. The profile's own `cordis.patch.yml`.
3. The home-level `$DSH_HOME/cordis.patch.yml` — machine-local preferences shared by every profile.
4. Each `--patch <path>` overlay, in argv order.

App arguments are not another patch layer. A surface bundle can resolve them through an ordinary app-owned service, described below.

Later layers win per row, and a patch replaces a row's entire `config` value rather than deep-merging keys. Two consequences for bundle authors:

- Your patch can override rows from earlier layers by `id` — the same way [the `dsh-web-app` bundle](../../../../packages/bundle/web-app/cordis.patch.yml) overrides `dsh-base` rows — but must restate every key the row needs, not just the changed one.
- Users can override your rows in their profile's `cordis.patch.yml` without touching your package, so prefer configuration defaults users are likely to keep and let the schema carry the rest.

In-box bundle names always resolve from the dsh installation itself; pnpm manages only out-of-tree packages, so your bundle can rely on `@deepseek-ai/dsh-base` being present and current.

## Give a surface bundle its own command line

A bundle that defines a runnable app mounts an ordinary provider plugin:

```yaml
- id: hello-startup
  name: 'dsh-hello-plugin/startup'
```

The plugin exports `inject = ['cmdlineArgs']`, calls `parseCmdline` from [`@deepseek-ai/dsh-cmdline`](../../../../packages/boot/cmdline/README.md) with its own commander program, and provides its app-owned service from the program's action. The launcher hands every plugin the same immutable arguments after launcher flags, so app-specific flags need no launcher change and multiple plugins may parse the snapshot. The Loader row needs no launcher marker or special kind.

Rows configured by those arguments inject the provider's service and read it from their own `!!js` options, with the deployment value beside it as the fallback:

```yaml
- id: my-app
  name: '@example/my-app'
  inject: [myAppStartup]
  config:
    port: !!js ctx.myAppStartup.port ?? 8080
```

On `--help`, the provider publishes no service, so those rows never activate. Loader mounts the composition once, waits for each row's ordinary injections, and only then evaluates that row's `!!js` config against its injected context.

## Installing from GitHub: the build-script catch

Publishing to a registry is not required — users can install straight from a git host:

```sh
dsh plugin --profile demo add github:you/hello-plugin
```

But a git install fetches **sources, not built artifacts**: nothing runs your `build` script, so a TypeScript package arrives without its `lib/` output and fails to load. Two things must happen, one on each side:

- **The author** ships a `prepare` script — pnpm runs it after a git install — that builds the published entry points from source, self-contained: it must not assume dev-only context such as a sibling monorepo checkout. A dedicated tsdown config can transpile `src/` without project references or type checking.
- **The user** allowlists the build. pnpm ≥10 refuses to run a git dependency's `prepare` script until it is explicitly allowed, so the first `add` fails; `dsh` points at the fix — copy the exact package key pnpm printed into the profile's `pnpm-workspace.yaml`:

  ```yaml
  allowBuilds:
    dsh-hello-plugin: true
  ```

  and re-run the `add`.

Treat that allowance as **permission to execute the package's code on your machine at install time**, outside any sandbox the agent runs under. Only allow packages whose source you trust, and pin a commit (`github:you/hello-plugin#<sha>`) so a later push cannot silently change what runs.

If you would rather not ask users for the allowance, distribute built artifacts instead — neither form needs any build permission:

- **Publish to npm** with `lib/` built at `pnpm publish` time; `dsh plugin add your-package` then installs prebuilt code.
- **Ship a tarball** from `pnpm pack`; users run `dsh plugin add ./hello-plugin-0.1.0.tgz`.

## Next steps

- [Plugins and lifecycle](../framework/index.md) — the full plugin lifecycle
- [CLI behavior reference](../../../../apps/cli/reference/README.md) — exact layer precedence, flags, and profile mechanics
