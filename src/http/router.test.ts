import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Router } from './router.ts';

const handler = (label: string) => async () => ({ status: 200, body: { label } });

async function labelOf(router: Router, method: string, path: string): Promise<string | null> {
  const match = router.match(method, path);
  if (match === null) return null;
  const response = await match.handler({
    method: 'GET',
    path,
    params: match.params,
    query: new URLSearchParams(),
    headers: {},
    body: undefined,
    rawBody: Buffer.alloc(0),
    actor: null,
    requestId: 'teste',
  });
  return (response.body as { label: string }).label;
}

describe('casamento de rotas', () => {
  test('extrai parametros de caminho', () => {
    const router = new Router().get('/api/veiculos/:id/travas/:lockId', handler('x'));
    const match = router.match('GET', '/api/veiculos/veh_1/travas/lck_9');
    assert.deepEqual(match?.params, { id: 'veh_1', lockId: 'lck_9' });
  });

  test('decodifica parametro percent-encoded', () => {
    const router = new Router().get('/s/:token', handler('x'));
    assert.equal(router.match('GET', '/s/a%2Fb')?.params['token'], 'a/b');
  });

  test('rota literal vence a parametrizada mesmo registrada DEPOIS', async () => {
    // Sem isso, inserir uma rota literal abaixo da parametrizada produziria um
    // 404 estranho em producao, e nada acusaria em tempo de compilacao.
    const router = new Router()
      .get('/api/veiculos/:id', handler('por-id'))
      .get('/api/veiculos/meus', handler('meus'));

    assert.equal(await labelOf(router, 'GET', '/api/veiculos/meus'), 'meus');
    assert.equal(await labelOf(router, 'GET', '/api/veiculos/veh_1'), 'por-id');
  });

  test('prefixo literal mais longo vence', async () => {
    const router = new Router()
      .get('/s/:token/:recurso', handler('generico'))
      .get('/s/:token/lamina.pdf', handler('pdf'));

    assert.equal(await labelOf(router, 'GET', '/s/abc/lamina.pdf'), 'pdf');
    assert.equal(await labelOf(router, 'GET', '/s/abc/outra'), 'generico');
  });

  test('metodo diferente nao casa', () => {
    const router = new Router().get('/recurso', handler('x'));
    assert.equal(router.match('POST', '/recurso'), null);
  });

  test('numero de segmentos precisa bater', () => {
    const router = new Router().get('/a/:b', handler('x'));
    assert.equal(router.match('GET', '/a'), null);
    assert.equal(router.match('GET', '/a/b/c'), null);
  });

  test('barras extras e finais nao alteram o casamento', () => {
    const router = new Router().get('/api/veiculos', handler('x'));
    assert.notEqual(router.match('GET', '/api/veiculos/'), null);
    assert.notEqual(router.match('GET', '//api//veiculos'), null);
  });

  test('allowedMethods alimenta o 405 com o cabecalho Allow', () => {
    const router = new Router()
      .get('/api/veiculos/:id', handler('x'))
      .delete('/api/veiculos/:id', handler('x'))
      .post('/api/veiculos', handler('x'));

    assert.deepEqual(router.allowedMethods('/api/veiculos/veh_1').sort(), ['DELETE', 'GET']);
    assert.deepEqual(router.allowedMethods('/api/veiculos'), ['POST']);
    assert.deepEqual(router.allowedMethods('/inexistente'), []);
  });

  test('marca rotas publicas', () => {
    const router = new Router()
      .get('/s/:token', handler('x'), { public: true })
      .get('/api/privada', handler('x'));

    assert.equal(router.match('GET', '/s/abc')?.isPublic, true);
    assert.equal(router.match('GET', '/api/privada')?.isPublic, false);
  });
});
