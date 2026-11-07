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
