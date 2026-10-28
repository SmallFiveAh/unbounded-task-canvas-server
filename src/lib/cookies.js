/**
 * Cookie 解析与序列化。会话使用 __Host- 前缀：
 * 强制 Secure、Path=/ 且禁止 Domain，防止子域覆盖（设计 §3.5）。
 */

export function parseCookieHeader(header) {
  const cookies = {};
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;

    const name = part.slice(0, separator).trim();
    if (!name) continue;

    let value = part.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  return cookies;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge != null) {
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }
  if (options.expires) {
    parts.push(`Expires=${new Date(options.expires).toUTCString()}`);
  }

  parts.push(`Path=${options.path ?? '/'}`);

  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);

  return parts.join('; ');
}

/** 立即过期某个 cookie（用于登出、OAuth 一次性 cookie） */
export function expireCookie(name, options = {}) {
  return serializeCookie(name, '', { ...options, maxAge: 0, expires: new Date(0) });
}

export function appendCookie(c, cookie) {
  c.header('Set-Cookie', cookie, { append: true });
}
