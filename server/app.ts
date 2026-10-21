import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import createMemoryStore from 'memorystore';
import helmet from 'helmet';
import { z } from 'zod';
import { isIsoDate } from '../shared/dates.js';
import type { MeResponse, ScopeRequest, TimelineResponse } from '../shared/types.js';
import { buildAuthorizeUrl, exchangeCode, getAccessibleSites, OAuthError } from './auth/oauth.js';
import { TtlCache } from './cache.js';
import type { AppConfig } from './config.js';
import { createContextFactory, NotAuthenticatedError, type RequestContext } from './context.js';
import { JiraApiError } from './jira/http.js';
import { loadTimeline, resolveFields, type FieldMap } from './timeline.js';

const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'timelines';

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

const issueKey = z.string().regex(/^[A-Z][A-Z0-9_]*-\d+$/, 'Invalid work item key');

const scopeSchema = z.object({
  source: z.enum(['board', 'filter', 'jql']),
  value: z.string().trim().min(1).max(4000),
  doneWithinDays: z.coerce.number().int().min(-1).max(3650).default(30),
});

const datesSchema = z
  .object({
    start: z.string().nullable().refine((v) => v === null || isIsoDate(v), 'start must be YYYY-MM-DD or null'),
    due: z.string().nullable().refine((v) => v === null || isIsoDate(v), 'due must be YYYY-MM-DD or null'),
  })
  .refine((v) => !v.start || !v.due || v.start <= v.due, 'start must be on or before due');

const dependencySchema = z
  .object({ fromKey: issueKey, toKey: issueKey })
  .refine((v) => v.fromKey !== v.toKey, 'A work item cannot depend on itself');

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

export function createApp(cfg: AppConfig) {
  const app = express();
  const contextFor = createContextFactory(cfg);
  const timelineCache = new TtlCache<TimelineResponse>(cfg.CACHE_TTL_SECONDS * 1000, 200);
  const scopeCache = new TtlCache<{ jql: string; label: string }>(5 * 60_000, 500);
  const fieldCache = new TtlCache<FieldMap>(10 * 60_000, 100);

  if (cfg.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { 'img-src': ["'self'", 'data:', 'https:'] },
      },
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  const MemoryStore = createMemoryStore(session);
  const secret = cfg.SESSION_SECRET ?? randomBytes(32).toString('hex');
  if (!cfg.SESSION_SECRET && cfg.NODE_ENV !== 'test') {
    console.warn('[timelines] SESSION_SECRET not set; using a random secret (sessions reset on restart).');
  }
  app.use(
    session({
      name: 'timelines.sid',
      secret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      store: new MemoryStore({ checkPeriod: 60 * 60_000 }),
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: cfg.NODE_ENV === 'production',
        maxAge: 12 * 60 * 60_000,
      },
    }),
  );

  // CSRF defence for state-changing requests: browsers won't send this custom header cross-site
  // without a CORS preflight, which this server never approves.
  app.use((req, _res, next) => {
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating && (req.path.startsWith('/api/') || req.path.startsWith('/auth/'))) {
      if (req.get(CSRF_HEADER) !== CSRF_VALUE) return next(new HttpError(403, 'Missing CSRF header'));
    }
    next();
  });

  const fieldsFor = (ctx: RequestContext) =>
    fieldCache.getOrLoad(ctx.siteKey, async () =>
      resolveFields(await ctx.source.listFields(), {
        startDate: cfg.START_DATE_FIELD_ID,
        sprint: cfg.SPRINT_FIELD_ID,
        team: cfg.TEAM_FIELD_ID,
      }),
    );

  // ---------- Auth ----------

  app.get(
    '/auth/login',
    wrap(async (req, res) => {
      if (cfg.AUTH_MODE !== 'oauth') return res.redirect('/');
      const state = randomBytes(24).toString('base64url');
      req.session.oauthState = state;
      await new Promise<void>((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
      res.redirect(buildAuthorizeUrl(cfg, state));
    }),
  );

  app.get(
    '/auth/callback',
    wrap(async (req, res) => {
      if (cfg.AUTH_MODE !== 'oauth') return res.redirect('/');
      const { code, state, error, error_description: errorDescription } = req.query as Record<string, string | undefined>;
      if (error) throw new HttpError(400, 'Atlassian sign-in was cancelled or failed', errorDescription ?? error);
      const expected = req.session.oauthState;
      if (!code || !state || !expected || state.length !== expected.length || !timingSafeEqual(Buffer.from(state), Buffer.from(expected))) {
        throw new HttpError(400, 'Invalid sign-in state. Please try signing in again.');
      }

      const tokens = await exchangeCode(cfg, code);
      const sites = await getAccessibleSites(tokens.accessToken);
      if (sites.length === 0) throw new HttpError(403, 'Your Atlassian account has not granted access to any Jira sites.');

      // Prevent session fixation: new session id once authenticated.
      await new Promise<void>((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
      req.session.tokens = tokens;
      req.session.sites = sites;
      if (sites.length === 1) {
        req.session.site = sites[0];
        req.session.user = await contextFor(req).source.myself();
      }
      await new Promise<void>((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));
      res.redirect('/');
    }),
  );

  app.post(
    '/auth/logout',
    wrap(async (req, res) => {
      await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
      res.clearCookie('timelines.sid');
      res.json({ ok: true });
    }),
  );

  // ---------- API ----------

  app.get('/api/health', (_req, res) => res.json({ ok: true, mode: cfg.AUTH_MODE }));

  app.get(
    '/api/me',
    wrap(async (req, res) => {
      const body: MeResponse = { authenticated: false, mode: cfg.AUTH_MODE };
      if (cfg.AUTH_MODE === 'oauth') {
        const s = req.session;
        if (s.tokens && s.site && s.user) Object.assign(body, { authenticated: true, user: s.user, site: s.site });
        else if (s.tokens && s.sites?.length) body.sites = s.sites;
        return res.json(body);
      }
      const ctx = contextFor(req);
      const user = await ctx.source.myself();
      res.json({
        ...body,
        authenticated: true,
        user,
        site: { cloudId: ctx.siteKey, name: new URL(ctx.source.siteUrl).hostname, url: ctx.source.siteUrl },
      } satisfies MeResponse);
    }),
  );

  app.post(
    '/api/sites/select',
    wrap(async (req, res) => {
      const { cloudId } = z.object({ cloudId: z.string().min(1) }).parse(req.body);
      const site = req.session.sites?.find((s) => s.cloudId === cloudId);
      if (!req.session.tokens || !site) throw new HttpError(400, 'Unknown site');
      req.session.site = site;
      req.session.user = await contextFor(req).source.myself();
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/boards',
    wrap(async (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined;
      res.json(await contextFor(req).source.listBoards(q));
    }),
  );

  app.get(
    '/api/timeline',
    wrap(async (req, res) => {
      const scope: ScopeRequest & { doneWithinDays: number } = scopeSchema.parse(req.query);
      const ctx = contextFor(req);
      const fresh = req.query.fresh === '1';
      const key = `${ctx.identity}|${scope.source}|${scope.value}|${scope.doneWithinDays}`;
      if (fresh) timelineCache.deletePrefix(key);

      const data = await timelineCache.getOrLoad(key, async () => {
        const resolved = await scopeCache.getOrLoad(`${ctx.identity}|${scope.source}|${scope.value}`, async () => {
          if (scope.source === 'jql') return { jql: scope.value, label: 'Custom JQL' };
          const id = Number(scope.value);
          if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `${scope.source} ID must be a positive number`);
          try {
            const found = scope.source === 'board' ? await ctx.source.getBoardScope(id) : await ctx.source.getFilterScope(id);
            return { jql: found.jql, label: found.name };
          } catch (e) {
            if (e instanceof JiraApiError && (e.status === 401 || e.status === 403) && scope.source === 'board') {
              throw new HttpError(
                403,
                `Couldn't read board ${id}'s configuration.`,
                'Reading a board filter needs the read:board-scope.admin:jira-software scope. Use the board\'s saved filter ID or JQL instead.',
              );
            }
            throw e;
          }
        });
        return loadTimeline(ctx.source, await fieldsFor(ctx), resolved, {
          epicClause: cfg.EPIC_JQL_CLAUSE,
          dependencyLinkTypes: cfg.DEPENDENCY_LINK_TYPES,
          maxEpics: cfg.MAX_EPICS,
          maxChildren: cfg.MAX_CHILDREN,
          doneWithinDays: scope.doneWithinDays,
        });
      });
      res.set('Cache-Control', 'no-store').json(data);
    }),
  );

  app.patch(
    '/api/issues/:key/dates',
    wrap(async (req, res) => {
      const key = issueKey.parse(req.params.key);
      const body = datesSchema.parse(req.body);
      const ctx = contextFor(req);
      const fm = await fieldsFor(ctx);
      const fields: Record<string, unknown> = { duedate: body.due };
      if (fm.startDate) fields[fm.startDate] = body.start;
      else if (body.start) throw new HttpError(400, 'This Jira site has no "Start date" field, so start dates cannot be saved.');
      try {
        await ctx.source.updateIssueFields(key, fields);
      } catch (e) {
        if (e instanceof JiraApiError && e.status === 400) {
          throw new HttpError(
            400,
            `Jira rejected the date change for ${key}.`,
            `${e.message}. If it says a field "cannot be set", add Start date and Due date to that project's edit screen.`,
          );
        }
        throw e;
      }
      timelineCache.deletePrefix(ctx.identity);
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/dependencies',
    wrap(async (req, res) => {
      const { fromKey, toKey } = dependencySchema.parse(req.body);
      const ctx = contextFor(req);
      await ctx.source.createDependencyLink(fromKey, toKey, cfg.DEPENDENCY_LINK_TYPES[0]);
      timelineCache.deletePrefix(ctx.identity);
      res.status(201).json({ ok: true });
    }),
  );

  app.delete(
    '/api/dependencies/:id',
    wrap(async (req, res) => {
      const id = z.string().regex(/^\d+$/).parse(req.params.id);
      const ctx = contextFor(req);
      await ctx.source.deleteIssueLink(id);
      timelineCache.deletePrefix(ctx.identity);
      res.json({ ok: true });
    }),
  );

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // ---------- Static web app (production build) ----------
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDir = [path.resolve(here, '../web'), path.resolve(here, '../dist/web')].find((d) => existsSync(path.join(d, 'index.html')));
  if (webDir) {
    app.use(express.static(webDir, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
  }

  // ---------- Errors ----------
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let status = 500;
    let error = 'Something went wrong';
    let detail: string | undefined;

    if (err instanceof HttpError) {
      status = err.status;
      error = err.message;
      detail = err.detail;
    } else if (err instanceof z.ZodError) {
      status = 400;
      error = 'Invalid request';
      detail = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    } else if (err instanceof NotAuthenticatedError) {
      status = 401;
      error = err.message;
    } else if (err instanceof OAuthError) {
      status = 401;
      error = 'Atlassian sign-in failed';
      detail = err.message;
    } else if (err instanceof JiraApiError) {
      status = [400, 401, 403, 404].includes(err.status) ? err.status : 502;
      error = err.status === 403 ? 'Jira denied access' : err.status === 404 ? 'Not found in Jira' : 'Jira request failed';
      detail = err.message;
    } else if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
      status = err.status;
      error = (err as unknown as Error).message;
    }

    if (status >= 500) console.error('[timelines]', req.method, req.path, err);
    if (req.path.startsWith('/auth/') && req.method === 'GET') {
      res.status(status).type('text/plain').send(`${error}${detail ? `\n\n${detail}` : ''}\n\nReturn to the app and try again.`);
      return;
    }
    res.status(status).json({ error, detail });
  });

  return app;
}
