import type { Language, Role, TextSize } from '@prisma/client';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    csrf?: string;
  }
}

export interface AuthUser {
  id: string;
  loginId: string;
  fullName: string;
  role: Role;
  language: Language;
  textSize: TextSize;
  mustChangePassword: boolean;
  permissions: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
