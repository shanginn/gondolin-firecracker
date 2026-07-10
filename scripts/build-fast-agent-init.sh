#!/usr/bin/env bash
set -euo pipefail

target="${TARGET:-x86_64-linux-musl}"
out_dir="${1:-tmp/fast-agent-init}"
src="${SRC:-guest/fastinit/gondolin-init.c}"
zig="${ZIG:-zig}"

command -v "$zig" >/dev/null 2>&1 || {
  printf 'missing required command: %s\n' "$zig" >&2
  exit 127
}

mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"
"$zig" cc -target "$target" -Oz -s -static -fno-stack-protector \
  -Wall -Wextra -Werror \
  -ffunction-sections -fdata-sections \
  -fno-asynchronous-unwind-tables -fno-unwind-tables -fno-ident \
  -Wl,--gc-sections -Wl,--build-id=none \
  -o "$out_dir/gondolin-init" "$src"

printf 'wrote %s/gondolin-init\n' "$out_dir"
