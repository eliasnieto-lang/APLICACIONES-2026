import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Settings } from '../shared/types.js';
import { parseReportText, type ExtractedReport } from '../shared/pdf-parser.js';
export { parseReportText } from '../shared/pdf-parser.js';
export type { ExtractedReport } from '../shared/pdf-parser.js';

const run = promisify(execFile);
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_OCR_PAGES = 8;
const LOCAL_TESSDATA = fileURLToPath(new URL('../.tools/tessdata/', import.meta.url));

/** Local extraction; documents never leave this machine. */
export async function extractPdf(filePath: string, settings: Settings): Promise<ExtractedReport> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size > MAX_BYTES) throw new Error('El PDF debe ser un archivo de hasta 20 MB.');
  const header = (await readFile(filePath)).subarray(0, 1024).toString('latin1');
  if (!header.includes('%PDF-')) throw new Error('El archivo no contiene un documento PDF válido.');
  const directory = await mkdtemp(path.join(tmpdir(), 'circulos-pdf-'));
  const deadline = Date.now() + 180_000;
  const remaining = (max: number) => {
    const value = Math.min(max, deadline - Date.now());
    if (value <= 0) throw new Error('El reconocimiento excedió tres minutos. Revise este PDF manualmente.');
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
    let text = await readFile(output, 'utf8');
    let ocr = false;
    let languageWarning = '';
    // Mixed PDFs can contain a long native header while the actual grade table is a scan.
    // Only raster-bearing documents need OCR; a digital-only unrecognized layout remains manual.
    const nativeReading = parseReportText(text, settings);
    const nativeGradesFound = nativeReading.areas.some(area => area.grades.some(row => row.some(Boolean)));
    let rasterGradesPossible = false;
    if (!nativeGradesFound) {
      const images = await run('pdfimages', ['-list', filePath], options(20_000));
      rasterGradesPossible = images.stdout.split('\n').some(line => {
        const dimensions = line.match(/^\s*\d+\s+\d+\s+image\s+(\d+)\s+(\d+)\s/);
        if (!dimensions) return false;
        const width = Number(dimensions[1]);
        const height = Number(dimensions[2]);
        return width >= 400 && height >= 300 && width * height >= 180_000;
      });
    }
    if (!nativeGradesFound && rasterGradesPossible) {
      if (pages > MAX_OCR_PAGES) throw new Error(`El PDF escaneado supera ${MAX_OCR_PAGES} páginas. Divídalo para realizar OCR o transcriba sus datos manualmente.`);
      ocr = true;
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
        const result = await run('tesseract', [path.join(directory, image), 'stdout', ...tessdataArgs, '-l', language, '--psm', '6', '-c', 'preserve_interword_spaces=1'], options(45_000));
        results.push(result.stdout);
      }
      const ocrText = results.join('\n\f\n');
      text = text.trim() ? `${text}\n\n${ocrText}` : ocrText;
    }
    const result = parseReportText(text, settings);
    result.ocr = ocr;
    if (ocr) result.warnings.unshift('Documento escaneado: OCR aplicado. Todas las celdas requieren confirmación visual.');
    if (languageWarning) result.warnings.push(languageWarning);
    if (!text.trim()) result.warnings.push('No se reconoció texto legible. Puede completar la ficha manualmente conservando este original.');
    return result;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error('Falta una herramienta de lectura PDF/OCR: instale poppler-utils y tesseract-ocr.');
    if (error instanceof Error && 'killed' in error && error.killed) throw new Error('El reconocimiento tardó demasiado. Divida el PDF o revise sus datos manualmente.');
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
