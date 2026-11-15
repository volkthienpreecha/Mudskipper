# Mudskipper — one entry point for every lane. `make` (or `make help`) lists targets.
SHELL := /bin/bash
.DEFAULT_GOAL := help

PYTHON ?= python3
VENV   := .venv
VPY    := $(VENV)/bin/python
RUN_ID ?= r01

.PHONY: help setup fixtures fixtures-check validate validate-full test check publish smoke clean

help: ## List targets
	@awk 'BEGIN {FS = ":.*## "; printf "Mudskipper make targets\n\n"} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf "\nVariables: RUN_ID=$(RUN_ID) (e.g. make publish RUN_ID=r02), PYTHON=$(PYTHON)\n"

$(VENV)/.ready: contracts/requirements.txt
	$(PYTHON) -m venv $(VENV)
	$(VPY) -m pip install --quiet --disable-pip-version-check -r contracts/requirements.txt
	@touch $@

setup: $(VENV)/.ready ## Create .venv with the validator's one dependency (jsonschema)

fixtures: ## Regenerate contracts/fixtures (stdlib only, deterministic)
	$(PYTHON) contracts/make_fixtures.py

fixtures-check: ## Fail if committed fixtures differ from a fresh build (T2 for fixtures)
	$(PYTHON) contracts/make_fixtures.py --check

validate: $(VENV)/.ready ## Validate fixtures and every artifacts/<run_id>/ (T1)
	$(VPY) contracts/validate.py

validate-full: $(VENV)/.ready ## validate + rerun the reference simulation and compare core's numbers exactly
	$(VPY) contracts/validate.py --recompute

test: $(VENV)/.ready ## Run the contract test suite (schemas, rules, validator)
	$(VPY) -m unittest discover -s contracts/tests

check: test validate fixtures-check ## Everything CI runs for contracts

publish: $(VENV)/.ready ## Publish artifacts/$(RUN_ID) to https://mudskipper-nisar.pages.dev (FIXTURES=1: the sample set; ARGS=--dry-run)
	npm run publish -w platform -- $(if $(FIXTURES),--fixtures,--run $(RUN_ID)) $(ARGS)

smoke: ## Smoke-test the deployed site and API (BASE=http://localhost:8788 for a local `npm run dev -w platform`)
	npm run smoke -w platform -- $(if $(BASE),--base $(BASE),)

clean: ## Remove the venv and Python caches (never touches data/ or artifacts/)
	rm -rf $(VENV)
	find . -name __pycache__ -type d -prune -exec rm -rf {} +
