import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Settings, Student } from '../shared/types.js';
import { parseReportText, type ExtractedReport } from '../shared/pdf-parser.js';
import { mergePdfReadings, needsPdfRecovery, needsRenderedGradeRecovery } from '../shared/pdf-recovery.js';
export { parseReportText } from '../shared/pdf-parser.js';
export type { ExtractedReport } from '../shared/pdf-parser.js';

const run = promisify(execFile);
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_OCR_PAGES = 8;
const LOCAL_TESSDATA = fileURLToPath(new URL('../.tools/tessdata/', import.meta.url));

/** Local extraction; documents never leave this machine. */
export async function extractPdf(filePath: string, settings: Settings, identityOptions: { identityFromFilename?: boolean; forceGrades?: boolean; cohort?: Pick<Student, 'grade' | 'section'> } = {}): Promise<ExtractedReport> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('El PDF debe ser un archivo de hasta 20 MB.');
  const header = (await readFile(filePath)).subarray(0, 1024).toString('latin1');
  if (!header.includes('%PDF-')) throw new Error('El archivo no contiene un documento PDF válido.');
  const directory = await mkdtemp(path.join(tmpdir(), 'circulos-pdf-'));
  const deadline = Date.now() + 180_000;
  const remaining = (max: number) => {
    const value = Math.min(max, deadline - Date.now());
    if (value <= 0) throw new Error('El reconocimiento excedió tres minutos. Divida el PDF o vuelva a procesar una copia más legible.');
    return value;
  };
  const options = (max: number) => ({ encoding: 'utf8' as const, maxBuffer: 4 * 1024 * 1024, timeout: remaining(max), killSignal: 'SIGKILL' as const });
  try {
    let pages: number;
    try {
      const result = await run('pdfinfo', [filePath], options(20_000));
      pages = Number(result.stdout.match(/^Pages:\s*(\d+)/m)?.[1]);
      if (!Number.isInteger(pages) || pages < 1) throw new Error('No se pudo leer el número de páginas.');
      if (pages > MAX_PAGES) throw new Error(`La libreta supera ${MAX_PAGES} páginas; divida el documento antes de importarlo.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('La libreta')) throw error;
      throw new Error('No se pudo abrir el PDF. Compruebe que no esté dañado ni protegido con contraseña.');
    }
    const output = path.join(directory, 'text.txt');
    await run('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, output], options(30_000));
    const text = await readFile(output, 'utf8');
    let languageWarning = '';
    // Native grades and a scanned identity header can coexist on the same page.
    // Inspect raster content only when the native reading still needs recovery.
    const nativeReading = parseReportText(text, settings, identityOptions.cohort);
    let result = nativeReading;
    let rasterTextPossible = false;
    if (needsPdfRecovery(nativeReading, !identityOptions.identityFromFilename, settings, identityOptions.cohort)) {
      const images = await run('pdfimages', ['-list', filePath], options(20_000));
      rasterTextPossible = images.stdout.split('\n').some(line => {
        const columns = line.trim().split(/\s+/);
        if (!/^\d+$/.test(columns[0]) || !['image', 'mask'].includes(columns[2])) return false;
        const width = Number(columns[3]);
        const height = Number(columns[4]);
        const xPpi = Number(columns[12]);
        const yPpi = Number(columns[13]);
        const drawnWidth = width * 72 / xPpi;
        const drawnHeight = height * 72 / yPpi;
        // A narrow scanned header is useful too; a small school logo is not.
        return width >= 180 && height >= 40 && width * height >= 18_000 && xPpi > 0 && yPpi > 0
          && ((drawnWidth >= 120 && drawnHeight >= 20) || drawnWidth * drawnHeight >= 16_000);
      });
    }
    if (rasterTextPossible || needsRenderedGradeRecovery(nativeReading, settings, identityOptions.forceGrades, identityOptions.cohort)) {
      if (pages > MAX_OCR_PAGES) throw new Error(`El PDF escaneado supera ${MAX_OCR_PAGES} páginas. Divídalo para realizar el reconocimiento automático.`);
      const localSpanishAvailable = await access(path.join(LOCAL_TESSDATA, 'spa.traineddata')).then(() => true, () => false);
      const tessdataArgs = localSpanishAvailable ? ['--tessdata-dir', LOCAL_TESSDATA] : [];
      const languages = await run('tesseract', [...tessdataArgs, '--list-langs'], options(10_000));
      const language = /^spa$/m.test(languages.stdout) ? 'spa' : 'eng';
      if (language === 'eng') languageWarning = 'OCR en idioma inglés: el paquete español no está instalado. Revise especialmente nombres y tildes.';
      await run('pdftoppm', ['-f', '1', '-l', String(pages), '-r', '160', '-scale-to', '2200', '-gray', '-png', filePath, path.join(directory, 'page')], options(60_000));
      const images = (await readdir(directory)).filter(name => /^page-\d+\.png$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (images.length !== pages) throw new Error('No fue posible renderizar todas las páginas escaneadas.');
      const results: string[] = [];
      for (const image of images) {
        // Multiple imports must not multiply Tesseract's OpenMP teams and stall each other.
        const result = await run('tesseract', [path.join(directory, image), 'stdout', ...tessdataArgs, '-l', language, '--psm', '6', '-c', 'preserve_interword_spaces=1'], { ...options(45_000), env: { ...process.env, OMP_THREAD_LIMIT: '1' } });
        results.push(result.stdout);
      }
      const ocrText = results.join('\n\f\n');
      result = mergePdfReadings(nativeReading, parseReportText(ocrText, settings, identityOptions.cohort), settings, identityOptions.cohort);
    }
    if (result.ocr) result.warnings.unshift('PDF renderizado: OCR aplicado para completar la lectura automática. Compare las celdas reconocidas con el PDF original.');
    if (languageWarning) result.warnings.push(languageWarning);
    if (!result.text.trim()) result.warnings.push('No se reconoció texto legible. Vuelva a procesar una copia más legible del PDF original.');
    return result;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error('Falta una herramienta de lectura PDF/OCR: instale poppler-utils y tesseract-ocr.');
    if (error instanceof Error && 'killed' in error && error.killed) throw new Error('El reconocimiento tardó demasiado. Divida el PDF o vuelva a procesar una copia más legible.');
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
