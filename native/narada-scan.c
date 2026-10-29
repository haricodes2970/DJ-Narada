#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static const char *root_path;
static const char **exclusions;
static size_t exclusion_count;
#ifdef NARADA_TEST_HELPER
static const char *test_fail_path;
static const char *test_mode;
static const char *test_replace_entry;
static const char *test_replace_target;
static const char *test_replace_file_entry;
static const char *test_replace_file_target;
static const char *test_disappear_entry;
static int test_force_read_error;
static int test_stream_error;
static const char *test_current_dir;
#endif
static dev_t root_device;

#ifdef NARADA_TEST_HELPER
static struct dirent *test_readdir(DIR *directory) {
  static int injected;
  if (!injected && test_stream_error && test_fail_path != NULL &&
      test_current_dir != NULL && strcmp(test_current_dir, test_fail_path) == 0) {
    injected = 1;
    errno = EIO;
    return NULL;
  }
  return readdir(directory);
}
#define NARADA_READDIR test_readdir
#else
#define NARADA_READDIR readdir
#endif

static void json_string(const char *value) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)value; *p; ++p) {
    switch (*p) {
      case '"': fputs("\\\"", stdout); break;
      case '\\': fputs("\\\\", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      case '\t': fputs("\\t", stdout); break;
      default:
        if (*p < 0x20) printf("\\u%04x", *p);
        else putchar(*p);
    }
  }
  putchar('"');
}

static void warning_record(const char *path, const char *code, const char *message) {
  fputs("{\"type\":\"warning\",\"path\":", stdout);
  json_string(path);
  fputs(",\"code\":", stdout);
  json_string(code);
  fputs(",\"message\":", stdout);
  json_string(message);
  fputs("}\n", stdout);
}

static int within(const char *candidate, const char *parent) {
  size_t n = strlen(parent);
  if (strncmp(candidate, parent, n) != 0) return 0;
  return candidate[n] == '\0' || candidate[n] == '/';
}

static int excluded(const char *display_path) {
  for (size_t i = 0; i < exclusion_count; ++i)
    if (within(display_path, exclusions[i])) return 1;
  return 0;
}

static int join_path(char *out, size_t size, const char *base, const char *name) {
  int written = snprintf(out, size, "%s/%s", base, name);
  return written >= 0 && (size_t)written < size;
}

static int join_relative(char *out, size_t size, const char *relative, const char *name) {
  if (relative[0] == '\0') return snprintf(out, size, "%s", name) < (int)size;
  return snprintf(out, size, "%s/%s", relative, name) < (int)size;
}

static void scan_dir(int parent_fd, const char *relative, const char *display_dir) {
#ifdef NARADA_TEST_HELPER
  if (test_fail_path != NULL && !test_stream_error && strcmp(display_dir, test_fail_path) == 0) {
    warning_record(display_dir, "READDIR_FAILED", "Injected test failure");
    return;
  }
#endif
  int dup_fd = dup(parent_fd);
  if (dup_fd < 0) {
    warning_record(display_dir, "DUP_FAILED", strerror(errno));
    return;
  }
#ifdef NARADA_TEST_HELPER
  test_current_dir = display_dir;
#endif
  DIR *dir = fdopendir(dup_fd);
  if (!dir) {
    close(dup_fd);
    warning_record(display_dir, "READDIR_FAILED", strerror(errno));
    return;
  }

  struct dirent *entry;
  for (;;) {
    errno = 0;
    entry = NARADA_READDIR(dir);
    if (entry == NULL) break;
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    char child_rel[PATH_MAX], child_display[PATH_MAX];
    if (!join_relative(child_rel, sizeof child_rel, relative, entry->d_name) ||
        !join_path(child_display, sizeof child_display, root_path, child_rel)) {
      warning_record(display_dir, "PATH_TOO_LONG", "Entry path exceeds PATH_MAX");
      continue;
    }
    struct stat st;
    if (fstatat(parent_fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
      warning_record(child_display, "LSTAT_FAILED", strerror(errno));
      continue;
    }
#ifdef NARADA_TEST_HELPER
    if (test_mode != NULL && strcmp(test_mode, "--test-disappear") == 0 &&
        test_disappear_entry != NULL && strcmp(child_display, test_disappear_entry) == 0) {
      if (S_ISDIR(st.st_mode)) {
        char backup[PATH_MAX];
        size_t display_len = strlen(child_display);
        if (display_len + 12 < sizeof backup) {
          memcpy(backup, child_display, display_len);
          memcpy(backup + display_len, ".test-backup", 13);
          rename(child_display, backup);
        }
      } else unlink(child_display);
      if (fstatat(parent_fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
        warning_record(child_display, "LSTAT_FAILED", strerror(errno));
        continue;
      }
    }
#endif
    if (S_ISLNK(st.st_mode)) {
      warning_record(child_display, "SYMLINK_SKIPPED", "Symbolic link skipped");
      continue;
    }
    if (S_ISDIR(st.st_mode)) {
#ifdef NARADA_TEST_HELPER
      if (test_mode != NULL && strcmp(test_mode, "--test-replace-dir") == 0 &&
          test_replace_entry != NULL && strcmp(child_display, test_replace_entry) == 0) {
        char backup[PATH_MAX];
        size_t display_len = strlen(child_display);
        if (display_len + 12 < sizeof backup) {
          memcpy(backup, child_display, display_len);
          memcpy(backup + display_len, ".test-backup", 13);
          if (rename(child_display, backup) == 0) symlink(test_replace_target, child_display);
        }
      }
#endif
      if (excluded(child_display)) continue;
      int child_fd = openat(parent_fd, entry->d_name,
                            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
      if (child_fd < 0) {
        warning_record(child_display, "OPEN_FAILED", strerror(errno));
        continue;
      }
      struct stat opened;
      if (fstat(child_fd, &opened) != 0 || !S_ISDIR(opened.st_mode) || opened.st_dev != root_device) {
        warning_record(child_display, "FSTAT_FAILED", "Opened entry is not a directory");
        close(child_fd);
        continue;
      }
      scan_dir(child_fd, child_rel, child_display);
      close(child_fd);
      continue;
    }
    if (!S_ISREG(st.st_mode) || excluded(child_display)) continue;
#ifdef NARADA_TEST_HELPER
    if (test_mode != NULL && strcmp(test_mode, "--test-replace-file") == 0 &&
        test_replace_file_entry != NULL && strcmp(child_display, test_replace_file_entry) == 0) {
      char backup[PATH_MAX];
      size_t display_len = strlen(child_display);
      if (display_len + 12 < sizeof backup) {
        memcpy(backup, child_display, display_len);
        memcpy(backup + display_len, ".test-backup", 13);
        if (rename(child_display, backup) == 0) symlink(test_replace_file_target, child_display);
      }
    }
#endif
    int file_fd = openat(parent_fd, entry->d_name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (file_fd < 0) {
      warning_record(child_display, "OPEN_FAILED", strerror(errno));
      continue;
    }
    struct stat opened;
    int valid = fstat(file_fd, &opened) == 0 && S_ISREG(opened.st_mode);
    close(file_fd);
    if (!valid) {
      warning_record(child_display, "FSTAT_FAILED", "Opened entry is not a regular file");
      continue;
    }
    fputs("{\"type\":\"file\",\"path\":", stdout);
    json_string(child_display);
    fputs("}\n", stdout);
  }
  if (errno != 0) warning_record(display_dir, "READDIR_FAILED", strerror(errno));
  closedir(dir);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: narada-scan ROOT [EXCLUSION ...]\n");
    return 2;
  }
  root_path = argv[1];
#ifdef NARADA_TEST_HELPER
  if (argc >= 3 && strncmp(argv[2], "--test-", 7) == 0) {
    test_mode = argv[2];
    if (strcmp(test_mode, "--test-replace-dir") == 0 && argc >= 5) {
      test_replace_entry = argv[3];
      test_replace_target = argv[4];
    }
    if (strcmp(test_mode, "--test-replace-file") == 0 && argc >= 5) {
      test_replace_file_entry = argv[3];
      test_replace_file_target = argv[4];
    }
    if ((strcmp(test_mode, "--test-disappear") == 0 || strcmp(test_mode, "--test-stream-error") == 0) && argc >= 4)
      test_disappear_entry = argv[3];
    if (strcmp(test_mode, "--test-stream-error") == 0) {
      test_stream_error = 1;
      test_fail_path = argv[3];
    }
  }
  if (argc >= 4 && strcmp(argv[2], "--test-fail-readdir") == 0) {
    test_fail_path = argv[3];
    test_force_read_error = 1;
    exclusions = (const char **)&argv[4];
    exclusion_count = (size_t)(argc - 4);
  } else if (argc >= 5 && (strcmp(argv[2], "--test-replace-dir") == 0 || strcmp(argv[2], "--test-replace-file") == 0)) {
    exclusions = (const char **)&argv[5];
    exclusion_count = (size_t)(argc - 5);
  } else if (argc >= 4 && (strcmp(argv[2], "--test-disappear") == 0 || strcmp(argv[2], "--test-stream-error") == 0)) {
    exclusions = (const char **)&argv[4];
    exclusion_count = (size_t)(argc - 4);
  } else {
    exclusions = (const char **)&argv[2];
    exclusion_count = (size_t)(argc - 2);
  }
#else
  exclusions = (const char **)&argv[2];
  exclusion_count = (size_t)(argc - 2);
#endif
  int root_fd = open(root_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (root_fd < 0) {
    warning_record(root_path, "ROOT_OPEN_FAILED", strerror(errno));
    return 3;
  }
#ifdef NARADA_TEST_HELPER
  if (test_mode != NULL && strcmp(test_mode, "--test-malformed") == 0) {
    fputs("not-json\n", stdout);
    close(root_fd);
    return 0;
  }
  if (test_mode != NULL && strcmp(test_mode, "--test-oversized") == 0) {
    for (int i = 0; i < 1100000; ++i) putchar('x');
    putchar('\n');
    close(root_fd);
    return 0;
  }
#endif
  struct stat root_stat;
  if (fstat(root_fd, &root_stat) != 0 || !S_ISDIR(root_stat.st_mode)) {
    warning_record(root_path, "ROOT_FSTAT_FAILED", "Root is not a directory");
    close(root_fd);
    return 3;
  }
  root_device = root_stat.st_dev;
  if (excluded(root_path)) {
    warning_record(root_path, "ROOT_EXCLUDED", "Scan root is inside an excluded path");
    close(root_fd);
    return 0;
  }
  scan_dir(root_fd, "", root_path);
  close(root_fd);
  return ferror(stdout) ? 4 : 0;
}
