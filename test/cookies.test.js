import { describe, expect, it } from 'vitest';
import { expireCookie, parseCookieHeader, serializeCookie } from '../src/lib/cookies.js';

describe('cookies', () => {
  it('解析带空格与编码的 Cookie 头', () => {
    const cookies = parseCookieHeader('a=1; b=hello%20world; __Host-session=abc');
    expect(cookies).toEqual({ a: '1', b: 'hello world', '__Host-session': 'abc' });
  });

  it('空头返回空对象', () => {
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
  });

  it('会话 cookie 带 __Host- 安全属性', () => {
    const cookie = serializeCookie('__Host-session', 'token', {
      maxAge: 60,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
    });

    expect(cookie).toContain('__Host-session=token');
    expect(cookie).toContain('Max-Age=60');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain=');
  });

  it('过期 cookie 使用 Max-Age=0', () => {
    const cookie = expireCookie('__Host-session');
    expect(cookie).toContain('Max-Age=0');
  });
});
