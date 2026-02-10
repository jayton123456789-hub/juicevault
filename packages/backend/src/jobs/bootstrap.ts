/**
 * Bootstrap — runs on deploy to set up admin + invite codes + sync catalog
 * Safe to run multiple times — skips if already set up.
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../../.env') });

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const API_BASE = process.env.JUICEWRLD_API_BASE || 'https://juicewrldapi.com/juicewrld';

async function bootstrap() {
  console.log('🔧 Running bootstrap...');

  // ─── Create admin if no users exist ────────────────
  const userCount = await prisma.user.count();
  if (userCount === 0) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@juicevault.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'JuiceVault2026!';
    const hash = await bcrypt.hash(adminPassword, 12);

    const admin = await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: hash,
        displayName: 'Admin',
        role: 'admin',
        isActive: true,
      },
    });
    console.log(`  ✅ Admin created: ${adminEmail} / ${adminPassword}`);

    // Create invite codes
    for (const code of ['JUICE999', 'WRLD999', 'VAULT999', 'LEGENDS999', 'ABYSS999',
                         'JUICE001', 'JUICE002', 'JUICE003', 'JUICE004', 'JUICE005',
                         'JUICE006', 'JUICE007', 'JUICE008', 'JUICE009', 'JUICE010']) {
      await prisma.invite.create({
        data: {
          code,
          createdBy: admin.id,
          expiresAt: new Date('2030-01-01'),
        },
      });
    }
    console.log('  ✅ 15 invite codes created (JUICE999, WRLD999, etc.)');
  } else {
    console.log(`  ✅ ${userCount} users exist, skipping admin creation.`);
  }

  // ─── Sync catalog if no songs exist ────────────────
  const songCount = await prisma.song.count();
  if (songCount === 0) {
    console.log('  📡 Syncing song catalog from API...');
    await syncCatalog();
  } else {
    console.log(`  ✅ ${songCount} songs already in DB, skipping sync.`);
  }

  console.log('🔧 Bootstrap complete!');
  await prisma.$disconnect();
}

// ─── Catalog Sync (simplified inline version) ────────────

async function syncCatalog() {
  // Fetch eras first
  try {
    const eraRes = await fetch(`${API_BASE}/eras/`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (eraRes.ok) {
      const eraData: unknown = await eraRes.json();
      const eras: any[] = Array.isArray(eraData) ? eraData : [];
      for (const era of eras) {
        await prisma.era.upsert({
          where: { externalId: era.id },
          update: { name: era.name, description: era.description || '', timeFrame: era.time_frame || '', playCount: era.play_count || 0 },
          create: { externalId: era.id, name: era.name, description: era.description || '', timeFrame: era.time_frame || '', playCount: era.play_count || 0, sortOrder: era.id },
        });
      }
      console.log(`  ✅ ${eras.length} eras synced`);
    }
  } catch (e: any) {
    console.warn(`  ⚠ Era sync failed: ${e.message}`);
  }

  // Fetch all songs page by page
  let page = 1;
  let totalSynced = 0;
  const pageSize = 100;

  while (true) {
    try {
      const url = `${API_BASE}/songs/?page=${page}&page_size=${pageSize}`;
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) {
        console.warn(`  ⚠ API returned ${res.status} on page ${page}`);
        break;
      }

      const data: any = await res.json();
      const songs = data.results || [];

      if (!songs.length) break;

      // Find eras for lookup
      const allEras = await prisma.era.findMany();
      const eraMap = new Map(allEras.map((e: any) => [e.externalId, e.id]));

      for (const s of songs) {
        const eraId = s.era?.id ? eraMap.get(s.era.id) || null : null;

        await prisma.song.upsert({
          where: { externalId: s.id },
          update: {
            name: s.name || 'Untitled',
            category: mapCategory(s.category),
            filePath: s.path || null,
            creditedArtists: s.credited_artists || '',
            producers: s.producers || '',
            engineers: s.engineers || '',
            recordingLocation: s.recording_location || '',
            recordDates: s.record_dates || '',
            length: s.length || '',
            bitrate: s.bitrate || '',
            rawLyrics: s.lyrics || '',
            imageUrl: s.image_url || '',
            dateLeaked: s.date_leaked || '',
            leakType: s.leak_type || '',
            additionalInfo: s.additional_info || '',
            releaseDate: s.release_date || '',
            previewDate: s.preview_date || '',
            notes: typeof s.notes === 'object' ? JSON.stringify(s.notes) : (s.notes || ''),
            snippets: Array.isArray(s.snippets) ? s.snippets : [],
            eraId,
            publicId: s.public_id || null,
            originalKey: s.original_key || '',
            isAvailable: !!s.path,
            lastSyncedAt: new Date(),
          },
          create: {
            externalId: s.id,
            name: s.name || 'Untitled',
            category: mapCategory(s.category),
            filePath: s.path || null,
            creditedArtists: s.credited_artists || '',
            producers: s.producers || '',
            engineers: s.engineers || '',
            recordingLocation: s.recording_location || '',
            recordDates: s.record_dates || '',
            length: s.length || '',
            bitrate: s.bitrate || '',
            rawLyrics: s.lyrics || '',
            imageUrl: s.image_url || '',
            dateLeaked: s.date_leaked || '',
            leakType: s.leak_type || '',
            additionalInfo: s.additional_info || '',
            releaseDate: s.release_date || '',
            previewDate: s.preview_date || '',
            notes: typeof s.notes === 'object' ? JSON.stringify(s.notes) : (s.notes || ''),
            snippets: Array.isArray(s.snippets) ? s.snippets : [],
            eraId,
            publicId: s.public_id || null,
            originalKey: s.original_key || '',
            isAvailable: !!s.path,
            lastSyncedAt: new Date(),
          },
        });
        totalSynced++;
      }

      console.log(`  📦 Page ${page}: ${songs.length} songs (${totalSynced} total)`);

      if (!data.next) break;
      page++;
    } catch (e: any) {
      console.warn(`  ⚠ Page ${page} failed: ${e.message}`);
      break;
    }
  }

  console.log(`  ✅ Catalog sync complete: ${totalSynced} songs`);
}

function mapCategory(cat: string): 'released' | 'unreleased' | 'unsurfaced' | 'recording_session' {
  switch (cat?.toLowerCase()) {
    case 'released': return 'released';
    case 'unreleased': return 'unreleased';
    case 'unsurfaced': return 'unsurfaced';
    case 'recording_session':
    case 'recording session': return 'recording_session';
    default: return 'unreleased';
  }
}

bootstrap().catch(e => {
  console.error('Bootstrap failed:', e.message);
  // Don't exit(1) — let the deploy continue even if bootstrap fails
});
