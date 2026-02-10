/**
 * Auto Lyrics Sync - Ultra Fast Edition
 * 
 * Handles automatic lyrics fetching and timing sync with:
 * - Multiple modes: full, genius-only, timing-only, timing-force
 * - AGGRESSIVE worker pools for maximum speed
 * - Run status + stats tracking with progress
 * - Rolling logs
 * - Single-job locking to prevent overlaps
 */

import prisma from '../config/database';
import { fetchGeniusLyrics } from '../services/genius-api';
import { generateTimedLyrics } from '../services/lyric-aligner';

export type AutoLyricsMode = 'full' | 'genius-only' | 'timing-only' | 'timing-force';

export type AutoLyricsStatus = {
  running: boolean;
  mode: AutoLyricsMode | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastTrigger: string | null;
  stage: 'idle' | 'genius' | 'timing' | 'done' | 'error';
  progress: {
    current: number;
    total: number;
    percent: number;
  };
  stats: {
    geniusCandidates: number;
    geniusFilled: number;
    timingCandidates: number;
    timingSynced: number;
    timingRetimed: number;
    errors: number;
  };
};

// ⚡ ULTRA FAST Configuration
const MAX_GENIUS_WORKERS = Math.min(Math.max(Number(process.env.GENIUS_SYNC_WORKERS || 10), 1), 15);
const MAX_ALIGN_WORKERS = Math.min(Math.max(Number(process.env.ASSEMBLYAI_SYNC_WORKERS || 5), 1), 8);
const API_BASE = process.env.JUICEWRLD_API_BASE || 'https://juicewrldapi.com/juicewrld';
const LOG_LIMIT = 500;

// State
let runningJob: Promise<void> | null = null;
let currentMode: AutoLyricsMode | null = null;
const logs: string[] = [];
const status: AutoLyricsStatus = {
  running: false,
  mode: null,
  startedAt: null,
  finishedAt: null,
  lastTrigger: null,
  stage: 'idle',
  progress: { current: 0, total: 0, percent: 0 },
  stats: {
    geniusCandidates: 0,
    geniusFilled: 0,
    timingCandidates: 0,
    timingSynced: 0,
    timingRetimed: 0,
    errors: 0,
  },
};

// ─── Helpers ────────────────────────────────────────────

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logs.push(line);
  if (logs.length > LOG_LIMIT) logs.shift();
  console.log(line);
}

function resetStats(mode: AutoLyricsMode, reason: string): void {
  status.running = true;
  status.mode = mode;
  currentMode = mode;
  status.startedAt = new Date().toISOString();
  status.finishedAt = null;
  status.lastTrigger = reason;
  status.stage = 'idle';
  status.progress = { current: 0, total: 0, percent: 0 };
  status.stats = {
    geniusCandidates: 0,
    geniusFilled: 0,
    timingCandidates: 0,
    timingSynced: 0,
    timingRetimed: 0,
    errors: 0,
  };
  log(`[AUTO-LYRICS] 🚀 STARTED (${mode}) by ${reason}`);
  log(`[AUTO-LYRICS] Workers: Genius=${MAX_GENIUS_WORKERS}, AssemblyAI=${MAX_ALIGN_WORKERS}`);
}

function updateProgress(current: number, total: number) {
  status.progress.current = current;
  status.progress.total = total;
  status.progress.percent = total > 0 ? Math.round((current / total) * 100) : 0;
}

function finishStatus(ok: boolean): void {
  status.running = false;
  status.finishedAt = new Date().toISOString();
  status.stage = ok ? 'done' : 'error';
  currentMode = null;
  log(`[AUTO-LYRICS] ✅ COMPLETE - Status: ${status.stage}`);
}

function buildAudioUrl(filePath: string): string {
  return `${API_BASE}/files/download/?path=${encodeURIComponent(filePath)}`;
}

async function runQueue<T>(items: T[], workers: number, handler: (item: T, index: number) => Promise<void>): Promise<void> {
  let idx = 0;
  const total = items.length;
  
  const worker = async () => {
    while (idx < total) {
      const i = idx++;
      try {
        await handler(items[i], i);
      } catch (err: any) {
        status.stats.errors += 1;
        log(`[AUTO-LYRICS] ❌ Worker error: ${err?.message || 'Unknown'}`);
      }
    }
  };
  
  await Promise.all(Array.from({ length: Math.min(workers, total || 1) }, () => worker()));
}

// ─── Genius Stage ───────────────────────────────────────

async function fetchMissingRawLyrics(): Promise<void> {
  const token = process.env.GENIUS_ACCESS_TOKEN;
  if (!token) {
    log('[AUTO-LYRICS] ⚠️ GENIUS_ACCESS_TOKEN missing; skipping Genius stage');
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
    orderBy: { name: 'asc' },
  });

  status.stats.geniusCandidates = songs.length;
  updateProgress(0, songs.length);
  
  log(`[AUTO-LYRICS] 🔍 Genius stage: ${songs.length} songs missing raw lyrics`);
  log(`[AUTO-LYRICS] 🚀 Using ${MAX_GENIUS_WORKERS} parallel workers`);

  if (songs.length === 0) {
    log('[AUTO-LYRICS] ✨ No songs need Genius lyrics');
    return;
  }

  let processed = 0;

  await runQueue(songs, MAX_GENIUS_WORKERS, async (song, index) => {
    try {
      const result = await fetchGeniusLyrics(song.name);
      
      if (result) {
        await prisma.song.update({
          where: { id: song.id },
          data: {
            rawLyrics: result.lyrics,
            additionalInfo: `Lyrics source: Genius (${result.geniusUrl})`,
          },
        });
        status.stats.geniusFilled += 1;
        log(`[AUTO-LYRICS] ✅ [${index + 1}/${songs.length}] Filled: "${song.name}"`);
      } else {
        log(`[AUTO-LYRICS] ❌ [${index + 1}/${songs.length}] Not found: "${song.name}"`);
      }
      
      processed++;
      if (processed % 10 === 0) {
        updateProgress(processed, songs.length);
      }
    } catch (err: any) {
      status.stats.errors += 1;
      log(`[AUTO-LYRICS] 💥 [${index + 1}/${songs.length}] Error on "${song.name}": ${err?.message || 'Unknown'}`);
    }
  });

  updateProgress(songs.length, songs.length);
  log(`[AUTO-LYRICS] 🎉 Genius stage DONE: ${status.stats.geniusFilled}/${songs.length} songs filled`);
}

// ─── AssemblyAI Stage ───────────────────────────────────

async function syncTimedLyrics(forceRetime: boolean): Promise<void> {
  const aaiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!aaiKey) {
    log('[AUTO-LYRICS] ⚠️ ASSEMBLYAI_API_KEY missing; skipping timing stage');
    return;
  }

  status.stage = 'timing';

  // Get or create system user
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

  // Find songs that need timing
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
        select: { id: true, source: true, isCanonical: true },
        take: 1,
        orderBy: [{ isCanonical: 'desc' }, { versionNumber: 'desc' }],
      },
    },
    orderBy: { name: 'asc' },
  });

  // Filter candidates
  const candidates = songs.filter((song) => {
    if (!song.filePath || song.rawLyrics.trim().length < 20) return false;
    if (!song.lyricsVersions.length) return true;
    return forceRetime && song.lyricsVersions[0]?.source === 'auto_generated';
  });

  status.stats.timingCandidates = candidates.length;
  updateProgress(0, candidates.length);
  
  log(`[AUTO-LYRICS] ⏱️ AssemblyAI stage: ${candidates.length} songs need timing${forceRetime ? ' (FORCE MODE)' : ''}`);
  log(`[AUTO-LYRICS] 🚀 Using ${MAX_ALIGN_WORKERS} parallel workers`);

  if (candidates.length === 0) {
    log('[AUTO-LYRICS] ✨ No songs need timing sync');
    return;
  }

  let processed = 0;

  await runQueue(candidates, MAX_ALIGN_WORKERS, async (song, index) => {
    try {
      const hadVersion = song.lyricsVersions.length > 0;
      const result = await generateTimedLyrics(buildAudioUrl(song.filePath!), song.rawLyrics);
      
      if (!result?.timedLines?.length) {
        log(`[AUTO-LYRICS] ⚠️ [${index + 1}/${candidates.length}] No timing: "${song.name}"`);
        return;
      }

      const timedCount = result.timedLines.filter((line) => line.confidence > 0).length;
      const confidence = timedCount / result.timedLines.length;
      
      if (confidence < 0.3) {
        log(`[AUTO-LYRICS] ⚠️ [${index + 1}/${candidates.length}] Low confidence (${Math.round(confidence * 100)}%): "${song.name}"`);
        return;
      }

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
      
      processed++;
      if (processed % 5 === 0) {
        updateProgress(processed, candidates.length);
      }
      
      log(`[AUTO-LYRICS] ✅ [${index + 1}/${candidates.length}] Synced: "${song.name}" (${lyricsData.length} lines, ${Math.round(confidence * 100)}% conf)`);
    } catch (err: any) {
      status.stats.errors += 1;
      log(`[AUTO-LYRICS] 💥 [${index + 1}/${candidates.length}] Failed: "${song.name}" - ${err?.message || 'Unknown'}`);
    }
  });

  updateProgress(candidates.length, candidates.length);
  log(`[AUTO-LYRICS] 🎉 AssemblyAI stage DONE: ${status.stats.timingSynced}/${candidates.length} songs synced`);
}

// ─── Main Job ───────────────────────────────────────────

async function runAutoLyricsSync(mode: AutoLyricsMode): Promise<void> {
  const started = Date.now();
  
  log(`[AUTO-LYRICS] ▶️ Starting run with mode: ${mode}`);
  
  // GENIUS-ONLY: Only fetch lyrics, NO TIMING
  if (mode === 'full' || mode === 'genius-only') {
    await fetchMissingRawLyrics();
  }
  
  // TIMING MODES: Only do timing, skip Genius
  if (mode === 'full' || mode === 'timing-only' || mode === 'timing-force') {
    await syncTimedLyrics(mode === 'timing-force');
  }
  
  const elapsedSec = Math.round((Date.now() - started) / 1000);
  log(`[AUTO-LYRICS] ✅ COMPLETE in ${elapsedSec}s - Mode: ${mode}`);
  log(`[AUTO-LYRICS] 📊 Results: Genius=${status.stats.geniusFilled}, Timing=${status.stats.timingSynced}, Errors=${status.stats.errors}`);
}

// ─── Public API ─────────────────────────────────────────

export function getAutoLyricsStatus(): AutoLyricsStatus {
  return JSON.parse(JSON.stringify(status));
}

export function getAutoLyricsLogs(): string[] {
  return [...logs];
}

export function isAutoLyricsRunning(): boolean {
  return status.running;
}

export function triggerAutoLyricsSync(reason: string, mode: AutoLyricsMode = 'full'): boolean {
  if (runningJob) {
    log(`[AUTO-LYRICS] ⛔ BLOCKED: Job already running (${status.mode})`);
    return false;
  }

  resetStats(mode, reason);

  runningJob = runAutoLyricsSync(mode)
    .then(() => {
      finishStatus(true);
    })
    .catch((err) => {
      status.stats.errors += 1;
      log(`[AUTO-LYRICS] 💥 FATAL ERROR: ${err?.message || err}`);
      finishStatus(false);
    })
    .finally(() => {
      runningJob = null;
    });

  return true;
}
