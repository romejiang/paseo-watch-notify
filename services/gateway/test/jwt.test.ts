import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, test } from "vitest";
import { signProviderToken } from "../src/jwt.js";

function makeKeyPair(): { privateKeyPem: string; publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"] } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

describe("signProviderToken", () => {
  test("produces a verifiable ES256 JWT with the expected header and claims", () => {
    const { privateKeyPem, publicKey } = makeKeyPair();
    const token = signProviderToken({
      keyPem: privateKeyPem,
      keyId: "ABC123",
      teamId: "TEAM456",
      issuedAtSeconds: 1_700_000_000,
    });

    const [header, claims, signature] = token.split(".");
    expect(header).toBeTruthy();
    expect(claims).toBeTruthy();
    expect(signature).toBeTruthy();

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
