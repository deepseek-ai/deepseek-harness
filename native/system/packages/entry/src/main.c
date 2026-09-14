/*
 * landlock-run: self-restrict-then-exec Landlock launcher.
 *
 * The Landlock rung of a consuming sandbox seam, for Linux hosts where
 * `bwrap` is
 * unusable (not installed, unprivileged user namespaces disabled, or an LSM
 * profile that denies mount — Landlock is an independent syscall family and
 * needs none of those). The launcher installs a Landlock
 * ruleset on itself and `exec`s the wrapped command; the ruleset is inherited
 * across `execve`, so the command (and every process it spawns) runs confined
 * while the invoking process stays unrestricted.
 *
 * CLI contract (mirrors the `bwrap` runner argv shape the executor wraps):
 *
 *   landlock-run [--ro <path>]... [--rw <path>]... -- <argv>...
 *   landlock-run --probe
 *
 * `--ro` grants read+execute beneath the path; `--rw` grants full filesystem
 * access beneath the path. Everything else is denied (Landlock is an
 * allow-list). `--probe` builds a maximal ruleset and reports whether the
 * running kernel actually enforces it — the executor's functional probe.
 *
 * Fail-closed: if the ruleset cannot be created or is NOT enforced by the
 * kernel, the launcher exits non-zero WITHOUT exec'ing the command. A partial
 * (best-effort) enforcement on an older ABI is accepted and reported on
 * stderr; the consumer's mode vocabulary keeps its file-effect promises
 * honest per ABI level (surfaced as `full` vs `partial` by the entry
 * package's probe).
 *
 * Plain C11 over the raw Landlock UAPI — no libraries beyond libc (musl,
 * linked statically), so the whole audit surface is this file plus the
 * kernel's stable syscall contract. Built natively per architecture by
 * `scripts/build.ts` into the per-platform npm packages
 * (`@deepseek-ai/node-addon-system-linux-{x64,arm64}`); the argv grammar,
 * exit codes, and report lines are pinned in `docs/cli-contract.md`.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/*
 * The Landlock UAPI, defined locally instead of via <linux/landlock.h>: the
 * kernel's user-space ABI is stable by contract, self-defining it keeps the
 * build independent of the toolchain's header vintage, and the definitions
 * double as the audit record of exactly which kernel API this launcher
 * touches. Layouts and values are verbatim from the kernel header (the
 * path-beneath struct is packed there, so it must be packed here).
 */
struct landlock_ruleset_attr {
  uint64_t handled_access_fs;
};

struct landlock_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define LANDLOCK_RULE_PATH_BENEATH 1

/* Filesystem access bits, grouped by the Landlock ABI that introduced them. */
#define LL_FS_EXECUTE     (UINT64_C(1) << 0)  /* ABI 1 */
#define LL_FS_WRITE_FILE  (UINT64_C(1) << 1)
#define LL_FS_READ_FILE   (UINT64_C(1) << 2)
#define LL_FS_READ_DIR    (UINT64_C(1) << 3)
#define LL_FS_REMOVE_DIR  (UINT64_C(1) << 4)
#define LL_FS_REMOVE_FILE (UINT64_C(1) << 5)
#define LL_FS_MAKE_CHAR   (UINT64_C(1) << 6)
#define LL_FS_MAKE_DIR    (UINT64_C(1) << 7)
#define LL_FS_MAKE_REG    (UINT64_C(1) << 8)
#define LL_FS_MAKE_SOCK   (UINT64_C(1) << 9)
#define LL_FS_MAKE_FIFO   (UINT64_C(1) << 10)
#define LL_FS_MAKE_BLOCK  (UINT64_C(1) << 11)
#define LL_FS_MAKE_SYM    (UINT64_C(1) << 12)
#define LL_FS_REFER       (UINT64_C(1) << 13) /* ABI 2 */
#define LL_FS_TRUNCATE    (UINT64_C(1) << 14) /* ABI 3 (ABI 4 added TCP bits only) */
#define LL_FS_IOCTL_DEV   (UINT64_C(1) << 15) /* ABI 5 */

#define LL_ABI1_MASK (LL_FS_REFER - 1) /* bits 0..12: every ABI-1 access, nothing newer */

/*
 * Newest ABI this build knows; the negotiation below scales the actual
 * ruleset down to what the running kernel supports.
 */
#define MAX_ABI 5L

/*
 * Landlock has no libc wrappers; these are the raw syscalls. The numbers are
 * identical on every architecture (the post-2011 unified table) — the
 * fallbacks only matter to a libc older than the feature.
 */
#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif

/*
 * Every fatal launcher error prints `landlock-run: <message>` to stderr
 * and exits 125 — a code the wrapped command itself is unlikely to use, so
 * the executor can tell launcher failures from command failures.
 */
#define EXIT_LAUNCHER_FAILURE 125

static const char NOT_ENFORCED_MESSAGE[] =
  "landlock is not enforced by this kernel (ABI unsupported or disabled)";

/* Print one fatal `landlock-run: ...` line; returns the fatal exit code. */
static int fail(const char *prefix, const char *detail) {
  if (detail == NULL) {
    fprintf(stderr, "landlock-run: %s\n", prefix);
  } else {
    fprintf(stderr, "landlock-run: %s: %s\n", prefix, detail);
  }
  return EXIT_LAUNCHER_FAILURE;
}

static int fail_usage(const char *message, const char *detail) {
  fprintf(stderr, "landlock-run: usage error: %s%s\n", message, detail == NULL ? "" : detail);
  return EXIT_LAUNCHER_FAILURE;
}

/* Parsed CLI: either a probe, or grants plus the command argv after `--`. */
struct cli {
  int probe;
  const char **ro;
  size_t ro_count;
  const char **rw;
  size_t rw_count;
  char **command; /* NULL-terminated tail of main's argv */
};

/*
 * Hand-rolled argv parsing — four flags do not justify a parsing library.
 * Returns 0 on success, else the process exit code (message already printed).
 */
static int parse(int argc, char **argv, struct cli *cli) {
  /* argc bounds each grant list; the launcher execs or exits, so no free. */
  cli->ro = calloc(argc > 0 ? (size_t)argc : 1, sizeof *cli->ro);
  cli->rw = calloc(argc > 0 ? (size_t)argc : 1, sizeof *cli->rw);
  if (cli->ro == NULL || cli->rw == NULL) return fail("out of memory", NULL);

  int index = 1;
  while (index < argc) {
    const char *arg = argv[index];
    if (strcmp(arg, "--probe") == 0) {
      if (argc != 2) {
        return fail_usage("--probe takes no other arguments", NULL);
      }
      cli->probe = 1;
      index += 1;
    } else if (strcmp(arg, "--ro") == 0 || strcmp(arg, "--rw") == 0) {
      if (index + 1 >= argc) {
        return fail_usage(arg, " requires a path");
      }
      if (strcmp(arg, "--ro") == 0) {
        cli->ro[cli->ro_count++] = argv[index + 1];
      } else {
        cli->rw[cli->rw_count++] = argv[index + 1];
      }
      index += 2;
    } else if (strcmp(arg, "--") == 0) {
      cli->command = &argv[index + 1];
      break;
    } else {
      return fail_usage("unknown argument: ", arg);
    }
  }
  if (!cli->probe && (cli->command == NULL || cli->command[0] == NULL)) {
    return fail_usage("missing `-- <argv>...` command", NULL);
  }
  return 0;
}

/* The filesystem accesses the running kernel's ABI can govern. */
static uint64_t fs_mask_for_abi(long abi) {
  uint64_t mask = LL_ABI1_MASK;
  if (abi >= 2) mask |= LL_FS_REFER;
  if (abi >= 3) mask |= LL_FS_TRUNCATE;
  if (abi >= 5) mask |= LL_FS_IOCTL_DEV;
  return mask;
}

/* Add one path-beneath rule; 0 on success, else the exit code. */
static int add_rule(int ruleset_fd, const char *path, uint64_t access) {
  int path_fd = open(path, O_PATH | O_CLOEXEC);
  if (path_fd < 0) {
    /* Fail closed on an unopenable grant root: silently narrowing the
     * granted set would be safe, but running with a profile the caller did
     * not get is not worth the ambiguity. */
    fprintf(stderr, "landlock-run: cannot open rule path: %s: %s\n", path, strerror(errno));
    return EXIT_LAUNCHER_FAILURE;
  }
  /* The kernel rejects directory-only accesses on a non-directory rule
   * (EINVAL), so a file grant keeps only the file-compatible bits — how the
   * `--rw /dev/null` grant works. */
  struct stat st;
  if (fstat(path_fd, &st) == 0 && !S_ISDIR(st.st_mode)) {
    access &= LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE | LL_FS_TRUNCATE | LL_FS_IOCTL_DEV;
  }
  struct landlock_path_beneath_attr attr = { .allowed_access = access, .parent_fd = path_fd };
  if (syscall(__NR_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &attr, 0) != 0) {
    int saved = errno;
    close(path_fd);
    return fail("landlock ruleset error", strerror(saved));
  }
  close(path_fd);
  return 0;
}

/*
 * Install the ruleset on the current thread, negotiating the kernel's ABI
 * down from MAX_ABI. `--ro` paths get the read side of the vocabulary (read
 * file/dir + execute — the wrapped `bash` and everything it spawns must
 * remain executable); `--rw` paths get every filesystem access the
 * negotiated ABI can grant. Sets `no_new_privs` first (mandatory for an
 * unprivileged restrict, and it neutralizes setuid/setgid escalation inside
 * the sandbox). On success `*partial` reports whether the kernel governs
 * only a subset of MAX_ABI's accesses. Returns 0, else the exit code.
 */
static int restrict_self(const struct cli *cli, int *partial) {
  long abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) {
    /* ENOSYS: kernel built without Landlock; EOPNOTSUPP: built but disabled.
     * Either way: not enforceable — fail CLOSED, never exec unconfined. */
    return fail(NOT_ENFORCED_MESSAGE, NULL);
  }
  *partial = abi < MAX_ABI;
  uint64_t handled = fs_mask_for_abi(abi < MAX_ABI ? abi : MAX_ABI);

  struct landlock_ruleset_attr attr = { .handled_access_fs = handled };
  int ruleset_fd = (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof attr, 0);
  if (ruleset_fd < 0) return fail("landlock ruleset error", strerror(errno));

  const uint64_t read_side = LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR;
  for (size_t i = 0; i < cli->ro_count; i++) {
    int code = add_rule(ruleset_fd, cli->ro[i], read_side & handled);
    if (code != 0) return code;
  }
  for (size_t i = 0; i < cli->rw_count; i++) {
    int code = add_rule(ruleset_fd, cli->rw[i], handled);
    if (code != 0) return code;
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    return fail("landlock ruleset error", strerror(errno));
  }
  if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0) != 0) {
    return fail("landlock ruleset error", strerror(errno));
  }
  close(ruleset_fd);
  return 0;
}

int main(int argc, char **argv) {
  struct cli cli = { 0 };
  int code = parse(argc, argv, &cli);
  if (code != 0) return code;

  if (cli.probe) {
    /* The functional probe: build and enforce a maximal ruleset in THIS
     * short-lived process (the probe run exits right after). `--version`
     * style checks would miss a kernel that has the syscalls but refuses
     * enforcement; actually restricting is the only honest signal. The one
     * report line is part of the launcher CLI contract — the executor reads
     * enforcement completeness from it. */
    static const char *probe_root = "/";
    struct cli probe = { .ro = &probe_root, .ro_count = 1 };
    int partial = 0;
    code = restrict_self(&probe, &partial);
    if (code != 0) return code;
    printf("landlock: %s\n", partial ? "partially enforced (older ABI)" : "fully enforced");
    return 0;
  }

  int partial = 0;
  code = restrict_self(&cli, &partial);
  if (code != 0) return code;
  if (partial) {
    /* Older ABI: some handled accesses are not governed (e.g. truncate
     * before ABI 3). Still confined for everything the kernel supports —
     * report, do not refuse. */
    fprintf(stderr, "landlock-run: partial enforcement (older Landlock ABI)\n");
  }

  execvp(cli.command[0], cli.command);
  /* exec only returns on failure. */
  return fail("exec failed", strerror(errno));
}
