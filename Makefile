# Mudskipper — one entry point for every lane. `make` (or `make help`) lists targets.
SHELL := /bin/bash
.DEFAULT_GOAL := help

PYTHON ?= python3
VENV   := .venv
VPY    := $(VENV)/bin/python
RUN_ID ?= r01

.PHONY: share-run fetch-run list-runs help setup fixtures fixtures-check validate validate-full test check publish smoke clean

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

share-run: ## Share artifacts/$(RUN_ID) with the team as a GitHub Release asset (DIR=… NAME=… to override)
	$(PYTHON) platform/scripts/run_transfer.py share $(RUN_ID) $(if $(DIR),--dir $(DIR),) $(if $(NAME),--name $(NAME),)

fetch-run: ## Download a shared run into artifacts/$(RUN_ID) (checksums verified; FORCE=1 replaces)
	$(PYTHON) platform/scripts/run_transfer.py fetch $(RUN_ID) $(if $(FORCE),--force,)

list-runs: ## List runs shared as GitHub Release assets
	$(PYTHON) platform/scripts/run_transfer.py list

smoke: ## Smoke-test the deployed site and API (BASE=http://localhost:8788 for a local `npm run dev -w platform`)
	npm run smoke -w platform -- $(if $(BASE),--base $(BASE),)

clean: ## Remove the venv and Python caches (never touches data/ or artifacts/)
	rm -rf $(VENV)
	find . -name __pycache__ -type d -prune -exec rm -rf {} +

# ------------------------------------------------------------------------------------------------ geo (Karthik)
# Python via uv (geo/pyproject.toml + geo/uv.lock). Downloads and caches go to $(DATA_DIR), outputs to $(RUN_DIR).
UV         ?= uv
DATA_DIR   ?= $(CURDIR)/data
RUN_DIR    ?= $(CURDIR)/artifacts/$(RUN_ID)
FTW_METHOD ?= ftw-global
CLAIMS_OUT ?= $(RUN_DIR)/claims.sample.geojson
GEO_RUN    := cd geo && $(UV) run --frozen python
# The scripts run inside geo/, so every path handed to them is made absolute first.
GEO_ARGS    = --run-id $(RUN_ID) --run-dir $(abspath $(RUN_DIR))
GEO_DATA    = --data-dir $(abspath $(DATA_DIR))

.PHONY: geo-setup geo-ftw-setup geo-test tiles grid fields district claims basemap

geo-setup: ## geo: install the locked Python environment (geo/.venv)
	cd geo && $(UV) sync --frozen

geo-ftw-setup: ## geo: also install ftw-tools 2.0.0b5 (torch; only for FTW_METHOD=ftw-local)
	cd geo && $(UV) sync --frozen --extra ftw

geo-test: ## geo: offline unit tests (synthetic rasters and polygons)
	cd geo && $(UV) run --frozen pytest

tiles: ## geo: search the rice-dense alternative tiles -> geo/tiles.rice-dense.json (official: geo/tiles.json, K-117)
	$(GEO_RUN) tiles.py $(GEO_DATA)

grid: ## geo: aoi.json + labeled 1 ha grid fields (H+0:45 hand-off) into RUN_DIR
	$(GEO_RUN) grid.py $(GEO_ARGS) $(GEO_DATA) --copy-to $(abspath $(DATA_DIR))/geo/$(RUN_ID)/fields.grid.geojson

fields: ## geo: FTW field polygons -> fields.geojson + fields.pmtiles (FTW_METHOD=ftw-global|ftw-local)
	$(GEO_RUN) fields.py $(GEO_ARGS) $(GEO_DATA) --method $(FTW_METHOD) \
	  --report $(abspath $(DATA_DIR))/geo/$(RUN_ID)/fields.$(FTW_METHOD).report.json

district: ## geo: district_check.json from fields + field_summary.jsonl (after publish)
	$(GEO_RUN) district_check.py $(GEO_ARGS)

claims: ## geo: 60 SYNTHETIC sample claims on the run's field ids (CLAIMS_OUT=...)
	$(GEO_RUN) claims_sample.py $(GEO_ARGS) --out $(abspath $(CLAIMS_OUT))

basemap: ## geo: Protomaps extract for both tiles -> $(DATA_DIR)/basemap/punjab.pmtiles
	$(GEO_RUN) basemap.py $(GEO_DATA)
