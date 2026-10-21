# Timelines

Cross-space Jira timelines (similar to Jira Premium Plans) built only on the standard Jira Cloud REST APIs.

- **Scope by board, saved filter or JQL.** A board whose filter spans several spaces (projects) gives you one timeline across all of them.
- **Swimlanes** by space, by Team field, or none. Each epic expands to show its child work items.
- **Bars** come from Start date and Due date. When those are missing, dates are inferred, in this order: rolled up from child work items, then from sprints, then from the release date. Inferred bars are hatched.
- **Edit in place.** Drag a bar to move it, drag its edges to resize it, or drag across an empty row to schedule unscheduled work. Changes are written to Jira as Start date and Due date.
- **Dependencies.** "Blocks" links are drawn as arrows, and arrows turn red when the blocked work starts before its blocker ends. To add one, drag from the dot at the end of a bar onto another bar, or use the details panel. Click an arrow to remove it.
- **Markers** for sprints (one lane per board) and releases. Releases with the same name in several spaces are shown as one marker.
- **Shareable URLs.** The current scope, grouping and zoom are kept in the URL.

## Quick start (demo data, no Jira needed)

```bash
nvm use            # Node 22
npm install
cp .env.example .env   # AUTH_MODE=mock by default
npm run dev
```

Open http://localhost:5173 and pick the "Platform Services" board.

## Connecting to Jira

### Option A: API token (local, single user)

Good for trying it against real data before the OAuth app is set up. Every change is made as you.

```ini
AUTH_MODE=token
JIRA_SITE_URL=https://your-site.atlassian.net
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=...   # https://id.atlassian.com/manage-profile/security/api-tokens
```

### Option B: OAuth 2.0 (3LO), required for production

Each person signs in with their own Atlassian account, so Jira permissions and history apply to them.

1. Go to https://developer.atlassian.com/console/myapps and choose **Create → OAuth 2.0 integration**.
2. **Permissions → Jira API → Configure.** Add these **classic** scopes:
   `read:jira-work`, `write:jira-work`, `read:jira-user`
3. Add these **granular** scopes for the Jira Software (board) endpoints, which don't support classic scopes:
   `read:board-scope:jira-software`, `read:board-scope.admin:jira-software` (needed to read a board's filter), `read:project:jira`
4. **Authorization → OAuth 2.0 (3LO).** Add callback URLs: `http://localhost:5173/auth/callback` for development, plus `https://<your-host>/auth/callback` for production.
5. **Settings.** Copy the Client ID and Secret into `.env`:

   ```ini
   AUTH_MODE=oauth
   ATLASSIAN_CLIENT_ID=...
   ATLASSIAN_CLIENT_SECRET=...
   OAUTH_REDIRECT_URI=http://localhost:5173/auth/callback
   SESSION_SECRET=<openssl rand -hex 32>
   ```

6. **Distribution.** A new app is *private*, so only its owner can authorize it. To let your team sign in, set Distribution to **Sharing**. That asks for vendor details, a privacy policy URL and a personal-data declaration. This app keeps OAuth tokens and display names only in the server's session memory and stores nothing about users on disk. Describe that accurately in the declaration.

`offline_access` is requested automatically so sessions can refresh. Atlassian **rotates** refresh tokens, and the server shares one refresh between concurrent requests so a rotated token is never reused.

If the console doesn't let you combine classic and granular scopes, choose granular for everything and set `OAUTH_SCOPES` to match. The app only calls the endpoints listed below.

| Endpoint | Used for |
| --- | --- |
| `POST /rest/api/3/search/jql` | Epics in scope, and children (`parent in (...)`) |
| `GET /rest/api/3/field` | Discover the Start date, Sprint and Team field IDs |
| `GET /rest/api/3/myself` | Signed-in user |
| `GET /rest/api/3/filter/{id}` | Saved-filter scope |
| `GET /rest/agile/1.0/board`, `/board/{id}/configuration` | Board picker, and a board's filter |
| `PUT /rest/api/3/issue/{key}` | Save Start date / Due date |
| `POST /rest/api/3/issueLink`, `DELETE /rest/api/3/issueLink/{id}` | Add or remove dependencies |
| `GET /rest/api/3/issue/{key}?fields=issuelinks` | Check a new link's direction |

## Data conventions that make it work well

- **Field screens.** Start date and Due date must be on the **edit screen** of every space you plan in, or Jira rejects the write and the app shows that error. Team-managed spaces include both by default. Company-managed spaces may need a screen change.
- **Top-level items.** By default these are epics (`EPIC_JQL_CLAUSE=issuetype = Epic`). Work items without an epic aren't shown in v1.
- **Above epic.** Hierarchy levels above epic (e.g. Initiative) are a Premium feature. A common workaround is an "Initiatives" space linked to epics, which a later version could render.
- **Dependencies.** These use the `Blocks` link type. Set `DEPENDENCY_LINK_TYPES` if you use another, for example `Blocks,Depends`. The first type listed is the one used when creating links.
- **Releases.** Versions belong to one space. Releases with the **same version name** in several spaces are drawn as one milestone, so agree on a naming convention (for example `2026.Q4.1`).

## Production

```bash
npm run build
NODE_ENV=production AUTH_MODE=oauth SESSION_SECRET=... ATLASSIAN_CLIENT_ID=... ATLASSIAN_CLIENT_SECRET=... \
  OAUTH_REDIRECT_URI=https://timelines.example.com/auth/callback TRUST_PROXY=true npm start
```

Or use `docker build -t timelines .`. The container serves the API and the built web app on one port (3001), with a health check at `/api/health`.

The server refuses to start in production unless `AUTH_MODE=oauth` and `SESSION_SECRET` are set. Cookies are `Secure` in production, so serve the app over HTTPS (set `TRUST_PROXY=true` behind a load balancer). Writes require an `X-Requested-With` header as CSRF protection.

**Scaling past one instance.** Sessions and the response cache are in memory, which is fine for a single container. To run more than one instance, replace the `memorystore` session store in `server/app.ts` with a shared one, for example `connect-dynamodb` or `connect-redis`. Encrypt tokens at rest in that store. Refresh deduplication (`server/auth/oauth.ts`) is also per-process, so use sticky sessions or move it to a shared lock.

**Rate limits.** Timeline responses are cached for 60 seconds per user and scope (`CACHE_TTL_SECONDS`), and the cache is cleared after that user's own edits. HTTP 429 and 503 responses are retried with `Retry-After` backoff.

## Project layout

```
server/          Express API (TypeScript, ESM)
  app.ts         routes, sessions, security headers, error handling
  auth/oauth.ts  Atlassian 3LO: authorize URL, code exchange, rotating refresh
  context.ts     per-request Jira client (OAuth / API token / mock)
  jira/http.ts   REST client with retry/backoff
  jira/source.ts Jira data access (search, filters, boards, edits, links)
  jira/mock.ts   in-memory demo data
  timeline.ts    scope → epics + children → rollups, dependencies, markers
shared/          types and date helpers used by both sides
web/             React + Vite client (custom SVG timeline, no paid Gantt library)
tests/           Vitest unit + API tests (mock mode)
```

## Scripts

| Command | |
| --- | --- |
| `npm run dev` | API on :3001 + Vite on :5173 (proxying `/api` and `/auth`) |
| `npm test` | Unit and API tests |
| `npm run typecheck` | Type-check client and server |
| `npm run build` / `npm start` | Production build / serve |

## Ideas for next iterations

- Show work items that have no epic, and add a level above epic (initiatives via links).
- Webhook-driven sync into DynamoDB for very large scopes.
- Ranking by drag in the left column (`PUT /rest/agile/1.0/issue/rank`, scope `write:issue:jira-software`).
- Saved views shared across the team.
- Capacity per team based on story points per sprint.
