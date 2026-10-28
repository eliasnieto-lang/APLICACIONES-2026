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

// Genuine one-page native PDFs, with identity independent of the filename and
// exactly three explicit cells per competency. No parser/API is mocked.
function makePdf(settings, { code, name, grade, section = 'F', grades = ['C', 'B', 'A'] }) {
  const clean = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[()\\]/g, '\\$&');
  const lines = [`Codigo del estudiante: ${code}`, `Apellidos y nombres: ${name}`, `Grado: ${grade}`, `Seccion: ${section}`, 'Periodo: 2026', 'BIMESTRES I II III'];
  for (const area of settings.areas) lines.push(area.name, ...area.competencies.map(competency => `${competency} ${grades.join(' ')}`));
  const stream = `BT /F1 8 Tf 35 800 Td 13 TL ${lines.map((line, index) => `${index ? 'T* ' : ''}(${clean(line)}) Tj`).join('\n')} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let result = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
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
    await page.getByRole('textbox', { name: 'Buscar estudiante' }).fill(code);
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
    await page.locator('.import-review').getByRole('heading', { name: filename, exact: true }).waitFor();
  };
  const confirm = async filename => {
    await review(filename);
    const name = await page.getByLabel('Apellidos y nombres', { exact: true }).inputValue();
    await page.getByRole('button', { name: 'Confirmar libreta y habilitar evaluación', exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
    await poll(async () => Boolean((await snapshot()).state.students.find(value => value.name === name)?.reportApproval), 'libreta confirmada');
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
      { code: 'AJUSTE-F3-001', name: 'QUISPE TORRES Mateo Andres', grade: 3 },
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
    assert.deepEqual(await page.getByLabel('Aula').locator('option').allTextContents(), ['Selecciona el aula reconocida en el PDF', '2.º F', '3.º F', '4.º F']);
    assert.equal(await page.getByLabel('Aula').inputValue(), '');
    assert(await page.getByRole('button', { name: 'Confirmar libreta y habilitar evaluación', exact: true }).isDisabled());
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

    await navigate('Importar libretas');
    await upload([fixtures[0]]);
    current = await snapshot();
    assert.equal(current.state.students.length, 3);
    const original = current.state.pdfs.find(pdf => pdf.extractedCode === pupils[0].code && pdf.status === 'validated');
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
    const clickPromise = page.getByRole('button', { name: 'Eliminar libreta y ficha vinculada', exact: true }).click();
    const dialog = await dialogPromise;
    assert.match(dialog.message(), new RegExp(pupils[0].code));
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
    const report = { passed: true, classrooms: ['2.º F', '3.º F', '4.º F'], rejectedClassroom: '5.º F', bimesters: ['I', 'II', 'III'], provisionalImport: true, reportGate: true, automaticAcademicOnly: true, progression: { firstTwo: 1.5, third: 3, score: 93.75, academic: 58.75 }, manualCompetition: true, missedRecordReducesParticipation: true, scores: { a: 58.75, b: 95.5, c: 65, total: (58.75 + 95.5 + 65) / 3 }, replacementAndDuplicateCascade: true, exactFileReimport: true, indexedDBPersistenceAfterRestart: true, standaloneInlineHtml: true, offlineOperations: true, httpRequestsAfterLoad: operationHttpRequests, downloads, pageErrors: errors, consoleErrors };
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
