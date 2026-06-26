#!/usr/bin/env bash
set -euo pipefail

version="${KERNEL_VERSION:-6.1.142}"
jobs="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1')}"
cache_dir="${KERNEL_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/gondolin/kernel}"
out_dir="${1:-tmp/firecracker-tiny-kernel}"
src_dir="${cache_dir}/linux-${version}"
tarball="${cache_dir}/linux-${version}.tar.xz"
url="https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${version}.tar.xz"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 127
  }
}

for cmd in bc bison curl flex gcc make openssl tar xz; do
  need "$cmd"
done

mkdir -p "$cache_dir" "$out_dir"

if [ ! -d "$src_dir" ]; then
  if [ ! -f "$tarball" ]; then
    curl -L --fail -o "$tarball" "$url"
  fi
  tar -C "$cache_dir" -xf "$tarball"
fi

build_dir="${out_dir}/build"
rm -rf "$build_dir"
mkdir -p "$build_dir"

make -s -C "$src_dir" O="$build_dir" tinyconfig

config() {
  "$src_dir/scripts/config" --file "$build_dir/.config" "$@"
}

config --set-str LOCALVERSION "-gondolin-tiny"
config -e 64BIT -e X86_64 -e EXPERT -e EMBEDDED -e CC_OPTIMIZE_FOR_SIZE
config -e HYPERVISOR_GUEST -e PARAVIRT -e KVM_GUEST -e PVH -e PARAVIRT_CLOCK
config -e BINFMT_ELF -e BINFMT_SCRIPT
config -e DEVTMPFS -e DEVTMPFS_MOUNT -e TMPFS -e PROC_FS -e PROC_SYSCTL
config -e SYSFS -e DEVPTS_FS
config -e BLOCK -e BLK_DEV -e EXT4_FS -e JBD2 -e FS_MBCACHE -e FUSE_FS
config -e TTY -e UNIX98_PTYS -e SERIAL_8250 -e SERIAL_8250_CONSOLE
config -e NET -e UNIX -e INET -e PACKET -e NETDEVICES -e ETHERNET
config -e VIRTIO -e VIRTIO_MENU -e VIRTIO_PCI -e VIRTIO_PCI_LEGACY
config -e VIRTIO_MMIO -e VIRTIO_BLK -e VIRTIO_NET
config -e VSOCKETS -e VIRTIO_VSOCKETS -e VIRTIO_VSOCKETS_COMMON
config -e HW_RANDOM -e HW_RANDOM_VIRTIO
config -e PCI -e PCI_MSI -e ACPI
config -e EPOLL -e SIGNALFD -e TIMERFD -e EVENTFD -e ANON_INODES -e SHMEM
config -e CRC32 -e CRC32_SLICEBY8 -e CRC32C -e CRYPTO -e CRYPTO_CRC32C
config -e CRYPTO_HASH

config -d MODULES -d IPV6 -d NETFILTER -d WIRELESS -d WLAN -d INPUT
config -d SOUND -d DRM -d MEDIA_SUPPORT
config -d DEBUG_INFO -d DEBUG_INFO_DWARF_TOOLCHAIN_DEFAULT -d DEBUG_INFO_BTF
config -d DEBUG_KERNEL -d FTRACE -d FUNCTION_TRACER -d KPROBES
config -d PERF_EVENTS -d AUDIT -d KALLSYMS -d IKCONFIG
config -d BPF_SYSCALL -d CGROUPS -d NAMESPACES -d SWAP -d HIBERNATION
config -d PM -d SUSPEND

make -s -C "$src_dir" O="$build_dir" olddefconfig
make -s -C "$src_dir" O="$build_dir" -j"$jobs" vmlinux

cp "$build_dir/vmlinux" "$out_dir/firecracker-kernel"
cp "$build_dir/.config" "$out_dir/firecracker-kernel.config"

printf 'wrote %s/firecracker-kernel\n' "$out_dir"
printf 'set firecrackerKernelPath to %s/firecracker-kernel\n' "$out_dir"
printf 'set firecrackerInitrdPath to null\n'
