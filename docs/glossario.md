# Glossário

Vocabulário do negócio e o identificador correspondente no código. O código usa
inglês na estrutura e português nos termos que não têm tradução útil.

## Papéis

| Termo | No código | O que é |
|---|---|---|
| Loja A / loja proprietária | `ownerStoreId` | dona do veículo. Fixa o preço líquido, emite o ATPV-e. A titularidade nunca muda de mão entre lojistas. |
| Loja B / loja vendedora | `sellingStoreId` | assume o cliente final por inteiro: atendimento, financiamento, carro de troca e a garantia legal do CDC. |
| Loja custodiante | `custodianStoreId` | quem está com o carro no pátio agora, e responde por multa, avaria e sinistro. Pode ser qualquer uma das duas. |
| Loja fundadora | `StoreKind.FOUNDER` | uma das 6 constituintes. Única com direito a voto no credenciamento. |
| Loja membro | `StoreKind.MEMBER` | credenciada depois, por aval dos fundadores. Opera igual, mas não vota. |
| Padrinho | `sponsorStoreId` | loja que apresentou a candidatura. Não vota na própria indicação. |
| Titular | `UserRole.PRINCIPAL` | quem vota credenciamento, além de tudo que o gerente faz. |
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
