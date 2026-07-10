#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/statfs.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef FUSE_SUPER_MAGIC
#define FUSE_SUPER_MAGIC 0x65735546
#endif

#define MOUNT_POLL_INTERVAL_US 10000
#define MOUNT_POLL_ATTEMPTS (30 * 1000000 / MOUNT_POLL_INTERVAL_US)

static char sandboxfs_mount[256] = "/data";
static char sandboxfs_binds[2048] = "";
static char gondolin_transport[32] = "vsock";
static char gondolin_net[16] = "on";
static char vsock_control_port[16] = "1024";
static char vsock_fs_port[16] = "1025";
static bool gondolin_debug = false;

static void write_all(int fd, const char *buf, size_t len) {
  while (len > 0) {
    ssize_t written = write(fd, buf, len);
    if (written > 0) {
      buf += written;
      len -= (size_t)written;
      continue;
    }
    if (written < 0 && errno == EINTR) continue;
    break;
  }
}

static int open_console(void) {
  int fd = open("/dev/console", O_WRONLY | O_CLOEXEC);
  if (fd < 0) fd = STDERR_FILENO;
  return fd;
}

static void log_line(const char *message) {
  int fd = open_console();
  write_all(fd, message, strlen(message));
  write_all(fd, "\n", 1);
  if (fd != STDERR_FILENO) close(fd);
}

static void log_debug(const char *message) {
  if (gondolin_debug) log_line(message);
}

static void log_failure(
    const char *operation, const char *target, int error_number) {
  int fd = open_console();
  write_all(fd, "[init] ", 7);
  write_all(fd, operation, strlen(operation));
  write_all(fd, " ", 1);
  write_all(fd, target, strlen(target));
  write_all(fd, " failed: ", 9);
  const char *message = strerror(error_number);
  write_all(fd, message, strlen(message));
  write_all(fd, "\n", 1);
  if (fd != STDERR_FILENO) close(fd);
}

static void mkdir_p(const char *path, mode_t mode) {
  char tmp[512];
  size_t len = strlen(path);
  if (len == 0 || len >= sizeof(tmp)) return;
  memcpy(tmp, path, len + 1);
  for (char *p = tmp + 1; *p; p++) {
    if (*p != '/') continue;
    *p = 0;
    mkdir(tmp, mode);
    *p = '/';
  }
  mkdir(tmp, mode);
}

static void mkdir_parent(const char *path, mode_t mode) {
  char tmp[512];
  size_t len = strlen(path);
  if (len == 0 || len >= sizeof(tmp)) return;
  memcpy(tmp, path, len + 1);
  char *slash = strrchr(tmp, '/');
  if (!slash || slash == tmp) {
    mkdir("/", 0755);
    return;
  }
  *slash = 0;
  mkdir_p(tmp, mode);
}

static void mount_try(
    const char *src,
    const char *target,
    const char *fstype,
    unsigned long flags,
    const char *data) {
  mkdir_p(target, 0755);
  if (mount(src, target, fstype, flags, data) != 0 && errno != EBUSY) {
    log_failure("mount", target, errno);
  }
}

static bool exists(const char *path) {
  return access(path, F_OK) == 0;
}

static bool executable(const char *path) {
  return access(path, X_OK) == 0;
}

static int run_wait(char *const argv[]) {
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    execvp(argv[0], argv);
    _exit(127);
  }
  int status = 0;
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
  return status;
}

static pid_t spawn_console(char *const argv[]) {
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    int fd = open("/dev/console", O_WRONLY | O_CLOEXEC);
    if (fd < 0) fd = open("/dev/null", O_WRONLY | O_CLOEXEC);
    if (fd >= 0) {
      dup2(fd, STDOUT_FILENO);
      dup2(fd, STDERR_FILENO);
      if (fd > STDERR_FILENO) close(fd);
    }
    execvp(argv[0], argv);
    _exit(127);
  }
  return pid;
}

static void set_value(char *dst, size_t dst_len, const char *value) {
  if (!value || dst_len == 0) return;
  size_t len = strnlen(value, dst_len - 1);
  memcpy(dst, value, len);
  dst[len] = 0;
}

static bool join_values(
    char *dst, size_t dst_len, const char *left, const char *right) {
  size_t left_len = strlen(left);
  size_t right_len = strlen(right);
  if (left_len + right_len >= dst_len) return false;
  memcpy(dst, left, left_len);
  memcpy(dst + left_len, right, right_len + 1);
  return true;
}

static void parse_cmdline(void) {
  char buf[4096] = "";
  int fd = open("/proc/cmdline", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return;
  ssize_t n = read(fd, buf, sizeof(buf) - 1);
  close(fd);
  if (n <= 0) return;
  buf[n] = 0;

  for (char *tok = strtok(buf, " \n"); tok; tok = strtok(NULL, " \n")) {
    if (strncmp(tok, "gondolin.transport=", 19) == 0) {
      set_value(gondolin_transport, sizeof(gondolin_transport), tok + 19);
    } else if (strncmp(tok, "gondolin.net=", 13) == 0) {
      set_value(gondolin_net, sizeof(gondolin_net), tok + 13);
    } else if (strncmp(tok, "gondolin.debug=", 15) == 0) {
      gondolin_debug = strcmp(tok + 15, "1") == 0;
    } else if (strncmp(tok, "gondolin.vsock.control=", 23) == 0) {
      set_value(vsock_control_port, sizeof(vsock_control_port), tok + 23);
    } else if (strncmp(tok, "gondolin.vsock.fs=", 18) == 0) {
      set_value(vsock_fs_port, sizeof(vsock_fs_port), tok + 18);
    } else if (strncmp(tok, "sandboxfs.mount=", 16) == 0) {
      set_value(sandboxfs_mount, sizeof(sandboxfs_mount), tok + 16);
    } else if (strncmp(tok, "sandboxfs.bind=", 15) == 0) {
      set_value(sandboxfs_binds, sizeof(sandboxfs_binds), tok + 15);
    }
  }
}

static bool fuse_mounted(const char *target) {
  struct statfs fs;
  return statfs(target, &fs) == 0 &&
         (unsigned long)fs.f_type == FUSE_SUPER_MAGIC;
}

static bool wait_for_mount(const char *target) {
  for (int i = 0; i < MOUNT_POLL_ATTEMPTS; i++) {
    if (fuse_mounted(target)) return true;
    usleep(MOUNT_POLL_INTERVAL_US);
  }
  return false;
}

static void write_file(const char *path, const char *content, mode_t mode) {
  mkdir_parent(path, 0755);
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, mode);
  if (fd < 0) return;
  write(fd, content, strlen(content));
  close(fd);
}

static void setup_mounts(void) {
  mount_try("proc", "/proc", "proc", 0, "");
  mount_try("sysfs", "/sys", "sysfs", 0, "");
  mount_try("devtmpfs", "/dev", "devtmpfs", 0, "");
  mount_try("devpts", "/dev/pts", "devpts", 0, "");
  mount_try("tmpfs", "/run", "tmpfs", 0, "");
  mount_try("tmpfs", "/tmp", "tmpfs", 0, "");
  mount_try("tmpfs", "/root", "tmpfs", 0, "");
  mount_try("tmpfs", "/var/tmp", "tmpfs", 0, "");
  mount_try("tmpfs", "/var/cache", "tmpfs", 0, "");
  mount_try("tmpfs", "/var/log", "tmpfs", 0, "");
  mkdir_p("/tmp/.cache", 0755);
  mkdir_p("/tmp/.config", 0755);
  mkdir_p("/tmp/.local/share", 0755);
  chmod("/root", 0700);
}

static void setup_env(void) {
  setenv("PATH", "/usr/sbin:/usr/bin:/sbin:/bin", 1);
  setenv("HOME", "/root", 1);
  setenv("TMPDIR", "/tmp", 1);
  setenv("XDG_CACHE_HOME", "/tmp/.cache", 1);
  setenv("XDG_CONFIG_HOME", "/tmp/.config", 1);
  setenv("XDG_DATA_HOME", "/tmp/.local/share", 1);
  setenv("UV_CACHE_DIR", "/tmp/.cache/uv", 1);
  setenv("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt", 1);
  setenv("UV_SYSTEM_CERTS", "true", 1);
}

static void set_interface_up(const char *name) {
  int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return;

  struct ifreq request;
  memset(&request, 0, sizeof(request));
  set_value(request.ifr_name, sizeof(request.ifr_name), name);
  if (ioctl(fd, SIOCGIFFLAGS, &request) == 0) {
    request.ifr_flags |= IFF_UP;
    ioctl(fd, SIOCSIFFLAGS, &request);
  }
  close(fd);
}

static void setup_network(void) {
  set_interface_up("lo");
  if (strcmp(gondolin_net, "off") == 0) return;

  set_interface_up("eth0");
  if (executable("/sbin/udhcpc") || executable("/usr/bin/udhcpc")) {
    if (executable("/usr/share/udhcpc/default.script")) {
      char *dhcp[] = {"udhcpc", "-i", "eth0", "-q", "-n", "-s",
                      "/usr/share/udhcpc/default.script", NULL};
      run_wait(dhcp);
    } else if (executable("/sbin/udhcpc.script")) {
      char *dhcp[] = {
          "udhcpc", "-i", "eth0", "-q", "-n", "-s", "/sbin/udhcpc.script",
          NULL};
      run_wait(dhcp);
    } else {
      char *dhcp[] = {"udhcpc", "-i", "eth0", "-q", "-n", NULL};
      run_wait(dhcp);
    }
  }
  if (!exists("/etc/resolv.conf")) {
    write_file("/etc/resolv.conf", "nameserver 192.168.127.1\n", 0644);
  }
}

static void bind_sandboxfs(void) {
  if (sandboxfs_binds[0] == 0) return;

  char buf[sizeof(sandboxfs_binds)];
  set_value(buf, sizeof(buf), sandboxfs_binds);
  for (char *bind = strtok(buf, ","); bind; bind = strtok(NULL, ",")) {
    if (bind[0] != '/') continue;
    char source[512];
    if (strcmp(sandboxfs_mount, "/") == 0) {
      set_value(source, sizeof(source), bind);
    } else {
      if (!join_values(source, sizeof(source), sandboxfs_mount, bind)) {
        log_failure("bind", bind, ENAMETOOLONG);
        continue;
      }
    }
    mkdir_p(bind, 0755);
    if (mount(source, bind, NULL, MS_BIND, NULL) != 0) {
      log_failure("bind", bind, errno);
    }
  }
}

static bool spawn_sandboxfs(void) {
  mkdir_p(sandboxfs_mount, 0755);
  if (!executable("/usr/bin/sandboxfs")) {
    write_file("/run/sandboxfs.failed", "sandboxfs binary missing\n", 0644);
    return false;
  }

  log_debug("[init] starting sandboxfs");
  char *argv[] = {
      "/usr/bin/sandboxfs",
      "--mount",
      sandboxfs_mount,
      "--rpc-vsock-port",
      vsock_fs_port,
      NULL};
  if (spawn_console(argv) < 0) {
    write_file("/run/sandboxfs.failed", "sandboxfs spawn failed\n", 0644);
    return false;
  }
  return true;
}

static void finish_sandboxfs(void) {
  if (!wait_for_mount(sandboxfs_mount)) {
    write_file("/run/sandboxfs.failed", "sandboxfs mount not ready\n", 0644);
    return;
  }

  bind_sandboxfs();
  write_file("/run/sandboxfs.ready", "ok\n", 0644);
}

int main(void) {
  setup_mounts();
  parse_cmdline();
  setup_env();
  bool sandboxfs_started = spawn_sandboxfs();
  setup_network();
  if (sandboxfs_started) finish_sandboxfs();

  log_debug("[init] starting sandboxd");
  if (strcmp(gondolin_transport, "vsock") == 0) {
    char *argv[] = {
        "/usr/bin/sandboxd", "--vsock-port", vsock_control_port, NULL};
    execv(argv[0], argv);
  } else {
    char *argv[] = {"/usr/bin/sandboxd", NULL};
    execv(argv[0], argv);
  }

  log_failure("exec", "/usr/bin/sandboxd", errno);
  char *sh[] = {"/bin/sh", NULL};
  execv(sh[0], sh);
  for (;;) pause();
}
