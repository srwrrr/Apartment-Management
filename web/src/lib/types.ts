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
  unit: { id: string; unitNumber: string; floor: number };
  resident?: { id: string; fullName: string; phone: string };
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
export interface FeeItem {
  chargeType: Exclude<ChargeType, 'OPENING_BALANCE' | 'OTHER'>;
  amount: number;
  description: string;
}
