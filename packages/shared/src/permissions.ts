// Grantable staff permissions. Matches SRS Appendix B.
export const PERMISSIONS = [
  'residents.manage',
  'units.manage',
  'directory.view',
  'billing.manage',
  'billing.view',
  'payments.record',
  'expenses.manage',
  'reports.view',
  'maintenance.view_all',
  'maintenance.review',
  'maintenance.assign',
  'announcements.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['RESIDENT', 'STAFF', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export function hasPermission(
  user: { role: Role; permissions: readonly string[] },
  permission: Permission,
): boolean {
  return user.role === 'ADMIN' || (user.role === 'STAFF' && user.permissions.includes(permission));
}
