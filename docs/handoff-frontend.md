# Handoff de frontend — rede-auto

**Para:** Claude Design · **De:** time de backend · **Status:** API implementada e
testada (337 testes), frontend inexistente.

Este documento é o briefing para a proposta visual. Tudo aqui está ancorado no
contrato real da API — os JSON citados são respostas de verdade, capturadas do
servidor rodando, não exemplos inventados. Se um campo não aparece aqui, ele não
existe ainda.

Leituras de apoio: [`../README.md`](../README.md) (o produto),
[`dominio.md`](dominio.md) (máquinas de estado), [`api.md`](api.md) (contrato
completo), [`glossario.md`](glossario.md) (vocabulário).

---

## 1. O produto, em um minuto

Rede fechada de **6 lojas fundadoras** de seminovos que compartilham estoque
entre si. Quando a Loja B tem um cliente para um carro que está na Loja A, hoje
isso se resolve por telefone: negocia margem, confirma disponibilidade, combina
o frete. A plataforma substitui essa ligação.

O modelo comercial é deliberadamente simples:

- A Loja A fixa um **preço líquido de repasse** — o que ela exige receber.
- A Loja B assume o cliente por inteiro (atendimento, financiamento, carro de
  troca, garantia do CDC) e **precifica como quiser**.
- Tudo acima do líquido é 100% da Loja B. Não há rateio, não há comissão.

**Não existe tela de negociação de margem.** Se a proposta de design incluir
uma, o produto foi mal entendido — é exatamente o atrito que ele elimina.

---

## 2. Quem usa, onde, com que pressa

| Persona | Papel na API | Onde está | Pressa |
|---|---|---|---|
| **Vendedor** | `SALESPERSON` | em pé, no showroom, celular na mão, cliente ao lado | máxima — minutos |
| **Gerente** | `MANAGER` | mesa, desktop, entre uma coisa e outra | média — horas |
| **Titular** | `PRINCIPAL` | mesa ou celular, decide preço e governança | baixa — dias |

O vendedor é quem manda no design. Ele abre a trava com o cliente olhando,
manda a lâmina pelo WhatsApp antes do cliente esfriar, e faz a vistoria do carro
em pé no pátio, sol na tela, às vezes com uma mão só.

Um usuário pertence a **uma** loja. A mesma pessoa nunca vê a rede de dois
ângulos ao mesmo tempo — mas vê o mesmo carro de ângulos diferentes conforme o
papel da loja dela naquele carro (dona, custodiante, interessada).

---

## 3. A decisão de design que define o produto

**Um carro tem dois estados ao mesmo tempo, e um badge só mente.**

```
  EIXO COMERCIAL                        EIXO FÍSICO
  quem pode vender, e até quando        quem está com o carro
  muda em minutos                       muda em dias

  DISPONÍVEL / EM NEGOCIAÇÃO / VENDIDO  Pátio da Prime / Em trânsito / Pátio da Veloz
```

O caso que justifica o produto inteiro: a Loja B leva o carro para o showroom
dela, o cliente desiste, a trava de 4h expira. O carro volta a ser ofertado a
**toda a rede** — e não sai do lugar. Para a Loja B ele virou oportunidade de
balcão; para a rede, estoque disponível; para a Loja A, um carro dela em poder
de terceiro.

**O mesmo carro, no mesmo instante, para três lojas diferentes:**

| Quem olha | O que precisa ler na primeira olhada |
|---|---|
| **Loja A** (dona) | "é meu, está na Veloz, disponível — posso chamar de volta" |
| **Loja B** (com o carro) | "está comigo, posso vender agora, sem logística" |
| **Loja C** (terceiro) | "disponível, mas está em São Paulo — preciso resolver frete" |

Se o design resolver isso, resolveu o produto. Se tratar como um status só, vai
produzir uma tela que parece correta e é inutilizável.

A API já entrega os dois eixos separados e uma leitura pronta do ângulo de quem
olha — ver `vocePode` e `prioridade` na seção 5.

---

## 4. Os sete problemas difíceis

### P1 · O cartão de veículo tem que contar duas histórias

Resposta real de `GET /api/v1/veiculos`, item visto pela **Loja C** (terceiro):

```jsonc
{
  "comercial": { "situacao": "LOCKED", "travaAtivaId": "lck_0001" },
  "fisico":    { "situacao": "AT_YARD", "lojaCustodianteId": "str_veloz",
                 "desde": "2026-09-14T15:00:00.000Z" },
  "trava":     { "lojaDetentoraId": "str_veloz", "expiraEm": "2026-09-14T23:00:00.000Z",
                 "restante": "5h", "extensoes": 1 },
  "estoqueAvancado": true,
  "vocePode":  { "travar": false, "chamarDeVolta": false, "precificar": false }
}
```

A mesma resposta, vista pela **Loja A** (dona): `vocePode` vira
`{ "travar": false, "chamarDeVolta": true, "precificar": true }`.

`vocePode` já traduz as regras de autorização pela ótica de quem chamou — o
design **não precisa reimplementar** quem pode o quê. Use-o para decidir quais
ações aparecem.

### P2 · O cronômetro de 4 horas

A trava congela o carro para toda a rede, inclusive para a dona. O vendedor
precisa saber quanto resta sem que isso vire ansiedade permanente.

A API entrega `restante` já formatado (`"5h"`, `"47min"`) e `expiraEm` absoluto.
Estados a cobrir: **> 2h** (informativo), **< 1h** (atenção), **< 15min**
(crítico, com a ação de estender em destaque), **expirada** (o carro voltou para
a rede — e isso é uma notícia, não um erro).

### P3 · Estender exige evidência, e a evidência tem preço

Não é um botão "estender". É escolher **qual evidência de avanço no funil** você
tem, e cada uma vale um prazo diferente, com cota:

| Evidência (`evidencia`) | Soma | Usos | Anexo |
|---|---|---|---|
| `TRADE_IN_APPRAISAL` — avaliação da troca | +2h | 2 | não |
| `BANK_PROPOSAL_SUBMITTED` — proposta em análise | +4h | 2 | não |
| `BANK_PROPOSAL_APPROVED` — crédito aprovado | +24h | 1 | **sim** |
| `DEPOSIT_RECEIPT` — comprovante de sinal | +48h | 1 | **sim** |
| `SIGNED_ORDER` — pedido assinado | +72h | 1 | **sim** |

Teto absoluto: 5 dias desde a abertura. O design precisa mostrar cota consumida
(`extensoes: 1`) e deixar óbvio que três delas exigem anexar comprovante — o
erro `EVIDENCE_ATTACHMENT_REQUIRED` depois de preencher tudo é frustração
evitável.

### P4 · A regra de conflito precisa ser legível, não só aplicada

Quando a Loja A pede o carro de volta e a Loja B está negociando, o recall é
aceito mas **fica aguardando**. Resposta real:

```jsonc
{
  "situacao": "WAITING_LOCK_RELEASE",
  "travaBloqueadoraId": "lck_0001",
  "prazoIniciadoEm": null,
  "prazoFinal": null
}
```

Se a Loja A vir só "aguardando" sem entender por quê e até quando, ela pega o
telefone — e o produto falhou. A API entrega o texto pronto:

> `prioridade.justificativa`: "Há trava comercial ativa: a loja que abriu a
> negociação tem exclusividade até o fim do prazo."

**Mostre essa frase.** É o que impede a ligação.

### P5 · Dois números que nunca podem se confundir

O vendedor tem na mesma tela o **preço líquido** (R$ 85.000 — o que a Loja A
recebe, segredo comercial) e o **preço ao cliente** (R$ 96.900 — o que ele
pratica). Se ele virar o celular para o cliente na tela errada, o modelo da rede
quebra.

O design precisa de uma separação **brutal e persistente** entre:

- **visão interna** (B2B): mostra líquido, margem, quem é a loja dona;
- **modo cliente** (a lâmina): não mostra nada disso.

Não pode ser um toggle discreto. Sugestão: chrome visualmente distinto — a
lâmina como um contexto separado, não uma variação da mesma tela.

Existe um terceiro número tóxico: `liquidoRepresado`. Quando a dona reprecifica
durante uma trava, o novo valor fica represado e **só vale depois**:

```jsonc
"precos": {
  "liquidoRepasse":   { "formatado": "R$ 85.000,00" },   // vale agora
  "liquidoRepresado": { "formatado": "R$ 89.000,00" }    // vale quando a trava cair
}
```

Quem está negociando fecha por 85.000. Mostrar 89.000 com igual peso seria
mentir para quem está com o cliente na frente.

### P6 · Prazo em horas ÚTEIS

O SLA de recall é "4 horas **úteis**" no fuso de São Paulo, seg–sex 08–18h,
sábado 09–13h, feriados nacionais incluídos. Um pedido às 17h de sexta vence
**segunda às 11h**.

Nunca mostre só "faltam 4h". Mostre o **prazo absoluto legível** ("segunda,
11:00") e, ao lado, o tempo útil restante. Um contador regressivo cru atravessa
a madrugada e o fim de semana mentindo.

### P7 · A vistoria é feita em pé, no pátio

O termo de custódia exige **cinco fotos obrigatórias** (frente, traseira,
esquerda, direita, odômetro), odômetro, nível de combustível **em oitavos**
(0–8, como o ponteiro do painel — não porcentagem, não litros), avarias e
assinatura com CPF.

É o fluxo mais fisicamente constrangido do produto: uma mão, sol na tela, luvas.
E é o momento em que a **responsabilidade civil muda de loja** — a entrada
assinada transfere multa, avaria e sinistro. A tela precisa dizer isso, porque é
o que a pessoa está realmente assinando.

Divergências entre saída e entrada (rodou demais, combustível a menos, avaria
nova) viram registro objetivo. Quando aparecem, são a base de uma conversa sobre
dinheiro entre parceiros — merecem destaque, não uma linha de log.

---

## 5. Superfícies a desenhar

### P0 — sem isto não há produto

#### 5.1 Catálogo da rede

*Quem:* vendedor e gerente. *Decisão:* "existe na rede um carro para o meu
cliente, e consigo entregá-lo?"

`GET /api/v1/veiculos` · filtros: `marca`, `modelo`, `anoModeloMinimo`,
`kmMaximo`, `liquidoMaximoCentavos`, `limite`, `deslocamento`.

Cada item traz o bloco completo da seção P1. O cartão precisa de: foto, título
(`Chevrolet Onix 1.0 Turbo LTZ 2023`), ano/km, **preço líquido**, e os dois
eixos. `estoqueAvancado: true` é o sinal de que o carro está no pátio de um
parceiro — para quem está perto, é uma vantagem logística; mostre-a.

Estados: disponível · em negociação por outro (com quanto falta) · em negociação
por mim · disponível e já no meu pátio (o mais valioso).

#### 5.2 Ficha do veículo

*Quem:* todos. *Decisão:* travar ou não.

`GET /api/v1/veiculos/:id` — mesma estrutura, mais fotos, opcionais, laudo
cautelar (`laudoCautelar.situacao`, `empresa`, `validoAte`) e histórico de
travas.

O laudo é o **selo de qualificação da rede**: sem laudo aprovado e vigente o
carro nem aparece. Merece tratamento de confiança, não de rodapé.

#### 5.3 Trava ativa (atendimento em curso)

*Quem:* vendedor. *Decisão:* estender ou liberar.

Cronômetro (P2), evidências disponíveis com cota e prazo (P3), referência do
atendimento (`referenciaAtendimento: "ATD-4471"` — código interno da loja, sem
dado pessoal do cliente), e o caminho para montar a negociação.

Precisa também da saída digna: "cliente desistiu" → liberar. Liberar cedo é
comportamento **bom** para a rede; a tela não deve fazer parecer desistência
vergonhosa.

#### 5.4 No meu pátio

*Quem:* gerente e vendedor. *Decisão:* "o que tenho aqui que posso vender hoje?"

`GET /api/v1/veiculos/no-meu-patio` — carros **de outras lojas** fisicamente
comigo. Superfície que não existe em nenhum ERP e é onde o estoque avançado vira
receita. Destaque os que estão comercialmente disponíveis: são venda de balcão
imediata, sem frete e sem espera.

#### 5.5 Termo de vistoria (mobile-first, obrigatório)

*Quem:* gerente/conferente. Ver P7.

Dois momentos com a mesma estrutura e pesos diferentes:
**saída** (assina quem está com o carro) e **entrada** (assina o destino — e a
responsabilidade muda aqui).

Campos: `odometerKm`, `fuelEighths` (0–8), `photos[]` com `angle` ∈ FRONT, REAR,
LEFT, RIGHT, ODOMETER (+ INTERIOR, ENGINE_BAY, DAMAGE, OTHER opcionais),
`damages[]` (`area`, `severity` LIGHT/MODERATE/SEVERE, `description`),
`responsavel` (nome, CPF, função).

O termo é selado com SHA-256 e o CPF sai mascarado na leitura
(`"***.982.***-**"`). A tela de leitura de um termo deve transmitir que aquilo é
um documento assinado, não um formulário preenchido.

#### 5.6 Lâmina white-label (cliente final)

*Quem:* o consumidor, pelo WhatsApp. **Pública, sem login.**

`GET /s/:token` · `/lamina.html` · `/lamina.pdf`. Já existe uma versão HTML
funcional em `src/infra/render/lamina.ts` — o design deve **propor a versão
definitiva**, e ela é a peça de maior visibilidade do produto.

Resposta real (note o que **não** está lá):

```jsonc
{
  "referencia": "V2L8LNOZ",
  "titulo": "Chevrolet Onix 1.0 Turbo LTZ 2023",
  "ano": "2022/2023", "quilometragem": "38.437 km", "cor": "Prata",
  "combustivel": "Flex", "cambio": "Automatico", "portas": 4,
  "opcionais": ["Ar-condicionado", "Direcao eletrica", "Multimidia", "Camera de re"],
  "fotos": ["https://rede.exemplo.com.br/s/<token>/fotos/0", "…/1"],
  "preco": { "formatado": "R$ 96.900,00" },
  "laudoCautelar": { "aprovado": true, "situacao": "Laudo cautelar aprovado",
                     "empresa": "Cautelar Brasil" },
  "placa": null,
  "apresentadoPor": { "nomeFantasia": "Veloz Seminovos", "cidade": "Sao Paulo",
                      "uf": "SP", "telefone": "(19) 3201-4455" },
  "validoAte": "2026-09-16T18:00:00.000Z",
  "aviso": "Valores e disponibilidade sujeitos a confirmacao…"
}
```

Ausentes **por construção**: nome/CNPJ da loja dona, preço líquido, chassi,
placa completa, número do laudo, e o domínio original das fotos. A única marca
na página é a de quem compartilhou.

Requisitos: abre no celular em rede ruim; imprime bem (o cliente leva ao banco);
tema claro e escuro; `noindex`. O PDF é gerado sem imagens — proponha um layout
que funcione só com tipografia e estrutura.

---

### P1 — o produto funciona, mas manco, sem isto

#### 5.7 Recalls (os dois lados)

`GET /api/v1/recalls` devolve `devoDevolver` e `estouEsperando`. São dois estados
emocionais opostos na mesma tela — a obrigação e a espera. Ver P4 e P6.

Situações: `WAITING_LOCK_RELEASE` (sem prazo ainda) · `DUE` (correndo) ·
`FULFILLED` · `CANCELLED` (com `motivoCancelamento` — `SUPERSEDED_BY_SALE`
significa "o carro foi vendido, virou dinheiro em vez de voltar"). O campo
`descumpridoEm` marca SLA estourado.

#### 5.8 Negociação (a tela do dinheiro)

*Quem:* vendedor monta, gerente acompanha. Doze números; precisa de hierarquia.

```jsonc
"financeiro": {
  "precoAoConsumidor":              { "formatado": "R$ 96.900,00" },
  "valorDadoNaTroca":               { "formatado": "R$ 42.000,00" },
  "dinheiroDoConsumidor":           { "formatado": "R$ 54.900,00" },
  "liquidoDaLojaProprietaria":      { "formatado": "R$ 85.000,00" },
  "creditoDaTrocaParaProprietaria": { "formatado": "R$ 0,00" },
  "dinheiroDevidoAProprietaria":    { "formatado": "R$ 85.000,00" },
  "margemDaVendedora":              { "formatado": "R$ 11.900,00" },
  "resultadoDaVendedoraNaTroca":    { "formatado": "-R$ 42.000,00" },
  "resultadoTotalDaVendedora":      { "formatado": "-R$ 30.100,00" },
  "saldoAberto":                    { "formatado": "R$ 85.000,00" },
  "liquidado": false, "vendaAbaixoDoLiquido": false
}
```

Três blocos, nesta ordem de leitura: **o cliente paga** → **a Loja A recebe** →
**eu fico com**.

> ⚠️ **Armadilha real, ver na resposta acima.** Este exemplo está em
> `situacao: "AWAITING_TRADE_IN_ACCEPTANCE"` — transbordo proposto, ainda sem
> aceite da Loja A. Enquanto não há aceite, o crédito da troca é R$ 0,00, e por
> isso `resultadoTotalDaVendedora` aparece como **−R$ 30.100,00**. Esse número
> **não é o resultado da operação** — é o resultado *se a Loja A recusar tudo*.
> Exibi-lo como final faria um gerente rejeitar um bom negócio.
>
> Enquanto `situacao === "AWAITING_TRADE_IN_ACCEPTANCE"`, os três campos de
> resultado (`creditoDaTrocaParaProprietaria`, `resultadoDaVendedoraNaTroca`,
> `resultadoTotalDaVendedora`) devem aparecer como **pendentes**, não como
> valores.
>
> Hoje a única forma de saber disso é olhar `situacao` — o bloco `financeiro`
> não se autodescreve. Há uma proposta aberta de o backend passar um
> `aceiteDaTrocaPendente: true` junto dos números, para que a interface não
> precise correlacionar dois campos distantes para não mentir. **Decisão
> pendente com o time de backend** — desenhe o estado "pendente" de qualquer
> forma, porque ele existe nos dois cenários.

O **transbordo** (`destino: "OWNER_STORE"`) é um pedido de aceite que trava a
negociação. Do lado da Loja A é uma decisão com prazo implícito: alguém está
esperando para fechar uma venda.

#### 5.9 Liquidação

Pagamento parcial é o normal, não a exceção: entrada em PIX hoje, liberação do
banco em três dias. `saldoAberto` é o número que importa. Meios: `PIX`, `TED`,
`BANK_FINANCING`, `CASH`. Cada parcela exige comprovante.

#### 5.10 Mural de avisos

`GET /api/v1/notificacoes`. Três urgências:

```jsonc
{ "tipo": "recall.requested", "urgencia": "ACTION_REQUIRED",
  "titulo": "Retorno de veículo solicitado",
  "texto": "A loja proprietária pediu o veículo de volta. Sua trava comercial segue
            valendo até o fim do prazo; o SLA começa depois dela.",
  "lidoEm": null }
```

- `ACTION_REQUIRED` — alguém precisa agir, e há prazo correndo.
- `ALERT` — prazo estourado ou inconsistência que já custou algo.
- `INFO` — apareceu uma oportunidade.

O aviso mais importante do produto é `vehicle.available_again`: um carro voltou
à rede. Ele é a razão de o mural existir — sem ele, o gerente volta a descobrir
as coisas por telefone.

---

### P2 — completa o quadro

**Meu estoque** (`/veiculos/meus`) — onde cada carro está e quem está negociando.
**Sincronização de feed** (`/feeds/sincronizacao`) — relatório com criados,
atualizados, ausentes (com ação tomada) e recusados com motivo legível; é uma
tela de diagnóstico, precisa dizer o que fazer com cada recusa.
**Credenciamento** (`/credenciamentos`) — votação dos fundadores: 3 avais entre
6 aprovam, 4 contrários reprovam. Raro e de alto peso institucional.

---

## 6. Dados reais para popular as telas

Não use lorem ipsum. Estes são os dados semeados pela aplicação:

**Lojas fundadoras:** Prime Motors (Campinas/SP) · Veloz Seminovos (São
Paulo/SP) · Garagem Central (Ribeirão Preto/SP) · Norte Automóveis (Curitiba/PR)
· Sul Car (Belo Horizonte/MG) · Via Livre Veículos (Porto Alegre/RS)

**Veículos:**

| Veículo | Ano | Km | Público | Líquido | Dona |
|---|---|---|---|---|---|
| Chevrolet Onix 1.0 Turbo LTZ | 2022/2023 | 38.400 | R$ 92.900 | R$ 85.000 | Prime |
| Fiat Argo 1.3 Drive | 2021/2022 | 54.210 | R$ 68.900 | R$ 62.500 | Veloz |
| Toyota Corolla 2.0 XEi | 2021/2022 | 61.800 | R$ 139.900 | R$ 128.000 | Garagem Central |
| Jeep Renegade 1.3 T270 Longitude | 2022/2023 | 29.450 | R$ 128.900 | R$ 118.500 | Prime |
| VW T-Cross 1.0 TSI Comfortline | 2022/2022 | 44.900 | R$ 118.500 | R$ 108.900 | Norte |

Nomes de pessoas: Titular Prime Motors, Vendedor Veloz Seminovos, Roberto
Conferente (gerente de pátio), Ana Paula Ribeiro (compradora).

---

## 7. Vocabulário na tela

Estes termos são o idioma da rede. Não inventar sinônimos — o glossário completo
está em [`glossario.md`](glossario.md).

| Na tela | Nunca escrever |
|---|---|
| **Preço líquido de repasse** | "preço de custo", "preço B2B" |
| **Trava comercial** | "reserva", "bloqueio", "hold" |
| **Estoque avançado** | "consignado", "emprestado" |
| **Termo de custódia** / **vistoria** | "checklist", "inspeção" |
| **Chamada de retorno** (recall) | "devolução", "cancelamento" |
| **Transbordo** | "repasse da troca" |
| **Laudo cautelar** | "vistoria cautelar", "laudo" sozinho |
| **Lâmina** | "ficha", "anúncio" |

Enums que aparecem crus na API e precisam de rótulo em pt-BR na interface:
`AVAILABLE` → Disponível · `LOCKED` → Em negociação · `SOLD` → Vendido ·
`DRAFT` → Sem laudo · `WITHDRAWN` → Fora da rede · `AT_YARD` → No pátio ·
`IN_TRANSIT` → Em trânsito · `DELIVERED_TO_CONSUMER` → Entregue.

---

## 8. Restrições

- **pt-BR.** Dinheiro em `R$ 89.900,00`; a API já entrega `formatado` pronto —
  não reformatar no cliente.
- **Mobile-first obrigatório:** catálogo, ficha, trava, vistoria, lâmina.
  **Desktop-first:** negociação, liquidação, feed, credenciamento, meu estoque.
- **Tema claro e escuro** — a lâmina pública já faz; a proposta deve cobrir os
  dois em tudo.
- **Rede ruim.** Vendedor em subsolo de showroom. Estados de carregamento e erro
  não são detalhe.
- **Sem frontend legado.** Nenhuma escolha de framework foi feita; a proposta é
  visual, não de implementação.
- **Sem identidade visual definida.** Proponha uma. Sugestão de direção: isto é
  uma ferramenta que move dinheiro entre concorrentes — deve parecer precisa e
  confiável, mais mesa de operações do que marketplace de consumo. Evite o visual
  de classificados; o usuário é lojista, não comprador.

---

## 9. Anti-objetivos

Coisas que parecem boas ideias e quebram o produto:

| Não desenhar | Por quê |
|---|---|
| Chat ou negociação de margem entre lojas | o produto existe para eliminar essa conversa |
| Leilão, lance, contraproposta | o preço líquido é fixado pela dona, não disputado |
| Botão "cancelar trava de terceiro" para a dona | a exclusividade da trava é o que a Loja B compra ao assumir o cliente |
| Um único badge de status por veículo | mente sobre os dois eixos (seção 3) |
| Preço líquido em qualquer superfície voltada ao consumidor | destrói o modelo da rede |
| Contador regressivo cru para o SLA | ignora horas úteis (P6) |
| Avaliação/rating entre lojas | governança aqui é o quórum de fundadores, não reputação social |
| Notificação para toda trava aberta | afogaria os avisos que exigem ação |

---

## 10. Checklist de aceitação

A proposta está pronta quando um lojista que nunca viu o sistema consegue
responder, olhando as telas:

- [ ] Este carro está disponível para mim **e** onde ele está fisicamente?
- [ ] Quanto tempo resta na trava, e o que eu faço para esticá-la?
- [ ] Por que meu pedido de retorno está parado, e até quando?
- [ ] Qual número eu posso mostrar ao cliente e qual eu não posso?
- [ ] Quanto eu ganho nesta operação, separado do que a outra loja recebe?
- [ ] Quem respondia por este carro na data desta multa?
- [ ] O que apareceu de novo na rede desde ontem?

---

## Como continuar

O caminho mais curto para ver o sistema funcionando:

```bash
npm install && npm run demo    # 17 atos narrados, a operação inteira
npm start                      # API em :3000, rede semeada, chaves no console
```

Com o servidor no ar, `GET /api/v1` lista todas as 53 rotas, e
`GET /s/<token>/lamina.html` mostra a lâmina atual — o ponto de partida visual
mais concreto que existe hoje.
