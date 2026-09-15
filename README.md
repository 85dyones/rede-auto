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
npm run check    # typecheck estrito + 562 testes
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
  uma praça só. Fundadora de Curitiba não endossa candidata de Londrina.

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

## As nove regras que sustentam a rede

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

### 4. Governança: quem decide quem entra são os membros

A rede é fechada, e a qualificação vem do **endosso**: uma fundadora coloca a
reputação dela atrás de uma candidata que conhece de praça. **Três endossos
credenciam.** A plataforma só opera — não vota, não veta, não admite.

**Não existe endosso contrário.** Quem tem restrição simplesmente não endossa, e
a ausência já é o sinal. Modelar rejeição daria a cada fundadora um veto
individual sobre concorrência direta, que é exatamente o que não se quer.

Como não há recusa, existe **prazo**: a candidatura caduca se não juntar os
endossos em 30 dias. Sem isso, "pendente para sempre" seria uma recusa que
ninguém precisa assinar — e a candidata nunca saberia o que aconteceu.

O terceiro endosso já credencia: não há passo entre a decisão e a loja poder
operar. A padrinho não endossa a própria indicação.

**Quantas fundadoras existem é um fato contado, não um número declarado.** O
alvo é dez, mas a praça abre com quem entrou — e por isso nenhum lugar do
sistema guarda um `founderCount`: pergunta-se ao repositório. Quem decide é a
**janela de fundação** do cluster (`foundingWindowEndsAt`, 90 dias por padrão):
credenciada dentro da janela, a loja nasce fundadora e paga meia adesão;
credenciada depois, entra como membro e paga a adesão cheia. Nada registra *por
que* a loja é fundadora — `joinedAt` contra a janela já responde, e um segundo
registro do mesmo fato só existiria para divergir do primeiro.

Três endossos é fixo, e não proporcional ao tamanho da praça. Proporcional
pareceria mais justo e seria pior: numa praça de seis, "metade" seriam três, e
numa de dez, cinco — o mesmo aval valeria coisas diferentes conforme quantas
lojas fecharam a janela, o que é um acidente de calendário.

O efeito colateral desse número fixo é aritmético, e a apuração o expõe: numa
praça pequena pode não haver fundadoras suficientes para fechar três endossos.
`apuracao.alcancavel` responde isso **na abertura da candidatura** — sem ele, a
única notícia seria a caducidade trinta dias depois, sem ninguém saber que nunca
houve chance.

> **Limite conhecido.** Endossos numa praça de 60 km não são independentes — as
> fundadoras se conhecem e compram nos mesmos leilões. Três endossos medem
> reputação no mercado, não saúde financeira. O contrapeso não está aqui: está na
> exposição graduada de quem acaba de entrar e no registro de conduta entre
> lojas.
>
> A janela de fundação tem o seu próprio: quem entra na janela leva a condição
> de fundadora **sem** ter passado pelo crivo de três endossos, porque as
> fundadoras são constituintes, não credenciadas. Isso é aceito de propósito —
> é o preço de montar a praça — mas é a razão de a janela ter teto de um ano.
> Janela larga demais transforma a exceção em regra, e a adesão cheia nunca
> entra.

### 5. O que a rede cobra — e o que ela não cobra

Duas receitas, e **nenhuma por transação**:

| | Fundadora | Depois |
|---|---|---|
| Adesão (uma vez, não é caução) | R$ 3.000 | R$ 6.000 |
| Mensalidade da empresa, 1ª loja inclusa | R$ 599 | R$ 599 |
| Cada loja adicional | R$ 159 | R$ 159 |

**Zero taxa por repasse, e isso é o desenho.** Cobrar por negócio fechado
criaria exatamente dois incentivos ruins: combinar por fora e subdeclarar o
valor. Cobrando só acesso, quem usa mais não paga mais por usar — o que é
precisamente o comportamento que a plataforma precisa induzir — e a única forma
de a receita crescer é a rede crescer.

Cobrar por pátio adicional não é cobrar duas vezes pelo mesmo serviço: o volume
da rede beneficia cada expositor, e cada pátio a mais é mais estoque a
sincronizar, mais custódia a rastrear e mais gente na plataforma.

**A tabela é versionada, com data de vigência.** Quem entra depois paga adesão
maior — é o que premia quem entrou no começo. E sobe por ato de governança, não
por fórmula: um reajuste automático aumentaria preço sem ninguém ter decidido
aumentar, e a primeira notícia seria a fatura do lojista.

**A fundadora fica 24 meses na tabela que assinou**, e congela a tabela
*inteira*: pátio aberto no mês 10 entra pelo preço congelado. Congelar só a
linha da empresa faria a fundadora descobrir o reajuste no momento em que
decidisse crescer — que é o momento em que a rede quer que ela cresça.

**Trinta dias de atraso suspendem a empresa**, e com ela todos os pátios: o
contrato é um só. Duas coisas que a suspensão deliberadamente **não** faz:

- não interrompe a custódia em curso. Carro de terceiro no pátio da empresa
  suspensa continua podendo voltar para a dona — transformá-lo em refém de uma
  fatura puniria quem não deve nada;
- não para a cobrança. Se parasse, ficar suspenso sairia mais barato que pagar.

A fatura emitida é **fato, não consulta**: valor e memória de cálculo ficam
congelados. Recalcular na leitura faria um pátio aberto hoje mudar
retroativamente uma fatura de três meses atrás. E o vencimento conta da
emissão, não da competência — se a plataforma ficar sem faturar e recuperar
quatro ciclos de uma vez, nenhum nasce vencido: ninguém fica inadimplente de um
boleto que nunca recebeu.

### 6. Empresa e loja são coisas diferentes

A tabela acima só existe como preço se **empresa** e **loja** forem separadas, e
por isso são:

- a **empresa** (`Member`) paga, é fundadora, endossa e é suspensa;
- a **loja** (`Store`) opera: custódia, estoque, trava, vistoria. Quem responde
  pelo carro é quem está com ele, e isso não se reparte entre filiais.

Daí **dois status**, não um: `Member.status` é contratual (inadimplência,
saída), `Store.status` é operacional (quebra de protocolo de entrega ou
retirada). `canTransact(store, member)` exige os dois de pé — unificar seria
escolher entre punir pátio que não fez nada e deixar empresa inadimplente
operando pela filial.

A separação fecha um buraco que só aparece depois dela: **se o endosso fosse do
pátio, um grupo com três lojas credenciaria uma candidata sozinho**, assinando
de cada uma. O endosso é da empresa, exercido pelo titular de qualquer pátio
dela, e endossar de novo atualiza a nota *por empresa*.

A identidade da empresa é a **raiz do CNPJ** (8 dígitos), derivada do CNPJ da
primeira loja — filial compartilha a raiz. Isso faz "essa loja é da mesma
empresa?" ser pergunta verificável em vez de declaração em que se acredita, e é
o que impede `POST /api/v1/lojas` de virar a porta dos fundos para credenciar
uma empresa inteira pelo preço de uma filial.

### 7. Conduta: as quebras que o sistema mede sozinho

"Quebrar o protocolo três vezes suspende" só vira regra se **quebra** for algo
que o sistema mede sem ninguém opinar. Julgamento humano sobre quem falhou seria
um tribunal entre concorrentes — exatamente o que esta rede não pode ter. Então
toda quebra atende três critérios: **objetiva** (sai de um prazo vencido ou de
um carimbo que faltou), **atribuível** (sobra para uma loja só) e **já medida**
(o sistema conhece o fato antes de alguém reclamar).

São quatro:

| Quebra | De quem | Sai de |
|---|---|---|
| Não devolveu no prazo do recall | custodiante | SLA de 4h úteis vencido |
| Não retirou o carro disponibilizado | quem pediu o recall | escape operacional sem retirada |
| Não deu aceite em entrega declarada no pátio | quem recebe | entrega com coordenada conferida |
| Deixou o carro em trânsito sem entregar nem cancelar | loja de origem | termo aberto além do plausível |

**A geolocalização da entrega passou a ser conferida.** Ela já era obrigatória,
mas não havia com o que compará-la: provava *uma* posição, não *a* posição — um
número que ninguém confere é decoração, não registro. Agora cada loja tem a
coordenada do pátio (`StoreProfile.yard`), e a declaração feita fora de um raio
de 500 m é **recusada na hora**, com a distância no erro. Isso impede o engano em
vez de puni-lo, e é o que torna "não deu aceite" atribuível: sem a conferência,
"declarei que deixei" contra "não chegou" seria palavra contra palavra.

O raio é generoso de propósito. GPS de celular em rua de centro erra mais de cem
metros; um raio apertado transformaria falha de sinal em acusação de declaração
falsa. O que 500 m elimina é a declaração feita de qualquer lugar — que era o
caso real.

**A janela é móvel, de 12 meses.** Uma quebra por ano durante três anos é um
problema diferente de três quebras num mês, e só a janela móvel separa os dois:
com contagem vitalícia, toda loja antiga viraria candidata a suspensão por
acúmulo lento. E o pátio **reabre sozinho** quando a janela alivia — punição que
depende de alguém lembrar de tirar vira permanente.

Três quebras suspendem o **pátio**, não a empresa: quem quebrou o protocolo foi
aquele pátio, e derrubar a matriz porque a filial atrasou três entregas puniria
quem não fez nada. Inadimplência é o caso oposto, e por isso os dois status
existem separados.

> **Fora do registro de conduta, de propósito.** Divergência de vistoria
> (odômetro além da tolerância, combustível a menos, avaria nova) **não** é
> quebra de protocolo — é dano, e o produto deliberadamente não arbitra dano.
> Contá-la como quebra transformaria o registro objetivo numa acusação
> automática, e a primeira loja a marcar um risco no termo aprenderia a não
> marcar mais. Declaração de entrega feita longe do pátio também não entra: ela é
> recusada na hora, e ato recusado não causou dano — registrar tentativa recusada
> puniria falha de GPS, que é indistinguível de má-fé com os dados que existem.

### 8. Desligamento: entrar é discricionário, sair é probatório

Essa assimetria é o desenho inteiro.

**Entrar** é discricionário: a fundadora endossa porque conhece a candidata e não
precisa provar nada. Por isso não existe endosso contrário — dar a cada fundadora
um veto individual sobre concorrência direta seria o abuso óbvio.

**Sair** é probatório: uma moção de desligamento só pode ser aberta contra quem
**já tem o registro medido** — reincidência em quebra de protocolo, isto é, uma
segunda suspensão por conduta. Sem essa exigência, o desligamento viraria o veto
que a admissão recusou, com a agravante de servir para remover quem está vendendo
bem. A opinião decide quem entra; o registro decide quem *pode* ser posto para
fora.

O fundamento é **apurado do registro**, não informado por quem abre: deixar a
proponente declarar a reincidência transformaria a guarda em formalidade — quem
quer desligar um concorrente também sabe digitar "2". E ele é **copiado na
abertura**, porque a janela móvel alivia com o tempo e a moção não pode perder o
chão no meio da votação porque o calendário andou.

Duas coisas seguem o formato da admissão, pelos mesmos motivos: **não há voto
contra** (o silêncio já é contra, e registrar "sou contra" tornaria visível quem
defendeu quem, que é como se constrói retaliação) e **há prazo** — moção que não
junta apoio caduca, e o desfecho por inércia é *fica*. Se "sai" fosse o default
do silêncio, bastaria abrir moções e esperar.

O quórum, ao contrário dos três endossos, é **proporcional**: dois terços das
fundadoras ativas, excluída a acusada, com piso de duas. Não é incoerência — na
admissão o que se mede é confiança, e três lojas respondendo por uma quarta é uma
unidade que não encolhe porque a praça é pequena; aqui o que se mede é consenso
da rede sobre expulsar alguém, e consenso é proporção por definição.

O desligamento **não espera a custódia se resolver, e não é bloqueado por ela**:
se estar com o carro de um parceiro adiasse a saída, bastaria segurar um carro
para nunca ser desligado — o refém viraria escudo. As obrigações sobrevivem, e a
lista de carros ainda em poder da empresa desligada vai no evento, para cada dona
saber no mesmo instante o que precisa chamar de volta.

### 9. Saída voluntária: duas comportas

Sair por vontade própria é um fluxo **diferente** do desligamento, e usar o mesmo
seria errado nos dois sentidos. Desligamento é sanção: precisa de fato provado,
quórum e prazo de votação, e quem decide são os outros. Saída é decisão de quem
sai — ninguém vota, ninguém precisa concordar, e não há nada a provar.

Mas saída também não pode ser instantânea, e a razão não é burocrática: no
instante em que a empresa deixa a rede, todo carro que ela ainda detiver — ou que
ainda estiver detido por outros — fica **sem contraparte**. Não há mais recall a
pedir, prazo a cobrar nem conduta a registrar. O livro de custódia continuaria
dizendo quem está com o quê, e não haveria mais rede para fazer nada a respeito.

Daí duas comportas, e as duas precisam abrir:

1. **Tempo** — 30 dias de aviso prévio, para os parceiros se reorganizarem. Quem
   conta com aquele estoque precisa de aviso, não de surpresa.
2. **Estado** — nada em aberto: nenhum carro de terceiro no pátio dela, nenhum
   carro dela em pátio alheio, nenhuma trava, negociação ou cobrança viva.

**A comporta de estado é a que importa, e ela não é uma data.** Por mais que o
prazo tenha vencido, a empresa não sai enquanto estiver com o carro de alguém. O
aviso prévio é um mínimo, não o gatilho.

Entre o aviso e a saída a empresa fica em `LEAVING`, e o estado tem sentido
preciso: **não adquire exposição nova** — não trava carro alheio, não recebe
custódia, não apresenta nem endossa candidata — **mas termina tudo o que já
estava aberto**. Bloquear o encerramento prenderia o carro de terceiro no pátio
de quem está saindo, que é o oposto do que se quer.

Isso cai fora de graça: `memberInGoodStanding` responde falso para `LEAVING`, e é
por ele que `canTransact` passa. Trava, apadrinhamento e endosso param sozinhos;
check-in, devolução, recall e liquidação — que não passam por ali — seguem
funcionando. Uma regra, não sete.

**A saída se conclui sozinha.** Não há botão final de "sair agora": no passe do
varredor em que a última pendência fecha, a empresa sai. A última pendência
costuma fechar por um ato de *outra* loja — o aceite de uma devolução, a
liquidação de uma negociação — e quem está saindo não tem como saber a hora
exata. Exigir um gesto humano deixaria a empresa pronta e presa, esperando alguém
reparar.

Duas decisões laterais que valem registro: uma empresa **suspensa** pode avisar
saída (impedir faria da suspensão uma armadilha — presa a uma rede em que não
opera, acumulando mensalidade), e as **candidaturas que ela apadrinhou** são
retiradas junto, porque deixar a candidata pendurada até caducar seria 30 dias de
silêncio sobre um fato que já se sabe.

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
│   ├── network/     lojas, usuários, credenciamento por endosso
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
de feeds, o material de divulgação e a trilha de auditoria. 409 testes,
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
