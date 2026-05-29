CREATE TABLE decomposition (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id    INTEGER NOT NULL REFERENCES goal(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE monthly (
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

CREATE TABLE weekly (
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

CREATE TABLE daily_task (
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

CREATE INDEX idx_monthly_decomp    ON monthly(decomposition_id);
CREATE INDEX idx_weekly_monthly    ON weekly(monthly_id);
CREATE INDEX idx_daily_weekly      ON daily_task(weekly_id);
CREATE INDEX idx_daily_decomp_date ON daily_task(decomposition_id, date);
