/**
 * Atlassian OAuth 2.0 authorization code grant (3LO).
 * https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
 */
import type { SiteRef } from '../../shared/types.js';
import type { AppConfig } from '../config.js';

const AUTH_URL = 'https://auth.atlassian.com/authorize';
const TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope?: string;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export function buildAuthorizeUrl(cfg: AppConfig, state: string): string {
  const url = new URL(AUTH_URL);
  url.searchParams.set('audience', 'api.atlassian.com');
  url.searchParams.set('client_id', cfg.ATLASSIAN_CLIENT_ID!);
  url.searchParams.set('scope', cfg.OAUTH_SCOPES.join(' '));
  url.searchParams.set('redirect_uri', cfg.OAUTH_REDIRECT_URI!);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

async function tokenRequest(body: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenSet> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new OAuthError(json.error_description ?? json.error ?? `Token request failed (${res.status})`, res.status);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    scope: json.scope,
  };
}

export function exchangeCode(cfg: AppConfig, code: string, fetchImpl: typeof fetch = fetch): Promise<TokenSet> {
  return tokenRequest(
    {
      grant_type: 'authorization_code',
      client_id: cfg.ATLASSIAN_CLIENT_ID!,
      client_secret: cfg.ATLASSIAN_CLIENT_SECRET!,
      code,
      redirect_uri: cfg.OAUTH_REDIRECT_URI!,
    },
    fetchImpl,
  );
}

/**
 * Atlassian uses rotating refresh tokens: each refresh returns a new refresh token and the old
 * one stops working. Concurrent requests from the same session must therefore share a single
 * refresh. Results are kept briefly so a request that read the session before the rotation was
 * saved still gets the new tokens.
 */
const inflight = new Map<string, Promise<TokenSet>>();
const REUSE_WINDOW_MS = 60_000;

export function refreshTokens(cfg: AppConfig, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<TokenSet> {
  const existing = inflight.get(refreshToken);
  if (existing) return existing;
  const p = tokenRequest(
    {
      grant_type: 'refresh_token',
      client_id: cfg.ATLASSIAN_CLIENT_ID!,
      client_secret: cfg.ATLASSIAN_CLIENT_SECRET!,
      refresh_token: refreshToken,
    },
    fetchImpl,
  ).then((t) => ({ ...t, refreshToken: t.refreshToken ?? refreshToken }));
  inflight.set(refreshToken, p);
  const clear = () => setTimeout(() => inflight.delete(refreshToken), REUSE_WINDOW_MS).unref?.();
  p.then(clear, () => inflight.delete(refreshToken));
  return p;
}

export async function getAccessibleSites(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<SiteRef[]> {
  const res = await fetchImpl(RESOURCES_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new OAuthError(`Could not list accessible Atlassian sites (${res.status})`, res.status);
  const list = (await res.json()) as Array<{ id: string; name: string; url: string; scopes?: string[] }>;
  return list
    .filter((r) => !r.scopes || r.scopes.some((s) => s.includes('jira')))
    .map((r) => ({ cloudId: r.id, name: r.name, url: r.url }));
}
