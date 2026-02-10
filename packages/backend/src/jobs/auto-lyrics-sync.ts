import prisma from '../config/database';
import { fetchGeniusLyrics } from '../services/genius-api';
import { generateTimedLyrics } from '../services/lyric-aligner';

type AutoLyricsMode = 'full' | 'genius-only' | 'timing-only' | 'timing-force';

type AutoLyricsStatus = {
  running: boolean;
  mode: AutoLyricsMode | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastTrigger: string | null;
  stage: 'idle' | 'genius' | 'timing' | 'done' | 'error';
  stats: {
    geniusCandidates: number;
    geniusFilled: number;
    timingCandidates: number;
    timingSynced: number;
    timingRetimed: number;
    errors: number;
  };
};

const MAX_GENIUS_WORKERS = Math.min(Math.max(Number(process.env.GENIUS_SYNC_WORKERS || 5), 1), 5);
const MAX_ALIGN_WORKERS = Math.min(Math.max(Number(process.env.ASSEMBLYAI_SYNC_WORKERS || 4), 1), 5);
const MAX_GENIUS_SCAN = Math.max(Number(process.env.GENIUS_SYNC_MAX_SONGS || 0), 0);
const MAX_TIMING_SCAN = Math.max(Number(process.env.ASSEMBLYAI_SYNC_MAX_SONGS || 0), 0);
const API_BASE = process.env.JUICEWRLD_API_BASE || 'https://juicewrldapi.com/juicewrld';
const LOG_LIMIT = 250;

let runningJob: Promise<void> | null = null;
const logs: string[] = [];
const status: AutoLyricsStatus = {
  running: false,
  mode: null,
  startedAt: null,
  finishedAt: null,
  lastTrigger: null,
  stage: 'idle',
  stats: {
    geniusCandidates: 0,
    geniusFilled: 0,
    timingCandidates: 0,
    timingSynced: 0,
    timingRetimed: 0,
    errors: 0,
  },
};

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logs.push(line);
  if (logs.length > LOG_LIMIT) logs.shift();
  console.log(line);
}

function resetStats(mode: AutoLyricsMode, reason: string): void {
  status.running = true;
  status.mode = mode;
  status.startedAt = new Date().toISOString();
  status.finishedAt = null;
  status.lastTrigger = reason;
  status.stage = 'idle';
  status.stats = {
    geniusCandidates: 0,
    geniusFilled: 0,
    timingCandidates: 0,
    timingSynced: 0,
    timingRetimed: 0,
    errors: 0,
  };
  log(`[AUTO-LYRICS] Triggered (${mode}) by ${reason} | workers: genius=${MAX_GENIUS_WORKERS}, timing=${MAX_ALIGN_WORKERS}`);
}

function finishStatus(ok: boolean): void {
  status.running = false;
  status.finishedAt = new Date().toISOString();
  status.stage = ok ? 'done' : 'error';
}

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
    log('[AUTO-LYRICS] GENIUS_ACCESS_TOKEN missing; skipping Genius stage');
    return;
  }

  status.stage = 'genius';
  const songs = await prisma.song.findMany({
    where: {
      rawLyrics: '',
      filePath: { not: '' },
      category: { in: ['released', 'unreleased'] },
    },
    select: { id: true, name: true },
    ...(MAX_GENIUS_SCAN > 0 ? { take: MAX_GENIUS_SCAN } : {}),
  });

  status.stats.geniusCandidates = songs.length;
  log(`[AUTO-LYRICS] Genius stage: ${songs.length} songs missing raw lyrics`);

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
      status.stats.geniusFilled += 1;
    } catch (err) {
      status.stats.errors += 1;
      log(`[AUTO-LYRICS] Genius failed for "${song.name}"`);
    }
  });

  log(`[AUTO-LYRICS] Genius stage done. Filled lyrics for ${status.stats.geniusFilled}/${songs.length} songs`);
}

async function syncTimedLyrics(forceRetime: boolean): Promise<void> {
  const aaiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!aaiKey) {
    log('[AUTO-LYRICS] ASSEMBLYAI_API_KEY missing; skipping timing stage');
    return;
  }

  status.stage = 'timing';

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
    },
    select: {
      id: true,
      name: true,
      filePath: true,
      rawLyrics: true,
      lyricsVersions: {
        where: { OR: [{ isCanonical: true }, { status: 'approved' }] },
        select: { id: true, source: true },
        take: 1,
        orderBy: [{ isCanonical: 'desc' }, { versionNumber: 'desc' }],
      },
    },
    ...(MAX_TIMING_SCAN > 0 ? { take: MAX_TIMING_SCAN } : {}),
  });

  const candidates = songs.filter((song) => {
    if (!song.filePath || song.rawLyrics.trim().length < 20) return false;
    if (!song.lyricsVersions.length) return true;
    return forceRetime && song.lyricsVersions[0].source === 'auto_generated';
  });

  status.stats.timingCandidates = candidates.length;
  log(`[AUTO-LYRICS] AssemblyAI stage: ${candidates.length} songs need timing${forceRetime ? ' (force mode)' : ''}`);

  await runQueue(candidates, MAX_ALIGN_WORKERS, async (song) => {
    try {
      const hadVersion = song.lyricsVersions.length > 0;
      const result = await generateTimedLyrics(buildAudioUrl(song.filePath!), song.rawLyrics);
      if (!result?.timedLines?.length) return;

      const timedCount = result.timedLines.filter((line) => line.confidence > 0).length;
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

      status.stats.timingSynced += 1;
      if (hadVersion) status.stats.timingRetimed += 1;
    } catch (err) {
      status.stats.errors += 1;
      log(`[AUTO-LYRICS] Timing failed for "${song.name}"`);
    }
  });

  log(`[AUTO-LYRICS] AssemblyAI stage done. Synced ${status.stats.timingSynced}/${candidates.length} songs`);
}

async function runAutoLyricsSync(mode: AutoLyricsMode): Promise<void> {
  const started = Date.now();
  if (mode === 'full' || mode === 'genius-only') {
    await fetchMissingRawLyrics();
  }
  if (mode === 'full' || mode === 'timing-only' || mode === 'timing-force') {
    await syncTimedLyrics(mode === 'timing-force');
  }
  const elapsedSec = Math.round((Date.now() - started) / 1000);
  log(`[AUTO-LYRICS] Job complete in ${elapsedSec}s`);
}

export function getAutoLyricsStatus(): AutoLyricsStatus {
  return JSON.parse(JSON.stringify(status));
}

export function getAutoLyricsLogs(): string[] {
  return [...logs];
}

export function triggerAutoLyricsSync(reason: string, mode: AutoLyricsMode = 'full'): boolean {
  if (runningJob) {
    log(`[AUTO-LYRICS] Job already running; skip trigger (${reason})`);
    return false;
  }

  resetStats(mode, reason);

  runningJob = runAutoLyricsSync(mode)
    .then(() => {
      finishStatus(true);
    })
    .catch((err) => {
      status.stats.errors += 1;
      log(`[AUTO-LYRICS] Job failed: ${err?.message || err}`);
      finishStatus(false);
    })
    .finally(() => {
      runningJob = null;
    });

  return true;
}
