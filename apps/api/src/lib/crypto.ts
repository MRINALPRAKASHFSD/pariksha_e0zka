import crypto from "node:crypto";

const SCRYPT_KEY_LENGTH = 64;
// 64 MiB memory-hard cost (N=2^16, r=8, p=1) aligned with OWASP scrypt guidance
const SCRYPT_COST = 65536;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

function scryptAsync(
  password: string,
  salt: string,
  keyLength: number,
  N: number,
  r: number,
  p: number,
): Promise<Buffer> {
  const requiredMemory = 128 * N * r * p;
  const maxmem = Math.max(32 * 1024 * 1024, requiredMemory * 2);
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, { N, r, p, maxmem }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Hash a password using Node.js native crypto.scrypt with a random 16-byte salt.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await scryptAsync(
    password,
    salt,
    SCRYPT_KEY_LENGTH,
    SCRYPT_COST,
    SCRYPT_BLOCK_SIZE,
    SCRYPT_PARALLELIZATION,
  );
  return `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELIZATION}$${salt}$${derivedKey.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  const salt = parts[4];
  const expectedHex = parts[5];
  if (
    !salt ||
    !expectedHex ||
    !Number.isFinite(cost) ||
    !Number.isFinite(blockSize) ||
    !Number.isFinite(parallelization) ||
    cost < 16384
  ) {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedHex, "hex");
  const derivedKey = await scryptAsync(
    password,
    salt,
    expectedBuffer.length,
    cost,
    blockSize,
    parallelization,
  );

  if (derivedKey.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(derivedKey, expectedBuffer);
}

// Constant precomputed dummy hash used during invalid-email logins to reduce timing side channels
export const DUMMY_PASSWORD_HASH =
  "scrypt$65536$8$1$00112233445566778899aabbccddeeff$" + "0".repeat(128);

export function generateOpaqueToken(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString("hex");
}

export function hashToken(token: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function generateTemporaryPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const all = upper + lower + digits;
  const chars = [
    upper[crypto.randomInt(upper.length)]!,
    lower[crypto.randomInt(lower.length)]!,
    digits[crypto.randomInt(digits.length)]!,
  ];
  for (let i = 0; i < 11; i++) {
    chars.push(all[crypto.randomInt(all.length)]!);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const tmp = chars[i]!;
    chars[i] = chars[j]!;
    chars[j] = tmp;
  }
  return chars.join("");
}
