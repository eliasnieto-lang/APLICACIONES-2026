import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Area, Block, Book, Shortlist, State } from '../shared/types';
import { AREAS, BLOCKS, GRADES, INDICATORS, assessBook, basePrice, practiceSummary, scoreEvaluation, workloadSummary } from '../shared/domain';
import { PRESENTATION_INDICATORS, presentationEvaluationScaleMax, presentationScaleLabel, presentationScore, presentationSummary } from '../shared/presentation';
import { LEGACY_PRESENTATION_INDICATORS } from '../shared/presentation-legacy';

export const A4 = { width: 595.28, height: 841.89 };
export interface ReportOptions { demo?: boolean; generatedAt?: string }
const clean = (value: unknown) => String(value ?? '').normalize('NFC').replace(/[\u2010-\u2015]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[^\x20-\x7e\xa0-\xff\n]/g, ' ');
const number = (value: number | null | undefined) => value === null || value === undefined ? 'Pendiente' : value.toFixed(2);
const money = (value: number | null) => value === null ? 'Precio pendiente / sin desglose' : `S/ ${value.toFixed(2)}`;
const gradeName = (id: string) => GRADES.find(grade => grade.id === id)?.label ?? id;
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : 'Pendiente';
const findBook = (state: State, id: string) => { const book = state.books.find(book => book.id === id); if (!book) throw new Error('No se encontró el título.'); return book; };
const findRound = (state: State, id: string) => { const round = state.rounds.find(round => round.id === id); if (!round) throw new Error('No se encontró la ronda.'); return round; };
function offerName(state: State, id: string) {
  const offer = state.offers.find(offer => offer.id === id); const series = state.series.find(series => series.id === offer?.seriesId);
  return `${state.publishers.find(publisher => publisher.id === series?.publisherId)?.name ?? 'Editorial pendiente'} / ${series?.name ?? 'Serie pendiente'}`;
}

class PrintedReport {
  document!: PDFDocument; regular!: PDFFont; bold!: PDFFont; page!: PDFPage; y = 0;
  constructor(private state: State, private title: string, private privacy: string, private options: ReportOptions) {}
  async initialize() {
    this.document = await PDFDocument.create();
    this.regular = await this.document.embedFont(StandardFonts.Helvetica);
    this.bold = await this.document.embedFont(StandardFonts.HelveticaBold);
    this.document.setTitle(clean(this.title)); this.document.setAuthor(clean(this.state.settings.school));
    this.document.setSubject(clean(this.privacy)); this.document.setCreator('Selección de textos escolares 2027');
    this.addPage(); return this;
  }
  addPage() {
    this.page = this.document.addPage([A4.width, A4.height]); this.y = A4.height - 42;
    this.page.drawRectangle({ x: 0, y: A4.height - 12, width: A4.width, height: 12, color: rgb(.04, .19, .34) });
    this.write(this.state.settings.school, { bold: true, size: 11 });
    this.write(this.title, { bold: true, size: 16 });
    if (this.options.demo) this.write('DEMOSTRACIÓN - DATOS FICTICIOS', { bold: true, size: 10 });
    this.write(this.privacy, { size: 8 }); this.y -= 8;
  }
  ensure(height: number) { if (this.y - height < 55) this.addPage(); }
  write(value: unknown, options: { bold?: boolean; size?: number; indent?: number; gap?: number } = {}) {
    const font = options.bold ? this.bold : this.regular; const size = options.size ?? 10;
    const x = 42 + (options.indent ?? 0); const maxWidth = A4.width - x - 42; const lineHeight = size * 1.36;
    for (const paragraph of clean(value).split('\n')) {
      const words = paragraph.split(/\s+/); const lines: string[] = []; let line = '';
      for (const word of words) {
        if (font.widthOfTextAtSize(`${line} ${word}`.trim(), size) <= maxWidth) { line = `${line} ${word}`.trim(); continue; }
        if (line) lines.push(line); line = '';
        let fragment = '';
        for (const char of word) {
          if (font.widthOfTextAtSize(fragment + char, size) > maxWidth) { lines.push(fragment); fragment = ''; }
          fragment += char;
        }
        line = fragment;
      }
      lines.push(line || ' ');
      for (const row of lines) { this.ensure(lineHeight); this.page.drawText(row, { x, y: this.y, size, font, color: rgb(.08, .13, .2) }); this.y -= lineHeight; }
    }
    this.y -= options.gap ?? 3;
  }
  heading(text: string) { this.ensure(43); this.y -= 8; this.write(text, { bold: true, size: 12, gap: 6 }); }
  field(label: string, value: unknown) { this.write(`${label}: ${value === '' || value === null || value === undefined ? '____________________________ (pendiente)' : String(value)}`); }
  blank(label: string) { this.ensure(36); this.write(`${label}: _______________________________________________________`); this.y -= 10; }
  signatures(labels: string[] = ['Dirección', 'Docente portavoz', 'Representación de familias']) {
    this.ensure(100 + labels.length * 35); this.heading('Firmas formales');
    this.write('El registro o cierre en la aplicación no sustituye las firmas de este documento.', { size: 9 });
    for (const label of labels) this.blank(`Firma y nombre - ${label}`);
    this.blank('Fecha / hora y sello');
  }
  async finish() {
    const pages = this.document.getPages();
    pages.forEach((page, index) => {
      page.drawLine({ start: { x: 42, y: 40 }, end: { x: A4.width - 42, y: 40 }, thickness: .5, color: rgb(.65, .7, .75) });
      page.drawText(clean(`Selección de textos 2027 | Página ${index + 1}/${pages.length} | ${this.options.generatedAt ? date(this.options.generatedAt) : 'Hora de Huaraz'}`), { x: 42, y: 26, size: 8, font: this.regular });
    });
    return this.document.save();
  }
}

export async function buildTeacherPdf(state: State, bookId: string, evaluationId?: string, options: ReportOptions = {}): Promise<Uint8Array> {
  const book = findBook(state, bookId); const offer = state.offers.find(offer => offer.id === book.offerId);
  const evaluation = evaluationId ? state.evaluations.find(item => item.id === evaluationId && item.bookId === book.id) : undefined;
  if (evaluationId && !evaluation) throw new Error('La ficha seleccionada no corresponde al título.');
  const report = await new PrintedReport(state, 'Ficha individual de evaluación docente', 'DOCUMENTO INTERNO - valoración individual reservada', options).initialize();
  report.field('Editorial / serie', offerName(state, book.offerId)); report.field('Título', book.title);
  report.field('Código / edición / grado', `${book.code} / ${book.edition} / ${gradeName(book.gradeId)}`);
  report.field('Área', AREAS.find(area => area.id === offer?.area)?.label);
  report.field('Docente', state.teachers.find(teacher => teacher.id === evaluation?.teacherId)?.name);
  report.field('Estado / cierre', evaluation ? `${evaluation.status === 'closed' ? 'Cerrada' : 'Borrador'} / ${date(evaluation.closedAt)}` : 'Ficha en blanco - no emitida');
  report.field('Versión de expediente / reglas', `${evaluation?.bookVersion ?? book.version} / ${evaluation?.rulesVersion ?? state.settings.rules.version}`);
  report.write('Escala: 0 = ninguna señal acreditada; 1 = parcial o una señal; 2 = ambas señales; pendiente = sin comprobar. No se asignan valores por defecto.');
  for (const [index, indicator] of INDICATORS.entries()) {
    const signals = indicator.variants && offer ? indicator.variants[offer.area] : indicator;
    report.heading(`${indicator.id}. ${indicator.label}`);
    report.write(`A: ${signals.a}`, { size: 9 }); report.write(`B: ${signals.b}`, { size: 9 });
    report.field('Puntaje 0 / 1 / 2', evaluation?.scores[index] === null || evaluation?.scores[index] === undefined ? 'Pendiente [  ] 0   [  ] 1   [  ] 2' : String(evaluation.scores[index]));
    report.field('Evidencia / página', evaluation?.evidence[index]); report.field('Observación', evaluation?.notes[index]);
  }
  const total = evaluation ? scoreEvaluation(evaluation) : null;
  report.heading('Resultado individual'); report.field('Puntaje /100', total === null ? 'Pendiente - ficha incompleta' : `${number(total)} (5 x suma de indicadores)`);
  report.field('Objeción / incidencia', evaluation?.objection ? evaluation.objectionDetail : 'Sin objeción registrada / completar si corresponde');
  report.field('Pauta institucional de práctica', state.settings.rules.practiceGuidelines[`${offer?.area}-${book.gradeId}`]);
  report.signatures(['Docente evaluador', 'Dirección / Subdirección']); return report.finish();
}

export interface PresentationTeacherReportScope {
  publisherId: string; area: Area; block: Block; evaluationId?: string; teacherId?: string;
}

/** One author's live observations; never includes another teacher's sheet or a book dossier. */
export async function buildPresentationTeacherPdf(state: State, scope: PresentationTeacherReportScope, options: ReportOptions = {}): Promise<Uint8Array> {
  const publisher = state.publishers.find(item => item.id === scope.publisherId);
  if (!publisher) throw new Error('No se encontró la editorial.');
  const evaluation = scope.evaluationId ? (state.presentationEvaluations ?? []).find(item => item.id === scope.evaluationId) : undefined;
  if (scope.evaluationId && (!evaluation || evaluation.publisherId !== scope.publisherId || evaluation.area !== scope.area || evaluation.block !== scope.block
    || (scope.teacherId && evaluation.teacherId !== scope.teacherId))) throw new Error('La ficha seleccionada no corresponde al docente, editorial, área y categoría.');
  const teacher = state.teachers.find(item => item.id === (evaluation?.teacherId ?? scope.teacherId));
  const scaleMax = evaluation ? presentationEvaluationScaleMax(evaluation) : 4;
  const score = evaluation ? presentationScore(evaluation) : null;
  const rawTotal = evaluation && score !== null ? evaluation.scores.reduce<number>((sum, value) => sum + value!, 0) : null;
  const report = await new PrintedReport(state, 'Ficha individual de exposición editorial', 'DOCUMENTO INTERNO - observaciones de un solo docente', options).initialize();
  report.field('Editorial', publisher.name);
  report.field('Área', AREAS.find(item => item.id === scope.area)?.label ?? scope.area);
  report.field('Categoría', BLOCKS.find(item => item.id === scope.block)?.label ?? scope.block);
  report.field('Docente evaluador', teacher?.name);
  report.field('Ejemplar físico observado (opcional)', evaluation?.physicalText || 'Sin identificación adicional registrada');
  report.field('Estado / cierre', evaluation ? `${evaluation.status === 'closed' ? 'Cerrada' : 'Borrador'} / ${date(evaluation.closedAt)}` : 'Ficha en blanco - no emitida');
  report.field('Versión de ficha / reglas', `${evaluation?.version ?? 0} / ${evaluation?.rulesVersion ?? state.settings.rules.version}`);
  report.field('Escala de la ficha', scaleMax === 4 ? 'Vigente: 0 a 4; máximo 40 puntos' : 'HISTÓRICA: 0 a 2; máximo 20 puntos; resultado original conservado');
  report.write(scaleMax === 4
    ? 'Valore lo observado durante la exposición y al revisar el ejemplar físico. Escala: 0 = Sin valoración; 1 = En inicio; 2 = En proceso; 3 = Logrado; 4 = Destacado. Elegir 0 es una respuesta y aporta cero puntos; pendiente significa sin responder. Las observaciones breves son opcionales.'
    : 'ARCHIVO HISTÓRICO: esta ficha conserva sus valores de la escala 0 a 2. No se convierte a la escala vigente ni participa en sus nuevos promedios. Para actualizarla, el docente debe volver a valorar expresamente los diez indicadores.');
  if (scaleMax === 2) report.heading('Rúbrica histórica 0–2');
  for (const [index, currentIndicator] of PRESENTATION_INDICATORS.entries()) {
    const indicator = scaleMax === 2 ? LEGACY_PRESENTATION_INDICATORS[index] : currentIndicator;
    report.heading(`${indicator.id}. ${indicator.label}`);
    if (scaleMax === 2) {
      const legacy = LEGACY_PRESENTATION_INDICATORS[index];
      const signals = legacy.variants?.[scope.area] ?? legacy;
      report.write(`A: ${signals.a}`, { size: 9 }); report.write(`B: ${signals.b}`, { size: 9 });
    } else report.write(currentIndicator.variants?.[scope.area]?.description ?? currentIndicator.description, { size: 9 });
    const value = evaluation?.scores[index];
    const choices = scaleMax === 4 ? '0 / 1 / 2 / 3 / 4' : '0 / 1 / 2';
    report.field(`Puntaje ${choices}`, value === null || value === undefined
      ? `Pendiente ${Array.from({ length: scaleMax + 1 }, (_, value) => `[  ] ${value}`).join('   ')}`
      : scaleMax === 4 ? `${value} - ${presentationScaleLabel(value)}` : `${value} (escala histórica)`);
    report.field('Observación propia (opcional)', evaluation?.notes[index] || '________________________________________');
  }
  report.heading('Resultado individual');
  report.field('Suma / máximo', rawTotal === null ? `Pendiente / ${10 * scaleMax}` : `${rawTotal} / ${10 * scaleMax}`);
  report.field('Puntaje /100', score === null ? 'Pendiente - diez respuestas necesarias' : `${number(score)} (${scaleMax === 4 ? '2.5' : '5'} x suma de diez indicadores)`);
  report.field('Observación general propia (opcional)', evaluation?.generalObservation || '________________________________________');
  report.signatures(['Docente evaluador', 'Dirección / Subdirección']);
  return report.finish();
}

/** Uses the published aggregate snapshot, even when the catalog or live reviews change later. */
export async function buildPresentationShortlistPdf(state: State, shortlistId: string, options: ReportOptions = {}): Promise<Uint8Array> {
  const shortlist = (state.presentationShortlists ?? []).find(item => item.id === shortlistId);
  if (!shortlist) throw new Error('No se encontró la terna de exposición.');
  const report = await new PrintedReport(state, 'Constancia de terna por exposición editorial', 'RESULTADO AGREGADO - sin fichas ni observaciones individuales', options).initialize();
  report.field('Área / categoría', `${AREAS.find(item => item.id === shortlist.area)?.label ?? shortlist.area} / ${BLOCKS.find(item => item.id === shortlist.block)?.label ?? shortlist.block}`);
  report.field('Versión / estado / reglas', `${shortlist.version} / ${shortlist.status} / ${shortlist.rulesVersion}`);
  report.field('Folio / publicación', `${shortlist.folio} / ${date(shortlist.publishedAt)}`);
  report.field('Validación de Dirección', shortlist.directorApproved ? 'Registrada; recoger firma formal' : 'Pendiente');
  const assessment = shortlist.snapshot.assessment;
  const scaleMax = shortlist.snapshot.scaleMax ?? 2;
  report.field('Escala de la versión publicada', scaleMax === 4 ? '0 a 4; máximo individual 40 puntos' : 'HISTÓRICA: 0 a 2; resultados originales conservados');
  report.field('Docentes registrados / fichas cerradas / pendientes al publicar', `${assessment.registered} / ${assessment.closed} / ${assessment.pending}`);
  report.field('Umbral /100 utilizado', shortlist.snapshot.threshold);
  shortlist.publisherIds.forEach((publisherId, index) => {
    const publisher = shortlist.snapshot.publishers.find(item => item.id === publisherId);
    const result = assessment.ranked.find(item => item.publisherId === publisherId);
    report.heading(`${index + 1}. ${publisher?.name ?? 'Editorial de la versión publicada'}`);
    report.field('Puntaje agregado /100', number(result?.score));
    report.field('Docentes registrados / cerrados / pendientes', `${result?.registered ?? 0} / ${result?.closed ?? 0} / ${result?.pending ?? 0}`);
    report.field(`I2 promedio (escala 0-${scaleMax})`, number(result?.i2));
  });
  report.field('Apreciación pedagógica del portavoz', shortlist.statement);
  report.write('El promedio utiliza todas las fichas cerradas de docentes registrados en el área y categoría. Este resultado no asigna notas individuales por grado ni sustituye el procedimiento de elección familiar.');
  report.signatures(); return report.finish();
}

/** Anonymous paper form: no section, representative, code, teacher or individual ballot identifier. */
export async function buildPaperBallotPdf(state: State, roundId: string, options: ReportOptions = {}): Promise<Uint8Array> {
  const round = findRound(state, roundId); if (round.mode !== 'paper') throw new Error('La ronda digital no admite cédulas en papel.');
  const report = await new PrintedReport(state, 'Cédula anónima de elección familiar', 'SIN NOMBRE, FIRMA, SECCIÓN NI CÓDIGO INDIVIDUAL', options).initialize();
  report.field('Grado representado 2027', gradeName(round.gradeId)); report.field('Ronda', round.number);
  report.write('Después de revisar los ejemplares físicos, marque una sola alternativa por área. Cada área se cuenta por separado. No escriba datos que identifiquen a su familia o sección.');
  for (const area of round.areas) {
    report.heading(AREAS.find(item => item.id === area)?.label ?? area);
    for (const id of round.options[area] ?? []) {
      const book = state.books.find(book => book.offerId === id && book.gradeId === round.gradeId && book.active);
      report.write(`[   ] ${offerName(state, id)}`, { bold: true }); report.write(`${book?.title ?? 'Título no disponible'} - Edición ${book?.edition ?? 'pendiente'}`, { indent: 24 });
    }
    report.write('Deje las opciones del área sin marcar si desea votar en blanco.', { size: 9 });
  }
  report.heading('Instrucciones de mesa'); report.write('Doble esta cédula y deposítela en el ánfora. No agregue firma, correlativo ni dato personal. La asistencia y la entrega se acreditan en una hoja separada.');
  return report.finish();
}

function resourceDescription(book: Book, profile: 'teacherSupport' | 'studentSupport') {
  const data = book[profile];
  return `${data.status}; ${data.included ? 'incluido' : 'no incluido'}; acceso: ${data.access || 'pendiente'}; acción: ${data.action || 'pendiente'}; celular: ${data.mobile || 'pendiente'}; conexión: ${data.connection || 'pendiente'}; sin conexión: ${data.offline || 'pendiente'}; vigencia: ${data.validity || 'pendiente'}; extra: ${money(data.extraCost)}; prueba: ${data.testedAt || 'pendiente'}; evidencia: ${data.evidence || 'pendiente'}`;
}

export async function buildComparisonPdf(state: State, roundId: string, options: ReportOptions = {}): Promise<Uint8Array> {
  const round = findRound(state, roundId); const report = await new PrintedReport(state, 'Tarjetas para mesas de revisión', 'MATERIAL DE CONSULTA - sin fichas docentes ni padrón personal', options).initialize();
  report.field('Grado 2027 / ronda', `${gradeName(round.gradeId)} / ${round.number}`);
  report.write('Reserve tiempo para revisar los ejemplares físicos. El puntaje técnico informa; cada familia elige por grado y área.');
  for (const area of round.areas) {
    report.heading(AREAS.find(item => item.id === area)?.label ?? area);
    const shortlist = state.shortlists.find(item => item.id === round.shortlistIds[area]);
    report.field('Terna vinculada / reglas / folio', shortlist ? `versión ${shortlist.version} / ${shortlist.rulesVersion} / ${shortlist.folio}` : 'Pendiente');
    const source = stateFromShortlist(state, shortlist);
    for (const id of round.options[area] ?? []) {
      const book = source.books.find(book => book.offerId === id && book.gradeId === round.gradeId && book.active); if (!book) continue;
      const workload = workloadSummary(book); const practice = practiceSummary(book);
      report.heading(offerName(source, id)); report.field('Título / edición', `${book.title} / ${book.edition}`);
      report.field('Nota técnica por grado', number(historicalGradeScore(shortlist, id, book.id) ?? assessBook(source, book).score));
      report.field('Temas B1 / B2 / B3 / B4', workload.bimesters.map(value => value ?? 'Pendiente').join(' / '));
      report.field('Temas anuales únicos / capítulos', `${workload.total ?? 'Pendiente'} / ${workload.chapters.length}`);
      report.field('Fuente y mapeo de la carga', `${book.workloadSource || 'Pendiente'}; ${book.mappingOrigin === 'school' ? 'distribución propuesta por el colegio' : 'editorial'}`);
      report.field('Consignas verificadas de la muestra base', practice.complete ? `promedio ${number(practice.mean)}; rango ${practice.min}-${practice.max}; n=${practice.size}; no extrapolado` : 'Muestra pendiente');
      for (const sample of practice.samples) report.write(`Tema ${sample.position}: ${sample.topicName}; base ${sample.baseCount ?? 'pendiente'}, cuaderno ${sample.workbookCount ?? 'pendiente'}, opcional ${sample.optionalCount ?? 'pendiente'}; ${sample.workType}; ${sample.evidence}`, { size: 9 });
      report.field('Modalidad de recursos', book.supportKind === 'platform' ? 'Plataforma' : book.supportKind === 'equivalent' ? `Apoyo equivalente sin plataforma; autorizado: ${book.equivalentAuthorized ? 'sí' : 'pendiente'}` : 'Sin apoyo complementario');
      report.field('Acceso docente', resourceDescription(book, 'teacherSupport')); report.field('Acceso estudiante', resourceDescription(book, 'studentSupport'));
      report.field('Opción base', money(basePrice(book))); report.field('Cotización / vigencia', `${book.priceSource} / ${book.priceValidity}`);
      for (const component of book.components) report.write(`${component.optional ? 'EXTRA OPCIONAL' : 'INCLUIDO'}: ${component.name}; cantidad ${component.quantity}; ${component.unitPrice === null ? 'sin desglose unitario' : money(component.unitPrice)}`, { size: 9 });
      report.field('Apreciación pedagógica del portavoz', shortlist?.statement);
      report.field('Limitaciones prácticas / viabilidad', `${book.workloadNote || 'Pendiente de registrar'}; ${book.supportNote || 'Sin observación adicional'}`);
    }
  }
  report.blank('Constancia de tiempo para revisión física (fecha, hora y responsable)'); return report.finish();
}

export async function buildShortlistPdf(state: State, shortlistId: string, options: ReportOptions = {}): Promise<Uint8Array> {
  const shortlist = state.shortlists.find(item => item.id === shortlistId); if (!shortlist) throw new Error('No se encontró la versión de terna.');
  const report = await new PrintedReport(state, 'Constancia de terna técnica', 'TERNA TÉCNICA - diferente del acuerdo final por votación familiar', options).initialize();
  report.field('Categoría / ámbito', `${shortlist.categoryId} / ${shortlist.scope === 'block' ? 'bloque común' : 'específica por grado'}`);
  report.field('Grados 2027', shortlist.gradeIds.map(gradeName).join(', ')); report.field('Versión / estado / reglas utilizadas', `${shortlist.version} / ${shortlist.status} / ${shortlist.rulesVersion}`);
  report.field('Folio / publicación', `${shortlist.folio} / ${date(shortlist.publishedAt)}`); report.field('Validación de Dirección', shortlist.directorApproved ? 'Registrada; firma formal pendiente en este documento' : 'Pendiente');
  const source = stateFromShortlist(state, shortlist);
  shortlist.offerIds.forEach((id, index) => { report.heading(`${index + 1}. ${offerName(source, id)}`); const assessment = historicalAssessment(shortlist, id); report.field('Puntaje histórico por bloque', assessment === null ? 'Conservar y consultar el snapshot histórico de la terna' : number(assessment)); for (const grade of shortlist.gradeIds) { const book = source.books.find(book => book.offerId === id && book.gradeId === grade); if (book) report.write(`${gradeName(grade)}: ${book.title}; edición ${book.edition}`); } });
  report.field('Apreciación general del portavoz', shortlist.statement); report.field('Motivo / acuerdo documentado', shortlist.reason);
  report.field('Incidencia art. 11.3', shortlist.article113 ? 'Acuerdo excepcional documentado; consultar folio' : 'No registrada para esta terna');
  report.write('Los puntajes originales se conservan. El orden técnico no reemplaza la elección de las familias por grado y área.');
  report.signatures(); return report.finish();
}

function stateFromShortlist(state: State, shortlist: Shortlist | undefined): State {
  const saved = shortlist?.snapshot as Partial<State> & { rules?: State['settings']['rules'] } | null;
  if (!saved || !Array.isArray(saved.books)) return state;
  return { ...state, books: saved.books, offers: saved.offers ?? state.offers, publishers: saved.publishers ?? state.publishers, series: saved.series ?? state.series, settings: { ...state.settings, rules: saved.rules ?? state.settings.rules } };
}
function historicalGradeScore(shortlist: Shortlist | undefined, offerId: string, bookId: string): number | null {
  type Ranked = {offerId:string; grades?:{bookId:string;score:number|null}[]};
  const saved = shortlist?.snapshot as { ranked?:Ranked[]; assessment?:{ranked?:Ranked[]} } | null;
  return (saved?.ranked ?? saved?.assessment?.ranked)?.find(item => item.offerId === offerId)?.grades?.find(item => item.bookId === bookId)?.score ?? null;
}

function historicalAssessment(shortlist: Shortlist, id: string): number | null {
  const snapshot = shortlist.snapshot as { ranked?: { offerId: string; score: number | null }[]; assessment?: { ranked?: { offerId: string; score: number | null }[] } } | null;
  return snapshot?.ranked?.find(item => item.offerId === id)?.score ?? snapshot?.assessment?.ranked?.find(item => item.offerId === id)?.score ?? null;
}

export async function buildMinutesPdf(state: State, roundId: string, options: ReportOptions = {}): Promise<Uint8Array> {
  const round = findRound(state, roundId); if (round.status !== 'closed') throw new Error('El acta final requiere una ronda cerrada.');
  const report = await new PrintedReport(state, 'Acta de elección por grado y área', 'RESULTADOS AGREGADOS - sin identidad ni sentido del voto individual', options).initialize();
  report.field('Jornada', state.settings.title); report.field('Sede / responsables', `${state.settings.venue} / ${state.settings.organizers}`);
  report.field('Grado 2027 / ronda / modalidad', `${gradeName(round.gradeId)} / ${round.number} / ${round.mode === 'paper' ? 'Papel' : 'Digital anónimo'}`);
  report.field('Apertura / cierre (Huaraz)', `${date(round.openedAt)} / ${date(round.closedAt)}`);
  report.field('Cédulas entregadas / depositadas', `${round.delivered} / ${round.deposited}`);
  report.field('Representación mínima / revisión física', `${round.minimumRequired} / ${round.physicalReviewConfirmed ? 'tiempo confirmado' : 'pendiente'}`);
  for (const area of round.areas) {
    report.heading(AREAS.find(item => item.id === area)?.label ?? area); const counts = round.counts[area]; const result = round.results[area];
    const shortlist = state.shortlists.find(item => item.id === round.shortlistIds[area]); report.field('Terna / versión / reglas / folio', shortlist ? `${shortlist.categoryId} / ${shortlist.version} / ${shortlist.rulesVersion} / ${shortlist.folio}` : 'Pendiente');
    if (shortlist?.reason) report.field('Acuerdo específico / incidencia de la terna', shortlist.reason);
    for (const id of round.options[area] ?? []) report.field(offerName(state, id), counts?.options[id] ?? 0);
    report.field('Votos blancos', counts?.blank ?? 'Pendiente'); report.field('Votos nulos', counts?.invalid ?? 'Pendiente');
    const sum = counts ? Object.values(counts.options).reduce((sum, value) => sum + value, 0) + counts.blank + counts.invalid : null;
    report.field('Conciliación del área', sum === round.deposited ? `${sum} = ${round.deposited} depositadas` : `Pendiente / inconsistente (${sum ?? '?'})`);
    const labels: Record<string, string> = { winner: 'Ganador por voto familiar', tie: 'Empate; requiere segunda vuelta de esta área', no_valid_votes: 'Sin votos válidos; no hay ganador', insufficient_representation: 'Representación insuficiente; no hay ganador', pending: 'Pendiente' };
    report.field('Resultado', labels[result?.state ?? 'pending']);
    if (result?.state === 'winner' && result.winnerId) {
      report.field('Editorial / serie elegida', offerName(state, result.winnerId));
      const book = state.books.find(book => book.offerId === result.winnerId && book.gradeId === round.gradeId);
      report.field('Título / edición / precio base', book ? `${book.title} / ${book.edition} / ${money(basePrice(book))}` : 'Consultar expediente');
    } else if (result?.tiedIds.length) report.field('Alternativas empatadas', result.tiedIds.map(id => offerName(state, id)).join('; '));
    if (result?.state !== 'winner') report.write('No se sustituye la decisión familiar por el primer puesto técnico. El resultado sigue el procedimiento documentado.');
  }
  report.heading('Incidencias y acuerdos');
  const references = [round.id, round.gradeId, ...Object.values(round.shortlistIds), ...Object.values(round.shortlistIds).map(id => state.shortlists.find(item => item.id === id)?.categoryId)];
  const incidents = state.incidents.filter(item => references.includes(item.referenceId) || item.scope === 'general' || item.scope === 'jornada');
  if (!incidents.length) report.write('Sin incidencias vinculadas a esta ronda registradas en el sistema.');
  incidents.forEach(item => report.write(`Folio ${item.folio || 'pendiente'}: ${item.description}; resolución: ${item.resolution || 'pendiente'}`));
  report.field('Conciliación documentada de respaldo / ronda', round.reconciliationReason); report.blank('Observaciones del acuerdo y documentos anexos'); report.signatures(); return report.finish();
}

export async function buildPrivateWorkbook(state: State): Promise<Uint8Array> {
  const { default: ExcelJS } = await import('exceljs'); const workbook = new ExcelJS.Workbook(); workbook.creator = 'Selección de textos escolares 2027';
  const sheet = (name: string, headers: string[], rows: unknown[][]) => {
    const result = workbook.addWorksheet(name); result.addRow(headers); rows.forEach(row => result.addRow(row)); result.getRow(1).font = { bold: true };
    result.columns.forEach(column => { column.width = 24; }); result.views = [{ state: 'frozen', ySplit: 1 }];
  };
  sheet('LEEME PRIVADO', ['Documento', 'Alcance'], [['EXPORTACIÓN INTERNA', 'Contiene docentes y observaciones privadas. Conservar con acceso restringido.'], ['Flujo vigente', 'Exposiciones PRIVADAS conserva la escala de cada ficha: vigente 0-4, máximo 40, nota = suma x 2.5. Las fichas históricas 0-2 conservan su máximo 20 y su nota original; no se mezclan con los promedios vigentes. Un 0 explícito aporta cero; solo null permanece pendiente. Docentes registrados conserva sus perfiles.'], ['Archivos históricos', 'Titulos y precios, Evaluaciones PRIVADAS y Ternas versiones conservan el procedimiento histórico por libro y grado; no son las notas vigentes de exposición.'], ['Privacidad del voto', 'El padrón no contiene opciones marcadas ni vínculo con el sentido del voto.'], ['Reglas vigentes', JSON.stringify(state.settings.rules)], ['Versión de estado', state.version]]);
  sheet('Docentes registrados', ['Docente', 'Nombres', 'Apellidos', 'Área', 'Categorías', 'Registro directo', 'Versión'], state.teachers.map(teacher => [teacher.name, teacher.firstNames ?? '', teacher.lastNames ?? '', teacher.area ?? '', (teacher.categories ?? []).join(', '), teacher.selfRegistered ? 'Sí' : 'No / histórico', teacher.version]));
  sheet('Exposiciones PRIVADAS', ['Docente', 'Editorial', 'Área', 'Categoría', 'Estado', 'Escala máxima', 'Suma', 'Máximo', 'Uso de la escala', 'I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10', 'Nota /100', 'Observaciones propias', 'Observación general', 'Ejemplar físico', 'Cierre', 'Reglas', 'Versión ficha'], (state.presentationEvaluations ?? []).map(evaluation => {
    const maximum = presentationEvaluationScaleMax(evaluation); const score = presentationScore(evaluation);
    const rawTotal = score === null ? null : evaluation.scores.reduce<number>((sum, value) => sum + value!, 0);
    return [state.teachers.find(teacher => teacher.id === evaluation.teacherId)?.name, state.publishers.find(publisher => publisher.id === evaluation.publisherId)?.name, evaluation.area, evaluation.block, evaluation.status,
      maximum, rawTotal, 10 * maximum, maximum === 4 ? 'Vigente 0-4' : 'Histórica 0-2: pendiente actualizar escala', ...evaluation.scores, score,
      evaluation.notes.map((note, index) => note ? `I${index + 1}: ${note}` : '').filter(Boolean).join('\n'), evaluation.generalObservation, evaluation.physicalText, evaluation.closedAt, evaluation.rulesVersion, evaluation.version];
  }));
  sheet('Resumen exposiciones', ['Área', 'Categoría', 'Editorial', 'Registrados', 'Cerrados', 'Pendientes', 'Promedio /100', 'I2 promedio', 'Estado', 'Escala máxima', 'Máximo individual', 'Pendientes de actualizar escala'], presentationSummary(state).flatMap(category => category.ranked.map(item => [category.area, category.block, state.publishers.find(publisher => publisher.id === item.publisherId)?.name, item.registered, item.closed, item.pending, item.score, item.i2, item.state, 4, 40, item.pendingScaleUpdate ?? 0])));
  sheet('Ternas de exposicion', ['Área', 'Categoría', 'Versión', 'Estado', 'Editoriales', 'Folio', 'Apreciación', 'Publicación', 'Reglas', 'Escala máxima', 'Máximo individual'], (state.presentationShortlists ?? []).map(shortlist => [shortlist.area, shortlist.block, shortlist.version, shortlist.status, shortlist.publisherIds.map(id => shortlist.snapshot.publishers.find(publisher => publisher.id === id)?.name ?? id).join('; '), shortlist.folio, shortlist.statement, shortlist.publishedAt, shortlist.rulesVersion, shortlist.snapshot.scaleMax ?? 2, 10 * (shortlist.snapshot.scaleMax ?? 2)]));
  sheet('Titulos y precios', ['Código', 'Título', 'Edición', 'Grado 2027', 'Editorial / serie', 'Base S/', 'Fuente precio', 'Vigencia', 'Verificación', 'Versión'], state.books.map(book => [book.code, book.title, book.edition, gradeName(book.gradeId), offerName(state, book.offerId), basePrice(book), book.priceSource, book.priceValidity, book.priceStatus, book.version]));
  sheet('Evaluaciones PRIVADAS', ['Docente', 'Título', 'Grado', 'Estado', 'I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10', 'Nota /100', 'Evidencias', 'Observaciones', 'Objeción', 'Reglas', 'Versión expediente', 'Versión ficha'], state.evaluations.map(evaluation => [state.teachers.find(teacher => teacher.id === evaluation.teacherId)?.name, state.books.find(book => book.id === evaluation.bookId)?.title, state.books.find(book => book.id === evaluation.bookId)?.gradeId, evaluation.status, ...evaluation.scores, scoreEvaluation(evaluation), evaluation.evidence.join('\n'), evaluation.notes.join('\n'), evaluation.objectionDetail, evaluation.rulesVersion, evaluation.bookVersion, evaluation.version]));
  sheet('Padron PRIVADO', ['Sección origen', 'Grado 2026', 'Grado 2027', 'Representante', 'Titular / suplente', 'Acreditación', 'Evidencia'], state.sections.map(section => [section.label, section.sourceGrade, gradeName(section.gradeId), section.representative, section.replacement ? 'Suplente' : 'Titular', section.accredited ? 'Acreditado' : 'Pendiente', section.accreditationEvidence]));
  sheet('Resultados agregados', ['Grado', 'Ronda', 'Modalidad', 'Área', 'Alternativa', 'Votos', 'Blancos', 'Nulos', 'Depositadas', 'Resultado', 'Ganador'], state.rounds.filter(round => round.status === 'closed').flatMap(round => round.areas.flatMap(area => (round.options[area] ?? []).map(id => [gradeName(round.gradeId), round.number, round.mode, area, offerName(state, id), round.counts[area]?.options[id] ?? 0, round.counts[area]?.blank, round.counts[area]?.invalid, round.deposited, round.results[area]?.state, round.results[area]?.winnerId ? offerName(state, round.results[area]!.winnerId!) : 'Sin ganador']))));
  sheet('Ternas versiones', ['Categoría', 'Ámbito', 'Grados', 'Versión', 'Estado', 'Series', 'Folio', 'Apreciación', 'Reglas'], state.shortlists.map(shortlist => [shortlist.categoryId, shortlist.scope, shortlist.gradeIds.join(', '), shortlist.version, shortlist.status, shortlist.offerIds.map(id => offerName(state, id)).join('; '), shortlist.folio, shortlist.statement, shortlist.rulesVersion]));
  sheet('Incidencias', ['Ámbito', 'Referencia', 'Descripción', 'Resolución', 'Folio', 'Fecha'], state.incidents.map(incident => [incident.scope, incident.referenceId, incident.description, incident.resolution, incident.folio, incident.createdAt]));
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export function downloadBytes(bytes: Uint8Array | string, fileName: string, type: string) {
  const content = typeof bytes === 'string' ? bytes : new Uint8Array(bytes).buffer;
  const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement('a'); link.href = url; link.download = fileName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
