import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';
import cookieParser from "cookie-parser";
import pkg from 'pg';
import cors from 'cors';
import events from 'events';

import connectDB from './config/db.js';

// Routes
import authRoutes from './routes/auth.js';
import mediaRoutes from './routes/media.js';
import albumRoutes from './routes/albums.js';
import googleRouter from './routes/google.js';
import forgotRouter from './routes/forgotPassword.js';
import deleteAccountRouter from './routes/deleteAccount.js';
import supportRouter from './routes/supportMail.js';
import lockedRoutes from './routes/locked.js';

// ⚠️ NOTE: Vercel pe cron continuously run nahi hota
// import './cron/Clean.js';

const { Pool } = pkg;
const app = express();

// Prevent MaxListeners warning
events.defaultMaxListeners = 20;

// -------------------- MIDDLEWARE --------------------

app.use(cookieParser());
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://localhost:3001"
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// -------------------- DATABASES --------------------

// PostgreSQL (safe for Vercel)
const pgPool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DB,
  password: process.env.PG_PASSWORD,
  port: Number(process.env.PG_PORT),
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

app.locals.pgPool = pgPool;

// 🔥 MongoDB middleware (SERVERLESS SAFE)
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error("MongoDB connection failed:", err.message);
    res.status(500).json({ error: "Database connection failed" });
  }
});

// -------------------- ROUTES --------------------

app.get('/', (req, res) => {
  res.json({
    message: 'Image Library API',
    status: 'running',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'connecting',
    endpoints: [
      '/health',
      '/auth',
      '/media',
      '/albums',
      '/google',
      '/forgotPassword',
      '/delete-account',
      '/support',
      '/locked'
    ]
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'connecting',
    postgres: 'connected'
  });
});

app.use('/auth', authRoutes);
app.use('/media', mediaRoutes);
app.use('/albums', albumRoutes);
app.use('/google', googleRouter);
app.use('/forgotPassword', forgotRouter);
app.use('/delete-account', deleteAccountRouter);
app.use('/support', supportRouter);
app.use('/locked', lockedRoutes);

// -------------------- ERRORS --------------------

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('🔥 Error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ✅ REQUIRED for Vercel
export default app;