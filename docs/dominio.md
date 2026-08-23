# Modelo de domínio

Este documento descreve os agregados, as máquinas de estado e as invariantes.
Para o *porquê* de cada decisão, ver [`decisoes.md`](decisoes.md); para o
vocabulário, [`glossario.md`](glossario.md).

## Os agregados e suas fronteiras

| Agregado | Arquivo | Fronteira de consistência |
|---|---|---|
| `Vehicle` | `domain/vehicle/vehicle.ts` | com `CommercialLock` — ver abaixo |
| `CommercialLock` | `domain/lock/commercial-lock.ts` | com `Vehicle` |
| `CustodyTransfer` | `domain/custody/custody.ts` | próprio, referencia `Vehicle` |
| `Recall` | `domain/recall/recall.ts` | próprio |
| `Deal` | `domain/deal/deal.ts` | próprio |
| `MembershipApplication` | `domain/network/membership.ts` | próprio |
| `ShareLink` | `domain/sharing/share-link.ts` | próprio |

**Veículo e trava são uma única fronteira.** Não existe estado válido em que o
veículo esteja `LOCKED` e a trava, expirada. Por isso as transições devolvem os
dois juntos (`VehicleWithLock`) e precisam ser persistidas na mesma operação.
Num adaptador de banco real, isso é uma transação explícita.

## Veículo: dois eixos independentes

```
                    ┌─────────────────────────────────────┐
                    │              Vehicle                │
                    ├─────────────────────────────────────┤
   quem pode        │  commercialStatus                   │
   vender, e        │  activeLockId                       │   muda em minutos
   até quando       │  pricing { publicPrice, netPrice }  │
                    │  pendingNetPrice                    │
                    ├─────────────────────────────────────┤
   quem está        │  physical {                         │
   com o carro,     │    state, custodianStoreId,         │   muda em dias
   e desde quando   │    inboundStoreId, since            │
                    │  }                                  │
                    └─────────────────────────────────────┘
```

Nenhuma transição de um bloco altera o outro. A única exceção é
`deliverToConsumer`, a entrega ao comprador final, que encerra os dois.

### Eixo comercial

```
                 laudo aprovado
    DRAFT ──────────────────────► AVAILABLE ◄──────────┐
      ▲                            │   ▲               │
      │ laudo vence/reprova        │   │               │ trava expira
      └────────────────────────────┘   │               │ ou é liberada
                                       │               │
                          openLock     │               │
                                       ▼               │
                                    LOCKED ────────────┘
                                       │
                                       │ deal confirmado
                                       ▼
                                     SOLD
                                       │
    WITHDRAWN ◄── retirada pela dona   │ (terminal)
    (reversível via relist)            ▼
```

- `DRAFT` — ingerido, sem laudo cautelar aprovado e vigente. Não circula.
- `AVAILABLE` — ofertado a toda a rede. **Pode estar no pátio de outra loja.**
- `LOCKED` — trava ativa. Congelado para todos, inclusive para a dona.
- `SOLD` — vendido ao consumidor. Sai do estoque da rede.
- `WITHDRAWN` — retirado pela dona (venda no balcão, uso interno, leilão).

### Eixo físico

```
    AT_YARD ──── openTransfer ────► IN_TRANSIT ──── checkIn ────► AT_YARD
       │                                │                        (no destino)
       │                                │
       │                          cancelTransfer
       │                                │
       │◄───────────────────────────────┘
       │
       └──── deliverToConsumer ────► DELIVERED_TO_CONSUMER (terminal)
```

Em `IN_TRANSIT`, `custodianStoreId` continua sendo a **origem**. Quem ainda não
conferiu o carro não herda o risco dele.

## Trava comercial

```
                    openLock
                       │
                       ▼
    ┌──────────────► ACTIVE ──────────────┬─────────────┐
    │                  │                  │             │
    │  extendLock      │  expiresAt       │ releaseLock │ convertLockToDeal
    │  (+ evidência)   │  alcançado       │ (detentor)  │ (deal confirmado)
    └──────────────────┤                  │             │
                       ▼                  ▼             ▼
                    EXPIRED            RELEASED     CONVERTED
```

Invariantes:

- só o detentor estende ou libera; **a dona não cancela trava de terceiro** —
  para reaver o carro ela usa recall, que respeita o prazo;
- trava expirada **não ressuscita**: enquanto ela estava vencida o carro estava
  livre e outra loja pode ter fechado;
- extensão exige evidência com cota por tipo, e as fortes exigem anexo;
- teto absoluto de 5 dias desde a abertura, calibrado para efetivamente
  vincular (a soma de todas as extensões possíveis daria 160h);
- `netPriceSnapshot` é congelado na abertura e nunca muda.

Ao encerrar por expiração ou liberação, `settleCommercialStatusAfterLock`
decide para onde o veículo volta:

| Condição | Destino |
|---|---|
| normal | `AVAILABLE` |
| laudo venceu ou foi reprovado durante a trava | `DRAFT` |
| sumiu do feed **e** está no pátio da dona | `WITHDRAWN` |
| sumiu do feed **mas** está no pátio de terceiro | `AVAILABLE` + sinalizado |

E o preço líquido represado (`pendingNetPrice`) passa a valer.

## Recall

```
                        requestRecall
                             │
              trava ativa ───┴─── sem trava
              de terceiro         (ou trava da própria dona)
                    │                    │
                    ▼                    ▼
       WAITING_LOCK_RELEASE ──────────► DUE ──────────► FULFILLED
              │        (trava cai;       │  (check-in no       ▲
              │         SLA começa       │   pátio da dona)    │
              │         AGORA)           │                     │
              │                          │  now > dueAt        │
              │                          ├──► breachedAt marcado
              │                          │    (segue DUE)      │
              ▼                          ▼                     │
          CANCELLED ◄──────────────── CANCELLED ────────────────┘
       (venda fechou:                (desistência da dona)
        SUPERSEDED_BY_SALE)
```

A regra de prioridade está isolada em `resolvePriority(vehicle, lock, now)` —
função pura, sem repositório e sem relógio real:

| Trava ativa de terceiro? | Prioridade |
|---|---|
| sim | detentor da trava, até `expiresAt` |
| não | loja proprietária |
| trava da própria dona | loja proprietária |

`fulfillRecall` encerra o recall mesmo em atraso, mas registra o atraso em
minutos úteis. `flagBreachIfOverdue` marca o descumprimento **uma única vez**,
apesar de o varredor rodar a cada minuto.

## Custódia

```
  InspectionTerm (selado com SHA-256)
  ├── odometerKm, fuelEighths
  ├── photos[]      ← exige FRONT, REAR, LEFT, RIGHT, ODOMETER
  ├── damages[]
  ├── observations, geolocation
  └── signature { nome, CPF validado, função, storeId, termHash, signedAt }
```

`verifyTerm` recalcula o hash sobre o conteúdo (sem a assinatura) e compara. O
hash é estável quanto à ordem de fotos e avarias, então reordenar não é
adulteração — mas trocar uma URL ou baixar o odômetro é.

### Divergências detectadas no check-in

| Tipo | Regra |
|---|---|
| `ODOMETER` | rodagem > 80 km, ou odômetro menor que na saída |
| `FUEL` | queda maior que 1 oitavo |
| `NEW_DAMAGE` | avaria cuja área não constava na saída (comparação sem acento e sem caixa) |

### Livro de custódia

Derivado dos termos **concluídos**, não armazenado. Termos cancelados e termos
ainda abertos não movem responsabilidade.

```
    |────── Loja A ──────|────── Loja B ──────|──── Loja C ────►
    criação            check-in            check-in         em curso
                       na Loja B           na Loja C
```

Intervalo semiaberto `[from, to)`: o instante exato do check-in já pertence ao
destino, para não existir microssegundo com dois responsáveis.

`attributeInfraction(ledger, instant)` não adivinha fora do intervalo conhecido
— infração anterior à entrada do veículo na rede ou posterior à entrega ao
consumidor volta como não resolvida.

## Negociação de repasse

```
                    openDeal
                       │
        transbordo?  ──┴──  não
             │                │
             ▼                ▼
  AWAITING_TRADE_IN ──────► DRAFT ──── confirmDeal ────► CONFIRMED
   _ACCEPTANCE      aceite                                   │
        │           ou recusa                    registerSettlement
        │                                                    │
        └──────────► CANCELLED ◄────── cancelDeal            ▼
                     (só antes de haver dinheiro)         SETTLED
                                                             │
                                            registerAtpv ────┤──── markDelivered
                                                             │
                                          (quando ambos) ────▼
                                                         COMPLETED
```

`confirmDeal` com `cashDueToOwner == 0` (o transbordo cobriu o líquido inteiro)
já nasce `SETTLED`.

A ordem entre ATPV-e e entrega não importa; `COMPLETED` exige os dois.

### Cálculo financeiro

```
cashFromConsumer     = retailPrice − tradeInAllowance
tradeInCreditToOwner = transbordo ? acceptedValue : 0
cashDueToOwner       = netPrice − tradeInCreditToOwner
sellerGrossMargin    = retailPrice − netPrice
sellerTradeInResult  = (transbordo ? acceptedValue : appraisedValue) − allowance
sellerTotalResult    = sellerGrossMargin + sellerTradeInResult
```

Regras que a conta impõe:

- `cashDueToOwner ≥ 0` — troca acima do líquido faria a Loja A dever dinheiro à
  Loja B; a operação é recusada com a sugestão de separar em duas;
- `tradeInAllowance ≤ retailPrice`;
- `retailPrice < netPrice` é **permitido** (autonomia da Loja B, que pode
  aceitar prejuízo no seminovo para ganhar no giro da troca) mas emite
  `deal.selling_below_net_price`;
- liquidação parcial é aceita; nenhuma parcela pode exceder o saldo aberto;
- cancelamento só antes de haver qualquer liquidação registrada.

## Credenciamento

```
     openApplication
          │
          ▼
       PENDING ──── 3º aval ────► APPROVED ──── admitApprovedStore ──► loja MEMBER
          │
          ├──── 4º voto contrário ────► REJECTED
          │
          └──── withdrawApplication ──► WITHDRAWN
```

- só o titular (`PRINCIPAL`) de loja fundadora ativa vota;
- um voto por fundadora, substituível enquanto a decisão não saiu;
- a loja padrinho não vota na própria indicação;
- limiar de reprovação = `founderCount − requiredApprovals + 1` = 4.

Aprovar e credenciar são funções separadas de propósito: aprovar é ato de
governança, credenciar é provisionamento. Se a criação da loja falhar, a decisão
dos fundadores permanece registrada e o provisionamento pode ser repetido sem
nova votação.

## Eventos de domínio

Toda transição emite evento; a trilha de auditoria é derivada deles, não escrita
à mão em cada serviço.

| Prefixo | Exemplos |
|---|---|
| `vehicle.*` | `listed`, `unlisted`, `withdrawn`, `available_again`, `net_price_changed`, `net_price_deferred` |
| `lock.*` | `opened`, `extended`, `expired`, `released`, `converted` |
| `custody.*` | `checked_out`, `checked_in`, `discrepancies_found`, `transfer_cancelled`, `delivered_to_consumer` |
| `recall.*` | `requested`, `sla_started`, `fulfilled`, `sla_breached`, `superseded_by_sale`, `cancelled` |
| `deal.*` | `opened`, `trade_in_accepted`, `confirmed`, `settlement_registered`, `settled`, `atpv_registered`, `completed` |
| `feed.*` | `vehicle_created`, `vehicle_updated`, `vehicle_missing`, `duplicate_vin_detected` |
| `membership.*` | `application_opened`, `vote_cast`, `application_approved`, `application_rejected` |
| `sharing.*` | `link_created`, `link_revoked` |
| `network.*` | `store_admitted` |

Os que uma integração de notificação deveria assinar primeiro:
`lock.expired` e `vehicle.available_again` (o carro voltou à rede),
`recall.requested` e `recall.sla_breached` (alguém precisa agir),
`deal.trade_in_acceptance_requested` (a Loja A está segurando um fechamento).
