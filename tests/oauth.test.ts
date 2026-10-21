import { describe, expect, it, vi } from 'vitest';
import { buildAuthorizeUrl, refreshTokens } from '../server/auth/oauth';
import { loadConfig } from '../server/config';

const cfg = loadConfig({
  AUTH_MODE: 'oauth', NODE_ENV: 'test', ATLASSIAN_CLIENT_ID: 'cid', ATLASSIAN_CLIENT_SECRET: 'sec',
  OAUTH_REDIRECT_URI: 'http://localhost:5173/auth/callback',
} as NodeJS.ProcessEnv);

describe('OAuth', () => {
  it('builds an authorize URL with offline access', () => {
    const url = new URL(buildAuthorizeUrl(cfg, 'state123'));
    expect(url.origin).toBe('https://auth.atlassian.com');
    expect(url.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(url.searchParams.get('scope')).toContain('offline_access');
    expect(url.searchParams.get('state')).toBe('state123');
  });

  it('shares one refresh between concurrent callers (rotating refresh tokens)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'a2', refresh_token: 'r2', expires_in: 3600 }), { status: 200 }),
    );
    const [a, b] = await Promise.all([
      refreshTokens(cfg, 'r1', fetchImpl as unknown as typeof fetch),
      refreshTokens(cfg, 'r1', fetchImpl as unknown as typeof fetch),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a.refreshToken).toBe('r2');
    expect(b.accessToken).toBe('a2');
  });

  it('rejects production config without OAuth', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'mock', SESSION_SECRET: 'x' } as NodeJS.ProcessEnv)).toThrow(/AUTH_MODE=oauth/);
  });
});
