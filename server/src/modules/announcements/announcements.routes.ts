import { Router } from 'express';
import { z } from 'zod';
import { hasPermission, announcementAudienceSchema, announcementCreateSchema, announcementListQuerySchema, announcementUpdateSchema } from '@apt/shared';
import { asyncHandler } from '../../lib/errors';
import { requireAuth, requirePermission, requireRole } from '../../middleware/auth';
import { archiveAnnouncement, getAnnouncement, getForNotice, listAnnouncements, markAnnouncementRead, noticeHtml, previewAudience, publish, readStatus, updateAnnouncement } from './announcements.service';
import { getSettings } from '../settings/settings.service';
import { renderPdf } from '../../pdf/render';

export const announcementsRouter = Router();
announcementsRouter.use(requireAuth);

const manage = requirePermission('announcements.manage');
const canManage = (u: Parameters<typeof hasPermission>[0]) => hasPermission(u, 'announcements.manage');
const id = (v: unknown) => String(v);

// FR-23: administrators and staff granted announcements.manage publish. Everyone else only reads what was sent to them.
announcementsRouter.post('/', manage, asyncHandler(async (req, res) => res.status(201).json(await publish(announcementCreateSchema.parse(req.body), req.user!))));

// "This will reach N residents", before publishing. Must come before '/:id'.
announcementsRouter.post(
  '/audience-preview',
  manage,
  asyncHandler(async (req, res) => res.json(await previewAudience(z.object({ audience: announcementAudienceSchema }).parse(req.body).audience))),
);

announcementsRouter.get(
  '/',
  asyncHandler(async (req, res) => res.json(await listAnnouncements(announcementListQuerySchema.parse(req.query), req.user!, canManage(req.user!)))),
);
announcementsRouter.get('/:id', asyncHandler(async (req, res) => res.json(await getAnnouncement(id(req.params.id), req.user!, canManage(req.user!)))));

// FR-53.
announcementsRouter.get(
  '/:id/notice.pdf',
  manage,
  asyncHandler(async (req, res) => {
    const a = await getForNotice(id(req.params.id));
    const { buildingName } = await getSettings();
    const pdf = await renderPdf(noticeHtml(a, buildingName, req.user!.language));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="notice.pdf"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  }),
);

announcementsRouter.patch('/:id', manage, asyncHandler(async (req, res) => res.json(await updateAnnouncement(id(req.params.id), announcementUpdateSchema.parse(req.body)))));
announcementsRouter.post('/:id/archive', manage, asyncHandler(async (req, res) => res.json(await archiveAnnouncement(id(req.params.id)))));
announcementsRouter.get('/:id/reads', manage, asyncHandler(async (req, res) => res.json(await readStatus(id(req.params.id)))));

// A resident opening an announcement marks it read.
announcementsRouter.post('/:id/read', requireRole('RESIDENT'), asyncHandler(async (req, res) => res.json(await markAnnouncementRead(id(req.params.id), req.user!.id))));
