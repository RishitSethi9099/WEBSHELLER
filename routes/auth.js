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
const crypto  = require('crypto');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;

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

// ─── OAuth Strategies & Config ───────────────────────────────────────────────

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

if (process.env.GOOGLE_CLIENT_ID) {
  passport.use(new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "https://sheller.me/api/auth/google/callback"
    },
    (accessToken, refreshToken, profile, cb) => cb(null, profile)
  ));
}

if (process.env.GITHUB_CLIENT_ID) {
  passport.use(new GitHubStrategy({
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: "https://sheller.me/api/auth/github/callback"
    },
    (accessToken, refreshToken, profile, cb) => cb(null, profile)
  ));
}

function handleOAuthCallback(req, res, provider) {
  if (!req.user) return res.redirect('/login');
  
  const profile = req.user;
  const email = profile.emails && profile.emails[0] ? profile.emails[0].value : (profile._json && profile._json.email) || '';
  const oauth_id = String(profile.id);
  const display_name = profile.displayName || profile.username || '';

  let user = db.prepare('SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?').get(provider, oauth_id);
  
  if (!user && email) {
    // Attempt fallback lookup by email
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) {
      // Link account
      db.prepare('UPDATE users SET oauth_provider = ?, oauth_id = ? WHERE id = ?').run(provider, oauth_id, user.id);
    }
  }

  if (user) {
    const token = signToken(user);
    return res.redirect(`https://sheller.me/auth/callback?token=${token}`);
  } else {
    const pending_id = crypto.randomUUID();
    db.prepare('INSERT INTO pending_oauth (id, provider, oauth_id, email, display_name) VALUES (?, ?, ?, ?, ?)').run(
      pending_id, provider, oauth_id, email, display_name
    );
    return res.redirect(`https://sheller.me/auth/username-picker?pending_id=${pending_id}`);
  }
}

// ─── GET /api/auth/google ────────────────────────────────────────────────────

router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

router.get('/google/callback', 
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => handleOAuthCallback(req, res, 'google')
);

// ─── GET /api/auth/github ────────────────────────────────────────────────────

router.get('/github', passport.authenticate('github', { scope: ['user:email'] }));

router.get('/github/callback', 
  passport.authenticate('github', { failureRedirect: '/' }),
  (req, res) => handleOAuthCallback(req, res, 'github')
);

// ─── POST /api/auth/complete-oauth ───────────────────────────────────────────

router.post('/complete-oauth', (req, res) => {
  const { pending_id, username } = req.body;
  
  if (!pending_id || !username) {
    return res.status(400).json({ error: 'Missing requirements.' });
  }
  
  if (username.length < 3 || username.length > 30) {
    return res.status(400).json({ error: 'Username must be 3–30 characters.' });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, hyphens, and underscores.' });
  }

  const pending = db.prepare('SELECT * FROM pending_oauth WHERE id = ?').get(pending_id);
  if (!pending) {
    return res.status(404).json({ error: 'Pending OAuth session not found.' });
  }

  if (findUserByUsername.get(username)) {
    return res.status(409).json({ error: 'This username is already taken.' });
  }

  try {
    const result = db.prepare('INSERT INTO users (username, email, oauth_provider, oauth_id) VALUES (?, ?, ?, ?)').run(
      username, pending.email, pending.provider, pending.oauth_id
    );
    db.prepare('DELETE FROM pending_oauth WHERE id = ?').run(pending_id);
    
    const user = { id: result.lastInsertRowid, username, email: pending.email };
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    console.error('[auth/complete-oauth]', err.message);
    res.status(500).json({ error: 'Failed to complete registration.' });
  }
});

module.exports = router;
