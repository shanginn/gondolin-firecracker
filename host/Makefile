.PHONY: build typecheck lint test format clean fuzz

PNPM ?= pnpm
NODE ?= node
TSC ?= ./node_modules/.bin/tsc
TSC_BUILD_INFO ?= ../.cache/host-typecheck.tsbuildinfo
RUN_PARALLEL ?= ../scripts/run-parallel
PRETTIER ?= ../node_modules/.bin/prettier

# Host fuzzer target name (see host/fuzz/targets)
TARGET ?= virtio

build:
	@$(PNPM) run build

typecheck:
	@mkdir -p $(dir $(TSC_BUILD_INFO))
	@$(TSC) -p tsconfig.json --noEmit --incremental --tsBuildInfoFile $(TSC_BUILD_INFO)

lint: typecheck

format:
	@$(PRETTIER) --write --ignore-unknown --no-error-on-unmatched-pattern \
		"src/**/*.ts" \
		"bin/**/*.ts" \
		"test/**/*.ts" \
		"fuzz/**/*.ts" \
		"examples/**/*.ts" \
		"package.json" \
		"tsconfig.json" \
		"README.md"

test:
	@$(RUN_PARALLEL) -j 1 \
		"host:test" "$(NODE) --test test/*.test.ts"

fuzz:
	@$(PNPM) run fuzz -- $(TARGET)

clean:
	@rm -rf dist $(TSC_BUILD_INFO)
