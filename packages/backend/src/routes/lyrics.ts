import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import prisma from '../config/database';
import { requireAuth, requireRole } from '../middleware/auth';
import { fetchGeniusLyrics } from '../services/genius-api';

const router = Router();

// ─── Types ──────────────────────────────────────────────

interface TimedLine {
  id: string;
  start_ms: number;
  end_ms?: number;
  text: string;
  confidence: number;
}

// ─── GET /api/songs/:songId/lyrics ──────────────────────
// Returns the canonical (approved) timed lyrics version, or null.

router.get('/:songId/lyrics', requireAuth, async (req: Request, res: Response) => {
  try {
    const canonical = await prisma.lyricsVersion.findFirst({
      where: { songId: req.params.songId, isCanonical: true },
      include: { author: { select: { id: true, displayName: true } } },
      orderBy: { versionNumber: 'desc' },
    });

    const fallbackApproved = canonical ? null : await prisma.lyricsVersion.findFirst({
      where: { songId: req.params.songId, status: 'approved' },
      include: { author: { select: { id: true, displayName: true } } },
      orderBy: { versionNumber: 'desc' },
    });

    const effectiveLyrics = canonical ?? fallbackApproved;

    if (!effectiveLyrics) {
      // Fall back: return raw lyrics from API if available
      const song = await prisma.song.findUnique({
        where: { id: req.params.songId },
        select: { rawLyrics: true },
      });

      if (song?.rawLyrics) {
        res.json({
          canonical: null,
          rawLyrics: song.rawLyrics,
          message: 'No timed lyrics yet. Raw lyrics from the database are available.',
        });
        return;
      }

      // Fallback: try Genius on demand for songs that still have no lyrics.
      // This makes lyric fetch behavior immediate for users without requiring a separate cron job.
      const songWithName = await prisma.song.findUnique({
        where: { id: req.params.songId },
        select: { id: true, name: true },
      });

      if (songWithName?.name) {
        const geniusResult = await fetchGeniusLyrics(songWithName.name);
        if (geniusResult) {
          await prisma.song.update({
            where: { id: songWithName.id },
            data: {
              rawLyrics: geniusResult.lyrics,
              additionalInfo: `Lyrics source: Genius (${geniusResult.geniusUrl})`,
            },
          });

          res.json({
            canonical: null,
            rawLyrics: geniusResult.lyrics,
            message: 'No timed lyrics yet. Raw lyrics were fetched from Genius.',
          });
          return;
        }
      }

      res.json({ canonical: null, rawLyrics: null });
      return;
    }

    res.json({
      canonical: {
        id: effectiveLyrics.id,
        versionNumber: effectiveLyrics.versionNumber,
        lyricsData: effectiveLyrics.lyricsData,
        source: effectiveLyrics.source,
        author: effectiveLyrics.author,
        createdAt: effectiveLyrics.createdAt,
      },
      rawLyrics: null, // Not needed when timed lyrics exist
    });
  } catch (err) {
    console.error('Get lyrics error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/songs/:songId/lyrics/versions ─────────────
// List all versions for a song (for editor history).

router.get('/:songId/lyrics/versions', requireAuth, async (req: Request, res: Response) => {
  try {
    const versions = await prisma.lyricsVersion.findMany({
      where: { songId: req.params.songId },
      include: {
        author: { select: { id: true, displayName: true } },
        reviewer: { select: { id: true, displayName: true } },
      },
      orderBy: { versionNumber: 'desc' },
    });

    res.json({
      versions: versions.map((v) => ({
        id: v.id,
        versionNumber: v.versionNumber,
        status: v.status,
        source: v.source,
        author: v.author,
        reviewer: v.reviewer,
        reviewNotes: v.reviewNotes,
        isCanonical: v.isCanonical,
        lineCount: Array.isArray(v.lyricsData) ? (v.lyricsData as unknown[]).length : 0,
        createdAt: v.createdAt,
        reviewedAt: v.reviewedAt,
      })),
    });
  } catch (err) {
    console.error('List versions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/songs/:songId/lyrics/versions/:versionId ──
// Get a specific version's full data (for loading in editor).

router.get('/:songId/lyrics/versions/:versionId', requireAuth, async (req: Request, res: Response) => {
  try {
    const version = await prisma.lyricsVersion.findFirst({
      where: { id: req.params.versionId, songId: req.params.songId },
      include: {
        author: { select: { id: true, displayName: true } },
        reviewer: { select: { id: true, displayName: true } },
      },
    });

    if (!version) {
      res.status(404).json({ error: 'Version not found' });
      return;
    }

    res.json({ version });
  } catch (err) {
    console.error('Get version error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/songs/:songId/lyrics ─────────────────────
// Create a new lyrics version (draft).
// Accepts either:
//   a) Full timed lines array
//   b) Import from raw API lyrics (splits text into untimed lines)

const createSchema = z.object({
  lyricsData: z.array(z.object({
    id: z.string(),
    start_ms: z.number().min(0),
    end_ms: z.number().optional(),
    text: z.string(),
    confidence: z.number().min(0).max(1),
  })).optional(),
  importFromRaw: z.boolean().optional(),
  source: z.enum(['manual', 'auto_generated', 'imported_lrc', 'imported_api']).default('manual'),
});

router.post('/:songId/lyrics', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = createSchema.parse(req.body);
    const songId = req.params.songId;

    const song = await prisma.song.findUnique({ where: { id: songId } });
    if (!song) {
      res.status(404).json({ error: 'Song not found' });
      return;
    }

    let lyricsData: TimedLine[];

    if (body.importFromRaw) {
      // Import from API raw lyrics — split into lines, no timing yet
      if (!song.rawLyrics || song.rawLyrics.trim().length === 0) {
        res.status(400).json({ error: 'This song has no raw lyrics to import' });
        return;
      }

      const lines = song.rawLyrics
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      lyricsData = lines.map((text, i) => ({
        id: `l${i + 1}`,
        start_ms: 0,     // Untimed — user will add timing in the editor
        text,
        confidence: 0,   // 0 = untimed
      }));
    } else if (body.lyricsData && body.lyricsData.length > 0) {
      lyricsData = body.lyricsData;
    } else {
      res.status(400).json({ error: 'Provide lyricsData array or set importFromRaw: true' });
      return;
    }

    // Determine next version number
    const latestVersion = await prisma.lyricsVersion.findFirst({
      where: { songId },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });
    const nextVersion = (latestVersion?.versionNumber ?? 0) + 1;

    const version = await prisma.lyricsVersion.create({
      data: {
        songId,
        authorId: req.user!.userId,
        versionNumber: nextVersion,
        status: 'draft',
        lyricsData: lyricsData as any,
        source: body.importFromRaw ? 'imported_api' : body.source,
      },
    });

    res.status(201).json({
      version: {
        id: version.id,
        versionNumber: version.versionNumber,
        status: version.status,
        lineCount: lyricsData.length,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.errors });
      return;
    }
    console.error('Create lyrics error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /api/songs/:songId/lyrics/:versionId ──────────
// Update a draft version (autosave from editor).
// Only the author can update their own draft.

const updateSchema = z.object({
  lyricsData: z.array(z.object({
    id: z.string(),
    start_ms: z.number().min(0),
    end_ms: z.number().optional(),
    text: z.string(),
    confidence: z.number().min(0).max(1),
  })),
});

router.put('/:songId/lyrics/:versionId', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = updateSchema.parse(req.body);

    const version = await prisma.lyricsVersion.findFirst({
      where: { id: req.params.versionId, songId: req.params.songId },
    });

    if (!version) {
      res.status(404).json({ error: 'Version not found' });
      return;
    }

    if (version.status !== 'draft') {
      res.status(400).json({ error: 'Can only edit draft versions' });
      return;
    }

    if (version.authorId !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Can only edit your own drafts' });
      return;
    }

    await prisma.lyricsVersion.update({
      where: { id: version.id },
      data: { lyricsData: body.lyricsData as any },
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.errors });
      return;
    }
    console.error('Update lyrics error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /api/songs/:songId/lyrics/:versionId/submit ────
// Submit a draft for review.
// Validation: at least 70% of lines must be timed (start_ms > 0).

router.put('/:songId/lyrics/:versionId/submit', requireAuth, async (req: Request, res: Response) => {
  try {
    const version = await prisma.lyricsVersion.findFirst({
      where: { id: req.params.versionId, songId: req.params.songId },
    });

    if (!version) {
      res.status(404).json({ error: 'Version not found' });
      return;
    }

    if (version.status !== 'draft') {
      res.status(400).json({ error: 'Can only submit drafts' });
      return;
    }

    if (version.authorId !== req.user!.userId && req.user!.role !== 'admin') {
      res.status(403).json({ error: 'Can only submit your own drafts' });
      return;
    }

    // Validate: 70% of lines must be timed
    const lines = version.lyricsData as unknown as TimedLine[];
    const timedCount = lines.filter((l) => l.start_ms > 0).length;
    const timedPercent = lines.length > 0 ? timedCount / lines.length : 0;

    if (timedPercent < 0.7) {
      res.status(400).json({
        error: `At least 70% of lines must be timed. Currently: ${Math.round(timedPercent * 100)}% (${timedCount}/${lines.length})`,
      });
      return;
    }

    // Warn about long lines (>12s) but don't block
    const warnings: string[] = [];
    for (const line of lines) {
      if (line.end_ms && line.end_ms - line.start_ms > 12000) {
        warnings.push(`Line "${line.text.slice(0, 30)}..." exceeds 12 seconds`);
      }
    }

    // Check for overlaps
    const sorted = [...lines].filter(l => l.start_ms > 0).sort((a, b) => a.start_ms - b.start_ms);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start_ms < (sorted[i - 1].end_ms ?? sorted[i - 1].start_ms)) {
        warnings.push(`Overlap detected near "${sorted[i].text.slice(0, 30)}..."`);
      }
    }

    // Trusted contributors auto-publish; others go to pending_review
    const userRole = req.user!.role;
    const autoApprove = userRole === 'admin' || userRole === 'trusted_contributor';

    if (autoApprove) {
      await prisma.$transaction([
        prisma.lyricsVersion.updateMany({
          where: { songId: req.params.songId, isCanonical: true },
          data: { isCanonical: false },
        }),
        prisma.lyricsVersion.update({
          where: { id: version.id },
          data: {
            status: 'approved',
            isCanonical: true,
            reviewedBy: req.user!.userId,
            reviewedAt: new Date(),
          },
        }),
      ]);

      res.json({ status: 'approved', isCanonical: true, autoApproved: true, warnings });
    } else {
      await prisma.lyricsVersion.update({
        where: { id: version.id },
        data: { status: 'pending_review' },
      });

      res.json({ status: 'pending_review', isCanonical: false, autoApproved: false, warnings });
    }
  } catch (err) {
    console.error('Submit lyrics error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /api/songs/:songId/lyrics/:versionId/approve ───

router.put(
  '/:songId/lyrics/:versionId/approve',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const version = await prisma.lyricsVersion.findFirst({
        where: { id: req.params.versionId, songId: req.params.songId },
      });

      if (!version) { res.status(404).json({ error: 'Version not found' }); return; }
      if (version.status !== 'pending_review') { res.status(400).json({ error: 'Can only approve pending submissions' }); return; }

      await prisma.$transaction([
        prisma.lyricsVersion.updateMany({
          where: { songId: req.params.songId, isCanonical: true },
          data: { isCanonical: false },
        }),
        prisma.lyricsVersion.update({
          where: { id: version.id },
          data: {
            status: 'approved', isCanonical: true,
            reviewedBy: req.user!.userId, reviewedAt: new Date(),
            reviewNotes: req.body.notes || null,
          },
        }),
      ]);

      await prisma.user.update({
        where: { id: version.authorId },
        data: { reputationScore: { increment: 5 } },
      }).catch(() => {});

      res.json({ success: true, status: 'approved', isCanonical: true });
    } catch (err) {
      console.error('Approve error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── PUT /api/songs/:songId/lyrics/:versionId/reject ────

router.put(
  '/:songId/lyrics/:versionId/reject',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const version = await prisma.lyricsVersion.findFirst({
        where: { id: req.params.versionId, songId: req.params.songId },
      });

      if (!version) { res.status(404).json({ error: 'Version not found' }); return; }

      await prisma.lyricsVersion.update({
        where: { id: version.id },
        data: {
          status: 'rejected', reviewedBy: req.user!.userId,
          reviewedAt: new Date(), reviewNotes: req.body.notes || 'Rejected by admin',
        },
      });

      res.json({ success: true, status: 'rejected' });
    } catch (err) {
      console.error('Reject error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ─── PUT /api/songs/:songId/lyrics/:versionId/revert ────

router.put(
  '/:songId/lyrics/:versionId/revert',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response) => {
    try {
      const version = await prisma.lyricsVersion.findFirst({
        where: { id: req.params.versionId, songId: req.params.songId },
      });

      if (!version) { res.status(404).json({ error: 'Version not found' }); return; }

      await prisma.$transaction([
        prisma.lyricsVersion.updateMany({
          where: { songId: req.params.songId, isCanonical: true },
          data: { isCanonical: false },
        }),
        prisma.lyricsVersion.update({
          where: { id: version.id },
          data: {
            isCanonical: true, status: 'approved',
            reviewedBy: req.user!.userId, reviewedAt: new Date(),
            reviewNotes: `Reverted to version ${version.versionNumber} by admin`,
          },
        }),
      ]);

      res.json({ success: true, reverted_to: version.versionNumber });
    } catch (err) {
      console.error('Revert error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
