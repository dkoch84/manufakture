.PHONY: install dev test typecheck build lint licenses bench-house bench-memory mcp

# `make -C <checkout> mcp` must not print "Entering directory" on stdout: it carries the protocol.
MAKEFLAGS += --no-print-directory

install:
	pnpm install

dev:
	pnpm dev

test:
	pnpm test

typecheck:
	pnpm typecheck

build:
	pnpm build

lint:
	pnpm lint

# The MCP server for agents, over stdio (apps/mcp; docs/user/agents.md). Configured from the
# environment (MANUFAKTURE_LIBRARY, MANUFAKTURE_OUTPUT). Silent: stdout carries the protocol.
mcp:
	@pnpm --silent --filter @manufakture/mcp start

# Every shipped dependency's license against ADR 0006's allowlist (tools/licenses); offline.
licenses:
	pnpm licenses:check

# The T6.5d house bench (packages/domain-construction/bench): regen of a 2,000 sq ft house
# against the T6.5a budgets. Takes about a minute; not part of `test`.
bench-house:
	pnpm --filter @manufakture/domain-construction bench

# The kernel memory bench (apps/web/bench): wasm heap left behind per regen of each acceptance
# model, against the recycle threshold (docs/research/end-of-m1-checkpoints.md). A few minutes.
bench-memory:
	pnpm --filter @manufakture/web bench:memory
