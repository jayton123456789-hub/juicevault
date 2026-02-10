import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { requireAuth, requirePlaybackEnabled } from '../middleware/auth';
import { getJuiceApi } from '../services/juice-api';

const router = Router();

// ─── GET /api/songs/categories ──────────────────────────
// Returns distinct categories with counts (for filter chips)
// MUST be before /:id route

router.get('/categories', requireAuth, async (_req: Request, res: Response) => {
  try {
    const results = await prisma.song.groupBy({
      by: ['category'],
      _count: { category: true },
      orderBy: { category: 'asc' },
    });

    const categories: string[] = [];
    const counts: Record<string, number> = {};
    for (const r of results) {
      if (r.category) {
        categories.push(r.category);
        counts[r.category] = r._count.category;
      }
    }

    res.json({ categories, counts });
  } catch (err) {
    console.error('Categories error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/songs/by-external/:externalId ─────────────
// Lookup a song by its external API ID (integer)
// Used by radio mode to find songs in local DB
// MUST be before /:id route

router.get('/by-external/:externalId', requireAuth, async (req: Request, res: Response) => {
  try {
    const externalId = parseInt(req.params.externalId, 10);
    if (isNaN(externalId)) {
      res.status(400).json({ error: 'Invalid external ID' });
      return;
    }

    const song = await prisma.song.findUnique({
      where: { externalId },
      include: {
        era: true,
        aliases: true,
        lyricsVersions: {
          where: { isCanonical: true },
          take: 1,
        },
      },
    });

    if (!song) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }

    res.json({
      id: song.id,
      externalId: song.externalId,
      name: song.name,
      category: song.category,
      era: song.era,
      creditedArtists: song.creditedArtists,
      producers: song.producers,
      length: song.length,
      durationMs: song.durationMs,
      imageUrl: song.imageUrl,
      isAvailable: song.isAvailable,
      hasFilePath: !!song.filePath,
      playCount: song.playCount,
      rawLyrics: song.rawLyrics,
      canonicalLyrics: song.lyricsVersions[0] || null,
    });
  } catch (err) {
    console.error('By-external lookup error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/songs ─────────────────────────────────────
// Browse our local catalog (synced from API).
// Supports pagination, category/era filtering, text search,
// and excludeCategories param for "All" view.

const listSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
  category: z.string().optional(),
  era: z.string().optional(),
  search: z.string().optional(),
  excludeCategories: z.string().optional(), // comma-separated: "unsurfaced,recording_session"
  sortBy: z.enum(['name', 'playCount', 'createdAt']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  hasLyrics: z.coerce.boolean().optional(),
});

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const params = listSchema.parse(req.query);

    const where: any = {};
    if (params.category) where.category = params.category;
    if (params.era) where.era = { name: params.era };

    // Exclude specific categories (used by "All" to hide unsurfaced/sessions)
    if (params.excludeCategories) {
      const excluded = params.excludeCategories.split(',').map(s => s.trim()).filter(Boolean);
      if (excluded.length) {
        where.category = where.category
          ? where.category  // If specific category is set, that takes priority
          : { notIn: excluded };
      }
    }

    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { creditedArtists: { contains: params.search, mode: 'insensitive' } },
        { producers: { contains: params.search, mode: 'insensitive' } },
        { aliases: { some: { alias: { contains: params.search, mode: 'insensitive' } } } },
      ];
    }

    // Filter for songs with lyrics
    if (params.hasLyrics) {
      where.rawLyrics = { not: '' };
    }

    // Dynamic sort
    let orderBy: any = { name: 'asc' };
    if (params.sortBy) {
      orderBy = { [params.sortBy]: params.sortOrder || 'asc' };
    }

    const [songs, total] = await Promise.all([
      prisma.song.findMany({
        where,
        include: {
          era: { select: { id: true, name: true, timeFrame: true } },
          aliases: { select: { alias: true, isPrimary: true } },
          lyricsVersions: {
            where: { isCanonical: true },
            select: { id: true, versionNumber: true },
            take: 1,
          },
        },
        orderBy,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      prisma.song.count({ where }),
    ]);

    res.json({
      songs: songs.map((s) => ({
        id: s.id,
        externalId: s.externalId,
        name: s.name,
        category: s.category,
        era: s.era ? { id: s.era.id, name: s.era.name, timeFrame: s.era.timeFrame } : null,
        aliases: s.aliases.map((a) => a.alias),
        length: s.length,
        durationMs: s.durationMs,
        creditedArtists: s.creditedArtists,
        producers: s.producers,
        isAvailable: s.isAvailable,
        hasFilePath: !!s.filePath,
        playCount: s.playCount,
        hasLyrics: s.lyricsVersions.length > 0,
        hasRawLyrics: s.rawLyrics.length > 0,
        imageUrl: s.imageUrl,
        leakType: s.leakType,
      })),
      pagination: {
        page: params.page,
        pageSize: params.pageSize,
        total,
        totalPages: Math.ceil(total / params.pageSize),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid parameters', details: err.errors });
      return;
    }
    console.error('List songs error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/songs/:id ─────────────────────────────────
// Full song detail including raw lyrics and canonical timed lyrics.

router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const song = await prisma.song.findUnique({
      where: { id: req.params.id },
      include: {
        era: true,
        aliases: true,
        lyricsVersions: {
          where: { isCanonical: true },
          take: 1,
        },
      },
    });

    if (!song) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }

    res.json({
      id: song.id,
      externalId: song.externalId,
      publicId: song.publicId,
      name: song.name,
      category: song.category,
      era: song.era,
      aliases: song.aliases.map((a) => ({ alias: a.alias, isPrimary: a.isPrimary })),
      creditedArtists: song.creditedArtists,
      producers: song.producers,
      engineers: song.engineers,
      recordingLocation: song.recordingLocation,
      recordDates: song.recordDates,
      length: song.length,
      durationMs: song.durationMs,
      bitrate: song.bitrate,
      additionalInfo: song.additionalInfo,
      previewDate: song.previewDate,
      releaseDate: song.releaseDate,
      dateLeaked: song.dateLeaked,
      leakType: song.leakType,
      imageUrl: song.imageUrl,
      isAvailable: song.isAvailable,
      hasFilePath: !!song.filePath,
      playCount: song.playCount,
      rawLyrics: song.rawLyrics,
      canonicalLyrics: song.lyricsVersions[0] || null,
    });
  } catch (err) {
    console.error('Get song error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/songs/:id/lyrics/:lyricsId ────────────────
// Return a specific lyrics version with full lyricsData (timed lines)

router.get('/:id/lyrics/:lyricsId', requireAuth, async (req: Request, res: Response) => {
  try {
    const lv = await prisma.lyricsVersion.findFirst({
      where: {
        id: req.params.lyricsId,
        songId: req.params.id,
      },
    });

    if (!lv) {
      res.status(404).json({ error: 'Lyrics version not found' });
      return;
    }

    res.json({
      id: lv.id,
      versionNumber: lv.versionNumber,
      source: lv.source,
      status: lv.status,
      isCanonical: lv.isCanonical,
      lyricsData: lv.lyricsData, // The timed lyrics JSON array
    });
  } catch (err) {
    console.error('Get lyrics version error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/songs/:id/stream ──────────────────────────
router.get(
  '/:id/stream',
  requireAuth,
  requirePlaybackEnabled,
  async (req: Request, res: Response) => {
    try {
      const song = await prisma.song.findUnique({
        where: { id: req.params.id },
        select: { id: true, filePath: true, isAvailable: true, externalId: true },
      });

      if (!song) {
        res.status(404).json({ error: 'Song not found' });
        return;
      }

      if (!song.filePath) {
        res.status(404).json({ error: 'This song has no playable audio file' });
        return;
      }

      if (!song.isAvailable) {
        res.status(410).json({ error: 'This track is currently unavailable' });
        return;
      }

      const api = getJuiceApi();
      const rangeHeader = req.headers.range;

      let audioResponse: any;
      try {
        audioResponse = await api.fetchAudioStream(song.filePath, rangeHeader);
      } catch (err) {
        console.error(`Audio proxy failed for ${song.id} (path: ${song.filePath}):`, err);
        await prisma.song.update({
          where: { id: song.id },
          data: { isAvailable: false, lastHealthCheck: new Date() },
        }).catch(() => {});
        res.status(502).json({ error: 'Audio source is currently unavailable' });
        return;
      }

      res.status(audioResponse.status);
      const headersToForward = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
      for (const header of headersToForward) {
        const value = audioResponse.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      res.setHeader('Cache-Control', 'no-store, no-cache');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      if (audioResponse.body) {
        const reader = audioResponse.body.getReader();
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!res.writableEnded) res.write(Buffer.from(value));
            }
          } catch (pipeErr) {
            // Client disconnected
          } finally {
            if (!res.writableEnded) res.end();
          }
        };
        pump();
      } else {
        res.end();
      }

      prisma.song.update({
        where: { id: song.id },
        data: { playCount: { increment: 1 }, lastHealthCheck: new Date(), isAvailable: true },
      }).catch(() => {});

    } catch (err) {
      console.error('Stream error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Streaming error' });
    }
  }
);

// ─── GET /api/songs/:id/cover-art ───────────────────────
router.get('/:id/cover-art', requireAuth, async (req: Request, res: Response) => {
  try {
    const song = await prisma.song.findUnique({
      where: { id: req.params.id },
      select: { filePath: true },
    });

    if (!song?.filePath) {
      res.status(404).json({ error: 'No cover art available' });
      return;
    }

    const api = getJuiceApi();
    const artResponse = await api.fetchCoverArt(song.filePath);

    const contentType = artResponse.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    if (artResponse.body) {
      const reader = artResponse.body.getReader();
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } finally {
          res.end();
        }
      };
      pump();
    } else {
      res.end();
    }
  } catch (err) {
    console.error('Cover art error:', err);
    if (!res.headersSent) res.status(404).json({ error: 'Cover art not available' });
  }
});

// ─── POST /api/songs/:id/report ─────────────────────────
const reportSchema = z.object({
  reason: z.string().min(5).max(500),
});

router.post('/:id/report', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = reportSchema.parse(req.body);
    const song = await prisma.song.findUnique({ where: { id: req.params.id } });

    if (!song) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }

    const report = await prisma.brokenTrackReport.create({
      data: {
        songId: song.id,
        reportedBy: req.user!.userId,
        reason: body.reason,
      },
    });

    res.status(201).json({ report: { id: report.id, status: report.status } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.errors });
      return;
    }
    console.error('Report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/songs/:id/regen-lyrics ───────────────────
// Re-generate timed lyrics via AssemblyAI for a single song.
// Requires admin or trusted_contributor role.

router.post('/:id/regen-lyrics', requireAuth, async (req: Request, res: Response) => {
  try {
    // Only admins and trusted contributors can regen
    if (req.user!.role !== 'admin' && req.user!.role !== 'trusted_contributor') {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    const song = await prisma.song.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, filePath: true, rawLyrics: true, isAvailable: true },
    });

    if (!song) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }
    if (!song.filePath) {
      res.status(400).json({ error: 'Song has no audio file path' });
      return;
    }
    if (!song.rawLyrics || song.rawLyrics.trim().length < 20) {
      res.status(400).json({ error: 'Song has no/insufficient lyrics to align' });
      return;
    }

    // Build audio URL for AssemblyAI
    const API_BASE = process.env.JUICEWRLD_API_BASE || 'https://juicewrldapi.com/juicewrld';
    const audioUrl = `${API_BASE}/files/download/?path=${encodeURIComponent(song.filePath)}`;

    // Dynamic import to avoid loading AssemblyAI key at module load
    const { generateTimedLyrics } = await import('../services/lyric-aligner');
    const result = await generateTimedLyrics(audioUrl, song.rawLyrics);

    if (!result || !result.timedLines.length) {
      res.status(422).json({ error: 'AssemblyAI could not generate timing for this song' });
      return;
    }

    // Delete existing canonical versions, then create new one
    await prisma.lyricsVersion.updateMany({
      where: { songId: song.id, isCanonical: true },
      data: { isCanonical: false },
    });

    // Get next version number
    const lastVersion = await prisma.lyricsVersion.findFirst({
      where: { songId: song.id },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });

    const newVersion = await prisma.lyricsVersion.create({
      data: {
        songId: song.id,
        authorId: req.user!.userId,
        versionNumber: (lastVersion?.versionNumber || 0) + 1,
        status: 'approved',
        lyricsData: result.timedLines as any,
        source: 'auto_generated',
        isCanonical: true,
        reviewedBy: req.user!.userId,
        reviewedAt: new Date(),
      },
    });

    console.log(`[REGEN] ${song.name}: ${result.timedLines.length} timed lines (v${newVersion.versionNumber})`);

    res.json({
      success: true,
      lyricsVersionId: newVersion.id,
      versionNumber: newVersion.versionNumber,
      lineCount: result.timedLines.length,
    });
  } catch (err: any) {
    console.error('Regen lyrics error:', err);
    res.status(500).json({ error: err.message || 'Failed to regenerate lyrics' });
  }
});

export default router;
