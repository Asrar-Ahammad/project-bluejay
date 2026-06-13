import { Router } from 'express';
import { Webhook } from 'svix';
import { prisma } from '../lib/db';

const router = Router();

router.post('/clerk', async (req, res) => {
  const payload = req.body; 
  const headers = req.headers;

  const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET!);
  let evt: any;

  try {
    evt = wh.verify(payload, headers as any);
  } catch {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  if (evt.type === 'user.created') {
    const { id, email_addresses } = evt.data;
    await prisma.user.create({
      data: {
        clerkId: id,
        email: email_addresses[0].email_address,
      },
    });
  }

  res.json({ received: true });
});

export default router;