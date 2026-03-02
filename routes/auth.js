import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import isAuth from "../middleware/isAuth.js";

const router = express.Router();

/* ================= COOKIE OPTIONS ================= */
const isProduction = process.env.NODE_ENV === 'production';

const accessCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
  path: "/",
  maxAge: 15 * 24 * 60 * 60 * 1000
};

const refreshCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "lax",
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

  if (!pool) {
    console.error('❌ Database pool not available');
    return res.status(500).json({ error: "Database connection error" });
  }

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

    // Generate tokens
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
      user 
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

  // Validate input
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  if (!pool) {
    console.error('❌ Database pool not available');
    return res.status(500).json({ error: "Database connection error" });
  }

  try {
    // Get user from database
    const result = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (!result.rows.length) {
      console.log('❌ User not found:', email);
      return res.status(400).json({ error: "User not found" });
    }

    const user = result.rows[0];
    console.log('✅ User found:', user.email);

    // Compare password
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      console.log('❌ Invalid password for:', email);
      return res.status(400).json({ error: "Invalid credentials" });
    }

    console.log('✅ Password matched');

    // Generate tokens
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken();

    console.log('✅ Tokens generated');

    // Save session
    await pool.query(
      `INSERT INTO sessions (user_id, refresh_token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, refreshToken]
    );

    console.log('✅ Session saved');

    // Set cookies
    res.cookie("token", accessToken, accessCookieOptions);
    res.cookie("refreshToken", refreshToken, refreshCookieOptions);

    console.log('✅ Cookies set');

    // Send response
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
    res.status(500).json({ error: "Login failed", details: err.message });
  }
});

/* ================= REFRESH ================= */
router.post("/refresh", async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  const pool = req.pgPool || req.app?.locals?.pgPool;

  if (!refreshToken) {
    return res.status(401).json({ error: "No refresh token" });
  }

  if (!pool) {
    return res.status(500).json({ error: "Database connection error" });
  }

  try {
    const session = await pool.query(
      `SELECT user_id FROM sessions
       WHERE refresh_token = $1 AND expires_at > NOW()`,
      [refreshToken]
    );

    if (!session.rows.length) {
      return res.status(401).json({ error: "Invalid refresh token" });
    }

    const user = await pool.query(
      "SELECT id, email, role FROM users WHERE id = $1",
      [session.rows[0].user_id]
    );

    const newAccessToken = generateAccessToken(user.rows[0]);

    res.cookie("token", newAccessToken, accessCookieOptions);

    res.json({ 
      success: true,
      token: newAccessToken 
    });

  } catch (err) {
    console.error('❌ Refresh error:', err);
    res.status(403).json({ error: "Token refresh failed" });
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

  res.clearCookie("token");
  res.clearCookie("refreshToken");

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