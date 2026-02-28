import express from 'express';
import mongoose from 'mongoose';
import Album from '../models/album.js';
import Media from '../models/media.js';
import isAuth from '../middleware/isAuth.js';

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
        console.log('✅ [Albums] MongoDB connected');
        return mongoose;
      })
      .catch(err => {
        console.error('❌ [Albums] MongoDB error:', err.message);
        cached.promise = null;
        throw err;
      });
  }
  
  cached.conn = await cached.promise;
  return cached.conn;
}

// ==================== MIDDLEWARE ====================
router.use(async (req, res, next) => {
  try {
    req.db = await connectDB();
    next();
  } catch (err) {
    console.error('❌ [Albums] DB connection failed:', err.message);
    res.status(500).json({ error: 'Database connection failed' });
  }
});

// ==================== HELPER FUNCTIONS ====================
const updateAlbumCover = async (albumId) => {
  try {
    const album = await Album.findById(albumId);
    if (!album) return;
    
    if (album.media?.length > 0) {
      const firstMedia = await Media.findById(album.media[0]).lean();
      if (firstMedia) {
        album.coverUrl = firstMedia.url;
        await album.save();
      }
    } else {
      album.coverUrl = '';
      await album.save();
    }
  } catch (err) {
    console.error('Error updating album cover:', err);
  }
};

// ==================== CREATE ALBUM/FOLDER ====================
router.post('/create', isAuth, async (req, res) => {
    try {
        const { name, description, category, parentAlbumId, isFolder } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Name is required' });
        }

        // Validate parent if provided
        if (parentAlbumId) {
            if (!mongoose.Types.ObjectId.isValid(parentAlbumId)) {
                return res.status(400).json({ error: 'Invalid parent folder ID' });
            }

            const parentExists = await Album.exists({
                _id: parentAlbumId,
                userId: req.user.id
            });

            if (!parentExists) {
                return res.status(404).json({ error: 'Parent folder not found' });
            }
        }

        const album = await Album.create({
            userId: req.user.id,
            name,
            description: description || '',
            category: category || 'personal',
            coverUrl: '',
            media: [],
            parentAlbumId: parentAlbumId || null,
            isFolder: isFolder || false
        });

        res.status(201).json(album);
    } catch (err) {
        console.error('Error creating album/folder:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== GET ALL ALBUMS ====================
router.get('/all', isAuth, async (req, res) => {
    try {
        const albums = await Album.find({ userId: req.user.id })
            .populate({
                path: 'media',
                select: 'url originalName mediaType size createdAt',
                options: { sort: { createdAt: -1 } }
            })
            .sort({ createdAt: -1 })
            .lean(); // Better performance

        res.json(albums);
    } catch (err) {
        console.error('Error fetching albums:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== GET ALBUMS/FOLDERS BY PARENT ====================
router.get('/', isAuth, async (req, res) => {
    try {
        const { parentId } = req.query;
        
        let query = { userId: req.user.id };
        
        if (parentId === 'root' || !parentId) {
            query.parentAlbumId = null;
        } else if (mongoose.Types.ObjectId.isValid(parentId)) {
            query.parentAlbumId = parentId;
        } else {
            return res.status(400).json({ error: 'Invalid parent ID' });
        }

        const albums = await Album.find(query)
            .populate({
                path: 'media',
                select: 'url originalName mediaType size createdAt',
                options: { sort: { createdAt: -1 } }
            })
            .sort({ isFolder: -1, name: 1 })
            .lean();

        res.json(albums);
    } catch (err) {
        console.error('Error fetching albums:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== GET SINGLE ALBUM ====================
router.get('/:albumId', isAuth, async (req, res) => {
    try {
        const { albumId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(albumId)) {
            return res.status(400).json({ error: 'Invalid album ID' });
        }

        const album = await Album.findOne({
            _id: albumId,
            userId: req.user.id
        })
        .populate({
            path: 'media',
            select: 'url originalName mediaType size createdAt favorite isLocked',
            options: { sort: { createdAt: -1 } }
        })
        .lean();

        if (!album) {
            return res.status(404).json({ error: 'Album not found' });
        }

        res.json(album);
    } catch (err) {
        console.error('Error fetching album:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== GET CHILDREN OF A FOLDER ====================
router.get('/:albumId/children', isAuth, async (req, res) => {
    try {
        const { albumId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(albumId)) {
            return res.status(400).json({ error: 'Invalid folder ID' });
        }

        const parent = await Album.exists({
            _id: albumId,
            userId: req.user.id
        });

        if (!parent) {
            return res.status(404).json({ error: 'Parent folder not found' });
        }

        const children = await Album.find({
            parentAlbumId: albumId,
            userId: req.user.id
        })
        .populate({
            path: 'media',
            select: 'url originalName mediaType size createdAt',
            options: { sort: { createdAt: -1 } }
        })
        .sort({ isFolder: -1, name: 1 })
        .lean();

        res.json(children);
    } catch (err) {
        console.error('Error fetching children:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== GET ALBUM PATH ====================
router.get('/:albumId/path', isAuth, async (req, res) => {
    try {
        const { albumId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(albumId)) {
            return res.status(400).json({ error: 'Invalid album ID' });
        }

        const path = [];
        let currentId = albumId;

        while (currentId) {
            const album = await Album.findOne({
                _id: currentId,
                userId: req.user.id
            }).select('_id name isFolder parentAlbumId').lean();

            if (!album) break;

            path.unshift({
                _id: album._id,
                name: album.name,
                isFolder: album.isFolder
            });

            currentId = album.parentAlbumId;
        }

        res.json(path);
    } catch (err) {
        console.error('Error fetching album path:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== ADD MEDIA TO ALBUM ====================
router.post('/:albumId/add-media', isAuth, async (req, res) => {
    try {
        const { albumId } = req.params;
        const { mediaId } = req.body;

        if (!mediaId) {
            return res.status(400).json({ error: 'mediaId is required' });
        }

        if (!mongoose.Types.ObjectId.isValid(albumId) || !mongoose.Types.ObjectId.isValid(mediaId)) {
            return res.status(400).json({ error: 'Invalid ID format' });
        }

        // Check if media exists and belongs to user
        const media = await Media.findOne({
            _id: mediaId,
            userId: req.user.id
        }).lean();

        if (!media) {
            return res.status(404).json({ error: 'Media not found' });
        }

        // Update album
        const album = await Album.findOneAndUpdate(
            { _id: albumId, userId: req.user.id },
            { $addToSet: { media: mediaId } },
            { new: true }
        );

        if (!album) {
            return res.status(404).json({ error: 'Album not found' });
        }

        // Update media's albumId
        await Media.findByIdAndUpdate(mediaId, { albumId: album._id });

        // Set cover if first media
        if (album.media.length === 1) {
            album.coverUrl = media.url;
            await album.save();
        }

        const updatedAlbum = await Album.findById(albumId)
            .populate('media')
            .lean();

        res.json(updatedAlbum);
    } catch (err) {
        console.error('Error adding media to album:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== REMOVE MEDIA FROM ALBUM ====================
router.delete('/:albumId/remove-media/:mediaId', isAuth, async (req, res) => {
    try {
        const { albumId, mediaId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(albumId) || !mongoose.Types.ObjectId.isValid(mediaId)) {
            return res.status(400).json({ error: 'Invalid ID format' });
        }

        // Remove media from album
        const album = await Album.findOneAndUpdate(
            { _id: albumId, userId: req.user.id },
            { $pull: { media: mediaId } },
            { new: true }
        );

        if (!album) {
            return res.status(404).json({ error: 'Album not found' });
        }

        // Remove albumId from media
        await Media.findByIdAndUpdate(mediaId, { $unset: { albumId: 1 } });

        // Update cover if needed
        if (album.media.length === 0) {
            album.coverUrl = '';
            await album.save();
        } else {
            const firstMedia = await Media.findById(album.media[0]).lean();
            if (firstMedia && album.coverUrl !== firstMedia.url) {
                album.coverUrl = firstMedia.url;
                await album.save();
            }
        }

        res.json({ message: 'Media removed from album' });
    } catch (err) {
        console.error('Error removing media from album:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== MOVE MEDIA TO ALBUM/FOLDER ====================
router.post('/move-media', isAuth, async (req, res) => {
  try {
    const { mediaId, targetAlbumId } = req.body;

    if (!mediaId || !mongoose.Types.ObjectId.isValid(mediaId)) {
      return res.status(400).json({ error: 'Valid mediaId is required' });
    }

    if (targetAlbumId && !mongoose.Types.ObjectId.isValid(targetAlbumId)) {
      return res.status(400).json({ error: 'Invalid target album ID' });
    }

    // Get media
    const media = await Media.findOne({
      _id: mediaId,
      userId: req.user.id
    });

    if (!media) {
      return res.status(404).json({ error: 'Media not found' });
    }

    // Remove from current album
    if (media.albumId) {
      await Album.updateOne(
        { _id: media.albumId, userId: req.user.id },
        { $pull: { media: mediaId } }
      );
    }

    // Add to target album
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
      
      // Set cover if needed
      if (targetAlbum.media.length === 1) {
        targetAlbum.coverUrl = media.url;
        await targetAlbum.save();
      }
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

// ==================== BULK MOVE MEDIA ====================
router.post('/bulk-move-media', isAuth, async (req, res) => {
  try {
    const { mediaIds, targetAlbumId } = req.body;

    if (!mediaIds?.length) {
      return res.status(400).json({ error: 'mediaIds array is required' });
    }

    // Validate all media IDs
    const validIds = mediaIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length === 0) {
      return res.status(400).json({ error: 'No valid media IDs' });
    }

    // Remove from all current albums
    await Album.updateMany(
      { userId: req.user.id },
      { $pull: { media: { $in: validIds } } }
    );

    // Add to target album if specified
    if (targetAlbumId) {
      const targetAlbum = await Album.findOneAndUpdate(
        { _id: targetAlbumId, userId: req.user.id },
        { $addToSet: { media: { $each: validIds } } },
        { new: true }
      );

      if (!targetAlbum) {
        return res.status(404).json({ error: 'Target album not found' });
      }

      // Update all media with target album ID
      await Media.updateMany(
        { _id: { $in: validIds }, userId: req.user.id },
        { albumId: targetAlbumId }
      );

      // Set cover if needed
      if (targetAlbum.media.length === validIds.length) {
        const firstMedia = await Media.findOne({ _id: validIds[0] }).lean();
        if (firstMedia) {
          targetAlbum.coverUrl = firstMedia.url;
          await targetAlbum.save();
        }
      }
    } else {
      // Remove album ID from all media
      await Media.updateMany(
        { _id: { $in: validIds }, userId: req.user.id },
        { albumId: null }
      );
    }

    res.json({ 
      message: `Moved ${validIds.length} items successfully`,
      count: validIds.length
    });
  } catch (err) {
    console.error('Error bulk moving media:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== UPDATE ALBUM ====================
router.put('/:albumId', isAuth, async (req, res) => {
    try {
        const { albumId } = req.params;
        const { name, description, category, coverUrl } = req.body;

        if (!mongoose.Types.ObjectId.isValid(albumId)) {
            return res.status(400).json({ error: 'Invalid album ID' });
        }

        const album = await Album.findOneAndUpdate(
            { _id: albumId, userId: req.user.id },
            {
                $set: {
                    name,
                    description,
                    category,
                    coverUrl,
                    updatedAt: new Date()
                }
            },
            { new: true }
        ).populate('media').lean();

        if (!album) {
            return res.status(404).json({ error: 'Album not found' });
        }

        res.json(album);
    } catch (err) {
        console.error('Error updating album:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== MOVE ALBUM ====================
router.put('/:albumId/move', isAuth, async (req, res) => {
    try {
        const { albumId } = req.params;
        const { newParentId } = req.body;

        if (!mongoose.Types.ObjectId.isValid(albumId)) {
            return res.status(400).json({ error: 'Invalid album ID' });
        }

        // Check for circular reference
        if (newParentId && newParentId !== 'root') {
            if (!mongoose.Types.ObjectId.isValid(newParentId)) {
                return res.status(400).json({ error: 'Invalid parent ID' });
            }

            // Check if new parent exists
            const newParent = await Album.exists({
                _id: newParentId,
                userId: req.user.id
            });

            if (!newParent) {
                return res.status(404).json({ error: 'New parent folder not found' });
            }

            // Check for circular reference (simplified)
            if (newParentId === albumId) {
                return res.status(400).json({ error: 'Cannot move folder into itself' });
            }
        }

        const album = await Album.findOneAndUpdate(
            { _id: albumId, userId: req.user.id },
            {
                $set: {
                    parentAlbumId: newParentId === 'root' ? null : newParentId,
                    updatedAt: new Date()
                }
            },
            { new: true }
        ).lean();

        if (!album) {
            return res.status(404).json({ error: 'Album not found' });
        }

        res.json(album);
    } catch (err) {
        console.error('Error moving album:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==================== DELETE ALBUM ====================
router.delete('/:albumId', isAuth, async (req, res) => {
    try {
        const { albumId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(albumId)) {
            return res.status(400).json({ error: 'Invalid album ID' });
        }

        // Check if album exists
        const album = await Album.findOne({
            _id: albumId,
            userId: req.user.id
        });

        if (!album) {
            return res.status(404).json({ error: 'Album not found' });
        }

        // Delete all child folders recursively
        const deleteChildren = async (parentId) => {
            const children = await Album.find({ parentAlbumId: parentId });
            for (const child of children) {
                await deleteChildren(child._id);
                
                if (child.media?.length) {
                    await Media.updateMany(
                        { _id: { $in: child.media } },
                        { $unset: { albumId: 1 } }
                    );
                }
                
                await Album.findByIdAndDelete(child._id);
            }
        };

        await deleteChildren(albumId);

        // Remove album reference from media
        if (album.media?.length) {
            await Media.updateMany(
                { _id: { $in: album.media } },
                { $unset: { albumId: 1 } }
            );
        }

        // Delete the album itself
        await Album.findByIdAndDelete(albumId);

        res.json({ message: 'Album and all its contents deleted successfully' });
    } catch (err) {
        console.error('Error deleting album:', err);
        res.status(500).json({ error: err.message });
    }
});

export default router;