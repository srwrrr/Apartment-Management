import { Router } from 'express';
import { notificationListQuerySchema } from '@apt/shared';
import { asyncHandler } from '../../lib/errors';
import { requireAuth } from '../../middleware/auth';
import { listNotifications, markAllRead, markRead, unreadCount } from './notifications.service';

// FR-25, FR-26: every logged-in person, always about themselves.
export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get('/', asyncHandler(async (req, res) => res.json(await listNotifications(req.user!.id, notificationListQuerySchema.parse(req.query)))));
notificationsRouter.get('/unread-count', asyncHandler(async (req, res) => res.json(await unreadCount(req.user!.id))));
notificationsRouter.post('/read-all', asyncHandler(async (req, res) => res.json(await markAllRead(req.user!.id))));
notificationsRouter.post('/:id/read', asyncHandler(async (req, res) => res.json(await markRead(req.user!.id, String(req.params.id)))));
