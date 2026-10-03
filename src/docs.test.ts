/**
 * Os links internos da documentacao resolvem.
 *
 * Existe porque ja quebrou duas vezes: inserir uma decisao no meio de
 * `decisoes.md` renumera todas as seguintes, e as ancoras que apontavam para
 * elas passam a cair no vazio silenciosamente. Um leitor clica e nao acontece
 * nada — o pior tipo de defeito de documentacao, porque nao da erro.
 *
 * Verifica o que da para verificar sem rede: caminhos de arquivo e ancoras
 * dentro do repositorio. Links externos ficam de fora de proposito — testes que
 * dependem de internet falham por motivo errado.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

function markdownFiles(): string[] {
  const found = [join(ROOT, 'README.md')];
  const docs = join(ROOT, 'docs');
  if (existsSync(docs)) {
    for (const name of readdirSync(docs)) {
      if (name.endsWith('.md')) found.push(join(docs, name));
    }
  }
  return found;
}

/**
 * Ancora no estilo GitHub: minusculas, pontuacao fora, espacos viram hifen.
 * Os acentos ficam — e por isso que `#23-concorrência-...` e a forma correta.
 */
/**
 * A ancora que o GitHub gera para um titulo.
 *
 * As tres substituicoes finais sao a regra do GitHub, e a ordem importa:
 * minusculas, fora tudo que nao e letra, numero, espaco, hifen ou
 * SUBLINHADO, e espaco vira hifen.
 *
 * O sublinhado fica, e isso ja esteve errado aqui. Uma versao anterior o
 * removia junto com o asterisco, tratando os dois como marcadores de enfase —
 * mas o GitHub o preserva, entao o teste calculava uma ancora que o
 * renderizador nunca produz. Erro dos dois lados ao mesmo tempo: aceitava link
 * quebrado de verdade e recusava link que funciona. Um teste de link que nao
 * usa a regra do renderizador da confianca falsa, que e pior que nao ter teste.
 *
 * O backtick sai antes porque o GitHub remove a marcacao de codigo e mantem o
 * conteudo; o asterisco sai porque e enfase, e nao sobra no texto renderizado.
 *
 * E a troca de espaco e UM POR UM (`/ /g`), nao por run (`/\s+/g`). Era o
 * segundo erro da versao anterior, e aparece exatamente onde a pontuacao removida
 * deixa dois espacos seguidos: "nao `+ 4 * 3600_000`" vira
 * `nao--4--3600_000`, com hifen duplo. Colapsar produzia um hifen so, e o link
 * que o teste aprovava morria no GitHub.
 */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\*/g, '')
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
}

function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of markdown.split('\n')) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading === null) continue;
    const base = slugify(heading[1] as string);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

type Link = { readonly from: string; readonly target: string };

function linksOf(file: string, markdown: string): Link[] {
  const links: Link[] = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const target = match[1] as string;
    if (/^(https?:|mailto:)/.test(target)) continue;
    links.push({ from: file, target });
  }
  return links;
}

describe('links da documentacao', () => {
  const files = markdownFiles();
  const anchorCache = new Map<string, Set<string>>();

  function anchorsFor(file: string): Set<string> {
    const cached = anchorCache.get(file);
    if (cached !== undefined) return cached;
    const computed = anchorsOf(readFileSync(file, 'utf8'));
    anchorCache.set(file, computed);
    return computed;
  }

  test('existe documentacao para verificar', () => {
    assert.ok(files.length >= 5, 'README + docs/');
  });

  for (const file of files) {
    const short = relative(ROOT, file);

    test(`${short}: todo link interno resolve`, () => {
      const markdown = readFileSync(file, 'utf8');
      const quebrados: string[] = [];

      for (const link of linksOf(file, markdown)) {
        const [path, anchor] = link.target.split('#');

        const alvo = path === '' || path === undefined ? file : resolve(dirname(file), path);
        if (!existsSync(alvo)) {
          quebrados.push(`${link.target} — arquivo nao existe`);
          continue;
        }
        if (anchor === undefined || anchor === '') continue;
        if (!alvo.endsWith('.md')) continue;

        if (!anchorsFor(alvo).has(decodeURIComponent(anchor))) {
          quebrados.push(`${link.target} — o arquivo existe, a ancora nao`);
        }
      }

      assert.deepEqual(quebrados, [], `links quebrados em ${short}`);
    });
  }
});
