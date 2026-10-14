#!/bin/sh
set -eu
ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
install -d -m 700 -o dsh -g dsh /home/dsh/.ssh
install -m 600 -o dsh -g dsh /fixture-key.pub /home/dsh/.ssh/authorized_keys
install -d -m 700 -o dsh -g dsh /home/dsh/workspace
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
