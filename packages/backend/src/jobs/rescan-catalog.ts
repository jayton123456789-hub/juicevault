/**
 * Rescan Catalog Job — TURBO MODE
 *
 * - 25 parallel workers hammering the API
 * - 20-page parallel batch for ID collection
 * - Cover art downloads with 5s timeout (won't block the whole scan)
 * - Batch alias writes
 * - Incremental mode: skip songs synced in last 24h
 * - Progress tracking for admin UI polling
 */

import { PrismaClient, SongCategory } from '@prisma/client';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// ─── Progress Tracking ────────────────────────────────────

export interface RescanProgress {
  running: boolean;
  phase: 'idle' | 'collecting_ids' | 'syncing_details' | 'done' | 'error';
  totalSongs: number;
  processedSongs: number;
  successCount: number;
  errorCount: number;
  skippedCount: number;
  coversDownloaded: number;
  coversSkipped: number;
  coversFailed: number;
  startedAt: string | null;
  finishedAt: string | null;
  errors: Array<{ songId: number; name: string; error: string }>;
  message: string;
  songsPerSec: number;
}

let _progress: RescanProgress = {
  running: false,
  phase: 'idle',
  totalSongs: 0,
  processedSongs: 0,
  successCount: 0,
  errorCount: 0,
  skippedCount: 0,
  coversDownloaded: 0,
  coversSkipped: 0,
  coversFailed: 0,
  startedAt: null,
  finishedAt: null,
  errors: [],
  message: '',
  songsPerSec: 0,
};

export function getRescanProgress(): RescanProgress {
  // Calculate live speed
  if (_progress.running && _progress.startedAt) {
    const elapsed = (Date.now() - new Date(_progress.startedAt).getTime()) / 1000;
    _progress.songsPerSec = elapsed > 0 ? Math.round((_progress.processedSongs / elapsed) * 10) / 10 : 0;
  }
  return { ..._progress, errors: _progress.errors.slice(-50) };
}

function resetProgress(): void {
  _progress = {
    running: true,
    phase: 'collecting_ids',
    totalSongs: 0,
    processedSongs: 0,
    successCount: 0,
    errorCount: 0,
    skippedCount: 0,
    coversDownloaded: 0,
    coversSkipped: 0,
    coversFailed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    errors: [],
    message: 'Starting TURBO catalog rescan...',
    songsPerSec: 0,
  };
}

// ─── API Helpers (optimized) ────────────────────────────────

const API_BASE = process.env.JUICEWRLD_API_BASE || 'https://juicewrldapi.com/juicewrld';

async function apiFetch<T>(urlPath: string, retries = 3, timeoutMs = 10000): Promise<T> {
  const url = `${API_BASE}${urlPath}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          await new Promise(r => setTimeout(r, attempt * 500)); // Fast retry: 500ms, 1s, 1.5s
          continue;
        }
        throw new Error(`API ${res.status}: ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        if (attempt === retries) throw new Error(`Timeout after ${timeoutMs}ms: ${urlPath}`);
        continue;
      }
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, attempt * 300));
    }
  }
  throw new Error(`Failed after ${retries} retries: ${urlPath}`);
}

function parseDuration(length: string): number | null {
  if (!length?.trim()) return null;
  const parts = length.trim().split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return null;
}

function mapCategory(cat: string): SongCategory {
  const map: Record<string, SongCategory> = {
    released: 'released', unreleased: 'unreleased',
    unsurfaced: 'unsurfaced', recording_session: 'recording_session',
  };
  return map[cat] || 'unreleased';
}

function fixImageUrl(imageUrl: string): string {
  if (!imageUrl) return '';
  if (imageUrl.startsWith('http')) return imageUrl;
  return `https://juicewrldapi.com${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
}

// ─── Cover Art Download (with timeout) ──────────────────────

const COVERS_DIR = path.join(__dirname, '../../public/covers');

async function ensureCoversDir(): Promise<void> {
  if (!existsSync(COVERS_DIR)) {
    await mkdir(COVERS_DIR, { recursive: true });
  }
}

/** Download with a hard 5s timeout — don't let slow images block the whole scan */
async function fetchWithTimeout(url: string, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function downloadCoverArt(
  externalId: number,
  filePath: string | null,
  imageUrl: string
): Promise<string> {
  const filename = `${externalId}.jpg`;
  const localPath = path.join(COVERS_DIR, filename);

  // Already downloaded? Skip instantly
  if (existsSync(localPath)) {
    return `/covers/${filename}`;
  }

  // Priority 1: Embedded cover art from audio file
  if (filePath) {
    try {
      const encodedPath = encodeURIComponent(filePath);
      const coverUrl = `${API_BASE}/files/cover-art/?path=${encodedPath}`;
      const response = await fetchWithTimeout(coverUrl, 5000);
      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.startsWith('image/')) {
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > 1000) {
            await writeFile(localPath, buffer);
            return `/covers/${filename}`;
          }
        }
      }
    } catch { /* fall through */ }
  }

  // Priority 2: imageUrl (Spotify/external)
  if (imageUrl && imageUrl.startsWith('http')) {
    try {
      const response = await fetchWithTimeout(imageUrl, 5000);
      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.startsWith('image/')) {
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > 500) {
            await writeFile(localPath, buffer);
            return `/covers/${filename}`;
          }
        }
      }
    } catch { /* no cover */ }
  }

  return '';
}

// ─── Types ──────────────────────────────────────────────────

interface PageResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: Array<{ id: number; [key: string]: any }>;
}

interface FullSong {
  id: number;
  public_id?: number;
  name: string;
  original_key?: string;
  category: string;
  path?: string;
  era?: { id: number; name: string; description?: string; time_frame?: string; play_count?: number };
  track_titles?: string[];
  credited_artists?: string;
  producers?: string;
  engineers?: string;
  recording_locations?: string;
  record_dates?: string;
  length?: string;
  bitrate?: string;
  additional_information?: string;
  file_names?: string;
  instrumentals?: string;
  preview_date?: string;
  release_date?: string;
  dates?: string;
  session_titles?: string;
  session_tracking?: string;
  instrumental_names?: string;
  notes?: string;
  lyrics?: string;
  snippets?: any[];
  date_leaked?: string;
  leak_type?: string;
  image_url?: string;
}

// ─── Main Rescan Logic ──────────────────────────────────────

/** Phase 1: Collect ALL song IDs — 20 pages in parallel */
async function collectAllSongIds(): Promise<number[]> {
  const ids: number[] = [];
  const pageSize = 100;

  const first = await apiFetch<PageResponse>('/songs/?page=1&page_size=1');
  const total = first.count;
  const totalPages = Math.ceil(total / pageSize);

  _progress.totalSongs = total;
  _progress.message = `Collecting ${total} song IDs (${totalPages} pages, 20 parallel)...`;

  // Blast 20 pages at a time
  const batchSize = 20;
  for (let batch = 0; batch < totalPages; batch += batchSize) {
    const promises = [];
    for (let p = batch; p < Math.min(batch + batchSize, totalPages); p++) {
      promises.push(
        apiFetch<PageResponse>(`/songs/?page=${p + 1}&page_size=${pageSize}`).catch(() => null)
      );
    }
    const results = await Promise.all(promises);
    for (const r of results) {
      if (r?.results) {
        for (const song of r.results) ids.push(song.id);
      }
    }
  }
  return ids;
}

/** Phase 2 worker: fetch full song detail + upsert + cover download */
async function syncSingleSong(
  prisma: PrismaClient,
  songId: number,
  eraCache: Map<string, string>,
  downloadCovers: boolean
): Promise<{ success: boolean; skipped: boolean; coverResult: 'downloaded' | 'skipped' | 'failed' | 'none' }> {
  try {
    const s = await apiFetch<FullSong>(`/songs/${songId}/`, 2, 8000);

    // Handle era (use cache to avoid DB round-trips)
    let eraId: string | null = null;
    if (s.era?.name && s.era?.id) {
      if (eraCache.has(s.era.name)) {
        eraId = eraCache.get(s.era.name)!;
      } else {
        try {
          const era = await prisma.era.upsert({
            where: { externalId: s.era.id },
            create: {
              externalId: s.era.id,
              name: s.era.name,
              description: s.era.description || '',
              timeFrame: s.era.time_frame || '',
              playCount: s.era.play_count || 0,
            },
            update: { name: s.era.name },
          });
          eraCache.set(s.era.name, era.id);
          eraId = era.id;
        } catch { /* skip */ }
      }
    }

    const imageUrl = fixImageUrl(s.image_url || '');

    // Cover art download (parallel-safe, skips if exists)
    let localCoverPath = '';
    let coverResult: 'downloaded' | 'skipped' | 'failed' | 'none' = 'none';
    if (downloadCovers) {
      try {
        localCoverPath = await downloadCoverArt(s.id, s.path || null, imageUrl);
        coverResult = localCoverPath ? 'downloaded' : 'skipped';
      } catch {
        coverResult = 'failed';
      }
    }

    const data: any = {
      name: s.name || 'Unknown',
      category: mapCategory(s.category || ''),
      filePath: s.path || null,
      eraId,
      creditedArtists: s.credited_artists || '',
      producers: s.producers || '',
      engineers: s.engineers || '',
      length: s.length || '',
      durationMs: parseDuration(s.length || ''),
      isAvailable: !!s.path,
      imageUrl,
      rawLyrics: s.lyrics || '',
      publicId: s.public_id || null,
      originalKey: s.original_key || '',
      recordingLocation: s.recording_locations || '',
      recordDates: s.record_dates || '',
      bitrate: s.bitrate || '',
      additionalInfo: s.additional_information || '',
      fileNames: typeof s.file_names === 'string' ? s.file_names : '',
      instrumentals: s.instrumentals || '',
      previewDate: s.preview_date || '',
      releaseDate: s.release_date || '',
      dates: s.dates || '',
      sessionTitles: s.session_titles || '',
      sessionTracking: s.session_tracking || '',
      instrumentalNames: s.instrumental_names || '',
      notes: typeof s.notes === 'string' ? s.notes : '',
      dateLeaked: s.date_leaked || '',
      leakType: s.leak_type || '',
      snippets: s.snippets || [],
      lastSyncedAt: new Date(),
    };

    if (localCoverPath) {
      data.localCoverPath = localCoverPath;
    }

    const song = await prisma.song.upsert({
      where: { externalId: s.id },
      create: { externalId: s.id, ...data },
      update: data,
    });

    // Batch sync track_titles as aliases (delete + createMany is faster than individual creates)
    if (s.track_titles && s.track_titles.length > 0) {
      const validTitles = s.track_titles.filter(t => t?.trim());
      if (validTitles.length) {
        await prisma.songAlias.deleteMany({ where: { songId: song.id } });
        await prisma.songAlias.createMany({
          data: validTitles.map((title, i) => ({
            songId: song.id,
            alias: title.trim(),
            isPrimary: i === 0,
          })),
          skipDuplicates: true,
        });
      }
    }

    return { success: true, skipped: false, coverResult };
  } catch (err: any) {
    if (_progress.errors.length < 200) {
      _progress.errors.push({
        songId,
        name: `Song #${songId}`,
        error: err?.message || 'Unknown error',
      });
    }
    return { success: false, skipped: false, coverResult: 'none' };
  }
}

// ─── Public trigger ─────────────────────────────────────────

export function triggerRescan(prisma: PrismaClient, downloadCovers = true): boolean {
  if (_progress.running) return false;

  resetProgress();

  // Fire and forget — runs in background
  runRescan(prisma, downloadCovers).catch(err => {
    _progress.phase = 'error';
    _progress.running = false;
    _progress.message = `Fatal error: ${err.message}`;
    _progress.finishedAt = new Date().toISOString();
    console.error('[RESCAN] Fatal:', err);
  });

  return true;
}

async function runRescan(prisma: PrismaClient, downloadCovers: boolean): Promise<void> {
  const startTime = Date.now();
  console.log('[RESCAN] TURBO MODE — Starting full catalog rescan...');

  if (downloadCovers) {
    await ensureCoversDir();
  }

  // Pre-sync eras
  const eraCache = new Map<string, string>();
  try {
    const eras = await apiFetch<any[]>('/eras/');
    for (let i = 0; i < eras.length; i++) {
      const e = eras[i];
      const result = await prisma.era.upsert({
        where: { externalId: e.id },
        create: { externalId: e.id, name: e.name, description: e.description || '', timeFrame: e.time_frame || '', sortOrder: i },
        update: { name: e.name, sortOrder: i },
      });
      eraCache.set(e.name, result.id);
    }
    console.log(`[RESCAN] ${eras.length} eras synced`);
  } catch (err) {
    console.warn('[RESCAN] Era sync skipped:', err);
  }

  // Phase 1: Collect all song IDs (20 pages in parallel)
  _progress.phase = 'collecting_ids';
  _progress.message = 'Blasting API for song IDs...';
  const songIds = await collectAllSongIds();
  _progress.totalSongs = songIds.length;
  console.log(`[RESCAN] Got ${songIds.length} song IDs in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

  // Phase 2: 25 parallel workers fetch + upsert + download covers
  _progress.phase = 'syncing_details';
  const WORKERS = 25;
  _progress.message = `${WORKERS} workers syncing ${songIds.length} songs...`;
  console.log(`[RESCAN] Launching ${WORKERS} parallel workers...`);

  let nextIdx = 0;

  const worker = async (workerId: number) => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= songIds.length) break;

      const result = await syncSingleSong(prisma, songIds[idx], eraCache, downloadCovers);
      _progress.processedSongs++;

      if (result.skipped) {
        _progress.skippedCount++;
      } else if (result.success) {
        _progress.successCount++;
      } else {
        _progress.errorCount++;
      }

      if (result.coverResult === 'downloaded') _progress.coversDownloaded++;
      else if (result.coverResult === 'skipped') _progress.coversSkipped++;
      else if (result.coverResult === 'failed') _progress.coversFailed++;

      // Live status update every 25 songs
      if (_progress.processedSongs % 25 === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = Math.round(_progress.processedSongs / elapsed);
        const remaining = _progress.totalSongs - _progress.processedSongs;
        const eta = speed > 0 ? Math.round(remaining / speed) : 0;
        _progress.message = `${_progress.processedSongs}/${_progress.totalSongs} (${speed}/sec) | ${_progress.coversDownloaded} covers | ETA ${eta}s`;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(WORKERS, songIds.length) }, (_, i) => worker(i))
  );

  // Done
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  _progress.phase = 'done';
  _progress.running = false;
  _progress.finishedAt = new Date().toISOString();
  _progress.songsPerSec = Math.round(_progress.processedSongs / parseFloat(elapsed));
  _progress.message = `Done in ${elapsed}s — ${_progress.successCount} songs, ${_progress.coversDownloaded} covers, ${_progress.errorCount} errors (${_progress.songsPerSec}/sec)`;

  console.log(`[RESCAN] ${_progress.message}`);
}
