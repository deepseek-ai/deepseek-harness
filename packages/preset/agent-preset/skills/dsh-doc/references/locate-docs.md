# Locate documentation and sources

Answer for the running installation, not an unrelated checkout in the current working directory. Keep lookups read-only and cite the files and version used. The Host file-read tool can read Desktop's `app.asar`; use offset and limit for long files.

## Identify the installation

These runtime facts are not necessarily in model context. Print only the needed variables: in bash, `printf '%s\n' "$DSH_PROFILE" "$DSH_INSTALL_DIR" "$DSH_NODE_EXECUTABLE"`; in PowerShell, `$env:DSH_PROFILE; $env:DSH_INSTALL_DIR; $env:DSH_NODE_EXECUTABLE`. Keep the loaded skill's reported Base directory. `DSH_PROFILE=desktop` identifies the Desktop profile, including development launches; `web` can run from npm or source. Profile and distribution are not one-to-one: verify ASAR or checkout markers below. `DSH_PROFILE_DIR` holds the user's profile and added plugins, not the DSH installation root. Standard and Creator are agent modes, not installation layouts.

Verify that `DSH_INSTALL_DIR/package.json` names `@deepseek-ai/dsh`; its `version` identifies the running CLI package. Resolve symlinks before comparing directories. Missing variables alone do not establish that there is no profile or no source. Use the loaded skill's location or an inspected package directory to verify a candidate; if none is verifiable, report what remains unlocated. Do not change the profile to obtain tools.

## Source checkout

A source launch normally points `DSH_INSTALL_DIR` at `<root>/apps/cli`. Verify `<root>/pnpm-workspace.yaml`, `<root>/package.json` with name `@deepseek-ai/dsh-root`, and `<root>/apps/cli/package.json` with name `@deepseek-ai/dsh`. The loaded skill may instead locate the candidate root: its real directory is `<root>/packages/preset/agent-preset/skills/dsh-doc`, five parents below the root. Verify the same markers; a matching working-directory name is not evidence of the running installation.

Read `<root>/docs/user/index.md` for user documentation and `<root>/docs/upgrade-guide/` for migration guides. The checkout's `apps/cli/docs` need not exist. Use `<root>/packages/README.md` to find the owning group, then `<root>/packages/<group>/<directory>/package.json` to verify the package name. Read that package's `README.md` and the owning file under `src/`; do not assume every package resolves from `apps/cli/node_modules`. Use the verified CLI manifest's version and identify the checkout used.

## npm installation

For an installed package layout outside an ASAR, verify the CLI manifest at `DSH_INSTALL_DIR` and its packaged `docs/`; do not infer npm installation merely because checkout markers are absent. Read `DSH_INSTALL_DIR/docs/user/index.md` and `DSH_INSTALL_DIR/docs/upgrade-guide/README.md`, the generated index for this installed version's guides.

Resolve a shipped package's exported `package.json` from this installation anchor with the runtime command below. Read its `README.md`, then the owning file under `src/` when present; `lib/` contains built code. A configuration-only bundle may instead expose its patch files. Do not resolve from the shell's cwd or assume a global npm prefix. A package unavailable from this anchor may be a user-added plugin: use Inspect's package directory when available rather than guessing another installation's files.

## Desktop

For the packaged Desktop app, confirm that the installation or loaded skill path lies inside `app.asar` and the indicated runtime reports `process.versions.electron`. A Desktop development launch with verified checkout markers uses the source route above. Inside the archive, `DSH_INSTALL_DIR` still names the CLI package directory. Read its manifest, `docs/user/index.md`, and `docs/upgrade-guide/README.md` through the Host file-read tool. Resolve other packages from the same anchor and read their README and `src/` through that tool.

Native grep/glob, `ls`, `cat`, and a Node executable chosen from `PATH` cannot traverse ASAR files. Do not unpack the app to answer a question. For directory listing or bounded search, use `DSH_NODE_EXECUTABLE`, the running Electron executable, with `ELECTRON_RUN_AS_NODE=1` as below. It supplies ASAR-aware filesystem reads; an ordinary Node runtime ignores that environment setting.

## Resolve a package with the running runtime

With Inspect available, `Config.listConfigs` filtered by `name` lists mounted entries; querying an `entry` supplies `packageDir`. Otherwise use the installation anchor and executable verified above. In bash:

```sh
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" -e "console.log(require('node:path').dirname(require.resolve(process.argv[1] + '/package.json', { paths: [process.env.DSH_INSTALL_DIR] })))" @deepseek-ai/dsh-tool-bash
```

In PowerShell, use redirected process output and wait for the exit code. Windows Desktop's Electron is a GUI-subsystem executable, for which `&` does not reliably wait. Replace `$script` and `$arguments` for other reads:

```powershell
$script = @'
console.log(require('node:path').dirname(require.resolve(process.argv[1] + '/package.json', { paths: [process.env.DSH_INSTALL_DIR] })))
'@
$arguments = @('@deepseek-ai/dsh-tool-bash')
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$start = [System.Diagnostics.ProcessStartInfo]::new($env:DSH_NODE_EXECUTABLE)
foreach ($argument in @('-e', $script, '--') + $arguments) { $start.ArgumentList.Add($argument) }
$start.Environment['ELECTRON_RUN_AS_NODE'] = '1'
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$start.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$process = [System.Diagnostics.Process]::Start($start)
$stderr = $process.StandardError.ReadToEndAsync()
$stdout = $process.StandardOutput.ReadToEnd()
$process.WaitForExit()
[Console]::Out.Write($stdout)
[Console]::Error.Write($stderr.Result)
exit $process.ExitCode
```

If the executable or anchor is absent, do not substitute an unrelated Node from PATH. Inspect or directly read verified files. A checkout found only from the skill locates source but does not prove the running CLI version. Verify that `../../package.json` relative to the skill's base names `@deepseek-ai/dsh-agent-preset` before using its version as the shipping skill package's version. For a custom or single-executable layout, report only locations and versions actually verified.

## Bounded lookup

Read one file at a time. Outside ASAR, search only a narrow known directory. Inside ASAR, run `require('node:fs').readdirSync(dir).slice(0, 200)` through the runtime above to list one directory. For search, use that runtime's `fs.statSync(file).size` to reject files above a chosen bound (for example 1 MiB) before `fs.readFileSync(file, 'utf8')`; split into lines, match a literal term, and print the path once and at most 20 matching lines of 200 characters each with line numbers and a truncation notice. Do not scan or dump whole package trees. Use the file-read tool's offsets for larger files. Read the installed upgrade index before selecting guides as `references/upgrading.md` describes. If a file is missing, state that limitation rather than substituting another version's documentation or source.
