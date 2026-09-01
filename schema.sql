-- hosq TASK BOT — D1 schema (SQLite)
-- If the Cloudflare D1 UI says "Requests without any query are not supported",
-- run the split files in `d1/console/` one file at a time (01 … 10), then seed 11 … 14.

PRAGMA foreign_keys = ON;

-- PROFILES (replaces Google Sheets PROFILES tab)
CREATE TABLE IF NOT EXISTS profiles (
  user_email TEXT PRIMARY KEY,
  user_name TEXT NOT NULL,
  telegram_username TEXT,
  profile_image_link TEXT,
  notion_user_id TEXT,
  telegram_user_id TEXT UNIQUE,
  timezone TEXT,
  reminder_time TEXT,
  sparks INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  completed_tasks INTEGER NOT NULL DEFAULT 0,
  last_activity_date TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profiles_telegram_user_id ON profiles(telegram_user_id);

-- MESSAGES (replaces Google Sheets MESSAGES tab)
CREATE TABLE IF NOT EXISTS messages (
  message_tag TEXT PRIMARY KEY,
  section TEXT,
  message_text TEXT NOT NULL
);

-- PARAMETERS (replaces Google Sheets PARAMETERS tab)
CREATE TABLE IF NOT EXISTS parameters (
  parameter_key TEXT PRIMARY KEY,
  parameter_value TEXT NOT NULL,
  parameter_description TEXT
);

-- PROJECTS (replaces Google Sheets PROJECTS tab)
CREATE TABLE IF NOT EXISTS projects (
  project_tag TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  project_owner_email TEXT NOT NULL,
  project_status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_owner_email ON projects(project_owner_email);

-- HELPERS (replaces Google Sheets HELPERS tab)
CREATE TABLE IF NOT EXISTS helpers (
  name TEXT PRIMARY KEY,
  price INTEGER NOT NULL,
  image_link TEXT,
  description TEXT
);

-- INVENTORY (user purchases)
CREATE TABLE IF NOT EXISTS inventory (
  user_email TEXT NOT NULL,
  helper_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_email, helper_name),
  FOREIGN KEY (user_email) REFERENCES profiles(user_email) ON DELETE CASCADE,
  FOREIGN KEY (helper_name) REFERENCES helpers(name) ON DELETE RESTRICT
);

-- Ledger (optional but useful for debugging/auditing)
CREATE TABLE IF NOT EXISTS sparks_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_at TEXT NOT NULL,
  user_email TEXT NOT NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  helper_name TEXT,
  notion_page_id TEXT,
  notes TEXT,
  FOREIGN KEY (user_email) REFERENCES profiles(user_email) ON DELETE CASCADE
);

