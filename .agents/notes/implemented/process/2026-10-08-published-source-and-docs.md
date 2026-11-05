# Agent Note: Published source, maps, and documentation

Status: implemented

English | [中文](2026-10-08-published-source-and-docs.zh.md)

## Problem

A published `@deepseek-ai/dsh-*` package carried declarations, bundled runtime, and locale resources, but neither the TypeScript the declarations describe nor the maps that resolve into it. Its `exports` map nevertheless declared `./src/*`, so an installed consumer resolved that subpath to files the tarball did not contain. A plugin author who wanted the implementation behind a documented API had to read the declaration, the documentation website, or a checkout at the matching `dsh-v*` tag: the first stops at the declaration, and the other two are not the installed version. The repository's Markdown documentation reached readers only through the website, which tracks the published release.

## Decision

Every release member publishes its TypeScript source, the declaration maps that resolve into it, and the JavaScript maps beside the bundles they describe. `@deepseek-ai/dsh` publishes the documentation website's page set plus the upgrade guides, and the build compresses emitted bundles without mangling identifiers.

[`expectedDshPackageFiles`](../../../../scripts/check-workspace-constraints.ts) lists `lib/types/**/*.d.ts.map`, `lib/**/*.js.map`, and `src`; a package with Typert Remote navigation also lists `lib/typert.remote-client.d.ts.map`, which its generated declaration references through `sourceMappingURL`. No payload member is forbidden, so the static manifest check owns the exact publication list. The `./src/*` export that 315 of the 332 release members declare resolves to those files, which serves editor navigation and reading; plain Node still cannot import them without a TypeScript loader.

The client preset compresses the browser bundle's text (`minify: { compress: false, mangle: false }`). Identifiers keep their names, so a stack frame and the published map still name the original code. Node-side entries stay uncompressed: the browser worker image lowers `yield*` only as a whole statement and rewrites `for await` loops by their source layout, and compressed input breaks both.

`@deepseek-ai/dsh` stages that set into `apps/cli/docs` from its `prepack` lifecycle through [`scripts/stage-dsh-docs.ts`](../../../../scripts/stage-dsh-docs.ts), and removes the copy again from `postpack`. The set is the website manifest's Markdown, every `docs/upgrade-guide/` document, and the non-Markdown assets those pages reference. Staging also generates `docs/upgrade-guide/README.md`, an index grouped by the release each `v<T>` directory upgrades from, with each guide's title, its English and Chinese descriptions, and both relative paths; the repository tree keeps no index of its own. The generated `docs/persistence-changes/` records, the `docs/i18n/` guidelines, and the `*.i18n.yaml` consistency records stay out. The vendored family keeps upstream's payload unchanged ([release sequences](2026-08-10-npm-release-sequences.md)).

Desktop keeps `src/` and the `@deepseek-ai/dsh` `docs/` tree inside `app.asar`, so an agent reads the installed version's documentation and code there; [its runtime file policy](../../../../apps/desktop/scripts/runtime-file-policy.ts) still omits every declaration and map. Ordinary tools cannot open an archive entry, so [`dsh-shell-env`](../../../../packages/shell/shell-env/README.md) gives every model shell call `DSH_INSTALL_DIR`, the `@deepseek-ai/dsh` package directory, and `DSH_NODE_EXECUTABLE`, the executable running the Harness; under Desktop that is Electron, whose Node mode (`ELECTRON_RUN_AS_NODE=1`) reads the archive. The Python single-file executable pays nothing: [`PUBLISHED_PAYLOAD_IGNORES`](../../../../scripts/build-exe-for-python-sdk.ts) excludes the same trees, so its contents do not depend on a staged `docs` left in the checkout.

## Alternatives considered

**Keep the payload declarations-only and send readers to the documentation website or the matching `dsh-v*` tag.** Rejected because neither is the installed version, and the website serves the latest published release rather than a prerelease. The declared `./src/*` export also has no meaning without those files.

**Publish maps without `src`.** Rejected because a map whose `sources` are absent resolves nothing, which is exactly the navigation the [Typert Remote design](../architecture/2026-08-02-typert-remote-method-calls.md) requires.

**Publish the whole `docs/` tree, or only the website's page set.** Both extremes were rejected. The whole tree publishes maintainer material an installed reader does not need — postmortems, testing guides, agent instructions, and the generated migration records — while the site's page set alone omits the upgrade guides, which are the documents an installed reader consults when a released change breaks something.

**Mangle the bundles as well.** Rejected because mangled identifiers break the correspondence a published map exists to provide and make an unhandled stack frame unreadable.

**Compress the node-side entries as well.** Rejected because the browser worker image refuses compressed input: the packer rejects a `yield*` a compressor moved into an expression, and it produces unparseable code for `dsh-agent-instructions`. Both are lowering constraints, not size arguments.

## Consequences

`src` adds about 29 MB and declaration maps about 10 MB across the release set; JavaScript maps add about 49 MB, and the staged documentation adds 6.4 MB across 320 files to `@deepseek-ai/dsh`. Compression removes about a third of a browser bundle — `ui-chat`'s `lib/client.js` falls from 591 kB to 420 kB — while node-side entries keep their size until the worker image lowering accepts compressed input. The macOS arm64 `app.asar` grows by about 20 MB of `src` and 5 MB of documentation; the Python executable keeps its previous payload.

A consumer editor now follows a declaration to the installed implementation, and a plugin author reads that version's documentation without a checkout. The staged copy keeps the repository's relative links, so a link into `../packages/**` or into the omitted `persistence-changes/` records resolves only in a checkout. `docs/` exists in the working tree only between `prepack` and `postpack`, and `pnpm run clean` removes a copy an interrupted pack left behind.

`pnpm run constraints` rejects a member whose `files` omits `src` or a map, because the canonical list is exact. The release family's tarball check requires `@deepseek-ai/dsh` to carry documentation, the upgrade guide index, and source, so a pack run that skips the staging hook fails instead of publishing without them.
