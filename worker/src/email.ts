import type { Env } from "./types";

export async function sendVerificationCode(
  env: Env,
  email: string,
  code: string
): Promise<void> {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
          <tr>
            <td style="background-color:#18181b;padding:32px 40px;text-align:center;">
              <h1 style="color:#ffffff;font-size:24px;margin:0;font-weight:600;">Borderlessify</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">
              <h2 style="color:#18181b;font-size:20px;margin:0 0 16px 0;font-weight:600;">Verify your email</h2>
              <p style="color:#52525b;font-size:14px;line-height:1.6;margin:0 0 24px 0;">Use the following code to sign in to your Borderlessify account. This code expires in 10 minutes.</p>
              <div style="background-color:#f4f4f5;border-radius:8px;padding:20px;text-align:center;margin:0 0 24px 0;">
                <span style="font-size:32px;font-weight:700;color:#18181b;letter-spacing:8px;font-family:monospace;">${code}</span>
              </div>
              <p style="color:#a1a1aa;font-size:12px;line-height:1.5;margin:0;">If you did not request this code, you can safely ignore this email. Do not share this code with anyone.</p>
            </td>
          </tr>
          <tr>
            <td style="background-color:#fafafa;padding:24px 40px;border-top:1px solid #e4e4e7;">
              <p style="color:#a1a1aa;font-size:12px;margin:0;text-align:center;">&copy; ${new Date().getFullYear()} Borderlessify. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `Borderlessify - Verify your email

Your verification code is: ${code}

This code expires in 10 minutes.

If you did not request this code, you can safely ignore this email. Do not share this code with anyone.`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || "onboarding@resend.dev",
      to: [email],
      subject: "Your Borderlessify verification code",
      html,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to send email: ${body}`);
  }
}
