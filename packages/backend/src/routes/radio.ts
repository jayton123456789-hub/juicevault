/**
 * Radio Route
 * Proxies GET /radio/random/ from the Juice WRLD API.
 * Returns a random playable song with full metadata.
 * Now filters out unsurfaced/no-audio songs and retries.
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { getJuiceApi } from '../services/juice-api';
import prisma from '../config/database';

const router = Router();

router.get('/random', requireAuth, async (_req: Request, res: Response) => {
  try {
    const api = getJuiceApi();

    // Try up to 5 times to find a playable song
    for (let attempt = 0; attempt < 5; attempt++) {
      const radioSong = await api.getRandomSong();

      // Try to find matching song in our DB
      let localSong = null;
      if (radioSong.song?.id) {
        localSong = await prisma.song.findUnique({
          where: { externalId: radioSong.song.id },
          select: {
            id: true,
            name: true,
            filePath: true,
            isAvailable: true,
            category: true,
          },
        });
      }

      // Skip unsurfaced songs or songs without audio
      if (localSong && (!localSong.filePath || localSong.category === 'unsurfaced')) {
        continue; // Try again
      }

      return res.json({
        title: radioSong.title,
        path: radioSong.path,
        size: radioSong.size,
        metadata: radioSong.song ? {
          externalId: radioSong.song.id,
          name: radioSong.song.name,
          category: radioSong.song.category,
          era: radioSong.song.era?.name || null,
          creditedArtists: radioSong.song.credited_artists,
          producers: radioSong.song.producers,
          length: radioSong.song.length,
          imageUrl: radioSong.song.image_url,
          hasLyrics: !!(radioSong.song.lyrics),
        } : null,
        localSong: localSong ? {
          id: localSong.id,
          name: localSong.name,
          filePath: localSong.filePath,
          isAvailable: localSong.isAvailable,
        } : null,
      });
    }

    // All 5 attempts failed to find a playable song
    res.status(404).json({ error: 'No playable song found after multiple attempts' });
  } catch (err) {
    console.error('Radio error:', err);
    res.status(502).json({ error: 'Radio service unavailable' });
  }
});

export default router;
