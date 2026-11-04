import type { Area, Block, GradeId, State } from './types';

export type ImportKind = 'titles' | 'topics' | 'practice' | 'sections';
export interface ImportIssue { row: number; field: string; message: string }
export interface ImportValidation {
  valid: boolean;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  rows: Record<string, unknown>[];
}

/** Canonical CSV/XLSX headers. Unknown amounts remain null, including prices. */
export const IMPORT_SCHEMAS: Record<ImportKind, readonly string[]> = {
  titles: ['code', 'publisher', 'series', 'area', 'block', 'gradeId', 'title', 'edition', 'declaredBasePrice', 'priceSource', 'priceValidity'],
  topics: ['bookCode', 'code', 'order', 'chapter', 'bimester', 'name', 'pages', 'revisitOf', 'distinctLesson'],
  practice: ['bookCode', 'topicCode', 'position', 'topicName', 'pages', 'baseCount', 'workbookCount', 'optionalCount', 'verified', 'evidence', 'workType'],
  sections: ['label', 'sourceGrade', 'gradeId', 'representative', 'replacement', 'accredited', 'accreditationEvidence'],
};

const text = (value: unknown): string => value == null ? '' : String(value).trim();
const normalized = (value: unknown): string => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const key = (value: unknown): string => normalized(value).replace(/[^a-z0-9]/g, '');
const gradeBlocks: Record<GradeId, Block> = {
  PRI1: 'P1', PRI2: 'P1', PRI3: 'P2', PRI4: 'P2', PRI5: 'P2', PRI6: 'P2', SEC1: 'S1', SEC2: 'S1', SEC3: 'S1',
};
const aliases: Record<string, readonly string[]> = {
  code: ['codigo', 'codigoTema', 'identificadorTema', 'temaId'],
  bookCode: ['codigoTexto', 'codigoLibro', 'textoCodigo', 'libroCodigo'],
  publisher: ['editorial', 'nombreEditorial'], series: ['serie', 'nombreSerie'],
  area: ['area'], block: ['bloque'], gradeId: ['grado', 'gradoDestino', 'grado2027', 'destino'],
  title: ['titulo', 'tituloTexto', 'tituloExacto'], edition: ['edicion', 'edicionAnio', 'anioEdicion'],
  declaredBasePrice: ['precio', 'precioBase', 'precioTotal', 'precioConjunto', 'precioDeclarado', 'precioSoles'],
  priceSource: ['fuentePrecio', 'fuenteCotizacion'], priceValidity: ['vigenciaPrecio', 'vigenciaCotizacion'],
  authors: ['autores'], obnate: ['registroObnate'], obnateSource: ['fuenteObnate'],
  order: ['orden', 'ordenAnual', 'posicionAnual'], chapter: ['capitulo', 'unidad'],
  bimester: ['bimestre'], name: ['nombre', 'nombreTema', 'tema'], pages: ['paginas', 'pagina', 'referenciaPagina'],
  revisitOf: ['retomaDe', 'referenciaTemaOriginal', 'temaOriginal'], distinctLesson: ['leccionDistinta'],
  topicCode: ['codigoTema', 'temaCodigo', 'topicId'], position: ['posicion', 'orden', 'ordenAnual'],
  topicName: ['nombreTema', 'tema', 'nombre'], baseCount: ['cantidadBase', 'consignasBase', 'recuentoBase', 'textoBase'],
  workbookCount: ['cantidadCuaderno', 'consignasCuaderno', 'cuadernoIncluido'],
  optionalCount: ['cantidadOpcional', 'consignasOpcionales', 'recursosOpcionales'],
  verified: ['verificado', 'comprobado'], evidence: ['evidencia', 'fuente', 'sustento'], workType: ['tipoTrabajo', 'tipoActividad'],
  label: ['seccion', 'nombreSeccion'], sourceGrade: ['gradoOrigen', 'origen', 'grado2026'],
  representative: ['representante', 'nombreRepresentante'], replacement: ['suplente', 'esSuplente'],
  accredited: ['acreditado', 'acreditada'], accreditationEvidence: ['evidenciaAcreditacion', 'sustentoAcreditacion'],
};

function grade(value: unknown): GradeId | null {
  const raw = key(value).toUpperCase();
  if (raw in gradeBlocks) return raw as GradeId;
  const primary = raw.match(/^(?:PRI|PRIMARIA|P)([1-6])$/) ?? raw.match(/^([1-6])(?:O|RO|DO|TO|ER)?(?:DE)?(?:PRIMARIA|PRI|P)$/);
  if (primary) return `PRI${primary[1]}` as GradeId;
  const secondary = raw.match(/^(?:SEC|SECUNDARIA|S)([1-3])$/) ?? raw.match(/^([1-3])(?:O|RO|DO|TO|ER)?(?:DE)?(?:SECUNDARIA|SEC|S)$/);
  return secondary ? `SEC${secondary[1]}` as GradeId : null;
}

function targetFromSource(value: unknown): GradeId | null {
  const raw = key(value);
  if (['ini5', 'inicial5', 'inicial5anos', 'inicialde5anos', '5anos', '5inicial', '5deinicial', '5anosinicial'].includes(raw)) return 'PRI1';
  const source = grade(value);
  if (!source) return null;
  if (source === 'PRI6') return 'SEC1';
  if (source.startsWith('PRI')) return `PRI${Number(source.at(-1)) + 1}` as GradeId;
  if (source === 'SEC1') return 'SEC2';
  if (source === 'SEC2') return 'SEC3';
  return null;
}

function toArea(value: unknown): Area | null {
  const raw = key(value);
  if (['mat', 'matematica', 'matematicas'].includes(raw)) return 'MAT';
  if (['com', 'comunicacion'].includes(raw)) return 'COM';
  return null;
}

function toBlock(value: unknown): Block | null {
  const raw = text(value).toUpperCase();
  return ['P1', 'P2', 'S1'].includes(raw) ? raw as Block : null;
}

function readNumber(value: unknown): number | null | undefined {
  if (value == null || text(value) === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const raw = text(value).replace(/^S\/?\.?\s*/i, '').replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (value == null || text(value) === '') return false;
  if (typeof value === 'boolean') return value;
  const raw = normalized(value);
  if (['1', 'true', 'si', 'sí', 'yes', 'verificado', 'acreditado'].includes(raw)) return true;
  if (['0', 'false', 'no', 'pendiente', 'declarado'].includes(raw)) return false;
  return undefined;
}

/** Validate an import without changing the state. Rows are insertion proposals, never upserts. */
export function validateImport(kind: ImportKind, incoming: Record<string, unknown>[], state: State): ImportValidation {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const rows: Record<string, unknown>[] = [];
  const fail = (row: number, field: string, message: string) => errors.push({ row, field, message });
  const warn = (row: number, field: string, message: string) => warnings.push({ row, field, message });
  if (!Object.hasOwn(IMPORT_SCHEMAS, kind)) return { valid: false, errors: [{ row: 1, field: 'kind', message: 'Tipo de importación desconocido.' }], warnings, rows };
  if (!Array.isArray(incoming) || !incoming.length) return { valid: false, errors: [{ row: 1, field: '', message: 'La carga debe contener al menos una fila.' }], warnings, rows };
  if (incoming.length > 20_000) return { valid: false, errors: [{ row: 1, field: '', message: 'La carga supera 20 000 filas; divídala en archivos menores.' }], warnings, rows };
  const canonical = [...IMPORT_SCHEMAS[kind], ...(kind === 'titles' ? ['authors', 'obnate', 'obnateSource'] : [])];
  const lookup = new Map<string, string>();
  for (const field of canonical) for (const alias of [field, ...(aliases[field] ?? [])]) lookup.set(key(alias), field);
  const seen = new Map<string, number>();
  const seenSecondary = new Map<string, number>();
  const booksByCode = new Map(state.books.filter(book => book.active).map(book => [normalized(book.code), book]));
  const topicImports = new Map<string, { row: number; value: Record<string, unknown> }>();

  for (let index = 0; index < incoming.length; index++) {
    const rowNo = index + 2;
    const input = incoming[index];
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      fail(rowNo, '', 'La fila debe ser un objeto de columnas.');
      rows.push({});
      continue;
    }
    const row: Record<string, unknown> = {};
    for (const [header, value] of Object.entries(input)) {
      const field = lookup.get(key(header));
      if (!field) {
        if (text(value)) warn(rowNo, header, 'Columna no reconocida; no se aplicará.');
        continue;
      }
      if (field in row) fail(rowNo, field, 'Hay dos columnas para el mismo dato.');
      row[field] = typeof value === 'string' ? value.trim() : value;
    }
    const requireText = (field: string, label: string) => {
      row[field] = text(row[field]);
      if (!row[field]) fail(rowNo, field, `${label} es obligatorio.`);
      return row[field] as string;
    };
    const optionalText = (field: string) => row[field] = text(row[field]);
    const number = (field: string, integer: boolean, required = false, positive = false) => {
      const parsed = readNumber(row[field]);
      row[field] = parsed ?? null;
      if (parsed === undefined || (parsed !== null && (parsed < 0 || (integer && !Number.isInteger(parsed)) || (positive && parsed === 0)))) {
        fail(rowNo, field, `Debe ser ${positive ? 'positivo' : 'no negativo'}${integer ? ' y entero' : ''}, o quedar vacío si se desconoce.`);
      } else if (required && parsed === null) fail(rowNo, field, 'El valor es obligatorio.');
      return parsed;
    };
    const boolean = (field: string) => {
      const parsed = readBoolean(row[field]);
      if (parsed === undefined) fail(rowNo, field, 'Use sí/no, true/false o 1/0.');
      row[field] = parsed ?? false;
      return parsed;
    };
    const duplicate = (stable: string, field: string, second = false) => {
      const registry = second ? seenSecondary : seen;
      const first = registry.get(stable);
      if (first !== undefined) fail(rowNo, field, `Clave duplicada en la carga (también en fila ${first}).`);
      else registry.set(stable, rowNo);
    };

    if (kind === 'titles') {
      const code = requireText('code', 'El código estable del texto');
      const publisher = requireText('publisher', 'La editorial');
      const series = requireText('series', 'La serie');
      requireText('title', 'El título exacto');
      const edition = requireText('edition', 'La edición');
      const area = toArea(row.area);
      if (!area) fail(rowNo, 'area', 'Use MAT (Matemática) o COM (Comunicación).');
      row.area = area ?? text(row.area);
      const gradeId = grade(row.gradeId);
      if (!gradeId) fail(rowNo, 'gradeId', 'Use PRI1–PRI6 o SEC1–SEC3 como grado 2027.');
      row.gradeId = gradeId ?? text(row.gradeId);
      const suppliedBlock = text(row.block);
      const block = suppliedBlock ? toBlock(suppliedBlock) : gradeId ? gradeBlocks[gradeId] : null;
      if (!block || (gradeId && block !== gradeBlocks[gradeId])) fail(rowNo, 'block', 'El bloque debe corresponder al grado: P1, P2 o S1.');
      row.block = block ?? suppliedBlock;
      number('declaredBasePrice', false);
      for (const field of ['priceSource', 'priceValidity', 'authors', 'obnate', 'obnateSource']) optionalText(field);
      if (row.declaredBasePrice !== null && !row.priceSource) warn(rowNo, 'priceSource', 'El precio se cargará como declarado; falta la referencia de la cotización.');
      if (code) {
        duplicate(normalized(code), 'code');
        if (state.books.some(book => normalized(book.code) === normalized(code))) fail(rowNo, 'code', 'El código ya existe. Edite o versione el texto con revisión; la carga no lo sobrescribe.');
      }
      if (publisher && series && area && gradeId && edition) {
        const stable = [publisher, series, area, gradeId, edition].map(normalized).join('|');
        duplicate(stable, 'gradeId', true);
        const existing = state.books.some(book => {
          const offer = state.offers.find(item => item.id === book.offerId);
          const linkedSeries = state.series.find(item => item.id === offer?.seriesId);
          const linkedPublisher = state.publishers.find(item => item.id === linkedSeries?.publisherId);
          return book.active && offer?.area === area && book.gradeId === gradeId && normalized(offer.edition) === normalized(edition)
            && normalized(linkedSeries?.name) === normalized(series) && normalized(linkedPublisher?.name) === normalized(publisher);
        });
        if (existing) fail(rowNo, 'gradeId', 'Ya existe un título activo para esa editorial, serie, edición, área y grado.');
      }
    } else if (kind === 'topics' || kind === 'practice') {
      const bookCode = requireText('bookCode', 'El código del texto');
      const book = booksByCode.get(normalized(bookCode));
      if (!book) fail(rowNo, 'bookCode', 'No existe un texto activo con ese código; importe primero los títulos.');
      if (book?.dossierClosed) fail(rowNo, 'bookCode', 'El expediente está cerrado. Reábralo con motivo y versión antes de incorporar datos.');
      if (kind === 'topics') {
        const code = requireText('code', 'El identificador estable del tema');
        number('order', true, true, true);
        requireText('chapter', 'El capítulo o unidad');
        requireText('name', 'El nombre del tema');
        optionalText('pages');
        optionalText('revisitOf');
        boolean('distinctLesson');
        const rawBimester = text(row.bimester).toUpperCase();
        const roman = ['I', 'II', 'III', 'IV'].indexOf(rawBimester) + 1;
        const bimester = rawBimester ? roman || readNumber(rawBimester) : null;
        row.bimester = bimester ?? null;
        if (bimester !== null && (!Number.isInteger(bimester) || bimester! < 1 || bimester! > 4)) fail(rowNo, 'bimester', 'El bimestre debe ser I–IV o 1–4; vacío significa pendiente.');
        if (rawBimester && bimester === undefined) fail(rowNo, 'bimester', 'El bimestre debe ser I–IV o 1–4.');
        if (row.bimester === null) warn(rowNo, 'bimester', 'La distribución de este tema queda pendiente.');
        if (!row.pages) warn(rowNo, 'pages', 'Falta la página o referencia del tema.');
        if (bookCode && code) {
          const stable = `${normalized(bookCode)}|${normalized(code)}`;
          duplicate(stable, 'code');
          topicImports.set(stable, { row: rowNo, value: row });
          if (book?.topics.some(topic => normalized(topic.code) === normalized(code))) fail(rowNo, 'code', 'El tema ya existe en ese texto; la carga no lo sobrescribe.');
        }
        if (bookCode && typeof row.order === 'number') {
          duplicate(`${normalized(bookCode)}|${row.order}`, 'order', true);
          if (book?.topics.some(topic => topic.order === row.order)) fail(rowNo, 'order', 'El orden anual ya está ocupado en ese texto.');
        }
      } else {
        optionalText('topicCode');
        const topic = book?.topics.find(item => normalized(item.code) === normalized(row.topicCode));
        if (row.topicCode && !topic) fail(rowNo, 'topicCode', 'Ese tema no existe en el índice del texto.');
        if (!text(row.position) && topic) row.position = topic.order;
        if (!text(row.topicName) && topic) row.topicName = topic.name;
        if (!text(row.pages) && topic) row.pages = topic.pages;
        number('position', true, true, true);
        requireText('topicName', 'El nombre del tema');
        requireText('pages', 'La página o unidad de referencia');
        for (const field of ['baseCount', 'workbookCount', 'optionalCount']) number(field, true);
        const verified = boolean('verified');
        optionalText('evidence'); optionalText('workType');
        if (verified && !row.evidence) fail(rowNo, 'evidence', 'Un conteo verificado requiere evidencia.');
        if (verified && row.baseCount === null) fail(rowNo, 'baseCount', 'Un conteo verificado debe indicar la cantidad base, incluido cero si se comprobó.');
        if (topic && row.position !== topic.order) fail(rowNo, 'position', 'La posición no coincide con el orden del tema en el índice.');
        if (book?.topics.length && !row.topicCode) fail(rowNo, 'topicCode', 'Con índice detallado debe identificar el código del tema para evitar cruces.');
        if (bookCode && typeof row.position === 'number') {
          duplicate(`${normalized(bookCode)}|${row.position}`, 'position');
          if (book?.practice.some(sample => sample.position === row.position)) fail(rowNo, 'position', 'Ya existe un recuento para esa posición; edítelo con revisión.');
        }
      }
    } else {
      const label = requireText('label', 'La sección');
      const source = requireText('sourceGrade', 'El grado de origen 2026');
      const expected = targetFromSource(source);
      if (!expected) fail(rowNo, 'sourceGrade', 'Indique inicial de 5 años, PRI1–PRI6 o SEC1–SEC2 como origen 2026.');
      const target = text(row.gradeId) ? grade(row.gradeId) : expected;
      row.gradeId = target ?? text(row.gradeId);
      if (!target) fail(rowNo, 'gradeId', 'El grado representado debe ser PRI1–PRI6 o SEC1–SEC3.');
      else if (expected && target !== expected) fail(rowNo, 'gradeId', `El origen indicado representa ${expected} en 2027.`);
      optionalText('representative');
      boolean('replacement');
      const accredited = boolean('accredited');
      optionalText('accreditationEvidence');
      if (accredited && (!row.representative || !row.accreditationEvidence)) fail(rowNo, 'accreditationEvidence', 'Una sección acreditada requiere representante y sustento de acreditación.');
      if (label && target) {
        duplicate(`${target}|${normalized(label)}`, 'label');
        if (state.sections.some(section => section.gradeId === target && normalized(section.label) === normalized(label))) fail(rowNo, 'label', 'La sección ya existe en ese grado; no se sobrescribirá ni duplicará su representación.');
      }
    }
    rows.push(row);
  }

  if (kind === 'topics') {
    for (const { row, value } of topicImports.values()) {
      if (!value.revisitOf) continue;
      const prefix = `${normalized(value.bookCode)}|`;
      const reference = `${prefix}${normalized(value.revisitOf)}`;
      const self = `${prefix}${normalized(value.code)}`;
      const book = booksByCode.get(normalized(value.bookCode));
      if (self === reference) fail(row, 'revisitOf', 'Un tema no puede retomarse a sí mismo.');
      else if (!topicImports.has(reference) && !book?.topics.some(topic => normalized(topic.code) === normalized(value.revisitOf))) fail(row, 'revisitOf', 'El tema original no existe en ese texto ni en esta carga.');
      const chain = new Set([self]);
      let next: string | undefined = reference;
      while (next && topicImports.has(next)) {
        if (chain.has(next)) { fail(row, 'revisitOf', 'Las referencias de temas retomados forman un ciclo.'); break; }
        chain.add(next);
        const linked: Record<string, unknown> = topicImports.get(next)!.value;
        next = linked.revisitOf ? `${prefix}${normalized(linked.revisitOf)}` : undefined;
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings, rows };
}
