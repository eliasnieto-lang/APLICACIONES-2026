import { GlobalWorkerOptions, OPS, Util, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import { createWorker, OEM, PSM, type Worker as OcrWorker } from 'tesseract.js';
import pdfWorkerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw';
import ocrWorkerSource from 'tesseract.js/dist/worker.min.js?raw';
import ocrCoreSource from 'tesseract.js-core/tesseract-core-lstm.wasm.js?raw';
import spanishModelUrl from '../../.tools/tessdata/spa.traineddata?url&inline';
import { parseReportText, type ExtractedReport } from '../../shared/pdf-parser';
import { layoutPdfText, mergePdfReadings, needsPdfRecovery, needsRenderedGradeRecovery } from '../../shared/pdf-recovery';
import type { Settings } from '../../shared/types';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 20;
const MAX_OCR_PAGES = 8;
const MAX_TEXT = 4 * 1024 * 1024;
const MAX_DURATION = 180_000;

interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

function timed<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), Math.max(1, milliseconds));
    promise.then(value => { window.clearTimeout(timer); resolve(value); }, error => { window.clearTimeout(timer); reject(error); });
  });
}

/** Rebuild rows from PDF text coordinates rather than concatenating the drawing order. */
function layoutText(items: unknown[], viewportTransform: number[]): string {
  const words = items.filter((item): item is PdfTextItem => typeof item === 'object' && item !== null && 'str' in item && typeof item.str === 'string' && item.str.trim().length > 0)
    .map(item => {
      const transform = Util.transform(viewportTransform, item.transform);
      return { text: item.str, x: transform[4], y: transform[5], width: item.width, height: Math.max(4, item.height || Math.abs(transform[3])) };
    });
  return layoutPdfText(words);
}

/** Ignore small logos; a wide header or a page/table scan can contain missing fields. */
function hasReadableRaster(operators: { fnArray: number[]; argsArray: unknown[][] }): boolean {
  let transform = [1, 0, 0, 1, 0, 0];
  const saved: number[][] = [];
  const readable = (pixelsWide: number, pixelsHigh: number, matrix: number[]): boolean => {
    const width = Math.hypot(matrix[0], matrix[1]);
    const height = Math.hypot(matrix[2], matrix[3]);
    return pixelsWide >= 180 && pixelsHigh >= 40 && pixelsWide * pixelsHigh >= 18_000
      && ((width >= 120 && height >= 20) || width * height >= 16_000);
  };
  for (let index = 0; index < operators.fnArray.length; index++) {
    const operator = operators.fnArray[index];
    const args = operators.argsArray[index];
    if (operator === OPS.save) saved.push([...transform]);
    else if (operator === OPS.restore) transform = saved.pop() || [1, 0, 0, 1, 0, 0];
    else if (operator === OPS.transform) transform = Util.transform(transform, args as number[]);
    else if ([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(operator)) {
      const inline = args[0] as { width?: number; height?: number } | undefined;
      const pixelsWide = operator === OPS.paintImageXObject ? Number(args[1]) : Number(inline?.width);
      const pixelsHigh = operator === OPS.paintImageXObject ? Number(args[2]) : Number(inline?.height);
      if (readable(pixelsWide, pixelsHigh, transform)) return true;
    } else if (operator === OPS.paintImageXObjectRepeat) {
      // PDF.js folds repeated image draws into one operation and omits their pixel sizes.
      const repeated = Util.transform(transform, [Number(args[1]), 0, 0, Number(args[2]), 0, 0]);
      if (readable(Infinity, Infinity, repeated)) return true;
    } else if (operator === OPS.paintImageMaskXObjectRepeat) {
      const mask = args[0] as { width: number; height: number };
      const repeated = Util.transform(transform, [...args.slice(1, 5).map(Number), 0, 0]);
      if (readable(mask.width, mask.height, repeated)) return true;
    } else if (operator === OPS.paintImageMaskXObjectGroup) {
      const images = args[0] as { width: number; height: number; transform: number[] }[];
      if (images.some(image => readable(image.width, image.height, Util.transform(transform, image.transform)))) return true;
    }
  }
  return false;
}

function modelBytes(): Uint8Array {
  // ?url&inline is enforced during the browser build: no file:// fetch or network is needed.
  const comma = spanishModelUrl.indexOf(',');
  if (!spanishModelUrl.startsWith('data:') || comma < 0) throw new Error('El archivo de la aplicación no incluye el modelo OCR español. Vuelva a generar la versión portátil.');
  const encoded = spanishModelUrl.slice(comma + 1);
  const binary = spanishModelUrl.slice(0, comma).includes(';base64') ? atob(encoded) : decodeURIComponent(encoded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function makeOcrWorkerSource(): string {
  // Tesseract.js 6.0.1 accepts inline Lang objects for loadLanguage but its initialize handler
  // incorrectly uses their binary data as a language name. Normalize only that message, before
  // the official worker listener runs; do not change the model or third-party source.
  return `self.addEventListener('message',function(event){var message=event.data;if(message&&message.action==='initialize'&&message.payload&&Array.isArray(message.payload.langs)){message.payload.langs=message.payload.langs.map(function(lang){return typeof lang==='string'?lang:lang.code;});}});\nsetTimeout(function(){self.close();},185000);\n${ocrWorkerSource}`;
}

/** Browser-only PDF and Spanish OCR. All document processing stays on this device. */
export async function extractBrowserPdf(file: Blob, settings: Settings, options: { identityFromFilename?: boolean; forceGrades?: boolean } = {}): Promise<ExtractedReport> {
  if (file.size > MAX_BYTES) throw new Error('El PDF debe ser un archivo de hasta 20 MB.');
  const data = new Uint8Array(await file.arrayBuffer());
  const header = new TextDecoder('latin1').decode(data.subarray(0, 1024));
  if (!header.includes('%PDF-')) throw new Error('El archivo no contiene un documento PDF válido.');
  if (typeof Worker === 'undefined') throw new Error('Este navegador no admite los trabajadores necesarios para leer PDF. Use una versión actual de Chrome, Edge o Firefox.');

  const deadline = Date.now() + MAX_DURATION;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error('El reconocimiento excedió tres minutos. Divida el PDF o vuelva a procesar una copia más legible.');
    return value;
  };
  const pdfWorkerUrl = URL.createObjectURL(new Blob([pdfWorkerSource], { type: 'text/javascript' }));
  const pdfWorker = new Worker(pdfWorkerUrl, { type: 'module' });
  GlobalWorkerOptions.workerPort = pdfWorker;
  const task = getDocument({ data, isEvalSupported: false, useSystemFonts: true, disableFontFace: true, useWorkerFetch: false, useWasm: false, maxImageSize: 20_000_000, stopAtErrors: true });
  let documentPdf: PDFDocumentProxy | undefined;
  let ocrWorker: OcrWorker | undefined;
  let ocrWorkerUrl: string | undefined;
  let ocrCoreUrl: string | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    documentPdf = await timed(task.promise, Math.min(30_000, remaining()), 'No se pudo abrir el PDF a tiempo. Compruebe que no esté dañado ni protegido con contraseña.');
    if (documentPdf.numPages > MAX_PAGES) throw new Error(`La libreta supera ${MAX_PAGES} páginas; divida el documento antes de importarlo.`);
    const texts: string[] = [];
    for (let i = 1; i <= documentPdf.numPages; i++) {
      const page = await documentPdf.getPage(i);
      const content = await timed(page.getTextContent(), Math.min(20_000, remaining()), 'No se pudo leer una página del PDF a tiempo.');
      texts.push(layoutText(content.items, page.getViewport({ scale: 1 }).transform));
      if (texts.reduce((length, text) => length + text.length, 0) > MAX_TEXT) throw new Error('El PDF contiene demasiado texto para una libreta. Divídalo antes de importarlo.');
    }
    const nativeText = texts.join('\n\f\n');
    const nativeReading = parseReportText(nativeText, settings);
    let rasterPresent = false;
    if (needsPdfRecovery(nativeReading, !options.identityFromFilename)) {
      for (let i = 1; i <= documentPdf.numPages && !rasterPresent; i++) {
        const page = await documentPdf.getPage(i);
        const operators = await timed(page.getOperatorList(), Math.min(20_000, remaining()), 'No se pudieron inspeccionar las imágenes del PDF a tiempo.');
        rasterPresent = hasReadableRaster(operators);
      }
    }
    const renderGrades = needsRenderedGradeRecovery(nativeReading, settings, options.forceGrades);
    if (!rasterPresent && !renderGrades) return nativeReading;
    if (documentPdf.numPages > MAX_OCR_PAGES) throw new Error(`El PDF escaneado supera ${MAX_OCR_PAGES} páginas. Divídalo para realizar el reconocimiento automático.`);

    ocrWorkerUrl = URL.createObjectURL(new Blob([makeOcrWorkerSource()], { type: 'text/javascript' }));
    ocrCoreUrl = URL.createObjectURL(new Blob([ocrCoreSource], { type: 'text/javascript' }));
    // The official loader recognizes a complete script by its .js suffix; the URL fragment
    // provides that suffix while preserving the Blob resource containing the inline WASM.
    const initialization = createWorker([{ code: 'spa', data: modelBytes() }], OEM.LSTM_ONLY, {
      workerPath: ocrWorkerUrl,
      workerBlobURL: false,
      corePath: `${ocrCoreUrl}#core.js`,
      gzip: false,
      cacheMethod: 'none',
      errorHandler: () => { /* The corresponding awaited worker job reports the error. */ },
    });
    let initializationExpired = false;
    void initialization.then(worker => { if (initializationExpired) void worker.terminate(); }, () => {});
    try {
      ocrWorker = await timed(initialization, Math.min(45_000, remaining()), 'No se pudo iniciar el OCR español integrado. Recargue la aplicación y vuelva a procesar el PDF.');
    } catch (error) { initializationExpired = true; throw error; }
    await ocrWorker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
    const recognized: string[] = [];
    canvas = document.createElement('canvas');
    for (let i = 1; i <= documentPdf.numPages; i++) {
      const page = await documentPdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2200 / Math.max(base.width, base.height), 3);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('El navegador no permite dibujar las páginas para OCR.');
      await timed(page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' }).promise, Math.min(30_000, remaining()), 'No se pudo dibujar una página escaneada a tiempo.');
      const result = await timed(ocrWorker.recognize(canvas), Math.min(45_000, remaining()), 'El reconocimiento de una página tardó demasiado. Divida el PDF o vuelva a procesar una copia más legible.');
      recognized.push(result.data.text);
    }
    const result = mergePdfReadings(nativeReading, parseReportText(recognized.join('\n\f\n'), settings), settings);
    result.warnings.unshift('PDF renderizado: OCR local en español aplicado para completar la lectura automática. Compare las celdas reconocidas con el PDF original.');
    return result;
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') throw new Error('El PDF está protegido con contraseña. Cargue una copia sin protección.');
    if (error instanceof Error) throw error;
    throw new Error('No se pudo leer el PDF. Compruebe que no esté dañado y vuelva a intentarlo.');
  } finally {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    await ocrWorker?.terminate();
    if (documentPdf) await documentPdf.destroy();
    else await task.destroy();
    pdfWorker.terminate();
    if (GlobalWorkerOptions.workerPort === pdfWorker) GlobalWorkerOptions.workerPort = null;
    URL.revokeObjectURL(pdfWorkerUrl);
    if (ocrWorkerUrl) URL.revokeObjectURL(ocrWorkerUrl);
    if (ocrCoreUrl) URL.revokeObjectURL(ocrCoreUrl);
  }
}
