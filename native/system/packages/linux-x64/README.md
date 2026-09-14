---
description: "Prebuilt Landlock launcher and POSIX flock addons for Linux x64."
kind: "package-library"
---
# @deepseek-ai/node-addon-system-linux-x64

English | [中文](README.zh.md)

This platform package contains the static musl executable `bin/landlock-run` and Node-API v8 addons `bin/glibc/system.node` and `bin/musl/system.node`. The entry chooses the addon matching the running Node process's libc; the Landlock executable serves both libc systems.

The package contains no JavaScript or installation build script. Platform prepack checks complete payloads, ELF architecture, Node-API exports, and launcher executability; the installed-artifact rehearsal checks bytes and executes native behavior. See the workspace [support matrix](../../docs/support-matrix.md).
