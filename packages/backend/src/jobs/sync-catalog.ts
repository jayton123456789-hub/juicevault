/**
 * Catalog Sync Job — FULL DATA
 * 
 * Phase 1: Fetch paginated list to get all song IDs
 * Phase 2: Fetch individual song details for FULL data (lyrics, path, image_url, etc.)
 * 
 * The list endpoint /songs/ only returns: id, name, category, era.name, credited_artists, producers
 * The detail endpoint /songs/{id}/ returns EVERYTHING: lyrics, path, image_url, track_titles, etc.
 * 
 * Run: npx tsx src/jobs/sync-catalog.ts
 */

import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../../.env') });

import { PrismaClient, SongCategory } from '@prisma/client';

const prisma = new PrismaClient({ log: ['error'] });
const API_BASE = process.env.JUICEWRLD_API_BASE || 'https://juicewrldapi.com/juicewrld';

async function apiFetch<T>(path: string, retries = 3): Promise<T> {
  const url = `${API_BASE}${path}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          // Rate limited or server error — wait and retry
          const wait = attempt * 2000;
          console.error(`  ⚠️ API ${res.status} on ${path}, retrying in ${wait / 1000}s...`);
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
  throw new Error(`Failed after ${retries} retries: ${path}`);
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

/** Make image_url absolute if it's relative */
function fixImageUrl(imageUrl: string): string {
  if (!imageUrl) return '';
  if (imageUrl.startsWith('http')) return imageUrl;
  // Relative like "/assets/youtube.webp" — prepend API origin
  return `https://juicewrldapi.com${imageUrl.startsWith('/') ? '' : '/'}${imageUrl}`;
}

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

/** Phase 1: Collect all song IDs from paginated list */
async function collectAllSongIds(category?: string): Promise<number[]> {
  const ids: number[] = [];
  let page = 1;
  const pageSize = 100;

  // Get total count first
  let url = `/songs/?page=1&page_size=1${category ? '&category=' + category : ''}`;
  const first = await apiFetch<PageResponse>(url);
  const total = first.count;
  const totalPages = Math.ceil(total / pageSize);

  console.log(`  📊 ${total.toLocaleString()} songs across ${totalPages} pages`);
  console.log(`  📋 Collecting song IDs...`);

  // Fetch all pages in parallel (batches of 10)
  const batchSize = 10;
  for (let batch = 0; batch < totalPages; batch += batchSize) {
    const promises = [];
    for (let p = batch; p < Math.min(batch + batchSize, totalPages); p++) {
      const pageNum = p + 1;
      const pageUrl = `/songs/?page=${pageNum}&page_size=${pageSize}${category ? '&category=' + category : ''}`;
      promises.push(apiFetch<PageResponse>(pageUrl).catch(() => null));
    }
    const results = await Promise.all(promises);
    for (const r of results) {
      if (r?.results) {
        for (const song of r.results) {
          ids.push(song.id);
        }
      }
    }
    process.stdout.write(`\r  📋 Collected ${ids.length}/${total} IDs...   `);
  }
  console.log('');
  return ids;
}

/** Phase 2: Fetch full details and upsert */
async function syncSongDetail(
  songId: number,
  eraCache: Map<string, string>
): Promise<{ success: boolean; hasLyrics: boolean; hasPath: boolean; hasImage: boolean }> {
  const result = { success: false, hasLyrics: false, hasPath: false, hasImage: false };

  try {
    const s = await apiFetch<FullSong>(`/songs/${songId}/`);

    // Handle era
    let eraId: string | null = null;
    if (s.era) {
      const eraName = s.era.name;
      const eraExtId = s.era.id;

      if (eraName && eraCache.has(eraName)) {
        eraId = eraCache.get(eraName)!;
      } else if (eraName && eraExtId) {
        try {
          const era = await prisma.era.upsert({
            where: { externalId: eraExtId },
            create: {
              externalId: eraExtId,
              name: eraName,
              description: s.era.description || '',
              timeFrame: s.era.time_frame || '',
              playCount: s.era.play_count || 0,
            },
            update: { name: eraName },
          });
          eraCache.set(eraName, era.id);
          eraId = era.id;
        } catch { /* skip era error */ }
      }
    }

    const imageUrl = fixImageUrl(s.image_url || '');

    const data = {
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
      imageUrl: imageUrl,
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

    const song = await prisma.song.upsert({
      where: { externalId: s.id },
      create: { externalId: s.id, ...data },
      update: data,
    });

    // Sync track_titles as aliases
    if (s.track_titles && s.track_titles.length > 0) {
      // Delete old aliases and recreate
      await prisma.songAlias.deleteMany({ where: { songId: song.id } });
      for (let i = 0; i < s.track_titles.length; i++) {
        const title = s.track_titles[i];
        if (title && title.trim()) {
          await prisma.songAlias.create({
            data: {
              songId: song.id,
              alias: title.trim(),
              isPrimary: i === 0,
            },
          }).catch(() => {}); // skip duplicate errors
        }
      }
    }

    result.success = true;
    result.hasLyrics = !!(s.lyrics && s.lyrics.trim());
    result.hasPath = !!s.path;
    result.hasImage = !!imageUrl;
  } catch {
    // Failed for this song
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const category = args.find(a => a.startsWith('--category='))?.split('=')[1];
  const workers = Number(args.find(a => a.startsWith('--workers='))?.split('=')[1]) || 10;
  const maxSongs = Number(args.find(a => a.startsWith('--max-songs='))?.split('=')[1]) || Infinity;

  console.log('');
  console.log('  🧃 JuiceVault Catalog Sync — FULL DATA');
  console.log('  ═══════════════════════════════════════');
  console.log(`  DB:       ${process.env.DATABASE_URL ? '✅ connected' : '❌ no DATABASE_URL!'}`);
  console.log(`  API:      ${API_BASE}`);
  console.log(`  Workers:  ${workers}`);
  console.log(`  Category: ${category || 'all'}`);
  if (maxSongs < Infinity) console.log(`  Max songs: ${maxSongs}`);
  console.log('');

  if (!process.env.DATABASE_URL) {
    console.error('  ❌ DATABASE_URL not set! Check your .env file.');
    process.exit(1);
  }

  // Test DB
  try {
    await prisma.$connect();
    console.log('  ✅ Database connected');
  } catch (err) {
    console.error('  ❌ Database connection failed:', (err as Error).message);
    process.exit(1);
  }

  // Test API
  try {
    const test = await apiFetch<{ total_songs: number }>('/stats/');
    console.log(`  ✅ API online (${test.total_songs.toLocaleString()} total songs in API)`);
  } catch (err) {
    console.error('  ❌ API connection failed:', (err as Error).message);
    process.exit(1);
  }

  // Sync eras first
  console.log('');
  console.log('  🎨 Syncing eras...');
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
    console.log(`  ✅ ${eras.length} eras synced`);
  } catch { console.log('  ⚠️ Era sync skipped'); }

  // Phase 1: Collect all song IDs
  console.log('');
  console.log('  ══ PHASE 1: Collecting song IDs ══');
  let songIds = await collectAllSongIds(category);

  if (maxSongs < Infinity) {
    songIds = songIds.slice(0, maxSongs);
    console.log(`  ✂️ Limited to ${songIds.length} songs`);
  }

  // Phase 2: Fetch full details for each song
  console.log('');
  console.log('  ══ PHASE 2: Fetching full song details ══');
  console.log(`  🚀 Fetching ${songIds.length} songs with ${workers} workers...`);
  console.log('     (This fetches lyrics, file paths, cover art URLs, aliases, etc.)');
  console.log('');

  const start = Date.now();
  let synced = 0, errors = 0, withLyrics = 0, withPath = 0, withImage = 0;
  let nextIdx = 0;

  const progress = () => {
    const done = synced + errors;
    const pct = Math.round((done / songIds.length) * 100);
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    process.stdout.write(`\r  ⚡ ${done}/${songIds.length} (${pct}%) — ${synced} ok, ${errors} err | 🎵${withPath} playable | 📝${withLyrics} lyrics | 🖼️${withImage} covers | ${elapsed}s   `);
  };

  const worker = async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= songIds.length) break;

      const result = await syncSongDetail(songIds[idx], eraCache);
      if (result.success) {
        synced++;
        if (result.hasLyrics) withLyrics++;
        if (result.hasPath) withPath++;
        if (result.hasImage) withImage++;
      } else {
        errors++;
      }
      if ((synced + errors) % 10 === 0) progress();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(workers, songIds.length) }, () => worker())
  );

  progress();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log('');
  console.log('');
  console.log('  ════════════════════════════════════════');
  console.log(`  ✅ Done in ${elapsed}s`);
  console.log(`  📀 ${synced.toLocaleString()} songs synced`);
  console.log(`  🎵 ${withPath.toLocaleString()} with playable audio`);
  console.log(`  📝 ${withLyrics.toLocaleString()} with lyrics`);
  console.log(`  🖼️  ${withImage.toLocaleString()} with cover art URL`);
  if (errors > 0) console.log(`  ❌ ${errors} errors`);
  console.log(`  ⚡ ${(synced / parseFloat(elapsed)).toFixed(0)} songs/sec`);
  console.log('  ════════════════════════════════════════');

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('');
  console.error('  ❌ FATAL:', err.message);
  process.exit(1);
});
