#!/bin/bash
# Run an already registered Apple Silicon runner with explicit tools and machine configuration.
set -euo pipefail
if [[ $# -lt 3 || $# -gt 4 || (${4:-} != '' && ${4:-} != '--check' && ${4:-} != '--service') ]]; then
  echo 'Usage: bash start-macos-packaging-runner.sh RUNNER_ROOT CONFIG_ROOT NODE_BIN [--check|--service]' >&2
  exit 1
fi
runner_root=$1
config_root=$2
node_bin=$3
for directory in "$runner_root" "$config_root" "$node_bin"; do
  [[ "$directory" = /* && -d "$directory" ]] || { echo 'All directories must exist and be absolute' >&2; exit 1; }
done
[[ $(uname -s) = Darwin && $(uname -m) = arm64 ]] || { echo 'Requires an Apple Silicon Mac' >&2; exit 1; }
[[ -x "$node_bin/node" ]] || { echo 'NODE_BIN must contain Node 24' >&2; exit 1; }
[[ $("$node_bin/node" -p 'process.versions.node.split(".")[0]') = 24 ]] || { echo 'Requires Node 24' >&2; exit 1; }
[[ -f "$config_root/presets/test.env" && -f "$config_root/secrets/macos-signing.env" ]] || { echo 'Configure the test preset and macos-signing.env before starting' >&2; exit 1; }
developer_dir=$(xcode-select -p)
sdk_root=$(DEVELOPER_DIR="$developer_dir" xcrun --sdk macosx --show-sdk-path)
xcrun --find notarytool
xcrun --find stapler
probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/dsh-macos-toolchain.XXXXXX")
trap 'rm -rf "$probe_dir"' EXIT
DEVELOPER_DIR="$developer_dir" SDKROOT="$sdk_root" /usr/bin/cc -x c - -o "$probe_dir/toolchain-probe" <<<'int main(void) { return 0; }'
rm -rf "$probe_dir"
trap - EXIT
if [[ ${4:-} = '--check' ]]; then
  echo 'Runner tool and configuration-file checks passed; registration and credentials were not tested.'
  exit 0
fi
[[ -f "$runner_root/.runner" && -x "$runner_root/run.sh" ]] || { echo 'Register the runner before starting' >&2; exit 1; }
entry=./run.sh
if [[ ${4:-} = '--service' ]]; then
  [[ -x "$runner_root/runsvc.sh" ]] || { echo 'Install the runner service first' >&2; exit 1; }
  entry=./runsvc.sh
fi
cd "$runner_root"
exec /usr/bin/env -i HOME="$HOME" USER="$(id -un)" LOGNAME="$(id -un)" \
  PATH="$node_bin:/usr/bin:/bin:/usr/sbin:/sbin" TMPDIR="${TMPDIR:-/tmp}" \
  DEVELOPER_DIR="$developer_dir" SDKROOT="$sdk_root" \
  ACTIONS_RUNNER_SVC="${ACTIONS_RUNNER_SVC:-0}" LANG=en_US.UTF-8 DSH_PACKAGING_CONFIG_DIR="$config_root" DSH_TELEMETRY_DISABLED=1 \
  /usr/bin/caffeinate -i "$entry"
