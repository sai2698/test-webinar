import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().default('file:./dev.db'),

  JWT_SECRET: z.string().min(16).default('dev-only-insecure-secret-change-me'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  ADMIN_EMAIL: z.string().email().default('admin@webinar.local'),
  ADMIN_PASSWORD: z.string().default('Admin@12345'),

  RZP_KEY_ID: z.string().optional().default(''),
  RZP_KEY_SECRET: z.string().optional().default(''),
  RZP_WEBHOOK_SECRET: z.string().optional().default(''),

  PUBLIC_IP: z.string().default('127.0.0.1'),
  RTC_MIN_PORT: z.coerce.number().default(40000),
  RTC_MAX_PORT: z.coerce.number().default(40100),
  MEDIASOUP_ANNOUNCED_IP: z.string().default('127.0.0.1'),
  MEDIASOUP_WORKERS: z.coerce.number().default(2),

  TURN_URL: z.string().optional().default(''),
  TURN_USERNAME: z.string().optional().default(''),
  TURN_PASSWORD: z.string().optional().default(''),

  RESEND_API_KEY: z.string().optional().default(''),
  EMAIL_FROM: z.string().default('webinars@example.com'),

  // Optional SMTP. When set it wins over RESEND_API_KEY; when neither is set
  // mail is logged to the console instead of sent.
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),

  /** Set to "false" to disable the reminder scheduler entirely. */
  REMINDERS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';

/** Razorpay is optional — without keys the app runs in mock-payment mode. */
export const razorpayEnabled = Boolean(env.RZP_KEY_ID && env.RZP_KEY_SECRET);

export const allowedOrigins = env.WEB_ORIGIN.split(',').map((s) => s.trim());
