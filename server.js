// api/index.js
import express from 'express';
import mongoose from 'mongoose';
import { Pool } from 'pg';
import cors from 'cors';

// Import your existing routes
import authRoutes from '../routes/auth.js';
import mediaRoutes from '../routes/media.js';
// ... other imports

const app = express();

// ✅ Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'));

// ✅ PostgreSQL connection (Neon.tech)
const pgPool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DB,
  password: process.env.PG_PASSWORD,
  port: Number(process.env.PG_PORT),
  ssl: { rejectUnauthorized: false }
});
app.locals.pgPool = pgPool;

// ✅ Middleware
app.use(cors({
  origin: ['https://your-frontend.vercel.app', 'http://localhost:3000']
}));
app.use(express.json());

// ✅ Routes
app.use('/auth', authRoutes);
app.use('/media', mediaRoutes);
// ... other routes

// ✅ Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// ❌ Important: app.listen() hatao
// ✅ Sirf export karo
export default app;