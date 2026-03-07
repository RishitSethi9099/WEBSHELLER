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

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    email       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password    TEXT    NOT NULL,
    created_at  TEXT    DEFAULT (datetime('now'))
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
