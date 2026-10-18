/** Base64url encode bytes without padding. */
function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlFromText(text: string): string {
  return base64UrlFromBytes(new TextEncoder().encode(text));
}

/** Convert a PKCS#8 PEM block into DER bytes. */
export function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

const keyCache = new Map<string, CryptoKey>();

async function importKey(pem: string): Promise<CryptoKey> {
  const cached = keyCache.get(pem);
  if (cached) {
    return cached;
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  keyCache.set(pem, key);
  return key;
}

/**
 * Sign an APNs provider token (ES256 JWT) using Web Crypto.
 *
 * Web Crypto's ECDSA `sign` already returns the raw `r || s` (IEEE P1363) form that JOSE expects,
 * so no DER-to-JOSE conversion is needed.
 */
export async function signProviderToken(input: {
  keyPem: string;
  keyId: string;
  teamId: string;
  issuedAtSeconds: number;
}): Promise<string> {
  const header = base64UrlFromText(JSON.stringify({ alg: "ES256", kid: input.keyId }));
  const claims = base64UrlFromText(JSON.stringify({ iss: input.teamId, iat: input.issuedAtSeconds }));
  const signingInput = `${header}.${claims}`;
  const key = await importKey(input.keyPem);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}
