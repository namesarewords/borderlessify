const encoder = new TextEncoder();

export function generateOTP(): string {
  const bytes = new Uint8Array(1);
  let otp = "";
  for (let i = 0; i < 6; i++) {
    crypto.getRandomValues(bytes);
    otp += (bytes[0] % 10).toString();
  }
  return otp;
}

export async function hashSHA256(data: string): Promise<string> {
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateToken(): string {
  return crypto.randomUUID();
}
