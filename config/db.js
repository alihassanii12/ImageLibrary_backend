import mongoose from 'mongoose';
import pkg from 'pg';
const { Pool } = pkg;

export const connectMongoDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is not defined in environment");
    }
    
    console.log('🔍 Connecting to MongoDB...');
    console.log('MONGO_URI exists:', !!process.env.MONGO_URI);
    
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    
    mongoose.connection.on('error', (err) => {
      console.error('MongoDB connection error:', err);
    });
    
    console.log('✅ MongoDB connected successfully');
    return mongoose;
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    throw err;
  }
};

export const createPostgresPool = () => {
  // Check all required PostgreSQL env variables
  const required = ['PG_USER', 'PG_PASSWORD', 'PG_HOST', 'PG_PORT', 'PG_DB'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    throw new Error(`Missing PostgreSQL environment variables: ${missing.join(', ')}`);
  }

  const pool = new Pool({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DB,
    password: process.env.PG_PASSWORD,
    port: Number(process.env.PG_PORT),
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  pool.on('error', (err) => {
    console.error('❌ PostgreSQL pool error:', err);
  });

  console.log('✅ PostgreSQL pool created');
  return pool;
};