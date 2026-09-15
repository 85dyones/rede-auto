/**
 * Rotas de rede e governanca: empresas, patios e credenciamento.
 *
 * A distincao aparece na URL: `/empresas` e quem paga e endossa, `/lojas` sao
 * os patios. Quem abre um patio novo faz POST em `/lojas` — nao ha candidatura,
 * porque as fundadoras ja responderam pela empresa.
 */

import { notFoundError } from '../../domain/shared/errors.ts';
import { asApplicationId, asChargeId } from '../../domain/shared/ids.ts';
import type { AppContext } from '../../application/context.ts';
import type { ApplicationView } from '../../application/governance-service.ts';
import {
  memberStatement,
  registerChargePayment,
} from '../../application/billing-service.ts';
import {
  openStoreBranch,
  retireApplication,
  submitApplication,
  viewApplication,
  endorseApplication,
} from '../../application/governance-service.ts';
import type { Router } from '../router.ts';
import { errorResponse, json } from '../http-types.ts';
import { applicationDto, chargeDto, clusterDto, memberDto, statementDto, storeDto } from '../serialize.ts';
import { asObject, optionalText } from '../parse.ts';
import { requireActor } from './support.ts';

/**
 * Empresa e patio andam juntos no DTO ou nenhum dos dois aparece: uma resposta
 * com loja credenciada e empresa nula obrigaria o cliente a tratar um estado
 * que o dominio nao produz.
 */
const admittedPair = (view: ApplicationView) =>
  view.admittedMember === null || view.admittedStore === null
    ? null
    : { member: view.admittedMember, store: view.admittedStore };

export function registerNetworkRoutes(router: Router, context: AppContext): void {
  /** As lojas da **sua** praca. Nao existe "todas as lojas da instalacao". */
  router.get('/api/v1/lojas', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const stores = await context.repos.stores.byCluster(actor.value.store.clusterId);
    return json(200, {
      total: stores.length,
      lojas: stores.map(storeDto),
    });
  });

  /** A praca em que esta loja opera: alcance declarado e municipios atendidos. */
  router.get('/api/v1/cluster', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const cluster = await context.repos.clusters.byId(actor.value.store.clusterId);
    if (cluster === undefined) {
      return errorResponse(
        notFoundError('CLUSTER_NOT_FOUND', 'A praca desta loja nao foi encontrada.'),
        request.requestId,
      );
    }
    return json(200, { cluster: clusterDto(cluster, context.clock.now()) });
  });

  /**
   * Abre mais um patio da empresa do ator. E a operacao que a linha de R$ 159
   * cobra. Sem endosso: as fundadoras ja responderam pela empresa.
   */
  router.post('/api/v1/lojas', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const result = await openStoreBranch(context, actor.value, body.value['loja'] ?? body.value);
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(201, {
      loja: storeDto(result.value.store),
      lojasDaEmpresa: result.value.storeCount,
    });
  });

  /** As empresas da sua praca — quem paga, quem endossa, quem foi suspensa. */
  router.get('/api/v1/empresas', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const members = await context.repos.members.byCluster(actor.value.member.clusterId);
    const dtos = [];
    for (const member of members) {
      const stores = await context.repos.stores.byMember(member.id);
      dtos.push(memberDto(member, stores.length));
    }
    return json(200, { total: dtos.length, empresas: dtos });
  });

  router.get('/api/v1/empresas/fundadoras', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    // `total` vem da contagem, nunca de politica: quantas fundadoras a praca tem
    // depende de quem entrou antes de a janela de fundacao fechar.
    const founders = await context.repos.members.founders(actor.value.member.clusterId);
    const dtos = [];
    for (const member of founders) {
      const stores = await context.repos.stores.byMember(member.id);
      dtos.push(memberDto(member, stores.length));
    }
    return json(200, {
      total: dtos.length,
      endossosParaCredenciar: context.policies.governance.requiredEndorsements,
      empresas: dtos,
    });
  });

  /**
   * O extrato da empresa do ator. Nao ha rota para ver o extrato de outra: o
   * que uma loja paga nao e assunto da vizinha, mesmo dentro da praca.
   */
  router.get('/api/v1/financeiro', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const result = await memberStatement(context, actor.value.member.id);
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(200, statementDto(result.value));
  });

  /**
   * Registra o pagamento de uma cobranca. Hoje o gesto e da propria empresa —
   * nao ha integracao de meio de pagamento, e este e o ponto por onde um
   * adaptador real entraria sem mexer no dominio.
   */
  router.post('/api/v1/financeiro/cobrancas/:id/pagamento', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const chargeId = asChargeId(request.params['id'] as string);
    const charge = await context.repos.charges.byId(chargeId);

    // 404, e nao 403, para cobranca de outra empresa: dizer "existe, mas nao e
    // sua" ja entrega que ela existe.
    if (charge === undefined || charge.memberId !== actor.value.member.id) {
      return errorResponse(
        notFoundError('CHARGE_NOT_FOUND', 'Cobranca nao encontrada.', { chargeId }),
        request.requestId,
      );
    }

    const result = await registerChargePayment(context, chargeId);
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(200, {
      cobranca: chargeDto(result.value.charge),
      empresaReativada: result.value.reinstated === null ? null : result.value.reinstated.id,
    });
  });

  router.post('/api/v1/credenciamentos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const result = await submitApplication(context, actor.value, body.value['candidata'] ?? body.value);
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(201, applicationDto(result.value.application, result.value.tally, null));
  });

  router.get('/api/v1/credenciamentos/:id', async (request) => {
    const result = await viewApplication(context, asApplicationId(request.params['id'] as string));
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, applicationDto(result.value.application, result.value.tally, admittedPair(result.value)));
  });

  router.get('/api/v1/credenciamentos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const pending = await context.repos.memberships.pending(actor.value.store.clusterId);
    const views = [];
    for (const application of pending) {
      const view = await viewApplication(context, application.id);
      if (view.ok) views.push(applicationDto(view.value.application, view.value.tally, null));
    }
    return json(200, { total: views.length, candidaturas: views });
  });

  /**
   * Endosso de fundadora. O terceiro endosso ja credencia — quem decide quem
   * entra sao os membros, e a plataforma so opera.
   */
  router.post('/api/v1/credenciamentos/:id/endossos', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const body = asObject(request.body);
    if (!body.ok) return errorResponse(body.error, request.requestId);

    const result = await endorseApplication(
      context,
      actor.value,
      asApplicationId(request.params['id'] as string),
      optionalText(body.value, 'justificativa'),
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);

    return json(200, applicationDto(result.value.application, result.value.tally, admittedPair(result.value)));
  });

  router.delete('/api/v1/credenciamentos/:id', async (request) => {
    const actor = requireActor(request);
    if (!actor.ok) return errorResponse(actor.error, request.requestId);

    const result = await retireApplication(
      context,
      actor.value,
      asApplicationId(request.params['id'] as string),
    );
    if (!result.ok) return errorResponse(result.error, request.requestId);
    return json(200, applicationDto(result.value.application, result.value.tally, null));
  });
}
