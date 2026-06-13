import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import 'dotenv/config';
import { clerkMiddleware } from '@clerk/express';
import webhookRoutes from './routes/webhooks';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));

// Webhook route BEFORE express.json() — needs raw body
app.use('/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

app.use(express.json());
app.use(clerkMiddleware());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'bluejay-api', runtime: 'bun' });
});

app.listen(PORT, () => {
  console.log(`BlueJay API running on port ${PORT}`);
});