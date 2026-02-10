import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import prisma from '../config/database';
import { getEnv } from '../config/env';
import { requireAuth, AuthPayload } from '../middleware/auth';
import { triggerAutoLyricsSync } from '../jobs/auto-lyrics-sync';

const router = Router();

// ─── Validation Schemas ─────────────────────────────────

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(2).max(50),
  inviteCode: z.string().min(1),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// ─── Helpers ────────────────────────────────────────────

function signToken(payload: AuthPayload): string {
  const env = getEnv();
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as any });
}

function setTokenCookie(res: Response, token: string): void {
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

// ─── POST /api/auth/register ────────────────────────────

router.post('/register', async (req: Request, res: Response) => {
  try {
    const body = registerSchema.parse(req.body);

    // Check invite code
    const invite = await prisma.invite.findUnique({
      where: { code: body.inviteCode },
    });

    if (!invite || invite.usedBy) {
      res.status(400).json({ error: 'Invalid or already used invite code' });
      return;
    }

    if (invite.expiresAt < new Date()) {
      res.status(400).json({ error: 'Invite code has expired' });
      return;
    }

    // Check if invites are enabled
    const inviteSetting = await prisma.appSetting.findUnique({
      where: { key: 'invites_enabled' },
    });
    if (inviteSetting && !(inviteSetting.value as boolean)) {
      res.status(403).json({ error: 'Registration is currently closed' });
      return;
    }

    // Check duplicate email
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      res.status(400).json({ error: 'Email already registered' });
      return;
    }

    // Create user
    const passwordHash = await bcrypt.hash(body.password, 12);
    const user = await prisma.user.create({
      data: {
        email: body.email,
        passwordHash,
        displayName: body.displayName,
        invitedBy: invite.createdBy,
      },
    });

    // Mark invite as used
    await prisma.invite.update({
      where: { id: invite.id },
      data: { usedBy: user.id },
    });

    const payload: AuthPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
    };
    const token = signToken(payload);
    setTokenCookie(res, token);

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
      token,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.errors });
      return;
    }
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/login ───────────────────────────────

router.post('/login', async (req: Request, res: Response) => {
  try {
    const body = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !user.isActive) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const payload: AuthPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
    };
    const token = signToken(payload);
    setTokenCookie(res, token);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      },
      token,
    });

    // Kick off background lyrics enrichment/sync after successful login.
    triggerAutoLyricsSync(`login:${user.id}`);
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation failed', details: err.errors });
      return;
    }
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/auth/logout ──────────────────────────────

router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// ─── GET /api/auth/me ───────────────────────────────────

router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        reputationScore: true,
        createdAt: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({ user });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
