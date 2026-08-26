import { Hono } from "hono";
import type { Env, Variables } from "./types";
import { hashSHA256, hashPassword, verifyPassword, generateToken } from "./crypto";
import { sendPasswordResetEmail } from "./email";

const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const RESET_TTL_SECONDS = 60 * 60;

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email) && email.length <= 254;
}

function isValidPassword(password: string): boolean {
  return password.length >= 8 && password.length <= 128;
}

auth.post("/register", async (c) => {
  const env = c.env;

  let body: { email?: string; password?: string; deviceId?: string; deviceName?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const email = body.email?.toLowerCase().trim();
  const password = body.password;
  const deviceId = body.deviceId?.trim();
  const deviceName = body.deviceName?.trim() || null;

  if (!email || !isValidEmail(email)) {
    return c.json({ success: false, error: "A valid email address is required" }, 400);
  }
  if (!password || !isValidPassword(password)) {
    return c.json({ success: false, error: "Password must be between 8 and 128 characters" }, 400);
  }

  const existingUser = await env.DB.prepare(
    "SELECT id, password_hash FROM users WHERE email = ?"
  )
    .bind(email)
    .first();

  if (existingUser && existingUser.password_hash) {
    return c.json({ success: false, error: "An account with this email already exists. Please sign in." }, 409);
  }

  if (!existingUser) {
    return c.json({ success: false, error: "No account found. Purchase Supporter to get started." }, 404);
  }

  const sub = await env.DB.prepare(
    "SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('active', 'trialing') ORDER BY created_at DESC LIMIT 1"
  )
    .bind(existingUser.id)
    .first();

  if (!sub) {
    return c.json({ success: false, error: "No active subscription found. Purchase Supporter to continue." }, 403);
  }

  const { hash, salt } = await hashPassword(password);

  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?"
  )
    .bind(hash, salt, existingUser.id)
    .run();

  const token = generateToken();
  const tokenHash = await hashSHA256(token);
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, device_id, token_hash, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)"
  )
    .bind(sessionId, existingUser.id, deviceId || null, tokenHash, now.toISOString(), expiresAt.toISOString())
    .run();

  if (deviceId) {
    const deviceCount = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM devices WHERE user_id = ?"
    )
      .bind(existingUser.id)
      .first();

    if (deviceCount && (deviceCount.count as number) >= 2) {
      return c.json({ success: false, error: "Device limit reached. Remove an existing device first." }, 403);
    }

    const existingDevice = await env.DB.prepare(
      "SELECT id FROM devices WHERE user_id = ? AND device_id = ?"
    )
      .bind(existingUser.id, deviceId)
      .first();

    if (existingDevice) {
      await env.DB.prepare(
        "UPDATE devices SET last_seen = ?, device_name = COALESCE(?, device_name) WHERE user_id = ? AND device_id = ?"
      )
        .bind(now.toISOString(), deviceName, existingUser.id, deviceId)
        .run();
    } else {
      await env.DB.prepare(
        "INSERT INTO devices (id, user_id, device_id, device_name, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(crypto.randomUUID(), existingUser.id, deviceId, deviceName, now.toISOString(), now.toISOString())
        .run();
    }
  }

  const subRow = await env.DB.prepare(
    "SELECT id, stripe_subscription_id, status, current_period_end FROM subscriptions WHERE user_id = ? AND status IN ('active', 'trialing') ORDER BY created_at DESC LIMIT 1"
  )
    .bind(existingUser.id)
    .first();

  return c.json({
    success: true,
    data: {
      token,
      user: { id: existingUser.id, email, created_at: existingUser.id },
      subscription: subRow ? { id: subRow.id, stripe_subscription_id: subRow.stripe_subscription_id, status: subRow.status, current_period_end: subRow.current_period_end } : null,
      expires_at: expiresAt.toISOString(),
    },
  });
});

auth.post("/login", async (c) => {
  const env = c.env;

  let body: { email?: string; password?: string; deviceId?: string; deviceName?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const email = body.email?.toLowerCase().trim();
  const password = body.password;
  const deviceId = body.deviceId?.trim();
  const deviceName = body.deviceName?.trim() || null;

  if (!email || !isValidEmail(email)) {
    return c.json({ success: false, error: "A valid email address is required" }, 400);
  }
  if (!password) {
    return c.json({ success: false, error: "Password is required" }, 400);
  }

  const userRow = await env.DB.prepare(
    "SELECT id, email, password_hash, password_salt, stripe_customer_id, created_at FROM users WHERE email = ?"
  )
    .bind(email)
    .first();

  if (!userRow || !userRow.password_hash || !userRow.password_salt) {
    return c.json({ success: false, error: "Invalid email or password" }, 401);
  }

  const valid = await verifyPassword(password, userRow.password_hash as string, userRow.password_salt as string);
  if (!valid) {
    return c.json({ success: false, error: "Invalid email or password" }, 401);
  }

  const subscriptionRow = await env.DB.prepare(
    "SELECT id, stripe_subscription_id, status, current_period_end FROM subscriptions WHERE user_id = ? AND status IN ('active', 'trialing') ORDER BY created_at DESC LIMIT 1"
  )
    .bind(userRow.id)
    .first();

  if (!subscriptionRow) {
    return c.json({ success: false, error: "No active subscription. Purchase Supporter to continue." }, 403);
  }

  const token = generateToken();
  const tokenHash = await hashSHA256(token);
  const sessionId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, device_id, token_hash, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)"
  )
    .bind(sessionId, userRow.id, deviceId || null, tokenHash, now.toISOString(), expiresAt.toISOString())
    .run();

  if (deviceId) {
    const deviceCount = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM devices WHERE user_id = ?"
    )
      .bind(userRow.id)
      .first();

    if (deviceCount && (deviceCount.count as number) >= 2) {
      return c.json({ success: false, error: "Device limit reached. Remove an existing device first." }, 403);
    }

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
      await env.DB.prepare(
        "INSERT INTO devices (id, user_id, device_id, device_name, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(crypto.randomUUID(), userRow.id, deviceId, deviceName, now.toISOString(), now.toISOString())
        .run();
    }
  }

  return c.json({
    success: true,
    data: {
      token,
      user: { id: userRow.id, email: userRow.email, stripe_customer_id: userRow.stripe_customer_id, created_at: userRow.created_at },
      subscription: { id: subscriptionRow.id, stripe_subscription_id: subscriptionRow.stripe_subscription_id, status: subscriptionRow.status, current_period_end: subscriptionRow.current_period_end },
      expires_at: expiresAt.toISOString(),
    },
  });
});

auth.post("/forgot-password", async (c) => {
  const env = c.env;

  let body: { email?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const email = body.email?.toLowerCase().trim();
  if (!email || !isValidEmail(email)) {
    return c.json({ success: false, error: "A valid email address is required" }, 400);
  }

  const userRow = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ?"
  )
    .bind(email)
    .first();

  if (!userRow) {
    return c.json({ success: true, data: { message: "If an account with that email exists, a reset link has been sent." } });
  }

  await env.DB.prepare(
    "UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0"
  )
    .bind(userRow.id)
    .run();

  const resetToken = generateToken();
  const resetTokenHash = await hashSHA256(resetToken);
  const resetId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_TTL_SECONDS * 1000);

  await env.DB.prepare(
    "INSERT INTO password_resets (id, user_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)"
  )
    .bind(resetId, userRow.id, resetTokenHash, expiresAt.toISOString(), now.toISOString())
    .run();

  try {
    const resetUrl = `${env.PUBLIC_SITE_URL}/reset-password?token=${resetToken}`;
    await sendPasswordResetEmail(env, email, resetUrl);
  } catch (err) {
    console.error("Failed to send reset email");
  }

  return c.json({ success: true, data: { message: "If an account with that email exists, a reset link has been sent." } });
});

auth.post("/reset-password", async (c) => {
  const env = c.env;

  let body: { token?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const token = body.token?.trim();
  const password = body.password;

  if (!token) {
    return c.json({ success: false, error: "Reset token is required" }, 400);
  }
  if (!password || !isValidPassword(password)) {
    return c.json({ success: false, error: "Password must be between 8 and 128 characters" }, 400);
  }

  const tokenHash = await hashSHA256(token);

  const resetRow = await env.DB.prepare(
    "SELECT id, user_id, expires_at, used FROM password_resets WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first();

  if (!resetRow) {
    return c.json({ success: false, error: "Invalid or expired reset link" }, 400);
  }
  if (resetRow.used === 1) {
    return c.json({ success: false, error: "This reset link has already been used" }, 400);
  }
  if (new Date(resetRow.expires_at) < new Date()) {
    return c.json({ success: false, error: "This reset link has expired" }, 400);
  }

  const { hash, salt } = await hashPassword(password);

  await env.DB.prepare(
    "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?"
  )
    .bind(hash, salt, resetRow.user_id)
    .run();

  await env.DB.prepare(
    "UPDATE password_resets SET used = 1 WHERE id = ?"
  )
    .bind(resetRow.id)
    .run();

  await env.DB.prepare(
    "UPDATE sessions SET revoked = 1 WHERE user_id = ?"
  )
    .bind(resetRow.user_id)
    .run();

  return c.json({ success: true, data: { message: "Password reset successfully. Please sign in." } });
});

auth.post("/session", async (c) => {
  const env = c.env;

  let body: { token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const token = body.token?.trim();
  if (!token) {
    return c.json({ success: false, error: "Token is required" }, 400);
  }

  const tokenHash = await hashSHA256(token);

  const sessionRow = await env.DB.prepare(
    "SELECT id, user_id, device_id, token_hash, created_at, expires_at, revoked FROM sessions WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first();

  if (!sessionRow) {
    return c.json({ success: false, error: "Invalid session" }, 401);
  }
  if (sessionRow.revoked === 1) {
    return c.json({ success: false, error: "Session has been revoked" }, 401);
  }
  if (new Date(sessionRow.expires_at) < new Date()) {
    return c.json({ success: false, error: "Session has expired" }, 401);
  }

  const userRow = await env.DB.prepare(
    "SELECT id, email, stripe_customer_id, created_at FROM users WHERE id = ?"
  )
    .bind(sessionRow.user_id)
    .first();

  if (!userRow) {
    return c.json({ success: false, error: "User not found" }, 401);
  }

  const subscriptionRow = await env.DB.prepare(
    "SELECT id, stripe_subscription_id, status, current_period_end FROM subscriptions WHERE user_id = ? AND status IN ('active', 'trialing') ORDER BY created_at DESC LIMIT 1"
  )
    .bind(userRow.id)
    .first();

  if (sessionRow.device_id) {
    await env.DB.prepare(
      "UPDATE devices SET last_seen = ? WHERE user_id = ? AND device_id = ?"
    )
      .bind(new Date().toISOString(), userRow.id, sessionRow.device_id)
      .run();
  }

  return c.json({
    success: true,
    data: {
      user: { id: userRow.id, email: userRow.email, stripe_customer_id: userRow.stripe_customer_id, created_at: userRow.created_at },
      subscription: subscriptionRow ? { id: subscriptionRow.id, stripe_subscription_id: subscriptionRow.stripe_subscription_id, status: subscriptionRow.status, current_period_end: subscriptionRow.current_period_end } : null,
    },
  });
});

auth.post("/signout", async (c) => {
  const env = c.env;

  let body: { token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }

  const token = body.token?.trim();
  if (!token) {
    return c.json({ success: false, error: "Token is required" }, 400);
  }

  const tokenHash = await hashSHA256(token);

  const sessionRow = await env.DB.prepare(
    "SELECT id, revoked FROM sessions WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first();

  if (!sessionRow) {
    return c.json({ success: false, error: "Session not found" }, 404);
  }
  if (sessionRow.revoked === 1) {
    return c.json({ success: true, data: { message: "Session already signed out" } });
  }

  await env.DB.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?")
    .bind(sessionRow.id)
    .run();

  return c.json({ success: true, data: { message: "Signed out successfully" } });
});

export default auth;
