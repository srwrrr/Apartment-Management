import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(16),
  PORT: z.coerce.number().default(4000),
  UPLOAD_DIR: z.string().default('./uploads'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DEMO_MODE: z.coerce.boolean().default(false),
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
