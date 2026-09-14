import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assessMaterial, buildMaterialKit, findLeaks, forbiddenTermsFor } from './kit.ts';
import {
  InspectionStatus,
  VehicleAngle,
  hasUsableMaterial,
  publishNeutralPhotos,
  type Vehicle,
} from '../vehicle/vehicle.ts';
import { fromReais } from '../shared/money.ts';
import { unwrap } from '../shared/result.ts';
import { buildFoundingNetwork, buildSpecs, buildVehicle } from '../../testing/builders.ts';

const network = buildFoundingNetwork(6);
const lojaA = network.founderAt(0); // dona — nao pode aparecer no material
const lojaB = network.founderAt(1); // parceira que baixa

const T0 = Date.parse('2026-09-14T13:00:00Z');
const BASE = '/api/v1/veiculos/veh_0001/material';

/** Fotos do feed hospedadas no CDN da propria dona: o vazamento mais sutil. */
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

const kit = (overrides: Partial<Parameters<typeof buildMaterialKit>[1]> = {}) =>
  buildMaterialKit(vehicle, { mediaBase: BASE, now: T0, ...overrides });

describe('publicacao do conjunto neutro', () => {
  test('so a loja dona publica — e ela quem tem o carro', () => {
    const result = publishNeutralPhotos({
      vehicle,
      actorStoreId: lojaB.id,
      photos: [{ url: 'https://midia.rede.com.br/a.jpg', angle: VehicleAngle.FRONT }],
      now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'NOT_VEHICLE_OWNER');
  });

  test('exige os angulos sem os quais nao da para anunciar', () => {
    const result = publishNeutralPhotos({
      vehicle,
      actorStoreId: lojaA.id,
      photos: [{ url: 'https://midia.rede.com.br/frente.jpg', angle: VehicleAngle.FRONT }],
      now: T0,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'MATERIAL_ANGLES_MISSING');
    assert.match(result.ok === false ? result.error.message : '', /REAR/);
  });

  test('publicado o conjunto, o material fica utilizavel', () => {
    const semMaterial = { ...vehicle, neutralPhotos: [] };
    assert.equal(hasUsableMaterial(semMaterial), false);
    assert.equal(assessMaterial(semMaterial).ready, false);

    const publicado = unwrap(
      publishNeutralPhotos({
        vehicle: semMaterial,
        actorStoreId: lojaA.id,
        photos: [VehicleAngle.FRONT, VehicleAngle.REAR, VehicleAngle.INTERIOR].map((angle) => ({
          url: `https://midia.rede.com.br/${angle}.jpg`,
          angle,
        })),
        now: T0,
      }),
    );
    assert.equal(hasUsableMaterial(publicado.state), true);
    assert.equal(assessMaterial(publicado.state).missingAngles.length, 0);
    assert.ok(publicado.events.some((e) => e.type === 'vehicle.neutral_photos_published'));
  });

  test('a prontidao aponta exatamente o que falta', () => {
    const readiness = assessMaterial({ ...vehicle, neutralPhotos: [] });
    assert.deepEqual(readiness.missingAngles, ['FRONT', 'REAR', 'INTERIOR']);
    assert.equal(readiness.photoCount, 0);
  });
});

describe('o material que sai da rede nao entrega a origem', () => {
  test('nenhum termo da loja dona aparece no kit', () => {
    const leaks = findLeaks(kit(), vehicle, lojaA);
    assert.deepEqual(leaks, [], `vazou: ${leaks.join(', ')}`);
  });

  test('a lista de termos proibidos cobre identidade, liquido, chassi e fotos do feed', () => {
    const terms = forbiddenTermsFor(vehicle, lojaA);
    assert.ok(terms.includes(lojaA.profile.tradeName));
    assert.ok(terms.includes(lojaA.profile.cnpj));
    assert.ok(terms.includes('9BWZZZ377VT004251'));
    assert.ok(terms.includes('8500000'), 'os centavos do liquido tambem sao vazamento');
    assert.ok(terms.some((term) => term.includes('cdn.primemotors.com.br')));
  });

  test('as fotos do feed nunca entram — so as neutras, servidas pela plataforma', () => {
    const serialized = JSON.stringify(kit());
    assert.equal(serialized.includes('primemotors'), false);
    for (const photo of kit().sheet.photos) {
      assert.ok(photo.url.startsWith(`${BASE}/fotos/`), photo.url);
    }
  });

  test('sem base de midia, o kit sai sem foto em vez de apontar para o CDN da dona', () => {
    const semBase = buildMaterialKit(vehicle, { now: T0 });
    assert.deepEqual(semBase.sheet.photos, []);
    assert.equal(semBase.sheet.inspection.fileUrl, null);
    assert.deepEqual(findLeaks(semBase, vehicle, lojaA), []);
  });

  test('placa, chassi e preco liquido ficam de fora', () => {
    const serialized = JSON.stringify(kit());
    assert.equal(serialized.includes('ABC1D23'), false);
    assert.equal(serialized.includes('9BWZZZ377VT004251'), false);
    assert.equal(serialized.includes('85.000'), false);
    assert.equal(serialized.includes('8500000'), false);
  });

  test('o numero do laudo nao vai no material, mas o arquivo e a aprovacao sim', () => {
    const sheet = kit().sheet;
    assert.equal(JSON.stringify(sheet).includes('LC-2026-004512'), false);
    assert.equal(sheet.inspection.approved, true);
    assert.equal(sheet.inspection.provider, 'Cautelar Brasil');
    assert.equal(sheet.inspection.fileUrl, `${BASE}/laudo.pdf`);
  });

  test('o guarda de runtime acusa quando um campo passa a vazar', () => {
    const vazado = { ...kit(), observacaoInterna: `Carro da ${lojaA.profile.tradeName}` };
    assert.deepEqual(findLeaks(vazado as never, vehicle, lojaA), [lojaA.profile.tradeName]);
  });
});

describe('marca da parceira no material', () => {
  test('o kit nasce neutro: sem loja e sem preco', () => {
    const neutro = kit();
    assert.equal(neutro.branding, null);
    assert.equal(JSON.stringify(neutro).includes('Veloz'), false);
  });

  test('a parceira pode carimbar a propria marca e o proprio preco', () => {
    // Quem define o liquido e a dona; quem define o preco ao consumidor e quem
    // vai atender o consumidor.
    const comMarca = kit({ partner: lojaB, partnerPrice: fromReais(96_900) });
    assert.equal(comMarca.branding?.tradeName, 'Veloz Seminovos');
    assert.equal(comMarca.branding?.price?.formatted, 'R$ 96.900,00');
    assert.deepEqual(findLeaks(comMarca, vehicle, lojaA), [], 'a marca da parceira nao e vazamento');
  });

  test('a ficha traz os dados tecnicos completos', () => {
    const sheet = kit().sheet;
    assert.equal(sheet.title, 'Chevrolet Onix 1.0 Turbo LTZ 2023');
    assert.equal(sheet.yearLabel, '2022/2023');
    assert.equal(sheet.mileageLabel, '38.400 km');
    assert.equal(sheet.fuelLabel, 'Flex');
    assert.equal(sheet.transmissionLabel, 'Automatico');
    assert.deepEqual(sheet.optionals, ['Ar-condicionado', 'Direcao eletrica', 'Multimidia']);
  });

  test('laudo ausente aparece como tal, sem inventar arquivo', () => {
    const semLaudo = buildMaterialKit(
      {
        ...vehicle,
        inspection: {
          status: InspectionStatus.MISSING,
          reportNumber: null,
          provider: null,
          issuedAt: null,
          expiresAt: null,
          fileUrl: null,
        },
      },
      { mediaBase: BASE, now: T0 },
    );
    assert.equal(semLaudo.sheet.inspection.approved, false);
    assert.equal(semLaudo.sheet.inspection.fileUrl, null);
    assert.equal(semLaudo.readiness.hasInspectionFile, false);
  });
});
