/**
 * JuiceVault Backend — Express Server Entry Point
 * 
 * All routes are mounted under /api.
 * Audio streaming is proxied through /api/songs/:id/stream.
 * The frontend NEVER contacts the Juice WRLD API directly.
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { getEnv } from './config/env';

// Routes
import authRoutes from './routes/auth';
import songRoutes from './routes/songs';
import lyricsRoutes from './routes/lyrics';
import searchRoutes from './routes/search';
import radioRoutes from './routes/radio';
import adminRoutes from './routes/admin';
import playlistRoutes from './routes/playlists';

const app = express();

// Trust proxy (required for Render, Railway, etc.)
app.set('trust proxy', 1);

// ─── Global Middleware ──────────────────────────────────

const env = getEnv();

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // Allow inline scripts for SPA
}));

app.use(cors({
  origin: env.NODE_ENV === 'production'
    ? [env.FRONTEND_URL, 'https://juicevault.onrender.com']
    : true,
  credentials: true,
}));

app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// ─── Rate Limiting ──────────────────────────────────────

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 120,              // 120 requests per minute per IP
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const streamLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,               // 30 stream requests per minute (matches API limit)
  message: { error: 'Streaming rate limit exceeded' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,                     // 20 auth attempts per 15 min
  message: { error: 'Too many auth attempts' },
});

// ─── Routes ─────────────────────────────────────────────

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/songs', apiLimiter, songRoutes);
app.use('/api/songs', apiLimiter, lyricsRoutes);     // Mounted under /api/songs/:songId/lyrics
app.use('/api/search', apiLimiter, searchRoutes);
app.use('/api/radio', apiLimiter, radioRoutes);
app.use('/api/admin', apiLimiter, adminRoutes);
app.use('/api/playlists', apiLimiter, playlistRoutes);

// Stream endpoint gets its own stricter limiter
app.use('/api/songs/:id/stream', streamLimiter);

// ─── Health Check ───────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
  });
});

// ─── Public Cover Gallery (no auth — used by auth screen) ─

import prisma from './config/database';

app.get('/api/cover-gallery', async (_req, res) => {
  try {
    // Get random songs that have cover art (localCoverPath or imageUrl)
    const songs = await prisma.song.findMany({
      where: {
        OR: [
          { localCoverPath: { not: '' } },
          { imageUrl: { not: '' } },
        ],
      },
      select: { localCoverPath: true, imageUrl: true },
      take: 200,
    });

    // Shuffle and pick up to 56 (7 rows x 8 covers)
    const shuffled = songs.sort(() => Math.random() - 0.5).slice(0, 56);
    const urls = shuffled.map(s => s.localCoverPath || s.imageUrl).filter(Boolean);

    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min cache
    res.json({ covers: urls });
  } catch (err) {
    console.error('Cover gallery error:', err);
    // Fallback: empty array, frontend will use placeholders
    res.json({ covers: [] });
  }
});

// ─── Serve Frontend ─────────────────────────────────────

app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA fallback — serve index.html for non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Error Handler ──────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start Server ───────────────────────────────────────

const PORT = env.PORT;
app.listen(PORT, () => {
  console.log(`
  ┌──────────────────────────────────────┐
  │                                      │
  │   🧃 JuiceVault Backend             │
  │   Running on port ${PORT}              │
  │   Environment: ${env.NODE_ENV}       │
  │                                      │
  │   API:  http://localhost:${PORT}/api   │
  │                                      │
  └──────────────────────────────────────┘
  `);
});

export default app;
