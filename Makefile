.PHONY: test deploy logs-prod

## test: the gates (see docs/development.md): Go vet/gofmt/race tests, then Deno check, lint and tests
test:
	deno task build
	cd src/backend && go vet ./... && test -z "$$(gofmt -l .)" && go test -race ./...
	deno task check
	deno lint src/frontend/scripts
	deno task test

# The gem's bin dir is not on PATH everywhere; override with `make deploy KAMAL=/path/to/kamal`.
KAMAL ?= kamal

## deploy: test, then `kamal deploy` (build, push to ghcr.io, swap in on home-docker)
deploy: test
	@# Kamal builds from HEAD, not the working tree, so refuse edits the tests just ran against.
	@git diff --quiet HEAD -- || { echo "deploy: tracked files have uncommitted changes; commit first so the tag names what runs" >&2; exit 1; }
	$(KAMAL) deploy

## logs-prod: follow the production app's logs
logs-prod:
	$(KAMAL) app logs -f
