import { createHash, timingSafeEqual } from "crypto";

export const AUTH_COOKIE_NAME = "issue-estimator-auth";
const COOKIE_SALT = "issue-estimator-cookie-v1";

function ensureHexString(value: string, label: string) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
    throw new Error(`${label} must be a hex-encoded string`);
  }
}

export function readConfiguredPasswordHash(): string {
  const raw = process.env.APP_PASSWORD_SHA256;
  if (!raw) {
    throw new Error("APP_PASSWORD_SHA256 environment variable is required");
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized.length !== 64) {
    throw new Error("APP_PASSWORD_SHA256 must be the 64 character SHA-256 digest");
  }
  ensureHexString(normalized, "APP_PASSWORD_SHA256");
  return normalized;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hexToBuffer(value: string): Buffer | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) {
    return null;
  }
  try {
    return Buffer.from(value, "hex");
  } catch {
    return null;
  }
}

export function constantTimeHexEquals(a: string, b: string): boolean {
  const aBuffer = hexToBuffer(a);
  const bBuffer = hexToBuffer(b);
  if (!aBuffer || !bBuffer || aBuffer.length !== bBuffer.length) {
    return false;
  }
  return timingSafeEqual(aBuffer, bBuffer);
}

export function deriveCookieDigest(hash: string): string {
  return sha256(`${COOKIE_SALT}:${hash}`);
}

export function verifyPasswordAgainstHash(password: string, expectedHash: string): boolean {
  const candidate = sha256(password);
  return constantTimeHexEquals(candidate, expectedHash);
}

export function isAuthorizedCookie(cookieValue: string | undefined, expectedHash: string): boolean {
  if (!cookieValue) {
    return false;
  }
  const expectedDigest = deriveCookieDigest(expectedHash);
  return constantTimeHexEquals(cookieValue, expectedDigest);
}
