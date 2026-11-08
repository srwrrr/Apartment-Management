// The demo building (spec §12). Money goes through the real services, so numbers, receipts, notifications and the
// activity log are all what the app itself would have produced. Only the past is written directly, since a service
// cannot say "this happened last month".
import type { RequestCategory, RequestPriority, RequestStatus, Unit, User } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { addMonths, currentMonthDhaka, dateOnly, todayDhaka, ymdOf } from '../src/lib/dates';
import { hashPassword } from '../src/modules/users/auth.service';
import { createOpeningBalance, generateBills } from '../src/modules/billing/bills.service';
import { recordPayment, voidPayment } from '../src/modules/billing/payments.service';
import { createReport, rejectReport } from '../src/modules/billing/paymentReports.service';
import { issueCertificate } from '../src/modules/billing/certificates.service';
import { publish } from '../src/modules/announcements/announcements.service';
import { createDueScheduledRequests, addDays } from '../src/modules/maintenance/scheduledTasks.service';
import type { AuthUser } from '../src/types';

const NAMES = [
  'Rahim Uddin', 'রহিম উদ্দিন', 'Fatema Begum', 'ফাতেমা বেগম', 'Kamal Hossain', 'নাসরিন আক্তার', 'Shafiq Ahmed', 'Tahmina Khatun',
  'আব্দুল করিম', 'Nusrat Jahan', 'Mizanur Rahman', 'সালমা খাতুন', 'Imran Kabir', 'Sharmin Sultana', 'জাহিদ হাসান', 'Rokeya Parvin',
  'Anwar Hossain', 'মাহমুদা রহমান', 'Tanvir Islam', 'Farhana Yasmin',
];
const SECOND = ['Sumaiya Akter', 'হাসান মাহমুদ', 'Rafiq Ullah', 'Laila Arjumand', 'তাসনিম ফেরদৌস', 'Babul Mia', 'Nazma Sultana', 'Sohel Rana'];
/** Which of the 20 stays are tenants, who also pay rent. */
const TENANTS = new Set([3, 6, 9, 13, 17]);
/** The unit the demo resident lives in, among the 20 occupied units. */
const DEMO_RESIDENT = 9;

const SLA_HOURS: Record<RequestPriority, number> = { HIGH: 24, MEDIUM: 72, LOW: 168 };
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

export async function demoBuilding(staff: { admin: string; caretaker: string; manager: string }) {
  const today = todayDhaka();
  const month = currentMonthDhaka();
  const months = [3, 2, 1, 0].map((n) => addMonths(month, -n));
  const admin = { id: staff.admin, role: 'ADMIN' as const };
  const adminUser = { id: staff.admin, role: 'ADMIN', permissions: [] } as unknown as AuthUser;

  await prisma.setting.upsert({ where: { key: 'goLiveDate' }, update: { value: `${months[0]}-01` }, create: { key: 'goLiveDate', value: `${months[0]}-01` } });
  await prisma.setting.upsert({ where: { key: 'shareExpenseSummary' }, update: { value: 'true' }, create: { key: 'shareExpenseSummary', value: 'true' } });

  // ------------------------------------------------------------- units and people
  const units: Unit[] = [];
  for (let floor = 1; floor <= 6; floor++) {
    for (const letter of 'ABCD') {
      const unitNumber = `${floor}${letter}`;
      units.push(await prisma.unit.create({ data: { unitNumber, floor, bedrooms: 2 + (floor % 2), sizeSqft: 1050 + floor * 25, isAvailable: unitNumber !== '6D' } }));
    }
  }
  const byNumber = (n: string) => units.find((u) => u.unitNumber === n)!;
  const empty = new Set(['5D', '6B', '6C', '6D']);
  const homes = units.filter((u) => !empty.has(u.unitNumber));

  const passwordHash = await hashPassword('Resident1234');
  const person = (i: number, fullName: string, loginId: string) =>
    prisma.user.create({ data: { loginId, passwordHash, role: 'RESIDENT', fullName, phone: `+88017110${String(i).padStart(5, '0')}`, mustChangePassword: false } });

  const residents: User[] = [];
  for (let i = 0; i < NAMES.length; i++) {
    const r = await person(i + 1, NAMES[i]!, i === DEMO_RESIDENT ? 'resident@demo.local' : `r${String(i + 1).padStart(2, '0')}@demo.local`);
    residents.push(r);
    await prisma.occupancy.create({
      data: { unitId: homes[i]!.id, residentId: r.id, type: TENANTS.has(i) ? 'TENANT' : 'OWNER', startDate: dateOnly('2024-01-01'), isBillingContact: true },
    });
  }
  for (let i = 0; i < SECOND.length; i++) {
    const r = await person(30 + i, SECOND[i]!, `s${i + 1}@demo.local`);
    await prisma.occupancy.create({ data: { unitId: homes[i * 2]!.id, residentId: r.id, type: 'OWNER', startDate: dateOnly('2024-06-01') } });
  }

  // Someone who moved out two months ago, so the history has a former resident in it.
  const former = await person(50, 'Delwar Hossain', 'former@demo.local');
  const left = await prisma.occupancy.create({
    data: { unitId: byNumber('6C').id, residentId: former.id, type: 'TENANT', startDate: dateOnly('2023-03-01'), endDate: dateOnly(`${months[1]}-20`), isBillingContact: true },
  });

  const home = await prisma.occupancy.findFirstOrThrow({ where: { residentId: residents[DEMO_RESIDENT]!.id } });
  const family = await person(60, 'সাদিয়া আক্তার', 'family@demo.local');
  await prisma.householdMember.create({ data: { occupancyId: home.id, userId: family.id, relation: 'Daughter', addedAt: dateOnly('2024-01-01') } });

  // ------------------------------------------------------------------ fees and bills
  await prisma.unitFee.create({ data: { unitId: null, chargeType: 'SERVICE', amount: 300000, description: 'Service charge' } });
  for (const i of TENANTS) await prisma.unitFee.create({ data: { unitId: homes[i]!.id, chargeType: 'RENT', amount: 1800000, description: 'Rent' } });
  await prisma.unitFee.create({ data: { unitId: left.unitId, chargeType: 'RENT', amount: 1800000, description: 'Rent' } });

  for (const [i, amount, note] of [[7, 450000, 'Service charge from before the app'], [12, 1200000, 'Four months unpaid before the app'], [2, 300000, 'One month unpaid before the app'], [16, 600000, 'Two months unpaid before the app']] as const) {
    await createOpeningBalance(homes[i]!.id, { amount, note }, admin);
  }
  for (const m of months) await generateBills({ month: m }, admin, false);

  // ------------------------------------------------------------------------ payments
  const methods = ['CASH', 'BKASH', 'NAGAD', 'BANK'] as const;
  let ref = 1000;
  const pay = async (billId: string, amount: number, day: string, i: number) => {
    const method = methods[i % methods.length]!;
    return recordPayment(billId, { amount, paidOn: day <= today ? day : today, method, ...(method !== 'CASH' && { reference: `TX${ref++}` }) }, admin);
  };
  const billOf = async (unitId: string, m: string) => {
    const b = await prisma.bill.findFirst({ where: { unitId, kind: 'REGULAR', billingMonth: dateOnly(`${m}-01`) }, include: { charges: true } });
    return b && { id: b.id, total: b.charges.reduce((s, c) => s + c.amount, 0) };
  };
  // Who has not paid, by month, so the collection rate falls month by month the way it does in real life.
  const unpaid = [new Set([7]), new Set([7, 12]), new Set([7, 12, 15, 18]), null];
  const partly = [new Set<number>(), new Set([3]), new Set([3, 9]), new Set<number>()];
  for (const [k, m] of months.entries()) {
    for (let i = 0; i < homes.length; i++) {
      const bill = await billOf(homes[i]!.id, m);
      if (!bill) continue;
      const skip = unpaid[k] ? unpaid[k].has(i) : i % 3 !== 0;
      if (skip) continue;
      await pay(bill.id, partly[k]!.has(i) ? Math.round(bill.total / 2) : bill.total, `${m}-${String(3 + (i % 8)).padStart(2, '0')}`, i);
    }
  }
  for (const m of months) {
    const bill = await billOf(left.unitId, m);
    if (bill) await pay(bill.id, bill.total, `${m}-05`, 1);
  }
  const paidOpening = await prisma.bill.findFirstOrThrow({ where: { unitId: homes[2]!.id, kind: 'OPENING_BALANCE' } });
  await pay(paidOpening.id, 300000, `${months[0]}-15`, 0);

  // One payment entered against the wrong amount, voided, then entered again.
  const corrected = (await billOf(homes[5]!.id, months[1]!))!;
  const wrong = await prisma.payment.findFirstOrThrow({ where: { billId: corrected.id, voidedAt: null } });
  await voidPayment(wrong.id, { reason: 'Entered against the wrong month' }, admin);
  await pay(corrected.id, corrected.total, `${months[1]}-11`, 0);

  // What residents have reported and the office has not finished with.
  const reporter = (i: number) => ({ id: residents[i]!.id }) as AuthUser;
  for (const i of [12, 15, 18]) {
    const bill = (await billOf(homes[i]!.id, months[2]!))!;
    await createReport(bill.id, { amount: bill.total, paidOn: today, method: 'BKASH', reference: `BK${9000 + i}` }, undefined, reporter(i));
  }
  const refused = (await billOf(homes[7]!.id, months[2]!))!;
  const report = await createReport(refused.id, { amount: refused.total, paidOn: today, method: 'NAGAD', reference: 'NG7001' }, undefined, reporter(7));
  await rejectReport(report.id, { reason: 'No payment with this reference has reached the building’s account.' }, admin);

  await issueCertificate(homes[0]!.id, undefined, admin);

  // ------------------------------------------------------------------------ expenses
  const spending = [['STAFF_SALARY', 2800000, 'Guards and cleaner'], ['GENERATOR_FUEL', 650000, 'Padma Oil'], ['COMMON_ELECTRICITY', 420000, 'DPDC'], ['LIFT', 300000, 'Lift service'], ['CLEANING', 180000, 'Cleaning supplies']] as const;
  await prisma.expense.createMany({
    data: months.slice(0, 3).flatMap((m, k) =>
      spending.map(([category, amount, payee], n) => ({ spentOn: dateOnly(`${m}-${String(5 + n * 4).padStart(2, '0')}`), category, amount: amount + k * 15000, payee, recordedById: staff.admin })),
    ),
  });

  // ------------------------------------------------------------------------ requests
  interface Sample { i: number; category: RequestCategory; title: string; description: string; status: RequestStatus; ago: number; priority?: RequestPriority; assigned?: boolean; stars?: number; comment?: string; overdue?: boolean; resolvedAgo?: number }
  const samples: Sample[] = [
    { i: DEMO_RESIDENT, category: 'PLUMBING', title: 'Kitchen tap is leaking', description: 'The kitchen tap has been dripping since yesterday.', status: 'RESOLVED', ago: 4, priority: 'MEDIUM', assigned: true, resolvedAgo: 1 },
    { i: DEMO_RESIDENT, category: 'ELECTRICAL', title: 'Bedroom switch sparks', description: 'The bedroom light switch sparks when turned on.', status: 'CLOSED', ago: 20, priority: 'HIGH', assigned: true, stars: 5, comment: 'Fixed the same day.', resolvedAgo: 19 },
    { i: 0, category: 'LIFT', title: 'Lift stops at floor 3', description: 'The lift stops for a long time at floor 3.', status: 'IN_PROGRESS', ago: 5, priority: 'HIGH', assigned: true, overdue: true },
    { i: 1, category: 'WATER_SUPPLY', title: 'Low water pressure', description: 'Very low water pressure in the mornings.', status: 'UNDER_REVIEW', ago: 2, priority: 'MEDIUM', assigned: true },
    { i: 2, category: 'SECURITY', title: 'Gate lock is loose', description: 'The main gate lock does not close firmly.', status: 'SUBMITTED', ago: 0 },
    { i: 3, category: 'CLEANING', title: 'Stairs not cleaned', description: 'The stairs on floor 1 were not cleaned this week.', status: 'SUBMITTED', ago: 4, overdue: true },
    { i: 4, category: 'GAS', title: 'Smell of gas near meter', description: 'A faint smell of gas near the meter room.', status: 'CLOSED', ago: 30, priority: 'HIGH', assigned: true, stars: 4, resolvedAgo: 29 },
    { i: 5, category: 'PLUMBING', title: 'Bathroom drain blocked', description: 'The bathroom drain is blocked and slow.', status: 'CLOSED', ago: 25, priority: 'LOW', assigned: true, stars: 3, comment: 'Took a while.', resolvedAgo: 18 },
    { i: 6, category: 'ELECTRICAL', title: 'Corridor light is out', description: 'The corridor light on floor 2 is out.', status: 'CLOSED', ago: 40, priority: 'LOW', assigned: true, resolvedAgo: 35 },
    { i: 7, category: 'GENERATOR', title: 'Generator did not start', description: 'During the outage the generator did not start.', status: 'IN_PROGRESS', ago: 1, priority: 'HIGH', assigned: true },
    { i: 8, category: 'OTHER', title: 'Parking line repainting', description: 'The parking lines have faded and need repainting.', status: 'REJECTED', ago: 15 },
    { i: 10, category: 'CLEANING', title: 'Roof drain needs cleaning', description: 'Leaves have blocked the roof drain.', status: 'RESOLVED', ago: 6, priority: 'LOW', assigned: true, resolvedAgo: 2 },
    { i: 11, category: 'PLUMBING', title: 'Water heater leaking', description: 'I no longer need this, it has been fixed privately.', status: 'CANCELLED', ago: 12 },
    { i: 12, category: 'LIFT', title: 'Lift button stuck', description: 'The floor 4 lift button stays pressed.', status: 'CLOSED', ago: 50, priority: 'MEDIUM', assigned: true, stars: 2, comment: 'Had to report it twice.', resolvedAgo: 41 },
    { i: 13, category: 'WATER_SUPPLY', title: 'Rusty water from tap', description: 'Brown water comes from the tap in the morning.', status: 'UNDER_REVIEW', ago: 1, priority: 'MEDIUM' },
  ];
  for (const s of samples) {
    const createdAt = daysAgo(s.ago);
    const resolvedAt = s.resolvedAgo === undefined ? null : daysAgo(s.resolvedAgo);
    const closedAt = s.status === 'CLOSED' ? resolvedAt : null;
    const hours = s.priority ? SLA_HOURS[s.priority] : 48;
    const r = await prisma.maintenanceRequest.create({
      data: {
        submittedById: residents[s.i]!.id,
        unitId: homes[s.i]!.id,
        location: 'UNIT',
        category: s.category,
        title: s.title,
        description: s.description,
        priority: s.priority ?? null,
        status: s.status,
        assignedToId: s.assigned ? staff.caretaker : null,
        dueAt: s.overdue ? daysAgo(1) : new Date(createdAt.getTime() + hours * 3_600_000),
        createdAt,
        resolvedAt,
        closedAt,
        updates: {
          create: [
            { authorId: residents[s.i]!.id, kind: 'STATUS_CHANGE', toValue: 'SUBMITTED', createdAt },
            ...(s.status === 'SUBMITTED' ? [] : [{ authorId: staff.manager, kind: 'STATUS_CHANGE' as const, fromValue: 'SUBMITTED', toValue: s.status, createdAt: resolvedAt ?? createdAt, note: s.status === 'REJECTED' ? 'This is a decision for the committee.' : null }]),
          ],
        },
      },
    });
    if (s.stars) await prisma.requestRating.create({ data: { requestId: r.id, stars: s.stars, comment: s.comment ?? null, ratedById: residents[s.i]!.id, createdAt: closedAt! } });
  }

  await prisma.scheduledTask.create({
    data: { title: 'Monthly lift service', description: 'Routine service by the lift company.', category: 'LIFT', intervalMonths: 1, nextDueDate: dateOnly(addDays(today, 5)), defaultAssigneeId: staff.caretaker, createdById: staff.admin },
  });
  await prisma.scheduledTask.create({
    data: { title: 'Clean the water tank', description: 'Drain and clean the roof water tank.', category: 'WATER_SUPPLY', intervalMonths: 6, nextDueDate: dateOnly(addDays(today, 40)), createdById: staff.admin },
  });
  await createDueScheduledRequests();

  // --------------------------------------------------------------------- announcements
  const committee = await prisma.residentGroup.create({ data: { name: 'Committee', members: { create: [0, 2, 4, 9].map((i) => ({ userId: residents[i]!.id })) } } });
  await prisma.emergencyContact.createMany({
    data: [
      { name: 'Guard desk', role: 'Building security', phone: '01700000101', hours: '24 hours' },
      { name: 'Building caretaker', role: 'Caretaker', phone: '01700000102', hours: '8am to 8pm' },
      { name: 'Lift company', role: 'Lift breakdowns', phone: '01700000103', hours: '24 hours' },
      { name: 'Electrician', role: 'Electrical faults', phone: '01700000104', hours: '9am to 6pm' },
      { name: 'Fire service', role: 'Fire', phone: '999', hours: '24 hours' },
      { name: 'Police', role: 'Emergency', phone: '999', hours: '24 hours' },
    ].map((c, sortOrder) => ({ ...c, sortOrder })),
  });

  const tomorrow = new Date(`${addDays(today, 1)}T09:00:00+06:00`).toISOString();
  const ended = await publish({ title: 'Gas line inspection', body: 'The gas line was inspected on Tuesday.', category: 'SERVICE_INTERRUPTION', isImportant: false, audience: { type: 'ALL' } }, adminUser);
  await prisma.announcement.update({ where: { id: ended.id }, data: { publishedAt: daysAgo(12), recipientsResolvedAt: daysAgo(12), endsAt: daysAgo(9) } });
  await publish({ title: 'AGM on Friday at 7pm', body: 'The annual general meeting will be held in the community room.\nAll owners are requested to attend.', category: 'MEETING', isImportant: false, audience: { type: 'OWNERS' } }, adminUser);
  await publish({ title: 'কমিটি সভা', body: 'আগামী রবিবার সন্ধ্যা ৭টায় কমিটির সভা হবে।', category: 'MEETING', isImportant: false, audience: { type: 'GROUP', groupId: committee.id } }, adminUser);
  await publish({ title: 'Floor 3 pipe repair', body: 'Water will be off on floor 3 from 11am to 1pm tomorrow.', category: 'MAINTENANCE', isImportant: false, audience: { type: 'FLOORS', floors: [3] } }, adminUser);
  await publish({ title: 'Water off on Saturday', body: 'The water tank will be cleaned on Saturday.\nPlease store water from Friday night.', category: 'SERVICE_INTERRUPTION', isImportant: true, audience: { type: 'ALL' } }, adminUser);
  await publish({ title: 'New rules for visitor parking', body: 'From next month, visitors must park in the marked bays only.', category: 'RULES', isImportant: false, audience: { type: 'ALL' }, publishAt: tomorrow }, adminUser);

  return { units: units.length, bills: await prisma.bill.count(), payments: await prisma.payment.count(), since: ymdOf(dateOnly(`${months[0]}-01`)) };
}
