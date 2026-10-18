import { createPrivateKey, createSign } from "node:crypto";

function base64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

/**
 * Build a signed APNs provider token (ES256 JWT).
 *
 * `dsaEncoding: "ieee-p1363"` makes Node emit the raw `r || s` signature that JOSE requires, so no
 * DER-to-JOSE conversion is needed.
 */
export function signProviderToken(input: {
  keyPem: string;
  keyId: string;
  teamId: string;
  issuedAtSeconds: number;
}): string {
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: input.keyId }));
  const claims = base64Url(
    JSON.stringify({ iss: input.teamId, iat: input.issuedAtSeconds }),
  );
  const signingInput = `${header}.${claims}`;

  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();

  const signature = signer.sign({
    key: createPrivateKey(input.keyPem),
    dsaEncoding: "ieee-p1363",
  });

  return `${signingInput}.${signature.toString("base64url")}`;
}
