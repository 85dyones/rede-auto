import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { buildApplication, type Application } from '../bootstrap.ts';
import { loadConfig } from '../config.ts';
import { FakeClock, HOUR, DAY } from '../domain/shared/clock.ts';
import { sequentialIdGenerator } from '../domain/shared/ids.ts';

/**
 * Teste de integracao da API: sobe o servidor de verdade, com relogio
 * controlado, e percorre o ciclo completo de um repasse — do catalogo ao
 * ATPV-e — pelas mesmas rotas que o cliente usaria.
 *
 * O relogio falso e o que torna isso possivel: a trava de 4h e o SLA de recall
 * sao exercitados de ponta a ponta em milissegundos.
 */

const clock = new FakeClock(Date.parse('2026-08-24T13:00:00Z')); // segunda, 10:00 em SP
let app: Application;
let baseUrl: string;

const PRIME = 'demo_prime_titular';
const PRIME_VENDEDOR = 'demo_prime_vendedor';
const VELOZ = 'demo_veloz_titular';
const VELOZ_VENDEDOR = 'demo_veloz_vendedor';
const CENTRAL = 'demo_central_vendedor';

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: { key?: string; body?: unknown; xml?: string } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (options.key !== undefined) headers['authorization'] = `Bearer ${options.key}`;

  let payload: string | undefined;
  if (options.xml !== undefined) {
    headers['content-type'] = 'text/xml';
    payload = options.xml;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
    redirect: 'manual',
  });

  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') && text.length > 0 ? JSON.parse(text) : text;
  return { status: response.status, body: body as T };
}

/** Vistoria minima valida, com as cinco fotos obrigatorias. */
const vistoria = (odometro: number, combustivel = 4) => ({
  odometerKm: odometro,
  fuelEighths: combustivel,
  photos: ['FRONT', 'REAR', 'LEFT', 'RIGHT', 'ODOMETER'].map((angle) => ({
    angle,
    url: `https://cdn.exemplo.com/${angle.toLowerCase()}.jpg`,
  })),
  damages: [],
});

const responsavel = { nome: 'Roberto Conferente', cpf: '529.982.247-25', funcao: 'Gerente de patio' };

before(async () => {
  app = await buildApplication({
    config: { ...loadConfig(), port: 0, seedDemoData: true, publicBaseUrl: '' },
    clock,
    ids: sequentialIdGenerator(),
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await app.stop();
});

describe('autenticacao e descoberta', () => {
  test('health e o indice de rotas sao publicos', async () => {
    assert.equal((await api('GET', '/health')).status, 200);
    assert.equal((await api('GET', '/api/v1')).status, 200);
  });

  test('rota de negocio sem chave devolve 401', async () => {
    const response = await api<{ erro: { codigo: string } }>('GET', '/api/v1/veiculos');
    assert.equal(response.status, 401);
    assert.equal(response.body.erro.codigo, 'AUTHENTICATION_REQUIRED');
  });

  test('chave invalida nao autentica', async () => {
    assert.equal((await api('GET', '/api/v1/veiculos', { key: 'chave-inventada' })).status, 401);
  });

  test('metodo errado no caminho certo devolve 405 com Allow', async () => {
    const response = await fetch(`${baseUrl}/health`, { method: 'DELETE' });
    assert.equal(response.status, 405);
    assert.match(response.headers.get('allow') ?? '', /GET/);
  });

  test('rota inexistente devolve 404 com requestId para suporte', async () => {
    const response = await api<{ requestId: string }>('GET', '/api/v1/inexistente', { key: PRIME });
    assert.equal(response.status, 404);
    assert.ok(response.body.requestId.length > 0);
  });
});

describe('ciclo completo de um repasse', () => {
  let vehicleId: string;
  let lockId: string;
  let dealId: string;

  test('a Loja B enxerga o estoque da Loja A com o preco liquido de repasse', async () => {
    const response = await api<{
      total: number;
      veiculos: Array<{ id: string; precos: { liquidoRepasse: { formatado: string } }; vocePode: { travar: boolean } }>;
    }>('GET', '/api/v1/veiculos?marca=Chevrolet', { key: VELOZ_VENDEDOR });

    assert.equal(response.status, 200);
    assert.equal(response.body.total, 1);

    const vehicle = response.body.veiculos[0];
    assert.ok(vehicle);
    vehicleId = vehicle.id;
    assert.equal(vehicle.precos.liquidoRepasse.formatado, 'R$ 85.000,00');
    assert.equal(vehicle.vocePode.travar, true);
  });

  test('a Loja B abre a trava de 4 horas', async () => {
    const response = await api<{
      trava: { id: string; restante: string; precoLiquidoTravado: { centavos: number } };
    }>('POST', `/api/v1/veiculos/${vehicleId}/trava`, {
      key: VELOZ_VENDEDOR,
      body: { referenciaAtendimento: 'ATD-4471' },
    });

    assert.equal(response.status, 201);
    lockId = response.body.trava.id;
    assert.equal(response.body.trava.restante, '4h');
    assert.equal(response.body.trava.precoLiquidoTravado.centavos, 8_500_000);
  });

  test('outra loja nao consegue travar o mesmo veiculo', async () => {
    const response = await api<{ erro: { codigo: string } }>(
      'POST',
      `/api/v1/veiculos/${vehicleId}/trava`,
      { key: CENTRAL },
    );
    assert.equal(response.status, 409);
    assert.equal(response.body.erro.codigo, 'VEHICLE_ALREADY_LOCKED');
  });

  test('a Loja A reprecifica e o novo liquido fica represado ate a trava cair', async () => {
    const response = await api<{
      precos: { liquidoRepasse: { centavos: number }; liquidoRepresado: { centavos: number } };
    }>('PATCH', `/api/v1/veiculos/${vehicleId}/precos`, {
      key: PRIME,
      body: { precoLiquidoRepasse: { centavos: 8_900_000 } },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.precos.liquidoRepasse.centavos, 8_500_000, 'o vigente nao muda');
    assert.equal(response.body.precos.liquidoRepresado.centavos, 8_900_000);
  });

  test('a proposta bancaria estende a trava em 4 horas', async () => {
    clock.advance(3 * HOUR);
    const response = await api<{ trava: { expiraEm: string; extensoes: unknown[] } }>(
      'POST',
      `/api/v1/travas/${lockId}/extensoes`,
      { key: VELOZ_VENDEDOR, body: { evidencia: 'BANK_PROPOSAL_SUBMITTED', referencia: 'PROP-8812' } },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.trava.extensoes.length, 1);
    assert.equal(Date.parse(response.body.trava.expiraEm) - Date.parse('2026-08-24T13:00:00Z'), 8 * HOUR);
  });

  test('evidencia forte sem anexo e recusada com motivo', async () => {
    const response = await api<{ erro: { codigo: string } }>(
      'POST',
      `/api/v1/travas/${lockId}/extensoes`,
      { key: VELOZ_VENDEDOR, body: { evidencia: 'DEPOSIT_RECEIPT' } },
    );
    assert.equal(response.status, 422);
    assert.equal(response.body.erro.codigo, 'EVIDENCE_ATTACHMENT_REQUIRED');
  });

  test('a Loja B monta a negociacao sobre o preco que travou', async () => {
    const response = await api<{ id: string; financeiro: Record<string, { formatado: string }> }>(
      'POST',
      `/api/v1/veiculos/${vehicleId}/negociacao`,
      {
        key: VELOZ_VENDEDOR,
        body: {
          precoAoConsumidor: { centavos: 9_490_000 },
          troca: {
            veiculo: { placa: 'DEF4G56', marca: 'Fiat', modelo: 'Argo', anoModelo: 2019, km: 71_000 },
            valorDadoAoCliente: { centavos: 4_200_000 },
            avaliacao: { centavos: 4_600_000 },
            destino: 'SELLER_STOCK',
          },
        },
      },
    );

    assert.equal(response.status, 201);
    dealId = response.body.id;

    // Liquido de 85.000 (o travado), venda a 94.900: margem integral da Loja B.
    assert.equal(response.body.financeiro['liquidoDaLojaProprietaria']?.formatado, 'R$ 85.000,00');
    assert.equal(response.body.financeiro['margemDaVendedora']?.formatado, 'R$ 9.900,00');
    assert.equal(response.body.financeiro['dinheiroDevidoAProprietaria']?.formatado, 'R$ 85.000,00');
    assert.equal(response.body.financeiro['resultadoTotalDaVendedora']?.formatado, 'R$ 13.900,00');
  });

  test('a Loja A nao fecha a venda no lugar da Loja B', async () => {
    const response = await api<{ erro: { codigo: string } }>(
      'POST',
      `/api/v1/negociacoes/${dealId}/confirmacao`,
      { key: PRIME },
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.erro.codigo, 'NOT_SELLING_STORE');
  });

  test('a Loja B confirma a venda e o veiculo sai do estoque da rede', async () => {
    const confirm = await api<{ situacao: string }>(
      'POST',
      `/api/v1/negociacoes/${dealId}/confirmacao`,
      { key: VELOZ_VENDEDOR },
    );
    assert.equal(confirm.status, 200);
    assert.equal(confirm.body.situacao, 'CONFIRMED');

    const catalog = await api<{ total: number }>('GET', '/api/v1/veiculos?marca=Chevrolet', { key: CENTRAL });
    assert.equal(catalog.body.total, 0, 'o carro nao aparece mais para a rede');
  });

  test('a liquidacao acontece em duas parcelas e fecha o valor devido', async () => {
    const entrada = await api<{ situacao: string; financeiro: Record<string, { formatado: string }> }>(
      'POST',
      `/api/v1/negociacoes/${dealId}/liquidacoes`,
      { key: VELOZ_VENDEDOR, body: { valor: { centavos: 2_000_000 }, meio: 'PIX', comprovante: 'E2E-99112233' } },
    );
    assert.equal(entrada.status, 201);
    assert.equal(entrada.body.situacao, 'CONFIRMED');
    assert.equal(entrada.body.financeiro['saldoAberto']?.formatado, 'R$ 65.000,00');

    const banco = await api<{ situacao: string; financeiro: Record<string, { formatado: string }> }>(
      'POST',
      `/api/v1/negociacoes/${dealId}/liquidacoes`,
      {
        key: VELOZ_VENDEDOR,
        body: { valor: { centavos: 6_500_000 }, meio: 'BANK_FINANCING', comprovante: 'CONTRATO-77123' },
      },
    );
    assert.equal(banco.body.situacao, 'SETTLED');
    assert.equal(banco.body.financeiro['saldoAberto']?.formatado, 'R$ 0,00');
  });

  test('o ATPV-e e emitido pela loja proprietaria, e so por ela', async () => {
    const pelaVendedora = await api<{ erro: { codigo: string } }>(
      'POST',
      `/api/v1/negociacoes/${dealId}/atpv`,
      {
        key: VELOZ,
        body: { numero: 'ATPV-2026-889231', compradorNome: 'Ana Paula Ribeiro', compradorDocumento: '529.982.247-25' },
      },
    );
    assert.equal(pelaVendedora.status, 403);

    const pelaProprietaria = await api<{ atpv: { numero: string } }>(
      'POST',
      `/api/v1/negociacoes/${dealId}/atpv`,
      {
        key: PRIME,
        body: { numero: 'ATPV-2026-889231', compradorNome: 'Ana Paula Ribeiro', compradorDocumento: '529.982.247-25' },
      },
    );
    assert.equal(pelaProprietaria.status, 200);
    assert.equal(pelaProprietaria.body.atpv.numero, 'ATPV-2026-889231');
  });

  test('a entrega ao comprador conclui a negociacao', async () => {
    const response = await api<{ situacao: string }>(
      'POST',
      `/api/v1/negociacoes/${dealId}/entrega`,
      { key: VELOZ_VENDEDOR },
    );
    assert.equal(response.body.situacao, 'COMPLETED');
  });

  test('a auditoria registrou toda a trajetoria do veiculo', async () => {
    const response = await api<{ eventos: Array<{ tipo: string }> }>(
      'GET',
      `/api/v1/auditoria?agregadoId=${vehicleId}`,
      { key: PRIME },
    );
    const tipos = response.body.eventos.map((evento) => evento.tipo);
    assert.ok(tipos.includes('lock.opened'));
    assert.ok(tipos.includes('lock.extended'));
    assert.ok(tipos.includes('vehicle.net_price_deferred'));
    assert.ok(tipos.includes('lock.converted'));
  });
});

describe('estoque avancado, expiracao e recall', () => {
  let vehicleId: string;
  let transferId: string;

  test('a Loja A envia o Jeep para o patio da Loja B', async () => {
    const catalog = await api<{ veiculos: Array<{ id: string }> }>('GET', '/api/v1/veiculos?marca=Jeep', {
      key: PRIME,
    });
    vehicleId = catalog.body.veiculos[0]?.id as string;

    const saida = await api<{ termo: { id: string } }>(
      'POST',
      `/api/v1/veiculos/${vehicleId}/custodia/saidas`,
      {
        key: PRIME,
        body: {
          lojaDestinoId: 'str_veloz',
          finalidade: 'EXTENDED_STOCK',
          vistoria: vistoria(29_450, 6),
          responsavel,
        },
      },
    );
    assert.equal(saida.status, 201);
    transferId = saida.body.termo.id;
  });

  test('em transito, a responsabilidade civil ainda e da loja de origem', async () => {
    const response = await api<{ fisico: { situacao: string; lojaCustodianteId: string } }>(
      'GET',
      `/api/v1/veiculos/${vehicleId}`,
      { key: PRIME },
    );
    assert.equal(response.body.fisico.situacao, 'IN_TRANSIT');
    assert.equal(response.body.fisico.lojaCustodianteId, 'str_prime');
  });

  test('a entrada assinada pela Loja B transfere a responsabilidade', async () => {
    clock.advance(2 * HOUR);
    const entrada = await api<{ termo: { situacao: string; divergencias: unknown[] } }>(
      'POST',
      `/api/v1/custodia/termos/${transferId}/entrada`,
      { key: VELOZ, body: { vistoria: vistoria(29_490, 6), responsavel } },
    );
    assert.equal(entrada.status, 200);
    assert.equal(entrada.body.termo.situacao, 'COMPLETED');
    assert.deepEqual(entrada.body.termo.divergencias, [], '40 km entre patios esta na tolerancia');

    const vehicle = await api<{ fisico: { lojaCustodianteId: string }; comercial: { situacao: string } }>(
      'GET',
      `/api/v1/veiculos/${vehicleId}`,
      { key: PRIME },
    );
    assert.equal(vehicle.body.fisico.lojaCustodianteId, 'str_veloz');
    assert.equal(
      vehicle.body.comercial.situacao,
      'AVAILABLE',
      'estar no patio de outra loja nao tira o carro do catalogo da rede',
    );
  });

  test('a trava expira e o carro volta a rede SEM sair do patio da Loja B', async () => {
    await api('POST', `/api/v1/veiculos/${vehicleId}/trava`, { key: VELOZ_VENDEDOR });

    clock.advance(5 * HOUR);
    const varredura = await api<{ travasExpiradas: number }>('POST', '/api/v1/manutencao/varredura', {
      key: PRIME,
    });
    assert.equal(varredura.body.travasExpiradas, 1);

    const vehicle = await api<{
      comercial: { situacao: string };
      fisico: { lojaCustodianteId: string };
      estoqueAvancado: boolean;
    }>('GET', `/api/v1/veiculos/${vehicleId}`, { key: CENTRAL });

    assert.equal(vehicle.body.comercial.situacao, 'AVAILABLE');
    assert.equal(vehicle.body.fisico.lojaCustodianteId, 'str_veloz');
    assert.equal(vehicle.body.estoqueAvancado, true);
  });

  test('depois de expirar, qualquer loja pode travar — inclusive a que perdeu o prazo', async () => {
    const response = await api<{ trava: { id: string } }>(
      'POST',
      `/api/v1/veiculos/${vehicleId}/trava`,
      { key: VELOZ_VENDEDOR },
    );
    assert.equal(response.status, 201, 'nao ha carencia: o carro no patio dela e oportunidade de balcao');
    await api('DELETE', `/api/v1/travas/${response.body.trava.id}`, {
      key: VELOZ_VENDEDOR,
      body: { motivo: 'liberado para o teste seguinte' },
    });
  });

  test('com o carro disponivel, o recall da Loja A tem prazo imediato', async () => {
    const response = await api<{ recall: { situacao: string; prazoFinal: string | null } }>(
      'POST',
      `/api/v1/veiculos/${vehicleId}/recall`,
      { key: PRIME, body: { motivo: 'OWN_SALE' } },
    );
    assert.equal(response.status, 201);
    assert.equal(response.body.recall.situacao, 'DUE');
    assert.notEqual(response.body.recall.prazoFinal, null, 'o SLA ja esta correndo');
  });

  test('o painel mostra a pendencia dos dois lados', async () => {
    const daLojaB = await api<{ devoDevolver: unknown[] }>('GET', '/api/v1/recalls', { key: VELOZ });
    assert.equal(daLojaB.body.devoDevolver.length, 1);

    const daLojaA = await api<{ estouEsperando: unknown[] }>('GET', '/api/v1/recalls', { key: PRIME });
    assert.equal(daLojaA.body.estouEsperando.length, 1);
  });

  test('a devolucao assinada cumpre o recall automaticamente', async () => {
    const saida = await api<{ termo: { id: string; finalidade: string } }>(
      'POST',
      `/api/v1/veiculos/${vehicleId}/custodia/saidas`,
      {
        key: VELOZ,
        body: {
          lojaDestinoId: 'str_prime',
          finalidade: 'OTHER',
          vistoria: vistoria(29_600, 5),
          responsavel,
        },
      },
    );
    assert.equal(saida.body.termo.finalidade, 'RECALL_RETURN', 'o termo ja nasce vinculado ao recall');

    const entrada = await api<{ recallCumprido: { situacao: string } | null }>(
      'POST',
      `/api/v1/custodia/termos/${saida.body.termo.id}/entrada`,
      { key: PRIME, body: { vistoria: vistoria(29_640, 5), responsavel } },
    );
    assert.equal(entrada.body.recallCumprido?.situacao, 'FULFILLED');
  });

  test('o livro de custodia responde quem respondia pelo carro em cada data', async () => {
    const durante = new Date(Date.parse('2026-08-24T13:00:00Z') + 8 * HOUR).toISOString();
    const response = await api<{ resolvido: boolean; lojaResponsavelId: string }>(
      'GET',
      `/api/v1/veiculos/${vehicleId}/custodia/responsavel?em=${encodeURIComponent(durante)}`,
      { key: PRIME },
    );
    assert.equal(response.body.resolvido, true);
    assert.equal(response.body.lojaResponsavelId, 'str_veloz');
  });
});

describe('recall represado por trava ativa', () => {
  let vehicleId: string;

  test('a Loja B trava o T-Cross que esta no patio dela', async () => {
    const catalog = await api<{ veiculos: Array<{ id: string }> }>(
      'GET',
      '/api/v1/veiculos?marca=Volkswagen',
      { key: VELOZ_VENDEDOR },
    );
    vehicleId = catalog.body.veiculos[0]?.id as string;

    const saida = await api<{ termo: { id: string } }>(
      'POST',
      `/api/v1/veiculos/${vehicleId}/custodia/saidas`,
      {
        key: 'demo_norte_titular',
        body: {
          lojaDestinoId: 'str_veloz',
          finalidade: 'EXTENDED_STOCK',
          vistoria: vistoria(44_900),
          responsavel,
        },
      },
    );
    await api('POST', `/api/v1/custodia/termos/${saida.body.termo.id}/entrada`, {
      key: VELOZ,
      body: { vistoria: vistoria(44_930), responsavel },
    });

    const trava = await api('POST', `/api/v1/veiculos/${vehicleId}/trava`, { key: VELOZ_VENDEDOR });
    assert.equal(trava.status, 201);
  });

  test('o recall e aceito mas fica aguardando: a Loja B tem exclusividade', async () => {
    const response = await api<{
      recall: { situacao: string; prazoFinal: string | null; travaBloqueadoraId: string | null };
    }>('POST', `/api/v1/veiculos/${vehicleId}/recall`, {
      key: 'demo_norte_titular',
      body: { motivo: 'OWN_SALE' },
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.recall.situacao, 'WAITING_LOCK_RELEASE');
    assert.equal(response.body.recall.prazoFinal, null, 'o prazo nao corre enquanto a trava vale');
    assert.notEqual(response.body.recall.travaBloqueadoraId, null);
  });

  test('quando a trava cai, o prazo comeca a correr dali', async () => {
    clock.advance(5 * HOUR);
    await api('POST', '/api/v1/manutencao/varredura', { key: PRIME });

    const board = await api<{ devoDevolver: Array<{ situacao: string; prazoFinal: string }> }>(
      'GET',
      '/api/v1/recalls',
      { key: VELOZ },
    );
    const recall = board.body.devoDevolver.find((item) => item.situacao === 'DUE');
    assert.ok(recall, 'o recall represado virou prazo');
    assert.ok(Date.parse(recall.prazoFinal) > clock.now(), 'o prazo comeca agora, nao retroage');
  });
});

describe('lamina white-label', () => {
  let token: string;

  test('a Loja B gera o link com o proprio preco', async () => {
    const catalog = await api<{ veiculos: Array<{ id: string }> }>('GET', '/api/v1/veiculos?marca=Toyota', {
      key: VELOZ_VENDEDOR,
    });
    const vehicleId = catalog.body.veiculos[0]?.id as string;

    const response = await api<{ url: string; precoExibido: { formatado: string } }>(
      'POST',
      `/api/v1/veiculos/${vehicleId}/compartilhamentos`,
      { key: VELOZ_VENDEDOR, body: { precoExibido: { centavos: 14_490_000 }, validadeHoras: 48 } },
    );
    assert.equal(response.status, 201);
    assert.equal(response.body.precoExibido.formatado, 'R$ 144.900,00');
    token = response.body.url.split('/s/')[1] as string;
  });

  test('a lamina publica abre sem autenticacao', async () => {
    const response = await api<{
      titulo: string;
      apresentadoPor: { nomeFantasia: string };
      preco: { formatado: string };
    }>('GET', `/s/${token}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.titulo, 'Toyota Corolla 2.0 XEi 2022');
    assert.equal(response.body.apresentadoPor.nomeFantasia, 'Veloz Seminovos');
    assert.equal(response.body.preco.formatado, 'R$ 144.900,00');
  });

  test('a lamina nao vaza a loja proprietaria, o liquido, o chassi nem a placa', async () => {
    const response = await api<string>('GET', `/s/${token}/lamina.html`);
    const html = String(response.body).toLowerCase();

    for (const proibido of [
      'garagem central',
      '34028316000103',
      '93ybb05654j019381',
      'pqr2c58',
      '128.000',
      '12800000',
    ]) {
      assert.equal(html.includes(proibido), false, `vazou na lamina: ${proibido}`);
    }
    assert.ok(html.includes('veloz seminovos'));
    assert.ok(html.includes('noindex'));
  });

  test('a lamina em PDF e um PDF valido e igualmente limpa', async () => {
    const response = await fetch(`${baseUrl}/s/${token}/lamina.pdf`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');

    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString('latin1'), '%PDF-1.7');
    const text = bytes.toString('latin1').toLowerCase();
    assert.equal(text.includes('garagem central'), false);
    assert.ok(text.includes('veloz seminovos'));
  });

  test('as fotos passam pelo proxy da plataforma', async () => {
    const sheet = await api<{ fotos: string[] }>('GET', `/s/${token}`);
    assert.ok(sheet.body.fotos[0]?.startsWith(`/s/${token}/fotos/`));

    const photo = await fetch(`${baseUrl}/s/${token}/fotos/0`, { redirect: 'manual' });
    assert.equal(photo.status, 302);
    assert.match(photo.headers.get('location') ?? '', /^https:\/\/cdn\.central\.com\.br\//);
  });

  test('link expirado devolve mensagem util ao cliente final', async () => {
    clock.advance(3 * DAY);
    const response = await api<{ erro: { mensagem: string } }>('GET', `/s/${token}`);
    assert.equal(response.status, 409);
    assert.match(response.body.erro.mensagem, /expirou/);
  });
});

describe('credenciamento pelos fundadores', () => {
  let applicationId: string;

  const candidata = {
    legalName: 'Nova Garagem Veiculos LTDA',
    tradeName: 'Nova Garagem',
    cnpj: '07.526.557/0001-00',
    city: 'Sorocaba',
    state: 'SP',
    phone: '(15) 99876-5432',
    email: 'contato@novagaragem.com.br',
    responsibleName: 'Joao Pereira',
  };

  test('uma fundadora apresenta a candidata', async () => {
    const response = await api<{ id: string; situacao: string; apuracao: { faltamAvais: number } }>(
      'POST',
      '/api/v1/credenciamentos',
      { key: PRIME, body: { candidata } },
    );
    assert.equal(response.status, 201);
    applicationId = response.body.id;
    assert.equal(response.body.situacao, 'PENDING');
    assert.equal(response.body.apuracao.faltamAvais, 3);
  });

  test('a padrinho nao vota na propria indicacao', async () => {
    const response = await api<{ erro: { codigo: string } }>(
      'POST',
      `/api/v1/credenciamentos/${applicationId}/votos`,
      { key: PRIME, body: { decisao: 'APPROVE' } },
    );
    assert.equal(response.status, 422);
    assert.equal(response.body.erro.codigo, 'SPONSOR_CANNOT_VOTE');
  });

  test('vendedor nao vota — o aval e do titular', async () => {
    const response = await api('POST', `/api/v1/credenciamentos/${applicationId}/votos`, {
      key: PRIME_VENDEDOR,
      body: { decisao: 'APPROVE' },
    });
    assert.equal(response.status, 403);
  });

  test('dois avais ainda nao credenciam', async () => {
    for (const key of [VELOZ, 'demo_central_titular']) {
      const response = await api<{ situacao: string }>(
        'POST',
        `/api/v1/credenciamentos/${applicationId}/votos`,
        { key, body: { decisao: 'APPROVE' } },
      );
      assert.equal(response.body.situacao, 'PENDING');
    }
  });

  test('o terceiro aval aprova e a loja ja entra na rede operando', async () => {
    const response = await api<{ situacao: string; lojaCredenciada: { id: string; tipo: string } }>(
      'POST',
      `/api/v1/credenciamentos/${applicationId}/votos`,
      { key: 'demo_norte_titular', body: { decisao: 'APPROVE' } },
    );
    assert.equal(response.body.situacao, 'APPROVED');
    assert.equal(response.body.lojaCredenciada.tipo, 'MEMBER', 'quem entra depois nao vira fundador');

    const stores = await api<{ total: number }>('GET', '/api/v1/lojas', { key: PRIME });
    assert.equal(stores.body.total, 7);
  });
});

describe('sincronizacao de feed', () => {
  const feed = (id: string, chassi: string, repasse: string) => `<?xml version="1.0" encoding="UTF-8"?>
<estoque>
  <veiculo>
    <id>${id}</id><placa>MNO3P44</placa><chassi>${chassi}</chassi>
    <marca>Hyundai</marca><modelo>HB20</modelo><versao>1.0 Comfort</versao>
    <anofabricacao>2022</anofabricacao><anomodelo>2023</anomodelo>
    <km>31200</km><cor>Branco</cor><combustivel>Flex</combustivel><cambio>Manual</cambio>
    <preco>78.900,00</preco><preco_repasse>${repasse}</preco_repasse>
    <fotos><foto>https://cdn.sul.com.br/hb20-1.jpg</foto></fotos>
    <laudo_cautelar><situacao>APROVADO</situacao><numero>LC-1</numero><empresa>Cautelar Brasil</empresa><data>20/08/2026</data></laudo_cautelar>
  </veiculo>
</estoque>`;

  test('o XML entra e o veiculo aparece no catalogo da rede', async () => {
    const response = await api<{ integrador: string; resumo: { criados: number } }>(
      'POST',
      '/api/v1/feeds/sincronizacao',
      { key: 'demo_sul_titular', xml: feed('SUL-1', '9BHBG51CAKP123456', '72.000,00') },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.integrador, 'revendamais');
    assert.equal(response.body.resumo.criados, 1);

    const catalog = await api<{ total: number }>('GET', '/api/v1/veiculos?marca=Hyundai', { key: PRIME });
    assert.equal(catalog.body.total, 1);
  });

  test('rodar o mesmo feed de novo nao escreve nada', async () => {
    const response = await api<{ resumo: { criados: number; atualizados: number; semMudanca: number } }>(
      'POST',
      '/api/v1/feeds/sincronizacao',
      { key: 'demo_sul_titular', xml: feed('SUL-1', '9BHBG51CAKP123456', '72.000,00') },
    );
    assert.equal(response.body.resumo.criados, 0);
    assert.equal(response.body.resumo.atualizados, 0);
    assert.equal(response.body.resumo.semMudanca, 1);
  });

  test('outra loja anunciando o mesmo chassi e recusada', async () => {
    const response = await api<{ resumo: { criados: number }; recusados: Array<{ codigo: string }> }>(
      'POST',
      '/api/v1/feeds/sincronizacao',
      { key: 'demo_vialivre_titular', xml: feed('VL-9', '9BHBG51CAKP123456', '71.000,00') },
    );
    assert.equal(response.body.resumo.criados, 0);
    assert.equal(response.body.recusados[0]?.codigo, 'DUPLICATE_VIN_IN_NETWORK');
  });

  test('XML com DOCTYPE e rejeitado', async () => {
    const response = await api<{ erro: { codigo: string } }>('POST', '/api/v1/feeds/sincronizacao', {
      key: 'demo_sul_titular',
      xml: `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><estoque><veiculo>&xxe;</veiculo></estoque>`,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.erro.codigo, 'XML_DOCTYPE_REJECTED');
  });
});
