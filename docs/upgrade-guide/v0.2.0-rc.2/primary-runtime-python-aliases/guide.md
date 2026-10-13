---
kind: upgrade-guide
description: "Custom primary-runtime payloads require relocatable Python interpreter aliases."
---

# Custom Python runtime aliases must target a sibling interpreter

English | [中文](guide.zh.md)

## Change

On macOS and Linux, `DSH_PRIMARY_RUNTIME` previously accepted interpreter links that resolved outside their payload or through other links. Payload validation now requires each linked `dependencies/python/bin/python` or `python3` to point directly to the regular sibling interpreter named for `runtime.json`'s Python major and minor version, such as `python3.12`. Regular command files remain supported, including those distributed in Python wheels. Windows is unchanged.

## Migration

1. For a custom payload, keep the versioned interpreter in `dependencies/python/bin/` and make `python` and `python3` relative links to its filename. The [runtime preparation instructions](../../../../packages/skill/tool-workspace-dependencies/README.md) list the required target and output arguments.
2. Preserve relative links when copying prepared resources. With Node `fs.cp`, use `verbatimSymlinks: true`; wheel builders must materialize the command files because pip does not restore links. The native build smoke requires the prepared resource tree to retain both aliases.
3. Confirm that `readlink` reports only the sibling filename for both aliases, then move the payload away from its build directory, point `DSH_PRIMARY_RUNTIME` at its new directory, and verify that `load_workspace_dependencies` and the returned Python command succeed.
