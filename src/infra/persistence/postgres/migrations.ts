/**
 * Migracoes do esquema, em ordem. Cada uma roda numa transacao, com o
 * `search_path` apontado para o schema da instalacao — o SQL nao qualifica os
 * nomes, e e isso que deixa os testes rodarem cada um no seu schema.
 *
 * Ficam num modulo TypeScript, e nao em arquivos `.sql`, porque o empacotador
 * da funcao serverless so leva o que e importado: um `.sql` lido do disco em
 * tempo de execucao sumiria do pacote sem erro nenhum ate a primeira chamada.
 *
 * O desenho das tabelas, e por que ele e assim:
 *
 *  - **Uma tabela por agregado, com o agregado inteiro em `data jsonb`.** O
 *    dominio e funcional e devolve o agregado novo inteiro; o repositorio grava
 *    o que recebeu. Normalizar cada lista interna (extensoes da trava, parcelas
 *    da negociacao, fotos do termo) multiplicaria as tabelas sem que nenhuma
 *    consulta precise delas.
 *  - **As colunas fora do `data` sao so as que alguma consulta filtra ou
 *    ordena**, e as que uma constraint precisa enxergar. Elas sao derivadas do
 *    agregado a cada gravacao, nunca escritas a mao.
 *  - **`version`** e o controle de concorrencia: a gravacao confere a versao
 *    lida, e quem perdeu a corrida refaz a requisicao (ver `database.ts`).
 *  - **`seq`** preserva a ordem de insercao, que o adaptador em memoria
 *    devolvia de graca e algumas listas usam.
 *  - **Instantes em `bigint` de milissegundos**, como no dominio. Converter
 *    para `timestamptz` na borda criaria uma segunda fonte de verdade para
 *    "quando", e a aritmetica de horas uteis ja e toda em milissegundos.
 */

export type Migration = {
  readonly version: string;
  readonly sql: string;
};

const aggregate = (name: string, columns: string): string => `
CREATE TABLE ${name} (
  id text PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  ${columns},
  version integer NOT NULL,
  data jsonb NOT NULL
);`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: '001_inicial',
    sql: `
CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

${aggregate('clusters', 'slug text NOT NULL UNIQUE')}

${aggregate(
  'members',
  `cluster_id text NOT NULL,
  -- A raiz do CNPJ e unica na instalacao inteira, nao por praca.
  cnpj_root text NOT NULL UNIQUE,
  kind text NOT NULL`,
)}
CREATE INDEX members_by_cluster ON members (cluster_id, kind);

${aggregate(
  'stores',
  `cluster_id text NOT NULL,
  member_id text NOT NULL,
  cnpj text NOT NULL UNIQUE`,
)}
CREATE INDEX stores_by_cluster ON stores (cluster_id);
CREATE INDEX stores_by_member ON stores (member_id);

${aggregate('users', 'store_id text NOT NULL')}
CREATE INDEX users_by_store ON users (store_id);

${aggregate(
  'membership_applications',
  `cluster_id text NOT NULL,
  status text NOT NULL`,
)}
CREATE INDEX membership_applications_by_status ON membership_applications (cluster_id, status);

${aggregate(
  'vehicles',
  `cluster_id text NOT NULL,
  owner_store_id text NOT NULL,
  custodian_store_id text NOT NULL,
  chassis text NOT NULL,
  commercial_status text NOT NULL,
  brand_folded text NOT NULL,
  model_folded text NOT NULL,
  net_price_cents bigint NOT NULL,
  model_year integer NOT NULL,
  mileage_km integer NOT NULL,
  updated_at bigint NOT NULL`,
)}
CREATE INDEX vehicles_catalog ON vehicles (cluster_id, commercial_status);
CREATE INDEX vehicles_by_owner ON vehicles (owner_store_id);
CREATE INDEX vehicles_by_custodian ON vehicles (custodian_store_id);
CREATE INDEX vehicles_by_chassis ON vehicles (chassis);

${aggregate(
  'commercial_locks',
  `vehicle_id text NOT NULL,
  status text NOT NULL,
  opened_at bigint NOT NULL,
  expires_at bigint NOT NULL`,
)}
CREATE INDEX commercial_locks_by_vehicle ON commercial_locks (vehicle_id, opened_at);
CREATE INDEX commercial_locks_due ON commercial_locks (expires_at) WHERE status = 'ACTIVE';
-- Decisao 23. Duas lojas que leem o carro AVAILABLE ao mesmo tempo e travam
-- as duas: a segunda gravacao bate aqui. E a ultima linha de defesa contra a
-- venda duplicada; a primeira continua sendo o dominio, que tem a mensagem boa.
CREATE UNIQUE INDEX commercial_locks_one_active_per_vehicle
  ON commercial_locks (vehicle_id) WHERE status = 'ACTIVE';

${aggregate(
  'custody_transfers',
  `vehicle_id text NOT NULL,
  status text NOT NULL,
  opened_at bigint NOT NULL`,
)}
CREATE INDEX custody_transfers_by_vehicle ON custody_transfers (vehicle_id, opened_at);
CREATE INDEX custody_transfers_pending ON custody_transfers (opened_at)
  WHERE status IN ('OPEN', 'DROPPED_OFF');

${aggregate(
  'recalls',
  `vehicle_id text NOT NULL,
  status text NOT NULL,
  custodian_store_id text NOT NULL,
  requested_by_store_id text NOT NULL,
  requested_at bigint NOT NULL`,
)}
CREATE INDEX recalls_by_vehicle ON recalls (vehicle_id, requested_at);
-- Um recall aberto por carro. O pedido so insere uma linha nova, e a versao so
-- pega quem regrava a mesma linha: dois pedidos simultaneos passariam os dois.
-- Aqui o segundo bate, a requisicao e refeita, e o dominio responde
-- RECALL_ALREADY_OPEN.
CREATE UNIQUE INDEX recalls_one_open_per_vehicle ON recalls (vehicle_id)
  WHERE status IN ('WAITING_LOCK_RELEASE', 'DUE', 'READY_FOR_PICKUP');

${aggregate(
  'deals',
  `vehicle_id text NOT NULL,
  owner_store_id text NOT NULL,
  selling_store_id text NOT NULL,
  created_at bigint NOT NULL`,
)}
CREATE INDEX deals_by_vehicle ON deals (vehicle_id, created_at);
CREATE INDEX deals_by_owner ON deals (owner_store_id);
CREATE INDEX deals_by_seller ON deals (selling_store_id);

${aggregate(
  'charges',
  `cluster_id text NOT NULL,
  member_id text NOT NULL,
  status text NOT NULL,
  issued_at bigint NOT NULL`,
)}
CREATE INDEX charges_by_member ON charges (member_id, issued_at);
CREATE INDEX charges_open ON charges (cluster_id) WHERE status = 'OPEN';

${aggregate(
  'breaches',
  `cluster_id text NOT NULL,
  member_id text NOT NULL,
  store_id text NOT NULL,
  occurred_at bigint NOT NULL`,
)}
CREATE INDEX breaches_by_store ON breaches (store_id, occurred_at);
CREATE INDEX breaches_by_member ON breaches (member_id, occurred_at);
CREATE INDEX breaches_by_cluster ON breaches (cluster_id, occurred_at);

${aggregate(
  'expulsion_motions',
  `cluster_id text NOT NULL,
  member_id text NOT NULL,
  status text NOT NULL,
  opened_at bigint NOT NULL`,
)}
CREATE INDEX expulsion_motions_by_member ON expulsion_motions (member_id, opened_at);
CREATE INDEX expulsion_motions_open ON expulsion_motions (cluster_id) WHERE status = 'OPEN';

-- Trilha e mural so crescem; nao ha agregado a versionar, so ordem a manter.
CREATE TABLE audit_entries (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  aggregate_id text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX audit_entries_by_aggregate ON audit_entries (aggregate_id, seq);

CREATE TABLE notifications (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  store_id text NOT NULL,
  read_at bigint,
  data jsonb NOT NULL
);
CREATE INDEX notifications_by_store ON notifications (store_id, seq);

-- So o hash da chave e gravado. A chave em claro nao chega aqui.
CREATE TABLE store_api_keys (
  key_hash text PRIMARY KEY,
  store_id text NOT NULL,
  user_id text NOT NULL,
  label text NOT NULL
);

CREATE TABLE platform_api_keys (
  key_hash text PRIMARY KEY,
  operator_id text NOT NULL,
  name text NOT NULL
);

-- No Supabase, os papeis da API REST publica (anon, authenticated) nao tem o
-- que fazer aqui: preco liquido e hash de chave nao saem por ela. O schema ja
-- fica fora da API por nao ser o public; a revogacao e a segunda tranca.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM anon, authenticated', current_schema());
  END IF;
END $$;
`,
  },
];
