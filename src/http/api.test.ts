import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { buildApplication, type Application } from '../bootstrap.ts';
import { loadConfig } from '../config.ts';
import { FakeClock, HOUR } from '../domain/shared/clock.ts';
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
    const response = await api<{
      id: string;
      financeiro: Record<string, { formatado: string }> & {
        meusNumeros: Record<string, { formatado: string } | null>;
      };
    }>(
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
    assert.equal(response.body.financeiro['dinheiroDevidoAProprietaria']?.formatado, 'R$ 85.000,00');
    // Os numeros da vendedora vivem num bloco proprio, que a dona nao recebe.
    assert.equal(response.body.financeiro.meusNumeros['minhaMargem']?.formatado, 'R$ 9.900,00');
    assert.equal(response.body.financeiro.meusNumeros['resultadoTotal']?.formatado, 'R$ 13.900,00');
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

  test('para entregar, a Loja B busca o carro no patio da Loja A', async () => {
    // O Onix nunca saiu do patio da Prime. Quem atendeu o cliente e quem
    // entrega, entao o carro precisa chegar ate a Loja B primeiro.
    const saida = await api<{ termo: { id: string } }>(
      'POST',
      `/api/v1/veiculos/${vehicleId}/custodia/saidas`,
      {
        key: PRIME,
        body: {
          lojaDestinoId: 'str_veloz',
          finalidade: 'SALE_HANDOVER',
          vistoria: vistoria(38_400, 6),
          responsavel,
        },
      },
    );
    assert.equal(saida.status, 201);

    const entrada = await api('POST', `/api/v1/custodia/termos/${saida.body.termo.id}/entrada`, {
      key: VELOZ,
      body: { vistoria: vistoria(38_437, 6), responsavel },
    });
    assert.equal(entrada.status, 200);
  });

  test('outra finalidade de movimentacao e bloqueada para veiculo vendido', async () => {
    const response = await api<{ erro: { codigo: string } }>(
      'POST',
      `/api/v1/veiculos/${vehicleId}/custodia/saidas`,
      {
        key: VELOZ,
        body: {
          lojaDestinoId: 'str_central',
          finalidade: 'EXTENDED_STOCK',
          vistoria: vistoria(38_437, 6),
          responsavel,
        },
      },
    );
    assert.equal(response.status, 409);
    assert.equal(response.body.erro.codigo, 'VEHICLE_SOLD');
  });

  test('a entrega ao comprador encerra o eixo fisico e conclui a negociacao', async () => {
    const response = await api<{
      entregue: boolean;
      negociacao: { situacao: string } | null;
    }>('POST', `/api/v1/veiculos/${vehicleId}/entrega`, {
      key: VELOZ,
      body: { vistoria: vistoria(38_440, 5), responsavel },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.entregue, true);
    // A entrega fisica e a entrega da negociacao sao o mesmo fato.
    assert.equal(response.body.negociacao?.situacao, 'COMPLETED');

    const vehicle = await api<{ fisico: { situacao: string } }>(
      'GET',
      `/api/v1/veiculos/${vehicleId}`,
      { key: PRIME },
    );
    assert.equal(vehicle.body.fisico.situacao, 'DELIVERED_TO_CONSUMER');
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

describe('escape operacional do recall', () => {
  let vehicleId: string;
  let recallId: string;

  test('a Loja A chama o Corolla de volta com prazo de entrega', async () => {
    const catalog = await api<{ veiculos: Array<{ id: string }> }>('GET', '/api/v1/veiculos?marca=Toyota', {
      key: CENTRAL,
    });
    vehicleId = catalog.body.veiculos[0]?.id as string;

    const saida = await api<{ termo: { id: string } }>(
      'POST',
      `/api/v1/veiculos/${vehicleId}/custodia/saidas`,
      {
        key: 'demo_central_titular',
        body: {
          lojaDestinoId: 'str_veloz',
          finalidade: 'EXTENDED_STOCK',
          vistoria: vistoria(61_800),
          responsavel,
        },
      },
    );
    await api('POST', `/api/v1/custodia/termos/${saida.body.termo.id}/entrada`, {
      key: VELOZ,
      body: { vistoria: vistoria(61_830), responsavel },
    });

    const recall = await api<{ recall: { id: string; quemLeva: string; prazoFinal: string } }>(
      'POST',
      `/api/v1/veiculos/${vehicleId}/recall`,
      { key: 'demo_central_titular', body: { motivo: 'OWN_SALE' } },
    );
    assert.equal(recall.status, 201);
    recallId = recall.body.recall.id;
    assert.equal(recall.body.recall.quemLeva, 'CUSTODIAN_DELIVERS');
  });

  test('a Loja B nao tem como levar e declara o carro disponivel', async () => {
    // O escape: em vez de queimar as 4 horas sem motorista, ela avisa que o
    // carro esta pronto e a obrigacao dela termina ali.
    const response = await api<{
      recall: { situacao: string; minutosUteisPausados: number; quemLeva: string };
    }>('POST', `/api/v1/recalls/${recallId}/disponivel`, {
      key: VELOZ,
      body: { observacao: 'Sem motorista hoje, carro na frente com a chave na recepcao' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.recall.situacao, 'READY_FOR_PICKUP');
    assert.equal(response.body.recall.quemLeva, 'REQUESTER_COLLECTS');
    assert.ok(response.body.recall.minutosUteisPausados > 0, 'o relogio parou com tempo de sobra');
  });

  test('a Loja A e avisada de que pode buscar', async () => {
    const avisos = await api<{ avisos: Array<{ tipo: string; urgencia: string }> }>(
      'GET',
      '/api/v1/notificacoes',
      { key: 'demo_central_titular' },
    );
    const aviso = avisos.body.avisos.find((a) => a.tipo === 'recall.ready_for_pickup');
    assert.ok(aviso, 'quem vai buscar precisa saber');
    assert.equal(aviso.urgencia, 'ACTION_REQUIRED');
  });

  test('com o relogio parado, a varredura nao acusa descumprimento', async () => {
    clock.advance(30 * HOUR);
    const varredura = await api<{ recallsDescumpridos: number }>(
      'POST',
      '/api/v1/manutencao/varredura',
      { key: PRIME },
    );
    assert.equal(varredura.body.recallsDescumpridos, 0, 'o custodiante ja fez a parte dele');
  });

  test('foi buscar e o carro nao estava: o prazo retoma de onde parou', async () => {
    const response = await api<{ recall: { situacao: string; prazoFinal: string } }>(
      'POST',
      `/api/v1/recalls/${recallId}/reabrir-prazo`,
      { key: 'demo_central_titular', body: { motivo: 'Cheguei e o carro estava bloqueado' } },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.recall.situacao, 'DUE');
    assert.ok(Date.parse(response.body.recall.prazoFinal) > clock.now());
  });

  test('so o custodiante declara disponivel; so o interessado reabre', async () => {
    const pelaErrada = await api<{ erro: { codigo: string } }>(
      'POST',
      `/api/v1/recalls/${recallId}/disponivel`,
      { key: 'demo_central_titular' },
    );
    assert.equal(pelaErrada.status, 403);
    assert.equal(pelaErrada.body.erro.codigo, 'NOT_CUSTODIAN');
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

describe('material de divulgacao', () => {
  let vehicleId: string;

  test('a plataforma nao expoe nenhuma rota publica', async () => {
    // Nao ha superficie para o consumidor: toda rota de negocio exige login.
    for (const path of ['/api/v1/veiculos', '/api/v1/recalls', '/api/v1/notificacoes']) {
      assert.equal((await api('GET', path)).status, 401, path);
    }
  });

  test('a parceira baixa o kit neutro do carro da outra loja', async () => {
    const catalog = await api<{ veiculos: Array<{ id: string }> }>('GET', '/api/v1/veiculos?marca=Toyota', {
      key: VELOZ_VENDEDOR,
    });
    vehicleId = catalog.body.veiculos[0]?.id as string;

    const response = await api<{
      referencia: string;
      prontidao: { pronto: boolean; angulosFaltando: string[] };
      ficha: { titulo: string };
      minhaMarca: unknown;
    }>('GET', `/api/v1/veiculos/${vehicleId}/material`, { key: VELOZ_VENDEDOR });

    assert.equal(response.status, 200);
    assert.equal(response.body.ficha.titulo, 'Toyota Corolla 2.0 XEi 2022');
    assert.equal(response.body.minhaMarca, null, 'o kit nasce neutro');
  });

  test('o kit nao entrega a loja dona, o liquido, o chassi nem a placa', async () => {
    const response = await api<string>('GET', `/api/v1/veiculos/${vehicleId}/material`, {
      key: VELOZ_VENDEDOR,
    });
    const serialized = JSON.stringify(response.body).toLowerCase();

    for (const proibido of ['garagem central', '34028316000103', '93ybb05654j019381', 'pqr2c58', '12800000']) {
      assert.equal(serialized.includes(proibido), false, `vazou no material: ${proibido}`);
    }
  });

  test('a parceira carimba a propria marca e o proprio preco', async () => {
    const response = await api<{ minhaMarca: { nomeFantasia: string; preco: { formatado: string } } }>(
      'GET',
      `/api/v1/veiculos/${vehicleId}/material?comMinhaLoja=true&preco=144900`,
      { key: VELOZ_VENDEDOR },
    );
    assert.equal(response.body.minhaMarca.nomeFantasia, 'Veloz Seminovos');
    assert.equal(response.body.minhaMarca.preco.formatado, 'R$ 144.900,00');
  });

  test('a ficha em PDF e valida e igualmente limpa', async () => {
    const response = await fetch(`${baseUrl}/api/v1/veiculos/${vehicleId}/material/ficha.pdf`, {
      headers: { authorization: `Bearer ${VELOZ_VENDEDOR}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');

    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 8).toString('latin1'), '%PDF-1.7');
    assert.equal(bytes.toString('latin1').toLowerCase().includes('garagem central'), false);
  });

  test('a ficha em PDF exige login como todo o resto', async () => {
    const response = await fetch(`${baseUrl}/api/v1/veiculos/${vehicleId}/material/ficha.pdf`);
    assert.equal(response.status, 401);
  });

  test('as fotos neutras sao servidas pela plataforma', async () => {
    const photo = await fetch(`${baseUrl}/api/v1/veiculos/${vehicleId}/material/fotos/0`, {
      headers: { authorization: `Bearer ${VELOZ_VENDEDOR}` },
      redirect: 'manual',
    });
    assert.equal(photo.status, 302);
    const destino = photo.headers.get('location') ?? '';
    assert.equal(destino.includes('cdn.central'), false, 'nunca o CDN da loja dona');
  });

  test('o laudo cautelar acompanha o material', async () => {
    const laudo = await fetch(`${baseUrl}/api/v1/veiculos/${vehicleId}/material/laudo.pdf`, {
      headers: { authorization: `Bearer ${VELOZ_VENDEDOR}` },
      redirect: 'manual',
    });
    assert.equal(laudo.status, 302);
    assert.match(laudo.headers.get('location') ?? '', /laudos\.exemplo\.com\.br/);
  });

  test('so a loja dona publica o conjunto neutro', async () => {
    const response = await api<{ erro: { codigo: string } }>(
      'POST',
      `/api/v1/veiculos/${vehicleId}/material/fotos`,
      {
        key: VELOZ,
        body: { fotos: [{ url: 'https://midia.rede.com.br/a.jpg', angulo: 'FRONT' }] },
      },
    );
    assert.equal(response.status, 403);
    assert.equal(response.body.erro.codigo, 'NOT_VEHICLE_OWNER');
  });
});

describe('a dona nao ve a margem da parceira', () => {
  let dealId: string;

  test('a Loja B monta uma negociacao com preco ao consumidor', async () => {
    const catalog = await api<{ veiculos: Array<{ id: string }> }>('GET', '/api/v1/veiculos?marca=Volkswagen', {
      key: VELOZ_VENDEDOR,
    });
    const vehicleId = catalog.body.veiculos[0]?.id as string;
    await api('POST', `/api/v1/veiculos/${vehicleId}/trava`, { key: VELOZ_VENDEDOR });

    const deal = await api<{ id: string }>('POST', `/api/v1/veiculos/${vehicleId}/negociacao`, {
      key: VELOZ_VENDEDOR,
      body: { precoAoConsumidor: { centavos: 12_990_000 } },
    });
    assert.equal(deal.status, 201);
    dealId = deal.body.id;
  });

  test('a vendedora ve os proprios numeros', async () => {
    const response = await api<{ financeiro: { meusNumeros?: { minhaMargem: { formatado: string } } } }>(
      'GET',
      `/api/v1/negociacoes/${dealId}`,
      { key: VELOZ_VENDEDOR },
    );
    assert.equal(response.status, 200);
    assert.ok(response.body.financeiro.meusNumeros, 'a vendedora ve a propria margem');
  });

  test('a dona ve o que lhe e devido, e NADA da margem da parceira', async () => {
    // Se a dona visse a margem, bastaria olhar uma venda para saber quanto
    // subir o liquido na proxima — e a parceira pararia de trazer cliente.
    const response = await api<{ financeiro: Record<string, unknown> }>(
      'GET',
      `/api/v1/negociacoes/${dealId}`,
      { key: 'demo_norte_titular' },
    );
    assert.equal(response.status, 200);
    assert.ok(response.body.financeiro['dinheiroDevidoAProprietaria']);
    assert.equal('meusNumeros' in response.body.financeiro, false);
    assert.equal(JSON.stringify(response.body).includes('12990000'), false, 'o preco praticado nao vaza');
  });

  test('para terceiros a negociacao sequer existe', async () => {
    const response = await api<{ erro: { codigo: string } }>('GET', `/api/v1/negociacoes/${dealId}`, {
      key: CENTRAL,
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.erro.codigo, 'DEAL_NOT_FOUND');
  });
});

describe('credenciamento: quem decide quem entra sao os membros', () => {
  let applicationId: string;

  const candidata = {
    legalName: 'Nova Garagem Veiculos LTDA',
    tradeName: 'Nova Garagem',
    cnpj: '07.526.557/0001-00',
    city: 'Sao Jose dos Pinhais',
    state: 'PR',
    phone: '(41) 99876-5432',
    email: 'contato@novagaragem.com.br',
    responsibleName: 'Joao Pereira',
  };

  test('uma fundadora apresenta a candidata', async () => {
    const response = await api<{ id: string; situacao: string; apuracao: { faltam: number } }>(
      'POST', '/api/v1/credenciamentos', { key: PRIME, body: { candidata } },
    );

    assert.equal(response.status, 201);
    applicationId = response.body.id;
    assert.equal(response.body.situacao, 'PENDING');
    assert.equal(response.body.apuracao.faltam, 3);
  });

  test('a padrinho nao endossa a propria indicacao', async () => {
    const response = await api<{ erro: { codigo: string } }>(
      'POST', `/api/v1/credenciamentos/${applicationId}/endossos`, { key: PRIME, body: {} },
    );
    assert.equal(response.status, 422);
    assert.equal(response.body.erro.codigo, 'SPONSOR_CANNOT_ENDORSE');
  });

  test('vendedor nao endossa — o endosso e do titular', async () => {
    const response = await api('POST', `/api/v1/credenciamentos/${applicationId}/endossos`, {
      key: PRIME_VENDEDOR, body: {},
    });
    assert.equal(response.status, 403);
  });

  test('dois endossos ainda nao credenciam', async () => {
    for (const key of [VELOZ, 'demo_central_titular']) {
      const response = await api<{ situacao: string; lojaCredenciada: unknown }>(
        'POST', `/api/v1/credenciamentos/${applicationId}/endossos`,
        { key, body: { justificativa: 'Conheco a operacao de perto.' } },
      );
      assert.equal(response.body.situacao, 'PENDING');
      assert.equal(response.body.lojaCredenciada, null);
    }
  });

  test('o terceiro endosso credencia e a loja ja entra operando', async () => {
    const response = await api<{
      situacao: string;
      empresaCredenciada: { id: string; tipo: string; lojas: number };
      lojaCredenciada: { id: string; empresaId: string };
    }>('POST', `/api/v1/credenciamentos/${applicationId}/endossos`, {
      key: 'demo_norte_titular', body: {},
    });

    assert.equal(response.body.situacao, 'APPROVED');
    // FUNDADORA, e nao membro: a janela de fundacao do piloto esta aberta, e
    // quem entrar na janela leva. Fechada a janela, a mesma candidatura com os
    // mesmos endossos viraria MEMBER — e o que `services.test.ts` cobre, porque
    // exige avancar o relogio em 90 dias sem arrastar o resto desta suite.
    assert.equal(response.body.empresaCredenciada.tipo, 'FOUNDER');
    assert.equal(response.body.empresaCredenciada.lojas, 1, 'empresa nova nasce com um patio');
    assert.equal(response.body.lojaCredenciada.empresaId, response.body.empresaCredenciada.id);

    const stores = await api<{ total: number }>('GET', '/api/v1/lojas', { key: PRIME });
    assert.equal(stores.body.total, 12, '11 patios do seed + o da credenciada');

    const members = await api<{ total: number }>('GET', '/api/v1/empresas', { key: PRIME });
    assert.equal(members.body.total, 11, '10 empresas do seed + a credenciada');
  });

  test('a apuracao conta as fundadoras da praca — inclusive a que acabou de entrar', async () => {
    const response = await api<{
      apuracao: { fundadorasQuePodemEndossar: number; alcancavel: boolean };
    }>('GET', `/api/v1/credenciamentos/${applicationId}`, { key: PRIME });

    // 11 fundadoras agora (10 do seed + a credenciada), menos a padrinho, menos
    // as tres que ja endossaram.
    assert.equal(response.body.apuracao.fundadorasQuePodemEndossar, 7);
    assert.equal(response.body.apuracao.alcancavel, true);
  });

  test('a praca publica a janela de fundacao', async () => {
    const response = await api<{
      cluster: { janelaDeFundacao: { aberta: boolean; diasRestantes: number } };
    }>('GET', '/api/v1/cluster', { key: PRIME });

    assert.equal(response.body.cluster.janelaDeFundacao.aberta, true);
    assert.ok(response.body.cluster.janelaDeFundacao.diasRestantes > 0);
  });
});

describe('empresa e patio: a separacao que a tabela de precos exigiu', () => {
  test('a empresa lista os patios que tem — e a contagem e a base da fatura', async () => {
    const response = await api<{
      total: number;
      empresas: Array<{ id: string; razaoSocial: string; lojas: number; fundadora: boolean }>;
    }>('GET', '/api/v1/empresas', { key: PRIME });

    const prime = response.body.empresas.find((e) => e.razaoSocial.startsWith('Prime Motors'));
    assert.equal(prime?.lojas, 2, 'matriz + Boqueirao: R$ 599 + R$ 159');
    assert.equal(prime?.fundadora, true);

    const outra = response.body.empresas.find((e) => e.razaoSocial.startsWith('Veloz'));
    assert.equal(outra?.lojas, 1, 'so a primeira loja, inclusa nos R$ 599');
  });

  test('o patio nao carrega a condicao da empresa', async () => {
    // `fundadora` e `tipo` saem so no DTO da empresa. Repetir na loja seria
    // convidar as duas respostas a divergirem quando a empresa mudar de estado.
    const response = await api<{ lojas: Array<Record<string, unknown>> }>(
      'GET', '/api/v1/lojas', { key: PRIME },
    );
    const loja = response.body.lojas[0]!;
    assert.equal('fundadora' in loja, false);
    assert.equal('tipo' in loja, false);
    assert.equal(typeof loja['empresaId'], 'string');
  });

  test('a filial do Boqueirao opera com a chave dela, sob a mesma empresa', async () => {
    const matriz = await api<{ lojas: Array<{ id: string; empresaId: string; cnpj: string }> }>(
      'GET', '/api/v1/lojas', { key: PRIME },
    );
    const prime = matriz.body.lojas.filter((l) => l.cnpj.startsWith('11.222.333'));
    assert.equal(prime.length, 2);
    assert.equal(prime[0]!.empresaId, prime[1]!.empresaId, 'mesma raiz de CNPJ, mesma empresa');

    const catalogo = await api<{ total: number }>('GET', '/api/v1/veiculos', {
      key: 'demo_prime_boqueirao',
    });
    assert.equal(catalogo.status, 200, 'a filial ve o catalogo da praca');
  });

  test('patio novo com raiz de CNPJ de outra empresa e recusado', async () => {
    // Sem essa guarda, qualquer empresa entraria na rede pelo preco de uma
    // filial e sem passar por endosso nenhum.
    const response = await api<{ erro: { codigo: string } }>('POST', '/api/v1/lojas', {
      key: PRIME,
      body: {
        loja: {
          legalName: 'Outra Empresa Veiculos LTDA',
          tradeName: 'Outra Empresa',
          cnpj: '02.558.157/0001-62',
          city: 'Pinhais', state: 'PR',
          phone: '(41) 3344-5566',
          email: 'contato@outraempresa.com.br',
          responsibleName: 'Ana Lima',
        },
      },
    });

    assert.equal(response.status, 422);
    assert.equal(response.body.erro.codigo, 'BRANCH_CNPJ_MISMATCH');
  });

  test('vendedor nao abre patio: isso muda a mensalidade da empresa', async () => {
    const response = await api('POST', '/api/v1/lojas', {
      key: PRIME_VENDEDOR,
      body: { loja: { cnpj: '11.222.333/0003-43' } },
    });
    assert.equal(response.status, 403);
  });

  test('empresa ja na rede nao entra por candidatura — abre patio', async () => {
    const response = await api<{ erro: { codigo: string } }>(
      'POST', '/api/v1/credenciamentos',
      {
        key: VELOZ,
        body: {
          candidata: {
            legalName: 'Prime Motors Filial LTDA',
            tradeName: 'Prime Motors Filial',
            cnpj: '11.222.333/0004-24',
            city: 'Curitiba', state: 'PR',
            phone: '(41) 3344-7788',
            email: 'filial@prime.com.br',
            responsibleName: 'Paulo Prado',
          },
        },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.erro.codigo, 'COMPANY_ALREADY_IN_NETWORK');
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

/**
 * A dona recebe propostas com carro na troca. Declarar a postura no cadastro
 * move a descoberta para antes do trabalho — hoje a parceira monta a
 * negociacao inteira e so descobre no aceite, com o cliente na mesa.
 */
describe('postura de troca', () => {
  // `ficha` usa chaves em ingles no contrato atual, diferente do resto do corpo.
  const ficha = {
    brand: 'Hyundai', model: 'HB20', version: '1.0 Comfort',
    manufactureYear: 2022, modelYear: 2023, mileageKm: 31_200,
    color: 'Branco', fuel: 'FLEX', transmission: 'MANUAL', doors: 4,
  };

  const cadastro = (placa: string, chassi: string, extra: Record<string, unknown>) => ({
    placa, chassi, ficha,
    precoPublico: '72.900,00',
    precoLiquidoRepasse: '66.000,00',
    laudoCautelar: {
      situacao: 'APPROVED', numero: 'LC-TROCA', empresa: 'Cautelar Brasil',
      emitidoEm: '2026-08-01T12:00:00.000Z', validoAte: '2027-08-01T12:00:00.000Z',
    },
    ...extra,
  });

  test('o cadastro exige a decisao — nao ha padrao silencioso', async () => {
    const response = await api<{ erro: { codigo: string } }>('POST', '/api/v1/veiculos', {
      key: PRIME,
      body: cadastro('JKL1M23', '9BWZZZ377VT900001', {}),
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.erro.codigo, 'FIELD_REQUIRED_BOOLEAN');
  });

  test('a postura declarada sai no catalogo, para quem le antes de propor', async () => {
    const criado = await api<{ troca: { aceitaCarroNaTroca: boolean; observacao: string | null } }>(
      'POST', '/api/v1/veiculos',
      {
        key: PRIME,
        body: cadastro('JKL2M24', '9BWZZZ377VT900002', {
          aceitaCarroNaTroca: false,
          observacaoDaTroca: 'Preciso do dinheiro para quitar o floor plan.',
        }),
      },
    );

    assert.equal(criado.status, 201);
    assert.equal(criado.body.troca.aceitaCarroNaTroca, false);
    assert.equal(criado.body.troca.observacao, 'Preciso do dinheiro para quitar o floor plan.');
  });

  test('a dona muda de ideia; terceiro nao mexe', async () => {
    const criado = await api<{ id: string }>('POST', '/api/v1/veiculos', {
      key: PRIME,
      body: cadastro('JKL3M25', '9BWZZZ377VT900003', { aceitaCarroNaTroca: false }),
    });
    const id = criado.body.id;

    const alheio = await api('PATCH', `/api/v1/veiculos/${id}/troca`, {
      key: VELOZ,
      body: { aceitaCarroNaTroca: true },
    });
    assert.equal(alheio.status, 403, 'so a loja proprietaria decide');

    const propria = await api<{ troca: { aceitaCarroNaTroca: boolean } }>(
      'PATCH', `/api/v1/veiculos/${id}/troca`,
      { key: PRIME, body: { aceitaCarroNaTroca: true } },
    );
    assert.equal(propria.status, 200);
    assert.equal(propria.body.troca.aceitaCarroNaTroca, true);
  });

  test('a negociacao com transbordo e recusada na abertura, nao no aceite', async () => {
    const criado = await api<{ id: string }>('POST', '/api/v1/veiculos', {
      key: PRIME,
      body: cadastro('JKL4M26', '9BWZZZ377VT900004', { aceitaCarroNaTroca: false }),
    });
    const id = criado.body.id;

    await api('POST', `/api/v1/veiculos/${id}/trava`, {
      key: VELOZ_VENDEDOR,
      body: { referenciaAtendimento: 'ATD-TROCA' },
    });

    const negociacao = await api<{ erro: { codigo: string } }>(
      'POST', `/api/v1/veiculos/${id}/negociacao`,
      {
        key: VELOZ_VENDEDOR,
        body: {
          precoAoConsumidor: '74.900,00',
          troca: {
            destino: 'OWNER_STORE',
            valorDadoAoCliente: '20.000,00',
            avaliacao: '19.000,00',
            veiculo: {
              placa: 'ZZZ9Z99', marca: 'Fiat', modelo: 'Mobi', versao: '1.0 Like',
              anoModelo: 2019, km: 78_000,
            },
          },
        },
      },
    );

    assert.equal(negociacao.status, 422);
    assert.equal(negociacao.body.erro.codigo, 'TRADE_IN_NOT_ACCEPTED');
  });
});
