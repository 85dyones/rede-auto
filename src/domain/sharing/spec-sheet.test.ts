import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildWhiteLabelSheet, findLeaks, forbiddenTermsFor } from './spec-sheet.ts';
import { createShareLink, isUsable, linkUnavailableReason, registerView, revokeShareLink } from './share-link.ts';
import { CommercialStatus, type Vehicle } from '../vehicle/vehicle.ts';
import { fromReais } from '../shared/money.ts';
import { DAY, HOUR } from '../shared/clock.ts';
import { asShareLinkId } from '../shared/ids.ts';
import { unwrap } from '../shared/result.ts';
import { buildFoundingNetwork, buildSpecs, buildVehicle } from '../../testing/builders.ts';

const network = buildFoundingNetwork(6);
const lojaA = network.founderAt(0); // dona — nao pode aparecer
const lojaB = network.founderAt(1); // apresenta ao cliente
const vendedorB = network.principalAt(1);

const T0 = Date.parse('2026-08-24T13:00:00Z');

/** Fotos hospedadas no CDN da loja dona: o vazamento mais facil de esquecer. */
const vehicle: Vehicle = buildVehicle({
  ownerStoreId: lojaA.id,
  createdAt: T0,
  plate: 'ABC1D23',
  chassis: '9BWZZZ377VT004251',
  specs: buildSpecs({
    photos: [
      'https://cdn.primemotors.com.br/estoque/onix-frente.jpg',
      'https://cdn.primemotors.com.br/estoque/onix-lateral.jpg',
    ],
  }),
  pricing: { publicPrice: fromReais(92_900), netPrice: fromReais(85_000), updatedAt: T0 },
});

function link(overrides: Partial<Parameters<typeof createShareLink>[0]> = {}) {
  return unwrap(
    createShareLink({
      linkId: asShareLinkId('shr_0001'),
      vehicle,
      sharedByStoreId: lojaB.id,
      createdByUserId: vendedorB.id,
      now: T0,
      ...overrides,
    }),
  ).state;
}

const sheetFor = (l = link(), photoProxyBase: string | undefined = '/s/token/fotos') =>
  buildWhiteLabelSheet(vehicle, l, lojaB, { photoProxyBase, now: T0 });

describe('lamina white-label: o que NAO pode vazar', () => {
  test('nenhum termo que identifique a loja proprietaria aparece na lamina', () => {
    const leaks = findLeaks(sheetFor(), vehicle, lojaA, lojaB);
    assert.deepEqual(leaks, [], `vazou: ${leaks.join(', ')}`);
  });

  test('a lista de termos proibidos cobre identidade, preco liquido, chassi e fotos', () => {
    const terms = forbiddenTermsFor(vehicle, lojaA);
    assert.ok(terms.includes(lojaA.profile.tradeName));
    assert.ok(terms.includes(lojaA.profile.cnpj));
    assert.ok(terms.includes('9BWZZZ377VT004251'));
    assert.ok(terms.includes('8500000'), 'os centavos do liquido tambem sao um vazamento');
    assert.ok(terms.some((term) => term.includes('cdn.primemotors.com.br')));
  });

  test('o preco liquido de repasse nao aparece de nenhuma forma', () => {
    const serialized = JSON.stringify(sheetFor());
    assert.equal(serialized.includes('85.000'), false);
    assert.equal(serialized.includes('8500000'), false);
    assert.equal(serialized.includes('netPrice'), false);
  });

  test('as fotos sao servidas pela plataforma, nunca pelo CDN da loja dona', () => {
    const sheet = sheetFor();
    assert.deepEqual(sheet.photos, ['/s/token/fotos/0', '/s/token/fotos/1']);
    for (const photo of sheet.photos) {
      assert.equal(photo.includes('primemotors'), false);
    }
  });

  test('sem proxy configurado, a lamina sai sem foto em vez de vazar o dominio', () => {
    const sheet = buildWhiteLabelSheet(vehicle, link(), lojaB, { now: T0 });
    assert.deepEqual(sheet.photos, []);
    assert.deepEqual(findLeaks(sheet, vehicle, lojaA, lojaB), []);
  });

  test('a placa fica oculta por padrao', () => {
    // Placa completa permite consulta publica que devolve o proprietario.
    assert.equal(sheetFor().plate, null);
  });

  test('mesmo habilitada, a placa sai mascarada', () => {
    const sheet = sheetFor(link({ showPlate: true }));
    assert.equal(sheet.plate, 'ABC****');
    assert.deepEqual(findLeaks(sheet, vehicle, lojaA, lojaB), []);
  });

  test('o numero do laudo nao vai na lamina, mas a aprovacao sim', () => {
    const sheet = sheetFor();
    assert.equal(JSON.stringify(sheet).includes('LC-2026-004512'), false);
    assert.equal(sheet.inspection.approved, true);
    assert.equal(sheet.inspection.provider, 'Cautelar Brasil');
  });

  test('o guarda de runtime acusa quando um campo passa a vazar', () => {
    // Simula um campo novo do agregado escapando para a lamina.
    const vazada = { ...sheetFor(), observacaoInterna: `Carro da ${lojaA.profile.tradeName}` };
    const leaks = findLeaks(vazada as never, vehicle, lojaA, lojaB);
    assert.deepEqual(leaks, [lojaA.profile.tradeName]);
  });

  test('a loja dona compartilhando o proprio carro nao dispara falso positivo', () => {
    const propria = buildWhiteLabelSheet(vehicle, link({ sharedByStoreId: lojaA.id }), lojaA, {
      photoProxyBase: '/s/token/fotos',
      now: T0,
    });
    assert.deepEqual(findLeaks(propria, vehicle, lojaA, lojaA), []);
  });
});

describe('lamina white-label: o que precisa aparecer', () => {
  test('traz a ficha tecnica completa em portugues', () => {
    const sheet = sheetFor();
    assert.equal(sheet.title, 'Chevrolet Onix 1.0 Turbo LTZ 2023');
    assert.equal(sheet.yearLabel, '2022/2023');
    assert.equal(sheet.mileageLabel, '38.400 km');
    assert.equal(sheet.fuelLabel, 'Flex');
    assert.equal(sheet.transmissionLabel, 'Automatico');
    assert.deepEqual(sheet.optionals, ['Ar-condicionado', 'Direcao eletrica', 'Multimidia']);
  });

  test('a unica identidade da lamina e a da loja que compartilhou', () => {
    const sheet = sheetFor();
    assert.equal(sheet.presentedBy.tradeName, lojaB.profile.tradeName);
    assert.equal(sheet.presentedBy.phone, '(19) 3233-4455');
  });

  test('exibe o preco que a loja vendedora escolheu, nao o do dono', () => {
    const sheet = sheetFor(link({ displayPrice: fromReais(97_500) }));
    assert.equal(sheet.price.formatted, 'R$ 97.500,00');
  });

  test('sem preco explicito, usa o preco publico do anuncio', () => {
    assert.equal(sheetFor().price.formatted, 'R$ 92.900,00');
  });

  test('traz um codigo curto para o cliente citar ao vendedor', () => {
    assert.equal(sheetFor().reference.length, 8);
  });
});

describe('ciclo de vida do link', () => {
  test('nasce valido por 2 dias e some depois do prazo', () => {
    const l = link();
    assert.equal(l.expiresAt - l.createdAt, 2 * DAY);
    assert.equal(isUsable(l, T0 + DAY), true);
    assert.equal(isUsable(l, T0 + 3 * DAY), false);
    assert.equal(linkUnavailableReason(l, T0 + 3 * DAY), 'EXPIRED');
  });

  test('o prazo pedido e limitado pelo teto da politica', () => {
    const l = link({ ttlMs: 90 * DAY });
    assert.equal(l.expiresAt - l.createdAt, 7 * DAY);
  });

  test('conta aberturas e para no limite', () => {
    let l = link({ maxViews: 2 });
    l = unwrap(registerView(l, T0 + HOUR));
    l = unwrap(registerView(l, T0 + 2 * HOUR));
    assert.equal(l.viewCount, 2);

    const terceira = registerView(l, T0 + 3 * HOUR);
    assert.equal(terceira.ok, false);
    assert.equal(terceira.ok === false && terceira.error.code, 'SHARE_LINK_UNAVAILABLE');
  });

  test('link expirado devolve mensagem util ao cliente final', () => {
    const expirado = { ...link(), expiresAt: T0 - HOUR };
    const result = registerView(expirado, T0);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error.message : '', /Peca um novo ao vendedor/);
  });

  test('so a loja que gerou o link o desativa', () => {
    const l = link();
    const porOutro = revokeShareLink({ link: l, actorStoreId: lojaA.id, reason: 'x', now: T0 + HOUR });
    assert.equal(porOutro.ok, false);
    assert.equal(porOutro.ok === false && porOutro.error.code, 'NOT_LINK_OWNER');

    const revogado = unwrap(
      revokeShareLink({ link: l, actorStoreId: lojaB.id, reason: 'Carro vendido', now: T0 + HOUR }),
    ).state;
    assert.equal(isUsable(revogado, T0 + 2 * HOUR), false);
    assert.equal(linkUnavailableReason(revogado, T0 + 2 * HOUR), 'REVOKED');
  });

  test('o token e opaco e nao enumeravel', () => {
    const primeiro = link().token;
    const segundo = unwrap(
      createShareLink({
        linkId: asShareLinkId('shr_0002'),
        vehicle,
        sharedByStoreId: lojaB.id,
        createdByUserId: vendedorB.id,
        now: T0,
      }),
    ).state.token;

    assert.notEqual(primeiro, segundo);
    assert.ok(primeiro.length >= 32);
    assert.match(primeiro, /^[A-Za-z0-9_-]+$/, 'base64url, seguro em URL');
  });

  test('veiculo fora da rede nao pode ser compartilhado', () => {
    const result = createShareLink({
      linkId: asShareLinkId('shr_x'),
      vehicle: { ...vehicle, commercialStatus: CommercialStatus.SOLD },
      sharedByStoreId: lojaB.id,
      createdByUserId: vendedorB.id,
      now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'VEHICLE_NOT_SHAREABLE');
  });
});
