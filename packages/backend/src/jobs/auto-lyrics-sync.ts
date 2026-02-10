import prisma from '../config/database';
import { fetchGeniusLyrics } from '../services/genius-api';
import { generateTimedLyrics } from '../services/lyric-aligner';

const MAX_GENIUS_WORKERS = Math.min(Math.max(Number(process.env.GENIUS_SYNC_WORKERS || 5), 1), 5);
const MAX_ALIGN_WORKERS = Math.min(Math.max(Number(process.env.ASSEMBLYAI_SYNC_WORKERS || 4), 1), 5);
const API_BASE = process.env.JUICEWRLD_API_BASE || 'https://juicewrldapi.com/juicewrld';

let runningJob: Promise<void> | null = null;

function buildAudioUrl(filePath: string): string {
  return `${API_BASE}/files/download/?path=${encodeURIComponent(filePath)}`;
}

async function runQueue<T>(items: T[], workers: number, handler: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx;
      idx += 1;
      await handler(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, items.length || 1) }, () => worker()));
}

async function fetchMissingRawLyrics(): Promise<void> {
  const token = process.env.GENIUS_ACCESS_TOKEN;
  if (!token) {
    console.log('[AUTO-LYRICS] GENIUS_ACCESS_TOKEN missing; skipping Genius stage');
    return;
  }

  const songs = await prisma.song.findMany({
    where: {
      rawLyrics: '',
      filePath: { not: '' },
      category: { in: ['released', 'unreleased'] },
    },
    select: { id: true, name: true },
    take: 1500,
  });

  console.log(`[AUTO-LYRICS] Genius stage: ${songs.length} songs missing raw lyrics`);
  let found = 0;

  await runQueue(songs, MAX_GENIUS_WORKERS, async (song) => {
    try {
      const result = await fetchGeniusLyrics(song.name);
      if (!result) return;

      await prisma.song.update({
        where: { id: song.id },
        data: {
          rawLyrics: result.lyrics,
          additionalInfo: `Lyrics source: Genius (${result.geniusUrl})`,
        },
      });
      found += 1;
    } catch (err) {
      console.error(`[AUTO-LYRICS] Genius failed for "${song.name}":`, err);
    }
  });

  console.log(`[AUTO-LYRICS] Genius stage done. Filled lyrics for ${found}/${songs.length} songs`);
}

async function syncTimedLyrics(): Promise<void> {
  const aaiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!aaiKey) {
    console.log('[AUTO-LYRICS] ASSEMBLYAI_API_KEY missing; skipping timing stage');
    return;
  }

  const systemUser = await prisma.user.upsert({
    where: { email: 'system@juicevault.local' },
    update: {},
    create: {
      email: 'system@juicevault.local',
      passwordHash: 'SYSTEM_ACCOUNT_NO_LOGIN',
      displayName: '🤖 JuiceVault System',
      role: 'admin',
      isActive: false,
    },
    select: { id: true },
  });

  const songs = await prisma.song.findMany({
    where: {
      filePath: { not: null },
      rawLyrics: { not: '' },
      isAvailable: true,
      category: { in: ['released', 'unreleased'] },
      lyricsVersions: { none: { OR: [{ isCanonical: true }, { status: 'approved' }] } },
    },
    select: {
      id: true,
      name: true,
      filePath: true,
      rawLyrics: true,
    },
    take: 800,
  });

  console.log(`[AUTO-LYRICS] AssemblyAI stage: ${songs.length} songs need timed lyrics`);
  let synced = 0;

  await runQueue(songs, MAX_ALIGN_WORKERS, async (song) => {
    try {
      if (!song.filePath || song.rawLyrics.trim().length < 20) return;

      const result = await generateTimedLyrics(buildAudioUrl(song.filePath), song.rawLyrics);
      if (!result?.timedLines?.length) return;

      const timedCount = result.timedLines.filter(line => line.confidence > 0).length;
      if (timedCount / result.timedLines.length < 0.3) return;

      const lyricsData = result.timedLines.map((line, i) => ({
        id: `l${i + 1}`,
        start_ms: line.start_ms,
        end_ms: line.end_ms,
        text: line.text,
        confidence: line.confidence,
      }));

      const maxVersion = await prisma.lyricsVersion.aggregate({
        where: { songId: song.id },
        _max: { versionNumber: true },
      });

      await prisma.$transaction([
        prisma.lyricsVersion.updateMany({
          where: { songId: song.id, isCanonical: true },
          data: { isCanonical: false },
        }),
        prisma.lyricsVersion.create({
          data: {
            songId: song.id,
            authorId: systemUser.id,
            versionNumber: (maxVersion._max.versionNumber ?? 0) + 1,
            status: 'approved',
            isCanonical: true,
            source: 'auto_generated',
            lyricsData: lyricsData as any,
          },
        }),
      ]);
      synced += 1;
    } catch (err) {
      console.error(`[AUTO-LYRICS] Timing failed for "${song.name}":`, err);
    }
  });

  console.log(`[AUTO-LYRICS] AssemblyAI stage done. Synced ${synced}/${songs.length} songs`);
}

async function runAutoLyricsSync(): Promise<void> {
  const started = Date.now();
  console.log(`[AUTO-LYRICS] Job started at ${new Date(started).toISOString()}`);
  await fetchMissingRawLyrics();
  await syncTimedLyrics();
  const elapsedSec = Math.round((Date.now() - started) / 1000);
  console.log(`[AUTO-LYRICS] Job complete in ${elapsedSec}s`);
}

export function triggerAutoLyricsSync(reason: string): void {
  if (runningJob) {
    console.log(`[AUTO-LYRICS] Job already running; skip trigger (${reason})`);
    return;
  }

  runningJob = runAutoLyricsSync()
    .catch((err) => {
      console.error('[AUTO-LYRICS] Job failed:', err);
    })
    .finally(() => {
      runningJob = null;
    });
}
