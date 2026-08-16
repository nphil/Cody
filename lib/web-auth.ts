import { createHash, timingSafeEqual } from "node:crypto";
import { readEnv } from "./env";

export const CODY_AUTH_USERNAME = "cody";

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function equal(left: string, right: string): boolean {
  return timingSafeEqual(hash(left), hash(right));
}

export function isWebPasswordEnabled(password: string | undefined = readEnv("PASSWORD")): password is string {
  return typeof password === "string" && password.length > 0;
}

export function isValidBasicAuthorization(authorization: string | null, password = readEnv("PASSWORD")): boolean {
  if (!isWebPasswordEnabled(password) || !authorization) return false;
  const match = /^Basic\s+(\S+)$/i.exec(authorization);
  if (!match) return false;

  let credentials: string;
  try {
    const decoded = Buffer.from(match[1], "base64");
    if (decoded.toString("base64") !== match[1]) return false;
    credentials = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  } catch {
    return false;
  }
  const separator = credentials.indexOf(":");
  if (separator === -1) return false;
  return equal(credentials.slice(0, separator), CODY_AUTH_USERNAME)
    && equal(credentials.slice(separator + 1), password);
}
