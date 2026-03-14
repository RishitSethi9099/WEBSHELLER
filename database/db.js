/**
 * Sheller — SQLite Database Module
 *
 * Uses better-sqlite3 for a zero-config local database.
 * Stores users with bcrypt-hashed passwords.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'sheller.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// ─── Schema ──────────────────────────────────────────────────────────────────

// SQLite lacks 'ALTER COLUMN DROP NOT NULL', so we recreate the table to make password nullable.
// We also add oauth_provider, oauth_id if they don't exist.
const tableInfo = db.prepare("PRAGMA table_info(users)").all();
const hasUsersTable = tableInfo.length > 0;

if (!hasUsersTable) {
  db.exec(`
    CREATE TABLE users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      email       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password    TEXT,
      oauth_provider TEXT,
      oauth_id       TEXT,
      created_at  TEXT    DEFAULT (datetime('now')),
      UNIQUE(oauth_provider, oauth_id)
    );
  `);
} else {
  const hasOAuth = tableInfo.some(c => c.name === 'oauth_provider');
  const isPasswordNotNull = tableInfo.find(c => c.name === 'password')?.notnull === 1;

  if (isPasswordNotNull) {
    // Recreate table safely
    db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN TRANSACTION;
      CREATE TABLE users_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        email       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        password    TEXT,
        oauth_provider TEXT,
        oauth_id       TEXT,
        created_at  TEXT    DEFAULT (datetime('now')),
        UNIQUE(oauth_provider, oauth_id)
      );
      INSERT INTO users_new (id, username, email, password, created_at)
      SELECT id, username, email, password, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  } else if (!hasOAuth) {
    // Safe ALTER TABLE fallbacks if table existed without NOT NULL password but missing OAuth
    try { db.exec("ALTER TABLE users ADD COLUMN oauth_provider TEXT;"); } catch (e) {}
    try { db.exec("ALTER TABLE users ADD COLUMN oauth_id TEXT;"); } catch (e) {}
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oauth ON users(oauth_provider, oauth_id);");
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS pending_oauth (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    oauth_id TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS lesson_progress (
    user_id     INTEGER NOT NULL,
    lesson_id   TEXT    NOT NULL,
    step_index  INTEGER NOT NULL,
    PRIMARY KEY (user_id, lesson_id, step_index)
  );
`);

console.log('[db] SQLite database ready at', DB_PATH);

module.exports = db;
