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

## 12. Sanitização white-label por lista de inclusão

**Decisão.** `buildWhiteLabelSheet` monta o objeto campo a campo. Nunca
`{...vehicle}` com remoções.

**Por quê.** Com spread, todo campo novo do agregado passa a vazar **por
padrão**, e o vazamento só aparece em produção. Com lista de inclusão, o padrão é
não vazar e o esforço fica do lado certo.

Reforçado por `findLeaks`, um guarda de runtime que varre a lâmina serializada
antes de responder. Ele duplica o que os testes cobrem — de propósito: um campo
adicionado meses depois não vaza silenciosamente porque ninguém lembrou de
atualizar a função.

### As fotos são o vazamento mais fácil de esquecer

`cdn.primemotors.com.br/onix-1.jpg` entrega a loja proprietária sem que ninguém
perceba. As URLs originais nunca saem na lâmina; as fotos passam por
`/s/:token/fotos/:i`. Sem proxy configurado, a lâmina sai **sem foto** — melhor
que vazar.

Hoje a rota redireciona. Para esconder o domínio também do tráfego, é preciso
servir os bytes com cache; o contrato da rota não muda.

---

## 13. O feed não decide sozinho

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

## 14. Chassi como chave de deduplicação da rede

**Decisão.** Chassi já anunciado por outra loja é recusado, tanto no cadastro
manual quanto na ingestão.

**Por quê.** É a duplicidade de venda que a plataforma existe para impedir. O id
externo do integrador não serve: ele muda quando a loja troca de sistema — e por
isso a sincronização casa por id externo **ou** por chassi, nessa ordem.

---

## 15. Zero dependências de runtime

**Decisão.** Só Node built-ins. Parser XML, gerador de PDF, roteador HTTP e
autenticação escritos à mão.

**Por quê.** Cada peça é pequena e o escopo é conhecido: o parser XML precisa
**recusar** o que é perigoso mais do que cobrir a especificação inteira; o
roteador são ~100 linhas; a lâmina em PDF é texto, linhas e retângulos numa A4.

Numa aplicação que move dinheiro de terceiros e ingere XML de fornecedores, a
superfície de uma dependência no caminho crítico custa mais do que resolve
**neste tamanho**. A conta mudaria se a lâmina precisasse de imagens embutidas
ou o parser tivesse que lidar com namespaces de verdade.

**Custo assumido.** O gerador de PDF não embute imagens — as fotos vão na versão
HTML, que é a que o cliente abre no celular. A saída foi validada com pdf.js.

---

## 16. Português nos limites, inglês na estrutura

**Decisão.** Identificadores de código em inglês; termos intraduzíveis do
domínio (ATPV-e, laudo cautelar, placa, chassi) em português; mensagens de erro,
API e documentação em português.

**Por quê.** O código fica legível para qualquer engenheiro, e o vocabulário do
negócio — que é onde a ambiguidade custa caro — fica ancorado no
[glossário](glossario.md). As mensagens de erro são lidas por lojistas.

---

## 17. O que ficou de fora, e por quê

| Fora de escopo | Motivo |
|---|---|
| Persistência real | as portas estão prontas; o adaptador exige decisão de transação que depende do banco escolhido |
| Autenticação de produção | rotação, revogação, escopo por chave e rate limit são infraestrutura, não domínio |
| Resolução de disputa de avaria | projetar sem casos reais produziria a regra errada; as divergências já ficam registradas |
| Precificação sugerida / integração FIPE | o produto elimina a negociação de margem; sugerir preço seria reintroduzi-la |
| Notificações | o barramento existe e os eventos estão nomeados; falta o assinante |
| Multi-moeda | a rede é brasileira; `Money` fixa BRL de propósito, para o tipo não mentir |
