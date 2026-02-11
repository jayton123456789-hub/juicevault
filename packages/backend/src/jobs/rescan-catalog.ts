/**
 * Rescan Catalog Job — Runs in-process from admin API
 *
 * - Fetches every song from the JuiceWRLD API (paginated)
 * - Upserts full metadata into DB
 * - Downloads cover art images to /public/covers/
 * - Tracks progress for the admin UI to poll
 * - Idempotent & retry-safe
 */

import { PrismaClient, SongCategory } from '@prisma/client';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// ─── Progress Tracking ────────────────────────────────────

export interface RescanProgress {
  running: boolean;
  phase: 'idle' | 'collecting_ids' | 'syncing_details' | 'downloading_covers' | 'done' | 'error';
  totalSongs: number;
  processedSongs: number;
  successCount: number;
  errorCount: number;
  coversDownloaded: number;
  coversSkipped: number;
  coversFailed: number;
  startedAt: string | null;
  finishedAt: string | null;
  errors: Array<{ songId: number; name: string; error: string }>;
  message: string;
}

let _progress: RescanProgress = {
  running: false,
  phase: 'idle',
  totalSongs: 0,
  processedSongs: 0,
  successCount: 0,
  errorCount: 0,
  coversDownloaded: 0,
  coversSkipped: 0,
  coversFailed: 0,
  startedAt: null,
  finishedAt: null,
  errors: [],
  message: '',
};

export function getRescanProgress(): RescanProgress {
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
    coversDownloaded: 0,
    coversSkipped: 0,
    coversFailed: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    errors: [],
    message: 'Starting full catalog rescan...',
  };
}

// ─── API Helpers ────────────────────────────────────────────

const API_BASE = process.env.JUICEWRLD_API_BASE || 'https://juicewrldapi.com/juicewrld';

async function apiFetch<T>(urlPath: string, retries = 3): Promise<T> {
  const url = `${API_BASE}${urlPath}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          const wait = attempt * 2000;
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw new Error(`API ${res.status}: ${res.statusText}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, attempt * 1000));
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

// ─── Cover Art Download ─────────────────────────────────────

const COVERS_DIR = path.join(__dirname, '../../public/covers');

async function ensureCoversDir(): Promise<void> {
  if (!existsSync(COVERS_DIR)) {
    await mkdir(COVERS_DIR, { recursive: true });
  }
}

/**
 * Download cover art for a song. Priority:
 * 1. Embedded cover art from the API (album cover from the actual file)
 * 2. imageUrl from the song metadata (Spotify/era image)
 * 3. Skip (placeholder will be used)
 */
async function downloadCoverArt(
  externalId: number,
  filePath: string | null,
  imageUrl: string
): Promise<string> {
  const filename = `${externalId}.jpg`;
  const localPath = path.join(COVERS_DIR, filename);

  // Skip if already downloaded
  if (existsSync(localPath)) {
    return `/covers/${filename}`;
  }

  // Priority 1: Try embedded cover art from the audio file
  if (filePath) {
    try {
      const encodedPath = encodeURIComponent(filePath);
      const coverUrl = `${API_BASE}/files/cover-art/?path=${encodedPath}`;
      const response = await fetch(coverUrl);
      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.startsWith('image/')) {
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > 1000) { // Sanity check: real image > 1KB
            await writeFile(localPath, buffer);
            return `/covers/${filename}`;
          }
        }
      }
    } catch {
      // Fall through to imageUrl
    }
  }

  // Priority 2: Try the imageUrl (Spotify/external)
  if (imageUrl && imageUrl.startsWith('http')) {
    try {
      const response = await fetch(imageUrl);
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
    } catch {
      // No cover available
    }
  }

  return ''; // No cover art found
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

async function collectAllSongIds(): Promise<number[]> {
  const ids: number[] = [];
  const pageSize = 100;

  const first = await apiFetch<PageResponse>('/songs/?page=1&page_size=1');
  const total = first.count;
  const totalPages = Math.ceil(total / pageSize);

  _progress.totalSongs = total;
  _progress.message = `Collecting ${total} song IDs across ${totalPages} pages...`;

  const batchSize = 10;
  for (let batch = 0; batch < totalPages; batch += batchSize) {
    const promises = [];
    for (let p = batch; p < Math.min(batch + batchSize, totalPages); p++) {
      const pageUrl = `/songs/?page=${p + 1}&page_size=${pageSize}`;
      promises.push(apiFetch<PageResponse>(pageUrl).catch(() => null));
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

async function syncSingleSong(
  prisma: PrismaClient,
  songId: number,
  eraCache: Map<string, string>,
  downloadCovers: boolean
): Promise<{ success: boolean; coverResult: 'downloaded' | 'skipped' | 'failed' | 'none' }> {
  try {
    const s = await apiFetch<FullSong>(`/songs/${songId}/`);

    // Handle era
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

    // Download cover art if requested
    let localCoverPath = '';
    let coverResult: 'downloaded' | 'skipped' | 'failed' | 'none' = 'none';
    if (downloadCovers) {
      try {
        localCoverPath = await downloadCoverArt(s.id, s.path || null, imageUrl);
        if (localCoverPath) {
          // Check if it was already there vs newly downloaded
          coverResult = 'downloaded';
        } else {
          coverResult = 'skipped';
        }
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

    // Sync track_titles as aliases
    if (s.track_titles && s.track_titles.length > 0) {
      await prisma.songAlias.deleteMany({ where: { songId: song.id } });
      for (let i = 0; i < s.track_titles.length; i++) {
        const title = s.track_titles[i];
        if (title?.trim()) {
          await prisma.songAlias.create({
            data: { songId: song.id, alias: title.trim(), isPrimary: i === 0 },
          }).catch(() => {});
        }
      }
    }

    return { success: true, coverResult };
  } catch (err: any) {
    _progress.errors.push({
      songId,
      name: `Song #${songId}`,
      error: err?.message || 'Unknown error',
    });
    return { success: false, coverResult: 'none' };
  }
}

// ─── Public trigger ─────────────────────────────────────────

export function triggerRescan(prisma: PrismaClient, downloadCovers = true): boolean {
  if (_progress.running) return false;

  resetProgress();

  // Run async — don't await
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
  console.log('[RESCAN] Starting full catalog rescan...');

  // Ensure covers directory exists
  if (downloadCovers) {
    await ensureCoversDir();
  }

  // Sync eras first
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

  // Phase 1: Collect all song IDs
  _progress.phase = 'collecting_ids';
  _progress.message = 'Collecting song IDs from API...';
  const songIds = await collectAllSongIds();
  _progress.totalSongs = songIds.length;
  console.log(`[RESCAN] Collected ${songIds.length} song IDs`);

  // Phase 2: Fetch details + download covers
  _progress.phase = 'syncing_details';
  _progress.message = `Syncing ${songIds.length} songs with ${downloadCovers ? 'cover art download' : 'metadata only'}...`;

  const workers = 8;
  let nextIdx = 0;

  const worker = async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= songIds.length) break;

      const result = await syncSingleSong(prisma, songIds[idx], eraCache, downloadCovers);
      _progress.processedSongs++;

      if (result.success) {
        _progress.successCount++;
      } else {
        _progress.errorCount++;
      }

      if (result.coverResult === 'downloaded') _progress.coversDownloaded++;
      else if (result.coverResult === 'skipped') _progress.coversSkipped++;
      else if (result.coverResult === 'failed') _progress.coversFailed++;

      // Update message every 50 songs
      if (_progress.processedSongs % 50 === 0) {
        _progress.message = `Processed ${_progress.processedSongs}/${_progress.totalSongs} songs (${_progress.coversDownloaded} covers downloaded)`;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(workers, songIds.length) }, () => worker())
  );

  // Done
  _progress.phase = 'done';
  _progress.running = false;
  _progress.finishedAt = new Date().toISOString();
  _progress.message = `Rescan complete: ${_progress.successCount} songs synced, ${_progress.coversDownloaded} covers downloaded, ${_progress.errorCount} errors`;

  console.log(`[RESCAN] ${_progress.message}`);
}
