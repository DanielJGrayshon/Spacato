CREATE TABLE IF NOT EXISTS goal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  converged_spec_json TEXT,
  status TEXT NOT NULL DEFAULT 'eliciting',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  active_decomposition_id INTEGER,
  timeframe TEXT NOT NULL DEFAULT '6 months'
);
CREATE TABLE IF NOT EXISTS elicitation_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goal(id),
  generation INTEGER NOT NULL DEFAULT 0,
  population_json TEXT NOT NULL DEFAULT '[]',
  belief_json TEXT NOT NULL DEFAULT '{}',
  pending_question_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  vectors_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS external_signal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id INTEGER NOT NULL REFERENCES goal(id),
  genome_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  relevance_score REAL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS alert (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES external_signal(id),
  goal_id INTEGER NOT NULL REFERENCES goal(id),
  impact_score REAL NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS llm_cache (
  prompt_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (prompt_hash, model)
);
CREATE TABLE IF NOT EXISTS query_genome_state (
  goal_id    INTEGER PRIMARY KEY REFERENCES goal(id),
  state_json TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decomposition (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id    INTEGER NOT NULL REFERENCES goal(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS monthly (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  decomposition_id INTEGER NOT NULL REFERENCES decomposition(id),
  month_index      INTEGER NOT NULL,
  start_date       TEXT    NOT NULL,
  end_date         TEXT    NOT NULL,
  objective        TEXT    NOT NULL,
  description      TEXT    NOT NULL,
  weight           REAL    NOT NULL,
  progress         REAL    NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS weekly (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  decomposition_id INTEGER NOT NULL REFERENCES decomposition(id),
  monthly_id       INTEGER NOT NULL REFERENCES monthly(id),
  week_index       INTEGER NOT NULL,
  start_date       TEXT    NOT NULL,
  end_date         TEXT    NOT NULL,
  objective        TEXT    NOT NULL,
  description      TEXT    NOT NULL,
  weight           REAL    NOT NULL,
  progress         REAL    NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_task (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  decomposition_id     INTEGER NOT NULL REFERENCES decomposition(id),
  weekly_id            INTEGER NOT NULL REFERENCES weekly(id),
  date                 TEXT    NOT NULL,
  title                TEXT    NOT NULL,
  description          TEXT    NOT NULL,
  estimated_minutes    INTEGER NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'pending',
  concretization_level TEXT    NOT NULL DEFAULT 'coarse'
);

CREATE INDEX IF NOT EXISTS idx_monthly_decomp    ON monthly(decomposition_id);
CREATE INDEX IF NOT EXISTS idx_weekly_monthly    ON weekly(monthly_id);
CREATE INDEX IF NOT EXISTS idx_daily_weekly      ON daily_task(weekly_id);
CREATE INDEX IF NOT EXISTS idx_daily_decomp_date ON daily_task(decomposition_id, date);
