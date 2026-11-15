-- Migration number: 0001 	 SPEC B4 schema for the Mudskipper D1 database (binding DB, database "mudskipper").
--
-- Deviations from SPEC B4, all additive (CONTRACTS.md B4 lets platform add the columns the API needs; each is
-- logged in DECISIONS.md K-304):
--   * Every run table has run_id in a composite PRIMARY KEY, so several runs coexist and live.json picks one.
--     B4 lists `field_id PK` etc.; with one run loaded the rows are the same.
--   * Every table is WITHOUT ROWID and STRICT. WITHOUT ROWID stores rows in the primary-key b-tree, so a row
--     write is one b-tree write instead of two (rowid table + PK index). The free plan allows 100,000 rows
--     written per day and counts every index write, so there are NO secondary indexes: every query the API
--     makes is a primary-key prefix lookup or a whole-run scan cached per isolate (src/repo/d1.ts).
--   * Added columns are marked "added" below. JSON-valued columns hold JSON text.
--   * One added table, `docs`: each run-level API response as JSON text, built by the same code as the static
--     bundle. `meta` keeps the B4 shape and holds the D1 copy of live.json under key "live".

CREATE TABLE IF NOT EXISTS fields (
  run_id         TEXT NOT NULL,
  field_id       TEXT NOT NULL,
  tile           TEXT NOT NULL,
  district       TEXT NOT NULL,
  area_ha        REAL NOT NULL,
  source         TEXT NOT NULL,
  rice_mask_frac REAL NOT NULL,
  lon            REAL NOT NULL,
  lat            REAL NOT NULL,
  geometry       TEXT NOT NULL,              -- added: GeoJSON geometry (field card, ranking point-in-polygon)
  PRIMARY KEY (run_id, field_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS passes (
  run_id                 TEXT NOT NULL,
  pass_id                TEXT NOT NULL,
  granule_id             TEXT NOT NULL,
  datetime               TEXT NOT NULL,
  direction              TEXT NOT NULL,
  track                  INTEGER NOT NULL,   -- added
  frame                  INTEGER NOT NULL,   -- added
  pol_mode               TEXT NOT NULL,
  covariance_terms       TEXT NOT NULL,      -- added: JSON array
  crid                   TEXT NOT NULL,
  maturity               TEXT NOT NULL,
  pixel_m                REAL,               -- added
  valid_fraction_by_tile TEXT NOT NULL,      -- added: JSON object
  used                   INTEGER NOT NULL,   -- 0 or 1
  excluded_reason        TEXT,               -- added: null when used
  PRIMARY KEY (run_id, pass_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS observations (
  run_id        TEXT NOT NULL,
  field_id      TEXT NOT NULL,
  pass_id       TEXT NOT NULL,
  state         TEXT NOT NULL,
  p_flooded     REAL,
  confidence    REAL,
  stage         TEXT NOT NULL,
  hh_db         REAL,
  hv_db         REAL,
  ps_db         REAL,
  pd_db         REAL,
  pv_db         REAL,
  valid_frac    REAL NOT NULL,
  vv_db         REAL,                        -- added
  hh_hv_db      REAL,                        -- added
  observed_keys TEXT NOT NULL,               -- added: which optional quad-pol members `observed` carried
                                             --        ("vv_db,ps_db,pd_db,pv_db" or ""), so absent != null
  n_px          INTEGER NOT NULL,            -- added
  method        TEXT NOT NULL,               -- added
  flags         TEXT NOT NULL,               -- added: JSON array
  PRIMARY KEY (run_id, field_id, pass_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS summaries (
  run_id        TEXT NOT NULL,
  field_id      TEXT NOT NULL,
  awd_verdict   TEXT NOT NULL,
  drained_hits  INTEGER NOT NULL,
  clear_looks   INTEGER NOT NULL,
  p_catch       REAL NOT NULL,               -- = awd.p_catch_ge1_if_awd
  awd_reason    TEXT NOT NULL,
  dsr_signal    TEXT NOT NULL,
  dsr_reason    TEXT NOT NULL,
  k_star        INTEGER,                     -- added
  window_start  TEXT NOT NULL,               -- added
  window_end    TEXT NOT NULL,               -- added
  window_source TEXT NOT NULL,               -- added: inferred | assumed
  PRIMARY KEY (run_id, field_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS audits (
  audit_id    TEXT NOT NULL PRIMARY KEY,
  run_id      TEXT NOT NULL,                 -- added: the run the ranking was computed against
  created_at  TEXT NOT NULL,
  budget      INTEGER NOT NULL,
  seed        INTEGER NOT NULL,
  input_hash  TEXT NOT NULL,
  synthetic   INTEGER NOT NULL,              -- 0 or 1
  result_json TEXT NOT NULL                  -- the whole api/audit_response; never the uploaded body
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
) STRICT, WITHOUT ROWID;

-- added table: run-level API responses (meta, story, passes, detectability, states, checks, provenance) and the
-- bundle manifest, as JSON text, written by the loader from the same builder as the static bundle.
CREATE TABLE IF NOT EXISTS docs (
  run_id TEXT NOT NULL,
  name   TEXT NOT NULL,
  body   TEXT NOT NULL,
  PRIMARY KEY (run_id, name)
) STRICT, WITHOUT ROWID;
