/**
 * Genius Lyrics Sync Job
 * Finds songs missing lyrics and fetches them from Genius
 */
import 'dotenv/config';
import prisma from '../config/database';
import { fetchGeniusLyrics } from '../services/genius-api';

async function syncGeniusLyrics() {
  const token = process.env.GENIUS_ACCESS_TOKEN;
  if (!token) {
    console.log('[GENIUS] No GENIUS_ACCESS_TOKEN set, skipping');
    return;
  }

  console.log('[GENIUS] Starting lyrics sync from Genius...');

  // Find songs with no rawLyrics that have a file path (playable songs)
  const songs = await prisma.song.findMany({
    where: {
      rawLyrics: '',
      filePath: { not: '' },
      category: { in: ['released', 'unreleased'] },
    },
    select: { id: true, name: true },
    take: 50, // Process in batches
  });

  console.log(`[GENIUS] Found ${songs.length} songs without lyrics`);

  let found = 0;
  let failed = 0;

  for (const song of songs) {
    try {
      console.log(`[GENIUS] Searching: ${song.name}`);
      const result = await fetchGeniusLyrics(song.name);

      if (result) {
        await prisma.song.update({
          where: { id: song.id },
          data: {
            rawLyrics: result.lyrics,
            additionalInfo: prisma.song.fields?.additionalInfo 
              ? undefined 
              : `Lyrics source: Genius (${result.geniusUrl})`,
          },
        });
        found++;
        console.log(`[GENIUS] ✅ Found lyrics for "${song.name}" (${result.lyrics.length} chars)`);
      } else {
        console.log(`[GENIUS] ❌ No lyrics found for "${song.name}"`);
        failed++;
      }

      // Rate limit: wait 1.5s between requests
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error(`[GENIUS] Error for "${song.name}":`, err);
      failed++;
    }
  }

  console.log(`[GENIUS] Done. Found: ${found}, Not found: ${failed}`);
}

// Run if called directly
syncGeniusLyrics()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
