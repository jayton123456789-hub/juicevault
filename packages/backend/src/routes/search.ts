/**
 * Search Routes
 * 
 * Provides two search modes:
 * 1. Local DB search (Prisma full-text on our synced catalog)
 * 2. Proxy to the Juice WRLD API search (for songs not yet synced)
 * 
 * The external API supports:
 * - search: song names, credited artists, track titles (normalizes special chars)
 * - searchall: also includes producers
 * - lyrics: searches within lyric content
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../config/database';
import { requireAuth } from '../middleware/auth';
import { getJuiceApi } from '../services/juice-api';

const router = Router();

const searchSchema = z.object({
  q: z.string().min(1).max(200),
  mode: z.enum(['local', 'api', 'both']).default('local'),
  category: z.string().optional(),
  era: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
});

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const params = searchSchema.parse(req.query);

    // Local DB search
    if (params.mode === 'local' || params.mode === 'both') {
      const where: any = {
        OR: [
          { name: { contains: params.q, mode: 'insensitive' } },
          { creditedArtists: { contains: params.q, mode: 'insensitive' } },
          { producers: { contains: params.q, mode: 'insensitive' } },
          { rawLyrics: { contains: params.q, mode: 'insensitive' } },
          { aliases: { some: { alias: { contains: params.q, mode: 'insensitive' } } } },
        ],
      };
      if (params.category) where.category = params.category;
      if (params.era) where.era = { name: { contains: params.era, mode: 'insensitive' } };

      const [songs, total] = await Promise.all([
        prisma.song.findMany({
          where,
          include: {
            era: { select: { name: true } },
            aliases: { select: { alias: true } },
          },
          orderBy: { playCount: 'desc' },
          skip: (params.page - 1) * params.pageSize,
          take: params.pageSize,
        }),
        prisma.song.count({ where }),
      ]);

      const localResults = songs.map(s => ({
        id: s.id,
        externalId: s.externalId,
        name: s.name,
        category: s.category,
        era: s.era?.name || null,
        aliases: s.aliases.map(a => a.alias),
        creditedArtists: s.creditedArtists,
        producers: s.producers,
        length: s.length,
        isAvailable: s.isAvailable,
        hasFilePath: !!s.filePath,
        playCount: s.playCount,
        imageUrl: s.imageUrl,
        source: 'local' as const,
      }));

      if (params.mode === 'local') {
        res.json({
          results: localResults,
          pagination: {
            page: params.page,
            pageSize: params.pageSize,
            total,
            totalPages: Math.ceil(total / params.pageSize),
          },
        });
        return;
      }

      // mode === 'both' — also search API
      try {
        const apiResults = await getJuiceApi().getSongs({
          search: params.q,
          page: 1,
          page_size: 20,
          category: params.category,
        });

        res.json({
          local: { results: localResults, total },
          api: {
            results: apiResults.results.map(r => ({
              externalId: r.id,
              name: r.name,
              category: r.category,
              era: (r as any).era?.name || null,
              creditedArtists: (r as any).credited_artists || '',
              source: 'api' as const,
            })),
            total: apiResults.count,
          },
        });
      } catch {
        // API search failed — return local only
        res.json({
          local: { results: localResults, total },
          api: { results: [], total: 0, error: 'API search unavailable' },
        });
      }
      return;
    }

    // API-only search
    if (params.mode === 'api') {
      const apiResults = await getJuiceApi().getSongs({
        search: params.q,
        page: params.page,
        page_size: params.pageSize,
        category: params.category,
      });

      res.json({
        results: apiResults.results.map(r => ({
          externalId: r.id,
          name: r.name,
          category: r.category,
          era: (r as any).era?.name || null,
          creditedArtists: (r as any).credited_artists || '',
          source: 'api' as const,
        })),
        pagination: {
          page: params.page,
          pageSize: params.pageSize,
          total: apiResults.count,
          totalPages: Math.ceil(apiResults.count / params.pageSize),
        },
      });
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Invalid parameters', details: err.errors });
      return;
    }
    console.error('Search error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
