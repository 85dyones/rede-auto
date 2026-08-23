/**
 * Evidencias de avanco no funil e a extensao de prazo que cada uma concede.
 *
 * A trava padrao dura 4 horas porque esse e o tempo de um atendimento quente.
 * Estende-la exige EVIDENCIA, nunca so vontade: sem essa exigencia, a extensao
 * viraria o caminho normal e a trava deixaria de ser um compromisso de venda
 * para virar reserva indefinida de estoque alheio.
 *
 * A escala de prazo segue a irreversibilidade do passo no funil. Uma avaliacao
 * de troca enviada quase nao compromete o cliente (+2h); um contrato assinado
 * compromete quase tudo (+72h).
 */

import type { Instant } from '../shared/clock.ts';
import { HOUR } from '../shared/clock.ts';

export const EvidenceType = {
  /** Avaliacao do carro de troca registrada e enviada ao cliente. */
  TRADE_IN_APPRAISAL: 'TRADE_IN_APPRAISAL',
  /** Ficha enviada ao banco, proposta em analise. */
  BANK_PROPOSAL_SUBMITTED: 'BANK_PROPOSAL_SUBMITTED',
  /** Credito aprovado pelo banco. */
  BANK_PROPOSAL_APPROVED: 'BANK_PROPOSAL_APPROVED',
  /** Comprovante de sinal / entrada do cliente. */
  DEPOSIT_RECEIPT: 'DEPOSIT_RECEIPT',
  /** Pedido ou contrato de compra e venda assinado. */
  SIGNED_ORDER: 'SIGNED_ORDER',
} as const;
export type EvidenceType = (typeof EvidenceType)[keyof typeof EvidenceType];

export type EvidenceGrant = {
  readonly label: string;
  readonly extensionMs: number;
  /** Quantas vezes a mesma evidencia pode esticar a mesma trava. */
  readonly maxUses: number;
  /** Exige anexo (PDF/foto do comprovante) alem da declaracao do vendedor. */
  readonly requiresAttachment: boolean;
};

export type LockPolicy = {
  /** Prazo inicial da trava. 4 horas, por contrato de rede. */
  readonly baseTtlMs: number;
  /**
   * Teto absoluto contado da abertura da trava. Mesmo somando evidencias, uma
   * negociacao nao segura um carro da rede indefinidamente.
   *
   * Precisa ser MENOR que a soma de todas as extensoes possiveis, senao nunca
   * vincula e vira decoracao. Com as concessoes atuais essa soma e de 160h
   * (4 + 72 + 48 + 24 + 4x2 + 2x2), entao o teto de 120h realmente corta.
   */
  readonly maxTotalMs: number;
  readonly grants: Readonly<Record<EvidenceType, EvidenceGrant>>;
};

export const DEFAULT_LOCK_POLICY: LockPolicy = {
  baseTtlMs: 4 * HOUR,
  maxTotalMs: 5 * 24 * HOUR,
  grants: {
    [EvidenceType.TRADE_IN_APPRAISAL]: {
      label: 'Avaliacao do veiculo de troca',
      extensionMs: 2 * HOUR,
      maxUses: 2,
      requiresAttachment: false,
    },
    [EvidenceType.BANK_PROPOSAL_SUBMITTED]: {
      label: 'Proposta bancaria em analise',
      extensionMs: 4 * HOUR,
      maxUses: 2,
      requiresAttachment: false,
    },
    [EvidenceType.BANK_PROPOSAL_APPROVED]: {
      label: 'Credito aprovado pelo banco',
      extensionMs: 24 * HOUR,
      maxUses: 1,
      requiresAttachment: true,
    },
    [EvidenceType.DEPOSIT_RECEIPT]: {
      label: 'Comprovante de sinal',
      extensionMs: 48 * HOUR,
      maxUses: 1,
      requiresAttachment: true,
    },
    [EvidenceType.SIGNED_ORDER]: {
      label: 'Pedido assinado pelo cliente',
      extensionMs: 72 * HOUR,
      maxUses: 1,
      requiresAttachment: true,
    },
  },
};

export type Evidence = {
  readonly type: EvidenceType;
  /**
   * Referencia do comprovante: numero da proposta, id do documento assinado.
   * Nao guardamos dado pessoal do cliente final aqui — a rede e B2B e a Loja B
   * e quem responde pelo relacionamento com o consumidor (CDC).
   */
  readonly reference: string | null;
  readonly attachmentUrl: string | null;
  readonly note: string | null;
};

export function grantFor(policy: LockPolicy, type: EvidenceType): EvidenceGrant {
  return policy.grants[type];
}

export function describeExpiry(expiresAt: Instant, now: Instant): string {
  const remaining = expiresAt - now;
  return remaining <= 0 ? 'expirada' : `expira em ${Math.round(remaining / HOUR * 10) / 10}h`;
}
