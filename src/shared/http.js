export async function readBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return "";
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function readJson(req) {
  const body = await readBody(req);
  return body ? JSON.parse(body) : {};
}

export function sendJson(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...headers
  });
  res.end(JSON.stringify(payload));
  return true;
}

export function sendError(res, statusCode, message, details = undefined) {
  return sendJson(res, statusCode, {
    error: {
      message,
      details
    }
  });
}

export function parseCookies(cookieHeader = "") {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const index = part.indexOf("=");
      const key = index >= 0 ? part.slice(0, index) : part;
      const value = index >= 0 ? part.slice(index + 1) : "";
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}
