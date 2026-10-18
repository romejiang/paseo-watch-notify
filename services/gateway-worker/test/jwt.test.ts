import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "vitest";
import { pemToDer, signProviderToken } from "../src/jwt.js";

function toPkcs8Pem(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]): string {
  const base64 = privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
}

describe("pemToDer", () => {
  test("strips PEM armor and decodes DER", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const der = new Uint8Array(pemToDer(toPkcs8Pem(privateKey)));
    // PKCS#8 DER starts with a SEQUENCE (0x30).
    expect(der[0]).toBe(0x30);
    expect(der.length).toBeGreaterThan(0);
  });
});

describe("signProviderToken", () => {
  test("produces a verifiable ES256 JWT with the expected header and claims", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

    const token = await signProviderToken({
      keyPem: toPkcs8Pem(privateKey),
      keyId: "ABC123",
      teamId: "TEAM456",
      issuedAtSeconds: 1_700_000_000,
    });

    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString("utf8"))).toEqual({
      alg: "ES256",
      kid: "ABC123",
    });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString("utf8"))).toEqual({
      iss: "TEAM456",
      iat: 1_700_000_000,
    });
    // ES256 raw signatures are 64 bytes (r || s).
    expect(Buffer.from(signature!, "base64url")).toHaveLength(64);

    const valid = verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    );
    expect(valid).toBe(true);
  });
});
