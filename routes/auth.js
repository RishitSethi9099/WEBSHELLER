/**
 * Sheller — Auth Routes (Local SQLite)
 *
 * POST /api/auth/register  → create new user
 * POST /api/auth/login     → authenticate & return JWT
 * GET  /api/auth/me        → validate token & return user info
 */

const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const db      = require('../database/db');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'sheller_dev_secret_change_me';
const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = '7d';

// ─── Prepared statements ─────────────────────────────────────────────────────

const findUserByEmail    = db.prepare('SELECT * FROM users WHERE email = ?');
const findUserByUsername = db.prepare('SELECT * FROM users WHERE username = ?');
const findUserById       = db.prepare('SELECT id, username, email, created_at FROM users WHERE id = ?');
const insertUser         = db.prepare(
  'INSERT INTO users (username, email, password) VALUES (?, ?, ?)'
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// ─── POST /api/auth/register ─────────────────────────────────────────────────

router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required.' });
    }

    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: 'Username must be 3–30 characters.' });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, hyphens, and underscores.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    // Check for existing user
    if (findUserByEmail.get(email)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    if (findUserByUsername.get(username)) {
      return res.status(409).json({ error: 'This username is already taken.' });
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = insertUser.run(username, email, hash);

    const user = { id: result.lastInsertRowid, username, email };
    const token = signToken(user);

    res.status(201).json({
      message: 'Account created successfully.',
      token,
      user: { id: user.id, username: user.username, email: user.email },
    });
  } catch (err) {
    console.error('[auth/register]', err.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ─── POST /api/auth/login ────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = findUserByEmail.get(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = signToken(user);

    res.json({
      message: 'Login successful.',
      token,
      user: { id: user.id, username: user.username, email: user.email },
    });
  } catch (err) {
    console.error('[auth/login]', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─── GET /api/auth/me ────────────────────────────────────────────────────────

router.get('/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const decoded = verifyToken(authHeader.split(' ')[1]);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  const user = findUserById.get(decoded.id);
  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  res.json({ user });
});

// Export the helper too so server.js can verify tokens on WS connections
router.verifyToken = verifyToken;

module.exports = router;
