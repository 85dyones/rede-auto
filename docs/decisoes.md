# Decisões de projeto

O que foi decidido, por quê, e o que foi descartado no caminho.

---

## 1. Físico e comercial como eixos independentes

**Decisão.** `Vehicle` tem dois blocos sem acoplamento: `commercialStatus` /
`activeLockId` e `physical`. Nenhuma transição de um altera o outro.

**Por quê.** É a nuance central do negócio. Um ERP de estoque amarra "onde o
carro está" a "quem pode vendê-lo"; aqui, se a Loja B levou o carro para o
showroom e o cliente desistiu, gastar frete de devolução destrói o valor da
rede. O carro precisa voltar a ser ofertado a todos **sem sair do lugar**.

**Descartado.** Um único campo `status` com valores combinados
(`AVAILABLE_AT_OWNER`, `AVAILABLE_AT_PARTNER`, `LOCKED_AT_PARTNER`…). O produto
cartesiano cresce a cada estado novo, e toda regra de trava passaria a precisar
saber onde o carro está — que é exatamente o acoplamento que se quer evitar.

---

## 2. Sem carência depois que a trava expira

**Decisão.** Expirou, primeiro a travar leva — inclusive a loja que acabou de
perder o prazo.

**Por quê.** O enunciado do negócio é explícito: ao expirar, o veículo "passa a
ser uma oportunidade imediata de balcão para a Loja B **ou** para qualquer outro
membro". O carro está no pátio dela; negar a nova trava seria empurrar a venda
para fora da plataforma.

**Descartado.** Uma carência de 15 minutos contra quem acabou de perder o prazo,
como anti-abuso. Contradiz a regra de negócio e resolveria um problema que o
teto de 5 dias já resolve. O que ficou no lugar: histórico completo de travas
por veículo, para que o abuso seja *visível* — quem repete o padrão fica exposto
à rede, que é o mecanismo certo entre parceiros comerciais.

---

## 3. Teto da trava em 5 dias, não 7

**Decisão.** `maxTotalMs = 5 dias`.

**Por quê.** A primeira versão usava 7 dias. Somando todas as extensões
possíveis (4h base + 72 + 48 + 24 + 4×2 + 2×2) chega-se a **160 horas** — menos
que 168. O teto nunca vinculava: era código morto que passaria em qualquer
teste. Com 5 dias (120h) ele efetivamente corta, e existe um teste que prova
isso.

Vale como princípio geral: **um limite que a soma dos caminhos não alcança não é
um limite.**

---

## 4. A dona não cancela trava de terceiro

**Decisão.** Só o detentor libera a trava antes do prazo. A loja proprietária
não tem esse poder.

**Por quê.** A exclusividade dentro do prazo é o que a Loja B "compra" ao
assumir o cliente final. Se a dona pudesse derrubá-la por telefone, a trava não
valeria nada e o produto voltaria a ser uma planilha compartilhada.

Para reaver o carro, a dona usa recall — que **respeita** o prazo e só começa a
correr depois.

**Descartado.** Um cancelamento administrativo com aval de fundadores para casos
de fraude. É resolução de disputa, não fluxo de produto, e projetar isso sem
casos reais produziria a regra errada. Fora de escopo, e declarado como tal.

---

## 5. O SLA de recall não retroage

**Decisão.** Quando a trava cai, o SLA começa **daquele instante**, não do
momento do pedido.

**Por quê.** A loja custodiante estava legitimamente segurando o carro enquanto
a trava valia. Cobrar dela um prazo que correu enquanto ela não podia agir seria
punir o comportamento correto — e ensinaria as lojas a não travar.

---

## 6. Responsabilidade civil muda no check-in, não no checkout

**Decisão.** Em trânsito, `custodianStoreId` continua sendo a loja de **origem**.

**Por quê.** Quem ainda não viu o carro não pode herdar o risco dele. Se a
responsabilidade passasse na saída, a loja de destino responderia por uma avaria
ocorrida no guincho, sem ter conferido nada.

**Consequência.** O tempo em trânsito pertence à origem no livro de custódia, e
a atribuição de multa reflete isso.

---

## 7. Horas úteis de verdade, não `+ 4 * 3600_000`

**Decisão.** Aritmética completa de horas úteis: fuso via `Intl`, dias e janelas
configuráveis por dia da semana, feriados nacionais incluindo os móveis
derivados da Páscoa.

**Por quê.** O SLA contratual é "até 4 horas **úteis**". Somar milissegundos
daria prazos vencendo às 2h de domingo, e a loja seria cobrada por um atraso
impossível de evitar. O sábado tem janela própria (09:00–13:00) porque loja de
seminovos abre sábado, e tratá-lo como dia inteiro inflaria todo prazo pedido na
sexta à tarde.

**Descartado.** Uma biblioteca de datas. O cálculo cabe em ~150 linhas testadas,
e a dependência traria muito mais superfície do que resolve.

---

## 8. Dinheiro em centavos inteiros

**Decisão.** `Money = { currency: 'BRL', cents: number }`, sempre inteiro.

**Por quê.** Uma diferença de 1 centavo entre o líquido acordado e o valor
liquidado vira disputa entre lojistas. O parser aceita os formatos que os feeds
realmente mandam (`"89.900,00"`, `"89900.00"`, `"R$ 89.900,00"`) porque o mesmo
integrador varia entre eles.

---

## 9. Domínio funcional puro, sem classes de agregado

**Decisão.** Dados imutáveis + funções puras
`(estado, comando) → Result<{estado', eventos}, erro>`.

**Por quê.** Duas consequências práticas. Testar "trava expirada não pode ser
estendida" vira uma chamada de função — sem banco, sem relógio real, sem
servidor. E como o novo estado só existe no retorno, **não há meio-caminho
persistido** quando uma regra rejeita o comando: o objeto original nunca foi
tocado.

**Descartado.** Agregados como classes com métodos mutadores. Funciona, mas
convida a "mutar primeiro, validar depois", e o custo aparece quando duas regras
mutam o mesmo objeto e a segunda falha.

---

## 10. `Result` para falhas de negócio, `throw` só para bugs

**Decisão.** Tudo que um usuário da rede pode causar retorna `err(...)`.
`throw` é reservado a invariantes quebradas (`InvariantViolationError`).

**Por quê.** "A trava já expirou" não é excepcional — é o caminho normal de um
sistema com prazo. Tratar como exceção esconde o erro no tipo de retorno e
convida a `catch` genérico. E a distinção fica útil na borda HTTP: `DomainError`
vira 4xx com código estável; `InvariantViolationError` vira 500 e alerta.

---

## 11. Expiração preguiçosa **e** ativa

**Decisão.** A trava é materializada em toda leitura do veículo e também por um
varredor periódico, ambos pela mesma função idempotente.

**Por quê.** Só preguiçosa: o carro voltaria a ficar disponível sem que ninguém
soubesse até alguém abrir a tela — e o valor da regra está justamente em avisar
a rede. Só ativa: um varredor parado deixaria o sistema mostrar estado vencido.

Com as duas, o varredor garante **pontualidade**, não **correção** — pode
falhar, atrasar ou nem rodar sem produzir estado inválido.

---

## 12. Rede fechada: o anonimato muda de lugar

**Decisão.** Não existe superfície para o consumidor. Nenhuma rota pública de
negócio, nenhum link enviado ao cliente, nenhuma página hospedada. O consumidor
é atendido no canal da própria loja parceira.

**Por quê.** A plataforma existe para viabilizar o negócio **entre as lojas** —
o que hoje acontece por WhatsApp, é moroso e mata a venda. Hospedar anúncio a
colocaria no meio da relação da parceira com o cliente dela, que não é o
problema que ela resolve.

**Consequência que reorganiza o desenho.** Num marketplace, o anonimato protege
a página pública. Aqui, **dentro** da rede não há segredo entre parceiras: elas
se conhecem, e precisam ver de quem é o carro, qual o líquido e o que diz o
laudo para decidir. O que precisa ser neutro é o material que **sai** daqui,
porque ele vai ser republicado por outra loja no canal dela.

**Descartado.** O link temporário `/s/:token` com TTL, contagem de aberturas e
revogação — toda essa mecânica existia para controlar uma página de consumidor
que deixou de existir. Removê-la eliminou um agregado inteiro.

---

## 21. Fotos neutras são uma coleção separada, não um filtro

**Decisão.** O veículo tem duas coleções: as fotos do feed (uso interno) e um
conjunto **neutro** publicado pela loja dona, que é o único que entra no
material.

**Por quê.** As fotos do feed foram tiradas para o anúncio da própria dona.
Quase sempre têm adesivo no vidro, a fachada refletida no para-brisa, a placa
legível, o banner da loja ao fundo. Usá-las como material da rede entregaria a
origem no primeiro anúncio que a parceira publicasse.

O vazamento mais fácil de esquecer não é nem a foto: é a **URL** dela.
`cdn.primemotors.com.br/onix-1.jpg` entrega a loja sem que ninguém perceba. Por
isso o material referencia só caminhos da plataforma, e sem base de mídia
configurada o kit sai **sem foto** — melhor incompleto do que vazando.

**Assumido.** A curadoria é humana. Decidir se um adesivo entrega a origem é
julgamento, não regra que software aplique sozinho; o sistema garante que o
conjunto exista e cubra frente, traseira e interior. Borrar placa e remover
marca automaticamente é visão computacional, fora de escopo — e declarado como
tal.

**O CRLV fica de fora** pelo mesmo raciocínio: ele está no nome da loja dona.
Entre parceiras logadas isso não é segredo, mas o material é feito para sair, e
o CRLV entregaria a origem justamente onde não pode. O laudo cautelar circula
porque fala do carro, não de quem o possui.

---

## 22. A dona não vê a margem da parceira

**Decisão.** Os números da loja vendedora — preço ao consumidor, valor dado na
troca, margem, resultado — vivem num bloco `sellerPrivate` que a loja
proprietária **não recebe**. Para terceiros a negociação sequer existe (404).

**Por quê.** Era um defeito real: `GET /negociacoes/:id` deixava qualquer loja
autenticada ler qualquer negociação. Numa rede em que concorrentes dividem
estoque, isso destrói o modelo — bastaria a dona olhar uma venda para saber
quanto subir o líquido na próxima, e o incentivo para a parceira trazer clientes
acabaria junto. "A Loja B retém 100% da margem excedente" só vale se a margem
for dela também no sentido de ninguém mais poder medi-la.

**Como ficou estrutural, e não só uma regra.** `dealDto` passou a exigir o id de
quem está olhando. O compilador recusa qualquer serialização que não declare o
espectador, então esquecer o corte deixou de ser possível sem quebrar o build.

Pelo mesmo motivo o evento `deal.selling_below_net_price` não carrega o preço
praticado, e `deal.confirmed` não carrega o resultado da vendedora: eventos
alimentam notificação e auditoria, e a dona lê as duas.

---

## 19. Preço ao consumidor é opcional

**Decisão.** `retailPriceToConsumer` pode ser `null`.

**Por quê.** Quem define valor na plataforma é a dona — o líquido é o número do
negócio entre as duas lojas. O preço ao consumidor é da parceira, praticado no
canal dela, fora daqui. Exigi-lo transformaria a plataforma em registro de uma
venda que ela não intermedeia.

Quando a parceira registra, é para os próprios números, e eles ficam no bloco
privado. Sem ele, tudo degrada em silêncio: a margem vem `null`, a validação de
valor da troca contra o preço de venda é pulada, e o acordo entre as lojas segue
idêntico.

---

## 20. Sanitização por lista de inclusão

**Decisão.** `buildMaterialKit` monta o objeto campo a campo. Nunca
`{...vehicle}` com remoções.

**Por quê.** Com spread, todo campo novo do agregado passa a vazar **por
padrão**, e o vazamento só aparece em produção — no anúncio da parceira, que é o
pior lugar possível. Com lista de inclusão, o padrão é não vazar.

Reforçado por `findLeaks`, um guarda de runtime que varre o kit serializado
antes de o download sair. Ele duplica o que os testes cobrem, de propósito: um
campo adicionado meses depois não vaza silenciosamente porque ninguém lembrou de
atualizar a função.

---

## 21. O feed não decide sozinho

**Decisão.** A sincronização nunca move custódia física, nunca derruba
negociação em andamento, e não retira da rede um carro que sumiu do feed mas
está no pátio de outra loja.

**Por quê.** O feed é a fonte da verdade sobre **catálogo** — ficha, fotos,
preços, laudo. Não sobre nada mais. Onde o carro está resulta de termos
assinados. E "sumiu do feed" normalmente significa venda no balcão sem baixa:
alguém precisa combinar o retorno, e o sincronizador não tem essa informação.

**Consequência desenhada.** Com trava ativa, o preço líquido novo fica
represado em `pendingNetPrice` e só vale quando a trava cair — a Loja B fecha
pelo número que travou.

---

## 22. Chassi como chave de deduplicação da rede

**Decisão.** Chassi já anunciado por outra loja é recusado, tanto no cadastro
manual quanto na ingestão.

**Por quê.** É a duplicidade de venda que a plataforma existe para impedir. O id
externo do integrador não serve: ele muda quando a loja troca de sistema — e por
isso a sincronização casa por id externo **ou** por chassi, nessa ordem.

---

## 19. Zero dependências de runtime

**Decisão.** Só Node built-ins. Parser XML, gerador de PDF, roteador HTTP e
autenticação escritos à mão.

**Por quê.** Cada peça é pequena e o escopo é conhecido: o parser XML precisa
**recusar** o que é perigoso mais do que cobrir a especificação inteira; o
roteador são ~100 linhas; a ficha em PDF é texto, linhas e retângulos numa A4.

Numa aplicação que move dinheiro de terceiros e ingere XML de fornecedores, a
superfície de uma dependência no caminho crítico custa mais do que resolve
**neste tamanho**. A conta mudaria se a ficha precisasse de imagens embutidas
ou o parser tivesse que lidar com namespaces de verdade.

**Custo assumido.** O gerador de PDF não embute imagens — a ficha lista o
material fotográfico que acompanha o kit, e as fotos vão como arquivos. A saída foi validada com pdf.js.

---

## 20. Português nos limites, inglês na estrutura

**Decisão.** Identificadores de código em inglês; termos intraduzíveis do
domínio (ATPV-e, laudo cautelar, placa, chassi) em português; mensagens de erro,
API e documentação em português.

**Por quê.** O código fica legível para qualquer engenheiro, e o vocabulário do
negócio — que é onde a ambiguidade custa caro — fica ancorado no
[glossário](glossario.md). As mensagens de erro são lidas por lojistas.

---

## 21. Concorrência: o que muda quando sair da memória

O adaptador atual é em memória e o processo é single-threaded, então **duas
tentativas de travar o mesmo carro nunca se cruzam**. Isso é uma propriedade do
adaptador, não do domínio — e é exatamente a propriedade que reintroduziria a
venda duplicada se fosse perdida sem substituição.

Onde a corrida existe, em ordem de gravidade:

| Operação | O que pode acontecer | O que resolve |
|---|---|---|
| `openLock` | duas lojas leem `AVAILABLE` e ambas travam | índice único parcial em `(vehicle_id) WHERE status = 'ACTIVE'` na tabela de travas |
| `confirmDealSale` | negociação, trava e recall mudam em três escritas | uma transação envolvendo os três |
| `checkIn` | dois check-ins do mesmo termo | `UPDATE … WHERE status = 'OPEN'` e conferir as linhas afetadas |
| `registerSettlement` | duas parcelas simultâneas estourando o saldo | recalcular o saldo dentro da transação, com `SELECT … FOR UPDATE` no deal |

O índice único é o mais importante: ele transforma a corrida numa violação de
constraint, que o serviço traduz para o mesmo `409 VEHICLE_ALREADY_LOCKED` que
já existe. O domínio não muda — a checagem em `openLock` continua sendo a
primeira linha de defesa e a que produz a mensagem boa.

O desenho já facilita isso: as funções de domínio são puras e devolvem o estado
novo sem persistir, então envolver "carregar → decidir → salvar" numa transação
é trabalho do serviço de aplicação, não uma reescrita.

---

## 22. O que ficou de fora, e por quê

| Fora de escopo | Motivo |
|---|---|
| Persistência real | as portas estão prontas; o adaptador exige decisão de transação que depende do banco escolhido |
| Autenticação de produção | rotação, revogação, escopo por chave e rate limit são infraestrutura, não domínio |
| Resolução de disputa de avaria | projetar sem casos reais produziria a regra errada; as divergências já ficam registradas |
| Precificação sugerida / integração FIPE | o produto elimina a negociação de margem; sugerir preço seria reintroduzi-la |
| Notificações | o barramento existe e os eventos estão nomeados; falta o assinante |
| Multi-moeda | a rede é brasileira; `Money` fixa BRL de propósito, para o tipo não mentir |
