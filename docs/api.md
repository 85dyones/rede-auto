# Referência da API

Base: `http://localhost:3000`. Índice das rotas em tempo de execução: `GET /api/v1`.

## Autenticação

```
Authorization: Bearer <chave>
```

Também aceita `X-Api-Key: <chave>`. Uma chave identifica um par **(loja,
usuário)** — o papel do usuário decide o que ele pode fazer.

**Não existe rota pública de negócio.** As únicas sem autenticação são
`GET /health` e o índice `GET /api/v1`. O consumidor final não tem acesso à
plataforma, e não há superfície voltada a ele.

> A autenticação por chave é adaptador de **desenvolvimento**. Ver a ressalva em
> [`decisoes.md`](decisoes.md#24-o-que-ficou-de-fora-e-por-quê).

Com `SEED_DEMO_DATA` ligado (padrão), as chaves saem no console no `npm start`:
`demo_prime_titular`, `demo_veloz_vendedor`, e assim por diante.

## Convenções

**Dinheiro** sai como objeto e entra dos dois jeitos:

```jsonc
// resposta
"precoLiquidoRepasse": { "centavos": 8500000, "formatado": "R$ 85.000,00" }

// requisição — as três formas são aceitas
{ "precoLiquidoRepasse": { "centavos": 8500000 } }
{ "precoLiquidoRepasse": "85.000,00" }
{ "precoLiquidoRepasse": "85000.00" }
```

**Datas** em ISO-8601 UTC. **Prazos** vêm com um campo legível ao lado
(`restante: "3h 12min"`).

**Praça.** Toda resposta é implicitamente escopada ao cluster da loja
autenticada, e **nenhuma rota aceita a praça como parâmetro**. Ela vem da chave
de API, e só de lá: se fosse entrada, bastaria trocar um id para ler o preço
líquido de um concorrente de outra cidade. Um veículo de outra praça responde
`404` — para quem está fora, ele não existe.

**Erros**:

```jsonc
{
  "erro": {
    "codigo": "VEHICLE_ALREADY_LOCKED",
    "mensagem": "Já existe uma trava comercial ativa para este veículo.",
    "detalhes": { "vehicleId": "veh_0001", "lockId": "lck_0007" }
  },
  "requestId": "9f3c…"
}
```

| Status | Quando |
|---|---|
| 400 | payload malformado ou campo inválido |
| 401 | sem chave, ou chave desconhecida |
| 403 | autenticado, mas sem permissão para este recurso |
| 404 | recurso inexistente |
| 409 | a ação contradiz o estado atual (ex.: já travado) |
| 422 | regra de negócio violada (cota de evidência, teto da trava, quórum) |

O `codigo` é contrato estável — trate por ele, não pela mensagem. O `requestId`
aparece em toda resposta e no log do servidor.

---

## Rede e governança

### `GET /api/v1/cluster`

A praça em que a loja autenticada opera.

```jsonc
{
  "cluster": {
    "id": "clu_curitiba_rmc",
    "nome": "Curitiba e Regiao",
    "identificador": "curitiba-rmc",
    "uf": "PR",
    "municipios": ["Curitiba", "Sao Jose dos Pinhais", "Colombo", "…"],
    "raioOperacionalKm": 60,
    "situacao": "ACTIVE",
    "constituidoEm": "2026-03-09T12:00:00.000Z"
  }
}
```

`raioOperacionalKm` é **declarado**, não calculado a partir dos endereços. Serve
para a tela explicar o alcance da rede e para a governança julgar candidatura
("essa loja fica a 180 km, o recall de 4h vai falhar toda vez"). O cadastro
recusa acima de 300 km.

### `GET /api/v1/lojas` · `GET /api/v1/lojas/fundadoras`

Lojas **da sua praça** — não existe "todas as lojas da instalação". A segunda
traz também `avaisNecessarios`, e lista apenas as fundadoras do seu cluster: o
quórum de 3 é contado dentro de uma praça só.

### `POST /api/v1/credenciamentos`

Apresenta uma candidata. Quem chama vira o padrinho.

```jsonc
{
  "candidata": {
    "legalName": "Nova Garagem Veículos LTDA",
    "tradeName": "Nova Garagem",
    "cnpj": "07.526.557/0001-00",
    "city": "Sorocaba", "state": "SP",
    "phone": "(15) 99876-5432",
    "email": "contato@novagaragem.com.br",
    "responsibleName": "João Pereira"
  }
}
```

CNPJ, UF, telefone e e-mail são validados na candidatura, não na aprovação —
fundador não deve gastar voto analisando ficha incompleta. Se houver mais de um
campo inválido, o erro principal traz os demais em `detalhes.outrosErros`.

### `POST /api/v1/credenciamentos/:id/votos`

```jsonc
{ "decisao": "APPROVE", "justificativa": "Conheço a operação há 6 anos." }
```

Só o **titular** de fundadora ativa vota; o padrinho não vota na própria
indicação. O terceiro aval já credencia — a resposta traz `lojaCredenciada`
preenchida. Quatro votos contrários reprovam.

---

## Catálogo e trava comercial

### `GET /api/v1/veiculos`

Catálogo da rede. Filtros: `marca`, `modelo`, `anoModeloMinimo`, `kmMaximo`,
`liquidoMaximoCentavos`, `limite`, `deslocamento`. Por padrão traz só os
disponíveis; `?somenteDisponiveis=false` inclui os travados.

Cada item traz, além da ficha:

```jsonc
{
  "estoqueAvancado": true,          // está no pátio de uma loja que não é a dona
  "trava": { "lojaDetentoraId": "str_veloz", "restante": "3h 12min" },
  "prioridade": {
    "de": "LOCK_HOLDER",
    "lojaId": "str_veloz",
    "ate": "2026-08-24T19:00:00.000Z",
    "justificativa": "Há trava comercial ativa: a loja que abriu a negociação tem exclusividade até o fim do prazo."
  },
  "vocePode": { "travar": false, "chamarDeVolta": true, "precificar": true }
}
```

`vocePode` responde pela ótica de **quem chamou** — evita que cada cliente
reimplemente as regras de autorização.

### `GET /api/v1/veiculos/meus` · `GET /api/v1/veiculos/no-meu-patio`

O seu estoque, e os carros **de outras lojas** parados no seu pátio.

### `POST /api/v1/veiculos`

```jsonc
{
  "placa": "RGT4B71",
  "chassi": "9BWZZZ377VT004251",
  "ficha": {
    "brand": "Chevrolet", "model": "Onix", "version": "1.0 Turbo LTZ",
    "manufactureYear": 2022, "modelYear": 2023,
    "mileageKm": 38400, "color": "Prata",
    "fuel": "FLEX", "transmission": "AUTOMATIC", "doors": 4,
    "optionals": ["Ar-condicionado"],
    "photos": ["https://cdn.exemplo.com/1.jpg"]
  },
  "precoPublico": { "centavos": 9290000 },
  "precoLiquidoRepasse": { "centavos": 8500000 },
  "laudoCautelar": {
    "situacao": "APPROVED",
    "numero": "LC-2026-4471", "empresa": "Cautelar Brasil",
    "emitidoEm": "2026-08-14T00:00:00Z", "validoAte": "2026-11-12T00:00:00Z"
  }
}
```

Sem laudo aprovado e vigente, o veículo nasce `DRAFT` e não circula na rede.
Chassi já anunciado por outra loja → `409 DUPLICATE_VIN_IN_NETWORK`.

### `PATCH /api/v1/veiculos/:id/precos`

Só a loja proprietária. **Com trava ativa, o novo preço líquido fica
represado** — a resposta mostra isso:

```jsonc
"precos": {
  "liquidoRepasse":  { "formatado": "R$ 85.000,00" },   // continua valendo
  "liquidoRepresado": { "formatado": "R$ 89.000,00" }   // vale quando a trava cair
}
```

### `POST /api/v1/veiculos/:id/trava`

Abre a trava de 4 horas.

```jsonc
{ "referenciaAtendimento": "ATD-4471" }
```

A referência é interna da loja — a plataforma não guarda dado pessoal do cliente
final; quem responde por esse relacionamento (CDC) é a Loja B.

`409 VEHICLE_ALREADY_LOCKED` se já houver trava — **inclusive para a loja
proprietária**.

### `POST /api/v1/travas/:id/extensoes`

```jsonc
{
  "evidencia": "DEPOSIT_RECEIPT",
  "referencia": "PIX-E2E-8812",
  "anexoUrl": "https://docs.exemplo.com/sinal.pdf"
}
```

| `evidencia` | Prazo somado | Usos | Anexo |
|---|---|---|---|
| `TRADE_IN_APPRAISAL` | +2h | 2 | não |
| `BANK_PROPOSAL_SUBMITTED` | +4h | 2 | não |
| `BANK_PROPOSAL_APPROVED` | +24h | 1 | **sim** |
| `DEPOSIT_RECEIPT` | +48h | 1 | **sim** |
| `SIGNED_ORDER` | +72h | 1 | **sim** |

O prazo soma sobre o **vencimento**, não sobre "agora". Erros possíveis:
`422 EVIDENCE_QUOTA_EXCEEDED`, `422 EVIDENCE_ATTACHMENT_REQUIRED`,
`422 LOCK_MAX_DURATION_REACHED`, `409 LOCK_NOT_ACTIVE` (expirou — abra uma nova).

### `DELETE /api/v1/travas/:id`

Libera antes do prazo. Só o detentor; a dona recebe `403 NOT_LOCK_HOLDER`.

---

## Custódia física

### `POST /api/v1/veiculos/:id/custodia/saidas`

```jsonc
{
  "lojaDestinoId": "str_veloz",
  "finalidade": "EXTENDED_STOCK",
  "vistoria": {
    "odometerKm": 38400,
    "fuelEighths": 6,
    "photos": [
      { "angle": "FRONT",    "url": "https://cdn.exemplo.com/f.jpg" },
      { "angle": "REAR",     "url": "https://cdn.exemplo.com/t.jpg" },
      { "angle": "LEFT",     "url": "https://cdn.exemplo.com/e.jpg" },
      { "angle": "RIGHT",    "url": "https://cdn.exemplo.com/d.jpg" },
      { "angle": "ODOMETER", "url": "https://cdn.exemplo.com/o.jpg" }
    ],
    "damages": [
      { "area": "Para-choque dianteiro", "severity": "LIGHT", "description": "Risco superficial" }
    ]
  },
  "responsavel": { "nome": "Roberto Silva", "cpf": "529.982.247-25", "funcao": "Gerente de pátio" }
}
```

Os cinco ângulos são obrigatórios (`422 REQUIRED_PHOTOS_MISSING` diz quais
faltam).

| `finalidade` | Quando |
|---|---|
| `TEST_DRIVE` | apresentação ao cliente na loja de destino |
| `EXTENDED_STOCK` | exposição continuada no showroom da outra loja |
| `RECALL_RETURN` | retorno à loja proprietária atendendo a um recall |
| `SALE_HANDOVER` | movimentação **depois da venda**, para a loja vendedora entregar ao comprador |
| `OTHER` | demais casos |

Se houver recall aberto e o destino for a loja proprietária, o termo já nasce
como `RECALL_RETURN` vinculado a ele. Para um veículo já `SOLD`, a única
finalidade aceita é `SALE_HANDOVER` — o carro pode estar no pátio da dona, e
quem entrega é quem atendeu o cliente.

Quem assina a saída é a loja que **está** com o carro. O veículo vai para
`IN_TRANSIT`, mas a responsabilidade civil **continua na origem**.

### `POST /api/v1/custodia/termos/:id/entrada`

Mesmo formato. Assinada pela loja de **destino** — é neste instante que multa,
avaria e sinistro mudam de mão.

A resposta traz `divergencias` (rodagem acima de 80 km, queda de combustível,
avaria nova) e `recallCumprido` quando a entrada encerra um recall.

### `POST /api/v1/veiculos/:id/entrega`

Entrega ao comprador final. Corpo igual ao do termo de vistoria, com a vistoria
de saída definitiva.

Exige venda confirmada e que **quem chama esteja com o carro**. Encerra o eixo
físico (`DELIVERED_TO_CONSUMER`) e marca a entrega na negociação na mesma
operação — são o mesmo fato, e separá-los abriria um estado sem sentido:
negociação concluída com o carro ainda no pátio.

```jsonc
{ "entregue": true, "veiculoId": "veh_0001", "negociacao": { "situacao": "COMPLETED", … } }
```

A negociação vai a `COMPLETED` quando dinheiro, documento e carro chegaram ao
destino — em qualquer ordem. A entrega **não** exige liquidação: na operação
real a Loja B entrega quando o banco aprova, e o dinheiro cai dias depois.

### `GET /api/v1/veiculos/:id/custodia/responsavel?em=<ISO>`

Quem respondia pelo veículo naquele instante — a pergunta que uma multa faz.

```jsonc
{
  "resolvido": true,
  "lojaResponsavelId": "str_veloz",
  "periodo": { "de": "2026-03-09T15:00:00Z", "ate": null, "origem": "TRANSFER" }
}
```

Fora do intervalo conhecido devolve `resolvido: false` com
`BEFORE_FIRST_CUSTODY` ou `AFTER_DELIVERY` — o livro não adivinha.

---

## Recall

### `POST /api/v1/veiculos/:id/recall`

```jsonc
{ "motivo": "OWN_SALE", "observacao": "Cliente fechou aqui.", "euRetiro": false }
```

Motivos: `OWN_SALE`, `YARD_RETURN`, `MAINTENANCE`, `OTHER`.

| Situação do veículo | `situacao` do recall | `prazoFinal` |
|---|---|---|
| disponível no pátio de terceiro | `DUE` | +4h úteis a partir de agora |
| com trava ativa de terceiro | `WAITING_LOCK_RELEASE` | `null` |

Quando a trava cai, o SLA começa **dali**. Se a negociação travada fechar, o
recall vira `CANCELLED` com `SUPERSEDED_BY_SALE`.

`euRetiro: true` já nasce o recall como `REQUESTER_COLLECTS`: quem chamou vai
buscar, e o prazo passa a medir **deixar o carro disponível** (1h útil) em vez de
entregá-lo (4h úteis).

### `POST /api/v1/recalls/:id/retirada`

Sem corpo. Só **quem pediu o recall**. Troca `quemLeva` para
`REQUESTER_COLLECTS` depois do pedido — para quando a loja custodiante avisa que
não tem como levar.

O prazo nunca cresce: `prazoFinal = min(prazoFinal atual, agora + 1h útil)`.
Trocar de modalidade não compra tempo para quem já está atrasado.

Chamar duas vezes é inócuo — o recall já está em `REQUESTER_COLLECTS` e a
resposta é a mesma, sem novo evento.

| Erro | Quando |
|---|---|
| `NOT_RECALL_REQUESTER` (403) | quem chamou o carro não foi você |
| `RECALL_NOT_OPEN` (409) | recall já cumprido ou cancelado |

Se o recall ainda está em `WAITING_LOCK_RELEASE`, a modalidade fica registrada e
passa a valer quando a trava cair e o relógio começar.

### `POST /api/v1/recalls/:id/disponivel`

```jsonc
{ "observacao": "Sem motorista hoje. Carro na frente, chave na recepção." }
```

Só a **loja custodiante**, e só com o recall em `DUE`. O recall vai para
`READY_FOR_PICKUP`, o relógio **para** e a obrigação da custodiante termina ali:
o varredor deixa de contá-la como candidata a descumprimento.

O que sobrava do prazo fica guardado em `minutosUteisPausados` — não é zerado.

| Erro | Quando |
|---|---|
| `NOT_CUSTODIAN` (403) | o carro não está no seu pátio |
| `RECALL_NOT_DUE` (409) | recall ainda preso pela trava, ou já encerrado |

### `POST /api/v1/recalls/:id/reabrir-prazo`

```jsonc
{ "motivo": "Fui buscar às 14h e o carro não estava disponível." }
```

Só **quem pediu o recall**, e só a partir de `READY_FOR_PICKUP`. Volta para `DUE`
**retomando** `minutosUteisPausados` — não reinicia o relógio. Declarar
disponível cedo demais não rende nada à custodiante.

| Erro | Quando |
|---|---|
| `NOT_RECALL_REQUESTER` (403) | quem chamou o carro não foi você |
| `RECALL_NOT_AWAITING_PICKUP` (409) | o recall não está em `READY_FOR_PICKUP` |

### `GET /api/v1/recalls`

```jsonc
{ "devoDevolver": [ /* … */ ], "estouEsperando": [ /* … */ ] }
```

Cada recall traz `quemLeva` (`CUSTODIAN_DELIVERS` | `REQUESTER_COLLECTS`),
`disponivelParaRetiradaEm` e `minutosUteisPausados`.

---

## Negociação de repasse

### `POST /api/v1/veiculos/:id/negociacao`

Exige trava ativa **da sua loja**. O líquido vem do snapshot da trava.

```jsonc
{
  "precoAoConsumidor": { "centavos": 9690000 },
  "troca": {
    "veiculo": { "placa": "DEF4G56", "marca": "Fiat", "modelo": "Argo", "anoModelo": 2019, "km": 71000 },
    "valorDadoAoCliente": { "centavos": 4200000 },
    "avaliacao": { "centavos": 4400000 },
    "destino": "OWNER_STORE"
  }
}
```

`destino`: `SELLER_STOCK` (padrão — você fica com a troca) ou `OWNER_STORE`
(transbordo — a negociação fica `AWAITING_TRADE_IN_ACCEPTANCE` até a Loja A
aceitar).

`precoAoConsumidor` é **opcional** — a venda ao consumidor acontece fora da
plataforma, no canal da parceira. Aqui dentro o negócio é entre as duas lojas.

A resposta traz o bloco `financeiro`, **filtrado por quem está olhando**:

```jsonc
// o que as DUAS lojas veem — é o acordo entre elas
"financeiro": {
  "liquidoDaLojaProprietaria":      { "formatado": "R$ 89.000,00" },
  "creditoDaTrocaParaProprietaria": { "formatado": "R$ 41.000,00" },
  "dinheiroDevidoAProprietaria":    { "formatado": "R$ 48.000,00" },
  "jaLiquidado":                    { "formatado": "R$ 0,00" },
  "saldoAberto":                    { "formatado": "R$ 48.000,00" },
  "liquidado": false,
  "aceiteDaTrocaPendente": false,

  // presente SÓ para a loja vendedora
  "meusNumeros": {
    "precoAoConsumidor":    { "formatado": "R$ 96.900,00" },
    "valorDadoNaTroca":     { "formatado": "R$ 42.000,00" },
    "dinheiroDoConsumidor": { "formatado": "R$ 54.900,00" },
    "minhaMargem":          { "formatado": "R$  7.900,00" },
    "resultadoNaTroca":     { "formatado": "-R$ 1.000,00" },
    "resultadoTotal":       { "formatado": "R$  6.900,00" },
    "vendaAbaixoDoLiquido": false
  }
}
```

**A loja proprietária não recebe `meusNumeros`.** Numa rede em que concorrentes
dividem estoque, a dona ver a margem da parceira destrói o modelo: bastaria
olhar uma venda para saber quanto subir o líquido na próxima, e o incentivo para
a parceira trazer clientes acabaria junto. Pelo mesmo motivo, o valor dado ao
cliente na troca e a avaliação do usado também só aparecem para a vendedora.

Para **terceiros** a negociação sequer existe: `404`. Nem a existência dela, nem
quem está negociando o quê, são informação pública da rede.

`aceiteDaTrocaPendente: true` avisa que o transbordo ainda espera o aceite da
dona — enquanto isso, `creditoDaTrocaParaProprietaria` vale zero **porque nada
foi aceito**, não porque a operação vá dar isso. A interface precisa mostrar
esses números como provisórios, e o campo existe justamente para ela não
precisar correlacionar com `situacao`.

### `POST /api/v1/negociacoes/:id/troca/aceite`

Só a loja proprietária. `{ "valorAceito": { "centavos": 4100000 } }`.

Acima do líquido → `422 TRADE_IN_EXCEEDS_NET_PRICE`: a Loja A ficaria devendo à
Loja B, e a mensagem sugere registrar duas operações separadas.

`POST .../troca/recusa` não mata a negociação — devolve a troca para o pátio da
vendedora, que paga o líquido integral em dinheiro.

### `POST /api/v1/negociacoes/:id/confirmacao`

Só a loja vendedora. Fecha a venda: a trava vira venda, o veículo sai do estoque
da rede e um recall aberto é cancelado — tudo na mesma operação.

`409 LOCK_NO_LONGER_ACTIVE` se a trava caiu enquanto a negociação era montada.

### `POST /api/v1/negociacoes/:id/liquidacoes`

```jsonc
{ "valor": { "centavos": 1400000 }, "meio": "PIX", "comprovante": "E2E-2026-0311-991" }
```

Meios: `PIX`, `TED`, `BANK_FINANCING`, `CASH`. Parcial é aceito; nenhuma parcela
pode exceder o saldo (`422 SETTLEMENT_EXCEEDS_BALANCE`). Ao fechar o valor, a
negociação vai para `SETTLED`.

### `POST /api/v1/negociacoes/:id/atpv`

Só a **loja proprietária**, em cujo nome o veículo está registrado.

```jsonc
{ "numero": "ATPV-2026-889231", "compradorNome": "Ana Paula Ribeiro", "compradorDocumento": "529.982.247-25" }
```

Exige `SETTLED`. Aceita CPF ou CNPJ, com dígito verificador validado.

---

## Material de divulgação

A plataforma não tem rota pública. O material é **baixado pela loja parceira,
autenticada**, para ela usar no canal dela.

### `GET /api/v1/veiculos/:id/material`

Manifesto do kit: ficha neutra, fotos disponíveis e laudo.

```jsonc
{
  "veiculoId": "veh_demo_1",
  "referencia": "EH_DEMO1",
  "prontidao": {
    "fotos": 4,
    "angulosFaltando": [],          // FRONT, REAR e INTERIOR são obrigatórios
    "temLaudoAnexado": true,
    "pronto": true
  },
  "ficha": {
    "titulo": "Chevrolet Onix 1.0 Turbo LTZ 2023",
    "ano": "2022/2023", "quilometragem": "38.400 km", "cor": "Prata",
    "combustivel": "Flex", "cambio": "Automatico", "portas": 4,
    "opcionais": ["Ar-condicionado", "Direcao eletrica", "Multimidia"]
  },
  "fotos": [
    { "url": "/api/v1/veiculos/veh_demo_1/material/fotos/0", "angulo": "Frente" },
    { "url": "/api/v1/veiculos/veh_demo_1/material/fotos/1", "angulo": "Traseira" }
  ],
  "laudoCautelar": {
    "aprovado": true, "situacao": "Laudo cautelar aprovado",
    "empresa": "Cautelar Brasil",
    "arquivoUrl": "/api/v1/veiculos/veh_demo_1/material/laudo.pdf"
  },
  "minhaMarca": null,
  "geradoEm": "2026-09-14T18:00:00.000Z"
}
```

Ausentes **por construção**: nome e CNPJ da loja dona, preço líquido, chassi,
placa, número do laudo, CRLV, e as URLs das fotos do feed.

`prontidao` é o que diz se a parceira consegue anunciar. `angulosFaltando`
aponta exatamente o que a loja dona ainda não publicou.

**Parâmetros opcionais** — `?comMinhaLoja=true&preco=96900` gera o material já
com a marca de **quem está baixando** e o preço que **ela** pratica:

```jsonc
"minhaMarca": {
  "nomeFantasia": "Veloz Seminovos", "cidade": "Sao Paulo", "uf": "SP",
  "telefone": "(19) 3201-4455",
  "preco": { "centavos": 9690000, "formatado": "R$ 96.900,00" }
}
```

Nunca a marca da dona. Quem define o líquido é a dona; quem define o preço ao
consumidor é quem vai atender o consumidor — e essa venda acontece fora daqui.

### `GET /api/v1/veiculos/:id/material/ficha.pdf`

A ficha técnica em PDF. Neutra por padrão; aceita os mesmos `comMinhaLoja` e
`preco`. É o arquivo que circula por WhatsApp, imprime na vitrine e vai junto na
proposta ao banco.

### `GET /api/v1/veiculos/:id/material/fotos/:indice`

Foto neutra, servida pela plataforma. Redireciona para o arquivo hospedado; a
URL original das fotos do feed nunca aparece.

### `GET /api/v1/veiculos/:id/material/laudo.pdf`

O laudo cautelar. É o **único documento do carro** que circula na rede —
`404 INSPECTION_FILE_NOT_FOUND` quando não há arquivo anexado.

### `POST /api/v1/veiculos/:id/material/fotos`

Só a **loja proprietária** publica o conjunto neutro — é ela quem tem o carro
para fotografar.

```jsonc
{
  "fotos": [
    { "url": "https://midia…/frente.jpg",  "angulo": "FRONT" },
    { "url": "https://midia…/traseira.jpg","angulo": "REAR" },
    { "url": "https://midia…/interior.jpg","angulo": "INTERIOR" },
    { "url": "https://midia…/painel.jpg",  "angulo": "DASHBOARD" }
  ]
}
```

Ângulos: `FRONT`, `REAR`, `LEFT`, `RIGHT`, `INTERIOR`, `DASHBOARD`, `ENGINE`,
`TRUNK`, `OTHER`. Os três primeiros da lista obrigatória — frente, traseira e
interior — faltando, a resposta é `422 MATERIAL_ANGLES_MISSING` dizendo quais.

> A lista é diferente da vistoria de pátio de propósito: lá o objetivo é provar
> avaria, aqui é vender o carro.

A curadoria é humana: decidir se um adesivo no vidro entrega a origem é
julgamento, não regra que software aplique sozinho. O que o sistema garante é
que o conjunto exista e cubra os ângulos.

---

## Feeds e operação

### `POST /api/v1/feeds/sincronizacao`

Corpo: o XML cru, com `Content-Type: text/xml`. O integrador vem de
`?integrador=revendamais|motors|generic` ou é detectado pelo conteúdo.

```bash
curl -X POST "http://localhost:3000/api/v1/feeds/sincronizacao" \
  -H "Authorization: Bearer demo_prime_titular" \
  -H "Content-Type: text/xml" \
  --data-binary @estoque.xml
```

```jsonc
{
  "integrador": "revendamais",
  "resumo": { "recebidos": 42, "criados": 3, "atualizados": 5, "semMudanca": 34, "ausentes": 1, "recusados": 1 },
  "ausentes": [ { "veiculoId": "veh_0012", "placa": "ABC-1D23", "acao": "FLAGGED_ON_EXTENDED_CUSTODY" } ],
  "recusados": [ { "idExterno": "RM-1099", "codigo": "MISSING_NET_PRICE", "mensagem": "Sem preço líquido de repasse o veículo não circula na rede." } ]
}
```

Ações possíveis para veículos ausentes do feed: `WITHDRAWN` (estava no pátio da
dona), `FLAGGED_ON_EXTENDED_CUSTODY` (está com terceiro — decisão humana),
`DEFERRED_UNTIL_LOCK_ENDS` (há trava ativa).

`400 XML_DOCTYPE_REJECTED` para qualquer XML com DTD.

### `GET /api/v1/notificacoes?naoLidas=true&limite=50`

Mural de avisos da sua loja. É o que fecha o laço do produto: sem ele, a trava
que expira às 22h só seria descoberta por quem abrisse a tela no dia seguinte.

```jsonc
{
  "naoLidas": 3,
  "avisos": [
    {
      "id": "aud_0042",
      "tipo": "vehicle.available_again",
      "urgencia": "INFO",
      "titulo": "Veículo disponível novamente",
      "texto": "Um veículo voltou a ficar disponível na rede e está no pátio de uma loja parceira — pronto para apresentação imediata.",
      "agregadoId": "veh_0001",
      "ocorridoEm": "2026-08-24T22:00:00.000Z",
      "lidoEm": null
    }
  ]
}
```

`urgencia`: `INFO` (uma oportunidade apareceu), `ACTION_REQUIRED` (alguém precisa
agir, com prazo correndo) ou `ALERT` (prazo estourado ou inconsistência).

Quem recebe o quê:

| Evento | Vai para | Urgência |
|---|---|---|
| `vehicle.available_again` | toda a rede ativa | INFO |
| `feed.vehicle_created` | toda a rede, menos quem publicou | INFO |
| `recall.requested` | loja custodiante | ACTION_REQUIRED |
| `recall.sla_started` | loja custodiante | ACTION_REQUIRED |
| `recall.collection_elected` | loja custodiante | ACTION_REQUIRED |
| `recall.ready_for_pickup` | loja que chamou | ACTION_REQUIRED |
| `recall.deadline_reopened` | loja custodiante | ALERT |
| `recall.sla_breached` | custodiante e proprietária | ALERT |
| `recall.superseded_by_sale` | loja proprietária | INFO |
| `deal.confirmed` / `deal.settled` | loja proprietária | ACTION_REQUIRED / INFO |
| `deal.trade_in_acceptance_requested` | loja proprietária | ACTION_REQUIRED |
| `custody.discrepancies_found` | origem e destino | ALERT |
| `feed.duplicate_vin_detected` | as duas lojas envolvidas | ALERT |
| `feed.vehicle_missing` (com terceiro) | proprietária e custodiante | ACTION_REQUIRED |
| `membership.application_opened` | fundadoras, menos a padrinho | ACTION_REQUIRED |
| `network.store_admitted` | toda a rede | INFO |

`lock.opened`, `lock.extended` e as mudanças de preço **não** notificam: virariam
ruído e afogariam os avisos que exigem ação.

### `POST /api/v1/notificacoes/:id/lida`

Marca um aviso como lido. Idempotente — reler não muda o instante da primeira
leitura. Uma loja só enxerga e marca a própria caixa.

### `GET /api/v1/auditoria?agregadoId=&limite=`

Trilha derivada dos eventos de domínio: tipo, agregado, instante, loja e usuário
que agiram, e o payload do evento.

### `POST /api/v1/manutencao/varredura`

Dispara a varredura de travas vencidas e SLAs estourados sob demanda.

```jsonc
{ "travasExpiradas": 2, "recallsDescumpridos": 1 }
```

Existe para teste e operação. O varredor periódico faz o mesmo sozinho, e a
leitura de qualquer veículo já reconcilia a trava — chamar esta rota **nunca é
necessário para a correção do estado**.

---

## Configuração

| Variável | Padrão | O que faz |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `HOST` | `0.0.0.0` | interface |
| `SWEEP_INTERVAL_MS` | `60000` | intervalo do varredor |
| `MAX_BODY_BYTES` | `41943040` | teto do corpo (feeds grandes) |
| `SEED_DEMO_DATA` | `true` | semeia as 6 fundadoras e o estoque de exemplo |

As políticas de negócio (4h de trava, 4h úteis de SLA, quórum de 3 em 6,
tolerâncias de vistoria) ficam em `src/config.ts`, não em variável de ambiente:
são cláusulas do contrato da rede, e mudá-las é decisão de governança.
