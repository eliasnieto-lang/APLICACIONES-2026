const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const ExcelJS = require('exceljs');

// Browser-only build; no Express/SQLite process or API is used.
// Build web/index.html, then serve ONLY web/ with a static HTTP server:
// python3 -m http.server 4120 --bind 127.0.0.1 --directory web
// APP_WEB_URL=http://127.0.0.1:4120/index.html node tests/browser-web.cjs
// All mutations occur in a fresh temporary Chromium profile, never institutional data.
const root = path.resolve(__dirname, '..');
const appUrl = process.env.APP_WEB_URL || 'http://127.0.0.1:4120/index.html';
const chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(check, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await pause(100); }
  throw new Error(`No se confirmó: ${label}`);
}
function makePdf(settings, code, name, grade = 'A') {
  const clean = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[()\\]/g, '\\$&');
  const lines = [`Codigo: ${code}`, `Estudiante: ${name}`, 'Grado: 3', 'Seccion: A', 'Periodo: 2026'];
  for (const area of settings.areas) lines.push(area.name, ...area.competencies.map(c => `${c} ${grade} ${grade} ${grade} ${grade}`));
  const stream = `BT /F1 9 Tf 40 790 Td 12 TL ${lines.map((s, i) => `${i ? 'T* ' : ''}(${clean(s)}) Tj`).join('\n')} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

(async () => {
  await fs.access(path.join(root, 'web/index.html')); // A missing build is a failure, never a mocked page.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'circulos-web-browser-'));
  const profile = path.join(directory, 'profile');
  const requests = [];
  const failedRequests = [];
  const pageErrors = [];
  const consoleErrors = [];
  let context;
  let page;
  let downloads = 0;
  let fileOpening = 'no comprobado';
  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, { executablePath: chromiumPath, headless: true, viewport: { width: 1440, height: 1100 }, acceptDownloads: true, args: ['--no-sandbox'] });
    context.on('request', request => requests.push({ url: request.url(), type: request.resourceType(), method: request.method() }));
    context.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
    page = context.pages()[0] || await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  };
  const saved = async () => {
    await pause(120); // Confirmation checkboxes flush pending values before applying validation.
    await poll(async () => (await page.locator('.detail-save-state').innerText()).includes('Todos los cambios guardados'), 'autoguardado IndexedDB');
  };
  const check = async locator => { if (!(await locator.isChecked())) { await locator.click(); await poll(() => locator.isChecked(), 'confirmación de casilla'); } };
  const download = async trigger => {
    const [result] = await Promise.all([page.waitForEvent('download'), trigger()]);
    const destination = path.join(directory, `${++downloads}-${result.suggestedFilename()}`);
    await result.saveAs(destination);
    return { name: result.suggestedFilename(), path: destination, content: await fs.readFile(destination) };
  };
  const backup = async () => JSON.parse((await download(() => page.getByRole('button', { name: 'Descargar copia de seguridad', exact: true }).click())).content.toString());
  const navigate = async name => {
    const sidebarItem = page.locator('.sidebar .nav-item').filter({ hasText: name });
    if (await sidebarItem.count()) await sidebarItem.click();
    else await page.getByRole('button', { name, exact: true }).click();
  };
  const newStudent = async (code, name) => {
    await navigate('Panel principal');
    await page.getByRole('button', { name: 'Nuevo estudiante', exact: true }).click();
    await page.getByLabel('Nombre completo').fill(name);
    await page.getByLabel('Código de estudiante', { exact: true }).fill(code);
    await page.getByRole('button', { name: 'Crear estudiante', exact: true }).click();
    await page.getByRole('heading', { name, exact: true }).waitFor();
  };
  const upload = async files => {
    await page.locator('input[type=file][multiple]').first().setInputFiles(files);
    await poll(async () => {
      const rows = await page.locator('.import-queue-row').allTextContents();
      return rows.length === files.length && rows.every(text => text.includes('Procesado'));
    }, `procesamiento de ${files.length} PDF`, 180000);
  };
  try {
    await launch();
    if (process.env.CHECK_FILE_OPEN === '1') {
      try {
        await page.goto(pathToFileURL(path.join(root, 'web/index.html')).href);
        await page.getByRole('heading', { name: /Una mirada integral al talento/ }).waitFor({ timeout: 15000 });
        fileOpening = 'abrió correctamente';
      } catch (error) {
        if (/ERR_BLOCKED_BY_ADMINISTRATOR/.test(String(error))) fileOpening = 'bloqueado por la política de Chromium; no se intentó eludir';
        else throw error;
      }
      // A denied file navigation can schedule chrome-error after goto rejects.
      // Use a fresh page for the independent, permitted static HTTP workflow.
      await page.close();
      page = await context.newPage();
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    }
    await page.goto(appUrl);
    await page.getByRole('heading', { name: /Una mirada integral al talento/ }).waitFor();
    assert.equal(await page.evaluate(() => typeof indexedDB), 'object');
    assert((await page.evaluate(() => indexedDB.databases())).length > 0, 'La base IndexedDB fue creada.');
    await context.setOffline(true);
    const initial = await backup();
    assert.equal(initial.state.students.length, 0, 'Perfil temporal nuevo y sin datos reales.');
    await navigate('Parámetros');
    await check(page.getByLabel('Confirmo que los pesos, el catálogo y los criterios registrados cuentan con aprobación institucional para esta evaluación.'));
    await page.getByRole('button', { name: 'Guardar parámetros', exact: true }).first().click();
    await pause(400);
    assert.equal((await backup()).state.settings.criteriaApproved, true);
    await newStudent('WEB-MANUAL-001', 'Estudiante Ficticio Web Manual');
    await navigate('Desempeño');
    for (const [label, value] of [['Días lectivos del periodo', '200'], ['Días formalmente eximidos', '0'], ['Días asistidos', '190'], ['Ingresos puntuales', '171']]) await page.getByLabel(label).fill(value);
    await check(page.getByLabel('He contrastado y validado la asistencia')); await saved();
    await check(page.getByLabel('Confirmar “Sin incidencias”')); await saved();
    await check(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Validación final de desempeño' }) }).getByLabel('Revisado y validado')); await saved();
    await navigate('Compromiso');
    for (const heading of ['Participación institucional', 'Compromiso familiar']) {
      const card = page.locator('section.detail-records').filter({ has: page.getByRole('heading', { name: heading, exact: true }) });
      await card.getByRole('button', { name: 'Agregar', exact: true }).click();
      await card.getByRole('button', { name: 'Cumplió', exact: true }).click();
      await card.getByLabel(/Evidencia/).fill('Acta ficticia de la prueba web.');
      await check(card.getByLabel('He revisado y confirmo este registro')); await saved();
    }
    await check(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Validación final de compromiso' }) }).getByLabel('Revisado y validado')); await saved();
    await navigate('Académico');
    const cells = page.locator('.grade-select');
    assert.equal(await cells.count(), 60);
    for (let index = 0; index < 60; index++) await cells.nth(index).selectOption('A');
    const areas = page.getByLabel('Confirmo que todas las calificaciones de esta área coinciden con la libreta');
    for (let index = 0; index < await areas.count(); index++) { await check(areas.nth(index)); await saved(); }
    await check(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Validación final académica' }) }).getByLabel('Revisado y validado')); await saved();
    const complete = await backup();
    const manual = complete.state.students.find(student => student.code === 'WEB-MANUAL-001');
    assert.deepEqual(manual.validated, { academic: true, performance: true, commitment: true });
    assert(manual.history.length > 0);
    const results = page.locator('.detail-results');
    assert.match(await results.innerText(), /75[.,]00/);
    assert.match(await results.innerText(), /95[.,]50/);
    assert.match(await results.innerText(), /100[.,]00/);

    await context.setOffline(false);
    await page.reload();
    await navigate('Estudiantes');
    await page.getByRole('textbox', { name: 'Buscar estudiante' }).fill('WEB-MANUAL-001');
    await page.getByRole('button', { name: /Estudiante Ficticio Web Manual/ }).click();
    assert.equal(await page.locator('.grade-select').first().inputValue(), 'A');
    assert.deepEqual((await backup()).state, complete.state, 'IndexedDB preserva todo el estado después de recargar.');

    const settings = complete.state.settings;
    const fixtures = [];
    for (let index = 1; index <= 10; index++) {
      const destination = path.join(directory, `libreta-web-${index}.pdf`);
      await fs.writeFile(destination, makePdf(settings, `WEB-PDF-${String(index).padStart(2, '0')}`, `Estudiante Ficticio PDF ${index}`));
      fixtures.push(destination);
    }
    await navigate('Importar libretas');
    await upload(fixtures);
    let snapshot = await backup();
    assert.equal(snapshot.state.pdfs.length, 10);
    assert.equal(snapshot.state.students.length, 11);
    assert(snapshot.state.pdfs.every(pdf => pdf.status === 'review' && !pdf.ocr));
    assert(snapshot.state.students.filter(student => student.code.startsWith('WEB-PDF-')).every(student => student.academic[0].grades[0][0] === 'A' && !student.validated.academic));
    const originalFrame = page.locator('.import-original iframe');
    const originalUrl = await originalFrame.getAttribute('src');
    assert(originalUrl.startsWith('blob:'), 'La vista previa usa el PDF local conservado.');
    assert.equal(await page.evaluate(async url => new TextDecoder().decode((await (await fetch(url)).arrayBuffer()).slice(0, 5)), originalUrl), '%PDF-');
    await upload([fixtures[0]]);
    snapshot = await backup();
    assert.equal(snapshot.state.students.length, 11);
    assert.equal(snapshot.state.pdfs.filter(pdf => pdf.status === 'duplicate').length, 1);
    const previous = snapshot.state.pdfs.find(pdf => pdf.extractedCode === 'WEB-PDF-01' && pdf.status !== 'duplicate');
    const replacement = path.join(directory, 'libreta-web-reemplazo.pdf');
    await fs.writeFile(replacement, makePdf(settings, 'WEB-PDF-01', 'Estudiante Ficticio PDF 1', 'B'));
    await upload([replacement]);
    await page.getByLabel('¿Reemplaza una libreta anterior?').selectOption(previous.id);
    await page.getByRole('button', { name: 'Reemplazar y conservar historial' }).click();
    await pause(500);
    snapshot = await backup();
    assert.equal(snapshot.state.pdfs.find(pdf => pdf.id === previous.id).status, 'replaced');
    assert(snapshot.state.pdfs.some(pdf => pdf.replacesId === previous.id));

    await upload([path.join(__dirname, 'fixtures', 'mixed.pdf')]);
    snapshot = await backup();
    const mixed = snapshot.state.pdfs.find(pdf => pdf.name === 'mixed.pdf');
    assert(mixed, 'El documento mixto fue persistido.');
    assert.equal(mixed.ocr, true, 'La cabecera digital no impide reconocer las notas escaneadas.');
    assert.match(mixed.text, /Ana\s+Perez/i);
    assert.equal(mixed.areas.find(area => area.areaId === 'matematica').grades[0][0], 'A');
    assert.equal(mixed.areas[0].validated, false);

    const template = await download(() => page.getByRole('link', { name: 'Descargar plantilla CSV' }).click());
    assert.match(template.content.toString(), /codigo,dias,eximidos,asistencias,puntuales/);
    await navigate('Panel principal');
    const excel = await download(() => page.getByRole('button', { name: 'Generar ranking consolidado' }).click());
    assert(excel.name.endsWith('.xlsx'));
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(excel.content);
    assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['RANKING', 'DETALLE', 'PENDIENTES', 'CONFIGURACIÓN']);
    const ranking = workbook.getWorksheet('RANKING');
    assert.equal(ranking.rowCount, 2);
    assert.equal(ranking.getCell('B2').value, 'WEB-MANUAL-001');
    assert.equal(ranking.getCell('F2').value, 75);
    assert.equal(ranking.getCell('G2').value, 95.5);
    assert.equal(ranking.getCell('H2').value, 100);
    assert(Math.abs(ranking.getCell('I2').value - (75 + 95.5 + 100) / 3) < 1e-10);
    assert(workbook.getWorksheet('PENDIENTES').rowCount >= 11);
    assert.equal(workbook.getWorksheet('DETALLE').getCell('B2').value, manual.name);

    const beforeRestore = await backup();
    assert.equal(beforeRestore.files.length, beforeRestore.state.pdfs.length);
    for (const file of beforeRestore.files) {
      const record = beforeRestore.state.pdfs.find(pdf => pdf.id === file.id);
      const content = Buffer.from(file.content, 'base64');
      assert.equal(content.length, record.size);
      assert.equal(createHash('sha256').update(content).digest('hex'), record.hash);
    }
    const restorePath = path.join(directory, 'respaldo-web.json');
    await fs.writeFile(restorePath, JSON.stringify(beforeRestore));
    await newStudent('WEB-RESTORE-MARKER', 'Estudiante Ficticio Temporal Restauración');
    assert.equal((await backup()).state.students.length, beforeRestore.state.students.length + 1);
    await page.locator('input[type=file][accept=".json,application/json"]').setInputFiles(restorePath);
    await page.getByRole('button', { name: 'Restaurar datos', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    const restored = await backup();
    assert.deepEqual(restored.state, beforeRestore.state);
    assert.deepEqual(restored.files, beforeRestore.files);
    await page.getByRole('button', { name: 'Explorar demostración' }).click();
    await page.locator('.demo-banner').waitFor();
    const demo = await backup();
    assert(demo.state.students.length >= 8);
    assert(!demo.state.students.some(student => student.code === 'WEB-MANUAL-001'));
    await page.screenshot({ path: '/tmp/circulos-web.png', fullPage: true });
    await page.getByRole('button', { name: /Ir a datos reales/ }).click();
    assert.deepEqual((await backup()).state, beforeRestore.state);
    // Reopen the actual profile after all download checks. This managed Chromium build
    // crashes with SIGTRAP on a download in its second launch; persistence is independently
    // checked through the visible UI and the real IndexedDB state, without another download.
    await context.setOffline(false);
    await context.close();
    await launch();
    await page.goto(appUrl);
    await page.getByRole('heading', { name: /Una mirada integral al talento/ }).waitFor();
    await context.setOffline(true);
    const persisted = await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('circulos-2027-web', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, transaction = db.transaction('state', 'readonly'), request = transaction.objectStore('state').get('real');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      };
    }));
    assert.deepEqual(persisted, beforeRestore.state, 'El estado real IndexedDB permanece íntegro después de reiniciar Chromium.');
    await navigate('Estudiantes');
    await page.getByRole('textbox', { name: 'Buscar estudiante' }).fill('WEB-MANUAL-001');
    await page.getByRole('button', { name: /Estudiante Ficticio Web Manual/ }).click();
    assert.equal(await page.locator('.grade-select').first().inputValue(), 'A');
    assert.match(await page.locator('.detail-results').innerText(), /75[.,]00/);
    await navigate('Importar libretas');
    await page.getByRole('button', { name: 'Revisar', exact: true }).first().click();
    assert((await page.locator('.import-original iframe').getAttribute('src')).startsWith('blob:'), 'Los PDF originales persistidos vuelven a estar disponibles después del reinicio.');
    const httpApi = requests.filter(request => /^https?:/.test(request.url) && /\/api(?:\/|\?)/.test(new URL(request.url).pathname));
    assert.deepEqual(httpApi, [], 'Ninguna operación solicita una API HTTP.');
    const external = requests.filter(request => /^https?:/.test(request.url) && new URL(request.url).origin !== new URL(appUrl).origin);
    assert.deepEqual(external, [], 'PDF y OCR funcionan sin descargar recursos externos.');
    assert.deepEqual(pageErrors, [], 'Sin excepciones JavaScript.');
    const report = { passed: true, appUrl, fileOpening, indexedDB: true, browserRestartPersistence: true, restartEvidence: 'UI y lectura de IndexedDB real; sin descargas en segunda sesión por SIGTRAP de Chromium gestionado', offlineManualWorkflow: true, nativePdfs: 10, mixedOcr: true, duplicateAndReplacement: true, xlsxSheets: workbook.worksheets.map(sheet => sheet.name), backupRestore: true, demoIsolated: true, httpApiRequests: httpApi, externalHttpRequests: external, failedRequests, consoleErrors, pageErrors, downloads };
    await fs.writeFile('/tmp/circulos-web-result.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error('Diagnóstico navegador:', JSON.stringify({ appUrl, fileOpening, failedRequests, pageErrors, consoleErrors }, null, 2));
    if (page && !page.isClosed()) { await page.screenshot({ path: '/tmp/circulos-web-error.png', fullPage: true }).catch(() => {}); console.error((await page.locator('body').innerText().catch(() => '')).slice(-6500)); }
    throw error;
  } finally {
    if (context) await context.close();
    if (process.env.KEEP_BROWSER_WEB_PROFILE === '1') console.log('Perfil temporal conservado:', directory);
    else await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
