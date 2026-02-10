/**
 * DB Diagnostic — check what actually synced
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../../.env') });

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('');
  console.log('  🔍 JuiceVault DB Diagnostic');
  console.log('  ═══════════════════════════');

  const totalSongs = await prisma.song.count();
  const withFilePath = await prisma.song.count({ where: { filePath: { not: null } } });
  const withLyrics = await prisma.song.count({ where: { rawLyrics: { not: '' } } });
  const withImageUrl = await prisma.song.count({ where: { imageUrl: { not: '' } } });
  const withProducers = await prisma.song.count({ where: { producers: { not: '' } } });
  const withLength = await prisma.song.count({ where: { length: { not: '' } } });
  const eras = await prisma.era.count();
  const categories = await prisma.song.groupBy({ by: ['category'], _count: true });

  console.log(`  Total songs:        ${totalSongs}`);
  console.log(`  With file path:     ${withFilePath} (streamable)`);
  console.log(`  With raw lyrics:    ${withLyrics}`);
  console.log(`  With image URL:     ${withImageUrl}`);
  console.log(`  With producers:     ${withProducers}`);
  console.log(`  With duration:      ${withLength}`);
  console.log(`  Eras:               ${eras}`);
  console.log('');
  console.log('  Categories:');
  categories.forEach(c => console.log(`    ${c.category}: ${c._count}`));

  // Show 3 sample songs with data
  console.log('');
  console.log('  ─── Sample Songs ───');
  const samples = await prisma.song.findMany({ take: 3, where: { filePath: { not: null } }, include: { era: true } });
  for (const s of samples) {
    console.log(`  "${s.name}"`);
    console.log(`    filePath:  ${s.filePath ? s.filePath.substring(0, 80) : 'NONE'}`);
    console.log(`    imageUrl:  ${s.imageUrl ? s.imageUrl.substring(0, 80) : 'NONE'}`);
    console.log(`    lyrics:    ${s.rawLyrics ? s.rawLyrics.length + ' chars' : 'NONE'}`);
    console.log(`    era:       ${s.era?.name || 'NONE'}`);
    console.log(`    category:  ${s.category}`);
    console.log(`    producers: ${s.producers || 'NONE'}`);
    console.log('');
  }

  // Also test the API cover-art endpoint idea
  console.log('  ─── API Cover Art Test ───');
  const testSong = samples[0];
  if (testSong?.filePath) {
    const base = process.env.JUICEWRLD_API_BASE || 'https://juicewrldapi.com/juicewrld';
    const coverUrl = `${base}/files/cover-art/?path=${encodeURIComponent(testSong.filePath)}`;
    try {
      const resp = await fetch(coverUrl);
      const ct = resp.headers.get('content-type');
      console.log(`  Cover art for "${testSong.name}":`);
      console.log(`    URL:    ${coverUrl.substring(0, 100)}`);
      console.log(`    Status: ${resp.status}`);
      console.log(`    Type:   ${ct}`);
      console.log(`    Size:   ${resp.headers.get('content-length') || 'unknown'} bytes`);
      if (resp.ok && ct?.startsWith('image')) {
        console.log('    ✅ COVER ART WORKS — frontend just needs to use it');
      } else {
        console.log('    ❌ No embedded cover art for this track');
      }
    } catch (e) {
      console.log(`    ❌ Error: ${(e as Error).message}`);
    }

    // Also test /files/cover/ endpoint
    const coverUrl2 = `${base}/files/cover/?path=${encodeURIComponent(testSong.filePath)}`;
    try {
      const resp2 = await fetch(coverUrl2);
      console.log(`  /files/cover/ endpoint: ${resp2.status} ${resp2.headers.get('content-type')}`);
    } catch {}
  }

  // Test what a single song looks like from the API directly
  console.log('');
  console.log('  ─── Raw API Song Sample ───');
  if (testSong) {
    const base = process.env.JUICEWRLD_API_BASE || 'https://juicewrldapi.com/juicewrld';
    try {
      const resp = await fetch(`${base}/songs/${testSong.externalId}/`);
      const data: any = await resp.json();
      console.log(`  API song ${testSong.externalId}:`);
      console.log(`    name:       ${data.name}`);
      console.log(`    path:       ${data.path ? data.path.substring(0, 80) : 'NONE'}`);
      console.log(`    image_url:  ${data.image_url || 'NONE'}`);
      console.log(`    lyrics:     ${data.lyrics ? data.lyrics.length + ' chars' : 'NONE'}`);
      console.log(`    category:   ${data.category}`);
      console.log(`    era:        ${JSON.stringify(data.era?.name || 'NONE')}`);
    } catch (e) {
      console.log(`    Error: ${(e as Error).message}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
