const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');

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
  const snapshot = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('circulos-2027-web', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const transaction = db.transaction(['state', 'files'], 'readonly');
      let state;
      const files = [];
      const request = transaction.objectStore('state').get('real');
      request.onsuccess = () => { state = request.result; };
      const cursor = transaction.objectStore('files').openCursor();
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (!item) return;
        if (String(item.key).startsWith('real:')) files.push({ id: String(item.key).slice(5), size: item.value.size, type: item.value.type });
        item.continue();
      };
      transaction.oncomplete = () => { db.close(); resolve({ state, files }); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  }));
  const student = async code => (await snapshot()).state.students.find(value => value.code === code);
  const navigate = name => page.locator('.sidebar .nav-item').filter({ hasText: name }).click();
  const openStudent = async (code, name) => {
    await navigate('Estudiantes');
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
    assert.equal(await panel.locator('input, select, textarea, [contenteditable=true]').count(), 1, 'La revisión permite corregir únicamente apellidos y nombres.');
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
  const assertBlankManual = value => {
    assert.deepEqual(value.attendance, { required: null, attended: null, punctual: null, exempted: null, validated: false });
    assert.deepEqual(value.discipline, { confirmed: false, incidents: [] });
    assert.deepEqual(value.institutional, []);
    assert.deepEqual(value.family, []);
    assert.equal(value.validated.performance, false);
    assert.equal(value.validated.commitment, false);
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
    assert.equal(await page.getByRole('button', { name: 'Nuevo estudiante', exact: true }).count(), 0, 'El alta parte de una libreta.');

    await navigate('Parámetros');
    await check(page.getByLabel('Confirmo que los pesos, el catálogo y los criterios registrados cuentan con aprobación institucional para esta evaluación.'));
    await page.getByRole('button', { name: 'Guardar parámetros', exact: true }).first().click();
    await poll(async () => (await snapshot()).state.settings.criteriaApproved, 'aprobación de criterios');
    const settings = (await snapshot()).state.settings;
    const pupils = [
      { code: 'AJUSTE-F2-001', name: 'PEREZ RAMOS Lucia Elena', grade: 2 },
      { code: 'AJUSTE-F3-001', name: 'QUISPE TORRES Mateo Andres', grade: 3, identityLayout: 'stacked' },
      { code: 'AJUSTE-F4-001', name: 'ROJAS SALAS Maria Isabel', grade: 4 },
    ];
    const fixtures = [];
    for (let index = 0; index < pupils.length; index++) {
      const destination = path.join(directory, `documento-sin-identidad-${index + 1}.pdf`);
      await fs.writeFile(destination, makePdf(settings, pupils[index]));
      fixtures.push(destination);
    }
    const outside = { code: 'AJUSTE-F5-001', name: 'FUERA DE AULA Estudiante Ficticio', grade: 5 };
    const outsidePath = path.join(directory, 'aula-no-admitida.pdf');
    await fs.writeFile(outsidePath, makePdf(settings, outside));
    await navigate('Importar libretas');
    await upload([...fixtures, outsidePath]);
    let current = await snapshot();
    assert.equal(current.state.pdfs.length, 4);
    assert.equal(current.state.students.length, 3, 'La carga crea solo las tres aulas admitidas.');
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
    const outsideIdentity = await page.locator('.import-identity').innerText();
    assert(!outsideIdentity.includes(outside.code), 'El ingreso no exige mostrar códigos de estudiante.');
    assert.equal(await page.getByLabel('Apellidos y nombres', { exact: true }).inputValue(), outside.name);
    const outsideCohort = page.locator('.import-identity > div').filter({ has: page.locator('dt', { hasText: /^Grado y sección$/ }) }).locator('dd');
    assert.match(await outsideCohort.innerText(), /^5(?:[.º°\s]*(?:de secundaria)?)?\s+F$/, 'El aula ajena se muestra tal como fue reconocida.');
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
    assert.deepEqual(await page.getByLabel('Filtrar por aula').locator('option').allTextContents(), ['Las tres aulas habilitadas', '2.º F', '3.º F', '4.º F']);
    await openStudent(pupils[0].code, pupils[0].name);
    for (const name of ['Académico', 'Desempeño', 'Compromiso']) assert(await tab(name).isEnabled());
    await tab('Académico').click();
    const cells = page.locator('.grade-select');
    assert.equal(await cells.count(), settings.areas.reduce((sum, area) => sum + area.competencies.length * 3, 0));
    assert.deepEqual(await page.locator('.academic-table').first().locator('thead th').allTextContents(), ['Competencia', 'I bim.', 'II bim.', 'III bim.']);
    assert.deepEqual(await cells.evaluateAll(values => values.slice(0, 3).map(value => value.value)), ['C', 'B', 'A']);
    assert.match(await metric('General · G').innerText(), /50[.,]00/);
    assert.match(await metric('Promedio I–II · S1').innerText(), /1[.,]50/);
    assert.match(await metric('Promedio I–II · S1').innerText(), /III · S2: 3[.,]00/);
    assert.match(await metric('Progresión · P').innerText(), /93[.,]75/, 'P compara promedio I–II = 1,50 con III = 3,00.');
    assert.match(await dimension('Académico').innerText(), /58[.,]75/);
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
    const institutional = page.locator('section.detail-records').filter({ has: page.getByRole('heading', { name: 'Participación institucional', exact: true }) });
    assert.equal(await institutional.locator('.commitment-card').count(), 0, 'La confirmación del PDF no inventa actividades.');
    await institutional.getByRole('button', { name: 'Agregar', exact: true }).click();
    let record = institutional.locator('.commitment-card').first();
    assert.equal(await record.getByLabel('Actividad, competencia o compromiso', { exact: true }).inputValue(), '');
    assert.equal(await record.getByLabel('Fecha', { exact: true }).inputValue(), '');
    assert.equal(await record.getByLabel('Exigible para este estudiante').isChecked(), false);
    await record.getByLabel('Actividad, competencia o compromiso', { exact: true }).fill('Olimpiada Ficticia de Matematica 2026');
    await record.getByLabel('Fecha', { exact: true }).fill('2026-10-20');
    await check(record.getByLabel('Exigible para este estudiante'));
    await record.getByRole('button', { name: 'Cumplió', exact: true }).click();
    await record.getByLabel('Ubicación / puesto del estudiante', { exact: true }).fill('2.º puesto');
    await check(record.getByLabel('Participó representando al colegio'));
    await record.getByLabel('Evidencia documental · requerida para validar', { exact: true }).fill('Acta ficticia OLIMPIADA-2026-02.');
    await check(record.getByLabel('He revisado y confirmo este registro')); await saved();
    await institutional.getByRole('button', { name: 'Registrar incumplimiento', exact: true }).click();
    record = institutional.locator('.commitment-card').last();
    await record.getByLabel('Actividad, competencia o compromiso', { exact: true }).fill('Ensayo institucional ficticio no atendido');
    await record.getByLabel('Fecha', { exact: true }).fill('2026-10-22');
    await check(record.getByLabel('Exigible para este estudiante'));
    await record.getByLabel('Evidencia documental · requerida para validar', { exact: true }).fill('Registro ficticio de inasistencia ENSAYO-2026-22.');
    assert(await record.getByLabel('He revisado y confirmo este registro').isDisabled(), 'El incumplimiento requiere una observación explícita.');
    await record.getByLabel('Justificación / observación · requerida para validar', { exact: true }).fill('No asistió a la convocatoria exigible y no presentó justificación.');
    await check(record.getByLabel('He revisado y confirmo este registro')); await saved();
    const family = page.locator('section.detail-records').filter({ has: page.getByRole('heading', { name: 'Compromiso familiar', exact: true }) });
    await family.getByRole('button', { name: 'Agregar', exact: true }).click();
    const familyRecord = family.locator('.commitment-card').first();
    await familyRecord.getByLabel('Actividad o compromiso', { exact: true }).fill('Reunion familiar ficticia de octubre');
    await familyRecord.getByLabel('Fecha', { exact: true }).fill('2026-10-23');
    await check(familyRecord.getByLabel('Exigible para este estudiante'));
    await familyRecord.getByRole('button', { name: 'Cumplió', exact: true }).click();
    await familyRecord.getByLabel('Evidencia documental · requerida para validar', { exact: true }).fill('Acta familiar ficticia FAMILIA-2026-23.');
    await check(familyRecord.getByLabel('He revisado y confirmo este registro')); await saved();
    await check(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Validación final de compromiso', exact: true }) }).getByLabel('Revisado y validado')); await saved();
    const completed = await student(pupils[0].code);
    assert.equal(completed.institutional[0].name, 'Olimpiada Ficticia de Matematica 2026');
    assert.equal(completed.institutional[0].placement, '2.º puesto');
    assert.equal(completed.institutional[0].representingSchool, true);
    assert.equal(completed.institutional[1].status, 'missed');
    assert.equal(completed.institutional[1].validated, true);
    assert(completed.institutional[1].justification && completed.institutional[1].evidence);
    assert.deepEqual(completed.validated, { academic: true, performance: true, commitment: true });
    assert.match(await metric('Participación institucional · PI').innerText(), /50[.,]00/, 'El incumplimiento resta participación.');
    assert.match(await dimension('Compromiso').innerText(), /65[.,]00/);
    assert.match(await page.locator('.detail-total').innerText(), /73[.,]08/);
    assert.match(await page.locator('.detail-total').innerText(), /Validado para ranking/);

    await navigate('Panel principal');
    const exported = await download(() => page.getByRole('button', { name: 'Generar ranking consolidado', exact: true }).click());
    assert(exported.name.endsWith('.xlsx'));
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(exported.content);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['RANKING', 'DETALLE', 'PENDIENTES', 'CONFIGURACIÓN']);
    const ranking = workbook.getWorksheet('RANKING');
    assert.equal(ranking.rowCount, 2, 'Solo la ficha con A, B y C completos entra al ranking.');
    assert.equal(ranking.getCell('B2').value, pupils[0].code);
    assert.equal(ranking.getCell('F2').value, 58.75);
    assert.equal(ranking.getCell('G2').value, 95.5);
    assert.equal(ranking.getCell('H2').value, 65);
    assert(Math.abs(ranking.getCell('I2').value - (58.75 + 95.5 + 65) / 3) < 1e-10);

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
    await confirm(fallbackCase);
    const fallbackStudent = (await snapshot()).state.students.find(value => value.name === 'RAMIREZ FLORES NOMBRE MANUAL');
    assert.equal(fallbackStudent.grade, '4.º de secundaria');assert(fallbackStudent.reportApproval);
    assert.equal(fallbackStudent.validated.academic, false, 'La falta de notas deja A pendiente y permite abrir la ficha.');
    assertBlankManual(fallbackStudent);
    for (const name of ['Académico', 'Desempeño', 'Compromiso']) assert(await tab(name).isEnabled());
    await tab('Académico').click();
    assert.equal(await dimension('Académico').innerText(), 'Pendiente');
    await tab('Desempeño').click();
    assert.equal(await page.getByLabel('Días lectivos del periodo').inputValue(), '');
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

    // Keep every download in the first launch: managed Chromium can SIGTRAP on
    // a download after reopening its persistent profile. Restart is read-only.
    operationsStarted = false;
    await context.setOffline(false);
    await context.close();
    await launch();
    await load();
    assert.deepEqual((await snapshot()).state, finalBackup.state, 'El estado persiste tras reiniciar Chromium.');
    await openStudent(pupils[0].code, pupils[0].name);
    await tab('Académico').click();
    assert.deepEqual(await page.locator('.grade-select').evaluateAll(values => values.slice(0, 3).map(value => value.value)), ['C', 'B', 'A']);
    await tab('Compromiso').click();
    assert.equal(await page.locator('.commitment-card').count(), 0, 'No reaparecen evaluaciones eliminadas tras reiniciar.');
    await review(path.basename(fixtures[0]));
    assert((await page.locator('.import-original iframe').getAttribute('src')).startsWith('blob:'), 'El original reimportado persiste.');
    assert.deepEqual(operationHttpRequests, [], 'Ninguna operación después de cargar el HTML requiere HTTP.');
    assert.deepEqual(requests.filter(request => /^https?:/.test(request.url) && /\/api(?:\/|\?)/.test(new URL(request.url).pathname)), [], 'No se usa una API HTTP.');
    assert.deepEqual(requests.filter(request => /^https?:/.test(request.url) && new URL(request.url).origin !== new URL(appUrl).origin), [], 'No se descargan recursos externos.');
    assert.deepEqual(errors, [], 'Sin excepciones JavaScript.');
    const report = { passed: true, classrooms: ['2.º F', '3.º F', '4.º F'], rejectedClassroom: '5.º F', bimesters: ['I', 'II', 'III'], provisionalImport: true, automaticIdentityWithoutColons: true, editableFullNameConfirmDeleteReview: true, filenameIdentityBeforeConfirmation: true, filenameWithoutCodeOrYear: true, manualNameFallback: true, missingGradesRemainPending: true, existingPdfFilenameRecoveryWithoutOcr: true, recoveryPreservesManualRecords: true, mixedRasterHeaderNativeGrades: true, reportGate: true, automaticAcademicOnly: true, progression: { firstTwo: 1.5, third: 3, score: 93.75, academic: 58.75 }, manualCompetition: true, missedRecordReducesParticipation: true, scores: { a: 58.75, b: 95.5, c: 65, total: (58.75 + 95.5 + 65) / 3 }, replacementAndDuplicateCascade: true, exactFileReimport: true, indexedDBPersistenceAfterRestart: true, standaloneInlineHtml: true, offlineOperations: true, httpRequestsAfterLoad: operationHttpRequests, downloads, pageErrors: errors, consoleErrors };
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
