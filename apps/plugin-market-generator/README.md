# Plugin market index generator

English | [中文](README.zh.md)

A reference generator for [plugin market index](../../.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.md) files. It reads a plain list of npm package names and Git repository URLs and writes one `index.json` that the DSH **Discover** page can show without further requests. It is a standalone Node program, not a Cordis application, and it never installs or runs the code of the packages it describes.

## Usage

Write a source list, one entry per line. Blank lines and lines starting with `#` are ignored.

```text
# npm packages: every bundle version that is neither deprecated nor private is listed
@scope/dsh-example
dsh-another-plugin
# Git repositories: release tags and the default branch are listed
https://github.com/author/dsh-plugin
https://gitlab.example.com/group/dsh-plugins
```

Run the generator from the repository:

```sh
pnpm --filter @deepseek-ai/dsh-plugin-market-generator start \
  --input plugins.txt --output site/index.json --title "Example Market"
```

`--input` and `--output` are relative to the directory where you run pnpm. Publish the output directory over https, then add the `index.json` URL as an index source in Discover.

| Option | Default | Meaning |
|---|---|---|
| `--input <file>` | required | Source list. |
| `--output <file>` | required | Index file. Icons too large to inline are written to `icons/` next to it; generated icon files the index no longer uses are removed from there. |
| `--title <text>` | required | Market title. |
| `--description <text>` | none | Market description. |
| `--cache <dir>` | `.plugin-market-cache` next to the input list | Result cache. It stays out of the output directory, which is published. |
| `--registry <url>` | `https://registry.npmjs.org/` | npm registry. Any other registry is recorded in each npm version. |
| `--inline-icon-bytes <n>` | `16384` | Largest icon embedded as a `data:` URL, at most 32768, the format's inline icon limit. |
| `--concurrency <n>` | `4` | Sources read at the same time. |
| `--timeout-ms <n>` | `60000` | Deadline for one request or Git command. |
| `-h`, `--help` | | Print these options and the exit statuses. |

The exit status is 0 when every source was read, 1 when a source could not be read, and 2 for invalid arguments or an invalid list. A list line that the index format would reject, such as an `http:` URL, a URL with credentials, a query, or a fragment, a URL with fewer than two path segments, or a tarball URL, is an invalid list. A source that cannot be read keeps its last successful result, so a temporary outage does not remove plugins from the index; the failure is still reported.

## What gets listed

Each package becomes one plugin with one or more versions. A version is listed only when its `package.json` declares `dsh.bundle` with `patch` set to a file path or a list of file paths, and does not set `"private": true`. A Git package whose `package.json` on the default branch sets `"private": true` is not listed, and neither are its tagged versions.

- **npm package**: every version in the registry document that is neither deprecated nor private, declares a bundle, and has a publish time. Versions come from the registry document alone; only the tarball of the highest listed version is downloaded, for its display fields. Its `package.json` must name the requested package and version.
- **Git repository**: bundle packages are found on the default branch, in this order:
  1. the root `package.json` declares `dsh.bundle`: the root package only;
  2. `package.json` `workspaces` or `pnpm-workspace.yaml` `packages` match packages that declare `dsh.bundle`: those packages. Each glob segment is a literal name, a name with `*`, or `**`; negated globs are ignored, and a glob that matches nothing is reported;
  3. otherwise, every package declaring `dsh.bundle` within three directory levels, outside `node_modules`, `test`, `tests`, `fixtures`, `example`, and `examples`.

  Each package's versions come from release tags and the default branch. A `vX.Y.Z` or `X.Y.Z` tag applies to every package, and a `<name>@X.Y.Z` tag, such as `@scope/dsh-a@1.2.0`, to the package with that name; the tag version must be an exact SemVer version. A tag lists a package when the package's directory at the tagged commit holds a bundle manifest with the same name and the tag's version. The default branch commit lists each package's current version unless a tag already lists it. When several tags list one version, a `<name>@` tag wins over a unified tag, then the earlier commit wins. The publish time is the commit's committer time.

`engines.dsh` is the manifest's `engines.dsh`, trimmed. Without one, it is the conjunction of the manifest's `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` `peerDependencies` ranges; a peer of exactly `workspace:*`, `workspace:^`, or `workspace:~` means the running DSH version and adds nothing, and identical ranges appear once. A `*` range admits every version, so a version whose ranges are all `*` lists no `engines.dsh`. A version is skipped with a warning when installation would refuse it on every DSH version: an empty range, a `workspace:` value in `engines.dsh` or any other `workspace:` peer, an invalid range, or ranges that no version satisfies together.

Display fields come from the highest listed version and follow the rules DSH uses for installed plugins. `./locale/en.json` and `./locale/<language>.json` are resolved through the package `exports` map with the `import`, `node`, and `default` conditions, or literally without one, and every locale file must sit in the English file's directory; their `meta.title` and `meta.description` fall back to the manifest `name` and `description`. The icon is the manifest `icon`, a relative path, or else the exported `./icon`: SVG, PNG, JPEG, or WebP, at most 256 KiB, inside the package. `author` is the name part of the manifest `author` string, without its `<email>` and `(url)`, or the `name` of an author object. `homepage` is the manifest `homepage` as written when it is an absolute http(s) URL; nothing else, such as `repository`, stands in for a missing one. `repository` is the web page of the manifest `repository`, a shorthand such as `github:o/r` or a URL, through [hosted-git-info](https://github.com/npm/hosted-git-info) for hosts it knows, without any `#` committish; another http(s) URL loses a `git+` prefix, credentials, query, fragment, and `.git` suffix. Its `directory` is copied when the format accepts it. A repository with no http(s) page, or an unusable `directory`, is reported and omitted. Malformed locale files, invalid locale names, and rejected icons are reported as warnings. Translations without English text or a manifest fallback are dropped because the format requires English. Every entry is checked with [`dsh-plugin-market-index`](../../packages/util/plugin-market-index/README.md) before it is written.

`metadata.keywords` is an optional array of strings for discovery. npm `package.json` `keywords` is the convention; index generators may supplement or adjust it. This reference generator copies the highest listed version's manifest `keywords` unchanged, including empty strings, duplicates, and an empty array. An absent field is omitted; a non-array value or an array containing any non-string produces a warning and omits the whole field without dropping the package.

When several sources produce the same package name, the first one in the list wins.

## Caching and repeated runs

Each run reads the registry document of every npm source and the refs of every Git repository. Results are cached per immutable input: an npm plugin per registry, icon threshold, package, and set of listed versions; a Git repository per default branch commit and release tags; and each Git package per commit and directory. A Git run therefore fetches only the commits whose packages are not cached. Cache files are written atomically, and a cache file that is damaged or that the index format rejects is rebuilt. Output is deterministic: entries follow the list order, and the index and icon files are rewritten only when their contents change, so running the generator again without upstream changes leaves the output untouched.

## Security

The generator downloads and reads files only. npm tarballs are read in memory: a tarball and its unpacked files may not exceed 64 MiB each, the bytes must match the registry integrity hash, and only regular files outside `node_modules` are kept, without paths that leave the package. Git objects are fetched with depth 1 into a private temporary bare repository and read as blobs, so no working tree exists and no checkout filter, LFS download, or symbolic link takes effect; symbolic links and submodules count as absent. Git runs with hooks and the file-system monitor disabled, no submodules, only the https and ssh transports, and without inherited `GIT_*` variables except `GIT_SSH` and `GIT_SSH_COMMAND`. Your ssh program and `GIT_SSH_COMMAND` keep precedence; without either, ssh runs in batch mode, so it never waits for a prompt. Manifests, locale files, and workspace files over 1 MiB are refused. Private repositories use your Git credential configuration; an https URL can be routed to ssh with `url.<base>.insteadOf`.

Index content is what the packages claim about themselves. Review the list you publish: a listed repository can use any package name.

## Limits

- A Git server must allow fetching a commit by its SHA, as GitHub, GitLab, and Gitea do. When a server refuses, the generator fetches the tags and the default branch by name, which fails if a ref moved after it was listed.
- Registry tokens from `.npmrc` are not applied; only public or unauthenticated registries work.
- Git never prompts for credentials. A repository that needs them must be readable through a credential helper or an ssh agent.
