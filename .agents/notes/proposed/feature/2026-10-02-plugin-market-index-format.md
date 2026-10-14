# Agent Note: Plugin market index format

Status: proposed

English | [中文](2026-10-02-plugin-market-index-format.zh.md)

## Problem

DSH installs third-party bundles only from a spec the user already knows: an npm name, a Git URL, a tarball, or a local path. Nothing lets a user browse installable bundles. No official market exists, and one may be added later, so a market mechanism must work with indexes that third parties publish.

The smallest possible index is a list of npm names or Git repository URLs, one per line. It identifies every plugin, but a client rendering it must fetch each package's manifest, locale files, and icon before it can show a list. A list page that issues one or more requests per row is slow, fails partially, and puts metadata resolution in every client.

An index must therefore carry everything a list page displays: localized title and description, icon, author, available versions, compatibility, and publish time. Markets also want to publish their own data, such as categories, tags, downloads, and ratings, without DSH knowing what those values mean.

## Proposal

Separate the **index** from the **index generator**. DSH defines and reads one JSON index format. How an index is produced, and from which source list, belongs to the generator. DSH's reader, its Discover page, and a reference generator are separate changes that consume this format. Indexes list [profile plugin bundles](../../implemented/architecture/2026-08-05-profile-plugin-bundles.md) and install them through [guided plugin installation](../../implemented/architecture/2026-09-15-guided-plugin-installation.md).

The market reuses npm's package names, versions, ranges, distribution tags, and person declarations. Readers and generators use maintained npm parsers and validators. Additional fields or changed meanings require a plugin-market requirement that npm does not meet.

### Example

```json
{
  "format": 1,
  "title": { "en": "Example Market", "zh": "示例市场" },
  "description": { "en": "Community DSH bundles", "zh": "社区 DSH bundle" },
  "metadata": {
    "categories": {
      "productivity": { "title": { "en": "Productivity", "zh": "效率" } }
    },
    "labels": {
      "official": { "title": { "en": "Official", "zh": "官方" } }
    },
    "sortKeys": {
      "downloads": { "title": { "en": "Downloads", "zh": "下载量" }, "order": "desc" },
      "rating": { "title": { "en": "Rating", "zh": "评分" }, "order": "desc" }
    }
  },
  "plugins": [
    {
      "name": "@example/dsh-auto-review",
      "title": { "en": "Auto Review", "zh": "自动审查" },
      "description": { "en": "Per-tool LLM authorization review", "zh": "逐工具 LLM 授权审查" },
      "icon": "icons/auto-review.svg",
      "author": "Example Labs",
      "homepage": "https://example.com/dsh-auto-review",
      "metadata": {
        "category": "productivity",
        "labels": ["official"],
        "keywords": ["review", "authorization"],
        "sortKeys": { "downloads": 12034, "rating": 4.6 }
      },
      "dist-tags": { "latest": "0.2.0-rc.1", "next": "0.2.0-rc.2" },
      "versions": [
        {
          "version": "0.2.0-rc.2",
          "publishTimestamp": 1790476800,
          "source": { "type": "npm" },
          "engines": { "dsh": ">=0.2.0 <0.3.0" }
        },
        {
          "version": "0.2.0-rc.1",
          "publishTimestamp": 1789872000,
          "source": { "type": "npm" },
          "engines": { "dsh": "0.2.0 - 0.2.4 || >=0.3.0 <0.4.0" }
        }
      ]
    },
    {
      "name": "dsh-plugin-foo",
      "title": "Foo",
      "icon": "https://example.com/foo.png",
      "dist-tags": { "latest": "1.0.0" },
      "versions": [
        {
          "version": "1.0.0",
          "publishTimestamp": 1788000000,
          "source": {
            "type": "git",
            "url": "https://github.com/author/dsh-plugins",
            "commit": "3f9c2e1d8a4b6c0e7f1a2b3c4d5e6f708192a3b4",
            "path": "packages/foo"
          },
          "engines": { "dsh": "*" }
        }
      ]
    }
  ]
}
```

`LocalizedText` below is the `LocalizedText` type of [`dsh-package-manifest`](../../../../packages/util/package-manifest/src/types.ts), a string or an object of strings that contains `en`, with two additional rules: object keys are lowercase language ids matching `^[a-z]{2,8}(-[a-z0-9]{1,8})*$`, and every string contains at least one non-whitespace character.

### Root fields

| Field | Required | Rule |
|---|---|---|
| `format` | yes | Integer `1`. |
| `title` | yes | `LocalizedText` naming the market. |
| `description` | no | `LocalizedText`. |
| `metadata` | no | Object holding the three declaration maps below. |
| `metadata.categories` | no | Object mapping category id → `{ title: LocalizedText }`. |
| `metadata.labels` | no | Object mapping label id → `{ title: LocalizedText }`. |
| `metadata.sortKeys` | no | Object mapping sort-key id → `{ title: LocalizedText, order: "asc" \| "desc" }`; `order` is the initial sort direction. |
| `plugins` | yes | Array of plugins, possibly empty; its order is the index's default ordering. |

Category, label, and sort-key ids are non-empty strings. Readers look ids up as own properties, so ids such as `constructor` have no special meaning.

### Plugin fields

| Field | Required | Rule |
|---|---|---|
| `name` | yes | Package name accepted by npm's maintained package-name validator for new packages; unique within the index. |
| `title` | no | `LocalizedText`; a reader displays `name` when absent. |
| `description` | no | `LocalizedText`. |
| `icon` | no | Either `data:<type>;base64,<payload>`, where `<type>` is `image/svg+xml`, `image/png`, `image/jpeg`, or `image/webp`, `<payload>` is canonically padded base64, and the decoded payload is at most 256 KiB; or a URL reference whose resolution against the index URL is an `https:` URL or has the index URL's origin. |
| `author` | no | String with at least one non-whitespace character. |
| `homepage` | no | Absolute `https:` or `http:` URL of a page about the plugin. |
| `metadata` | no | Object holding the values below. |
| `metadata.category` | no | One declared category id. |
| `metadata.labels` | no | Array of distinct declared label ids. |
| `metadata.keywords` | no | Array of free-form strings; no root declaration required. |
| `metadata.sortKeys` | no | Object mapping a declared sort-key id → finite number. |
| `dist-tags` | no | Object mapping npm distribution-tag names to exact listed version strings; absent means no recorded channels. |
| `versions` | yes | Non-empty array of versions; see below. Array order does not select the installation version. |

`metadata.keywords` conventionally comes from npm `package.json` `keywords`, but generators may use another source, add strings, or adjust values. Neither presence nor equality with the package manifest is required. Readers preserve the strings and their order; an empty array is valid.

### Version fields

| Field | Required | Rule |
|---|---|---|
| `version` | yes | Exact version parsed by npm's `node-semver`; preserve the complete string, including Git build metadata. The exact string is unique within the plugin. |
| `publishTimestamp` | yes | Integer Unix timestamp in seconds, in `[0, 10^11)`. |
| `source` | yes | Where `version` is installed from; see below. |
| `engines` | yes | Object containing `dsh`. |
| `engines.dsh` | yes | Non-blank valid npm SemVer range declared in the source manifest; copied unchanged. `*` explicitly declares support for any DSH version. |

A relative `icon` reference resolves against the index URL, as an HTML image reference resolves against its page. For an index at `https://market.example/dsh/index.json`, `"icon": "icons/foo.svg"` names `https://market.example/dsh/icons/foo.svg`. A generator can therefore publish the index and its icon files as one directory on any static host without knowing the final URL. Absolute icon URLs on other origins must use `https:`; the same-origin allowance lets an `http:` index on a loopback or intranet host serve its own icons. Readers resolve the reference when they read the index, so clients receive absolute URLs.

`source` takes one of two forms, and readers reject any other `type`:

- `{ "type": "npm", "registry"?: string }`. `registry` is an `http:` or `https:` URL without credentials, query, or fragment; `http:` is admitted for intranet mirrors, as in DSH's [install registries](../../implemented/architecture/2026-09-18-plugin-install-registries.md).
- `{ "type": "git", "url": string, "commit": string, "path"?: string }`. `url` is a canonical `https:` URL (equal to its WHATWG URL serialization) with at least two non-empty path segments and no trailing slash, without credentials, query, or fragment, and not ending in `.tgz` or `.tar.gz`. `commit` is a lowercase 40-hex-digit SHA. `path` is a `/`-separated relative directory whose segments contain only ASCII letters, digits, and `._@+-`, and are neither `.` nor `..`; absent means the repository root.

### Install arguments

A client installs one version with exactly these pnpm arguments:

- npm: the spec `<name>@<version>`. Without `registry`, the client asks its configured registries as it does for any install. With `registry`, the client follows DSH's [registry plan](../../implemented/architecture/2026-09-18-plugin-install-registries.md): it asks `registry` first and falls back to its other configured registries only when `registry` is one of them; any other `registry` is asked alone, so a private registry never falls through to a public one that may publish a different package under the same name and version.
- git: the spec `git+<url>.git#<commit>`, without doubling a trailing `.git`, followed by `&path:/<path>` when `path` is present. The `git+` prefix makes pnpm treat URLs with more than two path segments, such as GitLab subgroups, as Git repositories.

### DSH compatibility

Every market-listed version must declare valid `engines.dsh`. The reader and market-origin installation evaluate that range against the running DSH version with npm's `node-semver` and `includePrerelease: true`. There is no peer fallback or range synthesis. npm package peer resolution remains outside market host compatibility.

Installation rechecks the source manifest before accepting a market-origin package. An exact local `name@version` exemption may permit a valid range that rejects the runtime; it cannot make a missing or invalid declaration eligible. Exemptions are not published in the index.

### Generator obligations

A reader cannot verify these rules; a generator that violates them publishes a misleading index.

- `name` and each `version` equal the package manifest of the installed source.
- `publishTimestamp` is the registry publish time of `version` for npm sources and the committer time of `commit` for Git sources.
- `engines.dsh` copies the manifest's declared range unchanged. A version with a missing, blank, or invalid range is omitted with a diagnostic. A plugin with no eligible version is omitted.
- `dist-tags` snapshots npm's [distribution tags](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/), retaining only targets present among the eligible listed versions. For Git sources, the publisher or market supplies the same exact tag-to-version mapping.
- Each listed version declares `dsh.bundle`. Installation independently refuses a package without a bundle patch.
- `title`, `description`, and `icon` come from the highest listed version's locale metadata, manifest fields, and icon under the installed-plugin display rules. Use npm's `node-semver.rsort()` order, retaining input order for ties. This metadata choice does not select the installation version. `homepage` copies that version's manifest `homepage` and is absent without one.
- `author` comes from the same highest listed version's npm author declaration. Copy an object's `name`; parse shorthand strings with a maintained npm person normalizer. Omit an absent or whitespace-only name and contact fields. Normalize a fresh projection, leaving the source manifest untouched.

### Reader rules

A reader rejects the whole index when the document violates any rule in Root fields, Plugin fields, Version fields, or the `source` forms, including an undeclared category, label, or sort-key reference, an unlisted distribution-tag target, a duplicate `name` or exact `version` string, or a `format` other than `1`. Each such defect is a generator bug, and dropping entries silently would hide it. Readers may bound the document size.

A reader ignores members that this note does not define, at every level; an unknown `source.type` value is rejected. Format 1 can then gain optional members without breaking existing readers; a change that existing readers would misinterpret uses a new `format` value.

Tag names must parse as registry tag specs under npm's maintained `npm-package-arg`; targets are exact listed version strings. npm sources use canonical published identifiers (`node-semver.valid(version) === version`); Git sources retain build metadata and pin their exact source by commit.

Categories, labels, and sort keys are opaque: a reader filters and sorts by them, displays their `title`, and never interprets an id. Readers display declarations in the order of their localized `title`. When sorting plugins, a plugin without a value for the selected sort key follows all plugins with a value in either direction, and equal values keep the index order. Sorting by publish time uses a plugin's greatest `publishTimestamp`.

A reader evaluates the required `engines.dsh` range under DSH compatibility. Versions use npm's `node-semver.rsort()` order, retaining index order for ties. Exact tag targets, not this display order, select installation versions.

The initial channel is `latest`. Its exact target is the publisher- or market-selected version. Clients install that recorded version or commit, never `name@latest`. Missing or incompatible `latest` requires explicit version or channel selection; clients do not switch automatically. Installation confirmation identifies the version, selected channel if any, prerelease status, index URL, and source.

## Alternatives considered

**A plain list of npm names or repository URLs.** It identifies every plugin but forces one or more requests per row before a list renders, which is the cost this format removes.

**One opaque install spec string per version.** A reader cannot verify that a free-form spec is pinned. A structured `source` with an exact `version`, or a `commit`, lets the reader verify pinning and lets the client build the spec it installs.

**Installing the latest version instead of a pinned one.** The installed build could then differ from the metadata the list displayed, and a package release would change what an unchanged index installs.

**One entry per version.** Every version would repeat the title, description, icon, author, and market metadata, and readers would group entries by `name` to show one plugin.

**One `source` per plugin, with only the pin per version.** A plugin that moves to another repository, directory, or registry between releases could not list its older versions.

**Display fields per version.** A list shows one row per plugin, so older display text, icons, authors, and homepages would cost index size without a reader that shows them.

**Inline icons only.** A list without extra requests needs inline icons, but 256 KiB of raw bytes is about 341 KiB as base64, so a 100-plugin index could reach about 35 MB. URL icons trade extra requests, and disclosure of the user's IP address to the image host, for a small index.

**Inferring host compatibility from peer dependencies.** The market defines a new standard requiring an author-declared `engines.dsh`. Existing packages must add that declaration before listing; no fallback, workspace mapping, or range intersection is needed.

**Copying the complete npm person object into the display field.** The list needs a name. The generator supports npm's original declaration while omitting unused contact fields.

**Opaque sort values for time, including ISO date strings.** Publish time has fixed semantics that clients format and sort, so it is a typed field. Without time, sort values can be numbers only, which needs no per-key value-type rule.

**Root-level `labels` and `sortKeys`, and a plugin field named `sort`.** Grouping market-defined declarations and values under `metadata` at both levels, with matching member names except the single-valued `category`, separates them from fields that clients interpret.

**Declaration order as display order.** JavaScript reorders integer-like object keys, so declaration order would need either an id pattern or array declarations. Clients sort declarations by their localized title instead.

**Selecting the greatest compatible version.** npm's `latest` can name an older release. Inferring a target from SemVer ranking loses the recorded channel choice and is ambiguous for equally ranked builds.

**Automatic prerelease fallback.** Missing or incompatible channel targets do not mean that the user selected a prerelease.

**Rejecting unknown members.** Every optional addition would then require a new `format` value and break every deployed reader.

## Acceptance criteria

- A validator accepts the example above and rejects one violation of each rule in Root fields, Plugin fields, Version fields, and the `source` forms, with a diagnostic naming the JSON path.
- Install arguments built from every example version are accepted by DSH's install-spec parser and by pnpm.
- A validator ignores unknown members at every level.
- Generator and validator refuse missing, blank, and invalid `engines.dsh`; omitted versions leave no dangling tag target. Index and market-origin installation agree on valid ranges, including hyphen ranges, prereleases, and valid ranges that reject the runtime. Exemptions never bypass the declaration requirement.
- Exact tag targets select the same source after equally ranked Git build versions are reordered. Missing targets are rejected; absent or incompatible `latest` causes no automatic switch.
- npm author objects and shorthand strings produce the declared name without contact fields or mutation of source identity.

## Risks

- An index is unsigned. Titles, authors, labels, and scores are market claims; an `official` label is not DSH verification. Clients must show the index URL and each version's `source`.
- A Git version's `name`, `version`, and `engines.dsh` are claims about the repository. A repository can claim any name, including an `@deepseek-ai/dsh-` name, and the installed manifest decides what is actually installed.
- An npm version's `source.registry` is equally a claim: it directs the install of any `name`, including an `@deepseek-ai/dsh-` name, to a registry the market chooses, and that registry decides what is installed.
- URL icons disclose the user's IP address to image hosts.
- Pinned versions and distribution tags stay stale until the index is regenerated.
- Market text reaches users, and models through any client tool that lists plugins, without review by DSH.
