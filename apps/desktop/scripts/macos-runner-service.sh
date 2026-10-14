#!/bin/bash
# Manage a registered runner in the current user's logged-in macOS session.
set -euo pipefail
if [[ $# -lt 2 ]]; then
  echo 'Usage: bash macos-runner-service.sh install RUNNER_ROOT CONFIG_ROOT NODE_BIN | start|stop|status|uninstall RUNNER_ROOT' >&2
  exit 1
fi
action=$1
runner_root=$2
[[ $(uname -s) = Darwin && $EUID -ne 0 ]] || { echo 'Run as the registered macOS runner user, without sudo' >&2; exit 1; }
[[ "$runner_root" = /* && -f "$runner_root/.runner" && -x "$runner_root/svc.sh" ]] || { echo 'Provide an absolute registered runner directory' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$runner_root"
case "$action" in
  install)
    [[ $# = 4 ]] || { echo 'install requires RUNNER_ROOT CONFIG_ROOT NODE_BIN' >&2; exit 1; }
    config_root=$3
    node_bin=$4
    [[ ! -f .service ]] || { echo 'Service already installed; stop and uninstall it before reinstalling' >&2; exit 1; }
    launchctl print "gui/$(id -u)" >/dev/null || { echo 'Log into the macOS desktop as this user first' >&2; exit 1; }
    bash "$source_dir/start-macos-packaging-runner.sh" "$runner_root" "$config_root" "$node_bin" --check
    umask 077
    service_dir="$runner_root/dsh-service"
    mkdir -p "$service_dir"
    cp "$source_dir/start-macos-packaging-runner.sh" "$service_dir/start.sh"
    # runsvc.sh reloads .path; replace the interactive PATH saved by registration.
    printf '%s\n' "$node_bin:/usr/bin:/bin:/usr/sbin:/sbin" > .path
    "$node_bin/node" --input-type=module - "$service_dir" "$runner_root" "$config_root" "$node_bin" <<'NODE'
import { writeFileSync } from 'node:fs'
const [directory, runner, config, node] = process.argv.slice(2)
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
// svc.sh substitutes its own placeholders with sed; prohibit template syntax in paths.
for (const value of [directory, runner, config, node]) {
  if (/[\r\n]|\{\{/u.test(value)) throw new Error('Service paths cannot contain newlines or template placeholders')
}
const args = ['/bin/bash', `${directory}/start.sh`, runner, config, node, '--service']
writeFileSync(`${directory}/service.plist.template`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{{SvcName}}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(runner)}</string>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(directory)}/stdout.log</string>
<key>StandardErrorPath</key><string>${xml(directory)}/stderr.log</string>
<key>EnvironmentVariables</key><dict><key>ACTIONS_RUNNER_SVC</key><string>1</string></dict>
<key>ProcessType</key><string>Interactive</string>
<key>SessionCreate</key><true/>
</dict></plist>
`, { mode: 0o600 })
NODE
    GITHUB_ACTIONS_RUNNER_SERVICE_TEMPLATE="$service_dir/service.plist.template" ./svc.sh install
    /usr/bin/plutil -lint "$(cat .service)"
    echo 'Installed. Run start, then status. This LaunchAgent requires a desktop login after reboot.'
    ;;
  start|stop|status|uninstall)
    [[ $# = 2 && -f .service ]] || { echo 'Provide an installed runner service directory' >&2; exit 1; }
    ./svc.sh "$action"
    ;;
  *) echo "Unknown action: $action" >&2; exit 1 ;;
esac
