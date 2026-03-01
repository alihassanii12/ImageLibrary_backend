import express from "express";
import multer from "multer";
import mongoose from 'mongoose';
import Media from "../models/media.js";
import cloudinary from "../config/cloudinary.js";
import fs from "fs";
import isAuth from "../middleware/isAuth.js";
import path from "path";
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import LockedFolder from "../models/lockedFolder.js";
import Album from "../models/album.js";
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// ==================== GLOBAL CONNECTION CACHE ====================
let cached = global.mongoose;
if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const opts = {
      bufferCommands: false,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    };
    
    cached.promise = mongoose.connect(process.env.MONGO_URI, opts)
      .then(mongoose => {
        console.log('✅ MongoDB connected successfully');
        return mongoose;
      })
      .catch(err => {
        console.error('❌ MongoDB connection error:', err.message);
        cached.promise = null;
        throw err;
      });
  }
  
  cached.conn = await cached.promise;
  return cached.conn;
}

// ==================== TEMP DIRECTORY (Serverless-friendly) ====================
const uploadDir = process.env.NODE_ENV === 'production' 
  ? path.join(os.tmpdir(), 'uploads')  // Vercel ke temp directory mein save karo
  : path.join(__dirname, '../uploads');

// Ensure upload directory exists
try {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
} catch (err) {
  console.error('❌ Error creating uploads directory:', err.message);
}

// ==================== MULTER CONFIG ====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
    cb(null, uniqueName + "-" + safeName);
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/")) {
    cb(null, true);
  } else {
    cb(new Error("Only image or video files allowed"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
});

// ==================== CONNECTION MIDDLEWARE ====================
router.use(async (req, res, next) => {
  try {
    req.db = await connectDB(); // Attach connection to request
    next();
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    res.status(500).json({ error: 'Database connection failed. Please try again.' });
  }
});

// ==================== HELPER FUNCTIONS ====================
const generateUrlHash = (originalName) => {
  return crypto.createHash('sha256').update(originalName + Date.now()).digest('hex').substring(0, 16);
};

const calculateUserStorage = async (userId) => {
  try {
    const media = await Media.find({ 
      userId: userId,
      isInTrash: false 
    });
    
    const totalUsed = media.reduce((acc, item) => acc + (item.size || 0), 0);
    const totalLimit = 15 * 1024 * 1024 * 1024; // 15GB limit
    
    return {
      used: totalUsed,
      total: totalLimit,
      percentage: (totalUsed / totalLimit) * 100,
      usedGB: (totalUsed / (1024 * 1024 * 1024)).toFixed(2),
      totalGB: "15.00"
    };
  } catch (err) {
    console.error("Error calculating storage:", err);
    return { used: 0, total: 15 * 1024 * 1024 * 1024, percentage: 0, usedGB: "0.00", totalGB: "15.00" };
  }
};

// Cleanup temp files helper
const cleanupTempFile = (filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error("Error cleaning up file:", err);
  }
};

// ==================== STORAGE ROUTES ====================
router.get("/storage", isAuth, async (req, res) => {
  try {
    const storage = await calculateUserStorage(req.user.id);
    res.json(storage);
  } catch (err) {
    console.error("Storage fetch error:", err);
    res.status(500).json({ error: "Failed to fetch storage info" });
  }
});

// ==================== UPLOAD ROUTES ====================
router.post("/upload", isAuth, upload.array("files", 10), async (req, res) => {
  const files = req.files || [];
  const uploadedMedia = [];
  let completed = 0;
  
  try {
    const { albumId } = req.body;
    
    if (files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    for (const file of files) {
      try {
        const mediaType = file.mimetype.startsWith("video/") ? "video" : "image";
        
        // Upload to Cloudinary
        const result = await cloudinary.uploader.upload(file.path, {
          resource_type: mediaType,
          folder: "user_uploads",
          timeout: 120000
        });

        // Save to MongoDB
        const mediaDoc = new Media({
          userId: req.user.id,
          originalName: file.originalname,
          mediaType: mediaType,
          url: result.secure_url,
          public_id: result.public_id,
          size: file.size,
          favorite: false,
          isInTrash: false,
          albumId: albumId || null
        });

        await mediaDoc.save();

        // Update album if needed
        if (albumId) {
          try {
            const album = await Album.findOneAndUpdate(
              { _id: albumId, userId: req.user.id },
              { $addToSet: { media: mediaDoc._id } },
              { new: true }
            );

            // Set cover URL if first media
            if (album && album.media.length === 1) {
              album.coverUrl = mediaDoc.url;
              await album.save();
            }
          } catch (albumErr) {
            console.error("Error updating album:", albumErr);
          }
        }

        uploadedMedia.push({
          _id: mediaDoc._id,
          url: mediaDoc.url,
          originalName: mediaDoc.originalName,
          type: mediaDoc.mediaType,
          size: mediaDoc.size,
          createdAt: mediaDoc.createdAt,
          albumId: mediaDoc.albumId
        });

        completed++;
        
      } catch (fileErr) {
        console.error("Error processing file:", file?.originalname, fileErr.message);
      } finally {
        // Always cleanup temp file
        cleanupTempFile(file?.path);
      }
    }

    const storage = await calculateUserStorage(req.user.id);

    res.status(201).json({ 
      message: `Uploaded ${completed} of ${files.length} files`, 
      media: uploadedMedia,
      storage: storage
    });

  } catch (err) {
    console.error("Upload error:", err);
    
    // Cleanup all temp files on error
    files.forEach(file => cleanupTempFile(file?.path));
    
    res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// ==================== GET MEDIA ====================
router.get("/", isAuth, async (req, res) => {
  try {
    const media = await Media.find({
      userId: req.user.id,
      isInTrash: false
    }).sort({ createdAt: -1 }).lean(); // .lean() for better performance

    const transformedMedia = media.map(item => ({
      _id: item._id,
      url: item.url,
      originalName: item.originalName,
      type: item.mediaType,
      size: item.size,
      favorite: item.favorite || false,
      albumId: item.albumId || null,
      createdAt: item.createdAt,
      isLocked: item.isLocked || false
    }));

    res.json(transformedMedia);
  } catch (err) {
    console.error("Fetch error:", err);
    res.status(500).json({ error: "Failed to fetch media" });
  }
});

// ==================== FAVORITE ====================
router.post("/:id/favorite", isAuth, async (req, res) => {
  try {
    const media = await Media.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      [{ $set: { favorite: { $eq: [false, "$favorite"] } } }],
      { new: true }
    );

    if (!media) {
      return res.status(404).json({ error: "Media not found" });
    }

    res.json({ 
      favorite: media.favorite,
      message: media.favorite ? "Added to favorites" : "Removed from favorites"
    });
  } catch (err) {
    console.error("Favorite toggle error:", err);
    res.status(500).json({ error: "Failed to toggle favorite" });
  }
});

// ==================== TRASH ====================
router.post("/:id/trash", isAuth, async (req, res) => {
  try {
    const media = await Media.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      {
        isInTrash: true,
        trashedAt: new Date(),
        scheduledDeleteAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)
      },
      { new: true }
    );

    if (!media) {
      return res.status(404).json({ error: "Media not found" });
    }

    const storage = await calculateUserStorage(req.user.id);

    res.json({ 
      message: "Moved to trash",
      scheduledDeleteAt: media.scheduledDeleteAt,
      storage: storage
    });
  } catch (err) {
    console.error("Trash error:", err);
    res.status(500).json({ error: "Failed to move to trash" });
  }
});

// Restore from trash
router.post("/:id/restore", isAuth, async (req, res) => {
  try {
    const media = await Media.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id, isInTrash: true },
      {
        isInTrash: false,
        trashedAt: null,
        scheduledDeleteAt: null
      },
      { new: true }
    );

    if (!media) {
      return res.status(404).json({ error: "Media not found in trash" });
    }

    const storage = await calculateUserStorage(req.user.id);

    res.json({ 
      message: "Restored from trash",
      storage: storage
    });
  } catch (err) {
    console.error("Restore error:", err);
    res.status(500).json({ error: "Failed to restore" });
  }
});

// Get trash
router.get("/trash/all", isAuth, async (req, res) => {
  try {
    const trashedMedia = await Media.find({
      userId: req.user.id,
      isInTrash: true
    }).sort({ trashedAt: -1 }).lean();

    const transformedMedia = trashedMedia.map(item => ({
      _id: item._id,
      url: item.url,
      originalName: item.originalName,
      type: item.mediaType,
      size: item.size,
      trashedAt: item.trashedAt,
      scheduledDeleteAt: item.scheduledDeleteAt,
      daysLeft: Math.max(0, Math.ceil((item.scheduledDeleteAt - new Date()) / (1000 * 60 * 60 * 24)))
    }));

    res.json(transformedMedia);
  } catch (err) {
    console.error("Fetch trash error:", err);
    res.status(500).json({ error: "Failed to fetch trash" });
  }
});

// Bulk trash
router.post("/bulk-trash", isAuth, async (req, res) => {
  try {
    const { mediaIds } = req.body;

    if (!mediaIds?.length) {
      return res.status(400).json({ error: "No media selected" });
    }

    const scheduledDeleteAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);

    const result = await Media.updateMany(
      { _id: { $in: mediaIds }, userId: req.user.id },
      { 
        isInTrash: true,
        trashedAt: new Date(),
        scheduledDeleteAt
      }
    );

    const storage = await calculateUserStorage(req.user.id);

    res.json({ 
      message: `${result.modifiedCount} items moved to trash`,
      storage: storage
    });
  } catch (err) {
    console.error("Bulk trash error:", err);
    res.status(500).json({ error: "Failed to move to trash" });
  }
});

// Bulk restore
router.post("/bulk-restore", isAuth, async (req, res) => {
  try {
    const { mediaIds } = req.body;

    if (!mediaIds?.length) {
      return res.status(400).json({ error: "No media selected" });
    }

    const result = await Media.updateMany(
      { _id: { $in: mediaIds }, userId: req.user.id, isInTrash: true },
      { 
        isInTrash: false,
        trashedAt: null,
        scheduledDeleteAt: null
      }
    );

    const storage = await calculateUserStorage(req.user.id);

    res.json({ 
      message: `${result.modifiedCount} items restored`,
      storage: storage
    });
  } catch (err) {
    console.error("Bulk restore error:", err);
    res.status(500).json({ error: "Failed to restore" });
  }
});

// ==================== LOCKED FOLDER ====================
router.post("/:id/lock", isAuth, async (req, res) => {
  try {
    const media = await Media.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      [{ $set: { isLocked: { $eq: [false, "$isLocked"] }, lockedAt: { $cond: { if: { $eq: ["$isLocked", false] }, then: new Date(), else: null } } } }],
      { new: true }
    );

    if (!media) {
      return res.status(404).json({ error: "Media not found" });
    }

    const storage = await calculateUserStorage(req.user.id);

    res.json({ 
      isLocked: media.isLocked,
      message: media.isLocked ? "Moved to locked folder" : "Removed from locked folder",
      storage: storage
    });
  } catch (err) {
    console.error("Lock error:", err);
    res.status(500).json({ error: "Failed to lock media" });
  }
});

// Get locked media
router.get("/locked/all", isAuth, async (req, res) => {
  try {
    const lockedFolder = await LockedFolder.findOne({ userId: req.user.id }).lean();
    
    const hasAccess = lockedFolder?.hasAccess && 
      lockedFolder?.sessionExpires && 
      lockedFolder.sessionExpires > new Date();

    if (!hasAccess) {
      return res.status(403).json({ error: "Access denied. Please verify password first." });
    }

    const lockedMedia = await Media.find({
      userId: req.user.id,
      isLocked: true,
      isInTrash: false
    }).sort({ lockedAt: -1 }).lean();

    const secureMedia = lockedMedia.map(m => ({
      _id: m._id,
      hash: generateUrlHash(m.originalName),
      originalName: m.originalName,
      type: m.mediaType,
      size: m.size,
      lockedAt: m.lockedAt,
      url: m.url,
      albumId: m.albumId
    }));

    res.json(secureMedia);
  } catch (err) {
    console.error("Fetch locked error:", err);
    res.status(500).json({ error: "Failed to fetch locked media" });
  }
});

// Access locked media
router.post("/locked/access/:hash", isAuth, async (req, res) => {
  try {
    const lockedFolder = await LockedFolder.findOne({ userId: req.user.id }).lean();
    
    const hasAccess = lockedFolder?.hasAccess && 
      lockedFolder?.sessionExpires > new Date();

    if (!hasAccess) {
      return res.status(403).json({ error: "Access denied. Please verify password first." });
    }

    const media = await Media.findOne({
      userId: req.user.id,
      isLocked: true
    }).lean();

    if (!media) {
      return res.status(404).json({ error: "Media not found" });
    }

    const expectedHash = generateUrlHash(media.originalName);
    if (req.params.hash !== expectedHash) {
      return res.status(403).json({ error: "Invalid access" });
    }

    res.json({ url: media.url });
  } catch (err) {
    console.error("Access error:", err);
    res.status(500).json({ error: "Failed to access media" });
  }
});

// ==================== PERMANENT DELETE ====================
router.delete("/permanent/:id", isAuth, async (req, res) => {
  let media = null;
  
  try {
    media = await Media.findOne({
      _id: req.params.id,
      userId: req.user.id,
      isInTrash: true
    });

    if (!media) {
      return res.status(404).json({ error: "Media not found in trash" });
    }

    // Delete from Cloudinary
    try {
      await cloudinary.uploader.destroy(media.public_id, {
        resource_type: media.mediaType,
      });
    } catch (cloudinaryErr) {
      console.error("Cloudinary delete error:", cloudinaryErr);
    }

    // Delete from MongoDB
    await media.deleteOne();

    const storage = await calculateUserStorage(req.user.id);

    res.json({ 
      message: "Permanently deleted",
      storage: storage
    });
  } catch (err) {
    console.error("Permanent delete error:", err);
    res.status(500).json({ error: "Failed to delete permanently" });
  }
});

// ==================== MOVE MEDIA ====================
router.post('/move-media', isAuth, async (req, res) => {
  try {
    const { mediaId, targetAlbumId } = req.body;

    if (!mediaId) {
      return res.status(400).json({ error: 'mediaId is required' });
    }

    // Find media
    const media = await Media.findOne({
      _id: mediaId,
      userId: req.user.id
    });

    if (!media) {
      return res.status(404).json({ error: 'Media not found' });
    }

    // Remove from current album if exists
    if (media.albumId) {
      await Album.updateOne(
        { _id: media.albumId, userId: req.user.id },
        { $pull: { media: mediaId } }
      );
    }

    // Add to target album if specified
    if (targetAlbumId) {
      const targetAlbum = await Album.findOneAndUpdate(
        { _id: targetAlbumId, userId: req.user.id },
        { $addToSet: { media: mediaId } },
        { new: true }
      );

      if (!targetAlbum) {
        return res.status(404).json({ error: 'Target album not found' });
      }

      media.albumId = targetAlbumId;
    } else {
      media.albumId = null;
    }

    await media.save();

    res.json({ 
      message: targetAlbumId ? 'Media moved to album' : 'Media moved to main library',
      media: {
        _id: media._id,
        url: media.url,
        originalName: media.originalName,
        type: media.mediaType,
        size: media.size,
        favorite: media.favorite,
        albumId: media.albumId,
        createdAt: media.createdAt,
        isLocked: media.isLocked
      }
    });
  } catch (err) {
    console.error('Error moving media:', err);
    res.status(500).json({ error: err.message });
  }
});

// Bulk move media
router.post('/bulk-move-media', isAuth, async (req, res) => {
  try {
    const { mediaIds, targetAlbumId } = req.body;

    if (!mediaIds?.length) {
      return res.status(400).json({ error: 'mediaIds array is required' });
    }

    // Remove from all current albums
    await Album.updateMany(
      { userId: req.user.id },
      { $pull: { media: { $in: mediaIds } } }
    );

    // Add to target album if specified
    if (targetAlbumId) {
      const targetAlbum = await Album.findOneAndUpdate(
        { _id: targetAlbumId, userId: req.user.id },
        { $addToSet: { media: { $each: mediaIds } } },
        { new: true }
      );

      if (!targetAlbum) {
        return res.status(404).json({ error: 'Target album not found' });
      }

      // Update all media with target album ID
      await Media.updateMany(
        { _id: { $in: mediaIds }, userId: req.user.id },
        { albumId: targetAlbumId }
      );
    } else {
      // Remove album ID from all media
      await Media.updateMany(
        { _id: { $in: mediaIds }, userId: req.user.id },
        { albumId: null }
      );
    }

    res.json({ 
      message: `Moved ${mediaIds.length} items successfully`,
      count: mediaIds.length
    });
  } catch (err) {
    console.error('Error bulk moving media:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
