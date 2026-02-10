/**
 * Sync Lyrics Job — AssemblyAI Free Tier
 * 
 * Batch-processes songs through AssemblyAI to generate timed lyrics.
 * Uses the free 185-hour tier with word-level timestamps.
 *
 * CRITICAL: dotenv MUST load before ANY other imports that read process.env.
 *
 * Usage:
 *   npx tsx src/jobs/sync-lyrics.ts [options]
 *
 * Options:
 *   --max-songs=N     Limit to N songs (default: all)
 *   --workers=N       Parallel workers (default: 3, AAI free tier = 5 concurrent)
 *   --dry-run         Show what would be processed without actually doing it
 *   --force           Re-process songs that already have timed lyrics
 *   --test=1          Process just 1 song to verify everything works
 */

// ─── STEP 1: Load .env BEFORE anything else ─────────────
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../../.env') });

// ─── STEP 2: Now safe to import modules that read process.env ─
import { PrismaClient } from '@prisma/client';
import { generateTimedLyrics } from '../services/lyric-aligner';

// Own PrismaClient instance (not shared with server)
const prisma = new PrismaClient({ log: ['error'] });

// ─── Config ─────────────────────────────────────────────

// The Juice WRLD API base — audio is at /files/download/?path=...
// .env has JUICEWRLD_API_BASE=https://juicewrldapi.com/juicewrld
const API_BASE = process.env.JUICEWRLD_API_BASE || 'https://juicewrldapi.com/juicewrld';

const args = process.argv.slice(2);
function getArg(name: string, def: string): string {
  const found = args.find(a => a.startsWith(`--${name}=`));
  return found ? found.split('=')[1] : def;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const MAX_SONGS = hasFlag('test')
  ? parseInt(getArg('test', '1'), 10)
  : (parseInt(getArg('max-songs', '0'), 10) || Infinity);
const WORKERS = Math.min(parseInt(getArg('workers', '3'), 10), 5); // AAI free = 5 concurrent max
const DRY_RUN = hasFlag('dry-run');
const FORCE = hasFlag('force');

// ─── Stats ──────────────────────────────────────────────

const stats = {
  total: 0,
  processed: 0,
  success: 0,
  skipped: 0,
  failed: 0,
  errors: [] as string[],
  startTime: Date.now(),
};

function elapsed(): string {
  const s = Math.round((Date.now() - stats.startTime) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

function progressLine(): string {
  const pct = stats.total > 0 ? ((stats.processed / stats.total) * 100).toFixed(1) : '0';
  return `  ⚡ ${stats.processed}/${stats.total} (${pct}%) — ✅${stats.success} ⏭${stats.skipped} ❌${stats.failed} | ${elapsed()}`;
}

// ─── Preflight Checks ───────────────────────────────────

async function preflight(): Promise<boolean> {
  let ok = true;

  // Check AssemblyAI key
  const aaiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!aaiKey) {
    console.error('  ❌ ASSEMBLYAI_API_KEY not found in .env!');
    console.error('     Add this line to packages\\backend\\.env:');
    console.error('     ASSEMBLYAI_API_KEY=your_key_here');
    ok = false;
  } else {
    console.log(`  ✅ AssemblyAI key: ${aaiKey.slice(0, 8)}...${aaiKey.slice(-4)}`);
  }

  // Check database connection
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('  ✅ Database connected');
  } catch (err: any) {
    console.error(`  ❌ Database connection failed: ${err.message}`);
    console.error('     Is PostgreSQL running? Check DATABASE_URL in .env');
    ok = false;
  }

  // Check Juice WRLD API is reachable
  try {
    const res = await fetch(`${API_BASE}/stats/`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      console.log(`  ✅ Juice WRLD API reachable (${API_BASE})`);
    } else {
      console.error(`  ❌ Juice WRLD API returned ${res.status}`);
      ok = false;
    }
  } catch (err: any) {
    console.error(`  ❌ Juice WRLD API unreachable: ${err.message}`);
    ok = false;
  }

  // Verify AssemblyAI key actually works
  if (aaiKey) {
    try {
      const res = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'POST',
        headers: {
          'Authorization': aaiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ audio_url: 'https://example.com/test.mp3' }),
      });
      // 400 = bad audio URL but auth worked. 401 = bad key.
      if (res.status === 401) {
        console.error('  ❌ AssemblyAI API key is INVALID (401 Unauthorized)');
        ok = false;
      } else {
        console.log('  ✅ AssemblyAI key is valid');
        // Cancel the test transcript we just created
        try {
          const data: any = await res.json();
          if (data.id) {
            await fetch(`https://api.assemblyai.com/v2/transcript/${data.id}`, {
              method: 'DELETE',
              headers: { 'Authorization': aaiKey },
            }).catch(() => {});
          }
        } catch {}
      }
    } catch (err: any) {
      console.error(`  ❌ AssemblyAI connection failed: ${err.message}`);
      ok = false;
    }
  }

  // Test that a sample audio URL is reachable
  try {
    const testSong = await prisma.song.findFirst({
      where: { filePath: { not: null }, isAvailable: true },
      select: { filePath: true, name: true },
    });
    if (testSong?.filePath) {
      const testUrl = buildAudioUrl(testSong.filePath);
      const res = await fetch(testUrl, {
        method: 'HEAD',
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok || res.status === 206) {
        console.log(`  ✅ Audio streaming works (tested: ${testSong.name.slice(0, 30)})`);
      } else {
        console.warn(`  ⚠ Audio HEAD returned ${res.status} — may still work for GET`);
      }
    }
  } catch (err: any) {
    console.warn(`  ⚠ Audio test failed: ${err.message} — will try anyway`);
  }

  return ok;
}

// ─── Audio URL Builder ──────────────────────────────────

/**
 * Build the public audio URL that AssemblyAI can fetch.
 * The Juice WRLD API serves files at: {base}/files/download/?path={encoded_path}
 * No auth required — this is a public API.
 */
function buildAudioUrl(filePath: string): string {
  return `${API_BASE}/files/download/?path=${encodeURIComponent(filePath)}`;
}

// ─── System User ────────────────────────────────────────

async function getOrCreateSystemUser(): Promise<string> {
  const SYSTEM_EMAIL = 'system@juicevault.local';

  let systemUser = await prisma.user.findUnique({ where: { email: SYSTEM_EMAIL } });

  if (!systemUser) {
    console.log('  Creating system user for auto-generated lyrics...');
    systemUser = await prisma.user.create({
      data: {
        email: SYSTEM_EMAIL,
        passwordHash: 'SYSTEM_ACCOUNT_NO_LOGIN',
        displayName: '🤖 JuiceVault System',
        role: 'admin',
        isActive: false,
      },
    });
    console.log(`  ✅ System user created: ${systemUser.id.slice(0, 8)}...`);
  }

  return systemUser.id;
}

// ─── Process Single Song ────────────────────────────────

async function processSong(
  song: {
    id: string;
    name: string;
    filePath: string | null;
    rawLyrics: string;
    durationMs: number | null;
  },
  systemUserId: string
): Promise<'success' | 'skipped' | 'failed'> {
  if (!song.filePath) return 'skipped';

  const rawText = song.rawLyrics?.trim();
  if (!rawText || rawText.length < 20) return 'skipped'; // Too short to align

  // Count actual lyric lines (skip empty and section headers like [Verse 1])
  const lyricLines = rawText.split('\n').filter(l => {
    const t = l.trim();
    return t.length > 0 && !t.match(/^\[.*\]$/);
  });
  if (lyricLines.length < 3) return 'skipped'; // Need at least 3 lines

  const audioUrl = buildAudioUrl(song.filePath);

  // Generate timed lyrics via AssemblyAI
  const result = await generateTimedLyrics(audioUrl, rawText);

  if (!result || !result.timedLines.length) return 'skipped';

  // Count how many lines got real timestamps (confidence > 0)
  const timedCount = result.timedLines.filter(l => l.confidence > 0).length;
  const timedPct = timedCount / result.timedLines.length;

  if (timedPct < 0.3) {
    // Less than 30% matched — alignment was too poor
    return 'skipped';
  }

  // Build lyricsData JSON
  const lyricsData = result.timedLines.map((line, i) => ({
    id: `l${i + 1}`,
    start_ms: line.start_ms,
    end_ms: line.end_ms,
    text: line.text,
    confidence: line.confidence,
  }));

  // Check for existing canonical version
  const existing = await prisma.lyricsVersion.findFirst({
    where: { songId: song.id, isCanonical: true },
  });

  if (existing) {
    await prisma.lyricsVersion.update({
      where: { id: existing.id },
      data: {
        lyricsData: lyricsData as any,
        source: 'auto_generated',
      },
    });
  } else {
    const maxVersion = await prisma.lyricsVersion.aggregate({
      where: { songId: song.id },
      _max: { versionNumber: true },
    });

    await prisma.lyricsVersion.create({
      data: {
        songId: song.id,
        authorId: systemUserId,
        versionNumber: (maxVersion._max.versionNumber || 0) + 1,
        source: 'auto_generated',
        status: 'approved',
        isCanonical: true,
        lyricsData: lyricsData as any,
      },
    });
  }

  return 'success';
}

// ─── Worker Loop ────────────────────────────────────────

async function workerLoop(workerId: number, queue: any[], systemUserId: string) {
  while (queue.length > 0) {
    const song = queue.shift();
    if (!song) break;

    stats.processed++;

    try {
      const result = await processSong(song, systemUserId);

      if (result === 'success') {
        stats.success++;
      } else if (result === 'skipped') {
        stats.skipped++;
      } else {
        stats.failed++;
      }
    } catch (err: any) {
      stats.failed++;
      const msg = `${song.name}: ${err.message?.slice(0, 100)}`;
      stats.errors.push(msg);
      // Don't spam console — just log first 5 errors inline
      if (stats.errors.length <= 5) {
        console.log(`\n  ❌ [W${workerId}] ${msg}`);
      }
    }

    // Update progress every song
    process.stdout.write(`\r${progressLine()}`);

    // Small delay between songs to be nice to APIs
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

// ─── Main ───────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════╗');
  console.log('  ║     🎤 JuiceVault Lyrics Sync                    ║');
  console.log('  ║     AssemblyAI Free Tier (185 hours)              ║');
  console.log('  ╚═══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Workers:    ${WORKERS}`);
  console.log(`  Max songs:  ${MAX_SONGS === Infinity ? 'All' : MAX_SONGS}`);
  console.log(`  Dry run:    ${DRY_RUN}`);
  console.log(`  Force:      ${FORCE}`);
  console.log(`  API base:   ${API_BASE}`);
  console.log('');

  // ─── Preflight checks ──────────────────────────────
  console.log('  ── Preflight Checks ──────────────────────────');
  const ready = await preflight();
  console.log('');

  if (!ready) {
    console.error('  ❌ Preflight checks failed. Fix the issues above and try again.');
    await prisma.$disconnect();
    process.exit(1);
  }

  // ─── Get system user ───────────────────────────────
  const systemUserId = await getOrCreateSystemUser();

  // ─── Find songs needing lyrics ─────────────────────

  const whereConditions: any = {
    filePath: { not: null },
    isAvailable: true,
    category: { notIn: ['unsurfaced'] },
  };

  // rawLyrics must have actual content (not empty string)
  whereConditions.rawLyrics = { not: '' };

  if (!FORCE) {
    whereConditions.lyricsVersions = { none: { isCanonical: true } };
  }

  const songs = await prisma.song.findMany({
    where: whereConditions,
    select: {
      id: true,
      name: true,
      filePath: true,
      rawLyrics: true,
      durationMs: true,
    },
    orderBy: { name: 'asc' },
    take: MAX_SONGS === Infinity ? undefined : MAX_SONGS,
  });

  stats.total = songs.length;

  if (!songs.length) {
    console.log('  ✅ Nothing to do! All eligible songs already have timed lyrics.');
    console.log('     Use --force to re-process existing lyrics.');
    await prisma.$disconnect();
    return;
  }

  // ─── Estimate usage ────────────────────────────────

  const totalDurationHrs = songs.reduce((sum, s) => sum + (s.durationMs || 210000), 0) / 3600000;
  const lyricsLineCount = songs.reduce((sum, s) => sum + s.rawLyrics.split('\n').filter(l => l.trim()).length, 0);

  console.log(`  📋 Songs to process:     ${stats.total}`);
  console.log(`  📝 Total lyric lines:    ~${lyricsLineCount.toLocaleString()}`);
  console.log(`  ⏱  Estimated AAI usage:  ~${totalDurationHrs.toFixed(1)} hours`);
  console.log(`  💰 Free tier remaining:  185 hours`);
  console.log('');

  // ─── Dry run ───────────────────────────────────────

  if (DRY_RUN) {
    console.log('  🔍 DRY RUN — would process these songs:');
    console.log('');
    songs.slice(0, 40).forEach((s, i) => {
      const lines = s.rawLyrics.split('\n').filter((l: string) => l.trim()).length;
      const dur = s.durationMs ? `${Math.round(s.durationMs / 1000)}s` : '?s';
      console.log(`  ${String(i + 1).padStart(3)}. ${s.name.slice(0, 50).padEnd(50)} ${String(lines).padStart(3)} lines  ${dur}`);
    });
    if (songs.length > 40) console.log(`  ... and ${songs.length - 40} more`);
    console.log('');
    console.log(`  To run for real: npx tsx src/jobs/sync-lyrics.ts`);
    console.log(`  To test 1 song:  npx tsx src/jobs/sync-lyrics.ts --test`);
    await prisma.$disconnect();
    return;
  }

  // ─── Process with worker pool ──────────────────────

  console.log('  🚀 Starting lyrics sync...');
  console.log('     (Ctrl+C to cancel — progress is saved per-song)');
  console.log('');

  const queue = [...songs];
  const workers: Promise<void>[] = [];

  for (let w = 0; w < WORKERS; w++) {
    workers.push(workerLoop(w, queue, systemUserId));
  }

  await Promise.all(workers);

  // ─── Final report ──────────────────────────────────

  console.log('\n');
  console.log('  ╔═══════════════════════════════════════════════════╗');
  console.log('  ║     🎤 LYRICS SYNC COMPLETE                      ║');
  console.log('  ╚═══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Total:     ${stats.total}`);
  console.log(`  ✅ Success: ${stats.success}`);
  console.log(`  ⏭ Skipped: ${stats.skipped}`);
  console.log(`  ❌ Failed:  ${stats.failed}`);
  console.log(`  ⏱ Duration: ${elapsed()}`);
  console.log('');

  if (stats.errors.length) {
    console.log('  ── Errors ───────────────────────────────────');
    stats.errors.slice(0, 20).forEach(e => console.log(`  • ${e}`));
    if (stats.errors.length > 20) console.log(`  ... and ${stats.errors.length - 20} more`);
    console.log('');
  }

  if (stats.success > 0) {
    console.log(`  🎉 ${stats.success} songs now have synced lyrics!`);
    console.log('     Restart the server to see them in action.');
  }

  console.log('');
  await prisma.$disconnect();
}

// ─── Run ────────────────────────────────────────────────

main().catch(err => {
  console.error('\n  💥 Fatal error:', err.message || err);
  console.error('');
  if (err.message?.includes('ECONNREFUSED')) {
    console.error('  Hint: Is PostgreSQL running? Start Docker first.');
  }
  if (err.message?.includes('ASSEMBLYAI')) {
    console.error('  Hint: Check your ASSEMBLYAI_API_KEY in .env');
  }
  process.exit(1);
});
