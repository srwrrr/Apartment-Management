import pg from 'pg';
import { config } from '../config';

// Used only by the session store. Everything else goes through Prisma.
export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });
