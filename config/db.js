import mongoose from 'mongoose';
import pkg from 'pg';
const { Pool } = pkg;

// ==================== MONGODB (Serverless Optimized) ====================
// Cache the MongoDB connection across serverless function invocations
let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

export const connectMongoDB = async () => {
  // If connection exists, return it
  if (cached.conn) {
    console.log('✅ Using cached MongoDB connection');
    return cached.conn;
  }

  // If no connection promise exists, create one
  if (!cached.promise) {
    if (!process.env.MONGO_URI) {
      throw new Error("MONGO_URI is not defined in environment");
    }

    console.log('🔍 Creating new MongoDB connection...');
    
    const opts = {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      minPoolSize: 1,
      maxIdleTimeMS: 10000,
      connectTimeoutMS: 10000,
    };

    cached.promise = mongoose.connect(process.env.MONGO_URI, opts)
      .then(mongoose => {
        console.log('✅ MongoDB connected successfully');
        return mongoose;
      })
      .catch(err => {
        console.error('❌ MongoDB connection failed:', err);
        cached.promise = null;
        throw err;
      });
  }
  
  try {
    cached.conn = await cached.promise;
  } catch (err) {
    cached.promise = null;
    throw err;
  }
  
  return cached.conn;
};

// ==================== POSTGRESQL (Serverless Optimized) ====================
let pgPool = null;
let poolPromise = null;

export const getPostgresPool = async () => {
  // Return existing pool if available
  if (pgPool) {
    return pgPool;
  }

  // If pool is being created, wait for it
  if (poolPromise) {
    return poolPromise;
  }

  // Create new pool
  poolPromise = new Promise((resolve, reject) => {
    try {
      const required = ['PG_USER', 'PG_PASSWORD', 'PG_HOST', 'PG_PORT', 'PG_DB'];
      const missing = required.filter(key => !process.env[key]);

      if (missing.length > 0) {
        throw new Error(`Missing PostgreSQL environment variables: ${missing.join(', ')}`);
      }

      console.log('🔍 Creating new PostgreSQL pool...');

      const pool = new Pool({
        user: process.env.PG_USER,
        host: process.env.PG_HOST,
        database: process.env.PG_DB,
        password: process.env.PG_PASSWORD,
        port: Number(process.env.PG_PORT),
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 5,
        min: 1,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 5000,
        maxUses: 7500,
      });

      pool.on('error', (err) => {
        console.error('❌ PostgreSQL pool error:', err);
        pgPool = null;
        poolPromise = null;
      });

      // Test connection
      pool.connect((err, client, done) => {
        if (err) {
          console.error('❌ PostgreSQL connection test failed:', err);
          poolPromise = null;
          reject(err);
        } else {
          console.log('✅ PostgreSQL pool created and tested');
          done();
          pgPool = pool;
          resolve(pool);
        }
      });
    } catch (err) {
      poolPromise = null;
      reject(err);
    }
  });

  return poolPromise;
};

// Cleanup function for development
export const closeConnections = async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.close();
    cached.conn = null;
    cached.promise = null;
    console.log('🔌 MongoDB connection closed');
  }
  
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
    poolPromise = null;
    console.log('🔌 PostgreSQL pool closed');
  }
};
