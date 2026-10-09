import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from './config.ts';

describe('configuracao da instalacao', () => {
  test('sem banco, a rede de exemplo e o padrao; com banco, so se pedida', () => {
    assert.equal(loadConfig({}).seedDemoData, true);
    assert.equal(loadConfig({ SEED_DEMO_DATA: 'false' }).seedDemoData, false);

    const comBanco = { DATABASE_URL: 'postgres://u@db.exemplo.com/rede' };
    assert.equal(loadConfig(comBanco).seedDemoData, false, 'dez lojas ficticias num banco de piloto, nao');
    assert.equal(loadConfig({ ...comBanco, SEED_DEMO_DATA: 'true' }).seedDemoData, true);
  });

  test('o varredor roda no processo, menos na Vercel ou quando desligado', () => {
    assert.equal(loadConfig({}).sweepIntervalMs, 60_000);
    assert.equal(loadConfig({ SWEEP_INTERVAL_MS: '0' }).sweepIntervalMs, null);
    assert.equal(loadConfig({ VERCEL: '1' }).sweepIntervalMs, null, 'la quem varre e o cron');
    assert.equal(loadConfig({ VERCEL: '1', SWEEP_INTERVAL_MS: '30000' }).sweepIntervalMs, 30_000);
  });

  test('o banco remoto confere o certificado por padrao', () => {
    const remoto = loadConfig({ DATABASE_URL: 'postgres://u:p@db.exemplo.com:6543/postgres?sslmode=require' });
    assert.deepEqual(remoto.database?.ssl, { mode: 'verify', caCert: null });
    assert.equal(remoto.database?.url.includes('sslmode'), false, 'quem decide e DATABASE_SSL, nao a URL');

    const local = loadConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1:5433/rede' });
    assert.deepEqual(local.database?.ssl, { mode: 'off' });

    const semConferir = loadConfig({ DATABASE_URL: 'postgres://u@db.exemplo.com/x', DATABASE_SSL: 'no-verify' });
    assert.deepEqual(semConferir.database?.ssl, { mode: 'no-verify' });
  });

  test('schema invalido e recusado antes de virar SQL', () => {
    assert.throws(
      () => loadConfig({ DATABASE_URL: 'postgres://u@h.exemplo.com/x', DATABASE_SCHEMA: 'rede"; drop' }),
      /DATABASE_SCHEMA invalido/,
    );
  });
});
