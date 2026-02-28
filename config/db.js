// config/db.js
import mongoose from 'mongoose';
import pkg from 'pg';
const { Pool } = pkg;

export const connectMongoDB = async () => {
  try {
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not defined in environment");
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    throw err; // throw so that server knows connection failed
  }
};

export const createPostgresPool = () => {
  if (!process.env.PG_USER || !process.env.PG_PASSWORD || !process.env.PG_DB || !process.env.PG_HOST || !process.env.PG_PORT) {
    throw new Error("PostgreSQL environment variables missing");
  }

  const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DB,
    password: process.env.PG_PASSWORD,
    port: Number(process.env.PG_PORT),
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  pool.on('error', (err) => {
    console.error('❌ PostgreSQL pool error:', err);
  });

  console.log('✅ PostgreSQL pool created');
  return pool;
};