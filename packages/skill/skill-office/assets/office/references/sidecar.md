# Missing Office sidecar

These instructions apply in Web, Desktop, and SDK sessions. First check whether an existing LibreOffice Kit installation can serve the task; a missing `dsoffice` command on PATH alone does not establish that the sidecar is absent. If the required sidecar is missing and the user has not already authorized its download, use the available ask-question tool to ask whether they want to download the Office conversion engine. If that tool is unavailable, ask in the conversation. Wait for explicit agreement before downloading or installing; if the user declines, continue work that does not need the engine and report the unavailable operation.

After agreement, install `@deepseek-ai/libreoffice-kit` together with the matching engine package, using the engine version declared by the main package's optional dependencies. Use an available npm or pnpm in a task-local tools directory, with `--ignore-scripts`: the packages provide prebuilt binaries and do not need installation scripts. Keep the package manager's cache or store in that writable task directory too (for npm, pass `--cache <task-tools-directory>/.npm-cache`). Select the package for the operating system and architecture of the Node.js process that will run the CLI, including when Node runs under emulation:

| Runtime platform | Engine package |
| --- | --- |
| Windows x64 | `@deepseek-ai/libreoffice-kit-win32-x64` |
| Windows ARM64 | `@deepseek-ai/libreoffice-kit-win32-arm64` |
| macOS Apple Silicon | `@deepseek-ai/libreoffice-kit-darwin-arm64` |
| macOS Intel | `@deepseek-ai/libreoffice-kit-darwin-x64` |
| No matching native package, including Linux | `@deepseek-ai/libreoffice-kit-wasm` |

Prefer the matching native package; otherwise use WASM when its package supports the current platform. Check package platform restrictions before installation rather than forcing an incompatible package. The published WASM package currently declares Linux support.

Reuse the bundled Node.js and pnpm paths from `load_workspace_dependencies` when available, or the user's configured Node.js and package manager. Permission to download the Office sidecar does not include installing Python, Node.js, or a package manager. If those prerequisites are missing, explain what is needed. Run the new installation's `dsoffice` entry, or its `lib/cli.js` with the selected Node executable, by path; do not assume installation changed the session's PATH. Check `dsoffice capabilities` before continuing the requested operation.
