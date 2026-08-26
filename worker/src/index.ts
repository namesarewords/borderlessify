import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Variables } from "./types";
import auth from "./auth";
import webhook from "./webhook";
import { hashSHA256 } from "./crypto";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

app.route("/api/auth", auth);
app.route("/api/webhooks", webhook);

app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/devices", async (c) => {
  const env = c.env;
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const token = authHeader.slice(7);
  const tokenHash = await hashSHA256(token);

  const session = await env.DB.prepare(
    "SELECT user_id, revoked, expires_at FROM sessions WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first();

  if (!session || session.revoked === 1 || new Date(session.expires_at) < new Date()) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const devices = await env.DB.prepare(
    "SELECT id, device_id, device_name, created_at, last_seen FROM devices WHERE user_id = ? ORDER BY last_seen DESC"
  )
    .bind(session.user_id)
    .all();

  return c.json({ success: true, data: devices.results });
});

app.delete("/api/devices/:id", async (c) => {
  const env = c.env;
  const deviceId = c.req.param("id");

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const token = authHeader.slice(7);
  const tokenHash = await hashSHA256(token);

  const session = await env.DB.prepare(
    "SELECT user_id, device_id, revoked, expires_at FROM sessions WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first();

  if (!session || session.revoked === 1 || new Date(session.expires_at) < new Date()) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const targetDevice = await env.DB.prepare(
    "SELECT id, user_id, device_id FROM devices WHERE id = ? AND user_id = ?"
  )
    .bind(deviceId, session.user_id)
    .first();

  if (!targetDevice) {
    return c.json({ success: false, error: "Device not found" }, 404);
  }

  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND device_id = ?")
    .bind(session.user_id, targetDevice.device_id)
    .run();

  await env.DB.prepare("DELETE FROM devices WHERE id = ? AND user_id = ?")
    .bind(deviceId, session.user_id)
    .run();

  return c.json({ success: true, data: { message: "Device removed" } });
});

app.get("/api/checkout/public", async (c) => {
  const env = c.env;
  const priceId = c.req.query("price_id");

  if (!priceId) {
    return c.json({ success: false, error: "Missing price_id" }, 400);
  }

  try {
    const { default: Stripe } = await import("stripe");
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${env.PUBLIC_SITE_URL}/signup?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.PUBLIC_SITE_URL}/pricing?checkout=cancelled`,
      allow_promotion_codes: true,
    });

    return c.redirect(checkoutSession.url!, 302);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Checkout error: ${message}`);
    return c.json({ success: false, error: message }, 500);
  }
});

app.get("/api/checkout/session/:sessionId", async (c) => {
  const env = c.env;
  const sessionId = c.req.param("sessionId");

  try {
    const { default: Stripe } = await import("stripe");
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    return c.json({
      success: true,
      data: { email: session.customer_details?.email || null },
    });
  } catch {
    return c.json({ success: false, error: "Invalid session" }, 400);
  }
});

app.post("/api/checkout", async (c) => {
  const env = c.env;

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const token = authHeader.slice(7);
  const tokenHash = await hashSHA256(token);

  const session = await env.DB.prepare(
    "SELECT user_id, revoked, expires_at FROM sessions WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first();

  if (!session || session.revoked === 1 || new Date(session.expires_at) < new Date()) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const userRow = await env.DB.prepare(
    "SELECT id, email, stripe_customer_id FROM users WHERE id = ?"
  )
    .bind(session.user_id)
    .first();

  if (!userRow) {
    return c.json({ success: false, error: "User not found" }, 404);
  }

  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  let customerId = userRow.stripe_customer_id;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: userRow.email,
      metadata: { user_id: userRow.id },
    });
    customerId = customer.id;

    await env.DB.prepare(
      "UPDATE users SET stripe_customer_id = ? WHERE id = ?"
    )
      .bind(customerId, userRow.id)
      .run();
  }

  let body: { priceId?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    // no body is fine
  }

  const priceId = body.priceId || "price_monthly_default";

  const checkoutSession = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: `${env.PUBLIC_SITE_URL}/dashboard?checkout=success`,
    cancel_url: `${env.PUBLIC_SITE_URL}/dashboard?checkout=cancelled`,
    metadata: {
      user_id: userRow.id,
    },
  });

  return c.json({
    success: true,
    data: {
      url: checkoutSession.url,
      sessionId: checkoutSession.id,
    },
  });
});

export default app;
