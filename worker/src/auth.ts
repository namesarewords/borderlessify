import { Hono } from "hono";
import type { Env, Variables } from "./types";
import { generateOTP, hashSHA256, generateToken } from "./crypto";
import { sendVerificationCode } from "./email";

const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_OTP_ATTEMPTS = 5;
const MAX_RATE_LIMIT = 3;
const OTP_TTL_SECONDS = 600;
const RATE_LIMIT_TTL_SECONDS = 600;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email) && email.length <= 254;
}

function jsonSuccess<T>(data: T, status = 200) {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonError(error: string, status = 400) {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

auth.post("/request-code", async (c) => {
  const env = c.env;

  let body: { email?: string };
  try {
    body = await c.req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  const email = body.email?.toLowerCase().trim();
  if (!email || !isValidEmail(email)) {
    return jsonError("A valid email address is required");
  }

  const rateLimitKey = `ratelimit:${email}`;
  const rateLimitRaw = await env.KV.get(rateLimitKey);
  const rateLimitCount = rateLimitRaw ? parseInt(rateLimitRaw, 10) : 0;

  if (rateLimitCount >= MAX_RATE_LIMIT) {
    return jsonSuccess({
      message: "If an account with that email exists, a verification code has been sent.",
    });
  }

  const code = generateOTP();
  const codeHash = await hashSHA256(code);

  const codeKey = `otp:${email}`;
  const existingCodeRaw = await env.KV.get(codeKey);
  let attempts = 0;
  if (existingCodeRaw) {
    try {
      const existing = JSON.parse(existingCodeRaw) as { attempts: number };
      attempts = existing.attempts;
    } catch {
      attempts = 0;
    }
  }

  const codeData = JSON.stringify({ codeHash, attempts: 0 });
  await env.KV.put(codeKey, codeData, { expirationTtl: OTP_TTL_SECONDS });

  const newRateLimit = rateLimitCount + 1;
  await env.KV.put(rateLimitKey, String(newRateLimit), {
    expirationTtl: RATE_LIMIT_TTL_SECONDS,
  });

  try {
    await sendVerificationCode(env, email, code);
  } catch (err) {
    console.error("Failed to send verification email");
  }

  return jsonSuccess({
    message: "If an account with that email exists, a verification code has been sent.",
  });
});

auth.post("/verify-code", async (c) => {
  const env = c.env;

  let body: { email?: string; code?: string; deviceId?: string; deviceName?: string };
  try {
    body = await c.req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  const email = body.email?.toLowerCase().trim();
  const code = body.code?.trim();
  const deviceId = body.deviceId?.trim();
  const deviceName = body.deviceName?.trim() || null;

  if (!email || !isValidEmail(email)) {
    return jsonError("A valid email address is required");
  }
  if (!code || code.length !== 6 || !/^\d{6}$/.test(code)) {
    return jsonError("A valid 6-digit code is required");
  }

  const codeKey = `otp:${email}`;
  const codeDataRaw = await env.KV.get(codeKey);

  if (!codeDataRaw) {
    return jsonError("Invalid or expired code. Please request a new one.", 401);
  }

  let storedData: { codeHash: string; attempts: number };
  try {
    storedData = JSON.parse(codeDataRaw);
  } catch {
    return jsonError("Invalid or expired code. Please request a new one.", 401);
  }

  if (storedData.attempts >= MAX_OTP_ATTEMPTS) {
    await env.KV.delete(codeKey);
    return jsonError("Too many failed attempts. Please request a new code.", 429);
  }

  const inputHash = await hashSHA256(code);
  if (inputHash !== storedData.codeHash) {
    const newAttempts = storedData.attempts + 1;
    await env.KV.put(
      codeKey,
      JSON.stringify({ codeHash: storedData.codeHash, attempts: newAttempts }),
      { expirationTtl: OTP_TTL_SECONDS }
    );
    return jsonError(
      `Invalid code. ${MAX_OTP_ATTEMPTS - newAttempts} attempts remaining.`,
      401
    );
  }

  await env.KV.delete(codeKey);

  const userRow = await env.DB.prepare(
    "SELECT id, email, stripe_customer_id, created_at FROM users WHERE email = ?"
  )
    .bind(email)
    .first();

  if (!userRow) {
    return jsonError("If an account with that email exists, a verification code has been sent.", 401);
  }

  const subscriptionRow = await env.DB.prepare(
    "SELECT id, user_id, stripe_subscription_id, status, current_period_end, created_at, updated_at FROM subscriptions WHERE user_id = ? AND status IN ('active', 'trialing') ORDER BY created_at DESC LIMIT 1"
  )
    .bind(userRow.id)
    .first();

  if (!subscriptionRow) {
    return jsonError("No active subscription found for this account.", 403);
  }

  const token = generateToken();
  const tokenHash = await hashSHA256(token);
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, device_id, token_hash, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)"
  )
    .bind(
      sessionId,
      userRow.id,
      deviceId || null,
      tokenHash,
      now.toISOString(),
      expiresAt.toISOString()
    )
    .run();

  if (deviceId) {
    const existingDevice = await env.DB.prepare(
      "SELECT id FROM devices WHERE user_id = ? AND device_id = ?"
    )
      .bind(userRow.id, deviceId)
      .first();

    if (existingDevice) {
      await env.DB.prepare(
        "UPDATE devices SET last_seen = ?, device_name = COALESCE(?, device_name) WHERE user_id = ? AND device_id = ?"
      )
        .bind(now.toISOString(), deviceName, userRow.id, deviceId)
        .run();
    } else {
      const deviceCount = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM devices WHERE user_id = ?"
      )
        .bind(userRow.id)
        .first();

      if (deviceCount && (deviceCount.count as number) >= 2) {
        return jsonError(
          "Device limit reached. You can have up to 2 active devices. Please remove an existing device first.",
          403
        );
      }

      await env.DB.prepare(
        "INSERT INTO devices (id, user_id, device_id, device_name, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(
          crypto.randomUUID(),
          userRow.id,
          deviceId,
          deviceName,
          now.toISOString(),
          now.toISOString()
        )
        .run();
    }
  }

  return jsonSuccess({
    token,
    user: {
      id: userRow.id,
      email: userRow.email,
      stripe_customer_id: userRow.stripe_customer_id,
      created_at: userRow.created_at,
    },
    subscription: {
      id: subscriptionRow.id,
      stripe_subscription_id: subscriptionRow.stripe_subscription_id,
      status: subscriptionRow.status,
      current_period_end: subscriptionRow.current_period_end,
    },
    expires_at: expiresAt.toISOString(),
  });
});

auth.post("/session", async (c) => {
  const env = c.env;

  let body: { token?: string };
  try {
    body = await c.req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  const token = body.token?.trim();
  if (!token) {
    return jsonError("Token is required");
  }

  const tokenHash = await hashSHA256(token);

  const sessionRow = await env.DB.prepare(
    "SELECT id, user_id, device_id, token_hash, created_at, expires_at, revoked FROM sessions WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first();

  if (!sessionRow) {
    return jsonError("Invalid session", 401);
  }

  if (sessionRow.revoked === 1) {
    return jsonError("Session has been revoked", 401);
  }

  const now = new Date();
  if (new Date(sessionRow.expires_at) < now) {
    return jsonError("Session has expired", 401);
  }

  const userRow = await env.DB.prepare(
    "SELECT id, email, stripe_customer_id, created_at FROM users WHERE id = ?"
  )
    .bind(sessionRow.user_id)
    .first();

  if (!userRow) {
    return jsonError("User not found", 401);
  }

  const subscriptionRow = await env.DB.prepare(
    "SELECT id, user_id, stripe_subscription_id, status, current_period_end, created_at, updated_at FROM subscriptions WHERE user_id = ? AND status IN ('active', 'trialing') ORDER BY created_at DESC LIMIT 1"
  )
    .bind(userRow.id)
    .first();

  if (sessionRow.device_id) {
    await env.DB.prepare(
      "UPDATE devices SET last_seen = ? WHERE user_id = ? AND device_id = ?"
    )
      .bind(now.toISOString(), userRow.id, sessionRow.device_id)
      .run();
  }

  return jsonSuccess({
    user: {
      id: userRow.id,
      email: userRow.email,
      stripe_customer_id: userRow.stripe_customer_id,
      created_at: userRow.created_at,
    },
    subscription: subscriptionRow
      ? {
          id: subscriptionRow.id,
          stripe_subscription_id: subscriptionRow.stripe_subscription_id,
          status: subscriptionRow.status,
          current_period_end: subscriptionRow.current_period_end,
        }
      : null,
  });
});

auth.post("/signout", async (c) => {
  const env = c.env;

  let body: { token?: string };
  try {
    body = await c.req.json();
  } catch {
    return jsonError("Invalid JSON body");
  }

  const token = body.token?.trim();
  if (!token) {
    return jsonError("Token is required");
  }

  const tokenHash = await hashSHA256(token);

  const sessionRow = await env.DB.prepare(
    "SELECT id, revoked FROM sessions WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first();

  if (!sessionRow) {
    return jsonError("Session not found", 404);
  }

  if (sessionRow.revoked === 1) {
    return jsonSuccess({ message: "Session already signed out" });
  }

  await env.DB.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?")
    .bind(sessionRow.id)
    .run();

  return jsonSuccess({ message: "Signed out successfully" });
});

export default auth;
