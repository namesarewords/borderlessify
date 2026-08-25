export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL: string;
  PUBLIC_SITE_URL: string;
  APP_URL: string;
}

export interface User {
  id: string;
  email: string;
  stripe_customer_id: string | null;
  created_at: string;
}

export interface Subscription {
  id: string;
  user_id: string;
  stripe_subscription_id: string | null;
  status: string;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}

export interface Device {
  id: string;
  user_id: string;
  device_id: string;
  device_name: string | null;
  created_at: string;
  last_seen: string;
}

export interface Session {
  id: string;
  user_id: string;
  device_id: string | null;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

export type Variables = {
  userId: string;
  user: User;
  subscription: Subscription | null;
};
