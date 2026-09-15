# rede-auto

Rede B2B **fechada** para compartilhamento de estoque e custódia física de
veículos seminovos entre lojistas parceiros.

Fechada no sentido literal: **não existe superfície para o consumidor final**.
Só lojista credenciado e logado entra. O cliente é atendido no canal da própria
loja parceira — a plataforma nunca aparece na venda.

Hoje o repasse entre lojas é combinado por telefone: o gerente da Loja B liga
para a Loja A, negocia margem, confirma se o carro ainda está disponível e
improvisa a logística. Esta plataforma digitaliza essa dinâmica com uma regra
que não existe no telefone — **exclusividade temporária garantida por sistema** —
e elimina o risco que ela cria: duas lojas vendendo o mesmo carro.

E a rede é **local**. Não é detalhe de lançamento, é a precondição de todo o
resto: levar o carro ao showroom da parceira, devolvê-lo em 4 horas úteis, o
vendedor ir até o pátio assinar a vistoria — nada disso fecha se as lojas não
estiverem a minutos umas das outras. O piloto é **Curitiba e Região**; cada
praça futura é um cluster próprio, com estoque, custódia e governança que não
se misturam (ver [Cluster](#cluster-a-rede-é-local-e-isso-é-uma-fronteira)).

```bash
npm install
npm start        # sobe a API em http://localhost:3000 com a rede semeada
npm run demo     # roteiro narrado: a operação inteira em milissegundos
npm run check    # typecheck estrito + 366 testes
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

## Cluster: a rede é local, e isso é uma fronteira

O modelo inteiro depende de proximidade. Um SLA de recall de 4 horas úteis entre
Curitiba e Porto Alegre não é um SLA — é uma ficção. Então a praça não é um
filtro de busca, é uma **fronteira**: estoque, custódia, travas, negociações e
governança não atravessam cluster.

O piloto é uma praça só:

| | |
|---|---|
| Praça | Curitiba e Região (PR) |
| Municípios | Curitiba, São José dos Pinhais, Colombo, Araucária, Pinhais, Campo Largo, Almirante Tamandaré, Piraquara, Fazenda Rio Grande, Quatro Barras |
| Raio operacional declarado | 60 km |
| Fundadoras | 6, todas dentro do raio |

O raio é declarado, não calculado — serve para a governança julgar candidatura
("essa loja fica a 180 km, o recall de 4h vai falhar toda vez") e para o produto
explicar por que a rede é local. Acima de **300 km** o cadastro é recusado: ida e
volta deixam de caber no dia útil, e um cluster maior que isso não é um cluster,
são dois.

**Por que agora, se clusters são planos futuros.** Porque *tenancy* é a coisa
clássica que não dá para retrofitar. A segunda praça, hoje, custa uma linha de
seed; depois de trinta consultas escritas sem escopo, custa uma auditoria — e o
que vaza no meio do caminho é preço líquido de concorrente de outra cidade.

A fronteira não depende de ninguém lembrar dela:

- `VehicleQuery.clusterId` é **obrigatório no tipo**. Não existe busca sem praça.
- `searchCatalog` recebe o ator e injeta a praça dele. O tipo de entrada
  (`CatalogQuery`) *omite* `clusterId`: buscar em outra praça não é proibido, é
  impossível de escrever.
- `loadVehicle` é o único caminho de um id até um veículo, e é onde a guarda
  mora. Carro de outra praça responde **404, não 403** — distinguir "não é seu"
  de "não existe" já entrega que existe.
- Broadcast de notificação exige `clusterId` no tipo; um aviso sem praça não
  chega a ninguém, em vez de chegar à rede errada.
- `founders(clusterId)` e `pending(clusterId)`: o endosso é contado dentro de
  uma praça só. Fundadora de Curitiba não vota em candidata de Londrina.

O que **não** existe ainda, e é deliberado: cobrança, provisionamento de praça e
autoatendimento de SaaS. Só a fronteira, que é a parte cara depois.

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

O SLA é contado em horas **úteis** de verdade: horário de Brasília (o
identificador IANA é `America/Sao_Paulo`, que cobre o Paraná igualmente), segunda
a sexta 08:00–18:00, sábado 09:00–13:00, feriados nacionais incluindo os móveis
derivados da Páscoa **e os da praça** — 19 de dezembro (Emancipação Política do
Paraná) e 8 de setembro (padroeira de Curitiba). Um pedido feito sexta às 17h
vence segunda de manhã, não às 2h da madrugada de domingo.

**E existe um escape operacional**, porque o prazo pressupõe motorista — e nem
sempre há. Sem saída, a regra rígida produz o pior dos dois mundos: ou a Loja B
fica em atraso por um transporte que nunca teve como fazer, ou queima as 4 horas
protegida pelo prazo enquanto a Loja A perde a venda que motivou o recall.

Então o prazo não mede sempre a mesma coisa:

| Quem leva | O que o prazo mede | Horas úteis |
|---|---|---|
| `CUSTODIAN_DELIVERS` (padrão) | entregar o carro no pátio da dona | 4 |
| `REQUESTER_COLLECTS` (quem chamou vai buscar) | **deixar o carro disponível** | 1 |

E, no meio do prazo, a Loja B pode declarar o carro pronto para retirada: o
relógio **para** e a obrigação dela termina ali — a Loja A busca quando puder,
sem ninguém em atraso.

O escape não é elástico. Optar por retirar nunca **estende** prazo
(`min(prazo atual, agora + 1h útil)`), declarar disponível **guarda** os minutos
que sobravam em vez de zerá-los, e se a retirada frustrar o prazo **retoma** de
onde parou. Muda de quem é a obrigação, não o tamanho do relógio.

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

### 4. Governança: fundadoras endossam, a plataforma decide

A rede é fechada, e a qualificação vem do **endosso**: uma fundadora coloca a
reputação dela atrás de uma candidata que conhece de praça. Mas endosso não é
voto — quem admite é a plataforma.

A diferença não é burocrática, é de incentivo. Enquanto o credenciamento era
decidido por quórum, as fundadoras tinham nas mãos o poder de barrar
concorrência direta e chamar isso de critério. Tirar a decisão delas remove o
conflito sem jogar fora o que elas sabem.

**Não existe endosso contrário.** Quem tem restrição simplesmente não endossa, e
a ausência já é o sinal. A plataforma pode admitir abaixo do endosso recomendado,
mas precisa registrar a justificativa — é o que impede o endosso de virar enfeite
sem transformá-lo em veto. A padrinho não endossa a própria indicação, e quem
entra depois não vira fundadora.

## Material de divulgação

A plataforma não hospeda anúncio nem manda link para cliente. O que ela entrega
à loja parceira, já logada, é o **material pronto para ela usar no canal dela**:

- **fotos neutras** — publicadas pela loja dona, sem placa legível, sem adesivo,
  sem fachada. É o que qualquer parceira pode republicar como se fosse próprio;
- **ficha técnica completa**, em JSON e em PDF;
- **o laudo cautelar** em arquivo, quando houver.

Isso desloca onde mora o anonimato. **Dentro** da rede não há segredo entre
parceiras — elas se conhecem, e precisam ver de quem é o carro, qual o líquido e
o que diz o laudo. O que precisa ser neutro é o material que **sai** daqui,
porque ele vai ser republicado por outra loja.

O que **não** entra no material, e por quê:

| Fora | Motivo |
|---|---|
| Nome, CNPJ e contato da loja dona | apareceriam no anúncio da parceira |
| Preço líquido de repasse | é o acordo entre as duas lojas |
| Placa completa e chassi | permitem consulta pública que devolve o proprietário |
| **CRLV** | está no nome da loja dona — entregaria a origem |
| **As fotos do feed** | foram tiradas para o anúncio da própria dona: adesivo, fachada, placa |

A última é a que mais escapa. `cdn.primemotors.com.br/onix-1.jpg` entrega a
origem sem que ninguém perceba, e por isso as fotos do feed **nunca** viram
material: elas seguem existindo para uso interno, e o que circula é o conjunto
neutro, servido pela plataforma.

O kit nasce sem loja e sem preço. A parceira pode gerar a ficha já com **a marca
dela e o preço dela** — nunca os da dona. Quem define o líquido é a dona; quem
define o preço ao consumidor é quem vai atender o consumidor.

A sanitização é escrita como lista de **inclusão**, campo a campo, e um guarda
de runtime varre o kit antes de o download sair: se um termo proibido aparecer,
a requisição falha em vez de entregar a origem.

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
│   ├── cluster/     a praça: fronteira de estoque, custódia e governança
│   ├── network/     lojas, usuários, credenciamento por quórum
│   ├── vehicle/     o agregado central, com os dois eixos desacoplados
│   ├── lock/        trava comercial com TTL e política de evidências
│   ├── custody/     termo de vistoria assinado e livro de responsabilidade civil
│   ├── recall/      prioridade dono vs. custodiante, SLA em horas úteis e o escape
│   ├── deal/        repasse, trade-in, liquidação, ATPV-e
│   └── material/    kit neutro que a parceira baixa para anunciar
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

Autenticação por chave em `Authorization: Bearer <chave>`. **Toda** rota de
negócio exige login — não há superfície pública.

```
GET    /api/v1/veiculos                              catálogo da rede
GET    /api/v1/veiculos/no-meu-patio                 estoque avançado de terceiros
POST   /api/v1/veiculos/:id/trava                    abre a trava de 4h
POST   /api/v1/travas/:id/extensoes                  estende com evidência
POST   /api/v1/veiculos/:id/custodia/saidas          termo de saída
POST   /api/v1/custodia/termos/:id/entrada           termo de entrada (muda a responsabilidade)
GET    /api/v1/veiculos/:id/custodia/responsavel?em= quem respondia naquela data
POST   /api/v1/veiculos/:id/recall                   chamada de retorno
POST   /api/v1/recalls/:id/retirada                  "eu retiro": muda quem leva
POST   /api/v1/recalls/:id/disponivel                carro pronto; o relógio para
POST   /api/v1/recalls/:id/reabrir-prazo             retirada frustrada; o prazo retoma
POST   /api/v1/veiculos/:id/negociacao               monta o repasse sobre a trava
POST   /api/v1/negociacoes/:id/confirmacao           fecha a venda
POST   /api/v1/veiculos/:id/entrega                  entrega ao comprador (encerra os dois eixos)
GET    /api/v1/veiculos/:id/material                 kit neutro para a parceira anunciar
GET    /api/v1/veiculos/:id/material/ficha.pdf       ficha técnica em PDF
POST   /api/v1/feeds/sincronizacao                   ingere o XML do integrador
GET    /api/v1/notificacoes                          mural de avisos da loja
```

Todas exigem login. As únicas rotas sem autenticação são `GET /health` e o
índice `GET /api/v1` — não há, por construção, nenhuma superfície pública.

Referência completa em [`docs/api.md`](docs/api.md). O índice das rotas também
sai em `GET /api/v1`.

## Documentação

| | |
|---|---|
| [`docs/dominio.md`](docs/dominio.md) | modelo de domínio, máquinas de estado e invariantes |
| [`docs/api.md`](docs/api.md) | referência da API, com exemplos de requisição |
| [`docs/decisoes.md`](docs/decisoes.md) | decisões de projeto e o que foi descartado |
| [`docs/glossario.md`](docs/glossario.md) | vocabulário do negócio ↔ identificadores no código |
| [`docs/handoff-frontend.md`](docs/handoff-frontend.md) | briefing para a proposta de frontend, ancorado no contrato real da API |

## Estado do projeto

Implementado e testado: todo o domínio, os casos de uso, a API HTTP, a ingestão
de feeds, o material de divulgação e a trilha de auditoria. 366 testes,
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
  [`decisoes.md`](docs/decisoes.md#23-concorrência-o-que-muda-quando-sair-da-memória).
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
- **curadoria das fotos neutras.** Decidir se um adesivo no vidro ou a fachada
  refletida no para-brisa entregam a origem é julgamento humano — a plataforma
  garante que o conjunto exista e cubra os ângulos, não que ele esteja limpo.
  Borrar placa e remover marca automaticamente é trabalho de visão
  computacional, fora do que foi entregue.
- **o SaaS em volta do cluster.** A fronteira existe e é testada; o negócio em
  volta dela não. Faltam cobrança e plano, provisionamento de praça
  (autoatendimento para constituir um cluster novo e suas fundadoras), e a
  decisão de produto sobre calendário por praça — hoje o expediente e os
  feriados são da instalação, e um cluster em outro estado tem feriado próprio.
  Nada disso muda a fronteira: são camadas por cima dela.
