import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),

  // Database
  DATABASE_URL: z.string().default('postgresql://juicevault:juicevault_dev_password@localhost:5432/juicevault'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // JWT
  JWT_SECRET: z.string().default('juicevault-dev-secret-change-in-production'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Juice WRLD API — CORRECT base URL from docs
  // All endpoints are under: https://juicewrldapi.com/juicewrld/
  JUICEWRLD_API_BASE: z.string().default('https://juicewrldapi.com/juicewrld'),

  // Typesense
  TYPESENSE_HOST: z.string().default('localhost'),
  TYPESENSE_PORT: z.coerce.number().default(8108),
  TYPESENSE_API_KEY: z.string().default('juicevault_typesense_dev_key'),

  // CORS
  FRONTEND_URL: z.string().default('http://localhost:3000'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env;

export function getEnv(): Env {
  if (!_env) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      console.error('❌ Invalid environment variables:', result.error.flatten().fieldErrors);
      process.exit(1);
    }
    _env = result.data;
  }
  return _env;
}
