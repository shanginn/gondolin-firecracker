# Build from the repository root:
#   docker build -f examples/multitenant-sim/Dockerfile -t ghcr.io/example/gondolin-user-sim:latest .

FROM rust:bookworm AS native-build
WORKDIR /native
COPY native/Cargo.toml native/Cargo.lock ./
COPY native/crates crates
RUN cargo build --locked --release -p gondolind

FROM node:24-bookworm-slim AS build

WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages packages
COPY host/package.json host/package.json
COPY examples/multitenant-sim/package.json examples/multitenant-sim/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY host host
COPY examples/multitenant-sim examples/multitenant-sim
RUN pnpm --filter @earendil-works/gondolin build
RUN pnpm --filter @earendil-works/gondolin-multitenant-sim build

FROM node:24-bookworm-slim

ARG FIRECRACKER_VERSION=v1.18.0
ARG FIRECRACKER_SHA256_X86_64=1ac8eec866dd5eea14efecf6323e22b23eea24054545338a5b34bc5bca6623cd
ARG FIRECRACKER_SHA256_AARCH64=2a6130ff0338901ff9d7fbd73ce046c6b1c6123889dc84a34d678aa53bd0c0c2

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    iproute2 \
    python3 \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) fc_arch="x86_64"; fc_sha256="$FIRECRACKER_SHA256_X86_64" ;; \
    arm64) fc_arch="aarch64"; fc_sha256="$FIRECRACKER_SHA256_AARCH64" ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  url="https://github.com/firecracker-microvm/firecracker/releases/download/${FIRECRACKER_VERSION}/firecracker-${FIRECRACKER_VERSION}-${fc_arch}.tgz"; \
  curl -fsSL "$url" -o /tmp/firecracker.tgz; \
  echo "$fc_sha256  /tmp/firecracker.tgz" | sha256sum -c -; \
  tar -xzf /tmp/firecracker.tgz -C /tmp; \
  install -m 0755 "$(find /tmp -type f -name "firecracker-${FIRECRACKER_VERSION}-${fc_arch}" | head -n 1)" /usr/local/bin/firecracker; \
  rm -rf /tmp/firecracker.tgz /tmp/release-"${FIRECRACKER_VERSION}"-"${fc_arch}"

COPY --from=build /repo /repo
COPY --from=native-build /native/target/release/gondolind /usr/local/bin/gondolind

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    GONDOLIN_NATIVE_BIN=/usr/local/bin/gondolind \
    GONDOLIN_JAILER=0 \
    GONDOLIN_FIRECRACKER=/usr/local/bin/firecracker \
    GONDOLIN_RUNTIME_DIR=/run/gondolin \
    XDG_CACHE_HOME=/cache \
    TMPDIR=/work/tmp

WORKDIR /repo/examples/multitenant-sim
EXPOSE 8080

CMD ["node", "dist/src/index.js"]
