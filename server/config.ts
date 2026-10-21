import 'dotenv/config';
import { z } from 'zod';

/**
 * Default OAuth scopes. Jira platform endpoints use classic scopes; Jira Software (agile)
 * endpoints only support granular scopes. Override with OAUTH_SCOPES if your app's
 * console configuration differs. These must match the scopes added in the developer console.
 */
export const DEFAULT_OAUTH_SCOPES = [
  'read:jira-work',
  'write:jira-work',
  'read:jira-user',
  'offline_access',
  'read:board-scope:jira-software',
  'read:board-scope.admin:jira-software',
  'read:project:jira',
];

const csv = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v && v.trim() ? v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : fallback,
    );

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    AUTH_MODE: z.enum(['oauth', 'token', 'mock']).default('mock'),
    APP_BASE_URL: z.string().url().default('http://localhost:5173'),
    SESSION_SECRET: z.string().optional(),
    TRUST_PROXY: z
      .string()
      .optional()
      .transform((v) => v === 'true' || v === '1'),

    // OAuth 2.0 (3LO)
    ATLASSIAN_CLIENT_ID: z.string().optional(),
    ATLASSIAN_CLIENT_SECRET: z.string().optional(),
    OAUTH_REDIRECT_URI: z.string().url().optional(),
    OAUTH_SCOPES: csv(DEFAULT_OAUTH_SCOPES),

    // API token (local development / single-user)
    JIRA_SITE_URL: z.string().url().optional(),
    JIRA_EMAIL: z.string().optional(),
    JIRA_API_TOKEN: z.string().optional(),

    // Jira data conventions
    EPIC_JQL_CLAUSE: z.string().default('issuetype = Epic'),
    DEPENDENCY_LINK_TYPES: csv(['Blocks']),
    START_DATE_FIELD_ID: z.string().optional(),
    SPRINT_FIELD_ID: z.string().optional(),
    TEAM_FIELD_ID: z.string().optional(),
    MAX_EPICS: z.coerce.number().int().positive().default(500),
    MAX_CHILDREN: z.coerce.number().int().positive().default(3000),
    CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(60),
  })
  .superRefine((cfg, ctx) => {
    const need = (key: keyof typeof cfg) => {
      if (!cfg[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when AUTH_MODE=${cfg.AUTH_MODE}` });
    };
    if (cfg.AUTH_MODE === 'oauth') {
      need('ATLASSIAN_CLIENT_ID');
      need('ATLASSIAN_CLIENT_SECRET');
      need('OAUTH_REDIRECT_URI');
    }
    if (cfg.AUTH_MODE === 'token') {
      need('JIRA_SITE_URL');
      need('JIRA_EMAIL');
      need('JIRA_API_TOKEN');
    }
    if (cfg.NODE_ENV === 'production') {
      need('SESSION_SECRET');
      if (cfg.AUTH_MODE !== 'oauth') {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_MODE'],
          message: 'Production deployments must use AUTH_MODE=oauth so every user acts as themselves in Jira.',
        });
      }
    }
  });

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat blank values (e.g. `FOO=` in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
