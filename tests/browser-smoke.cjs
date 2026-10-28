const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');

// Use an isolated acceptance instance with a temporary DATA_DIR, never the main instance.
// Example after npm run build: PORT=4117 DATA_DIR=/tmp/circulos-browser-test npm start
// Then: node tests/browser-smoke.cjs (requires Playwright and Chromium).
// A single uniquely named fictitious record is created and deleted; other data is preserved.
const base = process.env.APP_URL || 'http://127.0.0.1:4117';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(check, label, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await check()) return; await pause(100); }
  throw new Error(`No se confirmó: ${label}`);
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const api = async (route, options) => {
    const response = await fetch(`${base}/api${route}`, options);
    if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const code = `QA-BROWSER-${Date.now()}`;
  let studentId;
  const initial = await api('/state');
  assert.equal(initial.settings.closed, false, 'La prueba necesita evaluación real abierta.');
  await fs.writeFile('/tmp/circulos-browser-before.json', JSON.stringify(await api('/backup')));
  const readStudent = async () => (await api('/state')).students.find(s => s.id === studentId);
  const saved = async () => { await pause(120); try { await poll(async () => (await page.locator('.detail-save-state').innerText()).includes('Todos los cambios guardados'), 'autoguardado'); } catch (error) { console.error('SAVE STATE', await page.locator('.detail-save-state').innerText(), 'ALERTS', await page.locator('.alert').allTextContents()); await page.screenshot({ path: '/tmp/circulos-save-error.png', fullPage: true }); throw error; } };
  const check = async locator => { if (!(await locator.isChecked())) { await locator.click(); await poll(async () => locator.isChecked(), 'confirmación de casilla'); } };
  try {
    await page.goto(base);
    await page.getByRole('button', { name: 'Nuevo estudiante', exact: true }).click();
    await page.getByLabel('Nombre completo').fill('QA Estudiante Ficticio Navegador');
    await page.getByLabel('Código de estudiante', { exact: true }).fill(code);
    await page.getByRole('button', { name: 'Crear estudiante' }).click();
    await page.getByRole('heading', { name: 'QA Estudiante Ficticio Navegador', exact: true }).waitFor();
    studentId = (await api('/state')).students.find(s => s.code === code).id;

    await page.getByRole('button', { name: 'Desempeño', exact: true }).click();
    await page.getByLabel('Días lectivos del periodo').fill('200');
    await page.getByLabel('Días formalmente eximidos').fill('0');
    await page.getByLabel('Días asistidos').fill('190');
    await page.getByLabel('Ingresos puntuales').fill('171');
    await check(page.getByLabel('He contrastado y validado la asistencia'));
    await saved();
    await check(page.getByLabel('Confirmar “Sin incidencias”'));
    await saved();
    await check(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Validación final de desempeño' }) }).getByLabel('Revisado y validado'));
    await saved();
    let student = await readStudent();
    assert.equal(student.attendance.validated, true);
    assert.equal(student.discipline.confirmed, true);
    assert.equal(student.validated.performance, true);

    await page.getByRole('button', { name: 'Compromiso', exact: true }).click();
    for (const section of ['Participación institucional', 'Compromiso familiar']) {
      const card = page.locator('section.detail-records').filter({ has: page.getByRole('heading', { name: section, exact: true }) });
      await card.getByRole('button', { name: 'Agregar', exact: true }).click();
      await card.getByRole('button', { name: 'Cumplió', exact: true }).click();
      await card.getByLabel(/Evidencia documental/).fill('Registro de prueba ficticio QA.');
      await check(card.getByLabel('He revisado y confirmo este registro'));
      await saved();
    }
    await check(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Validación final de compromiso' }) }).getByLabel('Revisado y validado'));
    await saved();
    student = await readStudent();
    assert.equal(student.validated.commitment, true);

    await page.getByRole('button', { name: 'Académico', exact: true }).click();
    const gradeSelects = page.locator('.grade-select');
    const gradeCount = await gradeSelects.count();
    assert(gradeCount >= 20, 'Hay casillas académicas esperadas.');
    for (let i = 0; i < gradeCount; i++) await gradeSelects.nth(i).selectOption('A');
    const confirms = page.getByLabel('Confirmo que todas las calificaciones de esta área coinciden con la libreta');
    for (let i = 0; i < await confirms.count(); i++) { await check(confirms.nth(i)); await saved(); }
    await check(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Validación final académica' }) }).getByLabel('Revisado y validado'));
    await saved();
    student = await readStudent();
    assert.equal(student.validated.academic, true);
    assert(student.academic.every(a => a.validated));
    assert(student.history.length > 0, 'Las correcciones generan historial.');
    await page.screenshot({ path: '/tmp/circulos-ficha.png', fullPage: true });
    await gradeSelects.first().selectOption('B');
    await saved();
    student = await readStudent();
    assert.equal(student.validated.academic, false, 'Editar notas invalida la revisión académica.');
    assert.equal(student.validated.performance, true, 'La edición académica no invalida otra dimensión.');
    assert.equal(student.validated.commitment, true);
    await page.reload();
    await page.getByRole('button', { name: 'Estudiantes', exact: true }).click();
    const search = page.getByRole('textbox', { name: 'Buscar estudiante' });
    await search.pressSequentially(code, { delay: 20 });
    assert.equal(await search.inputValue(), code, 'La búsqueda conserva todos los caracteres.');
    assert.equal(await search.evaluate(input => document.activeElement === input), true, 'La búsqueda conserva el foco.');
    await page.getByRole('button', { name: new RegExp('QA Estudiante Ficticio Navegador') }).click();
    assert.equal(await page.locator('.grade-select').first().inputValue(), 'B', 'Persistencia tras recargar.');

    await page.getByRole('button', { name: 'Panel principal', exact: true }).click();
    const [rankingDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Generar ranking consolidado' }).click()]);
    assert(rankingDownload.suggestedFilename().endsWith('.xlsx'));
    const [backupDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Descargar copia de seguridad', exact: true }).click()]);
    assert(backupDownload.suggestedFilename().endsWith('.json'));

    await page.getByRole('button', { name: 'Explorar demostración' }).click();
    await poll(async () => (await page.locator('.demo-banner').count()) === 1, 'demostración');
    const demo = await api('/state?dataset=demo');
    assert(demo.students.length >= 8);
    assert(!demo.students.some(s => s.code === code), 'Real y demo están separados.');
    await page.screenshot({ path: '/tmp/circulos-dashboard.png', fullPage: true });
    await page.getByRole('button', { name: 'Parámetros', exact: true }).click();
    await page.getByRole('heading', { name: 'Parámetros institucionales' }).waitFor();
    const year = page.getByLabel('Año de evaluación');
    await year.fill(String(demo.settings.year + 1));
    assert.equal(await page.getByRole('button', { name: 'Guardar parámetros', exact: true }).first().isEnabled(), true);
    await year.fill(String(demo.settings.year));
    await page.screenshot({ path: '/tmp/circulos-parametros.png', fullPage: true });
    await page.getByRole('button', { name: 'Importar libretas', exact: true }).click();
    await page.getByRole('heading', { name: 'Importación masiva' }).waitFor();
    assert.equal(await page.locator('input[type=file][multiple]').count(), 2);
    await page.screenshot({ path: '/tmp/circulos-importacion.png', fullPage: true });
    await page.getByRole('button', { name: 'Panel principal', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await pause(700);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Sin desbordamiento global a390px.');
    await page.screenshot({ path: '/tmp/circulos-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Abrir menú' }).click();
    await page.getByRole('button', { name: 'Estudiantes', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Buscar estudiante' }).isVisible(), true);
    assert.deepEqual(errors, [], 'Sin excepciones JavaScript.');
    console.log(JSON.stringify({ passed: true, academicCells: gradeCount, validatedDimensions: 3, persistence: true, downloads: 2, mobileWidth: 390, consoleErrors: errors }, null, 2));
  } finally {
    if (!studentId) studentId = (await api('/state')).students.find(s => s.code === code)?.id;
    if (studentId) await api(`/students/${studentId}`, { method: 'DELETE' });
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
