import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../server/app';
import { loadConfig } from '../server/config';

const app = createApp(loadConfig({ AUTH_MODE: 'mock', NODE_ENV: 'test', CACHE_TTL_SECONDS: '60' } as NodeJS.ProcessEnv));
const H = { 'X-Requested-With': 'timelines' };

describe('API (mock mode)', () => {
  it('returns a cross-project timeline for a board', async () => {
    const res = await request(app).get('/api/timeline?source=board&value=656');
    expect(res.status).toBe(200);
    expect(res.body.scope.label).toBe('Platform Services');
    expect(res.body.items.length).toBeGreaterThan(10);
  });

  it('requires the CSRF header on writes', async () => {
    const res = await request(app).patch('/api/issues/IDP-120/dates').send({ start: '2026-11-01', due: '2026-11-30' });
    expect(res.status).toBe(403);
  });

  it('validates date payloads', async () => {
    const res = await request(app).patch('/api/issues/IDP-120/dates').set(H).send({ start: '2026-12-01', due: '2026-11-01' });
    expect(res.status).toBe(400);
  });

  it('writes dates and invalidates the cache', async () => {
    await request(app).get('/api/timeline?source=board&value=656');
    const w = await request(app).patch('/api/issues/IDP-120/dates').set(H).send({ start: '2026-11-02', due: '2026-12-18' });
    expect(w.status).toBe(200);
    const res = await request(app).get('/api/timeline?source=board&value=656');
    const item = res.body.items.find((i: { key: string }) => i.key === 'IDP-120');
    expect([item.start, item.due]).toEqual(['2026-11-02', '2026-12-18']);
  });

  it('creates and removes dependencies', async () => {
    const c = await request(app).post('/api/dependencies').set(H).send({ fromKey: 'LNK-12', toKey: 'PIPE-20' });
    expect(c.status).toBe(201);
    let res = await request(app).get('/api/timeline?source=board&value=656');
    const dep = res.body.dependencies.find((d: { fromKey: string; toKey: string }) => d.fromKey === 'LNK-12' && d.toKey === 'PIPE-20');
    expect(dep).toBeTruthy();
    expect((await request(app).delete(`/api/dependencies/${dep.id}`).set(H)).status).toBe(200);
    res = await request(app).get('/api/timeline?source=board&value=656');
    expect(res.body.dependencies.some((d: { id: string }) => d.id === dep.id)).toBe(false);
  });

  it('rejects malformed keys', async () => {
    const res = await request(app).post('/api/dependencies').set(H).send({ fromKey: 'nope', toKey: 'A-1' });
    expect(res.status).toBe(400);
  });
});
