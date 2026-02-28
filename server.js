import 'dotenv/config';
import express from 'express';
import mongoose from 'mongoose';  // ✅ IMPORTANT: Add this!
import cookieParser from "cookie-parser";
import cors from 'cors';
import events from 'events';

// Routes
import authRoutes from './routes/auth.js';
import mediaRoutes from './routes/media.js';
import albumRoutes from './routes/albums.js';
import googleRouter from './routes/google.js';
import forgotRouter from './routes/forgotPassword.js';
import deleteAccountRouter from './routes/deleteAccount.js';
import supportRouter from './routes/supportMail.js';
import lockedRoutes from './routes/locked.js';

// DB config
import { connectMongoDB, createPostgresPool } from './config/db.js';

// Increase max listeners
events.defaultMaxListeners = 20;

const app = express();

// Middleware
app.use(cookieParser());
app.use(cors({
  origin: ["http://localhost:3000", "http://localhost:3001", "https://*.vercel.app"],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ==================== DATABASE CONNECTIONS ====================
let pgPool;
let mongoConnected = false;

// PostgreSQL
try {
  pgPool = createPostgresPool();
  app.locals.pgPool = pgPool;
  console.log('✅ PostgreSQL pool created');
} catch (err) {
  console.error('❌ PostgreSQL connection failed:', err.message);
}

// MongoDB
connectMongoDB()
  .then(() => {
    mongoConnected = true;
    console.log('✅ MongoDB connected');
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
  });

// ==================== ROUTES ====================
app.get('/', (req, res) => {
  res.json({
    message: 'Image Library API',
    status: 'running',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    postgres: pgPool ? 'connected' : 'disconnected'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    postgres: pgPool ? 'connected' : 'disconnected',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Mount routes
app.use('/auth', authRoutes);
app.use('/media', mediaRoutes);
app.use('/albums', albumRoutes);
app.use('/google', googleRouter);
app.use('/forgotPassword', forgotRouter);
app.use('/delete-account', deleteAccountRouter);
app.use('/support', supportRouter);
app.use('/locked', lockedRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('🔥 Error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ==================== VERCEL SERVERLESS EXPORT ====================
// ❌ NO app.listen() - Vercel serverless mein ye nahi chalta
// ✅ Sirf export default app

export default app;