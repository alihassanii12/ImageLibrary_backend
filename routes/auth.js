import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import isAuth from "../middleware/isAuth.js";

const router = express.Router();

/* ================= COOKIE OPTIONS ================= */
const isProduction = process.env.NODE_ENV === 'production';

const accessCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
  maxAge: 15 * 24 * 60 * 60 * 1000
};

const refreshCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000
};

/* ================= TOKEN HELPERS ================= */
const generateAccessToken = (user) =>
  jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role
    },
    process.env.JWT_SECRET,
    { expiresIn: "15m" }
  );

const generateRefreshToken = () =>
  jwt.sign({}, process.env.JWT_REFRESH_SECRET, {
    expiresIn: "7d"
  });

/* ================= REGISTER ================= */
router.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  const pool = req.pgPool || req.app?.locals?.pgPool;

  try {
    // Check if user exists
    const exists = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email]
    );

    if (exists.rows.length) {
      return res.status(400).json({ error: "User already exists" });
    }

    // Hash password
    const hashed = await bcrypt.hash(password, 10);

    // Insert user
    const result = await pool.query(
      `INSERT INTO users (name, email, password, auth_provider)
       VALUES ($1, $2, $3, 'local')
       RETURNING id, name, email, role`,
      [name, email, hashed]
    );

    const user = result.rows[0];

    // Generate NEW tokens for registration
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken();

    // Save session
    await pool.query(
      `INSERT INTO sessions (user_id, refresh_token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, refreshToken]
    );

    // Set cookies
    res.cookie("token", accessToken, accessCookieOptions);
    res.cookie("refreshToken", refreshToken, refreshCookieOptions);

    // Send response
    res.status(201).json({ 
      message: "Registration successful",
      token: accessToken,
      refreshToken: refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });

  } catch (err) {
    console.error('❌ Registration error:', err);
    res.status(500).json({ error: err.message || "Registration failed" });
  }
});

/* ================= LOGIN ================= */
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const pool = req.pgPool || req.app?.locals?.pgPool;

  console.log('🔍 Login attempt for:', email);

  try {
    // Get user from database
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (!result.rows.length) {
      return res.status(400).json({ error: "User not found" });
    }

    const user = result.rows[0];

    // Compare password
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    // ✅ GENERATE BRAND NEW TOKENS FOR LOGIN
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken();

    console.log('✅ New login tokens generated');
    console.log('Access token (first 20 chars):', accessToken.substring(0, 20) + '...');
    console.log('Refresh token (first 20 chars):', refreshToken.substring(0, 20) + '...');

    // ✅ DELETE OLD SESSIONS (optional - cleanup)
    await pool.query(
      "DELETE FROM sessions WHERE user_id = $1",
      [user.id]
    );
    console.log('✅ Old sessions deleted');

    // ✅ SAVE NEW SESSION
    await pool.query(
      `INSERT INTO sessions (user_id, refresh_token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, refreshToken]
    );

    console.log('✅ New session saved');

    // Set cookies with NEW tokens
    res.cookie("token", accessToken, accessCookieOptions);
    res.cookie("refreshToken", refreshToken, refreshCookieOptions);

    console.log('✅ New cookies set');

    // Send response with NEW tokens
    res.json({
      token: accessToken,
      refreshToken: refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });

  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ error: "Login failed" });
  }
});

/* ================= LOGOUT ================= */
router.post("/logout", async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  const pool = req.pgPool || req.app?.locals?.pgPool;

  if (refreshToken && pool) {
    await pool.query(
      "DELETE FROM sessions WHERE refresh_token = $1",
      [refreshToken]
    );
  }

  res.clearCookie("token", {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/"
  });
  
  res.clearCookie("refreshToken", {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/"
  });

  res.json({ success: true });
});

/* ================= CURRENT USER ================= */
router.get("/me", isAuth, async (req, res) => {
  const pool = req.pgPool || req.app?.locals?.pgPool;

  try {
    const result = await pool.query(
      `SELECT id, name, email, role, plan, google_picture, auth_provider 
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.rows[0];
    
    res.json({ 
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        plan: user.plan,
        avatar: user.google_picture,
        auth_provider: user.auth_provider || 'local'
      }
    });

  } catch (err) {
    console.error('❌ Get user error:', err);
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

export default router;