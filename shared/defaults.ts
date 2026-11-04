import type { Book, Evaluation, GradeId, Offer, PresentationEvaluation, PresentationScore, Score, State, SupportProfile } from './types.js';
import { AREAS, BLOCKS, CHECKS, GRADES, samplePositions } from './domain.js';
import { presentationPublisherAvailable } from './presentation.js';

/** Nothing announced by a publisher is silently treated as verified. */
export function defaultSupportProfile(): SupportProfile {
  return {
    access: '', devices: '', connection: '', mobile: '', offline: '', validity: '',
    included: false, extraCost: null, renewal: '', support: '', action: '', evidence: '',
    testedAt: '', status: 'pending',
  };
}

export function defaultBook(overrides: Partial<Book> = {}): Book {
  return {
    id: '', version: 1, code: '', offerId: '', gradeId: 'PRI1', title: '', edition: '', authors: '',
    active: true, obnate: '', obnateSource: '', ministerialReference: '',
    checks: CHECKS.map(() => ({ status: 'pending', evidence: '', note: '' })),
    sampleTable: '', sampleQuantity: 0, familyAvailability: '', components: [],
    declaredBasePrice: null, priceSource: '', priceValidity: '', priceStatus: 'pending',
    workloadMode: 'quick', bimesters: [null, null, null, null], chapters: [], topics: [],
    workloadSource: '', mappingOrigin: 'editorial', workloadStatus: 'pending', workloadNote: '', availableWeeks: null,
    practice: [], practiceStatus: 'pending', supportKind: 'none', equivalentAuthorized: false,
    supportStatus: 'pending', supportNote: '', teacherSupport: defaultSupportProfile(),
    studentSupport: defaultSupportProfile(), dossierClosed: false, dossierReference: '',
    ...overrides,
  };
}

export function emptyState(): State {
  return {
    schemaVersion: 1, version: 1,
    settings: {
      version: 1, school: 'I.E.P. Albert Einstein', title: 'Selección de textos escolares 2027',
      eventAt: '2026-11-05T17:00:00-05:00', timezone: 'America/Lima',
      venue: 'Sede 2 · Jr. Augusto B. Leguía N.º 246, Nicrupampa, Huaraz',
      organizers: 'Subdirección Académica', editorsWithdrawn: false, withdrawalReference: '', directorName: '',
      evaluationMode: 'presentation', presentationScaleMax: 4,
      rules: {
        version: 1, threshold: 70, teacherCount: 2, indicatorCount: 10,
        presentationSeconds: 600, transitionSeconds: 120,
        representationMode: 'count', minimumRepresentation: null,
        practiceGuidelines: {}, lockedAt: null,
      },
    },
    publishers: [], series: [], offers: [], books: [], teachers: [], assignments: [], evaluations: [], reviews: [],
    presentationEvaluations: [], presentationShortlists: [],
    turn: { publisherId: null, status: 'ready', startedAt: null, pausedAt: null, pausedMilliseconds: 0 },
    shortlists: [], sections: [], deliveries: [], rounds: [], incidents: [], audit: [],
  };
}

/** Synthetic data lives only in its own dataset; the real dataset is emptyState(). */
export function demoState(): State {
  const state = emptyState();
  const at = '2026-11-04T15:00:00.000Z';
  state.settings.rules.presentationSeconds = 60;
  state.settings.rules.transitionSeconds = 12;
  state.settings.rules.minimumRepresentation = 1;
  state.settings.rules.lockedAt = at;
  state.settings.directorName = 'Dirección · demostración';
  for (const area of AREAS) for (const grade of GRADES) {
    state.settings.rules.practiceGuidelines[`${area.id}-${grade.id}`] = 'PAUTA FICTICIA: contrastar con 32 semanas; práctica guiada y una tarea autónoma apropiada, distribuida entre temas. La cantidad por sí sola no determina suficiencia.';
  }
  const names = ['Horizonte', 'Senderos', 'Aula Abierta', 'Raíces', 'Nueva Mirada', 'Aprender', 'Andes', 'Puentes', 'Pizarra', 'Décima Editorial'];
  state.publishers = names.map((name, index) => ({
    id: `demo-publisher-${index + 1}`, version: 1, name: `${name} · FICTICIA`, samplesReceived: index < 5,
    sampleNote: index < 5 ? 'Ejemplares sintéticos en la mesa de demostración.' : 'Sin muestra registrada; editorial ficticia para probar más de nueve.',
  }));
  state.teachers = [
    { id: 'demo-teacher-1', version: 1, name: 'Docente Ana · DEMO', firstNames: 'Ana', lastNames: 'Demostración', area: 'MAT', categories: ['P1', 'P2', 'S1'], selfRegistered: true, attended: true, attendanceEvidence: 'Asistencia ficticia D-01' },
    { id: 'demo-teacher-2', version: 1, name: 'Docente Luis · DEMO', firstNames: 'Luis', lastNames: 'Demostración', area: 'MAT', categories: ['P1', 'P2', 'S1'], selfRegistered: true, attended: true, attendanceEvidence: 'Asistencia ficticia D-02' },
  ];
  const scoreArray = (total: number): Score[] => {
    let remaining = total;
    return Array.from({ length: 10 }, () => { const value = Math.min(2, remaining) as Score; remaining -= value!; return value; });
  };
  const presentationScoreArray = (percentage: number): PresentationScore[] => {
    let remaining = percentage / 2.5;
    return Array.from({ length: 10 }, () => { const value = Math.min(4, remaining) as PresentationScore; remaining -= value!; return value; });
  };
  function addBook(offer: Offer, gradeId: GradeId, total: number, pending = false): void {
    const grade = GRADES.find(item => item.id === gradeId)!;
    const area = AREAS.find(item => item.id === offer.area)!;
    const book = defaultBook({
      id: `${offer.id}-${gradeId}`, code: `${offer.id}-${gradeId}`, offerId: offer.id, gradeId,
      title: `${state.series.find(item => item.id === offer.seriesId)!.name}: ${area.label} ${grade.label}`,
      edition: offer.edition, authors: 'Equipo ficticio de demostración',
      obnate: 'DEMO · sin registro real', obnateSource: 'Registro SIMULADO para prueba; no acredita verificación oficial.',
      ministerialReference: 'Ficha ministerial DEMO-01; datos ficticios',
      checks: CHECKS.map(() => ({ status: 'pass', evidence: 'Comité ficticio · ficha DEMO-01', note: 'Dato de demostración.' })),
      sampleTable: `Mesa ${grade.number}`, sampleQuantity: 2, familyAvailability: 'Disponible para la prueba general.',
      components: [
        { id: 'text', name: 'Texto reutilizable', kind: 'text', quantity: 1, unitPrice: null, optional: false },
        { id: 'workbook', name: 'Cuaderno incluido', kind: 'workbook', quantity: 1, unitPrice: null, optional: false },
        { id: 'optional', name: 'Taller opcional', kind: 'other', quantity: 1, unitPrice: 20, optional: true },
      ],
      declaredBasePrice: 98 + grade.number * 3, priceSource: 'Cotización conjunta ficticia DEMO-2027; sin desglose por componente.',
      priceValidity: '2027-03-31', priceStatus: 'verified', workloadMode: 'detailed',
      bimesters: [4, 3, 5, 4], chapters: [1, 2, 3, 4].map(chapter => ({ name: `Unidad ${chapter}`, topicCount: 4, source: 'Índice ficticio, pp. 2–3' })),
      topics: Array.from({ length: 16 }, (_, index) => ({
        id: `topic-${index + 1}`, code: `T${index + 1}`, order: index + 1,
        chapter: `Unidad ${Math.floor(index / 4) + 1}`, bimester: index < 4 ? 1 : index < 7 ? 2 : index < 12 ? 3 : 4,
        name: `Tema de demostración ${index + 1}`, pages: String(index * 6 + 4),
      })),
      workloadSource: 'Índice ficticio, pp. 2–3', workloadStatus: 'verified', availableWeeks: 32,
      practiceStatus: 'verified', supportKind: 'equivalent', equivalentAuthorized: true, supportStatus: 'verified',
      supportNote: 'Guía impresa docente y tarjetas autónomas incluidas, autorizadas antes de la prueba. No incluye plataforma.',
      dossierClosed: true, dossierReference: `Expediente ficticio ${offer.id}/${gradeId}`,
    });
    const profile: SupportProfile = {
      access: 'Material impreso incluido en el paquete base.', devices: 'No aplica: material impreso.', connection: 'No requiere conexión.',
      mobile: 'No aplica: material impreso.', offline: 'Sí, material impreso.', validity: 'Sin vencimiento del ejemplar impreso.',
      included: true, extraCost: 0, renewal: 'No aplica: sin licencia.', support: 'Guía de uso impresa, p. 1.',
      action: 'Localizó y utilizó una guía para planificar la tarea de la unidad 1.', evidence: 'Demostración ficticia, folio D-03.', testedAt: at, status: 'verified',
    };
    book.teacherSupport = { ...profile };
    book.studentSupport = { ...profile, action: 'Realizó de forma autónoma la actividad de la unidad 1 y consultó su retroalimentación.' };
    book.practice = samplePositions(16).map((position, index) => ({
      topicId: `topic-${position}`, topicName: `Tema de demostración ${position}`, position,
      pages: String((position - 1) * 6 + 4), baseCount: [8, 12, 10][index], workbookCount: 4, optionalCount: 5,
      verified: true, evidence: `Conteo ficticio de consignas independientes, folio D-${position}.`, workType: 'Problema y práctica guiada',
    }));
    state.books.push(book);
    state.teachers.forEach((teacher, index) => {
      const assignment = { id: `${book.id}-assignment-${index + 1}`, version: 1, bookId: book.id, teacherId: teacher.id, kind: 'initial' as const };
      state.assignments.push(assignment);
      const evaluation: Evaluation = {
        id: `${assignment.id}-evaluation`, version: 1, assignmentId: assignment.id, bookId: book.id, teacherId: teacher.id,
        bookVersion: 1, rulesVersion: 1, scores: scoreArray(total), evidence: Array.from({ length: 10 }, (_, item) => `Evidencia ficticia I${item + 1}, pp. 4–10; expediente compartido.`),
        notes: Array(10).fill(''), objection: false, objectionDetail: '', status: pending ? 'draft' : 'closed',
        closedAt: pending ? null : at, updatedAt: at,
      };
      if (pending) { evaluation.scores = Array(10).fill(null); evaluation.evidence = Array(10).fill(''); }
      state.evaluations.push(evaluation);
    });
  }
  for (let index = 0; index < 3; index += 1) {
    const series = { id: `demo-series-${index + 1}`, version: 1, publisherId: state.publishers[index].id, name: ['Exploramos', 'Construimos', 'Descubrimos'][index] };
    state.series.push(series);
    for (const area of AREAS) for (const block of BLOCKS) {
      const offer: Offer = { id: `${series.id}-${area.id}-${block.id}`, version: 1, seriesId: series.id, area: area.id, block: block.id,
        edition: '2027 · DEMO', status: 'offered', withdrawalReason: '' };
      state.offers.push(offer);
      for (const grade of block.gradeIds) addBook(offer, grade, [18, 17, 16][index]);
    }
  }
  const secondSeries = { id: 'demo-series-4', version: 1, publisherId: state.publishers[0].id, name: 'Exploramos Plus · otra serie' };
  state.series.push(secondSeries);
  const pendingOffer: Offer = { id: 'demo-series-4-MAT-P1', version: 1, seriesId: secondSeries.id, area: 'MAT', block: 'P1', edition: '2027 · DEMO', status: 'offered', withdrawalReason: '' };
  state.offers.push(pendingOffer);
  addBook(pendingOffer, 'PRI1', 16, true);
  addBook(pendingOffer, 'PRI2', 16);
  const partialSeries = { id: 'demo-series-5', version: 1, publisherId: state.publishers[3].id, name: 'Raíces · oferta parcial' };
  state.series.push(partialSeries);
  const partialOffer: Offer = { id: 'demo-series-5-COM-S1', version: 1, seriesId: partialSeries.id, area: 'COM', block: 'S1', edition: '2027 · DEMO', status: 'offered', withdrawalReason: '' };
  state.offers.push(partialOffer);
  addBook(partialOffer, 'SEC1', 17);
  addBook(partialOffer, 'SEC2', 17);
  for (const grade of GRADES) for (let section = 0; section < 4; section += 1) {
    const source = grade.id === 'PRI1' ? 'INI5' : grade.id === 'SEC1' ? 'PRI6'
      : `${grade.id.startsWith('PRI') ? 'PRI' : 'SEC'}${grade.number - 1}`;
    state.sections.push({ id: `demo-section-${grade.id}-${section + 1}`, version: 1,
      label: `${source} ${String.fromCharCode(65 + section)}`, sourceGrade: source, gradeId: grade.id,
      representative: `Representante ficticio ${grade.id}-${section + 1}`, replacement: false,
      accredited: true, accreditationEvidence: 'Acreditación ficticia de la prueba general.' });
  }
  state.turn.publisherId = state.publishers[0].id;
  // Keep the historical two-assignment demonstration intact. Live forms are separately
  // authored by five registered teachers and never copied from those historical grades.
  for (const [index, name] of ['Elena', 'José', 'Rosa'].entries()) {
    state.teachers.push({ id: `demo-teacher-${index + 3}`, version: 1, name: `Docente ${name} · DEMO`,
      firstNames: name, lastNames: 'Demostración', area: 'MAT', categories: ['P1', 'P2', 'S1'],
      selfRegistered: true, attended: true, attendanceEvidence: 'Registro ficticio para la exposición en vivo.' });
  }
  state.presentationQuestions = state.publishers.map(publisher => ({
    id: `demo-question-${publisher.id}`, version: 1, publisherId: publisher.id,
    representativeName: 'Representante docente · DEMOSTRACIÓN', area: 'MAT',
    question: 'Pregunta ficticia: ¿cómo apoya la propuesta a estudiantes con diferentes ritmos de aprendizaje?',
    answer: 'Respuesta ficticia: el material incluye orientaciones y actividades de refuerzo y profundización.',
    status: 'answered', askedAt: at, answeredAt: at, updatedAt: at,
  }));
  for (const [publisherIndex, publisher] of state.publishers.entries()) for (const block of BLOCKS) {
    if (!presentationPublisherAvailable(state, publisher.id, 'MAT', block.id)) continue;
    for (const [teacherIndex, teacher] of state.teachers.entries()) {
      const evaluation: PresentationEvaluation = {
        id: `demo-presentation-${publisher.id}-${block.id}-${teacher.id}`, version: 1,
        publisherId: publisher.id, teacherId: teacher.id, area: 'MAT', block: block.id,
        scaleMax: 4, rubricVersion: 2, responseScore: publisherIndex < 3 ? [4, 3, 2][publisherIndex] as PresentationScore : 1, questionVersion: 1, scores: presentationScoreArray(publisherIndex < 3 ? [90, 85, 80][publisherIndex] : 60),
        notes: Array.from({ length: 10 }, (_, indicator) => indicator === 1 && teacherIndex === 0
          ? 'Observación ficticia: explicó una situación y la contrastó con la actividad del ejemplar.' : ''),
        generalObservation: 'Ficha sintética de exposición en vivo; no constituye una recomendación real.',
        physicalText: 'Ejemplar ficticio en la mesa de demostración', materialViewed: true,
        status: 'closed', closedAt: at, updatedAt: at, rulesVersion: state.settings.rules.version,
      };
      state.presentationEvaluations.push(evaluation);
    }
  }
  return state;
}
