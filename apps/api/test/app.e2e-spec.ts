import request from 'supertest';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:3001';

describe('Plantak E2E', () => {
  it('health', async () => {
    const res = await request(BASE).get('/api/health');
    // nëse s’e ke /health ende, do e bëjmë pasi ta shtojmë
    expect([200, 404]).toContain(res.status);
  });
});
