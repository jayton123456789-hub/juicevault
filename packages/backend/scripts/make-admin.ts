/**
 * Make a user admin by email
 * Usage: npx tsx scripts/make-admin.ts Jayton123456789@gmail.com
 */
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '../.env') });

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function makeAdmin(email: string) {
  try {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      console.error(`❌ User not found: ${email}`);
      console.log('Available users:');
      const users = await prisma.user.findMany({
        select: { email: true, displayName: true, role: true },
        take: 10,
      });
      users.forEach(u => console.log(`  - ${u.email} (${u.displayName}) [${u.role}]`));
      process.exit(1);
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { role: 'admin' },
    });

    console.log(`✅ Made ${updated.displayName} (${updated.email}) an admin!`);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

const email = process.argv[2];
if (!email) {
  console.error('Usage: npx tsx scripts/make-admin.ts <email>');
  process.exit(1);
}

makeAdmin(email);
