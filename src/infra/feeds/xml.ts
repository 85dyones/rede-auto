/**
 * Parser XML minimo e defensivo para os feeds de estoque dos integradores.
 *
 * Por que nao uma biblioteca: o feed de estoque e um XML simples (elementos,
 * atributos, CDATA) vindo de terceiro nao confiavel. O que importa aqui nao e
 * cobrir a especificacao XML inteira — e RECUSAR o que e perigoso e nunca ficar
 * preso num arquivo malformado.
 *
 * Defesas, e o ataque que cada uma corta:
 *   - `<!DOCTYPE` rejeitado          -> XXE (ler /etc/passwd via entidade
 *                                       externa) e "billion laughs" (expansao
 *                                       exponencial de entidades);
 *   - instrucoes de processamento ignoradas;
 *   - limite de tamanho, profundidade e numero de nos -> exaustao de memoria;
 *   - so as cinco entidades predefinidas + referencias numericas sao expandidas.
 *
 * Busca de elementos e por nome LOCAL e sem diferenciar maiusculas: os feeds
 * reais alternam entre `<veiculo>`, `<Veiculo>` e `<ns:Veiculo>` sem aviso.
 */

import { type Result, err, ok } from '../../domain/shared/result.ts';
import { type DomainError, validationError } from '../../domain/shared/errors.ts';

export type XmlNode = {
  /** Nome local em minusculas, sem prefixo de namespace. Chave de busca. */
  readonly name: string;
  readonly rawName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
  /** Texto direto do elemento, ja com entidades expandidas e aparado. */
  readonly text: string;
};

export type XmlLimits = {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
};

export const DEFAULT_XML_LIMITS: XmlLimits = {
  // Um feed de 20 mil veiculos com fotos cabe folgado em 32 MB.
  maxBytes: 32 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 500_000,
};

export function parseXml(
  source: string,
  limits: XmlLimits = DEFAULT_XML_LIMITS,
): Result<XmlNode, DomainError> {
  if (source.length === 0) {
    return err(validationError('XML_EMPTY', 'O feed recebido esta vazio.'));
  }
  if (Buffer.byteLength(source, 'utf8') > limits.maxBytes) {
    return err(
      validationError('XML_TOO_LARGE', `O feed excede o limite de ${limits.maxBytes} bytes.`, {
        maxBytes: limits.maxBytes,
      }),
    );
  }
  if (/<!DOCTYPE/i.test(source)) {
    // Nenhum feed legitimo de estoque declara DTD. Quem declara esta tentando
    // entidade externa ou expansao recursiva.
    return err(
      validationError(
        'XML_DOCTYPE_REJECTED',
        'Declaracoes DOCTYPE nao sao aceitas neste endpoint.',
        { reason: 'XXE_AND_ENTITY_EXPANSION_GUARD' },
      ),
    );
  }

  const stack: MutableNode[] = [];
  let root: MutableNode | null = null;
  let nodeCount = 0;
  let cursor = 0;

  const pushText = (value: string): void => {
    const current = stack[stack.length - 1];
    if (current === undefined) return;
    const decoded = decodeEntities(value);
    if (decoded.trim().length > 0) current.textParts.push(decoded);
  };

  while (cursor < source.length) {
    const open = source.indexOf('<', cursor);
    if (open === -1) {
      pushText(source.slice(cursor));
      break;
    }
    if (open > cursor) pushText(source.slice(cursor, open));

    // Comentario.
    if (source.startsWith('<!--', open)) {
      const end = source.indexOf('-->', open + 4);
      if (end === -1) return err(malformed('comentario nao fechado', open));
      cursor = end + 3;
      continue;
    }

    // CDATA: conteudo literal, sem expansao de entidade.
    if (source.startsWith('<![CDATA[', open)) {
      const end = source.indexOf(']]>', open + 9);
      if (end === -1) return err(malformed('secao CDATA nao fechada', open));
      const current = stack[stack.length - 1];
      if (current !== undefined) current.textParts.push(source.slice(open + 9, end));
      cursor = end + 3;
      continue;
    }

    // Declaracao XML e instrucoes de processamento: ignoradas.
    if (source.startsWith('<?', open)) {
      const end = source.indexOf('?>', open + 2);
      if (end === -1) return err(malformed('instrucao de processamento nao fechada', open));
      cursor = end + 2;
      continue;
    }

    const close = source.indexOf('>', open);
    if (close === -1) return err(malformed('tag nao fechada', open));
    const raw = source.slice(open + 1, close).trim();

    // Fechamento.
    if (raw.startsWith('/')) {
      const name = localName(raw.slice(1).trim());
      const current = stack.pop();
      if (current === undefined) {
        return err(malformed(`fechamento </${name}> sem abertura correspondente`, open));
      }
      if (current.name !== name) {
        return err(malformed(`esperava </${current.rawName}>, encontrou </${name}>`, open));
      }
      cursor = close + 1;
      continue;
    }

    nodeCount += 1;
    if (nodeCount > limits.maxNodes) {
      return err(
        validationError('XML_TOO_MANY_NODES', `O feed excede ${limits.maxNodes} elementos.`, {
          maxNodes: limits.maxNodes,
        }),
      );
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const parsed = parseTag(body);
    const node: MutableNode = {
      name: localName(parsed.name),
      rawName: parsed.name,
      attributes: parsed.attributes,
      children: [],
      textParts: [],
    };

    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      if (root !== null) {
        return err(malformed('o documento tem mais de um elemento raiz', open));
      }
      root = node;
    } else {
      parent.children.push(node);
    }

    if (!selfClosing) {
      stack.push(node);
      if (stack.length > limits.maxDepth) {
        return err(
          validationError('XML_TOO_DEEP', `O feed excede ${limits.maxDepth} niveis de aninhamento.`, {
            maxDepth: limits.maxDepth,
          }),
        );
      }
    }
    cursor = close + 1;
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1] as MutableNode;
    return err(malformed(`elemento <${unclosed.rawName}> nao foi fechado`, source.length));
  }
  if (root === null) {
    return err(validationError('XML_NO_ROOT', 'O feed nao contem nenhum elemento.'));
  }

  return ok(freeze(root));
}

type MutableNode = {
  name: string;
  rawName: string;
  attributes: Record<string, string>;
  children: MutableNode[];
  textParts: string[];
};

function freeze(node: MutableNode): XmlNode {
  return {
    name: node.name,
    rawName: node.rawName,
    attributes: node.attributes,
    children: node.children.map(freeze),
    text: node.textParts.join('').trim(),
  };
}

function malformed(detail: string, position: number): DomainError {
  return validationError('XML_MALFORMED', `Feed XML malformado: ${detail}.`, { position });
}

/** Descarta o prefixo de namespace e normaliza a caixa. */
function localName(name: string): string {
  const colon = name.indexOf(':');
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

const ATTRIBUTE_PATTERN = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseTag(body: string): { name: string; attributes: Record<string, string> } {
  const match = /^([\w:.-]+)/.exec(body);
  const name = match?.[1] ?? body;
  const attributes: Record<string, string> = {};

  ATTRIBUTE_PATTERN.lastIndex = 0;
  let attribute: RegExpExecArray | null;
  while ((attribute = ATTRIBUTE_PATTERN.exec(body)) !== null) {
    const key = localName(attribute[1] as string);
    attributes[key] = decodeEntities(attribute[3] ?? attribute[4] ?? '');
  }
  return { name, attributes };
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Expande apenas as cinco entidades predefinidas e referencias numericas.
 * Entidade personalizada e ignorada (fica literal) — sem DTD, ela nao existe,
 * e tentar resolve-la e justamente o vetor do XXE.
 */
function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity.startsWith('#x') || entity.startsWith('#X')
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// ---------------------------------------------------------------------------
// Navegacao
// ---------------------------------------------------------------------------

/** Primeiro filho cujo nome local bate com QUALQUER um dos nomes dados. */
export function child(node: XmlNode | undefined, ...names: string[]): XmlNode | undefined {
  if (node === undefined) return undefined;
  const wanted = names.map((name) => name.toLowerCase());
  return node.children.find((candidate) => wanted.includes(candidate.name));
}

/** Todos os filhos com o nome local dado. */
export function children(node: XmlNode | undefined, ...names: string[]): XmlNode[] {
  if (node === undefined) return [];
  const wanted = names.map((name) => name.toLowerCase());
  return node.children.filter((candidate) => wanted.includes(candidate.name));
}

/**
 * Texto de um filho, aceitando varios nomes alternativos.
 * Devolve `undefined` para ausente OU vazio: um `<preco></preco>` no feed nao
 * carrega mais informacao do que a ausencia da tag.
 */
export function childText(node: XmlNode | undefined, ...names: string[]): string | undefined {
  const found = child(node, ...names);
  if (found === undefined) return undefined;
  return found.text.length > 0 ? found.text : undefined;
}

/** Atributo por nome local, aceitando alternativas. */
export function attr(node: XmlNode | undefined, ...names: string[]): string | undefined {
  if (node === undefined) return undefined;
  for (const name of names) {
    const value = node.attributes[name.toLowerCase()];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/** Texto de um filho OU de um atributo — os feeds usam os dois para a mesma coisa. */
export function textOrAttr(
  node: XmlNode | undefined,
  childNames: string[],
  attrNames: string[],
): string | undefined {
  return childText(node, ...childNames) ?? attr(node, ...attrNames);
}

/** Busca em profundidade pelo primeiro elemento com o nome local dado. */
export function findFirst(node: XmlNode, ...names: string[]): XmlNode | undefined {
  const wanted = names.map((name) => name.toLowerCase());
  const queue: XmlNode[] = [node];
  while (queue.length > 0) {
    const current = queue.shift() as XmlNode;
    if (wanted.includes(current.name)) return current;
    queue.push(...current.children);
  }
  return undefined;
}
