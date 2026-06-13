import { getAuth } from '@clerk/express';
import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/db';

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const { userId: clerkId } = getAuth(req);

  if (!clerkId) return res.status(401).json({ error: 'Unauthorized' });

  const user = await prisma.user.findUnique({ where: { clerkId } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  (req as any).user = user; // attach local user record
  next();
}