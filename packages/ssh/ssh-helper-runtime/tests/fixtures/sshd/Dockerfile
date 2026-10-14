# glibc 2.28 target without Node or a checkout; only the release payload is mounted at runtime.
FROM almalinux:8.10
RUN dnf install -y openssh-server procps-ng shadow-utils passwd && dnf clean all \
    && useradd --create-home dsh && passwd -d dsh \
    && rm -f /etc/ssh/ssh_host_*key*
COPY sshd_config /etc/ssh/sshd_config
COPY start.sh /start.sh
ENTRYPOINT ["/bin/sh", "/start.sh"]
