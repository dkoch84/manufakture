.PHONY: install dev test typecheck build lint

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
