/**
 * Bootstrap script — creates system playlists including Top 50 Unreleased Grails
 * Run after prisma migrate: npx ts-node src/jobs/bootstrap-playlists.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const TOP_50_UNRELEASED = [
  'Californication','Confide','Call Me Whenever','K Like A Russian','Run',
  'One Call','Cake','Carry It','Biscotti In The Air','Lemon Glow',
  'Waves','Scarface','Moncler Year','Styrofoam','Ups and Downs',
  'Dark Tints','Rental','Vibe','Troubled Kids','Purple Moncler',
  'Whip','Be Real','Racks In','Choppa Sang','Blade',
  'Delorean','Anacondas','GoPro','All Talk','Under Her Skin',
  'Hell','Tattoos and Ink','Spanglish','Forever Love','Mr Freeze',
  'Take Me Home','Hope I Did It','USD','Hard Time','In The Air',
  'I Don\'t Need It','Go Home','Ball','Priceless','Off The Rip',
  'Kel-Tec Talk','Oversprung','Do It','Don\'t Got Time','Outer Space',
];

async function bootstrap() {
  console.log('[BOOTSTRAP] Starting playlist bootstrap...');

  // Get or create admin user for system playlists
  const admin = await prisma.user.findFirst({ where: { role: 'admin' } });
  if (!admin) { console.log('[BOOTSTRAP] No admin user found. Create one first.'); return; }

  // 1. Create "Liked Songs" system playlist for each user (if not exists)
  const users = await prisma.user.findMany({ select: { id: true, displayName: true } });
  for (const u of users) {
    const exists = await prisma.playlist.findFirst({
      where: { userId: u.id, name: 'Liked Songs', isSystem: true },
    });
    if (!exists) {
      await prisma.playlist.create({
        data: { name: 'Liked Songs', description: 'Your liked songs', userId: u.id, isSystem: true, isPublic: false },
      });
      console.log(`[BOOTSTRAP] Created "Liked Songs" for ${u.displayName}`);
    }
  }

  // 2. Create "Top 50 — Unreleased Grails" system playlist
  let top50 = await prisma.playlist.findFirst({
    where: { name: 'Top 50 — Unreleased Grails', isSystem: true },
  });
  if (!top50) {
    top50 = await prisma.playlist.create({
      data: {
        name: 'Top 50 — Unreleased Grails',
        description: 'Community-consensus top 50 unreleased Juice WRLD tracks',
        userId: admin.id,
        isSystem: true,
        isPublic: true,
      },
    });
    console.log('[BOOTSTRAP] Created "Top 50 — Unreleased Grails" playlist');
  }

  // Populate Top 50 with matching songs from DB
  let matched = 0;
  for (let i = 0; i < TOP_50_UNRELEASED.length; i++) {
    const name = TOP_50_UNRELEASED[i];
    // Fuzzy match: search by name containing the keyword
    const song = await prisma.song.findFirst({
      where: {
        OR: [
          { name: { contains: name, mode: 'insensitive' } },
          { aliases: { some: { alias: { contains: name, mode: 'insensitive' } } } },
        ],
      },
    });
    if (song) {
      const already = await prisma.playlistSong.findUnique({
        where: { playlistId_songId: { playlistId: top50.id, songId: song.id } },
      });
      if (!already) {
        await prisma.playlistSong.create({
          data: { playlistId: top50.id, songId: song.id, position: i + 1 },
        });
      }
      matched++;
      console.log(`[BOOTSTRAP] ✅ #${i+1} "${name}" → ${song.name}`);
    } else {
      console.log(`[BOOTSTRAP] ❌ #${i+1} "${name}" — not found in DB`);
    }
  }

  // 3. Create "Top 50 — All Time" system playlist (most played)
  let topAll = await prisma.playlist.findFirst({
    where: { name: 'Top 50 — All Time', isSystem: true },
  });
  if (!topAll) {
    topAll = await prisma.playlist.create({
      data: {
        name: 'Top 50 — All Time',
        description: 'Most played tracks on JuiceVault',
        userId: admin.id,
        isSystem: true,
        isPublic: true,
      },
    });
    console.log('[BOOTSTRAP] Created "Top 50 — All Time" playlist');

    const topSongs = await prisma.song.findMany({
      where: { filePath: { not: '' }, category: { in: ['released', 'unreleased'] } },
      orderBy: { playCount: 'desc' },
      take: 50,
    });
    for (let i = 0; i < topSongs.length; i++) {
      await prisma.playlistSong.create({
        data: { playlistId: topAll.id, songId: topSongs[i].id, position: i + 1 },
      });
    }
    console.log(`[BOOTSTRAP] Populated "Top 50 — All Time" with ${topSongs.length} songs`);
  }

  console.log(`[BOOTSTRAP] Done! Matched ${matched}/${TOP_50_UNRELEASED.length} unreleased grails.`);
}

bootstrap()
  .then(() => prisma.$disconnect())
  .catch(e => { console.error(e); prisma.$disconnect(); process.exit(1); });
