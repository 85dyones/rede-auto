# Handoff do projeto — rede-auto

**Para:** uma nova sessão de trabalho (humana ou Claude Code) · **Última
atualização:** 2026-10-03 · **Branch:** `claude/b2b-vehicle-inventory-platform-yb70ce`,
mergeada em `main` a cada entrega.

Este é o documento de partida. Ele cobre o que o projeto é, o que está
construído, as regras comerciais e de governança que foram decididas, e o que
falta. Tudo aqui foi conferido contra o código e contra a API rodando — números,
rotas e contagens saíram do servidor, não de memória.

**Ordem de leitura sugerida:** este documento inteiro (~20 min), depois
`npm run demo` (20 atos narrados, a operação completa em tempo simulado). Só
então o código.

| Documento | O que tem |
|---|---|
| [`../README.md`](../README.md) | o produto e as nove regras que o sustentam |
| [`decisoes.md`](decisoes.md) | 31 decisões com o porquê e o que foi descartado |
| [`dominio.md`](dominio.md) | máquinas de estado e invariantes |
| [`api.md`](api.md) | contrato HTTP completo |
| [`glossario.md`](glossario.md) | vocabulário — o idioma da rede |
| [`handoff-frontend.md`](handoff-frontend.md) | briefing de design: 10 problemas difíceis, 15 superfícies |

---

## 1. O que é

Rede **B2B fechada e local** para lojistas de seminovos compartilharem estoque
entre si. Quando a Loja B tem um cliente para um carro que está na Loja A, hoje
isso se resolve no WhatsApp: negocia margem, confirma disponibilidade, combina o
frete. É moroso, e a lentidão mata a venda.

Três coisas que definem o produto e precisam ser entendidas antes de qualquer
decisão técnica:

**Não existe interface para o consumidor final.** Nenhuma. O cliente nunca vê a
plataforma — quem o atende é o lojista, no canal dele. A plataforma entrega à
loja parceira o *material* para ela usar: fotos neutras, ficha em PDF, laudo.
Não há landing page, busca pública, cadastro aberto ou link para cliente.

**O dono define o preço; o parceiro define a margem dele.** A Loja A fixa um
**preço líquido de repasse** — o que ela exige receber. A Loja B vende por quanto
quiser acima disso e fica com 100% do excedente. A Loja A **nunca** vê quanto a
Loja B ganhou. Isso elimina a negociação de margem, que é a conversa que trava a
venda.

**A rede é local, e isso é a precondição de tudo.** O modelo inteiro — levar o
carro ao showroom da parceira, devolvê-lo em 4 horas úteis, o vendedor ir até o
pátio assinar a vistoria — só fecha porque as lojas estão a minutos umas das
outras. Um SLA de 4 horas entre Curitiba e Porto Alegre não é um SLA, é uma
ficção.

O piloto é **Curitiba e Região Metropolitana**: 10 municípios, raio operacional
declarado de 60 km.

---

## 2. Stack e infraestrutura

### O que está em pé

| Camada | Escolha | Observação |
|---|---|---|
| Runtime | **Node ≥ 22.6** | TypeScript rodado nativamente por *type-stripping* |
| Linguagem | TypeScript 5.9, `strict` + 8 flags extras | `erasableSyntaxOnly`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` |
| Dependências de runtime | **zero** | só `typescript` e `@types/node` em dev |
| HTTP | `node:http` puro | roteador próprio (`src/http/router.ts`), 68 rotas |
| Persistência | **em memória** | portas assíncronas prontas; ver §8 |
| Auth | chave de API em memória | adaptador de desenvolvimento; ver §8 |
| PDF | gerador próprio (`src/infra/pdf/`) | sem biblioteca |
| XML (feeds) | parser próprio (`src/infra/feeds/xml.ts`) | sem biblioteca, DOCTYPE rejeitado |
| Testes | `node:test` | 583 testes, 24 arquivos |
| Frontend | **não existe** | ver §7 |

**Zero dependências de runtime é decisão, não acidente**
([decisão 21](decisoes.md#21-zero-dependências-de-runtime)). Em troca de escrever
um parser de XML e um gerador de PDF, o projeto não tem árvore de dependências
para auditar, atualizar ou ser comprometido por ela. Imports usam extensão `.ts`
explícita, o que o type-stripping exige.

### Comandos

```bash
npm install          # 3 pacotes, todos de dev
npm run check        # typecheck estrito + 583 testes (~3 s)
npm run demo         # 20 atos narrados, a operação inteira em relógio simulado
npm start            # API em :3000, rede semeada, chaves no console
npm run test:watch   # testes em watch
```

### Variáveis de ambiente

| Variável | Default | Para quê |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | monta as URLs do material de divulgação |
| `SWEEP_INTERVAL_MS` | `60000` | intervalo do varredor periódico |
| `MAX_BODY_BYTES` | `41943040` | teto do corpo da requisição (40 MB, por causa das fotos) |
| `SEED_DEMO_DATA` | `true` | `false` desliga a rede semeada e as chaves fixas |

### Chaves de desenvolvimento

Fixas e visíveis no log, de propósito — e é por isso que `SEED_DEMO_DATA=false`
desliga tudo. Padrão: `demo_<slug>_titular` e `demo_<slug>_vendedor` para as 10
fundadoras (`prime`, `veloz`, `central`, `norte`, `sul`, `vialivre`, `planalto`,
`atlas`, `iguacu`, `bandeirante`), mais `demo_prime_boqueirao` para o segundo
pátio da Prime.

Uso: `Authorization: Bearer demo_prime_titular`.

---

## 3. Arquitetura

```
src/
  domain/        núcleo funcional puro — sem I/O, sem async, sem classes
    billing/     tariff (tabela de preços), charge (cobrança)
    cluster/     a praça: a fronteira de tenancy
    conduct/     breach: quebras de protocolo e a janela móvel
    custody/     custody (termo de vistoria), ledger (livro de custódia)
    deal/        negociação, transbordo, liquidação, ATPV-e
    lock/        commercial-lock (trava de 4h), evidence (o que estende)
    material/    kit de divulgação
    network/     member (empresa), store (pátio), membership (entrada),
                 expulsion (desligamento), exit (saída voluntária)
    recall/      chamada de retorno e o SLA
    shared/      result, errors, events, transition, clock, money, ids,
                 business-hours, geo, validation
    vehicle/     o agregado central, com dois eixos independentes
  application/   casos de uso: orquestram domínio + repositórios + eventos
  http/          servidor, roteador, serialização campo a campo
  infra/         adaptadores: persistência em memória, auth, feeds, PDF, render
  testing/       builders de dados e fixtures
scripts/demo.ts  os 20 atos
```

**20.865 linhas de produção, 9.061 de teste.**

### As cinco regras estruturais

1. **Domínio funcional puro.** Dados imutáveis e transições
   `(estado, comando) → Result<{estado, eventos}, DomainError>`. Sem classes de
   agregado, sem métodos que mutam. Um teste de domínio não precisa de mock
   ([decisão 11](decisoes.md#11-domínio-funcional-puro-sem-classes-de-agregado)).

2. **`Result` para falha de negócio, `throw` só para bug.** "Trava já existe" é
   um resultado; "centavos não é inteiro" é um bug e explode
   ([decisão 12](decisoes.md#12-result-para-falhas-de-negócio-throw-só-para-bugs)).

3. **Dinheiro em centavos inteiros.** Nunca float. Uma diferença de 1 centavo
   entre o líquido acordado e o liquidado gera disputa entre lojistas
   ([decisão 10](decisoes.md#10-dinheiro-em-centavos-inteiros)).

4. **Relógio injetável.** `FakeClock` nos testes. É o que torna possível
   exercitar a trava de 4h e o SLA de recall de ponta a ponta em milissegundos.

5. **Eventos de domínio.** 73 tipos em 11 prefixos (`vehicle.*`, `lock.*`,
   `custody.*`, `recall.*`, `deal.*`, `feed.*`, `membership.*`, `network.*`,
   `billing.*`, `conduct.*`, `governance.*`). Auditoria e notificações são
   **derivadas** deles, não escritas à mão em cada serviço.

### O padrão que aparece sete vezes: parâmetro obrigatório como guarda

Quando uma regra nova precisa ser aplicada em todo lugar, o projeto torna o dado
um **parâmetro obrigatório** e deixa o compilador achar as chamadas. Foi usado
em `viewerStoreId`, `clusterId`, `tradeInPolicy`, `loadVehicle(actor)`,
`endorsementTally(founders)`, `canTransact(store, member)` e
`declareDropOff(destination)`.

Um parâmetro opcional faria metade das chamadas responderem à pergunta antiga
sem ninguém perceber — e a metade errada é sempre a perigosa.

### Tenancy é fronteira, não filtro

`CatalogQuery = Omit<VehicleQuery, 'clusterId'>`, e `searchCatalog` injeta a
praça do ator. Buscar em outra praça não é proibido: é **impossível de
escrever**. Se a praça fosse parâmetro de entrada, bastaria trocar um id no
query string ([decisão 7](decisoes.md#7-a-praça-é-fronteira-não-filtro--e-nasce-antes-da-segunda-praça-existir)).

---

## 4. As regras do produto

### 4.1 Dois eixos independentes — a nuance central

Um veículo tem **estado comercial** (`AVAILABLE`, `LOCKED`, `SOLD`, `DRAFT`,
`WITHDRAWN`) e **estado físico** (`AT_YARD`, `IN_TRANSIT`,
`AWAITING_ACCEPTANCE`, `DELIVERED_TO_CONSUMER`) que **não se falam**. Nenhuma
transição de um altera o outro.

Um carro pode estar fisicamente no pátio da Loja B e comercialmente travado pela
Loja C. Um ERP de estoque amarra "onde o carro está" a "se dá para vender", e é
por isso que ERP não resolve este problema
([decisão 1](decisoes.md#1-físico-e-comercial-como-eixos-independentes)).

**Nunca desenhe um badge único de status por veículo.** Ele mentiria sobre um
dos dois eixos.

### 4.2 Trava comercial: 4 horas, extensão com evidência

A Loja B trava o carro por **4 horas** e ganha exclusividade. Estender exige
**evidência**, e cada tipo tem preço e cota:

| Evidência | Ganha | Cota | Anexo |
|---|---|---|---|
| Avaliação do veículo de troca | +2 h | 2× | não |
| Proposta bancária em análise | +4 h | 2× | não |
| Crédito aprovado pelo banco | +24 h | 1× | **sim** |
| Comprovante de sinal | +48 h | 1× | **sim** |
| Pedido assinado pelo cliente | +72 h | 1× | **sim** |

Teto absoluto: **5 dias**. Não 7 — acima de 5 dias a loja dona perde a janela de
giro, e o produto existe para acelerar venda, não para estacionar carro
([decisão 3](decisoes.md#3-teto-da-trava-em-5-dias-não-7)).

Expirada a trava, **não há carência**: o carro volta imediatamente ao catálogo
([decisão 2](decisoes.md#2-sem-carência-depois-que-a-trava-expira)). E a dona
**não cancela** trava de terceiro — a exclusividade é o que a Loja B compra ao
assumir o cliente ([decisão 4](decisoes.md#4-a-dona-não-cancela-trava-de-terceiro)).

### 4.3 Recall: SLA de 4 horas **úteis**

A dona chama o carro de volta. O custodiante tem **4 horas úteis** para
devolver. Horas úteis de verdade: expediente seg–sex 08:00–18:00, sáb
09:00–13:00, fuso `America/Sao_Paulo`, com feriados **nacionais e regionais** —
19 de dezembro (Emancipação do Paraná) e 8 de setembro (padroeira de Curitiba)
entram na conta ([decisão 9](decisoes.md#9-horas-úteis-de-verdade-não--4--3600_000)).

O SLA **não retroage**: se há trava ativa de terceiro, o prazo só começa quando
a trava cai ([decisão 5](decisoes.md#5-o-sla-de-recall-não-retroage)).

**Escape operacional:** o custodiante pode *disponibilizar* o carro para a parte
interessada buscar, em vez de providenciar transporte. Prazo bem menor (1 hora
útil), porque a obrigação também é menor. O relógio dele para aí — e passa a
correr um prazo do lado de quem vai buscar
([decisão 6](decisoes.md#6-o-escape-operacional-do-recall-não-compra-tempo)).

### 4.4 Custódia: o termo tem dois lados

A cada movimentação, termo digital de vistoria: odômetro, combustível, **cinco
fotos obrigatórias** (frente, traseira, laterais, odômetro), avarias. Assinado
pelos dois lados.

**A responsabilidade civil muda no check-in, não no checkout.** Entre a saída e a
entrada o carro está em trânsito e a responsabilidade continua com a origem —
quem ainda não viu o carro não pode herdar o risco dele
([decisão 8](decisoes.md#8-responsabilidade-civil-muda-no-check-in-não-no-checkout)).

Divergências (rodou além da tolerância de 80 km, combustível a menos de 1/8,
avaria nova) viram registro objetivo. **O produto não arbitra dano** — ele
registra e deixa as duas lojas conversarem.

### 4.5 Protocolo de entrega, em quatro passos

1. quem está com o carro **marca a retirada** pela parceira;
2. quem recebe **informa a chegada** — é isso que começa a janela de 4h;
3. ao devolver, quem levou **declara a entrega com geolocalização**;
4. quem recebe **dá o aceite**, e é o aceite que move a custódia.

A coordenada do passo 3 é **conferida** contra o pátio de destino (raio de
500 m). Fora dele, recusada na hora com a distância no erro.

Isso foi consertado em outubro: a geolocalização já era obrigatória e **não era
comparada com nada** — provava *uma* posição, não *a* posição. Um número que
ninguém confere é decoração, não registro. E era o que impedia qualquer quebra
do protocolo de ser atribuível
([decisão 27](decisoes.md#27-a-geolocalização-da-entrega-passou-a-ser-conferida)).

### 4.6 Material neutro: o anonimato muda de lugar

**Dentro** da rede não há segredo entre parceiras — elas se conhecem e precisam
ver de quem é o carro, qual o líquido e o que diz o laudo. O que precisa ser
neutro é o material que **sai** daqui, porque vai ser republicado por outra loja
([decisão 14](decisoes.md#14-rede-fechada-o-anonimato-muda-de-lugar)).

- **fotos neutras** são uma coleção separada, não um filtro sobre as originais
  ([decisão 15](decisoes.md#15-fotos-neutras-são-uma-coleção-separada-não-um-filtro));
- **o CRLV não circula na rede** — carrega o nome da loja dona. Só o laudo
  cautelar;
- a ficha em PDF e as fotos são servidas pela plataforma, sem revelar o domínio
  da loja dona.

### 4.7 Negociação e dinheiro

A conta tem três linhas e uma regra que a sustenta: **`cashDueToOwner ≥ 0`**. Se
a troca vale mais que o líquido, a Loja A deveria dinheiro à Loja B — a operação
é recusada com a sugestão de separar em duas.

- `retailPrice` (preço ao consumidor) é **opcional**: a venda acontece fora da
  plataforma ([decisão 17](decisoes.md#17-preço-ao-consumidor-é-opcional));
- vender **abaixo** do líquido é permitido (autonomia da Loja B, que pode aceitar
  prejuízo no seminovo para ganhar no giro da troca) e emite evento — que **não
  carrega o preço praticado**;
- liquidação parcial é aceita; nenhuma parcela excede o saldo aberto.

**A dona não vê a margem da parceira.** Isso é imposto no tipo:
`dealDto(deal, viewer)` exige o espectador, e o compilador cobra em toda chamada
([decisão 16](decisoes.md#16-a-dona-não-vê-a-margem-da-parceira)).

---

## 5. Comercial: o que a rede cobra

### Tabela vigente — versão `2026-03`

| | Fundadora | Depois |
|---|---|---|
| **Adesão** (uma vez, não é caução, não volta) | R$ 3.000 | R$ 6.000 |
| **Mensalidade da empresa**, 1ª loja inclusa | R$ 599 | R$ 599 |
| **Cada loja adicional** | R$ 159 | R$ 159 |
| **Taxa por transação** | **zero** | **zero** |

### Zero taxa por transação é o desenho, não uma lacuna

Cobrar por repasse fechado criaria exatamente dois incentivos ruins: **combinar
por fora** — quando a plataforma existe para que o processo inteiro aconteça
dentro dela — e **subdeclarar o valor**, envenenando os únicos números que a rede
tem.

Cobrando só acesso, quem usa mais não paga mais por usar. É o oposto da intuição
de monetização e é o comportamento correto aqui: o produto precisa que o volume
suba. A receita cresce por membros, não por fricção.

Custo aceito: a plataforma não captura valor proporcional ao volume que
viabiliza. Numa rede pequena isso é irrelevante — o gargalo é adesão, não
extração ([decisão 26](decisoes.md#26-receita-por-acesso-nunca-por-transação)).

### Regras da tabela

- **Versionada com data de vigência.** Quem entra depois paga adesão maior — é o
  que premia quem entrou no começo. E sobe por **ato de governança, não por
  fórmula**: um reajuste automático aumentaria preço sem ninguém ter decidido, e
  a primeira notícia seria a fatura do lojista.
- A adesão de fundadora é **número próprio**, não "metade". Guardar uma fração
  prenderia as duas linhas uma na outra para sempre.
- **Fundadora fica 24 meses na tabela que assinou**, e congela a tabela
  *inteira*: pátio aberto no mês 10 entra pelo preço congelado. Congelar só a
  linha da empresa faria a fundadora descobrir o reajuste no momento em que
  decidisse crescer.
- A fatura **congela valor e memória de cálculo**. Recalcular na leitura faria um
  pátio aberto hoje mudar uma fatura de três meses atrás.
- **Sem rateio**: pátio aberto no meio do ciclo entra na fatura seguinte. O erro
  que sobra cai a favor de quem está crescendo.
- Ciclo ancorado no **aniversário da adesão**, com aritmética de calendário —
  `+ 30 dias` faria "todo dia 9" virar dia 8, depois 7.
- Vencimento conta da **emissão**, não da competência: recuperar quatro ciclos de
  uma vez não produz quatro faturas já vencidas. A falha de quem emite não vira
  suspensão de quem paga.
- Vencimento em **10 dias**; **30 dias de atraso suspendem a empresa**.
- Inadimplência é a cobrança aberta **mais atrasada**, nunca a soma dos atrasos.
  Somar suspenderia em dez dias quem tem três faturas do mesmo dia.

### Receitas indiretas

**Em stand-by por decisão de produto** (laudo, transporte, seguro, antecipação
de recebível). Nada no desenho os impede depois.

---

## 6. Governança: o ciclo de vida do membro

### 6.0 Empresa e loja são coisas diferentes

A tabela de preços só existe se **empresa** (`Member`) e **loja** (`Store`)
forem separadas:

- a **empresa** paga, é fundadora, endossa e é suspensa por inadimplência;
- a **loja** opera: custódia, estoque, trava, vistoria. Quem responde pelo carro
  é quem está com ele, e isso não se reparte entre filiais.

A identidade da empresa é a **raiz do CNPJ** (8 primeiros dígitos) — filial
compartilha a raiz e difere na ordem (`/0001`, `/0002`). Isso faz "essa loja é da
mesma empresa?" ser pergunta **verificável** em vez de declaração.

**Dois status, não um:**

| | Quem é atingido | Por quê | Termina |
|---|---|---|---|
| `Member.status = SUSPENDED` | a empresa, e todos os pátios | 30 dias de inadimplência | pagando |
| `Store.status = SUSPENDED` | só aquele pátio | 3 quebras de protocolo em 12 meses | a janela móvel andar |

`canTransact(store, member)` exige os dois de pé. Unificar seria escolher entre
punir pátio que não fez nada e deixar empresa inadimplente operando pela filial
([decisão 25](decisoes.md#25-empresa-e-loja-separadas-porque-o-preço-as-separou)).

Em **nenhum** dos dois casos a custódia é interrompida: o carro de terceiro no
pátio suspenso continua podendo voltar para a dona.

### 6.1 Entrada: três endossos credenciam

A qualificação vem do **endosso**: uma fundadora coloca a reputação dela atrás de
uma candidata que conhece de praça. **Três endossos credenciam**, e o terceiro já
admite — a plataforma não vota, não veta, não admite.

- **Não existe endosso contrário.** Quem tem restrição simplesmente não endossa.
  Modelar rejeição daria a cada fundadora um veto individual sobre concorrência
  direta;
- como não há recusa, existe **prazo**: a candidatura caduca em 30 dias. Sem
  isso, "pendente para sempre" seria uma recusa que ninguém precisa assinar;
- a padrinho não endossa a própria indicação, **nem pela filial**;
- o endosso é da **empresa**, exercido pelo titular de qualquer pátio dela. Se
  fosse do pátio, um grupo com três lojas credenciaria sozinho — e "três
  endossos" deixaria de significar três empresas respondendo por uma quarta;
- **três endossos é fixo, não proporcional.** Três lojas respondendo por uma
  quarta é a unidade de confiança da rede; ela não encolhe porque a praça é
  pequena;
- `apuracao.alcancavel` avisa, **na abertura**, quando não há fundadoras
  suficientes para fechar a conta. Sem isso a única notícia seria a caducidade
  30 dias depois.

> **Limite conhecido, registrado de propósito.** Endossos numa praça de 60 km não
> são independentes — as fundadoras se conhecem e compram nos mesmos leilões.
> Três endossos medem reputação no mercado, não saúde financeira. O contrapeso
> real seria **exposição graduada** do membro novo, que não está construída
> (§8).

### 6.2 A janela de fundação

O número de fundadoras é **flexível por decisão de produto** — idealmente dez,
podem ser menos. Quem decide é uma data no cluster: `foundingWindowEndsAt`, 90
dias por padrão, teto de um ano.

Credenciada **dentro** da janela, a empresa nasce fundadora e paga meia adesão;
**depois**, entra como membro pela adesão cheia.

Consequência técnica maior que a mudança de produto: **`founderCount` não existe**.
Um número declarado em constante mentiria sobre a praça no primeiro dia em que a
janela fechasse com oito. `endorsementTally` exige o rol de fundadoras como
parâmetro obrigatório, e o serviço o obtém do repositório
([decisão 24](decisoes.md#24-a-janela-de-fundação-quem-entra-na-janela-leva)).

### 6.3 Conduta: as quebras que o sistema mede sozinho

"Quebrar o protocolo três vezes suspende" só vira regra se **quebra** for algo
medido sem ninguém opinar — julgamento humano sobre quem falhou seria um tribunal
entre concorrentes. Toda quebra é **objetiva** (prazo vencido ou carimbo que
faltou), **atribuível** (sobra para uma loja só) e **já medida**.

| Quebra | De quem | Prazo |
|---|---|---|
| `RECALL_SLA` — não devolveu no prazo | custodiante | 4 h úteis |
| `PICKUP_NOT_COLLECTED` — não retirou o disponibilizado | quem pediu o recall | 8 h úteis |
| `DROPOFF_NOT_ACKNOWLEDGED` — não deu aceite na entrega | quem recebe | 4 h úteis |
| `TRANSFER_ABANDONED` — deixou o carro em trânsito | loja de origem | 24 h úteis |

**O que ficou de fora é a parte mais importante da decisão:**

- **divergência de vistoria não é quebra de protocolo.** É dano, e o produto não
  arbitra dano. Contá-la como quebra faria a primeira loja a marcar um risco no
  termo aprender a não marcar mais — o registro perderia a honestidade que o
  justifica;
- **declaração feita longe do pátio também não.** Ela é recusada na hora, e ato
  recusado não causou dano. Registrar tentativa recusada puniria falha de GPS,
  indistinguível de má-fé com os dados que existem.

**Janela móvel de 12 meses.** Uma quebra por ano durante três anos é um problema
diferente de três num mês. Três quebras suspendem o **pátio**, e ele **reabre
sozinho** quando a janela alivia — manter a suspensão exigiria alguém decidir
mantê-la, e essa decisão não está em nenhuma regra combinada
([decisão 28](decisoes.md#28-quebra-de-protocolo-o-que-conta-o-que-não-conta-e-por-quê)).

### 6.4 Desligamento: entrar é discricionário, sair é probatório

Essa assimetria é o desenho inteiro.

**Entrar** é discricionário: a fundadora endossa porque conhece a candidata e não
precisa provar nada. **Sair** é probatório: a moção só pode ser aberta contra quem
**já tem reincidência registrada** — uma segunda suspensão por conduta.

Sem essa exigência o desligamento viraria o veto que a admissão recusou, com a
agravante de servir para remover quem está vendendo bem. **A opinião decide quem
entra; o registro decide quem pode ser posto para fora.**

- o fundamento é **apurado do registro pelo serviço**, nunca informado por quem
  abre — quem quer desligar um concorrente também sabe digitar "2";
- e é **copiado na abertura**, porque a janela móvel alivia com o tempo e a moção
  não pode perder o chão porque o calendário andou;
- **não há voto contra**: o silêncio já é contra, e registrar "sou contra"
  tornaria visível quem defendeu quem — é como se constrói retaliação;
- **há prazo** (21 dias), e o desfecho por inércia é **fica**;
- quórum **proporcional**: dois terços das fundadoras ativas, excluída a
  acusada, piso de duas. Não é incoerência com os três endossos fixos — na
  admissão mede-se confiança, aqui mede-se consenso, e consenso é proporção;
- a custódia **não bloqueia** o desligamento: se estar com o carro de um parceiro
  adiasse a saída, bastaria segurar um carro para nunca ser desligado. As
  obrigações sobrevivem, e a lista de carros vai no evento
  ([decisão 29](decisoes.md#29-desligamento-entrar-é-discricionário-sair-é-probatório)).

### 6.5 Saída voluntária: duas comportas

Fluxo **diferente** do desligamento. Desligamento é sanção: fato provado, quórum,
e quem decide são os outros. Saída é decisão de quem sai — ninguém vota, nada a
provar.

Mas não pode ser instantânea, e a razão não é burocrática: no instante em que a
empresa deixa a rede, todo carro que ela ainda detiver — ou que ainda estiver
detido por outros — fica **sem contraparte**. Não há mais recall a pedir, prazo a
cobrar nem conduta a registrar.

1. **Tempo** — 30 dias de aviso prévio, para os parceiros se reorganizarem;
2. **Estado** — nada em aberto: nenhum carro de terceiro no pátio dela, nenhum
   carro dela em pátio alheio, nenhuma trava, negociação ou cobrança viva.

**A comporta de estado é a que importa, e não é uma data.** Por mais que o prazo
tenha vencido, a empresa não sai enquanto estiver com o carro de alguém.

Entre o aviso e a saída a empresa fica em `LEAVING`: **não adquire exposição
nova**, mas termina tudo o que já estava aberto. Isso cai de graça —
`memberInGoodStanding` responde falso, e é por ele que `canTransact` passa.
Trava, apadrinhamento e endosso param sozinhos; check-in, devolução, recall e
liquidação seguem funcionando.

**A saída se conclui sozinha**: no passe do varredor em que a última pendência
fecha. A última pendência costuma fechar por ato de *outra* loja, e um botão
final deixaria a empresa pronta e presa
([decisão 30](decisoes.md#30-saída-voluntária-o-prazo-é-o-mínimo-não-o-gatilho)).

Três decisões laterais: empresa **suspensa pode** avisar saída (impedir faria da
suspensão uma armadilha); faturamento para em `EXITED`, não em `LEAVING`; e as
candidaturas que ela apadrinhou são **retiradas junto**.

### 6.6 Tabela-resumo dos números de governança

| Parâmetro | Valor | Onde |
|---|---|---|
| Endossos para credenciar | 3 (fixo) | `governance.requiredEndorsements` |
| Prazo da candidatura | 30 dias | `governance.applicationWindowDays` |
| Janela de fundação | 90 dias (teto 365) | `cluster.foundingWindowEndsAt` |
| Congelamento de fundadora | 24 meses | `FOUNDER_FREEZE_MONTHS` |
| Vencimento da fatura | 10 dias | `billing.dueInDays` |
| Atraso que suspende a empresa | 30 dias | `billing.suspendAfterOverdueDays` |
| Quebras que suspendem o pátio | 3 | `conduct.breachesToSuspend` |
| Janela de conduta | 12 meses (móvel) | `conduct.windowMonths` |
| Suspensões para caber moção | 2 | `expulsion.suspensionsForRecidivism` |
| Quórum de desligamento | ⅔, piso 2 | `expulsion.supportFraction` |
| Prazo da moção | 21 dias | `expulsion.windowDays` |
| Aviso prévio de saída | 30 dias | `exit.noticeDays` |
| SLA de recall | 4 h úteis | `recall.slaBusinessHours` |
| Disponibilizar para retirada | 1 h útil | `recall.pickupReadinessBusinessHours` |
| Trava base / teto | 4 h / 5 dias | `lock.baseTtlMs` / `maxTotalMs` |
| Raio do pátio (entrega) | 500 m | `YARD_RADIUS_METERS` |
| Teto do raio do cluster | 300 km | `MAX_OPERATING_RADIUS_KM` |
| Tolerância de odômetro | 80 km | `custody.odometerToleranceKm` |

Todos em `src/config.ts` → `defaultPolicies()`. Nenhum está espalhado pelo
código.

---

## 7. Frontend: não existe, e o briefing está pronto

Nenhuma linha. Nenhum framework escolhido.

[`handoff-frontend.md`](handoff-frontend.md) é o briefing para a proposta visual:
**10 problemas difíceis** (o cartão que conta duas histórias, o cronômetro de
horas úteis, a coordenada conferida, os dois eixos de suspensão…) e **15
superfícies** agrupadas em essencial / importante / complementar / governança.

Restrições que a proposta precisa respeitar:

- **pt-BR**; a API já entrega dinheiro `formatado` — não reformatar no cliente;
- **mobile-first obrigatório**: catálogo, ficha, trava, vistoria, material,
  declaração e aceite de entrega. **Desktop-first**: negociação, liquidação,
  feed, credenciamento, financeiro, conduta, desligamento, saída;
- **sem tela de login público, sem cadastro aberto, sem landing de venda**;
- tema claro e escuro;
- rede ruim (vendedor em subsolo de showroom) — estados de carregamento e erro
  não são detalhe;
- **o titular alterna entre dois contextos**: empresa (financeiro, governança,
  conduta, saída) e pátio (catálogo, travas, recalls, vistorias). Não misture as
  duas listas numa navegação só.

Anti-objetivos (coisas que parecem boas e quebram o produto): qualquer tela
voltada ao consumidor, chat de negociação de margem, leilão ou contraproposta,
badge único de status, botão de "recusar candidatura" ou "votar contra", botão de
"sair agora", painel de conduta como ranking, taxa por transação em qualquer
lugar da interface, exibir "x de 10 fundadoras".

---

## 8. O que falta — na ordem em que eu faria

### 1. Persistência real

É o **único item que bloqueia um piloto com lojas de verdade**. Os repositórios
já são portas assíncronas com adaptador em memória, então trocar não deve encostar
em nenhum serviço de aplicação.

O ponto crítico não é o Postgres, é o **índice único parcial**:

```sql
CREATE UNIQUE INDEX ON commercial_locks (vehicle_id) WHERE status = 'ACTIVE';
```

Sem ele, duas lojas leem `AVAILABLE` ao mesmo tempo e ambas travam — precisamente
o problema que a plataforma existe para eliminar. O índice transforma a corrida
numa violação de constraint, que o serviço traduz para o mesmo
`409 VEHICLE_ALREADY_LOCKED` que já existe. O domínio não muda.

Os outros três pontos de corrida (confirmação de venda, check-in duplo,
liquidação simultânea) estão mapeados em
[decisão 23](decisoes.md#23-concorrência-o-que-muda-quando-sair-da-memória).

### 2. Autenticação de produção

A chave de API é adaptador de desenvolvimento. Falta rotação, revogação, **escopo
por chave** (uma chave de integração de feed não deveria poder fechar venda) e
limite de requisições.

### 3. Entrega das notificações fora da plataforma

O mural interno existe (`GET /api/v1/notificacoes`) e já recebe os avisos que
importam. Falta o transporte para onde o lojista realmente olha: push, WhatsApp
ou e-mail. O assinante do barramento já está no lugar — é acrescentar um canal ao
lado do mural, não refazer o mecanismo.

### 4. Frontend

Rodar o `/design` com o handoff atualizado é o próximo passo natural.

### Pendências de produto, menores mas pedidas pelo próprio modelo

- **Calendário por loja.** Hoje o expediente é da instalação. Feriado municipal
  difere dentro da própria RMC — São José dos Pinhais, Colombo e Araucária não
  fecham nos mesmos dias que Curitiba. O correto é o calendário seguir a **loja
  custodiante**, porque é a agenda dela que determina se o prazo era cumprível.
  A política já é parâmetro, então descê-la é mecânico quando houver a quem
  perguntar.
- **Exposição graduada do membro novo.** É o contrapeso real ao limite dos
  endossos correlacionados (§6.1): limites na exposição de custódia de quem
  acabou de entrar, nos primeiros 90 dias.
- **Saída voluntária com conduta aberta.** Decidi não bloquear (sair não é fuga),
  mas não há mecanismo para o caso de uma empresa sair no meio de uma moção de
  desligamento. Hoje a moção simplesmente fica órfã.
- **Reset do contador de quebras.** A janela móvel de 12 meses resolve o
  acúmulo, mas não há reconhecimento explícito de correção — uma loja que
  consertou o processo espera a janela andar como qualquer outra.

### Explicitamente fora de escopo

| Fora | Motivo |
|---|---|
| Resolução de disputa de avaria | projetar sem casos reais produziria a regra errada; as divergências já ficam registradas |
| Precificação sugerida / FIPE | o produto elimina a negociação de margem; sugerir preço seria reintroduzi-la |
| Multi-moeda | a rede é brasileira; `Money` fixa BRL para o tipo não mentir |
| Curadoria automática de foto neutra | decidir se um adesivo entrega a origem é julgamento humano; borrar placa é visão computacional |
| SaaS em volta do cluster | a fronteira existe e é testada; cobrança multi-praça, provisionamento e autoatendimento são camadas por cima dela |
| Receitas indiretas | stand-by por decisão de produto |

---

## 9. Como trabalhar neste repositório

### Convenções

- **Português nos limites, inglês na estrutura.** Rotas, campos de JSON e
  mensagens de erro em pt-BR, porque o usuário é lojista brasileiro. Tipos,
  funções e arquivos em inglês
  ([decisão 22](decisoes.md#22-português-nos-limites-inglês-na-estrutura)).
  Comentários em português **sem acentos** — é a convenção do código.
- **Serialização escrita à mão, campo a campo.** Com spread do agregado, todo
  campo interno novo passaria a sair na API por padrão, e a única forma de
  descobrir seria em produção.
- **Comentários explicam o porquê, não o quê.** O padrão do projeto é registrar a
  alternativa descartada: "X seria mais simples e estaria errado porque Y".
- **Toda decisão de produto vira entrada em `decisoes.md`**, com o descartado.
- `src/docs.test.ts` valida **todo link interno e âncora** da documentação. Se
  você renomear uma seção, o teste acusa.

### O hábito que mais pegou erro: mutação

Depois de escrever um teste para uma regra nova, **quebre a regra de propósito e
confirme que o teste falha**. Isso pegou três falsos positivos nesta base:

- a substituição de endosso por empresa passava limpa, porque na rede de teste
  toda empresa tinha um pátio só;
- `memberOverdueDays` com soma em vez de máximo passava, porque o teste tinha
  três faturas mas só uma vencida;
- o teste de idempotência do varredor de conduta passava chamando só
  `runConductSweep`, sem `sweepRecallBreaches` antes.

Os três testes foram reescritos para a mutação falhar. É o jeito mais rápido de
descobrir que um teste não testa o que diz.

### Fluxo de entrega

```bash
npm run check                    # typecheck + testes, sempre antes de commitar
npm run demo                     # confirma que a narrativa ponta a ponta roda
git add -A && git commit         # mensagem explica a decisão, não o diff
git push -u origin claude/b2b-vehicle-inventory-platform-yb70ce
git checkout main && git merge --ff-only <branch> && git push origin main
```

Commits descrevem **o porquê** — por que esta regra e não a óbvia, o que foi
descartado, e o que uma mutação provou. O diff já conta o quê.

---

## 10. Estado atual, em números

| | |
|---|---|
| Testes | **583**, todos passando |
| Typecheck | estrito, sem erros |
| Linhas de produção | 20.865 |
| Linhas de teste | 9.061 |
| Arquivos TypeScript | 94 (24 de teste) |
| Rotas HTTP | 68 |
| Eventos de domínio | 73 tipos em 11 prefixos |
| Decisões documentadas | 31 |
| Atos da demo | 20 |
| Dependências de runtime | 0 |

### A rede semeada

**Praça:** Curitiba e Região (PR) · 10 municípios · raio 60 km · janela de
fundação de 90 dias, aberta.

**10 empresas fundadoras, 11 pátios** — a Prime Motors tem dois (matriz no
centro e Boqueirão, a ~6 km). É a única que exercita a separação empresa/pátio e
a linha de R$ 159: mensalidade de **R$ 758,00** contra R$ 599,00 das demais.

Sul Car e Iguaçu Motors são `CASH_ONLY` de propósito — sem uma loja assim, o
piloto nunca exercitaria o caminho que a política de troca existe para cobrir.

**5 veículos:** Onix 2023 (Prime), Argo 2022 (Veloz), Corolla 2022 (Garagem
Central), Renegade 2023 (Prime), T-Cross 2022 (Norte).

Adesão de fundadora de R$ 3.000 já emitida e quitada no seed — começar o piloto
com dez empresas a dez dias do vencimento faria a primeira varredura parecer uma
crise de inadimplência.
