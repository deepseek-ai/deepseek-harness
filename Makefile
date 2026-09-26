# Short names for the Web and Desktop application commands. The package.json
# scripts they call stay the source of truth; docs/development.md documents both.
.DEFAULT_GOAL := help
.PHONY: help build web desktop dev-web dev-desktop

PNPM ?= pnpm
ARGS ?=

help:
	@echo "make build        pnpm run build           complete repository build"
	@echo "make web          pnpm run start:web       serve the built Web artifacts from source"
	@echo "make desktop      pnpm run start:desktop   launch the built Desktop artifacts"
	@echo "make dev-web      pnpm run dev:web         build, serve, and rebuild Web on source edits"
	@echo "make dev-desktop  pnpm run dev:desktop     build, then launch Desktop"
	@echo "ARGS='--no-open --port 3081' forwards options to the launched application;"
	@echo "the Web commands accept dsh web flags, the Desktop launcher accepts none."

build:
	$(PNPM) run build

web:
	$(PNPM) run start:web $(ARGS)

desktop:
	$(PNPM) run start:desktop $(ARGS)

dev-web:
	$(PNPM) run dev:web $(ARGS)

dev-desktop:
	$(PNPM) run dev:desktop $(ARGS)
