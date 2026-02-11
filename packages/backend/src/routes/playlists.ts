/**
 * Playlist Routes
 * Full CRUD for playlists + song management within playlists
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';

const router = Router();

// ─── GET /api/playlists — user's playlists ──────────────

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const playlists = await prisma.playlist.findMany({
      where: {
        OR: [
          { userId: req.user!.userId },
          { isPublic: true, isSystem: true },
        ],
      },
      include: {
        _count: { select: { songs: true } },
        songs: {
          take: 4,
          orderBy: { position: 'asc' },
          include: { song: { select: { imageUrl: true, localCoverPath: true, name: true } } },
        },
      },
      orderBy: [{ isSystem: 'desc' }, { updatedAt: 'desc' }],
    });

    res.json({
      playlists: playlists.map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        coverUrl: p.coverUrl,
        isPublic: p.isPublic,
        isSystem: p.isSystem,
        songCount: p._count.songs,
        previewImages: p.songs.map(s => s.song.localCoverPath || s.song.imageUrl).filter(Boolean).slice(0, 4),
        isOwner: p.userId === req.user!.userId,
        updatedAt: p.updatedAt,
      })),
    });
  } catch (err) {
    console.error('List playlists error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/playlists — create ───────────────────────

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(''),
  isPublic: z.boolean().default(true),
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = createSchema.parse(req.body);

    const playlist = await prisma.playlist.create({
      data: {
        name: body.name,
        description: body.description,
        isPublic: body.isPublic,
        userId: req.user!.userId,
      },
    });

    res.status(201).json({ playlist });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.errors });
      return;
    }
    console.error('Create playlist error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/playlists/:id — full playlist with songs ──

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const playlist = await prisma.playlist.findUnique({
      where: { id: req.params.id },
      include: {
        songs: {
          orderBy: { position: 'asc' },
          include: {
            song: {
              include: {
                era: { select: { name: true } },
                lyricsVersions: { where: { isCanonical: true }, take: 1, select: { id: true } },
              },
            },
          },
        },
        user: { select: { displayName: true } },
      },
    });

    if (!playlist) {
      res.status(404).json({ error: 'Playlist not found' });
      return;
    }

    // Check access
    if (!playlist.isPublic && playlist.userId !== req.user!.userId) {
      res.status(403).json({ error: 'Private playlist' });
      return;
    }

    res.json({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      coverUrl: playlist.coverUrl,
      isPublic: playlist.isPublic,
      isSystem: playlist.isSystem,
      isOwner: playlist.userId === req.user!.userId,
      createdBy: playlist.user.displayName,
      songs: playlist.songs.map(ps => ({
        playlistSongId: ps.id,
        position: ps.position,
        addedAt: ps.addedAt,
        id: ps.song.id,
        externalId: ps.song.externalId,
        name: ps.song.name,
        category: ps.song.category,
        era: ps.song.era?.name || null,
        creditedArtists: ps.song.creditedArtists,
        producers: ps.song.producers,
        length: ps.song.length,
        imageUrl: ps.song.imageUrl,
        localCoverPath: ps.song.localCoverPath,
        isAvailable: ps.song.isAvailable,
        hasFilePath: !!ps.song.filePath,
        playCount: ps.song.playCount,
        hasLyrics: ps.song.lyricsVersions.length > 0,
        hasRawLyrics: (ps.song.rawLyrics?.length || 0) > 0,
      })),
    });
  } catch (err) {
    console.error('Get playlist error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /api/playlists/:id — update ────────────────────

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  isPublic: z.boolean().optional(),
});

router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = updateSchema.parse(req.body);
    const playlist = await prisma.playlist.findUnique({ where: { id: req.params.id } });

    if (!playlist || playlist.userId !== req.user!.userId) {
      res.status(404).json({ error: 'Playlist not found' });
      return;
    }

    if (playlist.isSystem) {
      res.status(403).json({ error: 'Cannot modify system playlists' });
      return;
    }

    const updated = await prisma.playlist.update({
      where: { id: req.params.id },
      data: body,
    });

    res.json({ playlist: updated });
  } catch (err) {
    console.error('Update playlist error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /api/playlists/:id ──────────────────────────

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const playlist = await prisma.playlist.findUnique({ where: { id: req.params.id } });

    if (!playlist || playlist.userId !== req.user!.userId) {
      res.status(404).json({ error: 'Playlist not found' });
      return;
    }

    if (playlist.isSystem) {
      res.status(403).json({ error: 'Cannot delete system playlists' });
      return;
    }

    await prisma.playlist.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete playlist error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/playlists/:id/songs — add song ──────────

const addSongSchema = z.object({
  songId: z.string().uuid(),
});

router.post('/:id/songs', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = addSongSchema.parse(req.body);
    const playlist = await prisma.playlist.findUnique({ where: { id: req.params.id } });

    if (!playlist || playlist.userId !== req.user!.userId) {
      res.status(404).json({ error: 'Playlist not found' });
      return;
    }

    // Get next position
    const maxPos = await prisma.playlistSong.aggregate({
      where: { playlistId: req.params.id },
      _max: { position: true },
    });

    const ps = await prisma.playlistSong.create({
      data: {
        playlistId: req.params.id,
        songId: body.songId,
        position: (maxPos._max.position || 0) + 1,
      },
    });

    res.status(201).json({ playlistSong: ps });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      res.status(409).json({ error: 'Song already in playlist' });
      return;
    }
    console.error('Add to playlist error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DELETE /api/playlists/:id/songs/:songId ────────────

router.delete('/:id/songs/:songId', requireAuth, async (req: Request, res: Response) => {
  try {
    const playlist = await prisma.playlist.findUnique({ where: { id: req.params.id } });

    if (!playlist || playlist.userId !== req.user!.userId) {
      res.status(404).json({ error: 'Playlist not found' });
      return;
    }

    await prisma.playlistSong.deleteMany({
      where: {
        playlistId: req.params.id,
        songId: req.params.songId,
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Remove from playlist error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/songs/:songId/like — like/dislike/remove ─

const likeSchema = z.object({
  liked: z.boolean().nullable(), // true=like, false=dislike, null=remove
});

router.post('/like/:songId', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = likeSchema.parse(req.body);

    if (body.liked === null) {
      // Remove like/dislike
      await prisma.songLike.deleteMany({
        where: { userId: req.user!.userId, songId: req.params.songId },
      });
      res.json({ status: 'removed' });
      return;
    }

    // Upsert like/dislike
    const like = await prisma.songLike.upsert({
      where: {
        userId_songId: {
          userId: req.user!.userId,
          songId: req.params.songId,
        },
      },
      update: { liked: body.liked },
      create: {
        userId: req.user!.userId,
        songId: req.params.songId,
        liked: body.liked,
      },
    });

    res.json({ status: like.liked ? 'liked' : 'disliked' });
  } catch (err) {
    console.error('Like error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/playlists/likes/me — get user's likes ─────

router.get('/likes/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const likes = await prisma.songLike.findMany({
      where: { userId: req.user!.userId },
      select: { songId: true, liked: true },
    });

    const likeMap: Record<string, boolean> = {};
    for (const l of likes) {
      likeMap[l.songId] = l.liked;
    }

    res.json({ likes: likeMap });
  } catch (err) {
    console.error('Get likes error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
