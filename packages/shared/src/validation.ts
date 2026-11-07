import { z } from 'zod';
import { PERMISSIONS } from './permissions';

const BD_MOBILE = /^(\+?88)?01[3-9]\d{8}$/;

/** Normalise a Bangladeshi mobile number to +8801XXXXXXXXX. Returns null if invalid. */
export function normalizePhone(input: string): string | null {
  const digits = input.trim().replace(/[\s-]/g, '');
  return BD_MOBILE.test(digits) ? '+88' + digits.replace(/^(\+?88)/, '') : null;
}

/** Normalise a login ID: lower-case email, or +8801XXXXXXXXX phone (BR-01). Returns null if invalid. */
export function normalizeLoginId(input: string): string | null {
  const v = input.trim();
  if (z.string().email().safeParse(v).success) return v.toLowerCase();
  return normalizePhone(v);
}

/** BR-02: at least 8 characters, one letter, one digit. */
export const passwordSchema = z
  .string()
  .min(8)
  .regex(/[A-Za-z]/, 'needs a letter')
  .regex(/\d/, 'needs a digit');

function isRealDate(s: string): boolean {
  const t = Date.parse(`${s}T00:00:00Z`);
  // Date.parse returns NaN for month 13, and rolls 30 Feb over to 2 Mar; the round trip catches both.
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** A real calendar date as YYYY-MM-DD. */
export const ymdSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'INVALID_DATE')
  .refine(isRealDate, 'INVALID_DATE');

// Custom refinement messages become machine codes in API errors (the web translates them).
const loginIdSchema = z
  .string()
  .trim()
  .max(254)
  .refine((v) => normalizeLoginId(v) !== null, 'LOGIN_ID_INVALID');
const phoneSchema = z
  .string()
  .trim()
  .refine((v) => normalizePhone(v) !== null, 'PHONE_INVALID');
const optionalPhone = z
  .string()
  .trim()
  .refine((v) => v === '' || normalizePhone(v) !== null, 'PHONE_INVALID')
  .nullish();
const optionalText = (max: number) => z.string().trim().max(max).nullish();

export const unitInputSchema = z.object({
  unitNumber: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9-]+$/),
  floor: z.number().int().min(-2).max(100),
  sizeSqft: z.number().int().positive().nullish(),
  bedrooms: z.number().int().min(0).max(20).nullish(),
});

/** FR-03: create a resident. */
export const residentCreateSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  loginId: loginIdSchema,
  phone: phoneSchema,
  altPhone: optionalPhone,
  emergencyContactName: optionalText(100),
  emergencyContactPhone: optionalPhone,
});
export const residentUpdateSchema = residentCreateSchema.partial();

/** FR-37: what a resident may change about themselves. */
export const selfProfileUpdateSchema = z.object({
  phone: phoneSchema.optional(),
  altPhone: optionalPhone,
  emergencyContactName: optionalText(100),
  emergencyContactPhone: optionalPhone,
});

/** FR-06: create a staff account. */
export const permissionEnum = z.enum(PERMISSIONS);
export const staffCreateSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  loginId: loginIdSchema,
  phone: phoneSchema,
  permissions: z.array(permissionEnum).max(PERMISSIONS.length).default([]),
});
export const staffUpdateSchema = z.object({
  fullName: z.string().trim().min(2).max(100).optional(),
  loginId: loginIdSchema.optional(),
  phone: phoneSchema.optional(),
});
export const staffPermissionsSchema = z.object({ permissions: z.array(permissionEnum).max(PERMISSIONS.length) });

/** FR-05 / BR-06: link a resident to a unit. */
export const occupancyCreateSchema = z
  .object({
    residentId: z.string().uuid(),
    type: z.enum(['OWNER', 'TENANT']),
    startDate: ymdSchema,
    endDate: ymdSchema.nullish(),
    isBillingContact: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.endDate && v.endDate < v.startDate) {
      ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'END_BEFORE_START' });
    }
  });

export const occupancyUpdateSchema = z
  .object({
    endDate: ymdSchema.optional(),
    isBillingContact: z.literal(true).optional(),
    newBillingContactOccupancyId: z.string().uuid().optional(),
  })
  .refine((v) => v.endDate !== undefined || v.isBillingContact !== undefined, 'NOTHING_TO_UPDATE');

// ------------------------------------------------------------------ billing (Sprint 2)
// Money is always a whole number of poisha (1 taka = 100 poisha), at most 10,000,000 taka per item (BR-15).
export const MAX_POISHA = 1_000_000_000;
export const poishaSchema = z.number().int().positive().max(MAX_POISHA);

/** Charge types that can be set up as recurring fees (FR-32). */
export const RECURRING_CHARGE_TYPES = ['SERVICE', 'RENT', 'WATER', 'GAS', 'ELECTRICITY'] as const;
export type RecurringChargeType = (typeof RECURRING_CHARGE_TYPES)[number];
/** Charge types a person may add to a bill by hand. OPENING_BALANCE is created only by the opening-balance feature. */
export const MANUAL_CHARGE_TYPES = [...RECURRING_CHARGE_TYPES, 'OTHER'] as const;
export const PAYMENT_METHODS = ['CASH', 'BANK', 'BKASH', 'NAGAD', 'ROCKET', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const BILL_STATUSES = ['PAID', 'PARTIALLY_PAID', 'UNPAID', 'OVERDUE'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

const description = z.string().trim().min(1).max(200);
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const chargeInputSchema = z.object({
  type: z.enum(MANUAL_CHARGE_TYPES),
  amount: poishaSchema,
  description,
});
export const chargeUpdateSchema = z.object({ amount: poishaSchema.optional(), description: description.optional() }).strict();

export const feeItemSchema = z.object({ chargeType: z.enum(RECURRING_CHARGE_TYPES), amount: poishaSchema, description });
/** A list of fees: each type at most once (the database enforces this too). */
export const feeListSchema = z
  .object({ fees: z.array(feeItemSchema).max(RECURRING_CHARGE_TYPES.length) })
  .refine((v) => new Set(v.fees.map((f) => f.chargeType)).size === v.fees.length, { path: ['fees'], message: 'FEE_TYPE_REPEATED' });

/** 'YYYY-MM' */
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'INVALID_MONTH');

export const generateBillsSchema = z.object({ month: monthSchema, dueDate: ymdSchema.optional() });

export const oneOffBillSchema = z
  .object({
    unitId: z.string().uuid(),
    month: monthSchema,
    dueDate: ymdSchema.optional(),
    charges: z.array(chargeInputSchema).min(1).max(20),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    for (const c of v.charges) {
      if (c.type !== 'OTHER' && seen.has(c.type)) ctx.addIssue({ code: 'custom', path: ['charges'], message: 'CHARGE_TYPE_EXISTS' });
      seen.add(c.type);
    }
  });

export const paymentInputSchema = z.object({
  amount: poishaSchema,
  paidOn: ymdSchema,
  method: z.enum(PAYMENT_METHODS),
  reference: z.preprocess(emptyToUndefined, z.string().trim().max(40).optional()),
  /** The user has seen the "this reference was already used" warning and wants to save anyway. */
  confirm: z.boolean().optional(),
});

export const voidPaymentSchema = z.object({ reason: z.string().trim().min(3).max(300) });

export const openingBalanceSchema = z.object({
  amount: poishaSchema,
  dueDate: ymdSchema.optional(),
  note: z.preprocess(emptyToUndefined, z.string().trim().max(200).optional()),
});

export const settingsUpdateSchema = z
  .object({
    buildingName: z.string().trim().min(1).max(80).optional(),
    goLiveDate: ymdSchema.optional(),
    defaultDueDay: z.number().int().min(1).max(28).optional(),
    shareExpenseSummary: z.boolean().optional(),
  })
  .strict();

export const billListQuerySchema = z.object({
  status: z.enum(BILL_STATUSES).optional(),
  month: monthSchema.optional(),
  unitId: z.string().uuid().optional(),
  kind: z.enum(['REGULAR', 'OPENING_BALANCE']).optional(),
  q: z.string().trim().max(20).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ---------------------------------------------------------------- maintenance (Sprint 3)
export const REQUEST_CATEGORIES = ['PLUMBING', 'ELECTRICAL', 'LIFT', 'GENERATOR', 'WATER_SUPPLY', 'GAS', 'CLEANING', 'SECURITY', 'COMMON_AREA', 'OTHER'] as const;
export const REQUEST_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const REQUEST_STATUSES = ['SUBMITTED', 'UNDER_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REJECTED', 'CANCELLED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number];

/** BR-19: up to 3 photos, each JPG, PNG or WEBP, at most 5 MB. */
export const MAX_PHOTOS = 3;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const uuidOrBlank = z.preprocess(emptyToUndefined, z.string().uuid().optional());

/** FR-16. Sent as form fields along with the photos, so everything arrives as text. */
export const requestCreateSchema = z.object({
  category: z.enum(REQUEST_CATEGORIES),
  location: z.enum(['UNIT', 'COMMON_AREA']),
  title: z.string().trim().min(5).max(120),
  description: z.string().trim().min(10).max(2000),
  unitId: uuidOrBlank,
});

export const requestPrioritySchema = z.object({ priority: z.enum(REQUEST_PRIORITIES) });
export const requestAssignSchema = z.object({ staffId: z.string().uuid() });
export const requestTransitionSchema = z.object({
  to: z.enum(REQUEST_STATUSES),
  note: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(1000).optional()),
});
export const requestNoteSchema = z.object({
  note: z.string().trim().min(1).max(1000),
  isInternal: z.preprocess((v) => v === true || v === 'true', z.boolean()),
});

export const requestListQuerySchema = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  category: z.enum(REQUEST_CATEGORIES).optional(),
  priority: z.enum(REQUEST_PRIORITIES).optional(),
  unitId: z.string().uuid().optional(),
  assignedTo: z.union([z.literal('me'), z.literal('none'), z.string().uuid()]).optional(),
  overdue: z.enum(['true']).optional(),
  from: ymdSchema.optional(),
  to: ymdSchema.optional(),
  q: z.string().trim().max(60).optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ------------------------------------------------ announcements, notifications, reports (Sprint 4)
export const ANNOUNCEMENT_CATEGORIES = ['GENERAL', 'MAINTENANCE', 'MEETING', 'SERVICE_INTERRUPTION', 'RULES'] as const;
export const AUDIENCE_TYPES = ['ALL', 'UNITS', 'FLOORS', 'OWNERS', 'TENANTS', 'GROUP'] as const;

/** FR-24: who an announcement is for. */
export const announcementAudienceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ALL') }),
  z.object({ type: z.literal('OWNERS') }),
  z.object({ type: z.literal('TENANTS') }),
  z.object({ type: z.literal('GROUP'), groupId: z.string().uuid() }),
  z.object({ type: z.literal('UNITS'), unitIds: z.array(z.string().uuid()).min(1).max(200) }),
  z.object({ type: z.literal('FLOORS'), floors: z.array(z.number().int().min(-2).max(100)).min(1).max(103) }),
]);
export type AnnouncementAudience = z.infer<typeof announcementAudienceSchema>;

/** A moment in time, with its offset, such as 2026-11-08T09:00:00.000Z. */
const moment = z.preprocess(emptyToUndefined, z.string().datetime({ offset: true }).optional());

/** FR-23. */
export const announcementCreateSchema = z.object({
  title: z.string().trim().min(3).max(150),
  body: z.string().trim().min(1).max(5000),
  category: z.enum(ANNOUNCEMENT_CATEGORIES).default('GENERAL'),
  isImportant: z.boolean().default(false),
  audience: announcementAudienceSchema,
  /** FR-51: go out later. Left empty, or in the past, it goes out now. */
  publishAt: moment.optional(),
  /** FR-51: after this it moves to residents' past announcements. */
  endsAt: moment.optional(),
}).superRefine((v, ctx) => {
  const start = v.publishAt ? Date.parse(v.publishAt) : Date.now();
  if (v.endsAt && Date.parse(v.endsAt) <= start) ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'ENDS_BEFORE_PUBLISH' });
});
/** An announcement can be corrected afterwards, but not re-addressed: the people it reached stay as they were. */
export const announcementUpdateSchema = z
  .object({
    title: z.string().trim().min(3).max(150).optional(),
    body: z.string().trim().min(1).max(5000).optional(),
    category: z.enum(ANNOUNCEMENT_CATEGORIES).optional(),
    isImportant: z.boolean().optional(),
    /** Only before it has gone out. */
    publishAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'NOTHING_TO_UPDATE');
export const announcementListQuerySchema = z.object({
  archived: z.enum(['true', 'false', 'all']).default('false'),
  /** FR-51: announcements whose end time has passed. */
  past: z.enum(['true', 'false']).default('false'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const notificationListQuerySchema = z.object({
  unread: z.enum(['true']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** FR-15: a period of billing months, 'YYYY-MM' to 'YYYY-MM' (at most three years). */
export const financeReportQuerySchema = z
  .object({ from: monthSchema, to: monthSchema })
  .refine((v) => v.from <= v.to, { path: ['to'], message: 'RANGE_REVERSED' })
  .refine((v) => (Number(v.to.slice(0, 4)) - Number(v.from.slice(0, 4))) * 12 + Number(v.to.slice(5)) - Number(v.from.slice(5)) < 36, {
    path: ['to'],
    message: 'RANGE_TOO_LONG',
  });
export const dashboardQuerySchema = z.object({ month: monthSchema.optional() });

// ---------------------------------------------------------------- Sprint 5

/** Forms with a file arrive as text, so a number may be a numeric string. */
const numberFromForm = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v);
const formPoisha = z.preprocess(numberFromForm, poishaSchema);

/** FR-39, BR-21: the transaction ID is required on a report, unlike on a payment the office records itself. */
export const paymentReportCreateSchema = z.object({
  amount: formPoisha,
  paidOn: ymdSchema,
  method: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().min(1).max(40),
});

/** FR-40: the date or amount may be corrected while verifying. */
export const paymentReportVerifySchema = z
  .object({ amount: poishaSchema.optional(), paidOn: ymdSchema.optional(), confirm: z.boolean().optional() })
  .strict();
export const paymentReportRejectSchema = z.object({ reason: z.string().trim().min(3).max(300) });

export const PAYMENT_REPORT_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;
export const paymentReportListQuerySchema = z.object({
  status: z.enum(PAYMENT_REPORT_STATUSES).default('PENDING'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** FR-45: a period of days. */
const statementPeriod = z.object({ from: ymdSchema, to: ymdSchema });
export const statementQuerySchema = statementPeriod.refine((v) => v.from <= v.to, { path: ['to'], message: 'RANGE_REVERSED' });
export const myStatementQuerySchema = statementPeriod
  .extend({ unitId: z.string().uuid() })
  .refine((v) => v.from <= v.to, { path: ['to'], message: 'RANGE_REVERSED' });

/** FR-46: who it is issued to. Left out, it goes to the unit's billing contact. */
export const certificateIssueSchema = z.object({ residentId: z.string().uuid().optional() }).strict();
export const certificateLookupSchema = z.object({ number: z.string().trim().min(1).max(30) });

/** FR-56. `expectedBalance` is the balance the administrator was shown, so a change since then is noticed. */
export const moveOutPreviewQuerySchema = z.object({ date: ymdSchema.optional() });
export const moveOutSchema = z
  .object({
    endDate: ymdSchema,
    expectedBalance: z.number().int().min(0),
    newBillingContactOccupancyId: z.string().uuid().optional(),
    duesNote: z.preprocess(emptyToUndefined, z.string().trim().min(3).max(500).optional()),
    issueCertificate: z.boolean().default(false),
    deactivateAccount: z.boolean().default(false),
  })
  .strict();

/** BR-23. */
export const EXPENSE_CATEGORIES = ['STAFF_SALARY', 'GENERATOR_FUEL', 'COMMON_ELECTRICITY', 'WATER', 'CLEANING', 'LIFT', 'SECURITY', 'REPAIRS', 'OTHER'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const expenseCreateSchema = z.object({
  spentOn: ymdSchema,
  category: z.enum(EXPENSE_CATEGORIES),
  amount: formPoisha,
  payee: z.string().trim().min(1).max(120),
  description: z.preprocess(emptyToUndefined, z.string().trim().max(500).optional()),
});
/** A blank description clears it, so here '' is kept rather than treated as "not sent". */
export const expenseUpdateSchema = z
  .object({
    spentOn: ymdSchema.optional(),
    category: z.enum(EXPENSE_CATEGORIES).optional(),
    amount: formPoisha.optional(),
    payee: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
  })
  .strict();
export const expenseVoidSchema = z.object({ reason: z.string().trim().min(3).max(300) });
export const expenseListQuerySchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  month: monthSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** FR-44: what residents may see, when the summary is shared. */
export const buildingSummaryQuerySchema = z.object({ month: monthSchema.optional() });

// ---------------------------------------------------------------- Sprint 6

/** FR-34: everything the activity log records. Each has a sentence in the language files. */
export const ACTIVITY_ACTIONS = [
  'login.success',
  'login.failed',
  'password.change',
  'password.reset',
  'resident.create',
  'resident.update',
  'resident.deactivate',
  'resident.reactivate',
  'staff.create',
  'staff.update',
  'staff.activate',
  'staff.deactivate',
  'staff.permissions',
  'unit.create',
  'unit.update',
  'occupancy.create',
  'occupancy.update',
  'occupancy.move_out',
  'import.run',
  'fees.update',
  'bills.generate',
  'bill.create',
  'charge.add',
  'charge.update',
  'charge.delete',
  'opening_balance.create',
  'opening_balance.delete',
  'payment.record',
  'payment.void',
  'payment_report.verify',
  'payment_report.reject',
  'expense.create',
  'expense.update',
  'expense.void',
  'certificate.issue',
  'request.status',
  'request.assign',
  'request.priority',
  'announcement.publish',
  'announcement.update',
  'announcement.archive',
  'announcement.schedule',
  'group.create',
  'group.update',
  'group.delete',
  'group.members',
  'emergency_contacts.update',
  'household.add',
  'household.remove',
  'request.rate',
  'request.scheduled',
  'scheduled_task.create',
  'scheduled_task.update',
  'scheduled_task.pause',
  'scheduled_task.resume',
  'settings.update',
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export const activityListQuerySchema = z.object({
  actorId: z.string().uuid().optional(),
  action: z.enum(ACTIVITY_ACTIONS).optional(),
  from: ymdSchema.optional(),
  to: ymdSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** FR-30. */
export const searchQuerySchema = z.object({ q: z.string().trim().min(2).max(60) });

// ------------------------------------------------------- Could items (Sprint 7)

/** FR-54: a family member with their own login. */
export const householdMemberCreateSchema = z.object({
  fullName: z.string().trim().min(2).max(100),
  relation: z.string().trim().min(2).max(40),
  loginId: loginIdSchema,
  phone: z.preprocess(emptyToUndefined, phoneSchema.optional()),
});

/** BR-26. */
export const requestRatingSchema = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.preprocess(emptyToUndefined, z.string().trim().max(500).optional()),
});

/** BR-25. */
const scheduledTaskFields = {
  title: z.string().trim().min(5).max(120),
  description: z.string().trim().min(10).max(2000),
  category: z.enum(REQUEST_CATEGORIES),
  intervalMonths: z.number().int().min(1).max(24),
  nextDueDate: ymdSchema,
  defaultAssigneeId: z.string().uuid().nullish(),
};
export const scheduledTaskCreateSchema = z.object(scheduledTaskFields);
export const scheduledTaskUpdateSchema = z
  .object(scheduledTaskFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'NOTHING_TO_UPDATE');

/** FR-36. */
export const groupInputSchema = z.object({ name: z.string().trim().min(2).max(60) });
export const groupMembersSchema = z.object({ userIds: z.array(z.string().uuid()).max(1000) });

/** FR-52. Numbers such as 999 are allowed here, so this is not a mobile number check. */
export const emergencyContactsSchema = z.object({
  contacts: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(80),
        role: z.string().trim().min(2).max(80),
        phone: z.string().trim().refine((v) => /^\+?[0-9][0-9 -]{1,19}$/.test(v), 'EMERGENCY_PHONE_INVALID'),
        hours: z.string().trim().min(1).max(60),
      }),
    )
    .max(30),
});

/** FR-57. */
export const committeeQuerySchema = z.object({ month: monthSchema });
