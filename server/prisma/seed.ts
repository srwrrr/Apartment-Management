// Demo data.
//   npm run seed         accounts and the demo building. Safe to repeat: a database with units in it keeps them.
//   npm run demo:reset   empties the database and starts the demo again. Only when DEMO_MODE=true.
//   --accounts-only      just the accounts, for the end-to-end tests.
import bcrypt from 'bcryptjs';
import type { Role } from '@prisma/client';
import { config } from '../src/config';
import { prisma } from '../src/lib/prisma';
import { runAs } from '../src/lib/requestContext';
import { demoBuilding } from './demoBuilding';

const accountsOnly = process.argv.includes('--accounts-only');
const reset = process.argv.includes('--reset');

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

async function emptyEverything() {
  if (!config.DEMO_MODE || config.NODE_ENV === 'production') {
    console.error('Refusing to reset: this deletes all data, so it needs DEMO_MODE=true and must not be production.');
    process.exit(1);
  }
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

async function main() {
  if (reset) await emptyEverything();

  const admin = await user('admin@demo.local', 'Demo Admin', 'ADMIN', 'Admin1234');
  const caretaker = await user('staff@demo.local', 'Demo Caretaker', 'STAFF', 'Staff1234'); // no extra permissions
  const manager = await user('manager@demo.local', 'Demo Maintenance Manager', 'STAFF', 'Manager1234', ['maintenance.view_all', 'maintenance.review', 'maintenance.assign', 'payments.record']);
  await user('billing@demo.local', 'Demo Cashier', 'STAFF', 'Billing1234', ['billing.manage', 'billing.view', 'payments.record']);
  await user('viewer@demo.local', 'Demo Bill Viewer', 'STAFF', 'Viewer1234', ['billing.view']); // can look, not change
  await user('office@demo.local', 'Demo Office Staff', 'STAFF', 'Office1234', ['units.manage', 'residents.manage', 'directory.view']);

  const settings: Record<string, string> = {
    buildingName: 'Demo Tower',
    goLiveDate: new Date().toISOString().slice(0, 10),
    defaultDueDay: '10',
  };
  for (const [key, value] of Object.entries(settings)) {
    await prisma.setting.upsert({ where: { key }, update: {}, create: { key, value } });
  }
  console.log('Accounts: admin@demo.local / Admin1234, manager@demo.local / Manager1234, staff@demo.local / Staff1234, billing@demo.local / Billing1234, viewer@demo.local / Viewer1234, office@demo.local / Office1234');
  if (accountsOnly) return;

  if ((await prisma.unit.count()) > 0) {
    console.log('This database already has units, so the demo building was not added. Use npm run demo:reset to start again.');
    return;
  }
  const made = await runAs(admin.id, () => demoBuilding({ admin: admin.id, caretaker: caretaker.id, manager: manager.id }));
  console.log(`Demo building: ${made.units} units, ${made.bills} bills, ${made.payments} payments, since ${made.since}. Residents: resident@demo.local / Resident1234, family@demo.local / Resident1234`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
