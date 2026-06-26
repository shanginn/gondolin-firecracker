#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static char sandboxfs_mount[256] = "/data";
static char sandboxfs_binds[2048] = "";
static char gondolin_transport[32] = "vsock";
static char gondolin_net[16] = "on";
static char vsock_control_port[16] = "1024";
static char vsock_fs_port[16] = "1025";

static void log_line(const char *fmt, ...) {
  char buf[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);

  int fd = open("/dev/console", O_WRONLY | O_CLOEXEC);
  if (fd < 0) fd = STDERR_FILENO;
  dprintf(fd, "%s\n", buf);
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
    log_line("[init] mount %s failed: %s", target, strerror(errno));
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
  if (!value) return;
  snprintf(dst, dst_len, "%s", value);
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

static bool proc_mount_has(const char *target) {
  FILE *fp = fopen("/proc/mounts", "re");
  if (!fp) return false;
  char line[1024];
  bool found = false;
  while (fgets(line, sizeof(line), fp)) {
    char src[256], dst[256], type[128];
    if (sscanf(line, "%255s %255s %127s", src, dst, type) == 3 &&
        strcmp(dst, target) == 0) {
      found = true;
      break;
    }
  }
  fclose(fp);
  return found;
}

static bool wait_for_mount(const char *target) {
  for (int i = 0; i < 300; i++) {
    if (proc_mount_has(target)) return true;
    usleep(100000);
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

static void setup_network(void) {
  char *lo[] = {"ip", "link", "set", "lo", "up", NULL};
  run_wait(lo);
  if (strcmp(gondolin_net, "off") == 0) return;

  char *eth[] = {"ip", "link", "set", "eth0", "up", NULL};
  run_wait(eth);
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
  snprintf(buf, sizeof(buf), "%s", sandboxfs_binds);
  for (char *bind = strtok(buf, ","); bind; bind = strtok(NULL, ",")) {
    if (bind[0] != '/') continue;
    char source[512];
    if (strcmp(sandboxfs_mount, "/") == 0) {
      snprintf(source, sizeof(source), "%s", bind);
    } else {
      snprintf(source, sizeof(source), "%s%s", sandboxfs_mount, bind);
    }
    mkdir_p(bind, 0755);
    if (mount(source, bind, NULL, MS_BIND, NULL) != 0) {
      log_line("[init] bind %s failed: %s", bind, strerror(errno));
    }
  }
}

static bool start_sandboxfs(void) {
  mkdir_p(sandboxfs_mount, 0755);
  if (!executable("/usr/bin/sandboxfs")) {
    write_file("/run/sandboxfs.failed", "sandboxfs binary missing\n", 0644);
    return false;
  }

  log_line("[init] starting sandboxfs");
  char *argv[] = {
      "/usr/bin/sandboxfs",
      "--mount",
      sandboxfs_mount,
      "--rpc-vsock-port",
      vsock_fs_port,
      NULL};
  spawn_console(argv);

  if (!wait_for_mount(sandboxfs_mount)) {
    write_file("/run/sandboxfs.failed", "sandboxfs mount not ready\n", 0644);
    return false;
  }

  bind_sandboxfs();
  write_file("/run/sandboxfs.ready", "ok\n", 0644);
  return true;
}

int main(void) {
  parse_cmdline();
  setup_mounts();
  setup_env();
  setup_network();
  start_sandboxfs();

  log_line("[init] starting sandboxd");
  if (strcmp(gondolin_transport, "vsock") == 0) {
    char *argv[] = {
        "/usr/bin/sandboxd", "--vsock-port", vsock_control_port, NULL};
    execv(argv[0], argv);
  } else {
    char *argv[] = {"/usr/bin/sandboxd", NULL};
    execv(argv[0], argv);
  }

  log_line("[init] sandboxd exec failed: %s", strerror(errno));
  char *sh[] = {"/bin/sh", NULL};
  execv(sh[0], sh);
  for (;;) pause();
}
