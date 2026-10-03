.PHONY: install dev test typecheck build lint bench-house

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

# The T6.5d house bench (packages/domain-construction/bench): regen of a 2,000 sq ft house
# against the T6.5a budgets. Takes about a minute; not part of `test`.
bench-house:
	pnpm --filter @manufakture/domain-construction bench
