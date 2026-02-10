import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import prisma from '../config/database';
import { requireAuth, requireRole } from '../middleware/auth';

const router = Router();

// All admin routes require admin role
router.use(requireAuth, requireRole('admin'));

// ─── GET /api/admin/settings ────────────────────────────

router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const settings = await prisma.appSetting.findMany();
    const map: Record<string, unknown> = {};
    for (const s of settings) {
      map[s.key] = s.value;
    }

    // Ensure defaults exist
    if (!('playback_enabled' in map)) map['playback_enabled'] = true;
    if (!('invites_enabled' in map)) map['invites_enabled'] = true;

    res.json({ settings: map });
  } catch (err) {
    console.error('Get settings error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /api/admin/settings/:key ───────────────────────
// Update any setting. The KILL SWITCH is: PUT /api/admin/settings/playback_enabled

router.put('/settings/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      res.status(400).json({ error: 'value is required' });
      return;
    }

    const setting = await prisma.appSetting.upsert({
      where: { key },
      create: { key, value, updatedBy: req.user!.userId },
      update: { value, updatedBy: req.user!.userId },
    });

    console.log(`[ADMIN] Setting "${key}" updated to ${JSON.stringify(value)} by ${req.user!.email}`);

    res.json({ key: setting.key, value: setting.value });
  } catch (err) {
    console.error('Update setting error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/admin/users ───────────────────────────────

router.get('/users', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        select: {
          id: true,
          email: true,
          displayName: true,
          role: true,
          reputationScore: true,
          isActive: true,
          createdAt: true,
          _count: { select: { lyricsVersions: true, songComments: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.user.count(),
    ]);

    res.json({
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        reputationScore: u.reputationScore,
        isActive: u.isActive,
        createdAt: u.createdAt,
        lyricsCount: u._count.lyricsVersions,
        commentsCount: u._count.songComments,
      })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /api/admin/users/:id/role ──────────────────────

const roleSchema = z.object({
  role: z.enum(['admin', 'trusted_contributor', 'user']),
});

router.put('/users/:id/role', async (req: Request, res: Response) => {
  try {
    const body = roleSchema.parse(req.body);

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { role: body.role },
      select: { id: true, email: true, role: true },
    });

    console.log(`[ADMIN] User ${user.email} role changed to ${body.role} by ${req.user!.email}`);
    res.json({ user });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid role', details: err.errors });
      return;
    }
    console.error('Update role error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /api/admin/users/:id/active ────────────────────

router.put('/users/:id/active', async (req: Request, res: Response) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      res.status(400).json({ error: 'isActive must be a boolean' });
      return;
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive },
      select: { id: true, email: true, isActive: true },
    });

    console.log(`[ADMIN] User ${user.email} ${isActive ? 'activated' : 'deactivated'} by ${req.user!.email}`);
    res.json({ user });
  } catch (err) {
    console.error('Toggle active error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/admin/invites ────────────────────────────

const inviteSchema = z.object({
  expiresInDays: z.number().min(1).max(90).default(7),
  count: z.number().min(1).max(20).default(1),
});

router.post('/invites', async (req: Request, res: Response) => {
  try {
    const body = inviteSchema.parse(req.body);
    const expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000);

    const invites = [];
    for (let i = 0; i < body.count; i++) {
      const code = uuid().replace(/-/g, '').slice(0, 12).toUpperCase();
      const invite = await prisma.invite.create({
        data: {
          code,
          createdBy: req.user!.userId,
          expiresAt,
        },
      });
      invites.push({ code: invite.code, expiresAt: invite.expiresAt });
    }

    res.status(201).json({ invites });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.errors });
      return;
    }
    console.error('Create invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/admin/invites ─────────────────────────────

router.get('/invites', async (_req: Request, res: Response) => {
  try {
    const invites = await prisma.invite.findMany({
      include: {
        creator: { select: { displayName: true } },
        user: { select: { displayName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    res.json({
      invites: invites.map((i) => ({
        code: i.code,
        createdBy: i.creator.displayName,
        usedBy: i.user ? { name: i.user.displayName, email: i.user.email } : null,
        expiresAt: i.expiresAt,
        createdAt: i.createdAt,
        isExpired: i.expiresAt < new Date(),
        isUsed: !!i.usedBy,
      })),
    });
  } catch (err) {
    console.error('List invites error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/admin/lyrics/pending ──────────────────────

router.get('/lyrics/pending', async (_req: Request, res: Response) => {
  try {
    const pending = await prisma.lyricsVersion.findMany({
      where: { status: 'pending_review' },
      include: {
        song: { select: { id: true, name: true, category: true } },
        author: { select: { id: true, displayName: true, reputationScore: true } },
      },
      orderBy: { createdAt: 'asc' }, // Oldest first
    });

    res.json({
      pending: pending.map((v) => ({
        id: v.id,
        song: v.song,
        author: v.author,
        versionNumber: v.versionNumber,
        source: v.source,
        lineCount: Array.isArray(v.lyricsData) ? (v.lyricsData as unknown[]).length : 0,
        createdAt: v.createdAt,
      })),
    });
  } catch (err) {
    console.error('Pending lyrics error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/admin/analytics ───────────────────────────

router.get('/analytics', async (_req: Request, res: Response) => {
  try {
    const [
      totalUsers,
      totalSongs,
      availableSongs,
      unavailableSongs,
      songsWithLyrics,
      songsWithRawLyrics,
      totalLyricsVersions,
      pendingReviews,
      totalPlays,
      openReports,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.song.count(),
      prisma.song.count({ where: { isAvailable: true, filePath: { not: null } } }),
      prisma.song.count({ where: { isAvailable: false } }),
      prisma.lyricsVersion.groupBy({ by: ['songId'], where: { isCanonical: true } }).then((r) => r.length),
      prisma.song.count({ where: { rawLyrics: { not: '' } } }),
      prisma.lyricsVersion.count(),
      prisma.lyricsVersion.count({ where: { status: 'pending_review' } }),
      prisma.song.aggregate({ _sum: { playCount: true } }).then((r) => r._sum.playCount || 0),
      prisma.brokenTrackReport.count({ where: { status: 'open' } }),
    ]);

    // Top played songs
    const topPlayed = await prisma.song.findMany({
      where: { playCount: { gt: 0 } },
      select: { id: true, name: true, playCount: true, category: true },
      orderBy: { playCount: 'desc' },
      take: 20,
    });

    res.json({
      users: { total: totalUsers },
      songs: {
        total: totalSongs,
        available: availableSongs,
        unavailable: unavailableSongs,
        withTimedLyrics: songsWithLyrics,
        withRawLyrics: songsWithRawLyrics,
      },
      lyrics: {
        totalVersions: totalLyricsVersions,
        pendingReviews,
      },
      playback: {
        totalPlays,
        topPlayed,
      },
      reports: { open: openReports },
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/admin/reports ─────────────────────────────

router.get('/reports', async (_req: Request, res: Response) => {
  try {
    const reports = await prisma.brokenTrackReport.findMany({
      include: {
        song: { select: { id: true, name: true } },
        reporter: { select: { displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({ reports });
  } catch (err) {
    console.error('Reports error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── PUT /api/admin/reports/:id ─────────────────────────

router.put('/reports/:id', async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    if (!['resolved', 'dismissed'].includes(status)) {
      res.status(400).json({ error: 'Status must be "resolved" or "dismissed"' });
      return;
    }

    const report = await prisma.brokenTrackReport.update({
      where: { id: req.params.id },
      data: { status },
    });

    res.json({ report: { id: report.id, status: report.status } });
  } catch (err) {
    console.error('Update report error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/admin/lyrics/sync-status ───────────────────
// Returns stats about lyrics timing coverage

router.get('/lyrics/sync-status', async (_req: Request, res: Response) => {
  try {
    const [totalSongs, withAudio, withRawLyrics, withTimedLyrics, eligible] = await Promise.all([
      prisma.song.count(),
      prisma.song.count({ where: { filePath: { not: null }, isAvailable: true } }),
      prisma.song.count({ where: { rawLyrics: { not: '' } } }),
      prisma.lyricsVersion.groupBy({ by: ['songId'], where: { isCanonical: true } }).then(r => r.length),
      // Eligible = has audio + has raw lyrics + no canonical timed version
      prisma.song.count({
        where: {
          filePath: { not: null },
          rawLyrics: { not: '' },
          isAvailable: true,
          category: { notIn: ['unsurfaced'] },
          lyricsVersions: { none: { isCanonical: true } },
        },
      }),
    ]);

    // Estimate AssemblyAI usage
    const eligibleSongs = await prisma.song.findMany({
      where: {
        filePath: { not: null },
        rawLyrics: { not: '' },
        isAvailable: true,
        category: { notIn: ['unsurfaced'] },
        lyricsVersions: { none: { isCanonical: true } },
      },
      select: { durationMs: true },
    });
    const totalDurationMs = eligibleSongs.reduce((sum, s) => sum + (s.durationMs || 210000), 0);
    const estimatedHours = totalDurationMs / 3600000;

    res.json({
      totalSongs,
      withAudio,
      withRawLyrics,
      withTimedLyrics,
      eligible,
      estimatedHours: Math.round(estimatedHours * 10) / 10,
      hasApiKey: !!process.env.ASSEMBLYAI_API_KEY,
    });
  } catch (err) {
    console.error('Lyrics sync status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/admin/lyrics/sync-single ─────────────────
// Trigger lyrics timing for a single song (from admin UI)

router.post('/lyrics/sync-single', async (req: Request, res: Response) => {
  try {
    const { songId } = req.body;
    if (!songId) {
      res.status(400).json({ error: 'songId is required' });
      return;
    }

    if (!process.env.ASSEMBLYAI_API_KEY) {
      res.status(500).json({ error: 'ASSEMBLYAI_API_KEY not configured' });
      return;
    }

    const song = await prisma.song.findUnique({
      where: { id: songId },
      select: { id: true, name: true, filePath: true, rawLyrics: true },
    });

    if (!song) { res.status(404).json({ error: 'Song not found' }); return; }
    if (!song.filePath) { res.status(400).json({ error: 'Song has no audio file' }); return; }
    if (!song.rawLyrics?.trim()) { res.status(400).json({ error: 'Song has no raw lyrics' }); return; }

    // Import the aligner
    const { generateTimedLyrics } = await import('../services/lyric-aligner');

    const API_BASE = (process.env.JUICEWRLD_API_BASE || 'https://juicewrldapi.com/juicewrld').replace(/\/juicewrld\/?$/, '');
    const audioUrl = `${API_BASE}/files/download/?path=${encodeURIComponent(song.filePath)}`;

    const result = await generateTimedLyrics(audioUrl, song.rawLyrics);

    if (!result || !result.timedLines.length) {
      res.status(422).json({ error: 'Could not generate timed lyrics (no words detected)' });
      return;
    }

    const lyricsData = result.timedLines.map((line: any, i: number) => ({
      id: `l${i + 1}`,
      start_ms: line.start_ms,
      end_ms: line.end_ms,
      text: line.text,
      confidence: line.confidence,
    }));

    // Get or create system user
    const SYSTEM_EMAIL = 'system@juicevault.local';
    let systemUser = await prisma.user.findUnique({ where: { email: SYSTEM_EMAIL } });
    if (!systemUser) {
      systemUser = await prisma.user.create({
        data: {
          email: SYSTEM_EMAIL,
          passwordHash: 'SYSTEM_ACCOUNT_NO_LOGIN',
          displayName: '🤖 JuiceVault System',
          role: 'admin',
          isActive: false,
        },
      });
    }

    // Unset any existing canonical, then create new
    await prisma.lyricsVersion.updateMany({
      where: { songId: song.id, isCanonical: true },
      data: { isCanonical: false },
    });

    const maxVersion = await prisma.lyricsVersion.aggregate({
      where: { songId: song.id },
      _max: { versionNumber: true },
    });

    const version = await prisma.lyricsVersion.create({
      data: {
        songId: song.id,
        authorId: systemUser.id,
        versionNumber: (maxVersion._max.versionNumber || 0) + 1,
        source: 'auto_generated',
        status: 'approved',
        isCanonical: true,
        lyricsData: lyricsData as any,
      },
    });

    res.json({
      success: true,
      songName: song.name,
      lineCount: lyricsData.length,
      versionId: version.id,
    });
  } catch (err: any) {
    console.error('Single lyrics sync error:', err);
    res.status(500).json({ error: err.message || 'Lyrics sync failed' });
  }
});

export default router;
