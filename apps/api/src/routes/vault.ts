// src/routes/vault.ts
import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { prisma } from '../lib/db';

const router = Router();

router.get('/status', requireAuth, async (req, res) => {
  const user = (req as any).user;
  res.json({ hasVault: !!user.vaultSalt, vaultSalt: user.vaultSalt });
});

router.post('/setup', requireAuth, async (req, res) => {
  const user = (req as any).user;
  const { vaultSalt } = req.body;

  if (user.vaultSalt) return res.status(400).json({ error: 'Vault already set up' });

  await prisma.user.update({ where: { id: user.id }, data: { vaultSalt } });
  res.json({ success: true });
});

export default router;