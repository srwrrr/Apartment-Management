import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config } from '../config';
import { pool } from '../lib/pool';

export const SESSION_MINUTES = 30; // NFR-03: end sessions after inactivity

const PgStore = connectPgSimple(session);

export const sessionMiddleware = session({
  store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false }),
  name: 'apt.sid',
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true, // every response restarts the inactivity timer
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    maxAge: SESSION_MINUTES * 60 * 1000,
  },
});
