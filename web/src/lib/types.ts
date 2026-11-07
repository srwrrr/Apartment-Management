// Shapes of API responses used by the screens.
export type Role = 'RESIDENT' | 'STAFF' | 'ADMIN';

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface Unit {
  id: string;
  unitNumber: string;
  floor: number;
  sizeSqft: number | null;
  bedrooms: number | null;
  isAvailable: boolean;
  status: 'OCCUPIED' | 'VACANT' | 'UNAVAILABLE';
}

export interface ResidentProfileData {
  altPhone: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
}

export interface ResidentSummary {
  id: string;
  loginId: string;
  fullName: string;
  phone: string;
  isActive: boolean;
  occupancies: { type: 'OWNER' | 'TENANT'; unit: { id: string; unitNumber: string } }[];
}

export interface Occupancy {
  id: string;
  type: 'OWNER' | 'TENANT';
  startDate: string;
  endDate: string | null;
  isBillingContact: boolean;
  moveOutNote?: string | null;
  unit: { id: string; unitNumber: string; floor: number };
  resident?: { id: string; fullName: string; phone: string };
  household?: { id: string; relation: string; removedAt: string | null; user: { id: string; fullName: string; loginId: string; isActive: boolean } }[];
}

export interface ResidentDetail {
  id: string;
  loginId: string;
  fullName: string;
  phone: string;
  isActive: boolean;
  profile: ResidentProfileData | null;
  occupancies: Occupancy[];
}

export interface StaffMember {
  id: string;
  loginId: string;
  fullName: string;
  phone: string;
  isActive: boolean;
  permissions: string[];
}

export interface MyProfile extends ResidentDetail {
  occupancies: (Occupancy & { unit: Occupancy['unit'] & { sizeSqft: number | null; bedrooms: number | null } })[];
}

// ------------------------------------------------------------------ billing
export type BillStatus = 'PAID' | 'PARTIALLY_PAID' | 'UNPAID' | 'OVERDUE';
export type ChargeType = 'SERVICE' | 'RENT' | 'WATER' | 'GAS' | 'ELECTRICITY' | 'OPENING_BALANCE' | 'OTHER';

export interface BillRow {
  id: string;
  kind: 'REGULAR' | 'OPENING_BALANCE';
  billingMonth: string;
  dueDate: string;
  total: number;
  paid: number;
  balance: number;
  status: BillStatus;
  unit: { id: string; unitNumber: string; floor: number };
}
export interface BillList extends Page<BillRow> {
  sums: { total: number; paid: number; balance: number };
}
export interface Charge {
  id: string;
  type: ChargeType;
  amount: number;
  description: string;
}
export interface PaymentEntry {
  id: string;
  amount: number;
  paidOn: string;
  method: string;
  reference: string | null;
  receiptNo: string;
  createdAt: string;
  voided: boolean;
  voidedAt: string | null;
  voidReason: string | null;
  recordedBy?: string;
  voidedBy?: string | null;
}
export interface BillDetail {
  id: string;
  kind: 'REGULAR' | 'OPENING_BALANCE';
  unit: { id: string; unitNumber: string; floor: number };
  billingMonth: string;
  dueDate: string;
  billingContact: { id: string; fullName: string } | null;
  note: string | null;
  total: number;
  paid: number;
  balance: number;
  status: BillStatus;
  charges: Charge[];
  payments: PaymentEntry[];
}
// -------------------------------------------------------------- maintenance
export type RequestStatus = 'SUBMITTED' | 'UNDER_REVIEW' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' | 'REJECTED' | 'CANCELLED';
export type RequestPriority = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RequestRow {
  id: string;
  number: number;
  title: string;
  category: string;
  priority: RequestPriority | null;
  status: RequestStatus;
  overdue?: boolean;
  createdAt: string;
  dueAt?: string;
  unit: { id: string; unitNumber: string } | null;
  assignedTo?: { id: string; fullName: string } | string | null;
  submittedBy?: string | null;
  scheduled?: boolean;
}
export interface Photo {
  id: string;
  name: string;
}
export interface RequestUpdateEntry {
  id: string;
  kind: 'NOTE' | 'STATUS_CHANGE' | 'PRIORITY_CHANGE' | 'ASSIGNMENT';
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
  isInternal: boolean;
  createdAt: string;
  author: string | null;
  photos: Photo[];
}
export interface RequestDetail {
  id: string;
  number: number;
  title: string;
  description: string;
  category: string;
  location: 'UNIT' | 'COMMON_AREA';
  priority: RequestPriority | null;
  status: RequestStatus;
  overdue: boolean;
  dueAt: string;
  createdAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  unit: { id: string; unitNumber: string; floor: number } | null;
  assignedTo: { id: string; fullName: string } | null;
  submittedBy: { id: string; fullName: string; phone?: string } | null;
  scheduled: boolean;
  rating: { stars: number; comment: string | null; createdAt: string } | null;
  canRate: boolean;
  photos: Photo[];
  updates: RequestUpdateEntry[];
}

export interface FeeItem {
  chargeType: Exclude<ChargeType, 'OPENING_BALANCE' | 'OTHER'>;
  amount: number;
  description: string;
}

// ------------------------------------------------------------------ Sprint 4
export type NotificationType =
  | 'ANNOUNCEMENT' | 'BILL_NEW' | 'BILL_DUE_SOON' | 'BILL_OVERDUE' | 'PAYMENT_RECORDED' | 'REQUEST_NEW' | 'REQUEST_UPDATE' | 'REQUEST_ASSIGNED' | 'REQUEST_SCHEDULED'
  | 'PAYMENT_REPORT_NEW' | 'PAYMENT_REPORT_VERIFIED' | 'PAYMENT_REPORT_REJECTED' | 'CERTIFICATE_ISSUED' | 'MOVE_OUT_RECORDED';
export interface NotificationItem {
  id: string;
  type: NotificationType;
  params: Record<string, unknown>;
  link: string;
  readAt: string | null;
  createdAt: string;
}
export interface NotificationList extends Page<NotificationItem> {
  unread: number;
}

export type AnnouncementCategory = 'GENERAL' | 'MAINTENANCE' | 'MEETING' | 'SERVICE_INTERRUPTION' | 'RULES';
export interface AnnouncementRow {
  id: string;
  title: string;
  category: AnnouncementCategory;
  isImportant: boolean;
  publishedAt: string;
  endsAt?: string | null;
  state?: 'SCHEDULED' | 'ACTIVE' | 'ENDED' | 'ARCHIVED';
  editedAt: string | null;
  author: string;
  archivedAt?: string | null;
  preview?: string;
  read?: boolean | number;
  recipients?: number;
}
export interface AnnouncementDetail extends AnnouncementRow {
  body: string;
  read: boolean | number;
  audience?: { type: 'ALL' | 'OWNERS' | 'TENANTS' | 'FLOORS' | 'UNITS' | 'GROUP'; units: { id: string; unitNumber: string }[]; floors: number[]; group: string | null };
}

export interface FinanceMonth {
  month: string;
  bills: number;
  billed: number;
  collected: number;
  outstanding: number;
  rate: number | null;
}
export interface FinanceReport {
  from: string;
  to: string;
  billed: number;
  collected: number;
  outstanding: number;
  rate: number | null;
  openingBalances: { billed: number; collected: number; bills: number; outstanding: number };
  months: FinanceMonth[];
  byChargeType: { type: string; billed: number }[];
  byMethod: { method: string; collected: number }[];
}
export interface DuesReport {
  totalOwed: number;
  units: { unit: { id: string; unitNumber: string; floor: number }; owed: number; bills: number; overdueBills: number; oldestOverdue: string | null; contact: { name: string; phone: string | null } | null }[];
}
export interface DashboardData {
  month: string;
  building: { totalUnits: number; occupied: number; vacant: number; unavailable: number; residents: number };
  billing: { billed: number; collected: number; outstanding: number; rate: number | null; openingBalances: { outstanding: number }; overdueBills: number; overdueAmount: number; pendingReports: number };
  maintenance: { pending: number; submitted: number; underReview: number; inProgress: number; resolved: number; overdue: number };
  trend: { month: string; billed: number; collected: number; rate: number | null }[];
  recent: {
    activity: ActivityEntry[] | null;
    announcements: { id: string; title: string; publishedAt: string; isImportant: boolean }[];
    payments: { id: string; amount: number; paidOn: string; receiptNo: string; billId: string; unitNumber: string }[];
    requests: { id: string; number: number; title: string; status: RequestStatus; createdAt: string; unitNumber: string | null }[];
  };
}

// ------------------------------------------------------------------ Sprint 5
export type PaymentReportStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';
export interface BillPaymentReport {
  id: string;
  amount: number;
  paidOn: string;
  method: string;
  reference: string;
  status: PaymentReportStatus;
  rejectReason: string | null;
  reportedBy: string;
  screenshotId: string | null;
  createdAt: string;
}
export interface BillPaymentReports {
  available: number;
  items: BillPaymentReport[];
}
export interface QueueReport extends BillPaymentReport {
  billId: string;
  unitNumber: string;
  billingMonth: string;
  billKind: 'REGULAR' | 'OPENING_BALANCE';
  balance: number;
  duplicate: boolean;
}

export interface StatementRow {
  date: string;
  kind: 'BILL' | 'PAYMENT';
  billId: string;
  billKind: 'REGULAR' | 'OPENING_BALANCE';
  billingMonth: string;
  paymentId: string | null;
  receiptNo: string | null;
  method: string | null;
  charged: number;
  paid: number;
  balance: number;
}
export interface Statement {
  unit: { id: string; unitNumber: string; floor: number };
  from: string;
  to: string;
  opening: number;
  totalCharged: number;
  totalPaid: number;
  closing: number;
  rows: StatementRow[];
}

export interface Certificate {
  id: string;
  number: string;
  coversThroughMonth: string;
  issuedAt: string;
  unit: { id: string; unitNumber: string };
  issuedTo: { id: string; fullName: string };
  issuedBy: string;
}
export interface UnitCertificates {
  items: Certificate[];
  balance: number;
  canIssue: boolean;
}

export interface MoveOutPreview {
  occupancy: { id: string; type: 'OWNER' | 'TENANT'; startDate: string; isBillingContact: boolean };
  resident: { id: string; fullName: string; phone: string };
  unit: { id: string; unitNumber: string; floor: number };
  balance: number;
  unpaidBills: { id: string; billingMonth: string; kind: string; balance: number; status: BillStatus }[];
  pendingReports: { id: string; amount: number; method: string; reference: string; billId: string }[];
  openRequests: { id: string; number: number; title: string; status: RequestStatus }[];
  otherOccupants: { occupancyId: string; type: 'OWNER' | 'TENANT'; fullName: string }[];
  householdMembers: { id: string; fullName: string }[];
  hasOtherActiveOccupancy: boolean;
  canIssueCertificate: boolean;
}

export interface Expense {
  id: string;
  spentOn: string;
  category: string;
  amount: number;
  payee: string;
  description: string | null;
  receiptId: string | null;
  recordedBy: string;
  voided: boolean;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
}
export interface ExpenseList extends Page<Expense> {
  totalAmount: number;
}
export interface IncomeExpenseReport {
  from: string;
  to: string;
  income: number;
  expenses: number;
  net: number;
  months: { month: string; income: number; expenses: number; net: number }[];
  byCategory: { category: string; amount: number }[];
}
export interface BuildingSummary {
  month: string;
  total: number;
  byCategory: { category: string; amount: number }[];
}

// ------------------------------------------------------------------ Sprint 6
export interface ActivityEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  actor: { id: string; fullName: string } | null;
  ip: string | null;
  createdAt: string;
}
export interface SearchResults {
  residents: { id: string; fullName: string; phone: string; isActive: boolean }[];
  units: { id: string; unitNumber: string; floor: number }[];
  bills: { id: string; unitNumber: string; billingMonth: string; kind: string; balance: number; status: BillStatus }[];
  requests: { id: string; number: number; title: string; status: RequestStatus; unit: { unitNumber: string } | null }[];
}
export interface MaintenanceReport {
  from: string;
  to: string;
  total: number;
  byStatus: { status: RequestStatus; n: number }[];
  averageHours: number | null;
  overdue: number;
  averageRating: number | null;
  ratings: number;
  byCategory: { category: string; requests: number; resolved: number; averageHours: number | null; averageRating: number | null }[];
  byStaff: { id: string; fullName: string; ratings: number; averageRating: number | null }[];
  topUnits: { id: string; unitNumber: string; requests: number }[];
}

// ------------------------------------------------------------------ Sprint 7
export interface EmergencyContact {
  id: string;
  name: string;
  role: string;
  phone: string;
  hours: string;
}
export interface GroupRow {
  id: string;
  name: string;
  members: number;
}
export interface GroupDetail {
  id: string;
  name: string;
  members: { id: string; fullName: string; phone: string; isActive: boolean }[];
}
export interface ScheduledTask {
  id: string;
  title: string;
  description: string;
  category: string;
  intervalMonths: number;
  nextDueDate: string;
  defaultAssignee: { id: string; fullName: string } | null;
  isPaused: boolean;
}
export interface UpcomingTask {
  taskId: string;
  title: string;
  category: string;
  dueDate: string;
  assignee: string | null;
}
