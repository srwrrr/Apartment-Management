import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// The .env file lives at the repo root, not inside server/.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });

const schema = z.object({
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(16),
  PORT: z.coerce.number().default(4000),
  UPLOAD_DIR: z.string().default('./uploads'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DEMO_MODE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Serve the built web app from this server, so one process and one port run everything. */
  SERVE_WEB: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  /** Set when a hosting proxy terminates HTTPS in front of this server (Render, for example). */
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

if (config.NODE_ENV === 'production' && config.SESSION_SECRET.startsWith('change-me')) {
  console.error('Refusing to start in production with the default SESSION_SECRET.');
  process.exit(1);
}

/** bcrypt cost: 12 in real use (NFR-01), 4 in tests so they stay fast. */
export const BCRYPT_COST = config.NODE_ENV === 'test' ? 4 : 12;
