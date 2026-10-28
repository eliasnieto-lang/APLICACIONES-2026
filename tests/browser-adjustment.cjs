const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const { makeCompactPdf } = require('./compact-report-fixture.cjs');

// Acceptance of the I–III / confirmed-report workflow in the portable edition.
// npm run build:web && node tests/browser-adjustment.cjs
// A temporary static server exposes only web/index.html. All data is fictitious,
// all mutations use the UI, and all operations after loading run offline.
const root = path.resolve(__dirname, '..');
const chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(check, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`No se confirmó: ${label}`);
}

// Genuine one-page native PDFs with optional identity and three explicit cells
// per competency. No parser/API is mocked.
function makePdf(settings, { code, name, grade, section = 'F', grades = ['C', 'B', 'A'], identityLayout = 'inline', omitArea = '' }) {
  const clean = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[()\\]/g, '\\$&');
  const lines = identityLayout === 'none' ? ['BIMESTRES I II III'] : identityLayout === 'classroom' ? [`Grado: ${grade}`, `Seccion: ${section}`, 'BIMESTRES I II III'] : identityLayout === 'stacked'
    ? ['INFORME DE PROGRESO DEL ESTUDIANTE', 'Codigo modular: 1234567', 'Codigo del estudiante', code, 'Apellidos y nombres del estudiante', name, 'Grado', String(grade), 'Seccion', section, 'Periodo: 2026', 'BIMESTRES I II III']
    : [`Codigo del estudiante: ${code}`, `Apellidos y nombres: ${name}`, `Grado: ${grade}`, `Seccion: ${section}`, 'Periodo: 2026', 'BIMESTRES I II III'];
  for (const area of settings.areas.filter(area => area.id !== omitArea)) lines.push(area.name, ...area.competencies.map(competency => `${competency} ${grades.join(' ')}`));
  const stream = `BT /F1 8 Tf 35 800 Td 13 TL ${lines.map((line, index) => `${index ? 'T* ' : ''}(${clean(line)}) Tj`).join('\n')} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let result = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

// A genuine mixed document: the only identity is in the JPEG header, while
// competency labels and all three grade columns remain native selectable text.
function makeMixedPdf(settings, headerImage, imageWidth, imageHeight) {
  const clean = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[()\\]/g, '\\$&');
  const lines = ['BIMESTRES I II III'];
  for (const area of settings.areas) lines.push(area.name, ...area.competencies.map(competency => `${competency} AD B C`));
  const stream = `q 540 0 0 ${540 * imageHeight / imageWidth} 35 685 cm /Header Do Q\nBT /F1 8 Tf 35 665 Td 13 TL ${lines.map((line, index) => `${index ? 'T* ' : ''}(${clean(line)}) Tj`).join('\n')} ET`;
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> /XObject << /Header 6 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${headerImage.length} >>\nstream\n`), headerImage, Buffer.from('\nendstream')]),
  ];
  const parts = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let length = parts[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const part = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    parts.push(part); length += part.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

(async () => {
  const { SUPPLEMENTAL_REPORT_AREAS } = await import('../shared/report-catalog.ts');
  const artifact = await fs.readFile(path.join(root, 'web/index.html'));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'circulos-adjustment-'));
  const profile = path.join(directory, 'profile');
  const errors = [];
  const consoleErrors = [];
  const requests = [];
  const operationHttpRequests = [];
  let operationsStarted = false;
  let downloads = 0;
  let server;
  let context;
  let page;
  let appUrl = process.env.APP_WEB_URL;

  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, { executablePath: chromiumPath, headless: true, viewport: { width: 1440, height: 1100 }, acceptDownloads: true, args: ['--no-sandbox'] });
    context.on('request', request => {
      const record = { url: request.url(), method: request.method(), type: request.resourceType() };
      requests.push(record);
      if (operationsStarted && /^https?:/.test(record.url)) operationHttpRequests.push(record);
    });
    page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  };
  const load = async () => {
    operationsStarted = false;
    await context.setOffline(false);
    await page.goto(appUrl);
    await page.getByRole('heading', { name: /Una mirada integral al talento/ }).waitFor();
    await page.waitForLoadState('networkidle');
    await context.setOffline(true);
    operationsStarted = true;
  };
  const snapshot = (dataset = 'real') => page.evaluate(dataset => new Promise((resolve, reject) => {
    const open = indexedDB.open('circulos-2027-web', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction(['state', 'files'], 'readonly');
      let state;
      const files = [];
      const request = transaction.objectStore('state').get(dataset);
      request.onsuccess = () => { state = request.result; };
      const cursor = transaction.objectStore('files').openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        if (String(item.key).startsWith(`${dataset}:`)) files.push({ id: String(item.key).slice(dataset.length + 1), size: item.value.size, type: item.value.type });
        item.continue();
      };
      transaction.oncomplete = () => { db.close(); resolve({ state, files }); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  }), dataset);
  const student = async code => (await snapshot()).state.students.find(value => value.code === code);
  const navigate = name => page.locator('.sidebar .nav-item').filter({ hasText: name }).click();
  const openStudent = async (code, name) => {
    await navigate('Estudiantes');
    await page.getByLabel('Filtrar por aula', { exact: true }).selectOption('');
    await page.getByRole('textbox', { name: 'Buscar estudiante' }).fill(name);
    await page.getByRole('button', { name: new RegExp(name) }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
  };
  const tab = name => page.locator('.tab-list').getByRole('button', { name, exact: true });
  const saved = async () => {
    await pause(120);
    await poll(async () => (await page.locator('.detail-save-state').innerText()).includes('Todos los cambios guardados'), 'autoguardado IndexedDB');
  };
  const check = async locator => {
    if (!await locator.isChecked()) {
      await locator.click();
      await poll(() => locator.isChecked(), 'confirmación de casilla');
    }
  };
  const download = async trigger => {
    const [result] = await Promise.all([page.waitForEvent('download'), trigger()]);
    const destination = path.join(directory, `${++downloads}-${result.suggestedFilename()}`);
    await result.saveAs(destination);
    return { name: result.suggestedFilename(), content: await fs.readFile(destination) };
  };
  const backup = async () => JSON.parse((await download(() => page.getByRole('button', { name: 'Descargar copia de seguridad', exact: true }).click())).content.toString());
  const upload = async files => {
    await page.locator('input[type=file][multiple]').first().setInputFiles(files);
    await poll(async () => {
      const rows = await page.locator('.import-queue-row').allTextContents();
      return rows.length === files.length && rows.every(text => text.includes('Procesado'));
    }, `procesamiento nativo de ${files.length} PDF`, 180000);
  };
  const review = async filename => {
    await navigate('Importar libretas');
    const row = page.locator('tr').filter({ has: page.locator('.file-cell strong', { hasText: filename }) });
    await row.getByRole('button', { name: 'Revisar', exact: true }).click();
    const panel = page.locator('.import-review');
    await panel.getByRole('heading', { name: filename, exact: true }).waitFor();
    assert.equal(await panel.getByLabel('Apellidos y nombres', { exact: true }).count(), 1, 'La revisión conserva el nombre reconocido y permite corregir el aula si hace falta.');
    const pending = ['pending', 'review'].includes((await snapshot()).state.pdfs.find(pdf => pdf.name === filename).status);
    if (pending) assert(await panel.getByLabel('Apellidos y nombres', { exact: true }).isEditable(), 'El nombre reconocido se puede corregir antes de confirmar.');
    assert.deepEqual((await panel.getByRole('button').allTextContents()).map(value => value.trim()), ['Confirmar libreta', 'Eliminar libreta'], 'La revisión solo permite confirmar o eliminar.');
    await panel.locator('.import-identity').waitFor();
  };
  const confirm = async (filename, manualName) => {
    await review(filename);
    const nameField = page.locator('.import-review').getByLabel('Apellidos y nombres', { exact: true });
    if (manualName) await nameField.fill(manualName);
    await poll(async () => Boolean((await nameField.inputValue()).trim()), 'nombre visible antes de confirmar', 180000);
    const name = await nameField.inputValue();
    assert(name, 'La confirmación usa el nombre ya visible en la revisión.');
    await page.locator('.import-review').getByRole('button', { name: 'Confirmar libreta', exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await poll(async () => Boolean((await snapshot()).state.students.find(value => value.name === name)?.reportApproval), 'libreta confirmada');
  };
  const deleteImported = async filename => {
    await review(filename);
    const pdfId = (await snapshot()).state.pdfs.find(pdf => pdf.name === filename).id;
    const accepted = page.waitForEvent('dialog').then(dialog => dialog.accept());
    await page.locator('.import-review').getByRole('button', { name: 'Eliminar libreta', exact: true }).click();
    await accepted;
    await poll(async () => !(await snapshot()).state.pdfs.some(pdf => pdf.id === pdfId), 'eliminación de la libreta de aceptación');
  };
  const metric = label => page.locator('.detail-metric').filter({ has: page.locator('span', { hasText: new RegExp(`^${label}$`) }) });
  const dimension = name => page.locator('.detail-score-row').filter({ hasText: name }).locator('strong');
  const startPdfTrace = () => page.evaluate(() => {
    const original = window.fetch;
    window.__pdfUpdateCalls = [];
    window.__restoreFetch = () => { window.fetch = original; };
    window.fetch = function(input, init) {
      if (typeof input === 'string' && init?.method === 'PUT') {
        let body;
        try { body = JSON.parse(init.body); } catch { /* Only observe JSON actions. */ }
        window.__pdfUpdateCalls.push({ url: input, method: init.method, body });
      }
      return original.apply(this, arguments);
    };
  });
  const stopPdfTrace = () => page.evaluate(() => { const calls = window.__pdfUpdateCalls; window.__restoreFetch(); return calls; });
  const assertRescanCalls = (calls, pdfId, count = 1) => assert.deepEqual(calls.filter(call => call.body?.action === 'rescan-grades').map(call => ({ pathname: new URL(call.url, appUrl).pathname, method: call.method, action: call.body.action })), Array.from({ length: count }, () => ({ pathname: `/api/pdfs/${pdfId}`, method: 'PUT', action: 'rescan-grades' })));
  const assertBlankManual = value => {
    assert.deepEqual(value.attendance, { required: null, attended: null, punctual: null, exempted: null, validated: false });
    assert.deepEqual(value.discipline, { confirmed: false, incidents: [] });
    assert.deepEqual(value.institutional, []);
    assert.deepEqual(value.family, []);
    assert.equal(value.validated.performance, false);
    assert.equal(value.validated.commitment, false);
  };
  const setClosed = async closed => {
    await navigate('Parámetros');
    await check(page.getByLabel(closed
      ? 'He revisado los resultados y deseo bloquear los parámetros y los registros. El cierre conservará los datos para consulta y exportación.'
      : 'Confirmo la reapertura para realizar correcciones. Revisaré de nuevo los criterios y los resultados antes de cerrar.'));
    await page.getByRole('button', { name: closed ? 'Cerrar evaluación' : 'Reabrir evaluación', exact: true }).click();
    await poll(async () => (await snapshot()).state.settings.closed === closed, closed ? 'evaluación cerrada' : 'evaluación reabierta');
  };
  // Hold a real browser-backend request to verify that destructive actions wait
  // for an active scanner or autosave. No response or persistence is mocked.
  const holdStudentRequest = (kind, studentId) => page.evaluate(({ kind, studentId }) => {
    const original = window.fetch;
    window.__deleteRequestGate = { held: false, complete: false };
    window.__restoreDeleteRequestGate = () => { window.fetch = original; };
    window.fetch = async function(input, init) {
      let body;
      try { body = JSON.parse(init?.body); } catch { /* Only match JSON student actions. */ }
      const pathname = typeof input === 'string' ? new URL(input, location.href).pathname : '';
      const matches = init?.method === 'PUT' && (kind === 'save'
        ? pathname === `/api/students/${studentId}`
        : /^\/api\/pdfs\//.test(pathname) && body?.action === 'rescan-grades');
      const held = matches && !window.__deleteRequestGate.held;
      if (held) {
        window.__deleteRequestGate.held = true;
        await new Promise(resolve => { window.__releaseDeleteRequestGate = resolve; });
      }
      try { return await original.apply(this, arguments); }
      finally { if (held) window.__deleteRequestGate.complete = true; }
    };
  }, { kind, studentId });
  const releaseStudentRequest = async () => {
    await page.evaluate(() => window.__releaseDeleteRequestGate());
    await poll(() => page.evaluate(() => window.__deleteRequestGate.complete), 'operación pendiente terminada', 180000);
    await page.evaluate(() => window.__restoreDeleteRequestGate());
  };
  const assertEmptyDashboard = async () => {
    await navigate('Panel principal');
    await poll(async () => (await page.locator('.stat-value').allTextContents()).every(value => value === '00'), 'indicadores de evaluación vacía');
    assert.equal(await page.locator('.stat-value').count(), 4);
    assert.equal(await page.locator('.student-table tbody tr').count(), 0);
    await page.getByRole('heading', { name: 'Un nuevo ciclo empieza aquí', exact: true }).waitFor();
  };
  const deletionScreenshot = async (locator, name) => {
    await locator.screenshot({ path: `/tmp/circulos-${name}.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await locator.screenshot({ path: `/tmp/circulos-${name}-narrow.png` });
    await page.setViewportSize({ width: 1440, height: 1100 });
  };

  try {
    if (!appUrl) {
      server = http.createServer((request, response) => {
        if (request.url === '/' || request.url === '/index.html') {
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end(artifact);
        } else if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); }
        else { response.writeHead(404); response.end(); }
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      appUrl = `http://127.0.0.1:${server.address().port}/index.html`;
    }
    await launch();
    await load();
    assert.equal(await page.locator('script[src]').count(), 0, 'El HTML incorpora sus scripts.');
    assert.equal(await page.locator('link[rel=stylesheet]').count(), 0, 'El HTML incorpora sus estilos.');
    assert(await page.locator('img').evaluateAll(images => images.every(image => image.src.startsWith('data:'))), 'Las imágenes viajan dentro del HTML.');
    const initial = await backup();
    assert.equal(initial.state.students.length, 0, 'El perfil temporal no contiene datos institucionales.');
    assert.equal(initial.state.settings.workflowVersion, 2);
    assert.equal(initial.state.settings.progressionComparison, 'first_two_vs_third');
    assert.deepEqual(initial.state.settings.bimesterWeights, { first: 0.25, second: 0.25, third: 0.5 });
    assert.equal(initial.state.settings.academicScoringPolicy, 'weighted_bimesters_common_progression');
    assert.equal(await page.getByRole('button', { name: 'Nuevo estudiante', exact: true }).count(), 0, 'El alta parte de una libreta.');

    await navigate('Parámetros');
    for (const [label, value] of [['Peso del I bimestre', '25 %'], ['Peso del II bimestre', '25 %'], ['Peso del III bimestre', '50 %']]) {
      assert.equal((await page.getByLabel(label, { exact: true }).inputValue()).replace(/\s/g, ''), value.replace(/\s/g, ''));
      assert(await page.getByLabel(label, { exact: true }).getAttribute('readonly') !== null, 'Los pesos seleccionados se muestran sin alterar la regla institucional.');
    }
    await check(page.getByLabel('Confirmo que los pesos, el catálogo y los criterios registrados cuentan con aprobación institucional para esta evaluación.'));
    await page.getByRole('button', { name: 'Guardar parámetros', exact: true }).first().click();
    await poll(async () => (await snapshot()).state.settings.criteriaApproved, 'aprobación de criterios');
    const settings = (await snapshot()).state.settings;
    assert.deepEqual(settings.dimensionWeights, { academic: 0.5, performance: 0.25, commitment: 0.25 });
    const offeredClassrooms = [1, 2, 3, 4, 5].flatMap(grade => ['A', 'B', 'C', 'D', 'E'].map(section => `${grade}.º ${section}`));
    const weightedReference = 63.75 * settings.dimensionWeights.academic + 95.5 * settings.dimensionWeights.performance + 100 * settings.dimensionWeights.commitment;
    const weightedReferencePattern = new RegExp(weightedReference.toFixed(2).replace('.', '[.,]'));
    const pupils = [
      { code: 'AJUSTE-F2-001', name: 'PEREZ RAMOS Lucia Elena', grade: 2 },
      { code: 'AJUSTE-F3-001', name: 'QUISPE TORRES Mateo Andres', grade: 3, identityLayout: 'stacked' },
      { code: 'AJUSTE-F4-001', name: 'ROJAS SALAS Maria Isabel', grade: 4 },
    ];
    const fixtures = [];
    for (let index = 0; index < pupils.length; index++) {
      const destination = path.join(directory, `documento-sin-identidad-${index + 1}.pdf`);
      await fs.writeFile(destination, index === 0 ? makeCompactPdf(settings, pupils[index]) : makePdf(settings, pupils[index]));
      fixtures.push(destination);
    }
    const outside = { code: 'AJUSTE-F6-001', name: 'FUERA DE AULA Estudiante Ficticio', grade: 6 };
    const outsidePath = path.join(directory, 'aula-no-admitida.pdf');
    await fs.writeFile(outsidePath, makePdf(settings, outside));
    await navigate('Importar libretas');
    await upload([...fixtures, outsidePath]);
    let current = await snapshot();
    assert.equal(current.state.pdfs.length, 4);
    assert.equal(current.state.students.length, 3, 'La carga crea solo los estudiantes de aulas admitidas.');
    for (const [index, pupil] of pupils.entries()) {
      const record = current.state.pdfs.find(pdf => pdf.extractedCode === pupil.code);
      assert(record, 'El código se reconoce desde el contenido del PDF.');
      assert.equal(record.extractedName, pupil.name, 'Se conserva el nombre completo.');
      assert.equal(record.status, 'review');
      assert.equal(record.ocr, false);
      assert(record.areas.every(area => area.grades.every(row => row.length === 3 && row.join(',') === 'C,B,A')));
      const provisional = current.state.students.find(value => value.code === pupil.code);
      assert.equal(provisional.name, pupil.name);
      assert.equal(provisional.grade, `${index + 2}.º de secundaria`);
      assert.equal(provisional.section, 'F');
      assert(!provisional.reportApproval);
      assert.equal(provisional.validated.academic, false);
      assertBlankManual(provisional);
    }
    await review(path.basename(outsidePath));
    assert.deepEqual(await page.getByLabel('Aula de la libreta', { exact: true }).locator('option').allTextContents(), ['Seleccionar aula reconocida en el PDF', ...offeredClassrooms], 'La revisión ofrece exactamente25 aulas de primero a quinto, solo secciones A–E.');
    const outsideIdentity = await page.locator('.import-identity').innerText();
    assert(!outsideIdentity.includes(outside.code), 'El ingreso no exige mostrar códigos de estudiante.');
    assert.equal(await page.getByLabel('Apellidos y nombres', { exact: true }).inputValue(), outside.name);
    const outsideCohort = page.locator('.import-identity > div').filter({ has: page.locator('dt', { hasText: /^Grado y sección$/ }) }).locator('dd');
    assert.match(await outsideCohort.innerText(), /^6(?:[.º°\s]*(?:de secundaria)?)?\s+F$/, 'El aula ajena se muestra tal como fue reconocida.');
    assert(await page.locator('.import-review').getByRole('button', { name: 'Confirmar libreta', exact: true }).isDisabled());
    assert(await page.locator('.import-review').getByRole('button', { name: 'Eliminar libreta', exact: true }).isEnabled(), 'Una libreta de aula ajena se puede eliminar.');
    const originalUrl = await page.locator('.import-original iframe').getAttribute('src');
    assert(originalUrl.startsWith('blob:'), 'El original se previsualiza desde el almacenamiento local.');
    assert.equal(await page.evaluate(async value => new TextDecoder().decode((await (await fetch(value)).arrayBuffer()).slice(0, 5)), originalUrl), '%PDF-');

    await openStudent(pupils[0].code, pupils[0].name);
    await page.getByRole('heading', { name: 'Libreta pendiente de confirmación', exact: true }).waitFor();
    for (const name of ['Académico', 'Desempeño', 'Compromiso']) assert(await tab(name).isDisabled(), `${name} permanece cerrado antes de confirmar el PDF.`);
    assert.equal(await page.locator('.grade-select').count(), 0);
    assert.equal(await page.getByLabel('Días lectivos del periodo').count(), 0);
    assert.equal(await dimension('Académico').innerText(), 'Pendiente');

    // Inspect the compact report before confirming: all 45 active notes are
    // already visible, while its separately printed IV column is ignored.
    await review(path.basename(fixtures[0]));
    const preview = page.locator('.import-grade-preview');
    await preview.locator('summary').click();
    assert.deepEqual(await preview.locator('thead th').allTextContents(), ['Área / competencia', 'I', 'II', 'III']);
    assert.equal(await preview.locator('tbody tr').count(), 15);
    const previewNotes = await preview.locator('tbody tr td:not(:first-child)').allTextContents();
    assert.deepEqual(previewNotes, Array.from({ length: 15 }, () => ['C', 'B', 'A']).flat(), 'Las 45 notas aparecen antes de confirmar sin incluir IV.');
    assert.equal(await preview.locator('input, select, textarea, [contenteditable=true]').count(), 0, 'La vista previa muestra las notas sin solicitar transcripción.');
    await page.locator('.import-review').screenshot({ path: '/tmp/circulos-compact-report-review.png' });
    for (const filename of fixtures.map(value => path.basename(value))) await confirm(filename);
    current = await snapshot();
    for (const pupil of pupils) {
      const approved = current.state.students.find(value => value.code === pupil.code);
      assert(approved.reportApproval?.pdfId);
      assert.equal(approved.validated.academic, true, 'La confirmación completa A automáticamente.');
      assert(approved.academic.every(area => area.validated && area.grades.every(row => row.length === 3 && row.join(',') === 'C,B,A')));
      assertBlankManual(approved);
    }
    await navigate('Estudiantes');
    assert.deepEqual(await page.getByLabel('Filtrar por aula').locator('option').allTextContents(), ['Todas las aulas'], 'Las secciones antiguas F se conservan en Todas las aulas sin ofrecerse como filtro nuevo.');
    await openStudent(pupils[0].code, pupils[0].name);
    for (const name of ['Académico', 'Desempeño', 'Compromiso']) assert(await tab(name).isEnabled());
    await tab('Académico').click();
    const cells = page.locator('.grade-select');
    assert.equal(await cells.count(), settings.areas.reduce((sum, area) => sum + area.competencies.length * 3, 0));
    const gradeHeaders = await page.locator('.academic-table').first().locator('thead th').allTextContents();
    assert.equal(gradeHeaders[0], 'Competencia');
    for (const [index, bimester, weight] of [[1, 'I', 25], [2, 'II', 25], [3, 'III', 50]]) { assert(gradeHeaders[index].startsWith(`${bimester} bim.`)); assert(gradeHeaders[index].replace(/\s/g, '').endsWith(`${weight}%`)); }
    assert.deepEqual(await cells.allTextContents(), previewNotes, 'A conserva las 45 notas que se mostraron antes de confirmar.');
    assert.equal(await page.locator('.academic-table input, .academic-table select, .academic-table textarea, .academic-table [contenteditable=true]').count(), 0, 'Las notas académicas son de solo lectura.');
    assert.match(await metric('General · G').innerText(), /56[.,]25/);
    assert.match(await metric('Promedio I–II · S1').innerText(), /1[.,]50/);
    assert.match(await metric('Promedio I–II · S1').innerText(), /III · S2: 3[.,]00/);
    assert.match(await metric('Progresión · P').innerText(), /93[.,]75/, 'P compara promedio I–II = 1,50 con III = 3,00.');
    assert.match(await dimension('Académico').innerText(), /63[.,]75/);
    assert.equal(await dimension('Desempeño').innerText(), 'Pendiente');
    assert.equal(await dimension('Compromiso').innerText(), 'Pendiente');

    await tab('Desempeño').click();
    for (const [label, value] of [['Días lectivos del periodo', '200'], ['Días formalmente eximidos', '0'], ['Días asistidos', '190'], ['Ingresos puntuales', '171']]) {
      assert.equal(await page.getByLabel(label).inputValue(), '', `${label} queda vacío después de confirmar A.`);
      await page.getByLabel(label).fill(value);
    }
    await check(page.getByLabel('He contrastado y validado la asistencia')); await saved();
    await check(page.getByLabel('Confirmar “Sin incidencias”')); await saved();
    await check(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Validación final de desempeño', exact: true }) }).getByLabel('Revisado y validado')); await saved();
    assert.match(await dimension('Desempeño').innerText(), /95[.,]50/);

    await tab('Compromiso').click();
    const institutional = page.locator('section.detail-records').filter({ has: page.getByRole('heading', { name: 'CONCURSOS ACADÉMICOS', exact: true }) });
    assert.equal(await institutional.locator('.commitment-card').count(), 0, 'La confirmación del PDF no inventa concursos.');
    assert.equal(await institutional.getByRole('button', { name: 'Registrar incumplimiento', exact: true }).count(), 0, 'El ámbito institucional registra concursos académicos.');
    await institutional.getByRole('button', { name: 'No participó en concursos', exact: true }).click(); await saved();
    assert.equal((await student(pupils[0].code)).noContestParticipation, true);
    assert.deepEqual((await student(pupils[0].code)).institutional, [], 'La ausencia de participación no crea fecha, puesto ni concurso ficticios.');
    assert.equal(await institutional.locator('.commitment-card').count(), 0);
    assert.match(await metric('Participación institucional · PI').innerText(), /0[.,]00/);
    assert.match(await institutional.innerText(), /No participó en concursos/);
    assert((await student(pupils[0].code)).history.some(entry => entry.field === 'noContestParticipation'));
    const noContestBackup = await backup();
    assert.equal(noContestBackup.state.students.find(value => value.code === pupils[0].code).noContestParticipation, true);
    await institutional.screenshot({ path: '/tmp/circulos-no-contests-confirmed.png' });
    await load(); await openStudent(pupils[0].code, pupils[0].name); await tab('Compromiso').click();
    assert.equal((await student(pupils[0].code)).noContestParticipation, true, 'La confirmación sin concursos persiste al recargar.');
    assert.match(await metric('Participación institucional · PI').innerText(), /0[.,]00/);
    await institutional.getByRole('button', { name: 'Deshacer confirmación', exact: true }).click(); await saved();
    assert.equal((await student(pupils[0].code)).noContestParticipation, false);
    assert.match(await metric('Participación institucional · PI').innerText(), /Pendiente/);
    await institutional.getByRole('button', { name: 'No participó en concursos', exact: true }).click(); await saved();
    for (const [index, scope, points] of [[0, 'local', 40], [1, 'regional', 70], [2, 'national', 100]]) {
      await institutional.getByRole('button', { name: 'Agregar concurso', exact: true }).click();
      if (index === 0) { await saved(); assert.equal((await student(pupils[0].code)).noContestParticipation, false, 'Agregar un concurso retira la confirmación incompatible sin borrar historial.'); }
      const record = institutional.locator('.commitment-card').nth(index);
      const type = record.getByLabel('Tipo de evento · requerido');
      const date = record.getByLabel('Fecha · requerida', { exact: true });
      const placement = record.getByLabel('Ubicación / puesto del estudiante · requerido', { exact: true });
      const confirmation = record.getByLabel('He revisado y confirmo este concurso');
      assert.equal(await record.locator('select:visible').count(), 1, 'El formulario principal tiene un solo desplegable de tipo de evento.');
      assert.deepEqual(await type.locator('option').allTextContents(), ['Seleccionar tipo de evento', 'Concurso académico local', 'Concurso académico regional', 'Concurso académico nacional']);
      assert.equal(await type.inputValue(), '');
      assert.equal(await date.inputValue(), '');
      assert.equal(await placement.inputValue(), '');
      assert(await confirmation.isDisabled(), 'No se confirma un concurso sin sus tres datos requeridos.');
      await type.selectOption(scope);
      await date.fill('2026-10-20');
      assert(await confirmation.isDisabled(), 'La ubicación o puesto es obligatorio.');
      await placement.fill(`${index + 1}.º puesto`);
      if (index === 0) {
        await date.fill('');
        assert(await confirmation.isDisabled(), 'La fecha es obligatoria.');
        await date.fill('2026-10-20');
        await type.selectOption('');
        assert(await confirmation.isDisabled(), 'El tipo de evento es obligatorio.');
        await type.selectOption(scope);
      }
      assert(await confirmation.isEnabled(), 'Tipo, fecha y puesto habilitan la confirmación sin completar detalles opcionales.');
      await check(confirmation); await saved();
      const contest = (await student(pupils[0].code)).institutional[index];
      assert.equal(contest.eventType, 'academic_contest');
      assert.equal(contest.scope, scope);
      assert.equal(contest.status, 'fulfilled');
      assert.equal(contest.validated, true);
      assert.equal(contest.evidence, '');
      assert.equal(contest.justification, '');
      assert.equal(contest.representingSchool ?? false, false);
      assert.match(await metric('Participación institucional · PI').innerText(), new RegExp(`${points}[.,]00`), 'PI utiliza el mayor puntaje de los concursos confirmados.');
    }
    const family = page.locator('section.detail-records').filter({ has: page.getByRole('heading', { name: 'Compromiso familiar', exact: true }) });
    await family.getByRole('button', { name: 'Agregar', exact: true }).click();
    const familyRecord = family.locator('.commitment-card').first();
    const familyConfirmation = familyRecord.getByLabel('He revisado y confirmo este registro');
    assert(await familyConfirmation.isDisabled(), 'No se confirma un compromiso familiar sin actividad, fecha y estado.');
    await familyRecord.getByLabel('Actividad o compromiso', { exact: true }).fill('Reunion familiar ficticia de octubre');
    await familyRecord.getByLabel('Fecha', { exact: true }).fill('2026-10-23');
    assert(await familyRecord.getByLabel('Exigible para este estudiante').isChecked(), 'Un compromiso familiar agregado es exigible sin introducir un cuarto dato.');
    assert(await familyConfirmation.isDisabled(), 'El estado del compromiso familiar es obligatorio.');
    await familyRecord.getByRole('button', { name: 'Cumplió', exact: true }).click();
    assert(await familyConfirmation.isEnabled(), 'Actividad, fecha y estado permiten validar sin observación ni evidencia.');
    await familyRecord.getByLabel('Fecha', { exact: true }).fill('');
    assert(await familyConfirmation.isDisabled(), 'La fecha del compromiso familiar es obligatoria.');
    await familyRecord.getByLabel('Fecha', { exact: true }).fill('2026-10-23');
    await familyRecord.getByLabel('Actividad o compromiso', { exact: true }).fill('');
    assert(await familyConfirmation.isDisabled(), 'La actividad del compromiso familiar es obligatoria.');
    await familyRecord.getByLabel('Actividad o compromiso', { exact: true }).fill('Reunion familiar ficticia de octubre');
    assert.equal(await familyRecord.getByLabel('Justificación / observación · opcional', { exact: true }).inputValue(), '');
    assert.equal(await familyRecord.getByLabel('Evidencia documental · opcional', { exact: true }).inputValue(), '');
    await check(familyConfirmation); await saved();
    await check(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Validación final de compromiso', exact: true }) }).getByLabel('Revisado y validado')); await saved();
    const beforeExcludingC = await student(pupils[0].code);
    const includeC = page.getByLabel('Incluir Compromiso en el promedio', { exact: true });
    await includeC.uncheck(); await saved();
    const excludedC = await student(pupils[0].code);
    assert.equal(excludedC.commitmentEnabled, false);
    assert.deepEqual(excludedC.institutional, beforeExcludingC.institutional);
    assert.deepEqual(excludedC.family, beforeExcludingC.family);
    assert.deepEqual(excludedC.validated, beforeExcludingC.validated, 'Excluir Compromiso conserva sus confirmaciones y registros, sin afectar A/B.');
    assert.match(await page.locator('.detail-total').innerText(), /74[.,]33/);
    await includeC.check(); await saved();
    await page.getByLabel('Permanencia en el círculo', { exact: true }).selectOption('remains'); await saved();
    const completed = await student(pupils[0].code);
    assert.equal(completed.circleStatus, 'remains');
    assert(completed.history.some(entry => entry.field === 'circleStatus'));
    assert.deepEqual(completed.institutional.map(record => record.scope), ['local', 'regional', 'national']);
    assert(completed.institutional.every(record => record.eventType === 'academic_contest' && record.validated));
    assert.equal(completed.family[0].validated, true);
    assert.equal(completed.family[0].evidence, '');
    assert.equal(completed.family[0].justification, '');
    assert.deepEqual(completed.validated, { academic: true, performance: true, commitment: true });
    assert.match(await metric('Participación institucional · PI').innerText(), /100[.,]00/);
    assert.match(await metric('Compromiso familiar · CF').innerText(), /100[.,]00/);
    assert.match(await dimension('Compromiso').innerText(), /100[.,]00/);
    assert.match(await page.locator('.detail-total').innerText(), weightedReferencePattern);
    assert.match(await page.locator('.detail-total').innerText(), /Validado para ranking/);

    // Retry the active original through the same control exposed to a reviewer.
    // Trace its fetch call while delegating unchanged to the actual offline API.
    const beforeRescan = await snapshot();
    const activePdf = beforeRescan.state.pdfs.find(pdf => pdf.id === completed.reportApproval.pdfId);
    await startPdfTrace();
    await tab('Académico').click();
    await page.getByRole('button', { name: 'Volver a escanear notas', exact: true }).click();
    await poll(async () => (await student(pupils[0].code)).history.length > completed.history.length, 'nueva lectura del PDF original', 180000);
    await page.getByRole('button', { name: 'Volver a escanear notas', exact: true }).waitFor();
    assertRescanCalls(await stopPdfTrace(), activePdf.id);
    const afterRescan = await snapshot();
    const rescanned = afterRescan.state.students.find(value => value.id === completed.id);
    const rescannedPdf = afterRescan.state.pdfs.find(pdf => pdf.id === activePdf.id);
    assert.deepEqual({ id: rescannedPdf.id, hash: rescannedPdf.hash, size: rescannedPdf.size, uploadedAt: rescannedPdf.uploadedAt }, { id: activePdf.id, hash: activePdf.hash, size: activePdf.size, uploadedAt: activePdf.uploadedAt }, 'La nueva lectura conserva el PDF original.');
    for (const field of ['code', 'name', 'grade', 'section', 'reportApproval', 'attendance', 'discipline', 'institutional', 'family', 'validated', 'commitmentEnabled', 'circleStatus']) assert.deepEqual(rescanned[field], completed[field], `Volver a escanear conserva ${field}.`);
    assert.deepEqual(rescanned.academic, completed.academic);
    assert.deepEqual(await page.locator('.grade-select').allTextContents(), previewNotes);
    assert.match(await dimension('Académico').innerText(), /63[.,]75/);
    assert.match(await page.locator('.detail-total').innerText(), weightedReferencePattern);

    // Approval alone must not erase the completed reviews preserved by the
    // calculation-policy migration. Exercise the real Settings UI both ways.
    const beforeCriteriaApproval = await student(pupils[0].code);
    await navigate('Parámetros');
    const approveCriteria = page.getByLabel('Confirmo que los pesos, el catálogo y los criterios registrados cuentan con aprobación institucional para esta evaluación.');
    for (const approved of [false, true]) {
      await approveCriteria.setChecked(approved);
      await page.getByRole('button', { name: 'Guardar parámetros', exact: true }).first().click();
      await poll(async () => (await snapshot()).state.settings.criteriaApproved === approved, `aprobación de fórmula ${approved}`);
      const afterApproval = await student(pupils[0].code);
      for (const field of ['academic', 'attendance', 'discipline', 'institutional', 'family', 'validated', 'commitmentEnabled', 'circleStatus', 'noContestParticipation', 'reportApproval']) assert.deepEqual(afterApproval[field], beforeCriteriaApproval[field], `Cambiar solo la aprobación conserva ${field}.`);
    }
    await openStudent(pupils[0].code, pupils[0].name);
    assert.match(await page.locator('.detail-total').innerText(), /Validado para ranking/);
    assert.match(await page.locator('.detail-total').innerText(), weightedReferencePattern);

    await navigate('Panel principal');
    const exported = await download(() => page.getByRole('button', { name: 'Generar ranking consolidado', exact: true }).click());
    assert(exported.name.endsWith('.xlsx'));
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(exported.content);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['RANKING', 'DETALLE', 'PENDIENTES', 'CONFIGURACIÓN']);
    const ranking = workbook.getWorksheet('RANKING');
    assert.equal(ranking.rowCount, 2, 'Solo la ficha con A, B y C completos entra al ranking.');
    assert.equal(ranking.getCell('B2').value, pupils[0].code);
    assert.equal(ranking.getCell('F2').value, 63.75);
    assert.equal(ranking.getCell('G2').value, 95.5);
    assert.equal(ranking.getCell('H2').value, 100);
    assert(Math.abs(ranking.getCell('I2').value - weightedReference) < 1e-10);
    const exportedConfig = new Map();
    workbook.getWorksheet('CONFIGURACIÓN').eachRow((row, index) => { if (index > 1) exportedConfig.set(row.getCell(1).value, row.getCell(2).value); });
    assert.equal(exportedConfig.get('Peso I bimestre'), 0.25);
    assert.equal(exportedConfig.get('Peso II bimestre'), 0.25);
    assert.equal(exportedConfig.get('Peso III bimestre'), 0.5);
    assert.match(exportedConfig.get('Progresión comparable'), /A\/AD=3/);

    // Old saved metadata is repaired from the retained filename immediately.
    // Its original bytes, three grade columns and manual B/C stay intact.
    const legacyBackup = await backup();
    const legacyPdf = legacyBackup.state.pdfs.find(pdf => pdf.studentId === completed.id && pdf.status === 'validated');
    const legacyOriginal = { id: legacyPdf.id, hash: legacyPdf.hash, size: legacyPdf.size, uploadedAt: legacyPdf.uploadedAt };
    Object.assign(legacyPdf, { name: 'BOLETA_2do año F_Secundaria_PEREZ_RAMOS_Lucia Elena.pdf', status: 'review', extractedCode: '', extractedName: '', extractedGrade: '', extractedSection: '', text: '', warnings: ['Lectura antigua incompleta'] });
    delete legacyPdf.confirmedIdentity;
    delete legacyPdf.manualName;
    const legacyStudent = legacyBackup.state.students.find(value => value.id === completed.id);
    delete legacyStudent.reportApproval;
    legacyStudent.validated.academic = false;
    for (const area of legacyStudent.academic) area.validated = false;
    const legacyPath = path.join(directory, 'respaldo-lectura-antigua.json');
    await fs.writeFile(legacyPath, JSON.stringify(legacyBackup));
    const restoreLegacy = async () => {
      await page.locator('input[type=file][accept*="application/json"]').setInputFiles(legacyPath);
      await page.getByRole('dialog').getByRole('button', { name: 'Restaurar datos', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    };
    await navigate('Importar libretas');
    await restoreLegacy();
    await review(legacyPdf.name);
    assert.equal(await page.getByLabel('Apellidos y nombres', { exact: true }).inputValue(), pupils[0].name, 'El nombre del archivo aparece antes de confirmar.');
    assert((await page.locator('tr').filter({ has: page.locator('.file-cell strong', { hasText: legacyPdf.name }) }).innerText()).includes(pupils[0].name), 'La lista ya muestra el nombre del archivo.');
    assert(await page.locator('.import-review').getByRole('button', { name: 'Confirmar libreta', exact: true }).isEnabled());
    assert.equal(await page.locator('.import-review').getAttribute('aria-busy'), 'false', 'La metadata del archivo no inicia otra lectura OCR.');
    const temporaryName = 'PEREZ RAMOS NOMBRE TEMPORAL';
    await page.getByLabel('Apellidos y nombres', { exact: true }).fill(temporaryName);
    await page.locator('.import-review').getByRole('heading', { name: legacyPdf.name, exact: true }).click();
    await poll(async () => (await snapshot()).state.pdfs.find(pdf => pdf.id === legacyOriginal.id)?.manualName === temporaryName, 'nombre temporal guardado sin confirmar');
    await poll(async () => (await page.locator('tr').filter({ has: page.locator('.file-cell strong', { hasText: legacyPdf.name }) }).innerText()).includes(temporaryName), 'nombre temporal guardado visible');
    await restoreLegacy();
    await poll(async () => (await page.getByLabel('Apellidos y nombres', { exact: true }).inputValue()) === pupils[0].name, 'el respaldo reemplaza el nombre editado sin conservar un borrador anterior');
    assert(await page.locator('.import-review').getByRole('button', { name: 'Confirmar libreta', exact: true }).isEnabled(), 'Otra restauración tampoco bloquea la confirmación sin código.');
    await load();
    await review(legacyPdf.name);
    current = await snapshot();
    const recoveredPdf = current.state.pdfs.find(pdf => pdf.id === legacyOriginal.id);
    const recoveredStudent = current.state.students.find(value => value.id === completed.id);
    assert.deepEqual({ id: recoveredPdf.id, hash: recoveredPdf.hash, size: recoveredPdf.size, uploadedAt: recoveredPdf.uploadedAt }, legacyOriginal);
    assert.equal(recoveredPdf.extractedCode, '');assert.equal(recoveredPdf.text, '');assert.equal(recoveredPdf.ocr, false, 'La recuperación usa el archivo sin releer su contenido.');
    assert.equal(current.state.students.length, 3);
    assert(!recoveredStudent.reportApproval);
    assert.equal(recoveredStudent.validated.academic, false, 'El nombre recuperado todavía exige confirmar antes de calcular A.');
    for (const field of ['attendance', 'discipline', 'institutional', 'family']) assert.deepEqual(recoveredStudent[field], completed[field], `La recuperación conserva ${field} manual.`);
    await page.screenshot({ path: '/tmp/circulos-import-review.png', fullPage: true });
    await page.locator('.import-review').screenshot({ path: '/tmp/circulos-import-review-panel.png' });
    await openStudent(pupils[0].code, pupils[0].name);
    await page.getByRole('heading', { name: 'Libreta pendiente de confirmación', exact: true }).waitFor();
    assert.equal(await dimension('Académico').innerText(), 'Pendiente');
    await confirm(legacyPdf.name);
    const recoveredApproved = await student(pupils[0].code);
    assert.equal(recoveredApproved.id, completed.id);
    assert.equal(recoveredApproved.validated.academic, true);
    for (const field of ['attendance', 'discipline', 'institutional', 'family']) assert.deepEqual(recoveredApproved[field], completed[field]);

    await navigate('Importar libretas');
    await upload([fixtures[0]]);
    current = await snapshot();
    assert.equal(current.state.students.length, 3);
    const original = current.state.pdfs.find(pdf => pdf.studentId === completed.id && pdf.status === 'validated');
    assert.equal(current.state.pdfs.filter(pdf => pdf.hash === original.hash).length, 2);
    assert(current.state.pdfs.some(pdf => pdf.hash === original.hash && pdf.status === 'duplicate'));
    const replacementPath = path.join(directory, 'version-corregida-sin-identidad.pdf');
    await fs.writeFile(replacementPath, makePdf(settings, { ...pupils[0], grades: ['B', 'B', 'A'] }));
    await upload([replacementPath]);
    await poll(async () => (await snapshot()).state.pdfs.find(pdf => pdf.id === original.id)?.status === 'replaced', 'versión anterior conservada');
    await openStudent(pupils[0].code, pupils[0].name);
    await page.getByRole('heading', { name: 'Libreta pendiente de confirmación', exact: true }).waitFor();
    assert(await tab('Desempeño').isDisabled(), 'Una nueva versión requiere revisar de nuevo el PDF.');
    await confirm(path.basename(replacementPath));
    current = await snapshot();
    const replacement = current.state.pdfs.find(pdf => pdf.name === path.basename(replacementPath));
    assert.equal(replacement.replacesId, original.id);
    const unaffected = current.state.students.filter(value => value.code !== pupils[0].code);
    const removedIds = current.state.pdfs.filter(pdf => pdf.studentId === completed.id || pdf.hash === original.hash || pdf.hash === replacement.hash).map(pdf => pdf.id);
    assert(removedIds.length >= 3, 'El caso de eliminación incluye original, versión y duplicado.');
    await review(path.basename(replacementPath));
    const dialogPromise = page.waitForEvent('dialog');
    const clickPromise = page.locator('.import-review').getByRole('button', { name: 'Eliminar libreta', exact: true }).click();
    const dialog = await dialogPromise;
    assert.match(dialog.message(), new RegExp(pupils[0].name));
    assert.match(dialog.message(), /todas sus versiones PDF/);
    await dialog.accept(); await clickPromise;
    await poll(async () => !(await student(pupils[0].code)), 'eliminación de la ficha vinculada');
    current = await snapshot();
    assert(!current.state.pdfs.some(pdf => removedIds.includes(pdf.id) || pdf.hash === original.hash || pdf.hash === replacement.hash), 'La eliminación borra versiones y huellas duplicadas.');
    assert(!current.files.some(file => removedIds.includes(file.id)), 'Los originales se eliminan de IndexedDB en la misma operación.');
    assert.deepEqual(current.state.students, unaffected, 'Las otras aulas conservan todos sus datos.');
    await upload([fixtures[0]]);
    current = await snapshot();
    const reimported = current.state.pdfs.find(pdf => pdf.hash === original.hash);
    assert.equal(reimported.status, 'review', 'El mismo archivo vuelve a importarse después de eliminar su huella.');
    const recreated = await student(pupils[0].code);
    assert.notEqual(recreated.id, completed.id);
    assert(!recreated.reportApproval);
    assertBlankManual(recreated);
    await openStudent(pupils[0].code, pupils[0].name);
    await page.getByRole('heading', { name: 'Libreta pendiente de confirmación', exact: true }).waitFor();
    assert(await tab('Compromiso').isDisabled(), 'La reimportación comienza con una nueva revisión.');
    await confirm(path.basename(fixtures[0]));
    assertBlankManual(await student(pupils[0].code));

    const mixedPupil = { code: 'HEADER-TEST-003', name: 'PEREZ GARCIA ANA MARIA' };
    const headerPage = await context.newPage();
    const imageWidth = 1100, imageHeight = 260;
    await headerPage.setViewportSize({ width: imageWidth, height: imageHeight });
    await headerPage.setContent(`<html><body style="margin:0;padding:20px;background:white;color:black;font:24px/1.35 Arial,sans-serif"><div>INFORME DE PROGRESO DEL ESTUDIANTE</div><div>Codigo del estudiante: ${mixedPupil.code}</div><div>Apellidos y nombres: ${mixedPupil.name}</div><div>Grado: 3</div><div>Seccion: F</div><div>Periodo: 2026</div></body></html>`);
    const headerImage = await headerPage.screenshot({ type: 'jpeg', quality: 100 });
    await headerPage.close();
    const mixedPath = path.join(directory, 'documento-mixto-cabecera-imagen.pdf');
    await fs.writeFile(mixedPath, makeMixedPdf(settings, headerImage, imageWidth, imageHeight));
    await navigate('Importar libretas');
    await upload([mixedPath]);
    current = await snapshot();
    const mixedPdf = current.state.pdfs.find(pdf => pdf.name === path.basename(mixedPath));
    assert.equal(mixedPdf.extractedCode, mixedPupil.code, 'El código de la cabecera gráfica se reconoce aunque todas las notas ya sean texto nativo.');
    assert.equal(mixedPdf.extractedName, mixedPupil.name);
    assert.equal(mixedPdf.extractedSection, 'F');
    assert.equal(mixedPdf.ocr, true);
    assert(mixedPdf.areas.every(area => area.grades.every(row => row.join(',') === 'AD,B,C')), 'El OCR de identidad conserva las notas nativas.');
    assert.equal(mixedPdf.areas.flatMap(area => area.grades).flat().length, 45);
    const mixedPending = await student(mixedPupil.code);
    assert.equal(mixedPending.grade, '3.º de secundaria');assert(!mixedPending.reportApproval);assertBlankManual(mixedPending);
    await review(path.basename(mixedPath));
    assert.equal(await page.getByLabel('Apellidos y nombres', { exact: true }).inputValue(), mixedPupil.name);
    await page.screenshot({ path: '/tmp/circulos-mixed-pdf-review.png', fullPage: true });
    await page.locator('.import-review').screenshot({ path: '/tmp/circulos-mixed-pdf-review-panel.png' });
    await confirm(path.basename(mixedPath));
    const mixedConfirmed = await student(mixedPupil.code);
    assert.equal(mixedConfirmed.validated.academic, true);assertBlankManual(mixedConfirmed);
    await review(path.basename(mixedPath));
    const mixedDialog = page.waitForEvent('dialog').then(async dialog => { assert.match(dialog.message(), new RegExp(mixedPupil.name));await dialog.accept(); });
    await page.locator('.import-review').getByRole('button', { name: 'Eliminar libreta', exact: true }).click();
    await mixedDialog;
    await poll(async () => !(await student(mixedPupil.code)), 'eliminación de ficha mixta ficticia');
    assert.equal((await snapshot()).state.students.length, 3);

    // Every printed course is retained, including subjects outside the five
    // approved scoring areas. Their grades remain visible after a fresh scan.
    const allCoursesPupil = { code: 'TODAS-AREAS-F4-001', name: 'CAMPOS VEGA Elena Maria', grade: 4 };
    const allCoursesPath = path.join(directory, 'libreta-compacta-todas-las-areas.pdf');
    await fs.writeFile(allCoursesPath, makeCompactPdf(settings, { ...allCoursesPupil, additionalAreas: SUPPLEMENTAL_REPORT_AREAS }));
    await navigate('Importar libretas');
    await upload([allCoursesPath]);
    current = await snapshot();
    const allCoursesPdf = current.state.pdfs.find(pdf => pdf.name === path.basename(allCoursesPath));
    assert.equal(allCoursesPdf.areas.flatMap(area => area.grades).flat().length, 45);
    assert.equal(allCoursesPdf.supplementalAreas.length, 5);
    assert.equal(allCoursesPdf.supplementalAreas.flatMap(area => area.grades).flat().length, 33);
    assert(allCoursesPdf.supplementalAreas.every(area => area.grades.every(row => row.join(',') === 'C,B,A')));
    await review(path.basename(allCoursesPath));
    const allCoursesPreview = page.locator('.import-grade-preview');
    await allCoursesPreview.locator('summary').click();
    assert.equal(await allCoursesPreview.locator('tbody tr').count(), 26);
    const allCoursesNotes = await allCoursesPreview.locator('tbody tr td:not(:first-child)').allTextContents();
    assert.deepEqual(allCoursesNotes, Array.from({ length: 26 }, () => ['C', 'B', 'A']).flat(), 'Las 78 notas de las diez áreas ya aparecen en la revisión.');
    for (const area of SUPPLEMENTAL_REPORT_AREAS) assert((await allCoursesPreview.innerText()).includes(area.name));
    assert.equal(await allCoursesPreview.locator('input, select, textarea, [contenteditable=true]').count(), 0);
    await confirm(path.basename(allCoursesPath));
    await tab('Académico').click();
    assert.equal(await page.locator('.academic-table').count(), 10);
    assert.deepEqual(await page.locator('.grade-select').allTextContents(), allCoursesNotes);
    assert.equal(await page.locator('.academic-table input, .academic-table select, .academic-table textarea, .academic-table [contenteditable=true]').count(), 0);
    assert.match(await dimension('Académico').innerText(), /63[.,]75/);
    const allCoursesApproved = await student(allCoursesPupil.code);
    assertBlankManual(allCoursesApproved);
    await startPdfTrace();
    await page.getByRole('button', { name: 'Volver a escanear notas', exact: true }).click();
    await poll(async () => (await student(allCoursesPupil.code)).history.length > allCoursesApproved.history.length, 'nueva lectura de las diez áreas', 180000);
    await page.getByRole('button', { name: 'Volver a escanear notas', exact: true }).waitFor();
    assertRescanCalls(await stopPdfTrace(), allCoursesPdf.id);
    current = await snapshot();
    const allCoursesRescanned = current.state.pdfs.find(pdf => pdf.id === allCoursesPdf.id);
    assert.equal(allCoursesRescanned.hash, allCoursesPdf.hash);
    assert.deepEqual(allCoursesRescanned.supplementalAreas, allCoursesPdf.supplementalAreas);
    assert.deepEqual((await student(allCoursesPupil.code)).academic, allCoursesApproved.academic);
    assert.equal(current.state.settings.areas.length, 5, 'Reconocer otras asignaturas conserva el catálogo de cálculo aprobado.');
    assert.deepEqual(await page.locator('.grade-select').allTextContents(), allCoursesNotes);
    assert.match(await dimension('Académico').innerText(), /63[.,]75/);
    await page.screenshot({ path: '/tmp/circulos-all-courses-academic.png', fullPage: true });
    await deleteImported(path.basename(allCoursesPath));
    assert.equal((await snapshot()).state.students.length, 3);

    // A was the top level available in I–II. Its new AD in III keeps the
    // stronger current achievement, but never creates an extra growth bonus.
    const weightedPupil = { code: 'BIMESTRES-1A-001', name: 'RENDIMIENTO PONDERADO PRUEBA', grade: 1, section: 'A' };
    const weightedPath = path.join(directory, 'BOLETA_1ro año A_Secundaria_RENDIMIENTO_PONDERADO_PRUEBA.pdf');
    await fs.writeFile(weightedPath, makeCompactPdf(settings, { ...weightedPupil, grades: ['A', 'A', 'AD', 'C'] }));
    await navigate('Importar libretas'); await upload([weightedPath]);
    const weightedPdf = (await snapshot()).state.pdfs.find(pdf => pdf.name === path.basename(weightedPath));
    const weightedSource = structuredClone(weightedPdf.areas);
    assert(weightedSource.every(area => area.grades.every(row => row.join(',') === 'A,A,AD')));
    await confirm(path.basename(weightedPath)); await tab('Académico').click();
    const weightedMath = page.locator('.detail-area').filter({ has: page.getByRole('heading', { name: 'Matemática', exact: true }) });
    assert.match(await weightedMath.innerText(), /Promedio ponderado I–III/);
    assert.match(await weightedMath.innerText(), /87[.,]50\s*\/\s*100/);
    assert.match(await metric('General · G').innerText(), /87[.,]50/);
    assert.match(await metric('Ciencias y Letras · R').innerText(), /87[.,]50/);
    assert.match(await metric('Progresión · P').innerText(), /100[.,]00/);
    assert.match(await dimension('Académico').innerText(), /90[.,]00/);
    const comparable = page.locator('.detail-formula').filter({ has: page.getByRole('heading', { name: 'Fórmula y componentes', exact: true }) });
    assert.match(await comparable.innerText(), /Cambio comparable 0[.,]00/);
    assert.match(await comparable.innerText(), /AD.*III.*mejora adicional/s);
    await weightedMath.screenshot({ path: '/tmp/circulos-weighted-bimesters-aad.png' });
    const weightedBeforeReload = await student(weightedPupil.code);
    await load(); await openStudent(weightedPupil.code, weightedPupil.name); await tab('Académico').click();
    assert.match(await dimension('Académico').innerText(), /90[.,]00/);
    assert.deepEqual((await student(weightedPupil.code)).academic, weightedBeforeReload.academic);
    assert.deepEqual((await snapshot()).state.pdfs.find(pdf => pdf.id === weightedPdf.id).areas, weightedSource);
    const weightedBackup = await backup();
    assert.deepEqual(weightedBackup.state.settings.bimesterWeights, { first: 0.25, second: 0.25, third: 0.5 });
    assert.equal(weightedBackup.state.settings.academicScoringPolicy, 'weighted_bimesters_common_progression');
    const weightedFile = weightedBackup.files.find(file => file.id === weightedPdf.id);
    assert.equal(createHash('sha256').update(Buffer.from(weightedFile.content, 'base64')).digest('hex'), weightedPdf.hash);
    await deleteImported(path.basename(weightedPath));
    assert.equal((await snapshot()).state.students.length, 3);

    // The same ten printed subjects can include courses not studied during
    // I–III. IV-only notes do not activate those courses or trigger OCR.
    const blankCoursesPupil = { code: 'AREAS-VACIAS-F4-001', name: 'FERNANDEZ SOTO Rosa Elena', grade: 4 };
    const blankCourseIds = ['matematica', 'arte-cultura', 'educacion-religiosa'];
    const definitions = [...settings.areas, ...SUPPLEMENTAL_REPORT_AREAS];
    const blankDefinitions = definitions.filter(area => blankCourseIds.includes(area.id));
    const activeDefinitions = definitions.filter(area => !blankCourseIds.includes(area.id));
    const blankGrades = Object.fromEntries(blankDefinitions.map(area => [area.id, area.competencies.map(() => ['', '', '', 'AD'])]));
    const blankCoursesPath = path.join(directory, 'libreta-diez-areas-tres-no-cursadas.pdf');
    await fs.writeFile(blankCoursesPath, makeCompactPdf(settings, { ...blankCoursesPupil, grades: ['A', 'A', 'A', 'AD'], gradesByArea: blankGrades, additionalAreas: SUPPLEMENTAL_REPORT_AREAS }));
    await navigate('Importar libretas');
    await upload([blankCoursesPath]);
    const blankCoursesPdf = (await snapshot()).state.pdfs.find(pdf => pdf.name === path.basename(blankCoursesPath));
    assert.equal(blankCoursesPdf.ocr, false, 'Las áreas no cursadas no provocan una lectura OCR de notas inexistentes.');
    for (const definition of blankDefinitions) {
      const area = blankCoursesPdf.areas.find(area => area.areaId === definition.id)
        ?? blankCoursesPdf.supplementalAreas.find(area => area.definition.id === definition.id);
      assert(area, 'El respaldo conserva las áreas impresas aunque no se cursaron.');
      assert.deepEqual(area.grades, definition.competencies.map(() => ['', '', '']), 'IV no rellena los bimestres I–III.');
    }
    await review(path.basename(blankCoursesPath));
    const blankCoursesPreview = page.locator('.import-grade-preview');
    await blankCoursesPreview.locator('summary').click();
    assert.equal(await blankCoursesPreview.locator('tbody tr').count(), 18);
    for (const definition of blankDefinitions) assert(!(await blankCoursesPreview.innerText()).includes(definition.name), `${definition.name} sin notas I–III no aparece en la revisión.`);
    assert.deepEqual(await blankCoursesPreview.locator('tbody tr td:not(:first-child)').allTextContents(), Array(54).fill('A'));
    await startPdfTrace();
    await confirm(path.basename(blankCoursesPath));
    await tab('Académico').click();
    assert.equal(await page.locator('.academic-table').count(), 7);
    const blankCoursesAcademicNames = await page.locator('.detail-area h3').allTextContents();
    for (const definition of blankDefinitions) assert(!blankCoursesAcademicNames.includes(definition.name), `${definition.name} sin notas I–III no aparece en Académico.`);
    assert.deepEqual(blankCoursesAcademicNames, activeDefinitions.map(area => area.name));
    assert.deepEqual(await page.locator('.grade-select').allTextContents(), Array(54).fill('A'));
    assert.match(await metric('General · G').innerText(), /75[.,]00/, 'G usa solo las áreas cursadas y conserva su escala.');
    assert.notEqual(await dimension('Académico').innerText(), 'Pendiente', 'Matemática sin cursar no bloquea las otras cuatro áreas de cálculo.');
    assert.equal((await student(blankCoursesPupil.code)).validated.academic, true);
    await tab('Desempeño').click();
    await tab('Académico').click();
    await saved();
    assertRescanCalls(await stopPdfTrace(), blankCoursesPdf.id, 0);

    // Manual validation remains available for complete recognized grades whose
    // review flags were cleared in a restored backup. No note is transcribed.
    const manualBackup = await backup();
    const manualStudent = manualBackup.state.students.find(value => value.code === blankCoursesPupil.code);
    const manualGradeMatrices = structuredClone(manualStudent.academic);
    for (const area of manualStudent.academic) if (area.grades.flat().some(Boolean)) area.validated = false;
    manualStudent.validated.academic = false;
    const manualBackupPath = path.join(directory, 'respaldo-validacion-academica-manual.json');
    await fs.writeFile(manualBackupPath, JSON.stringify(manualBackup));
    await page.locator('input[type=file][accept*="application/json"]').setInputFiles(manualBackupPath);
    await page.getByRole('dialog').getByRole('button', { name: 'Restaurar datos', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await startPdfTrace();
    await openStudent(blankCoursesPupil.code, blankCoursesPupil.name);
    await tab('Académico').click();
    assert.equal((await student(blankCoursesPupil.code)).validated.academic, false);
    const academicFinal = page.getByLabel('Académico revisado y validado', { exact: true });
    assert(!await academicFinal.isChecked());
    assert(await academicFinal.isDisabled(), 'La validación final espera la revisión manual de las áreas cursadas.');
    for (const definition of settings.areas.filter(area => !blankCourseIds.includes(area.id))) {
      const validation = page.getByLabel(`${definition.name}: área revisada y validada`, { exact: true });
      assert(await validation.isEnabled());
      assert(!await validation.isChecked());
      await check(validation); await saved();
    }
    assert(await academicFinal.isEnabled(), 'Las cuatro áreas cursadas permiten confirmar A sin exigir Matemática.');
    await check(academicFinal); await saved();
    const manuallyValidated = await student(blankCoursesPupil.code);
    assert.equal(manuallyValidated.validated.academic, true);
    assert.deepEqual(manuallyValidated.academic.map(area => area.grades), manualGradeMatrices.map(area => area.grades), 'La validación manual conserva todas las notas y áreas vacías del respaldo.');
    assert.match(await metric('General · G').innerText(), /75[.,]00/);
    assert.notEqual(await dimension('Académico').innerText(), 'Pendiente');
    assert.equal(await page.locator('.academic-table input, .academic-table select, .academic-table textarea, .academic-table [contenteditable=true]').count(), 0);
    assertRescanCalls(await stopPdfTrace(), blankCoursesPdf.id, 0);
    await deleteImported(path.basename(blankCoursesPath));
    assert.equal((await snapshot()).state.students.length, 3);

    // An entirely blank Indaga row is not taught; its other science grades
    // Its six remaining science grades must still be scanned and reviewed;
    // confirming the PDF does not substitute the manual area confirmation.
    const science = settings.areas.find(area => area.group === 'science');
    const indagaIndex = science.competencies.findIndex(label => /^Indaga\b/i.test(label));
    assert(indagaIndex >= 0);
    for (const grade of [4, 5]) {
      const indagaPupil = { code: `INDAGA-F${grade}-001`, name: `INDAGA ${grade === 4 ? 'CUARTO' : 'QUINTO'} PRUEBA`, grade };
      const indagaPath = path.join(directory, `BOLETA_${grade}to año F_Secundaria_${indagaPupil.name.replaceAll(' ', '_')}.pdf`);
      const scienceRows = science.competencies.map((_, index) => index === indagaIndex ? ['', '', '', 'AD'] : ['A', 'A', 'A', 'AD']);
      await fs.writeFile(indagaPath, makeCompactPdf(settings, { ...indagaPupil, grades: ['A', 'A', 'A', 'AD'], gradesByArea: { [science.id]: scienceRows } }));
      await navigate('Importar libretas');
      await upload([indagaPath]);
      const indagaPdf = (await snapshot()).state.pdfs.find(pdf => pdf.name === path.basename(indagaPath));
      assert.equal(indagaPdf.extractedName, indagaPupil.name, 'La identidad de 4.º/5.º F procede también del nombre del archivo.');
      assert.equal(indagaPdf.extractedGrade, `${grade}.º de secundaria`);
      assert.equal(indagaPdf.ocr, false, 'Indaga no cursada no provoca OCR de una nota inexistente.');
      assert.deepEqual(indagaPdf.areas.find(area => area.areaId === science.id).grades[indagaIndex], ['', '', '']);
      await startPdfTrace();
      await confirm(path.basename(indagaPath));
      await tab('Académico').click();
      const scienceCard = page.locator('.detail-area').filter({ has: page.getByRole('heading', { name: science.name, exact: true }) });
      const scienceValidation = page.getByLabel(`${science.name}: área revisada y validada`, { exact: true });
      const finalValidation = page.getByLabel('Académico revisado y validado', { exact: true });
      assert.equal((await student(indagaPupil.code)).academic.find(area => area.areaId === science.id).validated, false);
      assert.equal((await student(indagaPupil.code)).validated.academic, false);
      assert(await scienceValidation.isEnabled(), 'La excepción permite revisar el área con Indaga totalmente vacía.');
      assert(!await scienceValidation.isChecked(), 'La validación del área sigue siendo un acto manual.');
      assert(await finalValidation.isDisabled());
      assert.match(await scienceCard.innerText(), /Indaga/);
      assert.match(await scienceCard.innerText(), /no se evalúa|no cursada/i);
      assert.match(await scienceCard.innerText(), /75[.,]00\s*\/\s*100/);
      assert.match(await metric('General · G').innerText(), /75[.,]00/);
      assert.match(await dimension('Académico').innerText(), /75[.,]00/);
      const beforeIndagaValidation = structuredClone((await student(indagaPupil.code)).academic.map(area => ({ areaId: area.areaId, grades: area.grades })));
      await check(scienceValidation); await saved();
      assert(await finalValidation.isEnabled());
      await check(finalValidation); await saved();
      assert.equal((await student(indagaPupil.code)).validated.academic, true);
      assert.deepEqual((await student(indagaPupil.code)).academic.map(area => ({ areaId: area.areaId, grades: area.grades })), beforeIndagaValidation, 'La revisión manual conserva Indaga vacía y las notas leídas.');
      await pause(600);
      assertRescanCalls(await stopPdfTrace(), indagaPdf.id, 0);
      if (grade === 4) await scienceCard.screenshot({ path: '/tmp/circulos-indaga-manual-4f.png' });
      await load();
      await startPdfTrace();
      await openStudent(indagaPupil.code, indagaPupil.name);
      await tab('Académico').click();
      assert(await page.getByLabel(`${science.name}: área revisada y validada`, { exact: true }).isChecked(), 'La validación manual persiste al recargar.');
      assert(await page.getByLabel('Académico revisado y validado', { exact: true }).isChecked());
      assert.deepEqual((await snapshot()).state.pdfs.find(pdf => pdf.id === indagaPdf.id).areas.find(area => area.areaId === science.id).grades[indagaIndex], ['', '', '']);
      assertRescanCalls(await stopPdfTrace(), indagaPdf.id, 0);
      await deleteImported(path.basename(indagaPath));
      assert.equal((await snapshot()).state.students.length, 3);
    }

    // Applicants from different sections share a grade but keep separate
    // lists/rankings. Their unmeasured C is explicitly excluded, never invented.
    const applicantPaths = [];
    for (const section of ['A', 'B']) {
      const applicant = { code: `POSTULANTE-1${section}`, name: `POSTULANTE PRIMERO ${section === 'A' ? 'ALFA' : 'BETA'}`, grade: 1, section };
      const applicantPath = path.join(directory, `BOLETA_1ro año ${section}_Secundaria_${applicant.name.replaceAll(' ', '_')}.pdf`);
      applicantPaths.push(applicantPath);
      const applicantScience = science.competencies.map((_, index) => section === 'B' && index === indagaIndex ? ['', '', '', 'AD'] : ['A', 'A', 'A', 'AD']);
      await fs.writeFile(applicantPath, makeCompactPdf(settings, { ...applicant, grades: ['A', 'A', 'A', 'AD'], gradesByArea: { [science.id]: applicantScience } }));
      await navigate('Importar libretas'); await upload([applicantPath]); await confirm(path.basename(applicantPath));
      assert.equal((await student(applicant.code)).section, section);
      if (section === 'B') {
        const reviewScience = page.getByLabel(`${science.name}: área revisada y validada`, { exact: true });
        assert(await reviewScience.isEnabled(), 'Indaga completamente vacía también se excluye en otras aulas.');
        await check(reviewScience); await saved();
        await check(page.getByLabel('Académico revisado y validado', { exact: true })); await saved();
      }
      const scienceCard = page.locator('.detail-area').filter({ has: page.getByRole('heading', { name: science.name, exact: true }) });
      assert.match(await scienceCard.innerText(), /75[.,]00\s*\/\s*100/);
      assert(!/\/\s*4\b/.test(await scienceCard.innerText()), 'El promedio mostrado usa escala de100 y los tres bimestres.');
      await page.getByLabel('Incluir Compromiso en el promedio', { exact: true }).uncheck(); await saved();
      await tab('Desempeño').click();
      for (const [label, value] of [['Días lectivos del periodo', '200'], ['Días formalmente eximidos', '0'], ['Días asistidos', '190'], ['Ingresos puntuales', '171']]) await page.getByLabel(label).fill(value);
      await check(page.getByLabel('He contrastado y validado la asistencia')); await saved();
      await check(page.getByLabel('Confirmar “Sin incidencias”')); await saved();
      await check(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Validación final de desempeño', exact: true }) }).getByLabel('Revisado y validado')); await saved();
      await page.getByLabel('Permanencia en el círculo', { exact: true }).selectOption(section === 'A' ? 'remains' : 'does_not_remain'); await saved();
      const applicantSaved = await student(applicant.code);
      assert.deepEqual(applicantSaved.institutional, []); assert.deepEqual(applicantSaved.family, []); assert.equal(applicantSaved.validated.commitment, false);
      assert.equal(applicantSaved.commitmentEnabled, false);
      assert.match(await page.locator('.detail-total').innerText(), /81[.,]83/);
      assert.match(await page.locator('.detail-total').innerText(), /Validado para ranking/);
      if (section === 'B') await page.locator('.evaluation-options').screenshot({ path: '/tmp/circulos-upgrade-applicant-options.png' });
      await load(); await openStudent(applicant.code, applicant.name);
      assert(!await page.getByLabel('Incluir Compromiso en el promedio', { exact: true }).isChecked());
      assert.equal(await page.getByLabel('Permanencia en el círculo', { exact: true }).inputValue(), section === 'A' ? 'remains' : 'does_not_remain');
    }
    for (const section of ['A', 'B']) {
      await navigate('Estudiantes');
      assert.deepEqual(await page.getByLabel('Filtrar por aula', { exact: true }).locator('option').allTextContents(), ['Todas las aulas', '1.º A', '1.º B'], 'Los filtros ofrecen solo las aulas actuales A–E presentes, conservando las antiguas bajo Todas las aulas.');
      await page.getByLabel('Filtrar por aula', { exact: true }).selectOption(`1.º ${section}`);
      const list = page.locator('.student-table tbody tr'); assert.equal(await list.count(), 1);
      assert.match(await list.innerText(), new RegExp(`POSTULANTE PRIMERO ${section === 'A' ? 'ALFA' : 'BETA'}`));
      await navigate('Ranking');
      const rankingSection = page.locator('section.card').filter({ has: page.getByRole('heading', { name: 'Ranking consolidado', exact: true }) });
      const ranked = rankingSection.locator('tbody tr'); assert.equal(await ranked.count(), 1);
      assert.match(await ranked.innerText(), /A \+ B/); assert.match(await ranked.locator('td').first().innerText(), /^01$/);
      assert.match(await ranked.innerText(), section === 'A' ? /Permanece/ : /No permanece/);
      await rankingSection.screenshot({ path: `/tmp/circulos-upgrade-ranking-1${section}.png` });
      const scopedExport = await download(() => page.getByRole('button', { name: 'Generar ranking consolidado', exact: true }).click());
      const scopedWorkbook = new ExcelJS.Workbook(); await scopedWorkbook.xlsx.load(scopedExport.content);
      assert.equal(scopedWorkbook.getWorksheet('RANKING').rowCount, 2);
      assert.equal(scopedWorkbook.getWorksheet('RANKING').getCell('B2').value, `POSTULANTE-1${section}`);
    }
    const applicantsBackup = await backup();
    for (const section of ['A', 'B']) {
      const backed = applicantsBackup.state.students.find(value => value.code === `POSTULANTE-1${section}`);
      assert.equal(backed.commitmentEnabled, false); assert.equal(backed.circleStatus, section === 'A' ? 'remains' : 'does_not_remain');
    }
    await page.getByLabel('Filtrar por aula', { exact: true }).selectOption('');
    for (const applicantPath of applicantPaths) await deleteImported(path.basename(applicantPath));
    assert.equal((await snapshot()).state.students.length, 3);

    // A single missing active note is a pending reading, so its course stays
    // visible and its academic validation remains unavailable.
    const partialPupil = { code: 'NOTA-PARCIAL-F4-001', name: 'VALDIVIA ROJAS Clara Sofia', grade: 4 };
    const mathematics = settings.areas.find(area => area.id === 'matematica');
    const partialMath = mathematics.competencies.map((_, index) => index === 0 ? ['A', '', 'A', 'AD'] : ['A', 'A', 'A', 'AD']);
    const partialPath = path.join(directory, 'libreta-matematica-una-nota-pendiente.pdf');
    await fs.writeFile(partialPath, makeCompactPdf(settings, { ...partialPupil, grades: ['A', 'A', 'A', 'AD'], gradesByArea: { matematica: partialMath } }));
    await navigate('Importar libretas');
    await upload([partialPath]);
    await review(path.basename(partialPath));
    const partialPreview = page.locator('.import-grade-preview');
    await partialPreview.locator('summary').click();
    assert.equal(await partialPreview.locator('tbody tr').count(), 15);
    assert((await partialPreview.innerText()).includes(mathematics.name));
    await startPdfTrace();
    await confirm(path.basename(partialPath));
    await poll(async () => (await student(partialPupil.code)).history.some(event => event.field === 'Actualización automática de notas desde el PDF original'), 'relectura de una nota faltante', 180000);
    await page.getByRole('button', { name: 'Volver a escanear notas', exact: true }).waitFor();
    await tab('Académico').click();
    assert.equal(await page.locator('.academic-table').count(), 5);
    assert.equal(await dimension('Académico').innerText(), 'Pendiente');
    assert(await page.getByLabel(`${mathematics.name}: área revisada y validada`, { exact: true }).isDisabled(), 'Una nota faltante impide validar el área visible.');
    assert.deepEqual((await student(partialPupil.code)).academic.find(area => area.areaId === 'matematica').grades[0], ['A', '', 'A']);
    await tab('Desempeño').click();
    await tab('Académico').click();
    await saved();
    const partialPdf = (await snapshot()).state.pdfs.find(pdf => pdf.name === path.basename(partialPath));
    assertRescanCalls(await stopPdfTrace(), partialPdf.id);
    await deleteImported(path.basename(partialPath));
    assert.equal((await snapshot()).state.students.length, 3);

    // Incident verification needs the recorded facts; measure and evidence are
    // optional. An unapproved discount still keeps B pending after verification.
    await openStudent(pupils[1].code, pupils[1].name);
    await tab('Desempeño').click();
    for (const [label, value] of [['Días lectivos del periodo', '200'], ['Días formalmente eximidos', '0'], ['Días asistidos', '200'], ['Ingresos puntuales', '200']]) await page.getByLabel(label).fill(value);
    await check(page.getByLabel('He contrastado y validado la asistencia')); await saved();
    await page.getByRole('button', { name: 'Agregar incidencia', exact: true }).click();
    const incident = page.locator('.commitment-card').first();
    const incidentConfirmation = incident.getByLabel('Incidencia verificada', { exact: true });
    assert(await incidentConfirmation.isDisabled());
    const unapprovedType = settings.disciplineTypes.find(type => !type.punctuality && type.discount == null);
    assert(unapprovedType, 'La aceptación incluye una categoría cuyo descuento sigue pendiente de aprobación.');
    await incident.getByRole('combobox').selectOption(unapprovedType.id);
    await incident.getByLabel('Fecha', { exact: true }).fill('2026-10-24');
    assert(await incidentConfirmation.isDisabled(), 'La descripción de la incidencia es obligatoria.');
    await incident.getByLabel('Descripción de la incidencia', { exact: true }).fill('Incidencia ficticia registrada para verificar los datos mínimos.');
    assert(await incidentConfirmation.isEnabled(), 'Categoría, fecha y descripción habilitan la verificación.');
    await incident.getByLabel('Fecha', { exact: true }).fill('');
    assert(await incidentConfirmation.isDisabled(), 'La fecha de la incidencia es obligatoria.');
    await incident.getByLabel('Fecha', { exact: true }).fill('2026-10-24');
    await incident.getByRole('combobox').selectOption('');
    assert(await incidentConfirmation.isDisabled(), 'La categoría de la incidencia es obligatoria.');
    await incident.getByRole('combobox').selectOption(unapprovedType.id);
    assert.equal(await incident.getByLabel('Medida aplicada · opcional', { exact: true }).inputValue(), '');
    assert.equal(await incident.getByLabel('Evidencia o referencia documental · opcional', { exact: true }).inputValue(), '');
    await check(incidentConfirmation); await saved();
    await check(page.getByLabel('Confirmo que el registro disciplinario está completo')); await saved();
    const minimalIncidentStudent = await student(pupils[1].code);
    assert.equal(minimalIncidentStudent.discipline.incidents[0].verified, true);
    assert.equal(minimalIncidentStudent.discipline.incidents[0].measure, '');
    assert.equal(minimalIncidentStudent.discipline.incidents[0].evidence, '');
    assert.equal(minimalIncidentStudent.attendance.validated, true);
    assert.equal(minimalIncidentStudent.discipline.confirmed, true);
    assert.equal(await dimension('Desempeño').innerText(), 'Pendiente', 'La verificación de hechos no aprueba un descuento pendiente.');
    assert(await page.locator('section').filter({ has: page.getByRole('heading', { name: 'Validación final de desempeño', exact: true }) }).getByLabel('Revisado y validado').isDisabled());

    // The provided filename is sufficient even when every native identity field
    // is absent. All 45 grade cells remain real native PDF text.
    const filenameCase = 'BOLETA_2do año F_Secundaria_SEGURA_CAMONES_ANDRES ADRIAN.pdf';
    const filenamePath = path.join(directory, filenameCase);
    await fs.writeFile(filenamePath, makePdf(settings, { identityLayout: 'none' }));
    await navigate('Importar libretas');
    await upload([filenamePath]);
    current = await snapshot();
    const filenamePdf = current.state.pdfs.find(pdf => pdf.name === filenameCase);
    const filenameStudent = current.state.students.find(value => value.id === filenamePdf.studentId);
    assert.equal(filenamePdf.extractedName, 'SEGURA CAMONES ANDRES ADRIAN');
    assert.equal(filenamePdf.extractedCode, '');assert.equal(filenamePdf.period, '');assert.equal(filenamePdf.ocr, false);
    assert.equal(filenamePdf.areas.flatMap(area => area.grades).flat().length, 45);
    assert.equal(filenameStudent.name, 'SEGURA CAMONES ANDRES ADRIAN');assert.equal(filenameStudent.grade, '2.º de secundaria');
    assert(!filenameStudent.reportApproval);assertBlankManual(filenameStudent);
    const filenameRow = page.locator('tr').filter({ has: page.locator('.file-cell strong', { hasText: filenameCase }) });
    assert((await filenameRow.innerText()).includes(filenameStudent.name), 'El estudiante figura en la lista antes de confirmar.');
    assert(!(await filenameRow.innerText()).includes(filenameStudent.code), 'La lista no pide un código generado.');
    await review(filenameCase);
    assert.equal(await page.getByLabel('Apellidos y nombres', { exact: true }).inputValue(), filenameStudent.name);
    assert.equal(await page.locator('.import-review').getByText('Código', { exact: true }).count(), 0);
    assert(await page.locator('.import-review').getByRole('button', { name: 'Confirmar libreta', exact: true }).isEnabled());
    assert.equal(await page.locator('.import-review').getAttribute('aria-busy'), 'false');
    await page.screenshot({ path: '/tmp/circulos-filename-review.png', fullPage: true });
    await page.locator('.import-review').screenshot({ path: '/tmp/circulos-filename-review-panel.png' });
    await confirm(filenameCase);
    const filenameApproved = await student(filenameStudent.code);
    assert.equal(filenameApproved.id, filenameStudent.id);assert.equal(filenameApproved.validated.academic, true);assertBlankManual(filenameApproved);
    for (const name of ['Académico', 'Desempeño', 'Compromiso']) assert(await tab(name).isEnabled());
    await deleteImported(filenameCase);

    const fallbackCase = 'documento-sin-nombre.pdf';
    const fallbackPath = path.join(directory, fallbackCase);
    await fs.writeFile(fallbackPath, makePdf(settings, { identityLayout: 'classroom', grade: 4, omitArea: 'matematica' }));
    await upload([fallbackPath]);
    await review(fallbackCase);
    const fallbackPdf = (await snapshot()).state.pdfs.find(pdf => pdf.name === fallbackCase);
    assert.equal(fallbackPdf.extractedName, '');assert.equal(fallbackPdf.extractedCode, '');assert.equal(fallbackPdf.period, '');assert.equal(fallbackPdf.ocr, false);
    assert.equal(await page.getByLabel('Apellidos y nombres', { exact: true }).inputValue(), '');
    assert(await page.locator('.import-review').getByRole('button', { name: 'Confirmar libreta', exact: true }).isDisabled());
    assert.equal(await page.locator('.import-review').getAttribute('aria-busy'), 'false', 'El nombre faltante permite escribir sin esperar OCR.');
    await page.getByLabel('Apellidos y nombres', { exact: true }).fill('RAMIREZ FLORES NOMBRE MANUAL');
    await page.locator('.import-review').getByRole('heading', { name: fallbackCase, exact: true }).click();
    await poll(async () => (await snapshot()).state.students.some(value => value.name === 'RAMIREZ FLORES NOMBRE MANUAL' && !value.reportApproval), 'nombre manual en la lista antes de confirmar');
    await poll(async () => (await page.locator('tr').filter({ has: page.locator('.file-cell strong', { hasText: fallbackCase }) }).innerText()).includes('RAMIREZ FLORES NOMBRE MANUAL'), 'nombre manual visible antes de confirmar');
    await startPdfTrace();
    await confirm(fallbackCase);
    await page.getByRole('button', { name: 'Volver a escanear notas', exact: true }).waitFor();
    const fallbackStudent = (await snapshot()).state.students.find(value => value.name === 'RAMIREZ FLORES NOMBRE MANUAL');
    assert.equal(fallbackStudent.grade, '4.º de secundaria');assert(fallbackStudent.reportApproval);
    assert.equal(fallbackStudent.validated.academic, true, 'El nombre manual confirma las cuatro áreas completas sin exigir un área no cursada.');
    assertBlankManual(fallbackStudent);
    for (const name of ['Académico', 'Desempeño', 'Compromiso']) assert(await tab(name).isEnabled());
    await tab('Académico').click();
    assert.notEqual(await dimension('Académico').innerText(), 'Pendiente');
    assert.equal(await page.locator('.academic-table').count(), 4);
    assert.equal(await page.locator('.academic-table input, .academic-table select, .academic-table textarea, .academic-table [contenteditable=true]').count(), 0);
    await tab('Desempeño').click();
    assert.equal(await page.getByLabel('Días lectivos del periodo').inputValue(), '');
    await tab('Académico').click();
    await saved();
    assertRescanCalls(await stopPdfTrace(), fallbackPdf.id, 0);
    await deleteImported(fallbackCase);
    assert.equal((await snapshot()).state.students.length, 3);

    const finalBackup = await backup();
    const finalSnapshot = await snapshot();
    assert.deepEqual(finalBackup.state, finalSnapshot.state);
    assert.equal(finalBackup.files.length, finalSnapshot.files.length);
    for (const file of finalBackup.files) {
      const record = finalBackup.state.pdfs.find(pdf => pdf.id === file.id);
      const content = Buffer.from(file.content, 'base64');
      assert.equal(content.length, record.size);
      assert.equal(createHash('sha256').update(content).digest('hex'), record.hash);
    }
    await openStudent(pupils[0].code, pupils[0].name);
    await page.screenshot({ path: '/tmp/circulos-adjustment.png', fullPage: true });
    await tab('Académico').click();
    assert.deepEqual((await page.locator('.grade-select').allTextContents()).slice(0, 3), ['C', 'B', 'A']);
    await tab('Compromiso').click();
    assert.equal(await page.locator('.commitment-card').count(), 0, 'No reaparecen evaluaciones eliminadas.');
    await review(path.basename(fixtures[0]));
    assert((await page.locator('.import-original iframe').getAttribute('src')).startsWith('blob:'), 'El original reimportado se conserva.');

    // The destructive workflows use only this temporary profile. Initialize the
    // separate demo space so every real-space deletion can prove its isolation.
    await page.getByRole('button', { name: 'Explorar demostración', exact: true }).click();
    await poll(async () => Boolean((await snapshot('demo')).state?.students.length), 'demostración ficticia disponible');
    const demoBeforeDeletion = await snapshot('demo');
    await page.getByRole('button', { name: 'Ir a datos reales', exact: true }).click();
    await page.locator('.demo-banner').waitFor({ state: 'hidden' });
    assert.deepEqual(await snapshot(), finalSnapshot, 'Explorar la demostración conserva el espacio real.');

    // Rebuild a replaced original and a duplicate for the new explicit student
    // deletion, independently of the existing import-review deletion coverage.
    await navigate('Importar libretas');
    await upload([fixtures[0]]);
    await upload([replacementPath]);
    await confirm(path.basename(replacementPath));
    await saved();
    const deleteStudentId = (await student(pupils[0].code)).id;
    await holdStudentRequest('rescan', deleteStudentId);
    await page.getByRole('button', { name: 'Volver a escanear notas', exact: true }).click();
    await poll(() => page.evaluate(() => window.__deleteRequestGate.held), 'escaneo pendiente antes de eliminar');
    assert(await page.getByRole('button', { name: 'Eliminar estudiante', exact: true }).isDisabled(), 'La eliminación espera al escaneo activo para que no restaure registros después.');
    await releaseStudentRequest();
    await poll(() => page.getByRole('button', { name: 'Eliminar estudiante', exact: true }).isEnabled(), 'escaneo finalizado antes de eliminar');

    await tab('Desempeño').click();
    await holdStudentRequest('save', deleteStudentId);
    await page.getByLabel('Días lectivos del periodo').fill('201');
    await page.getByRole('button', { name: 'Eliminar estudiante', exact: true }).click();
    await poll(() => page.evaluate(() => window.__deleteRequestGate.held), 'autoguardado pendiente antes de eliminar estudiante');
    assert.equal(await page.getByRole('dialog').count(), 0, 'El diálogo espera a que terminen los cambios de la ficha.');
    await releaseStudentRequest();
    const studentDeleteDialog = page.getByRole('dialog', { name: 'Eliminar estudiante', exact: true });
    await studentDeleteDialog.waitFor();
    assert.match(await studentDeleteDialog.innerText(), new RegExp(pupils[0].name));
    assert.match(await studentDeleteDialog.innerText(), /2\.º de secundaria · Sección F/);
    assert.match(await studentDeleteDialog.innerText(), /evaluaciones.*historial.*PDF.*versiones anteriores.*duplicados/s);
    assert.match(await studentDeleteDialog.innerText(), /Datos reales/);
    const beforeStudentCancel = await snapshot();
    const optionalBackup = JSON.parse((await download(() => studentDeleteDialog.getByRole('button', { name: 'Descargar respaldo', exact: true }).click())).content.toString());
    assert.deepEqual(optionalBackup.state, beforeStudentCancel.state, 'El respaldo opcional conserva la ficha antes de eliminar.');
    await studentDeleteDialog.getByRole('button', { name: 'Cancelar', exact: true }).last().click();
    await studentDeleteDialog.waitFor({ state: 'hidden' });
    assert.deepEqual(await snapshot(), beforeStudentCancel, 'Cancelar la eliminación individual conserva todos los registros y originales.');

    await setClosed(true);
    const beforeStudentDeletion = await snapshot();
    const target = beforeStudentDeletion.state.students.find(value => value.id === deleteStudentId);
    const targetHashes = new Set(beforeStudentDeletion.state.pdfs.filter(pdf => pdf.studentId === target.id || target.pdfIds.includes(pdf.id)).map(pdf => pdf.hash));
    const targetPdfIds = beforeStudentDeletion.state.pdfs.filter(pdf => pdf.studentId === target.id || targetHashes.has(pdf.hash)).map(pdf => pdf.id);
    assert(targetPdfIds.length >= 3, 'La eliminación individual incluye un original, una versión y un duplicado.');
    assert(beforeStudentDeletion.state.pdfs.some(pdf => targetPdfIds.includes(pdf.id) && pdf.status === 'replaced'));
    assert(beforeStudentDeletion.state.pdfs.some(pdf => targetPdfIds.includes(pdf.id) && pdf.status === 'duplicate'));
    await openStudent(pupils[0].code, pupils[0].name);
    assert(await page.getByRole('button', { name: 'Eliminar estudiante', exact: true }).isEnabled(), 'La ficha permite eliminar incluso con la evaluación cerrada.');
    await deletionScreenshot(page.locator('.danger-zone'), 'delete-student-footer');
    await page.getByRole('button', { name: 'Eliminar estudiante', exact: true }).click();
    await studentDeleteDialog.waitFor();
    await deletionScreenshot(studentDeleteDialog, 'delete-student-confirmation');
    await studentDeleteDialog.getByRole('button', { name: 'Eliminar estudiante', exact: true }).click();
    await studentDeleteDialog.waitFor({ state: 'hidden' });
    await poll(async () => !(await student(pupils[0].code)), 'eliminación individual de ficha y evaluaciones');
    const afterStudentDeletion = await snapshot();
    assert.deepEqual(afterStudentDeletion.state.settings, beforeStudentDeletion.state.settings, 'Eliminar una ficha conserva los parámetros y el cierre.');
    assert.deepEqual(afterStudentDeletion.state.students, beforeStudentDeletion.state.students.filter(value => value.id !== target.id), 'La eliminación individual conserva las otras fichas completas.');
    assert.deepEqual(afterStudentDeletion.state.pdfs, beforeStudentDeletion.state.pdfs.filter(pdf => !targetPdfIds.includes(pdf.id)), 'La eliminación individual conserva solo los documentos ajenos.');
    assert.deepEqual(afterStudentDeletion.files, beforeStudentDeletion.files.filter(file => !targetPdfIds.includes(file.id)), 'Se borran todos los originales vinculados de IndexedDB.');
    assert.deepEqual(await snapshot('demo'), demoBeforeDeletion, 'Eliminar un estudiante real conserva la demostración.');
    await navigate('Panel principal');
    const studentsMetric = page.locator('.stat-card').filter({ hasText: 'Estudiantes registrados' }).locator('.stat-value');
    await poll(async () => await studentsMetric.innerText() === '02', 'panel actualizado tras eliminar una ficha');

    await setClosed(false);
    await navigate('Importar libretas');
    await upload([fixtures[0]]);
    const afterExplicitReimport = await snapshot();
    const reimportedAfterExplicitDelete = afterExplicitReimport.state.pdfs.find(pdf => pdf.hash === original.hash);
    assert.equal(reimportedAfterExplicitDelete.status, 'review', 'El archivo eliminado se puede volver a importar sin una huella duplicada residual.');
    assert.notEqual((await student(pupils[0].code)).id, target.id);
    assertBlankManual(await student(pupils[0].code));
    await confirm(path.basename(fixtures[0]));
    await saved();

    // Leaving a dirty detail triggers a real autosave. Cleanup waits for that
    // operation before displaying counts or accepting destructive confirmation.
    await holdStudentRequest('save', (await student(pupils[0].code)).id);
    await tab('Desempeño').click();
    await page.getByLabel('Días lectivos del periodo').fill('202');
    await navigate('Panel principal');
    await page.getByRole('button', { name: 'Eliminar todos los datos de evaluación', exact: true }).click();
    await poll(() => page.evaluate(() => window.__deleteRequestGate.held), 'autoguardado pendiente antes de limpiar la evaluación');
    assert.equal(await page.getByRole('dialog').count(), 0, 'La limpieza espera el autoguardado de la ficha que acaba de cerrarse.');
    await releaseStudentRequest();
    const evaluationDeleteDialog = page.getByRole('dialog', { name: 'Eliminar todos los datos de evaluación', exact: true });
    await evaluationDeleteDialog.waitFor();
    const beforeEvaluationCancel = await snapshot();
    assert.equal((await student(pupils[0].code)).attendance.required, 202, 'El autoguardado pendiente termina antes de preparar la limpieza.');
    assert.match(await evaluationDeleteDialog.innerText(), new RegExp(`${beforeEvaluationCancel.state.students.length} estudiantes · ${beforeEvaluationCancel.state.pdfs.length} PDF`));
    assert.match(await evaluationDeleteDialog.innerText(), /Datos reales/);
    const confirmClear = evaluationDeleteDialog.getByRole('button', { name: 'Eliminar todos los datos de evaluación', exact: true });
    assert(await confirmClear.isDisabled(), 'La limpieza exige escribir la frase de confirmación.');
    await evaluationDeleteDialog.getByLabel('Escribe ELIMINAR TODO para confirmar', { exact: true }).fill('ELIMINAR');
    assert(await confirmClear.isDisabled(), 'Una frase incompleta no permite eliminar.');
    assert.deepEqual(await snapshot(), beforeEvaluationCancel, 'Una confirmación incorrecta no cambia registros ni originales.');
    await evaluationDeleteDialog.getByLabel('Escribe ELIMINAR TODO para confirmar', { exact: true }).fill('ELIMINAR TODO');
    assert(await confirmClear.isEnabled());
    await evaluationDeleteDialog.getByRole('button', { name: 'Cancelar', exact: true }).last().click();
    await evaluationDeleteDialog.waitFor({ state: 'hidden' });
    assert.deepEqual(await snapshot(), beforeEvaluationCancel, 'Cancelar la limpieza conserva todos los registros y originales.');

    await setClosed(true);
    // A deliberately unreferenced original in the temporary profile verifies
    // that cleanup clears the whole selected file-key range, not just PDF IDs.
    const orphanBlobId = 'acceptance-unreferenced-original';
    await page.evaluate(id => new Promise((resolve, reject) => {
      const open = indexedDB.open('circulos-2027-web', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const transaction = db.transaction('files', 'readwrite');
        transaction.objectStore('files').put(new Blob(['%PDF-1.4\nOrphan acceptance original\n%%EOF'], { type: 'application/pdf' }), `real:${id}`);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    }), orphanBlobId);
    const beforeEvaluationDeletion = await snapshot();
    assert(beforeEvaluationDeletion.state.pdfs.some(pdf => !pdf.studentId), 'La limpieza incluye un PDF sin estudiante vinculado.');
    assert(beforeEvaluationDeletion.files.some(file => beforeEvaluationDeletion.state.pdfs.some(pdf => pdf.id === file.id && !pdf.studentId)), 'El documento sin vínculo conserva su original antes de limpiar.');
    assert(beforeEvaluationDeletion.files.some(file => file.id === orphanBlobId) && !beforeEvaluationDeletion.state.pdfs.some(pdf => pdf.id === orphanBlobId), 'El perfil temporal incluye un blob huérfano sin metadatos PDF.');
    await navigate('Panel principal');
    assert(await page.getByRole('button', { name: 'Eliminar todos los datos de evaluación', exact: true }).isEnabled(), 'El panel permite limpiar una evaluación cerrada.');
    await deletionScreenshot(page.locator('.cleanup-card'), 'delete-evaluation-card');
    await page.getByRole('button', { name: 'Eliminar todos los datos de evaluación', exact: true }).click();
    await evaluationDeleteDialog.waitFor();
    assert.equal(await evaluationDeleteDialog.getByLabel('Escribe ELIMINAR TODO para confirmar', { exact: true }).inputValue(), '', 'Cada apertura requiere una confirmación nueva.');
    await deletionScreenshot(evaluationDeleteDialog, 'delete-evaluation-confirmation');
    await evaluationDeleteDialog.getByLabel('Escribe ELIMINAR TODO para confirmar', { exact: true }).fill('ELIMINAR TODO');
    await confirmClear.click();
    await evaluationDeleteDialog.waitFor({ state: 'hidden' });
    await poll(async () => !(await snapshot()).state.students.length && !(await snapshot()).state.pdfs.length, 'limpieza completa de los datos reales');
    const emptySnapshot = await snapshot();
    assert.deepEqual(emptySnapshot.files, [], 'La limpieza elimina también los blobs de PDF sin vincular.');
    assert.deepEqual(emptySnapshot.state.settings, { ...beforeEvaluationDeletion.state.settings, closed: false }, 'La limpieza conserva todos los parámetros y abre el proceso nuevo.');
    assert.deepEqual(await snapshot('demo'), demoBeforeDeletion, 'La limpieza total de datos reales conserva íntegro el espacio de demostración.');
    const emptyBackup = await backup();
    assert.deepEqual(emptyBackup.state, emptySnapshot.state);
    assert.deepEqual(emptyBackup.files, [], 'El respaldo posterior a la limpieza no contiene originales ni huellas eliminadas.');
    await assertEmptyDashboard();
    await pause(700);
    assert.deepEqual(await snapshot(), emptySnapshot, 'No reaparecen datos por autoguardados o escaneos pendientes.');
    await page.screenshot({ path: '/tmp/circulos-cleanup-empty.png', fullPage: true });

    // Keep every download in the first launch: managed Chromium can SIGTRAP on
    // a download after reopening its persistent profile. Restart is read-only.
    operationsStarted = false;
    await context.setOffline(false);
    await context.close();
    await launch();
    await load();
    assert.deepEqual(await snapshot(), emptySnapshot, 'La limpieza y los parámetros conservados persisten tras reiniciar Chromium.');
    assert.deepEqual(await snapshot('demo'), demoBeforeDeletion, 'El espacio de demostración permanece intacto después del reinicio.');
    await assertEmptyDashboard();
    assert.deepEqual(operationHttpRequests, [], 'Ninguna operación después de cargar el HTML requiere HTTP.');
    assert.deepEqual(requests.filter(request => /^https?:/.test(request.url) && /\/api(?:\/|\?)/.test(new URL(request.url).pathname)), [], 'No se usa una API HTTP.');
    assert.deepEqual(requests.filter(request => /^https?:/.test(request.url) && new URL(request.url).origin !== new URL(appUrl).origin), [], 'No se descargan recursos externos.');
    assert.deepEqual(errors, [], 'Sin excepciones JavaScript.');
    const report = { passed: true, classrooms: ['2.º F', '3.º F', '4.º F', '5.º F'], rejectedClassroom: '6.º F', bimesters: ['I', 'II', 'III'], provisionalImport: true, automaticIdentityWithoutColons: true, editableFullNameConfirmDeleteReview: true, filenameIdentityBeforeConfirmation: true, filenameWithoutCodeOrYear: true, manualNameFallback: true, missingGradesRemainPending: true, existingPdfFilenameRecoveryWithoutOcr: true, recoveryPreservesManualRecords: true, mixedRasterHeaderNativeGrades: true, reportGate: true, automaticAcademicOnly: true, progression: { firstTwo: 1.5, third: 3, score: 93.75, academic: 63.75 }, compactFourBimesterPdf: true, automatic45NotesPreview: true, all10Courses78Notes: true, supplementalCoursesSurviveRescan: true, incompleteReportAutomaticRescanOnce: true, readOnlyAcademicNotes: true, activeOriginalRescanPreservesManualRecords: true, contestOnlyEventTypes: true, threeRequiredContestFields: true, contestScores: { local: 40, regional: 70, national: 100 }, bestCompletedContest: true, scores: { a: 63.75, b: 95.5, c: 100, total: weightedReference }, replacementAndDuplicateCascade: true, exactFileReimport: true, indexedDBPersistenceAfterRestart: true, standaloneInlineHtml: true, offlineOperations: true, httpRequestsAfterLoad: operationHttpRequests, downloads, pageErrors: errors, consoleErrors };
    Object.assign(report, { bimesterWeights: settings.bimesterWeights, weightedAcademicAverages: true, comparableProgressionWithoutAutomaticAdBonus: true, weightedAadArea: 87.5, weightedAadAcademic: 90, weightedGradesAndPdfHashPreserved: true, offeredClassrooms, onlyFiveSectionsOffered: true, legacyClassroomRecordsPreserved: true, explicitNoContestParticipation: true, noContestScoresZeroWithoutEvent: true, noContestConfirmationPersistsAndCanUndo: true, addingContestClearsNoParticipation: true, dimensionWeights: settings.dimensionWeights, commitmentExclusion: true, commitmentRecordsPreservedWhenExcluded: true, manualCircleDecision: true, firstGradeClassroomFiltersAndRankings: true, perAreaPercentageScale: true, indagaAllClassroomsManualValidation: true, indaga4F5FManualValidation: true, indagaBlankGradesPreserved: true, indagaExcludedFromAverages: true, indagaDoesNotTriggerRecovery: true, indagaManualValidationPersistsAfterReload: true, blankCoursesExcludedFromPreviewAndScores: true, ivOnlyCoursesRemainInactive: true, blankRawGradesPreserved: true, blankCoursesDoNotTriggerRescan: true, manualAcademicValidationWithoutGradeEntry: true, partiallyReadCourseRemainsPending: true, threeRequiredIncidentFields: true, unapprovedDiscountRemainsPending: true, threeRequiredFamilyFields: true, optionalFamilyEvidence: true, familyScore: 100, explicitStudentDeletion: true, studentDeletionWhileClosed: true, deletionCancellationPreservesData: true, deletionWaitsForRescanAndAutosave: true, explicitDeletionCascadesVersionsDuplicatesAndBlobs: true, reimportAfterExplicitStudentDeletion: true, totalCleanupRequiresTypedConfirmation: true, totalCleanupWhileClosed: true, totalCleanupRemovesOrphanPdfBlobs: true, totalCleanupPreservesParameters: true, realCleanupPreservesDemo: true, emptyCleanupBackup: true, emptyCleanupDashboardAndRestart: true });
    await fs.writeFile('/tmp/circulos-adjustment-result.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error('Diagnóstico:', JSON.stringify({ operationHttpRequests, errors, consoleErrors }, null, 2));
    if (page && !page.isClosed()) {
      await page.screenshot({ path: '/tmp/circulos-adjustment-error.png', fullPage: true }).catch(() => {});
      console.error((await page.locator('body').innerText().catch(() => '')).slice(-9000));
    }
    throw error;
  } finally {
    if (context) await context.close();
    if (server) await new Promise(resolve => server.close(resolve));
    if (process.env.KEEP_BROWSER_ADJUSTMENT_PROFILE === '1') console.log('Perfil temporal:', directory);
    else await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
