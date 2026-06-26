#!/usr/bin/env bash
set -euo pipefail

target="${TARGET:-x86_64-linux-musl}"
out_dir="${1:-tmp/fast-agent-init}"
src="${SRC:-guest/fastinit/gondolin-init.c}"

command -v zig >/dev/null 2>&1 || {
  printf 'missing required command: zig\n' >&2
  exit 127
}

mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"
zig cc -target "$target" -Os -s -static -fno-stack-protector \
  -o "$out_dir/gondolin-init" "$src"

printf 'wrote %s/gondolin-init\n' "$out_dir"
