# Glossário

Vocabulário do negócio e o identificador correspondente no código. O código usa
inglês na estrutura e português nos termos que não têm tradução útil.

## Praça

| Termo | No código | O que é |
|---|---|---|
| Praça / cluster | `Cluster` | a rede local. Estoque, custódia, travas, negociação e governança não atravessam a fronteira. |
| Praça do piloto | `curitiba-rmc` | Curitiba e Região: 10 municípios, raio operacional declarado de 60 km, 10 fundadoras no seed. |
| Raio operacional | `operatingRadiusKm` | alcance declarado da praça. Não bloqueia nada — informa a governança e explica por que a rede é local. |
| Alcançável | `EndorsementTally.reachable` | se ainda sobram fundadoras suficientes para fechar os três endossos. `false` avisa na abertura o que, sem ele, só apareceria como caducidade 30 dias depois. |
| Janela de fundação | `foundingWindowEndsAt` | prazo em que uma loja credenciada ainda nasce fundadora (meia adesão). 90 dias por padrão, teto de um ano. Quem entrar na janela, leva. |
| Teto de raio | `MAX_OPERATING_RADIUS_KM` | 300 km. Acima disso ida e volta não cabem no dia útil e o SLA de recall deixa de ser cumprível. |
| Fronteira | `requireSameCluster` | a guarda única. Veículo de outra praça responde 404; alvo já identificado por outra via, 403. |

## Papéis

| Termo | No código | O que é |
|---|---|---|
| Loja A / loja proprietária | `ownerStoreId` | dona do veículo. Fixa o preço líquido, emite o ATPV-e. A titularidade nunca muda de mão entre lojistas. |
| Loja B / loja vendedora | `sellingStoreId` | assume o cliente final por inteiro: atendimento, financiamento, carro de troca e a garantia legal do CDC. |
| Loja custodiante | `custodianStoreId` | quem está com o carro no pátio agora, e responde por multa, avaria e sinistro. Pode ser qualquer uma das duas. |
| Empresa / membro | `Member` | a contratante. Paga, é fundadora, endossa e é suspensa por inadimplência. Identificada pela raiz do CNPJ. |
| Loja / pátio | `Store` | onde o carro fica. Custódia, estoque, trava, vistoria. Pertence a uma empresa (`memberId`). |
| Raiz do CNPJ | `cnpjRoot` | os 8 primeiros dígitos. Filial compartilha a raiz e difere na ordem — é o que torna "mesma empresa?" verificável. |
| Adesão | `ChargeKind.ADHESION` | R$ 6.000, metade para fundadora. Uma vez por empresa, não é caução, não volta. |
| Mensalidade | `ChargeKind.MONTHLY` | R$ 599 por empresa com a 1ª loja inclusa + R$ 159 por loja adicional. Sem taxa por transação. |
| Congelamento | `FOUNDER_FREEZE_MONTHS` | 24 meses em que a fundadora fica na tabela que assinou — a tabela inteira, inclusive a linha do pátio adicional. |
| Inadimplência | `isDelinquent` | 30 dias na cobrança aberta mais atrasada (nunca a soma). Suspende a empresa e, com ela, todos os pátios. |
| Empresa fundadora | `MemberKind.FOUNDER` | credenciada **dentro da janela de fundação**. Única que endossa, e só na própria praça (`isFoundingMemberOf`). Quantas existem se conta, não se declara. |
| Empresa membro | `MemberKind.MEMBER` | credenciada depois de fechada a janela. Opera igual, mas não endossa. |
| Padrinho | `sponsorMemberId` | empresa que apresentou a candidatura. Não endossa a própria indicação, nem pela filial. |
| Titular | `UserRole.PRINCIPAL` | quem endossa credenciamento, além de tudo que o gerente faz. |
| Gerente | `UserRole.MANAGER` | preço líquido, aceite de transbordo, recall, assinatura de custódia. |
| Vendedor | `UserRole.SALESPERSON` | abre e estende travas, monta negociação, baixa material. |

## Comercial

| Termo | No código | O que é |
|---|---|---|
| Repasse | `Deal` | a operação de compra B2B casada com a venda B2C. |
| Preço líquido de repasse | `pricing.netPrice` | o que a Loja A exige receber. É **ela** quem define. Nunca sai no material. |
| Preço público | `pricing.publicPrice` | preço de vitrine da dona. Referência; não vincula a Loja B. |
| Trava comercial | `CommercialLock` | exclusividade temporária de 4h sobre um veículo. Vale contra todos, inclusive a dona. |
| TTL da trava | `lock.expiresAt` | o prazo. Estender exige evidência de avanço no funil. |
| Preço travado | `netPriceSnapshot` | líquido congelado na abertura da trava. É por ele que a Loja B fecha. |
| Preço represado | `pendingNetPrice` | reprecificação da dona feita durante uma trava. Só vale quando a trava cair. |
| Margem excedente | `sellerPrivate.grossMargin` | `preço ao consumidor − líquido`. 100% da Loja B — e invisível para a dona. |
| Estoque avançado | `isOnExtendedCustody` | veículo comercialmente disponível a toda a rede, mas fisicamente no pátio de outra loja. |
| Oportunidade de balcão | — | o que o carro vira para a loja custodiante quando a trava expira: ele está na vitrine dela e livre para travar de novo. |

## Troca

| Termo | No código | O que é |
|---|---|---|
| Postura de troca | `TradeInPolicy` | declarada pela dona no cadastro: ela avalia carro na troca neste veículo, ou só dinheiro. |
| Aceita avaliar | `CONSIDERS` | a dona olha o carro. **Não é promessa de aceite** — o transbordo segue caso a caso. |
| Só dinheiro | `CASH_ONLY` | o transbordo é recusado na abertura da negociação, antes do trabalho. |
| Padrão da loja | `Store.tradeInDefault` | o que o veículo que entra pelo feed herda; o XML do integrador não tem esse campo. |

## Trade-in

| Termo | No código | O que é |
|---|---|---|
| Carro de troca | `TradeIn` | o usado que o cliente final entrega na negociação. |
| Cenário padrão | `TradeInDestination.SELLER_STOCK` | a Loja B fica com a troca e paga a Loja A 100% em dinheiro. |
| Transbordo | `TradeInDestination.OWNER_STORE` | a Loja B oferta a troca à Loja A, que abate o valor do líquido. Exige aceite explícito antes do fechamento. |
| Valor dado na troca | `allowanceToConsumer` | quanto foi creditado ao cliente. Abate o preço de venda. |
| Avaliação | `appraisedValue` | quanto a Loja B avalia o usado de fato. A diferença para o valor dado é o giro da troca. |
| Valor aceito | `ownerAcceptance.acceptedValue` | quanto a Loja A aceitou pagar pelo usado, no transbordo. |

## Custódia

| Termo | No código | O que é |
|---|---|---|
| Termo de custódia | `CustodyTransfer` | o documento de uma movimentação de pátio. Tem dois lados. |
| Vistoria | `InspectionTerm` | odômetro, combustível, fotos, avarias e assinatura, selados com SHA-256. |
| Saída / checkout | `openTransfer` | assinada pela loja que está com o carro. |
| Entrada / check-in | `checkIn` | assinada pela loja de destino. **É aqui que a responsabilidade civil muda.** |
| Divergência | `Discrepancy` | diferença entre saída e entrada: rodagem, combustível ou avaria nova. |
| Livro de custódia | `CustodyPeriod[]` | linha do tempo derivada dos termos concluídos. Responde quem respondia pelo carro em cada instante. |

## Recall

| Termo | No código | O que é |
|---|---|---|
| Recall | `Recall` | chamada de retorno do veículo pela loja proprietária. |
| SLA | `slaBusinessHours` | 4 horas **úteis** para liberar o retorno, contadas no calendário da rede. |
| Aguardando trava | `WAITING_LOCK_RELEASE` | recall aceito mas represado: há trava ativa de terceiro e o prazo ainda não corre. |
| Quem leva | `fulfilment` | de quem é o transporte. Muda o que o prazo mede — e, portanto, de quem é a obrigação. |
| Custodiante entrega | `CUSTODIAN_DELIVERS` | modalidade padrão: quem está com o carro leva até o pátio da dona. 4h úteis. |
| Quem chamou retira | `REQUESTER_COLLECTS` | o escape: quem pediu vai buscar. O prazo passa a medir só deixar o carro disponível — 1h útil. |
| Disponível para retirada | `READY_FOR_PICKUP` | o custodiante deixou o carro pronto. O relógio para e a obrigação dele acaba aqui. |
| Minutos pausados | `pausedRemainingMinutes` | o que sobrava do prazo quando o relógio parou. Se a retirada frustrar, retoma daí — não reinicia. |
| Superado pela venda | `SUPERSEDED_BY_SALE` | a negociação travada fechou. Não há o que devolver: o carro virou dinheiro. |

## Documentação e qualificação

| Termo | No código | O que é |
|---|---|---|
| Laudo cautelar | `InspectionReport` | vistoria de procedência. Sem laudo aprovado e vigente o veículo não circula na rede. |
| ATPV-e | `AtpvEmission` | Autorização para Transferência de Propriedade de Veículo, eletrônica. Emitida pela loja proprietária ao comprador final. |
| Placa Mercosul | `PLATE_MERCOSUL` | `ABC1D23`. O formato antigo (`ABC1234`) também é aceito. |
| Chassi / VIN | `chassis` | 17 caracteres, sem I, O ou Q. Chave de deduplicação da rede. |
| Material de divulgação | `MaterialKit` | fotos neutras + ficha + laudo que a parceira baixa para usar no canal dela. |
| Fotos neutras | `neutralPhotos` | conjunto curado pela dona, sem placa, adesivo ou fachada. O único que circula. |
| Ficha neutra | `NeutralSpecSheet` | ficha técnica sem nenhuma identificação de loja. Nasce sem preço. |
| Feed | `ParsedFeed` | XML de estoque publicado pelo integrador da loja. |
