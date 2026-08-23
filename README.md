# rede-auto

Rede B2B fechada para **compartilhamento de estoque e custódia física de
veículos seminovos** entre lojistas parceiros.

Hoje o repasse entre lojas é combinado por telefone: o gerente da Loja B liga
para a Loja A, negocia margem, confirma se o carro ainda está disponível e
improvisa a logística. Esta plataforma digitaliza essa dinâmica com uma regra
que não existe no telefone — **exclusividade temporária garantida por sistema** —
e elimina o risco que ela cria: duas lojas vendendo o mesmo carro.

```bash
npm install
npm start        # sobe a API em http://localhost:3000 com a rede semeada
npm run demo     # roteiro narrado: a operação inteira em milissegundos
npm run check    # typecheck estrito + 310 testes
```

## A ideia central: físico e comercial são eixos independentes

Esta é a nuance que define o produto, e o motivo de o modelo de dados não se
parecer com o de um ERP de estoque.

Um ERP amarra "onde o carro está" a "quem pode vendê-lo". Aqui os dois eixos
correm soltos:

```
              EIXO COMERCIAL                     EIXO FÍSICO
              (muda em minutos)                  (muda em dias)

              DISPONÍVEL ──┐                     Pátio da Loja A
                           │                            │
              EM NEGOCIAÇÃO┤  ← trava de 4h              │ termo de vistoria
              (trava ativa)│                            ▼
                           │                     Pátio da Loja B
              VENDIDO ─────┘                     (estoque avançado)
```

O caso que justifica tudo: a Loja B leva o carro para o showroom dela, o cliente
desiste, a trava expira. O carro volta a ser ofertado a **toda a rede** — e não
sai do lugar. Não há frete de devolução, e para a Loja B ele virou uma
oportunidade de balcão, porque continua na vitrine dela.

Nenhuma transição de um eixo altera o outro. A única exceção é a entrega ao
comprador final, que encerra os dois.

## Como o dinheiro funciona

A Loja A (dona do carro) fixa um **preço líquido de repasse**: o valor que ela
exige receber. A Loja B assume o cliente final por inteiro — atendimento, ficha
de financiamento, carro de troca, e a garantia legal do CDC — e precifica ao
consumidor pelo valor que quiser.

```
  Preço ao consumidor        R$ 96.900,00     ← autonomia total da Loja B
  (−) valor dado na troca    R$ 42.000,00
  = dinheiro do cliente      R$ 54.900,00

  Líquido devido à Loja A    R$ 89.000,00     ← fixado por ela, não negociado
  (−) crédito do transbordo  R$ 41.000,00
  = dinheiro a transferir    R$ 48.000,00

  Margem da Loja B           R$  7.900,00     ← 100% dela, sem rateio
```

Não há comissão sobre margem e não há rateio. É essa simplicidade que remove a
negociação por telefone que o produto existe para eliminar.

O carro de troca tem dois destinos:

- **Padrão** — a Loja B fica com ele no próprio pátio (lucra na venda e no giro
  da troca) e paga a Loja A 100% em dinheiro.
- **Transbordo** — a Loja B não trabalha com aquele modelo e oferta o usado à
  Loja A, que abate o valor aceito do líquido. Exige **aceite explícito da Loja
  A antes do fechamento**: sem isso, a Loja B daria um valor ao cliente sem
  saber se alguém o honra.

## As quatro regras que sustentam a rede

### 1. Trava comercial com prazo de 4 horas

Ao iniciar um atendimento quente, o vendedor da Loja B trava o veículo. Durante
o prazo ninguém mais reserva ou vende — **nem a loja dona**. Sem essa
exclusividade valendo contra todos, a Loja B não teria como prometer o carro ao
cliente que está na frente dela.

Estender exige **evidência de avanço no funil**, nunca só vontade:

| Evidência | Prazo somado | Usos | Anexo |
|---|---|---|---|
| Avaliação da troca enviada | +2h | 2 | não |
| Proposta bancária em análise | +4h | 2 | não |
| Crédito aprovado | +24h | 1 | sim |
| Comprovante de sinal | +48h | 1 | sim |
| Pedido assinado | +72h | 1 | sim |

Teto absoluto: 5 dias desde a abertura. O teto é menor que a soma de todas as
extensões possíveis (160h) de propósito — um teto inalcançável seria decoração.

Ao expirar, **não há carência nem prioridade residual**: primeiro a travar leva,
inclusive a loja que acabou de perder o prazo.

### 2. Recall: quem manda depende do status comercial, nunca do físico

| Situação | Quem tem prioridade |
|---|---|
| Carro no pátio da Loja B, **comercialmente disponível** | Loja A, total. SLA de **4 horas úteis** para liberar o retorno. |
| Carro no pátio da Loja B, **com trava ativa** | Loja B, exclusiva, até o timer zerar. O recall é aceito mas **aguarda**. |

Quando a trava cai, o SLA começa **dali** — não retroage ao pedido. Cobrar
retroativo puniria a Loja B por ter respeitado a própria trava.

Se a negociação travada **fechar**, o recall é cancelado: não há o que devolver,
o carro virou dinheiro — que era o objetivo de todos desde o início.

O SLA é contado em horas **úteis** de verdade: fuso de São Paulo, segunda a
sexta 08:00–18:00, sábado 09:00–13:00, feriados nacionais incluindo os móveis
derivados da Páscoa. Um pedido feito sexta às 17h vence segunda de manhã, não às
2h da madrugada de domingo.

### 3. Custódia: o termo tem dois lados, e a responsabilidade muda no segundo

A cada movimentação de pátio, um termo digital com fotos dos quatro ângulos mais
o odômetro, nível de combustível, avarias e assinatura do responsável (com CPF
validado).

```
  SAÍDA  ─── assinada pela loja que ESTÁ com o carro ───┐
                                                        │  em trânsito:
                                                        │  responsabilidade
                                                        │  continua na origem
  ENTRADA ── assinada pela loja de DESTINO ─────────────┘
             ▲
             └── é AQUI que multa, avaria e sinistro mudam de mão
```

Quem ainda não conferiu o carro não herda o risco dele. O conteúdo do termo é
selado com SHA-256 no momento da assinatura: baixar o odômetro ou trocar uma
foto depois é detectável.

Divergências entre saída e entrada (rodagem além da tolerância, combustível a
menos, avaria que não constava) viram registro objetivo — a base de qualquer
conversa sobre quem paga o quê.

E o livro de custódia responde à pergunta que uma multa faz: **quem estava com o
carro em 12/03 às 14h32?**

### 4. Governança: 6 fundadoras, 3 avais

A rede é fechada. Uma loja nova precisa do aval de pelo menos 3 das 6
fundadoras. O terceiro aval já credencia — não há razão para segurar a entrada
esperando os outros três votarem.

A candidatura é **reprovada ao quarto voto contrário**, porque com 6 votos
disponíveis 3 avais tornam-se aritmeticamente impossíveis. A loja padrinho não
vota na própria indicação, e quem entra depois não vira fundador.

## Apresentação white-label

O vendedor da Loja B gera um link temporário com **o preço que ele pratica**,
sem nenhum traço da loja proprietária. Sai em JSON, HTML (responsivo, pronto
para imprimir) e PDF.

O que **não** aparece na lâmina, e por quê:

| Omitido | Motivo |
|---|---|
| Nome, CNPJ e contato da loja dona | o cliente atravessaria a Loja B |
| Preço líquido de repasse | revela a margem da Loja B |
| Placa completa e chassi | permitem consulta pública que devolve o proprietário |
| Número do laudo cautelar | consultável e rastreável até quem contratou |
| **URLs originais das fotos** | o domínio do CDN costuma ser o da própria loja |

A última é a que mais escapa: `cdn.primemotors.com.br/onix-1.jpg` entrega a
origem sem que ninguém perceba. As fotos são servidas pela plataforma; sem proxy
configurado, a lâmina sai **sem foto** em vez de vazar o domínio.

A sanitização é escrita como lista de **inclusão**, campo a campo — com spread
do agregado, todo campo novo passaria a vazar por padrão. E um guarda de runtime
varre a lâmina serializada antes de responder: se um termo proibido aparecer, a
requisição falha em vez de entregar a origem.

## Ingestão de estoque

Feeds XML dos integradores automotivos, com mapeadores para os padrões Revenda
Mais (snake_case, dados em filhos) e Motors (PascalCase, dados em atributos),
mais um genérico de último recurso.

> Os esquemas são **modelados a partir dos padrões públicos** desses
> integradores — não são a especificação oficial de nenhum deles. O desenho leva
> isso em conta: cada mapeador só declara nomes de tag, e ajustar para o XML
> real de um fornecedor significa acrescentar nomes a uma lista, não reescrever
> regra de negócio.

O que a sincronização **não** faz, e é o mais importante:

- **nunca move custódia física** — onde o carro está resulta de termos
  assinados, não de um XML publicado a cada 15 minutos;
- **nunca derruba negociação em andamento** — com trava ativa, ficha e fotos se
  atualizam, mas o preço líquido fica represado até a trava cair;
- **não retira da rede um carro que sumiu do feed mas está no pátio de outra
  loja** — isso costuma significar venda no balcão sem baixa, e alguém precisa
  combinar o retorno.

Chassi já anunciado por outra loja é recusado: é a duplicidade de venda que a
plataforma existe para impedir. E a operação é idempotente por hash de conteúdo
— rodar o mesmo feed duas vezes não escreve nada na segunda.

O parser XML é próprio e defensivo: rejeita `DOCTYPE` (corta XXE e *billion
laughs* de uma vez), só expande as cinco entidades predefinidas, e limita
tamanho, profundidade e número de nós.

## Arquitetura

```
src/
├── domain/          núcleo funcional puro: sem I/O, sem framework, sem relógio real
│   ├── shared/      Result, Money em centavos, Clock injetável, horas úteis, validação pt-BR
│   ├── network/     lojas, usuários, credenciamento por quórum
│   ├── vehicle/     o agregado central, com os dois eixos desacoplados
│   ├── lock/        trava comercial com TTL e política de evidências
│   ├── custody/     termo de vistoria assinado e livro de responsabilidade civil
│   ├── recall/      prioridade dono vs. custodiante e SLA em horas úteis
│   ├── deal/        repasse, trade-in, liquidação, ATPV-e
│   └── sharing/     link temporário e sanitização white-label
├── application/     casos de uso: carregam, decidem, persistem, publicam
├── infra/           adaptadores — persistência, feeds, PDF, autenticação, seed
├── http/            servidor, roteador, serialização
└── testing/         builders e fixtures compartilhados
```

**Zero dependências de runtime.** Só Node built-ins. As dev dependencies são
TypeScript e `@types/node`; os testes rodam no `node:test` e o TypeScript é
executado nativamente pelo Node 22 via *type stripping*.

Três decisões estruturam o resto:

**O domínio é funcional e puro.** Todo agregado é dado imutável; toda regra é
`(estado, comando) → Result<{estado', eventos}, erro>`. Testar "trava expirada
não pode ser estendida" não exige banco, relógio real nem servidor — é uma
chamada de função. E como o novo estado só existe no retorno, não há
meio-caminho persistido quando uma regra rejeita o comando.

**O tempo é injetado.** A trava de 4h, o SLA em horas úteis e a validade do link
são funções do tempo. Sem relógio injetável, esses comportamentos só poderiam
ser testados esperando de verdade — e o roteiro de demonstração não conseguiria
simular dois dias de operação em milissegundos.

**Dinheiro é inteiro.** Centavos, sempre. Uma diferença de 1 centavo entre o
líquido acordado e o valor liquidado vira disputa entre lojistas.

### Expiração da trava: preguiçosa e ativa

Materializada de duas formas, ambas pela mesma função idempotente do domínio:

- **preguiçosa**, em toda leitura do veículo — ninguém vê estado vencido, mesmo
  com o varredor parado;
- **ativa**, pelo varredor periódico — a rede é avisada de que o carro voltou a
  estar disponível sem depender de alguém abrir a tela.

O varredor garante *pontualidade*, não *correção*. Por isso ele pode falhar,
atrasar ou nem rodar sem produzir estado inválido.

## API

Autenticação por chave em `Authorization: Bearer <chave>`. As rotas `/s/*` da
lâmina white-label são públicas.

```
GET    /api/v1/veiculos                              catálogo da rede
GET    /api/v1/veiculos/no-meu-patio                 estoque avançado de terceiros
POST   /api/v1/veiculos/:id/trava                    abre a trava de 4h
POST   /api/v1/travas/:id/extensoes                  estende com evidência
POST   /api/v1/veiculos/:id/custodia/saidas          termo de saída
POST   /api/v1/custodia/termos/:id/entrada           termo de entrada (muda a responsabilidade)
GET    /api/v1/veiculos/:id/custodia/responsavel?em= quem respondia naquela data
POST   /api/v1/veiculos/:id/recall                   chamada de retorno
POST   /api/v1/veiculos/:id/negociacao               monta o repasse sobre a trava
POST   /api/v1/negociacoes/:id/confirmacao           fecha a venda
POST   /api/v1/veiculos/:id/entrega                  entrega ao comprador (encerra os dois eixos)
POST   /api/v1/veiculos/:id/compartilhamentos        gera o link white-label
POST   /api/v1/feeds/sincronizacao                   ingere o XML do integrador
GET    /api/v1/notificacoes                          mural de avisos da loja
GET    /s/:token/lamina.pdf                          lâmina em PDF (pública)
```

Referência completa em [`docs/api.md`](docs/api.md). O índice das rotas também
sai em `GET /api/v1`.

## Documentação

| | |
|---|---|
| [`docs/dominio.md`](docs/dominio.md) | modelo de domínio, máquinas de estado e invariantes |
| [`docs/api.md`](docs/api.md) | referência da API, com exemplos de requisição |
| [`docs/decisoes.md`](docs/decisoes.md) | decisões de projeto e o que foi descartado |
| [`docs/glossario.md`](docs/glossario.md) | vocabulário do negócio ↔ identificadores no código |

## Estado do projeto

Implementado e testado: todo o domínio, os casos de uso, a API HTTP, a ingestão
de feeds, a lâmina em três formatos e a trilha de auditoria. 310 testes,
typecheck estrito (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
`erasableSyntaxOnly`) sem erros.

O que um piloto com lojas reais exigiria antes de rodar, e está fora do que foi
entregue aqui:

- **persistência real, e o índice que impede a venda duplicada.** Os
  repositórios são portas assíncronas com adaptador em memória. Trocar por
  Postgres não deve encostar em nenhum serviço, mas a atomicidade que hoje vem
  de graça do processo single-threaded precisa virar explícita. O item crítico é
  um **índice único parcial** em `(vehicle_id) WHERE status = 'ACTIVE'` na
  tabela de travas: sem ele, duas lojas podem ler `AVAILABLE` ao mesmo tempo e
  ambas travar — que é precisamente o problema que a plataforma existe para
  eliminar. Detalhes e os outros três pontos de corrida em
  [`decisoes.md`](docs/decisoes.md#17-concorrência-o-que-muda-quando-sair-da-memória).
- **autenticação de produção.** A chave de API é adaptador de desenvolvimento:
  falta rotação, revogação, escopo por chave (uma chave de integração de feed
  não deveria poder fechar venda) e limite de requisições.
- **entrega das notificações fora da plataforma.** O mural interno existe
  (`GET /api/v1/notificacoes`) e já recebe os avisos que importam. Falta o
  transporte para onde o lojista realmente olha: push, WhatsApp ou e-mail. O
  assinante do barramento já está no lugar — é acrescentar um canal ao lado do
  mural, não refazer o mecanismo.
- **esquemas reais dos integradores.** Ver a ressalva na seção de ingestão.
- **fotos servidas pela plataforma.** Hoje o proxy redireciona; para esconder o
  domínio também do tráfego, é preciso servir os bytes com cache. O contrato da
  rota não muda.
