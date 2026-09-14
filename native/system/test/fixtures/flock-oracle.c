/* Independent system flock(2) oracle; stdin commands produce flushed JSON lines. */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>

static int reply(int fd, int operation) {
  const int result = flock(fd, operation);
  const int error = result == 0 ? 0 : errno;
  if (printf("{\"errno\":%d}\n", error) < 0 || fflush(stdout) == EOF) {
    perror("flock-oracle: stdout");
    return 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  int operation = LOCK_EX;
  if (argc < 2 || argc > 3) {
    fprintf(stderr, "usage: flock-oracle <path> [exclusive|shared]\n");
    return 1;
  }
  if (argc == 3) {
    if (strcmp(argv[2], "shared") == 0) {
      operation = LOCK_SH;
    } else if (strcmp(argv[2], "exclusive") != 0) {
      fprintf(stderr, "flock-oracle: mode must be exclusive or shared\n");
      return 1;
    }
  }

  const int fd = open(argv[1], O_RDWR | O_CREAT, 0600);
  if (fd == -1) {
    perror("flock-oracle: open");
    return 1;
  }
  int status = 0;
  if (puts("{\"ready\":true}") == EOF || fflush(stdout) == EOF) {
    perror("flock-oracle: stdout");
    status = 1;
    goto cleanup;
  }

  char command[3];
  while (fgets(command, sizeof(command), stdin) != NULL) {
    if (command[1] != '\n') {
      fprintf(stderr, "flock-oracle: commands must be one letter followed by a newline\n");
      status = 1;
      break;
    }
    if (command[0] == 'q') break;
    if (command[0] != 't' && command[0] != 'u') {
      fprintf(stderr, "flock-oracle: expected t, u, or q\n");
      status = 1;
      break;
    }
    if (reply(fd, command[0] == 't' ? operation | LOCK_NB : LOCK_UN) != 0) {
      status = 1;
      break;
    }
  }
  if (ferror(stdin)) {
    perror("flock-oracle: stdin");
    status = 1;
  }

cleanup:
  if (close(fd) == -1) {
    perror("flock-oracle: close");
    status = 1;
  }
  return status;
}
