// Preserve a command symlink's inode while refusing an occupied destination.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int count, char **arguments) {
  if (count != 3 || arguments[1][0] != '/' || arguments[2][0] != '/') {
    fprintf(stderr, "Command entry paths must be absolute.\n");
    return 1;
  }
  if (linkat(AT_FDCWD, arguments[1], AT_FDCWD, arguments[2], 0) != 0) {
    fprintf(stderr, "Cannot link command entry: %s\n", strerror(errno));
    return 1;
  }
  return 0;
}
