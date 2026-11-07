import type { RequestHandler } from 'express';
import { hasPermission, type Permission } from '@apt/shared';
import { prisma } from '../lib/prisma';
import { ApiError, forbidden } from '../lib/errors';

/**
 * Loads the logged-in user from the session on every request, so permission changes and
 * deactivation take effect immediately (FR-06). Adds req.user, or leaves it undefined.
 */
export const loadUser: RequestHandler = async (req, _res, next) => {
  try {
    const id = req.session?.userId;
    if (!id) return next();
    const u = await prisma.user.findUnique({ where: { id }, include: { permissions: true } });
    if (!u || !u.isActive) {
      await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
      return next();
    }
    req.user = {
      id: u.id,
      loginId: u.loginId,
      fullName: u.fullName,
      role: u.role,
      language: u.language,
      textSize: u.textSize,
      mustChangePassword: u.mustChangePassword,
      permissions: u.permissions.map((p) => p.permission),
    };
    next();
  } catch (e) {
    next(e);
  }
};

function authGate(allowPasswordChange: boolean): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'UNAUTHENTICATED'));
    if (req.user.mustChangePassword && !allowPasswordChange) {
      return next(new ApiError(403, 'PASSWORD_CHANGE_REQUIRED'));
    }
    next();
  };
}

/** Must be logged in, and must not still be on a temporary password. */
export const requireAuth = authGate(false);
/** Logged in; allowed even while a temporary password is still set (change-password route only). */
export const requireAuthAllowTempPassword = authGate(true);

/** Admin, or staff who were granted this permission (NFR-02). Use after requireAuth. */
export const requirePermission =
  (permission: Permission): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'UNAUTHENTICATED'));
    if (!hasPermission(req.user, permission)) return next(forbidden());
    next();
  };

/** Only users with this exact role (e.g. residents' own pages). Use after requireAuth. */
export const requireRole =
  (role: 'RESIDENT' | 'STAFF' | 'ADMIN'): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'UNAUTHENTICATED'));
    if (req.user.role !== role) return next(forbidden());
    next();
  };

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new ApiError(401, 'UNAUTHENTICATED'));
  if (req.user.role !== 'ADMIN') return next(forbidden());
  next();
};
