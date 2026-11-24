#!/usr/bin/env bash
set -euo pipefail

# Ubuntu HTTP archive mirrors can stall for tens of seconds per package
# (Blacksmith lists http://azure.archive.ubuntu.com first), and Playwright's
# `install --with-deps` installs many of them. Point every APT source at HTTPS
# before that step, so a hosted runner spends seconds instead of minutes there.

sudo python3 - <<'PY'
from pathlib import Path
import re

apt = Path('/etc/apt')
sources = [apt / 'sources.list', apt / 'blacksmith-ubuntu-mirrors.txt',
           *(apt / 'sources.list.d').glob('*.list'),
           *(apt / 'sources.list.d').glob('*.sources')]
for source in sources:
    if source.is_file():
        source.write_text(re.sub(
            r'http://(?:[a-z0-9-]+\.)*(archive|security)\.ubuntu\.com/',
            r'https://\1.ubuntu.com/', source.read_text()))
PY
