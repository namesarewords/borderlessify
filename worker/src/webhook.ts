import { Hono } from "hono";
import type { Env } from "./types";
import Stripe from "stripe";
import { hashSHA256, generateToken } from "./crypto";
import { sendSetPasswordEmail } from "./email";

const webhook = new Hono<{ Bindings: Env }>();

const SET_PASSWORD_TTL_SECONDS = 24 * 60 * 60;

webhook.post("/stripe", async (c) => {
  const env = c.env;

  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return new Response(JSON.stringify({ error: "Missing stripe-signature header" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await c.req.text();

  let event: Stripe.Event;
  try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY);
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Webhook signature verification failed: ${message}`);
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const customerId = session.customer as string;
        const customerEmail = session.customer_details?.email || session.customer_email;

        if (!customerEmail || !customerId) {
          console.error("checkout.session.completed: missing email or customer ID");
          break;
        }

        const email = customerEmail.toLowerCase();
        const now = new Date().toISOString();

        let userRow = await env.DB.prepare(
          "SELECT id, email, stripe_customer_id, password_hash, created_at FROM users WHERE email = ?"
        )
          .bind(email)
          .first();

        let isNewUser = false;

        if (!userRow) {
          const userId = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO users (id, email, stripe_customer_id, created_at) VALUES (?, ?, ?, ?)"
          )
            .bind(userId, email, customerId, now)
            .run();

          userRow = { id: userId, email, stripe_customer_id: customerId, password_hash: null, created_at: now };
          isNewUser = true;
        } else if (!userRow.stripe_customer_id) {
          await env.DB.prepare(
            "UPDATE users SET stripe_customer_id = ? WHERE id = ?"
          )
            .bind(customerId, userRow.id)
            .run();
        }

        if (!userRow.password_hash) {
          // Invalidate any existing set-password tokens for this user
          await env.DB.prepare(
            "UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0"
          )
            .bind(userRow.id)
            .run();

          const resetToken = generateToken();
          const resetTokenHash = await hashSHA256(resetToken);
          const resetId = crypto.randomUUID();
          const expiresAt = new Date(Date.now() + SET_PASSWORD_TTL_SECONDS * 1000).toISOString();

          await env.DB.prepare(
            "INSERT INTO password_resets (id, user_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)"
          )
            .bind(resetId, userRow.id, resetTokenHash, expiresAt, now)
            .run();

          try {
            const signupUrl = `${env.PUBLIC_SITE_URL}/signup?session_id=${session.id}&email=${encodeURIComponent(email)}`;
            await sendSetPasswordEmail(env, email, signupUrl);
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            console.error(`Failed to send set-password email to ${email}: ${msg}`);
          }
        }

        const subscriptionId = session.subscription as string | null;
        if (subscriptionId) {
          try {
            const stripe = new Stripe(env.STRIPE_SECRET_KEY);
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);

            const existingSub = await env.DB.prepare(
              "SELECT id FROM subscriptions WHERE stripe_subscription_id = ?"
            )
              .bind(subscriptionId)
              .first();

            const periodEnd = new Date(
              subscription.current_period_end * 1000
            ).toISOString();

            if (existingSub) {
              await env.DB.prepare(
                "UPDATE subscriptions SET status = ?, current_period_end = ?, updated_at = ? WHERE stripe_subscription_id = ?"
              )
                .bind(subscription.status, periodEnd, now, subscriptionId)
                .run();
            } else {
              await env.DB.prepare(
                "INSERT INTO subscriptions (id, user_id, stripe_subscription_id, status, current_period_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
              )
                .bind(
                  crypto.randomUUID(),
                  userRow.id,
                  subscriptionId,
                  subscription.status,
                  periodEnd,
                  now,
                  now
                )
                .run();
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            console.error(`checkout.session.completed: failed to sync subscription ${subscriptionId}: ${msg}`);
          }
        }

        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const stripeSubscriptionId = subscription.id;
        const now = new Date().toISOString();
        const periodEnd = new Date(
          subscription.current_period_end * 1000
        ).toISOString();

        const existingSub = await env.DB.prepare(
          "SELECT id FROM subscriptions WHERE stripe_subscription_id = ?"
        )
          .bind(stripeSubscriptionId)
          .first();

        if (existingSub) {
          await env.DB.prepare(
            "UPDATE subscriptions SET status = ?, current_period_end = ?, updated_at = ? WHERE stripe_subscription_id = ?"
          )
            .bind(subscription.status, periodEnd, now, stripeSubscriptionId)
            .run();
        } else {
          const customerId = subscription.customer as string;
          const userRow = await env.DB.prepare(
            "SELECT id FROM users WHERE stripe_customer_id = ?"
          )
            .bind(customerId)
            .first();

          if (userRow) {
            await env.DB.prepare(
              "INSERT INTO subscriptions (id, user_id, stripe_subscription_id, status, current_period_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
            )
              .bind(
                crypto.randomUUID(),
                userRow.id,
                stripeSubscriptionId,
                subscription.status,
                periodEnd,
                now,
                now
              )
              .run();
          }
        }

        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const now = new Date().toISOString();

        await env.DB.prepare(
          "UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE stripe_subscription_id = ?"
        )
          .bind(now, subscription.id)
          .run();

        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription as string | null;

        if (subscriptionId) {
          try {
            const stripe = new Stripe(env.STRIPE_SECRET_KEY);
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const now = new Date().toISOString();
            const periodEnd = new Date(
              subscription.current_period_end * 1000
            ).toISOString();

            await env.DB.prepare(
              "UPDATE subscriptions SET status = ?, current_period_end = ?, updated_at = ? WHERE stripe_subscription_id = ?"
            )
              .bind(subscription.status, periodEnd, now, subscriptionId)
              .run();
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            console.error(`invoice.paid: failed to sync subscription ${subscriptionId}: ${msg}`);
          }
        }

        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription as string | null;

        if (subscriptionId) {
          const now = new Date().toISOString();
          await env.DB.prepare(
            "UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE stripe_subscription_id = ?"
          )
            .bind(now, subscriptionId)
            .run();
        }

        break;
      }

      default:
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`Error processing webhook event ${event.type}: ${message}`);
    return new Response(JSON.stringify({ error: "Webhook handler error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

export default webhook;
