import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getEnv } from '../config/env';
import prisma from '../config/database';
import { UserRole } from '@prisma/client';

export interface AuthPayload {
  userId: string;
  email: string;
  role: UserRole;
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/**
 * Require valid JWT. Attaches user to req.user.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token =
    req.cookies?.token ||
    req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const env = getEnv();
    const payload = jwt.verify(token, env.JWT_SECRET) as AuthPayload;
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Require specific roles. Must be used AFTER requireAuth.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

/**
 * Check if playback is enabled (kill switch).
 * Used on stream endpoints.
 */
export async function requirePlaybackEnabled(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const setting = await prisma.appSetting.findUnique({
      where: { key: 'playback_enabled' },
    });

    // Default to enabled if no setting exists
    const enabled = setting ? (setting.value as boolean) : true;

    if (!enabled) {
      res.status(503).json({ error: 'Playback is currently disabled' });
      return;
    }
    next();
  } catch {
    // If DB is down, fail open (allow playback) — debatable, but better UX
    next();
  }
}
