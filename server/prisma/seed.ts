// Demo data. Run with: npm run seed   (safe to run repeatedly)
import bcrypt from 'bcryptjs';
import { PrismaClient, type Role } from '@prisma/client';

const prisma = new PrismaClient();

async function user(loginId: string, fullName: string, role: Role, password: string, permissions: string[] = []) {
  const passwordHash = await bcrypt.hash(password, 12);
  const u = await prisma.user.upsert({
    where: { loginId },
    update: { fullName, role, passwordHash },
    create: { loginId, fullName, role, passwordHash, phone: '+8801700000000', mustChangePassword: false },
  });
  await prisma.staffPermission.deleteMany({ where: { userId: u.id } });
  if (permissions.length) {
    await prisma.staffPermission.createMany({ data: permissions.map((permission) => ({ userId: u.id, permission })) });
  }
  return u;
}

async function main() {
  await user('admin@demo.local', 'Demo Admin', 'ADMIN', 'Admin1234');
  await user('staff@demo.local', 'Demo Caretaker', 'STAFF', 'Staff1234'); // no extra permissions
  await user('office@demo.local', 'Demo Office Staff', 'STAFF', 'Office1234', ['units.manage', 'residents.manage']);

  const settings: Record<string, string> = {
    buildingName: 'Demo Tower',
    goLiveDate: new Date().toISOString().slice(0, 10),
    defaultDueDay: '10',
  };
  for (const [key, value] of Object.entries(settings)) {
    await prisma.setting.upsert({ where: { key }, update: {}, create: { key, value } });
  }
  console.log('Seeded: admin@demo.local / Admin1234, staff@demo.local / Staff1234, office@demo.local / Office1234');
}

main().finally(() => prisma.$disconnect());
