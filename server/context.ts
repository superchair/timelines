import type { Request } from 'express';
import type { SiteRef, UserRef } from '../shared/types.js';
import { refreshTokens, type TokenSet } from './auth/oauth.js';
import type { AppConfig } from './config.js';
import { createJiraHttp } from './jira/http.js';
import { MockSource } from './jira/mock.js';
import { JiraRestSource, type JiraDataSource } from './jira/source.js';

declare module 'express-session' {
  interface SessionData {
    oauthState?: string;
    returnTo?: string;
    tokens?: TokenSet;
    sites?: SiteRef[];
    site?: SiteRef;
    user?: UserRef;
  }
}

export class NotAuthenticatedError extends Error {
  readonly status = 401;
  constructor(message = 'Not signed in') {
    super(message);
  }
}

export interface RequestContext {
  source: JiraDataSource;
  /** Stable per-user/per-site key used to partition caches (permissions differ per user). */
  identity: string;
  /** Site-level key for data that's the same for every user (e.g. field definitions). */
  siteKey: string;
}

const EXPIRY_SKEW_MS = 60_000;

export function createContextFactory(cfg: AppConfig) {
  let mock: MockSource | undefined;
  let tokenSource: JiraRestSource | undefined;

  return function contextFor(req: Request): RequestContext {
    if (cfg.AUTH_MODE === 'mock') {
      mock ??= new MockSource();
      return { source: mock, identity: 'mock', siteKey: 'mock' };
    }

    if (cfg.AUTH_MODE === 'token') {
      const site = cfg.JIRA_SITE_URL!.replace(/\/$/, '');
      tokenSource ??= new JiraRestSource(
        createJiraHttp({
          baseUrl: site,
          siteUrl: site,
          getAuthorization: async () =>
            `Basic ${Buffer.from(`${cfg.JIRA_EMAIL}:${cfg.JIRA_API_TOKEN}`).toString('base64')}`,
        }),
      );
      return { source: tokenSource, identity: `token:${cfg.JIRA_EMAIL}`, siteKey: `site:${site}` };
    }

    // OAuth: a client per request, bound to the caller's session tokens.
    const session = req.session;
    if (!session.tokens || !session.site) throw new NotAuthenticatedError();
    const site = session.site;

    const refresh = async () => {
      const current = session.tokens;
      if (!current?.refreshToken) throw new NotAuthenticatedError('Session expired; please sign in again');
      try {
        session.tokens = await refreshTokens(cfg, current.refreshToken);
      } catch {
        session.tokens = undefined;
        throw new NotAuthenticatedError('Session expired; please sign in again');
      }
      await new Promise<void>((resolve) => session.save(() => resolve()));
    };

    const http = createJiraHttp({
      baseUrl: `https://api.atlassian.com/ex/jira/${site.cloudId}`,
      siteUrl: site.url,
      getAuthorization: async () => {
        if (!session.tokens) throw new NotAuthenticatedError();
        if (session.tokens.expiresAt - EXPIRY_SKEW_MS <= Date.now()) await refresh();
        return `Bearer ${session.tokens!.accessToken}`;
      },
      onUnauthorized: async () => {
        await refresh();
        return true;
      },
    });

    return {
      source: new JiraRestSource(http),
      identity: `oauth:${site.cloudId}:${session.user?.accountId ?? 'unknown'}`,
      siteKey: `site:${site.cloudId}`,
    };
  };
}
