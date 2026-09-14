# native/

English | [中文](README.zh.md)

Native source and public packages maintained with DeepSeek Harness. The [`system/` workspace](system/README.md) owns the Landlock launcher and POSIX flock binding, their platform packages, and the [release procedure](system/docs/release.md).

## Workspace and release boundary

`system/` and its packages belong to the repository's root pnpm workspace and lockfile. Harness consumers use the current workspace entry package during development and CI, so a launcher contract change and its consumer update can land and be tested together.

The main repository's `Node Addon System` workflow builds and tests each supported architecture. `Node Addon System Release` assembles those native artifacts, packs and verifies the npm tarballs, then optionally publishes them under one native version. The entry package retains platform packages as npm optional dependencies, so npm still installs only the package matching the user's operating system and CPU.
