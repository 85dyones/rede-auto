/**
 * Cluster: a praca onde a rede existe de fato.
 *
 * A rede e local, e isso nao e um detalhe de lancamento — e a precondicao de
 * todo o resto. O modelo inteiro (levar o carro para o showroom da parceira,
 * devolver em 4 horas uteis, o vendedor ir ate o patio assinar a vistoria) so
 * fecha porque as lojas estao a minutos umas das outras. Um SLA de 4 horas
 * entre Curitiba e Porto Alegre nao e um SLA, e uma ficcao.
 *
 * Logo, o cluster nao e um filtro de busca: e uma **fronteira**. Filtro se
 * esquece de aplicar; fronteira nao. Duas consequencias no codigo:
 *
 *  1. `VehicleQuery.clusterId` e obrigatorio. Nao existe busca sem praca — o
 *     compilador recusa. E o mesmo remedio usado em `dealDto(deal, viewer)`.
 *  2. Toda operacao entre duas lojas passa por `requireSameCluster`. Nenhuma
 *     trava, custodia, recall ou negociacao atravessa a fronteira.
 *
 * O plano de clusters locais em modo SaaS mora aqui: a segunda praca custa uma
 * linha de seed, nao uma auditoria de todas as consultas do sistema. Tenancy e
 * a coisa classica que nao da para retrofitar — ou nasce junto, ou vira
 * vazamento entre concorrentes de cidades diferentes.
 */

import { type Result, ok, err, combine } from '../shared/result.ts';
import { type DomainError, validationError, forbiddenError } from '../shared/errors.ts';
import { type Instant, DAY } from '../shared/clock.ts';
import type { ClusterId } from '../shared/ids.ts';
import { requireText, requireOneOf } from '../shared/validation.ts';

export const ClusterStatus = {
  /** Operando: lojas transacionam normalmente. */
  ACTIVE: 'ACTIVE',
  /**
   * Constituida, ainda nao transaciona. Nao e "faltam fundadoras" — o numero
   * delas e flexivel. E que a praca ainda nao foi aberta pela governanca.
   */
  FORMING: 'FORMING',
  /** Encerrada. Historico preservado, nada novo entra. */
  CLOSED: 'CLOSED',
} as const;
export type ClusterStatus = (typeof ClusterStatus)[keyof typeof ClusterStatus];

export type Cluster = {
  readonly id: ClusterId;
  /** Como a praca se chama para quem esta dentro: "Curitiba e Regiao". */
  readonly name: string;
  /** Identificador estavel e legivel: "curitiba-rmc". Vai em URL e em log. */
  readonly slug: string;
  readonly state: string;
  /**
   * Municipios atendidos. Nao e cerca — loja de fora pode ser credenciada se as
   * fundadoras quiserem. E a declaracao de alcance que torna o SLA honesto, e o
   * que a tela mostra a um candidato antes de ele se inscrever.
   */
  readonly cities: readonly string[];
  /**
   * Raio operacional declarado, em quilometros. Nao bloqueia nada: serve para
   * a governanca julgar candidatura ("essa loja fica a 180 km, o recall de 4h
   * vai falhar toda vez") e para o produto explicar por que a rede e local.
   */
  readonly operatingRadiusKm: number;
  readonly status: ClusterStatus;
  readonly foundedAt: Instant;
  /**
   * Fim da janela de fundacao. Quem for credenciado antes deste instante entra
   * como FUNDADORA; depois, como membro comum.
   *
   * A janela existe porque o numero de fundadoras e deliberadamente flexivel —
   * idealmente dez, podem ser menos. Fixar a contagem obrigaria a rede a
   * escolher entre esperar a decima loja (adiando o piloto por quem talvez
   * nunca venha) e recusar a nona (perdendo quem ja estava dentro). A data
   * resolve os dois: quem entrar na janela, leva. Vantagem lateral, e nao
   * pequena: a data e argumento de venda — o desconto de fundadora tem prazo
   * visivel, e prazo visivel fecha negocio.
   *
   * Consequencia direta no codigo: `founderCount` deixa de ser politica. O
   * numero de fundadoras passa a ser um fato do repositorio, contado, nunca
   * declarado.
   */
  readonly foundingWindowEndsAt: Instant;
};

const UF = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT',
  'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
] as const;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseClusterSlug(value: unknown): Result<string, DomainError> {
  const text = requireText(value, 'identificador do cluster', { min: 3, max: 60 });
  if (!text.ok) return text;
  const slug = text.value.toLowerCase();
  return SLUG_PATTERN.test(slug)
    ? ok(slug)
    : err(
        validationError(
          'CLUSTER_SLUG_INVALID',
          'identificador do cluster: use minusculas, numeros e hifen.',
          { received: text.value },
        ),
      );
}

export type ClusterDraft = {
  readonly name: string;
  readonly slug: string;
  readonly state: string;
  readonly cities: readonly string[];
  readonly operatingRadiusKm: number;
  /** Duracao da janela de fundacao, em dias corridos a partir da constituicao. */
  readonly foundingWindowDays: number;
};

export function parseClusterDraft(input: unknown): Result<ClusterDraft, DomainError> {
  if (typeof input !== 'object' || input === null) {
    return err(validationError('CLUSTER_REQUIRED', 'Dados do cluster sao obrigatorios.'));
  }
  const raw = input as Record<string, unknown>;
  const state = typeof raw['state'] === 'string' ? raw['state'].toUpperCase() : raw['state'];

  return combine({
    name: requireText(raw['name'], 'nome do cluster', { min: 3, max: 120 }),
    slug: parseClusterSlug(raw['slug']),
    state: requireOneOf(state, 'UF', UF),
    cities: parseCities(raw['cities']),
    operatingRadiusKm: parseRadius(raw['operatingRadiusKm']),
    foundingWindowDays: parseFoundingWindow(raw['foundingWindowDays']),
  });
}

function parseCities(value: unknown): Result<readonly string[], DomainError> {
  if (!Array.isArray(value) || value.length === 0) {
    return err(
      validationError('CLUSTER_CITIES_REQUIRED', 'Informe ao menos um municipio atendido.'),
    );
  }
  const cities: string[] = [];
  for (const item of value) {
    const city = requireText(item, 'municipio', { min: 2, max: 120 });
    if (!city.ok) return city;
    cities.push(city.value);
  }
  return ok(cities);
}

/**
 * Teto de 300 km. Nao e arbitrario: acima disso, ida e volta nao cabem no dia
 * util, e o SLA de recall de 4 horas passa a ser uma promessa que a operacao
 * nao tem como cumprir. Um cluster maior que isso nao e um cluster — sao dois.
 */
export const MAX_OPERATING_RADIUS_KM = 300;

function parseRadius(value: unknown): Result<number, DomainError> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return err(
      validationError('CLUSTER_RADIUS_INVALID', 'Raio operacional: informe km em numero positivo.'),
    );
  }
  if (value > MAX_OPERATING_RADIUS_KM) {
    return err(
      validationError(
        'CLUSTER_RADIUS_TOO_LARGE',
        `Raio operacional acima de ${MAX_OPERATING_RADIUS_KM} km: a custodia fisica e o SLA de ` +
          'recall deixam de ser cumpriveis. Abra um segundo cluster.',
        { received: value, max: MAX_OPERATING_RADIUS_KM },
      ),
    );
  }
  return ok(Math.round(value));
}

/**
 * Noventa dias. Curto o bastante para ser argumento ("a condicao de fundadora
 * acaba em marco") e longo o bastante para caber um ciclo de conversa com as
 * lojas que ainda estao decidindo. O teto de um ano existe para impedir o unico
 * erro grave possivel aqui: uma janela tao larga que a rede inteira acaba
 * fundadora e o desconto de adesao nunca vira receita cheia.
 */
export const DEFAULT_FOUNDING_WINDOW_DAYS = 90;
export const MAX_FOUNDING_WINDOW_DAYS = 365;

function parseFoundingWindow(value: unknown): Result<number, DomainError> {
  if (value === undefined || value === null) return ok(DEFAULT_FOUNDING_WINDOW_DAYS);
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return err(
      validationError(
        'FOUNDING_WINDOW_INVALID',
        'Janela de fundacao: informe os dias em numero inteiro positivo.',
        { received: value },
      ),
    );
  }
  if (value > MAX_FOUNDING_WINDOW_DAYS) {
    return err(
      validationError(
        'FOUNDING_WINDOW_TOO_LONG',
        `Janela de fundacao acima de ${MAX_FOUNDING_WINDOW_DAYS} dias: a condicao de fundadora ` +
          'deixa de ser excecao e a adesao cheia nunca entra.',
        { received: value, max: MAX_FOUNDING_WINDOW_DAYS },
      ),
    );
  }
  return ok(value);
}

export function transactsInCluster(cluster: Cluster): boolean {
  return cluster.status === ClusterStatus.ACTIVE;
}

/**
 * A janela de fundacao ainda esta aberta?
 *
 * Estritamente menor: no instante exato do fim, a janela fechou. O limite tem
 * de cair de um lado so, ou duas lojas credenciadas no mesmo milissegundo
 * receberiam condicoes diferentes conforme a ordem de gravacao.
 */
export function withinFoundingWindow(cluster: Cluster, now: Instant): boolean {
  return now < cluster.foundingWindowEndsAt;
}

/** Quanto falta da janela, em dias corridos. Zero quando ja fechou. */
export function foundingWindowDaysLeft(cluster: Cluster, now: Instant): number {
  return Math.max(0, Math.ceil((cluster.foundingWindowEndsAt - now) / DAY));
}

// ---------------------------------------------------------------------------
// A fronteira
// ---------------------------------------------------------------------------

/** Qualquer coisa que pertenca a uma praca. Loja, veiculo, candidatura. */
export type ClusterScoped = { readonly clusterId: ClusterId };

export function sameCluster(a: ClusterScoped, b: ClusterScoped): boolean {
  return a.clusterId === b.clusterId;
}

/**
 * Guarda unica da fronteira. Responde 403 — e nao 404 — de proposito: o id que
 * chegou aqui ja foi resolvido por outra via, entao fingir inexistencia so
 * confundiria o suporte. O que nao pode vazar e o *conteudo*, e ele nao vaza:
 * a chamada para antes de qualquer serializacao.
 *
 * Onde a existencia do recurso tambem e segredo (negociacao de terceiro), a
 * camada de aplicacao ja responde 404 antes de chegar aqui.
 */
export function requireSameCluster(
  actor: ClusterScoped,
  target: ClusterScoped,
  what: string,
): Result<void, DomainError> {
  return sameCluster(actor, target)
    ? ok(undefined)
    : err(
        forbiddenError(
          'CROSS_CLUSTER',
          `${what} pertence a outra praca da rede. Estoque, custodia e governanca ` +
            'nao atravessam cluster.',
          { actorClusterId: actor.clusterId, targetClusterId: target.clusterId },
        ),
      );
}

export function describeCluster(cluster: Cluster): string {
  return `${cluster.name} (${cluster.cities.length} municipios, raio ${cluster.operatingRadiusKm} km)`;
}
