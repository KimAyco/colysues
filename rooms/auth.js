const crypto = require("node:crypto");
const { ServerError } = require("colyseus");

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64");
}

function verifyGameToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("GAME_AUTH_SECRET must be configured with at least 32 characters");
  }
  if (typeof token !== "string" || token.length > 4096) {
    throw new ServerError(4002, "authentication required");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new ServerError(4002, "invalid access token");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const expected = crypto.createHmac("sha256", secret).update(unsigned).digest();
  let actual;
  try {
    actual = decodeBase64Url(encodedSignature);
  } catch {
    throw new ServerError(4002, "invalid access token");
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw new ServerError(4002, "invalid access token");
  }

  let header;
  let payload;
  try {
    header = JSON.parse(decodeBase64Url(encodedHeader).toString("utf8"));
    payload = JSON.parse(decodeBase64Url(encodedPayload).toString("utf8"));
  } catch {
    throw new ServerError(4002, "invalid access token");
  }

  if (
    header?.alg !== "HS256" ||
    payload?.iss !== "pixel-fishing" ||
    !/^[1-9]\d*$/.test(String(payload?.sub ?? "")) ||
    !Number.isInteger(payload?.exp) ||
    payload.exp <= nowSeconds ||
    typeof payload?.name !== "string"
  ) {
    throw new ServerError(4002, "expired or invalid access token");
  }
  return { accountId: Number(payload.sub), username: payload.name };
}

function signGameToken(accountId, username, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: "pixel-fishing",
    sub: String(accountId),
    name: username,
    iat: nowSeconds,
    exp: nowSeconds + 86400,
  });
  const unsigned = `${header}.${payload}`;
  const signature = crypto.createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

module.exports = { verifyGameToken, signGameToken };
