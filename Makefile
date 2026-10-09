.PHONY: help build test diagrams

help:
	@echo "build     Build the Obsidian plugin and Rust server"
	@echo "test      Run plugin tests, plugin build, and Rust tests"
	@echo "diagrams  Render architecture SVGs locally (Node.js and npm required)"

build:
	npm run build

test:
	npm test

diagrams:
	npm ci --prefix docs/architecture --ignore-scripts --no-audit --no-fund
	node docs/architecture/render-diagrams.mjs
