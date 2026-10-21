import { createApp } from './app.js';
import { loadConfig } from './config.js';

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const app = createApp(cfg);
const server = app.listen(cfg.PORT, () => {
  console.log(`[timelines] API listening on http://localhost:${cfg.PORT} (AUTH_MODE=${cfg.AUTH_MODE})`);
  if (cfg.NODE_ENV !== 'production') console.log(`[timelines] Open ${cfg.APP_BASE_URL}`);
});

const shutdown = (signal: string) => {
  console.log(`[timelines] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
