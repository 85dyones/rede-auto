# Handoff de frontend — rede-auto

**Para:** Claude Design · **De:** time de backend · **Status:** API implementada e
testada (562 testes), frontend inexistente.

Este documento é o briefing para a proposta visual. Tudo aqui está ancorado no
contrato real da API — os JSON citados são respostas de verdade, capturadas do
servidor rodando, não exemplos inventados. Se um campo não aparece aqui, ele não
existe ainda.

Leituras de apoio: [`../README.md`](../README.md) (o produto),
[`dominio.md`](dominio.md) (máquinas de estado), [`api.md`](api.md) (contrato
completo), [`glossario.md`](glossario.md) (vocabulário).

---

## 1. O produto, em um minuto

Rede **fechada e local** de lojas fundadoras de seminovos que compartilham
estoque entre si. Quando a Loja B tem um cliente para um carro que está na Loja
A, hoje isso se resolve no WhatsApp: negocia margem, confirma disponibilidade,
combina o frete. É moroso, e a lentidão mata a venda. A plataforma substitui
essa conversa.

**O que mudou desde a primeira versão deste handoff.** O produto cresceu em
quatro camadas que a proposta visual precisa cobrir, e todas têm superfície
própria na §5: **empresa acima da loja** (uma empresa pode ter vários pátios),
**financeiro** (adesão e mensalidade, zero taxa por transação), **conduta**
(quebras de protocolo medidas pelo sistema) e **ciclo de vida do membro**
(credenciamento, desligamento por moção, saída voluntária).

**Local importa para o design.** O piloto é Curitiba e Região — 10 municípios,
raio declarado de 60 km, todas as fundadoras dentro dele. Isso muda premissas
concretas de tela: distância entre lojas se mede em minutos, "buscar o carro
hoje à tarde" é uma frase realista, e o SLA de 4 horas úteis não é otimismo. Não
projete para uma rede nacional; projete para uma cidade e seu entorno.

Cada praça futura (o produto vira SaaS por cluster) é uma rede **separada**:
estoque, custódia e governança não se cruzam. O usuário pertence a uma praça e
nunca vê outra — então **não há seletor de praça, nem filtro por cidade "de
fora", nem tela de comparação entre clusters**. A praça é contexto, não escolha:
no máximo um rótulo discreto no cabeçalho ("Curitiba e Região · 12 lojas").

**Fechada no sentido literal: não existe interface para o cliente final.** Só
lojista credenciado e logado entra. O consumidor é atendido no canal da própria
loja parceira — site dela, WhatsApp dela, vitrine dela. A plataforma nunca
aparece na venda, e não há nenhuma tela voltada a quem compra o carro.

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
manda a ficha pelo WhatsApp dele antes do cliente esfriar, e faz a vistoria do carro
em pé no pátio, sol na tela, às vezes com uma mão só.

Um usuário pertence a **uma** loja. A mesma pessoa nunca vê a rede de dois
ângulos ao mesmo tempo — mas vê o mesmo carro de ângulos diferentes conforme o
papel da loja dela naquele carro (dona, custodiante, interessada).

**Empresa e loja são coisas diferentes, e a interface precisa refletir isso.**
Uma empresa (o contrato) pode ter vários pátios. O que é da empresa: pagar, ser
fundadora, endossar, ser suspensa por inadimplência, sair da rede. O que é da
loja: custódia, estoque, trava, vistoria — o carro está em *um* pátio.

Consequência direta de layout: **o titular alterna entre dois contextos**, e as
telas dele não são as mesmas do vendedor. Financeiro, governança, conduta e saída
são da empresa; catálogo, travas, recalls e vistorias são do pátio em que a
pessoa está. Não misture as duas listas numa navegação só.

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
| **Loja C** (terceiro) | "disponível, mas está em São José dos Pinhais — preciso buscar" |

Se o design resolver isso, resolveu o produto. Se tratar como um status só, vai
produzir uma tela que parece correta e é inutilizável.

A API já entrega os dois eixos separados e uma leitura pronta do ângulo de quem
olha — ver `vocePode` e `prioridade` na seção 5.

---

## 4. Os dez problemas difíceis

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

### P5 · Dentro da rede é tudo aberto; o que **sai** é que precisa ser neutro

Esta é a inversão que mais confunde quem vem de marketplace. Entre parceiras
logadas **não há segredo**: elas se conhecem, e precisam ver de quem é o carro,
qual o líquido e o que diz o laudo para decidir se assumem o cliente. Esconder
isso dentro da plataforma só atrapalharia.

O anonimato mora no **material que a parceira baixa e republica no canal dela**.
Ali, qualquer marca da loja dona apareceria no anúncio de outra loja.

Fica de fora do material, e o design precisa deixar isso legível para quem
publica as fotos:

| Fora do material | Motivo |
|---|---|
| Nome, CNPJ e contato da loja dona | apareceriam no anúncio da parceira |
| Preço líquido de repasse | é o acordo entre as duas lojas |
| Placa completa e chassi | consulta pública devolve o proprietário |
| **CRLV** | está no nome da loja dona |
| **As fotos do feed** | tiradas para o anúncio da própria dona: adesivo, fachada, placa |

A última é a mais fácil de esquecer, e não é nem a foto — é a **URL** dela:
`cdn.primemotors.com.br/onix-1.jpg` entrega a origem sem que ninguém perceba.

Existe ainda um número tóxico dentro da plataforma. Quando a dona reprecifica
durante uma trava, o novo líquido fica represado e **só vale depois**:

```jsonc
"precos": {
  "liquidoRepasse":   { "formatado": "R$ 85.000,00" },   // vale agora
  "liquidoRepresado": { "formatado": "R$ 89.000,00" }    // vale quando a trava cair
}
```

Quem está negociando fecha por 85.000. Mostrar 89.000 com igual peso seria
mentir para quem está com o cliente na frente.

### P6 · A dona não pode ver a margem da parceira

A API entrega o bloco `financeiro` **filtrado por quem está olhando**. Os
números da vendedora vêm num `meusNumeros` que a loja proprietária não recebe:

```jsonc
// as duas lojas veem
"liquidoDaLojaProprietaria":   { "formatado": "R$ 89.000,00" },
"dinheiroDevidoAProprietaria": { "formatado": "R$ 48.000,00" },
"saldoAberto":                 { "formatado": "R$ 48.000,00" },

// só a vendedora
"meusNumeros": {
  "precoAoConsumidor": { "formatado": "R$ 96.900,00" },
  "minhaMargem":       { "formatado": "R$  7.900,00" },
  "resultadoTotal":    { "formatado": "R$  6.900,00" }
}
```

Numa rede em que concorrentes dividem estoque, a dona ver a margem da parceira
destrói o modelo: bastaria olhar uma venda para saber quanto subir o líquido na
próxima. Para terceiros a negociação sequer existe — `404`.

**Para o design isso significa duas telas de negociação, não uma com campos
escondidos.** A da vendedora é operacional e mostra o resultado dela. A da dona
é de acompanhamento financeiro: o que vou receber, quanto já entrou, o que
falta. Tratar como a mesma tela com condicionais convida ao vazamento.

### P7 · Prazo em horas ÚTEIS

O SLA de recall é "4 horas **úteis**" no horário de Brasília, seg–sex 08–18h,
sábado 09–13h, feriados nacionais **e os da praça** (19/12, Emancipação do
Paraná; 8/9, padroeira de Curitiba). Um pedido às 17h de sexta vence
**segunda às 11h**.

Nunca mostre só "faltam 4h". Mostre o **prazo absoluto legível** ("segunda,
11:00") e, ao lado, o tempo útil restante. Um contador regressivo cru atravessa
a madrugada e o fim de semana mentindo.

**E o contador nem sempre está contando.** O prazo pressupõe que o custodiante
consiga transportar o carro, e nem sempre consegue — não há motorista, o guincho
não vem. Existe um escape, e ele muda **o que o prazo mede**:

| `quemLeva` | O prazo mede | Horas úteis |
|---|---|---|
| `CUSTODIAN_DELIVERS` (padrão) | entregar no pátio de quem chamou | 4 |
| `REQUESTER_COLLECTS` | deixar o carro **disponível** | 1 |

E a situação `READY_FOR_PICKUP` **para o relógio**: o custodiante declarou o carro
pronto e a obrigação dele acabou ali.

Para o design, três estados visuais distintos, não um contador com variações:

- **correndo** (`DUE`) — contador vivo + prazo absoluto. Urgência.
- **parado** (`READY_FOR_PICKUP`) — sem contador. Para o custodiante é alívio
  ("você já cumpriu"); para quem chamou é uma ação ("o carro está esperando por
  você"). Mesma situação, dois tons — a tela sabe qual loja está olhando.
- **sem prazo** (`WAITING_LOCK_RELEASE`) — `prazoFinal: null`. Nunca renderize
  "00:00" aqui; o relógio ainda não começou.

O campo `minutosUteisPausados` é o que sobrava quando o relógio parou. Não o
exiba cru — ele existe porque, se a retirada frustrar, o prazo **retoma** desses
minutos em vez de reiniciar. Se for mostrar algo, mostre a consequência: "restam
2h30 úteis se o prazo voltar a correr".

### P8 · A vistoria é feita em pé, no pátio

O termo de custódia exige **cinco fotos obrigatórias** (frente, traseira,
esquerda, direita, odômetro), odômetro, nível de combustível **em oitavos** —
como o ponteiro do painel, não porcentagem e não litros — avarias e assinatura
com CPF.

> Cuidado para não confundir com as fotos do **material** (P5): lá a lista
> obrigatória é frente, traseira e interior. São propósitos diferentes — a
> vistoria prova avaria, o material vende o carro — e misturá-las produziria um
> fluxo que não serve bem a nenhum dos dois.

É o fluxo mais fisicamente constrangido do produto: uma mão, sol na tela, luvas.
E é o momento em que a **responsabilidade civil muda de loja** — a entrada
assinada transfere multa, avaria e sinistro. A tela precisa dizer isso, porque é
o que a pessoa está realmente assinando.

Divergências entre saída e entrada (rodou demais, combustível a menos, avaria
nova) viram registro objetivo. Quando aparecem, são a base de uma conversa sobre
dinheiro entre parceiros — merecem destaque, não uma linha de log.

### P9 · A entrega tem coordenada, e a coordenada é conferida

O protocolo de devolução tem quatro passos, e cada um é uma tela diferente para
uma pessoa diferente:

1. quem está com o carro **marca a retirada** pela parceira;
2. quem recebe **informa a chegada ao pátio** — é isso que começa a janela de 4h;
3. ao devolver, quem levou **declara a entrega com geolocalização**;
4. quem recebe **dá o aceite**, e é o aceite que move a custódia.

O passo 3 acontece **em pé, no pátio, com o celular na mão**, e a coordenada é
conferida contra o pátio de destino num raio de 500 m. Fora dele, a declaração é
recusada com a distância no erro: `"A coordenada informada está a 16807 m do
pátio de destino."`

Isso muda o desenho da tela: o erro não é um beco, é uma **instrução**. Mostre a
distância, mostre onde é o pátio de destino, e deixe claro que basta declarar de
lá. Nunca trate como falha do usuário — quem está a 16 km provavelmente clicou
antes de sair, e o app precisa dizer isso sem acusar.

O passo 4 tem prazo: 4 horas úteis. Passado isso vira quebra de protocolo
registrada contra quem recebeu (P10). A tela de quem recebe precisa desse
contador tanto quanto a de quem entrega.

### P10 · Dois eixos de suspensão, e eles não se confundem

Uma loja pode estar parada por dois motivos completamente diferentes, e a
interface que os misturar vai mentir:

| | Quem é atingido | Por quê | Sai de |
|---|---|---|---|
| **Inadimplência** | a **empresa**, e com ela todos os pátios | 30 dias de atraso | pagar |
| **Conduta** | o **pátio**, só ele | 3 quebras de protocolo em 12 meses | a janela móvel andar |

A empresa inadimplente para inteira — matriz e filiais. O pátio que quebrou
protocolo para sozinho, e a matriz segue operando.

E há uma diferença que a tela precisa comunicar: **a suspensão por conduta
termina sozinha**. A janela é móvel de 12 meses, e quando a quebra mais antiga
sai dela o pátio reabre sem ninguém fazer nada. Por isso o registro de conduta
traz `janelaAliviaEm` — sem essa data, o lojista vê "3 de 3" e conclui que está
banido para sempre.

Em nenhum dos dois casos a custódia é interrompida: o carro de terceiro no pátio
suspenso continua podendo voltar para a dona. Se a tela sugerir que a loja
suspensa "não pode fazer nada", ela vai impedir exatamente a ação que precisa
acontecer.

---

## 5. Superfícies a desenhar

### Essencial — sem isto não há produto

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

*Quem:* gerente ou conferente. Ver P8.

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

#### 5.6 Material de divulgação

*Quem:* a parceira que vai anunciar. **Nunca o consumidor — ele não acessa a
plataforma.**

`GET /api/v1/veiculos/:id/material` · `/ficha.pdf` · `/fotos/:i` · `/laudo.pdf`.
Todas autenticadas.

O que a parceira baixa para usar no canal dela:

```jsonc
{
  "referencia": "EH_DEMO1",
  "prontidao": { "fotos": 4, "angulosFaltando": [], "temLaudoAnexado": true, "pronto": true },
  "ficha": {
    "titulo": "Chevrolet Onix 1.0 Turbo LTZ 2023",
    "ano": "2022/2023", "quilometragem": "38.400 km", "cor": "Prata",
    "combustivel": "Flex", "cambio": "Automatico", "portas": 4,
    "opcionais": ["Ar-condicionado", "Direcao eletrica", "Multimidia"]
  },
  "fotos": [{ "url": "/api/v1/veiculos/veh_demo_1/material/fotos/0", "angulo": "Frente" }],
  "laudoCautelar": { "aprovado": true, "empresa": "Cautelar Brasil",
                     "arquivoUrl": "/api/v1/veiculos/veh_demo_1/material/laudo.pdf" },
  "minhaMarca": null
}
```

**O kit nasce neutro** — sem loja e sem preço. A parceira pode pedir a versão
com a marca **dela** e o preço **dela** (`?comMinhaLoja=true&preco=96900`);
nunca os da dona. Ver P5 para o que fica de fora e por quê.

Duas telas, não uma:

**Baixar material** (qualquer parceira) — o que existe, o que dá para usar hoje,
e o botão que gera a ficha. `prontidao.angulosFaltando` é o que decide se ela
consegue anunciar ou não: um carro sem material é um carro que ela não vende,
por melhor que seja o preço.

**Publicar material** (só a loja dona) — subir o conjunto neutro exigindo
frente, traseira e interior. É uma tela de curadoria: a pessoa precisa entender
que está decidindo o que **outra loja** vai publicar como se fosse dela. Um
adesivo no vidro ou a fachada refletida no para-brisa estragam o material, e
nenhum software vai avisar — esse julgamento é dela.

A ficha em PDF é o que circula por WhatsApp, imprime na vitrine e vai junto na
proposta ao banco. O gerador não embute imagens: proponha um layout que funcione
com tipografia e estrutura, listando o material fotográfico que acompanha.

---

### Importante — o produto funciona, mas manco, sem isto

#### 5.7 Recalls (os dois lados)

`GET /api/v1/recalls` devolve `devoDevolver` e `estouEsperando`. São dois estados
emocionais opostos na mesma tela — a obrigação e a espera. Ver P4 e P7.

Situações: `WAITING_LOCK_RELEASE` (sem prazo ainda) · `DUE` (correndo) ·
`READY_FOR_PICKUP` (relógio parado, carro esperando) · `FULFILLED` · `CANCELLED`
(com `motivoCancelamento` — `SUPERSEDED_BY_SALE` significa "o carro foi vendido,
virou dinheiro em vez de voltar"). O campo `descumpridoEm` marca SLA estourado.

As três ações do escape (ver P7) são botões de contexto, e **cada uma pertence a
um lado só**:

| Ação | Rota | Quem vê o botão | Quando |
|---|---|---|---|
| "Eu retiro" | `POST /recalls/:id/retirada` | quem chamou (`estouEsperando`) | recall aberto |
| "Carro disponível" | `POST /recalls/:id/disponivel` | custodiante (`devoDevolver`) | situação `DUE` |
| "Fui buscar e não estava" | `POST /recalls/:id/reabrir-prazo` | quem chamou | situação `READY_FOR_PICKUP` |

"Eu retiro" também pode ser marcado já no pedido do recall (`euRetiro: true` em
`POST /veiculos/:id/recall`) — é o caso do lojista que está com o cliente na
mesa e não vai esperar transporte alheio.

A terceira é uma reclamação, e o tom importa: quem a aperta foi até a outra loja
e voltou de mãos vazias. Exija o `motivo` (é obrigatório na API) e deixe claro na
confirmação que o prazo **retoma** — a outra loja recebe alerta.

#### 5.8 Negociação — e são **duas** telas

Ver P6. A vendedora e a dona recebem blocos diferentes da mesma negociação, e
tratar como uma tela com campos escondidos convida ao vazamento.

**Tela da vendedora** — operacional. Ela monta a negociação, registra o preço
que pratica (opcional) e acompanha o próprio resultado:

```jsonc
"meusNumeros": {
  "precoAoConsumidor":    { "formatado": "R$ 96.900,00" },
  "valorDadoNaTroca":     { "formatado": "R$ 42.000,00" },
  "dinheiroDoConsumidor": { "formatado": "R$ 54.900,00" },
  "minhaMargem":          { "formatado": "R$  7.900,00" },
  "resultadoNaTroca":     { "formatado": "-R$ 1.000,00" },
  "resultadoTotal":       { "formatado": "R$  6.900,00" }
}
```

**Tela da dona** — acompanhamento financeiro. O que vou receber, quanto já
entrou, o que falta:

```jsonc
"liquidoDaLojaProprietaria":      { "formatado": "R$ 89.000,00" },
"creditoDaTrocaParaProprietaria": { "formatado": "R$ 41.000,00" },
"dinheiroDevidoAProprietaria":    { "formatado": "R$ 48.000,00" },
"jaLiquidado":                    { "formatado": "R$ 0,00" },
"saldoAberto":                    { "formatado": "R$ 48.000,00" },
"aceiteDaTrocaPendente": false
```

Hierarquia de leitura na tela da vendedora: **o cliente paga** → **a Loja A
recebe** → **eu fico com**. Na da dona: **o que combinei** → **o que já entrou**
→ **o que falta**.

> ⚠ **Estado provisório.** Quando `aceiteDaTrocaPendente` é `true`, o transbordo
> ainda espera o aceite da dona: `creditoDaTrocaParaProprietaria` vale zero
> **porque nada foi aceito**, não porque a operação vá dar isso. Exibir como
> final faria um gerente rejeitar um bom negócio. O campo existe justamente para
> a interface não precisar correlacionar com `situacao`.

O **transbordo** (`destino: "OWNER_STORE"`) é um pedido de aceite que trava a
negociação. Do lado da dona é uma decisão com prazo implícito: alguém está
esperando para fechar uma venda. Note que ela decide **sem ver** quanto a
parceira deu ao cliente pelo usado — esse número é da parceira; a dona avalia o
carro pelo próprio critério.

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

### Governança e contrato — o mundo do titular

As cinco telas seguintes formam um bloco à parte, e o layout deve tratá-las
assim: são da **empresa**, não do pátio, e quem entra nelas é o titular. Um
vendedor não deveria esbarrar nelas navegando.

#### 5.11 Financeiro da empresa

*Quem:* titular. *Decisão:* "o que eu pago, por quê, e estou em dia?"

`GET /api/v1/financeiro`. Duas receitas, e **nenhuma por transação** — isso é
argumento de venda, não detalhe: quem usa mais não paga mais por usar.

| | Fundadora | Depois |
|---|---|---|
| Adesão (uma vez) | R$ 3.000 | R$ 6.000 |
| Mensalidade da empresa, 1ª loja inclusa | R$ 599 | R$ 599 |
| Cada loja adicional | R$ 159 | R$ 159 |

A API entrega `memoriaDeCalculo` pronta (`empresa`, `patiosAdicionais`,
`porPatioAdicional`). **Mostre a conta, não só o total**: "R$ 599 + R$ 159 × 1" é
o que faz o lojista conferir de cabeça e não ligar para o suporte.

`tabela.congelada` é `true` só quando a tabela da empresa difere da vigente —
quando as duas coincidem, anunciar congelamento prometeria um desconto que ainda
não existe. Quando for `true`, é destaque: a fundadora está pagando menos que a
tabela de hoje, e ela precisa ver isso.

Estados de cobrança: `OPEN`, `PAID`, `VOID`. `diasEmAtraso` é o número que leva à
suspensão aos 30 — mostre a distância até lá, não só o número cru.

#### 5.12 Empresa e pátios

*Quem:* titular. *Decisão:* "quem somos na rede, e quero abrir mais um pátio."

`GET /api/v1/empresas` (cada uma com `lojas`, a contagem que é base da fatura) e
`POST /api/v1/lojas` para abrir um pátio novo.

O formulário de pátio novo tem uma armadilha que o design precisa desarmar: o
CNPJ tem de ter a **mesma raiz** (8 primeiros dígitos) da empresa. Uma raiz
diferente devolve `BRANCH_CNPJ_MISMATCH` — e a mensagem certa não é "CNPJ
inválido", é "esse CNPJ é de outra empresa; empresa nova entra por candidatura".

O formulário também pede a **coordenada do pátio**, obrigatória. Não é campo de
cadastro burocrático: é o que torna a entrega verificável (P9). Um mapa com pin
arrastável resolve; um par de campos lat/lng não.

#### 5.13 Conduta

*Quem:* titular e gerente. *Decisão:* "estamos perto de ser suspensos?"

`GET /api/v1/conduta` — só dos pátios da própria empresa. O registro alheio
aparece apenas no fundamento de uma moção de desligamento.

Cada pátio traz `quebrasNaJanela` de `limite`, a lista com `descricao` legível de
cada quebra, e `janelaAliviaEm`. Esta tela **não é um painel de vergonha**: ela
existe para o lojista corrigir antes de chegar a três. Um contador "1 de 3" com a
data em que vira "0 de 3" comunica isso; uma lista vermelha de infrações não.

#### 5.14 Desligamento (moção)

*Quem:* titular de fundadora. *Decisão:* "esta empresa deveria sair da rede?"

`POST /api/v1/desligamentos` · `POST /api/v1/desligamentos/:id/apoios`.

Três coisas que a tela precisa comunicar, e todas são contraintuitivas:

1. **Não existe botão de recusar**, como no credenciamento. O silêncio já é
   contra. Quem não concorda simplesmente não apoia;
2. o **fundamento** é o registro, não a opinião de quem abriu. Mostre
   `fundamento` com destaque — suspensões por conduta, quebras, espécies — porque
   é ele que separa governança de briga de concorrentes. Sem reincidência
   registrada, a moção nem abre (`NO_RECIDIVISM_ON_RECORD`);
3. o quórum é **proporcional** (dois terços), diferente dos três endossos fixos
   da admissão. `apuracao` traz `necessarios`, `faltam` e `alcancavel`.

A moção caduca em 21 dias, e **o desfecho por inércia é "fica"**. Isso merece
estar na tela: a barra de progresso que expira é uma informação diferente de uma
que trava.

#### 5.15 Saída voluntária

*Quem:* titular. *Decisão:* "quero sair — o que preciso encerrar antes?"

`GET /api/v1/saida` funciona **antes** de avisar, e essa é a tela mais
importante deste grupo: quem pensa em sair precisa ver o custo antes de decidir.

É um **checklist**, e a API já entrega no formato:

```jsonc
"pendencias": [
  { "codigo": "AVISO_EM_CURSO", "descricao": "o aviso previo ainda esta correndo" },
  { "codigo": "CUSTODIA_DE_TERCEIROS", "descricao": "ha carro de outra loja no seu patio" }
],
"contagens": {
  "carrosDeTerceirosNoSeuPatio": 1,
  "carrosSeusEmPatioAlheio": 0,
  "travasAbertas": 0,
  "negociacoesAbertas": 0,
  "cobrancasEmAberto": { "centavos": 0, "formatado": "R$ 0,00" }
}
```

Cada item vem com `descricao` pronta — **não traduza código na tela**. E cada
contagem deve levar à lista correspondente: "1 carro de outra loja no seu pátio"
é inútil sem o link para *qual* carro.

Duas coisas que o design precisa acertar:

- **não há botão de "sair agora"**. A saída se conclui sozinha no momento em que
  a última pendência fecha. A tela mostra progresso, não um gatilho — e o estado
  final chega como aviso;
- o prazo de 30 dias é o **menos** importante dos dois requisitos. Uma barra de
  progresso temporal em destaque, com o checklist embaixo, comunicaria o
  contrário do que a regra diz. O checklist vem primeiro.

`DELETE /api/v1/saida` desiste, e a volta é limpa. O botão de desistir deve estar
visível durante todo o processo — ninguém deveria sentir que atravessou uma porta
de mão única.

---

### Complementar — completa o quadro

**Meu estoque** (`/veiculos/meus`) — onde cada carro está e quem está negociando.
**Sincronização de feed** (`/feeds/sincronizacao`) — relatório com criados,
atualizados, ausentes (com ação tomada) e recusados com motivo legível; é uma
tela de diagnóstico, precisa dizer o que fazer com cada recusa.
**Credenciamento** (`/credenciamentos`) — três endossos de fundadoras
credenciam, e o terceiro já admite: a plataforma não decide nada aqui. Não há
voto contrário — quem tem restrição simplesmente não endossa, então **não
desenhe botão de recusar**. A tela mostra os endossos dados, quantos faltam, e
duas coisas que a API entrega prontas:

- `apuracao.fundadorasQuePodemEndossar` — quem ainda **pode** endossar (exclui as
  suspensas, as que já endossaram e a padrinho). É contagem real, não um total
  fixo da rede;
- `apuracao.alcancavel` — quando `false`, não há fundadoras suficientes para
  fechar os três endossos e a candidatura não tem como ser aprovada. A tela
  precisa dizer isso **na abertura**, não deixar a candidata descobrir pela
  caducidade em 30 dias.

A candidatura caduca em 30 dias, e o prazo é informação de tela: é o único
desfecho negativo que existe.

**Janela de fundação.** `GET /api/v1/cluster` traz `janelaDeFundacao` com
`aberta` e `diasRestantes`. Enquanto aberta, quem for credenciado entra como
**fundadora** (meia adesão); depois, como membro. Isso é argumento comercial com
prazo visível — merece destaque na tela de credenciamento e no convite, não uma
linha de rodapé.

---

## 6. Dados reais para popular as telas

Não use lorem ipsum. Estes são os dados semeados pela aplicação:

**Praça:** Curitiba e Região (PR) · 10 municípios · raio operacional 60 km

**Empresas fundadoras (10):** Prime Motors (Curitiba/PR) · Veloz Seminovos (São
José dos Pinhais/PR) · Garagem Central (Curitiba/PR) · Norte Automóveis
(Colombo/PR) · Sul Car (Araucária/PR) · Via Livre Veículos (Pinhais/PR) ·
Planalto Veículos (Campo Largo/PR) · Atlas Automóveis (Curitiba/PR) · Iguaçu
Motors (Piraquara/PR) · Bandeirante Seminovos (Fazenda Rio Grande/PR)

**Onze pátios, não dez:** a Prime Motors tem dois — matriz no centro e **Prime
Motors Boqueirão**, a ~6 km. É o caso que a mensalidade cobra (R$ 599 + R$ 159) e
o que obriga a interface a distinguir empresa de pátio. Use essa empresa nas
telas de financeiro e de saída; ela é a única que exercita os dois.

São dez porque dez é o alvo do piloto, **não** porque dez seja exigido: a praça
abre com quem entrou na janela de fundação. Nenhuma tela deve exibir "x de 10" —
o denominador vem contado da API.

Todas dentro do raio — e é por isso que "a Loja B vai buscar o carro hoje à
tarde" é uma frase que cabe na tela.

**Veículos:**

| Veículo | Ano | Km | Público | Líquido | Dona |
|---|---|---|---|---|---|
| Chevrolet Onix 1.0 Turbo LTZ | 2022/2023 | 38.400 | R$ 92.900 | R$ 85.000 | Prime |
| Fiat Argo 1.3 Drive | 2021/2022 | 54.210 | R$ 68.900 | R$ 62.500 | Veloz |
| Toyota Corolla 2.0 XEi | 2021/2022 | 61.800 | R$ 139.900 | R$ 128.000 | Garagem Central |
| Jeep Renegade 1.3 T270 Longitude | 2022/2023 | 29.450 | R$ 128.900 | R$ 118.500 | Prime |
| VW T-Cross 1.0 TSI Comfortline | 2022/2022 | 44.900 | R$ 118.500 | R$ 108.900 | Norte |

Nomes de pessoas: Titular Prime Motors, Vendedor Veloz Seminovos, Roberto
Conferente (gerente de pátio), Ana Paula Ribeiro (compradora), Gerente Prime
Boqueirão.

**Números reais para as telas novas:**

| Onde | Valor |
|---|---|
| Mensalidade Prime (2 pátios) | R$ 758,00 — R$ 599 + R$ 159 × 1 |
| Mensalidade das demais (1 pátio) | R$ 599,00 |
| Adesão de fundadora, já quitada | R$ 3.000,00 |
| Tabela vigente | `2026-03` |
| Congelamento de fundadora | 24 meses |
| Janela de fundação do piloto | 90 dias |
| Quebras para suspender o pátio | 3 em 12 meses |
| Quórum de desligamento (10 fundadoras) | 6 apoios de 9 elegíveis |
| Aviso prévio de saída | 30 dias |

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
| **Chamada de retorno** (recall) | "cancelamento"; e nunca "devolução" **como nome da funcionalidade** |
| **Transbordo** | "repasse da troca" |
| **Laudo cautelar** | "vistoria cautelar", "laudo" sozinho |
| **Ficha** (o PDF que circula) | "anúncio" |
| **Empresa** (o contrato) | "grupo", "matriz" como sinônimo de empresa |
| **Pátio** / **loja** (o endereço) | "filial" quando o texto fala do primeiro |
| **Endosso** | "voto", "aprovação" |
| **Moção de desligamento** | "expulsão", "banimento", "exclusão" |
| **Quebra de protocolo** | "infração", "penalidade", "falta" |
| **Aviso de saída** | "cancelamento de conta", "churn" |
| **Adesão** | "taxa de entrada", "caução" (não é caução: não volta) |

Duas ressalvas que valem mais que a tabela, porque é onde ela costuma ser mal
aplicada:

**"Devolução" é legítima para o ato, proibida para a coisa.** O recall se chama
*chamada de retorno* — é ele que tem id, situação e prazo. Mas devolver o carro é
literalmente o que acontece, e o verbo é do próprio domínio: o campo da API é
`devoDevolver`. Então "Prazo de devolução estourado" (o texto real da
notificação) está certo; "abrir uma devolução" no lugar de "chamada de retorno",
não.

**"Lâmina" saiu do vocabulário.** A palavra é jargão de pátio e nem todo vendedor
novo conhece; o produto inteiro já diz *ficha* — rota (`/material/ficha.pdf`),
módulo, campo do kit e testes. Duas fichas convivem sem ambiguidade porque vivem
em telas diferentes: a **ficha do veículo** é a tela de detalhe (§5.2), e a
**ficha de divulgação** é o PDF que a parceira baixa e manda no WhatsApp (§5.6).

Enums que aparecem crus na API e precisam de rótulo em pt-BR na interface:
`AVAILABLE` → Disponível · `LOCKED` → Em negociação · `SOLD` → Vendido ·
`DRAFT` → Sem laudo · `WITHDRAWN` → Fora da rede · `AT_YARD` → No pátio ·
`IN_TRANSIT` → Em trânsito · `AWAITING_ACCEPTANCE` → Entregue, aguardando aceite ·
`DELIVERED_TO_CONSUMER` → Entregue.

Situação da **empresa**: `ACTIVE` → Ativa · `SUSPENDED` → Suspensa por
inadimplência · `LEAVING` → Em saída · `EXITED` → Fora da rede.
Situação do **pátio**: `ACTIVE` → Aberto · `SUSPENDED` → Suspenso por conduta ·
`EXITED` → Fechado. Os dois rótulos de `SUSPENDED` são diferentes de propósito
(P10) — nunca escreva só "Suspensa".

Espécies de quebra: `RECALL_SLA` → Não devolveu no prazo · `PICKUP_NOT_COLLECTED`
→ Não retirou o carro disponibilizado · `DROPOFF_NOT_ACKNOWLEDGED` → Não deu
aceite na entrega · `TRANSFER_ABANDONED` → Deixou o carro em trânsito. A API já
entrega `descricao` legível em cada uma — prefira a dela.

---

## 8. Restrições

- **pt-BR.** Dinheiro em `R$ 89.900,00`; a API já entrega `formatado` pronto —
  não reformatar no cliente.
- **Mobile-first obrigatório:** catálogo, ficha, trava, vistoria, publicar
  material, **declaração de entrega** (é feita em pé, no pátio) e **aceite de
  entrega**. **Desktop-first:** negociação, liquidação, feed, credenciamento, meu
  estoque, financeiro, conduta, desligamento, saída.
- **Tema claro e escuro** em tudo.
- **Sem tela de login público, sem cadastro aberto, sem landing de venda.** O
  acesso é por credenciamento aprovado; a única porta é a de quem já é parceiro.
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
| **Qualquer tela voltada ao consumidor** | ele não acessa a plataforma; quem o atende é a parceira, no canal dela |
| Landing page, busca pública, cadastro aberto | a rede é fechada: só entra quem foi credenciado |
| Chat ou negociação de margem entre lojas | o produto existe para eliminar essa conversa |
| Leilão, lance, contraproposta | o preço líquido é fixado pela dona, não disputado |
| Botão "cancelar trava de terceiro" para a dona | a exclusividade da trava é o que a Loja B compra ao assumir o cliente |
| Um único badge de status por veículo | mente sobre os dois eixos (seção 3) |
| Preço líquido em qualquer superfície voltada ao consumidor | destrói o modelo da rede |
| Contador regressivo cru para o SLA | ignora horas úteis (P6) |
| Avaliação/rating entre lojas | governança aqui é endosso de fundadoras, não reputação social. O registro de conduta é objetivo (prazos vencidos) e alimenta governança, nunca o catálogo |
| Notificação para toda trava aberta | afogaria os avisos que exigem ação |
| Botão de "recusar" candidatura ou "votar contra" desligamento | o silêncio já é o contra; registrar contra expõe quem defendeu quem e constrói retaliação |
| Botão de "sair agora" | a saída se conclui sozinha quando a última pendência fecha; um gatilho manual deixaria a empresa pronta e presa |
| Painel de conduta como ranking ou vergonha pública | o registro é da própria empresa, serve para corrigir antes de chegar a três, e nunca alimenta o catálogo |
| Taxa por transação em qualquer lugar da interface | ela não existe: cobrar por repasse fechado incentivaria combinar por fora e subdeclarar valor |
| Exibir "x de 10 fundadoras" | o número é contado, não fixo — a praça abre com quem entrou na janela |

---

## 10. Checklist de aceitação

A proposta está pronta quando um lojista que nunca viu o sistema consegue
responder, olhando as telas:

- [ ] Este carro está disponível para mim **e** onde ele está fisicamente?
- [ ] Quanto tempo resta na trava, e o que eu faço para esticá-la?
- [ ] Por que minha mensalidade é esse valor, conferindo a conta de cabeça?
- [ ] Estou perto de ser suspenso por conduta, e quando isso alivia?
- [ ] Minha empresa está parada por dinheiro ou meu pátio por protocolo?
- [ ] Se eu quisesse sair da rede, o que precisaria encerrar antes?
- [ ] Por que meu pedido de retorno está parado, e até quando?
- [ ] Este carro tem material pronto para eu anunciar hoje, ou falta foto?
- [ ] O que eu publico aqui vai aparecer no anúncio de outra loja — está limpo?
- [ ] Quanto eu ganho nesta operação, separado do que a outra loja recebe?
- [ ] Quem respondia por este carro na data desta multa?
- [ ] O que apareceu de novo na rede desde ontem?

---

## Como continuar

O caminho mais curto para ver o sistema funcionando:

```bash
npm install && npm run demo    # 20 atos narrados, a operação inteira
npm start                      # API em :3000, rede semeada, chaves no console
```

Com o servidor no ar, `GET /api/v1` lista todas as rotas — todas
autenticadas, exceto `/health` e o próprio índice.
