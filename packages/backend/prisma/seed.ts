/**
 * Database Seed
 * Creates an initial admin user and default settings.
 * Run: npm run db:seed
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create admin user
  const adminPassword = await bcrypt.hash('admin123', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@juicevault.app' },
    create: {
      email: 'admin@juicevault.app',
      passwordHash: adminPassword,
      displayName: 'Admin',
      role: 'admin',
    },
    update: {},
  });
  console.log(`✅ Admin user: ${admin.email} (password: admin123)`);

  // Create default settings
  const settings = [
    { key: 'playback_enabled', value: true },
    { key: 'invites_enabled', value: true },
  ];

  for (const s of settings) {
    await prisma.appSetting.upsert({
      where: { key: s.key },
      create: { key: s.key, value: s.value, updatedBy: admin.id },
      update: {},
    });
  }
  console.log('✅ Default settings created');

  // Create a few invite codes
  const codes = ['JUICE999', 'VAULT2026', 'WRLD999'];
  for (const code of codes) {
    await prisma.invite.upsert({
      where: { code },
      create: {
        code,
        createdBy: admin.id,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
      },
      update: {},
    });
  }
  console.log(`✅ Invite codes: ${codes.join(', ')}`);

  console.log('\n🏁 Seed complete!');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
