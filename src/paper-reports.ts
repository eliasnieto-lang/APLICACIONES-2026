import { PDFDocument, StandardFonts, PrintScaling, rgb, type PDFFont } from 'pdf-lib';
import QRCode from 'qrcode';
import type { State } from '../shared/types';
import { AREAS, BLOCKS } from '../shared/domain';
import { PAPER_A5, PAPER_MARKERS, PAPER_MARKER_SIZE, PAPER_QR, paperChoiceBoxes, paperQrPayload, validatePaperDefinition, type PaperBallotDefinition } from '../shared/paper-layout';

const clean = (value: unknown) => String(value ?? '').normalize('NFC').replace(/[\u2010-\u2015]/g, '-').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[^\x20-\x7e\xa0-\xff]/g, ' ');

function wrapped(value: string, font: PDFFont, size: number, width: number, maxLines = 2): string[] {
  const lines: string[] = []; let line = '';
  for (const word of clean(value).split(/\s+/)) {
    if (font.widthOfTextAtSize(`${line} ${word}`.trim(), size) <= width) line = `${line} ${word}`.trim();
    else { if (line) lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines).map((row, index) => {
    let text = row;
    while (text && font.widthOfTextAtSize(text, size) > width) text = text.slice(0, -1);
    if ((index === maxLines - 1 && lines.length > maxLines) || text !== row) text = `${text.slice(0, -3)}...`;
    return text;
  });
}

/** One anonymous ballot on each true A5 page. Photos are never embedded or uploaded. */
export async function buildPaperVotingPdf(state: State, poll: PaperBallotDefinition, codes: string[], options: { demo?: boolean; generatedAt?: string } = {}): Promise<Uint8Array> {
  validatePaperDefinition(poll);
  if (!codes.length || codes.length > 200 || new Set(codes).size !== codes.length) throw new Error('Genere entre una y doscientas fichas distintas.');
  const dataset = options.demo ? 'demo' : 'real';
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica); const bold = await document.embedFont(StandardFonts.HelveticaBold);
  document.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  document.setTitle('Ficha A5 de votación familiar - Selección de textos 2027');
  document.setAuthor(clean(state.settings.school));
  document.setSubject('Cédula anónima para marcar e imprimir a tamaño real');
  for (const [index, code] of codes.entries()) {
    const page = document.addPage([PAPER_A5.width, PAPER_A5.height]);
    const text = (value: string, x: number, top: number, size = 10, strong = false) => page.drawText(clean(value), { x, y: PAPER_A5.height - top - size, size, font: strong ? bold : regular, color: rgb(0, 0, 0) });
    for (const marker of PAPER_MARKERS) page.drawRectangle({ x: marker.x - PAPER_MARKER_SIZE / 2, y: PAPER_A5.height - marker.y - PAPER_MARKER_SIZE / 2, width: PAPER_MARKER_SIZE, height: PAPER_MARKER_SIZE, color: rgb(0, 0, 0) });
    wrapped(state.settings.school, bold, 11, PAPER_A5.width - 90).forEach((line, row) => text(line, 43, 35 + row * 13, 11, true));
    text('SELECCIÓN DE TEXTOS ESCOLARES 2027', 43, 68, 12, true);
    text('FICHA ANÓNIMA DE VOTACIÓN FAMILIAR', 43, 87, 11, true);
    text(`Categoría: ${BLOCKS.find(item => item.id === poll.block)?.label ?? poll.block}`, 43, 108, 9);
    text(options.demo ? 'DEMOSTRACIÓN - SIN VALIDEZ PARA LA JORNADA REAL' : 'No escriba nombres ni datos personales.', 43, 124, 8, !!options.demo);
    text('Marque UNA casilla por área con X oscura o rellénela.', 43, 140, 9, true);
    text('Para dejarla en blanco, marque la casilla Voto en blanco.', 43, 153, 8);
    for (const [section, area] of poll.areas.entries()) {
      text(AREAS.find(item => item.id === area)?.label.toUpperCase() ?? area, 43, 167 + section * 143, 10, true);
      for (const box of paperChoiceBoxes(poll).filter(item => item.area === area)) {
        page.drawRectangle({ x: box.x, y: PAPER_A5.height - box.y - box.size, width: box.size, height: box.size, borderColor: rgb(0, 0, 0), borderWidth: .85 });
        wrapped(box.name, regular, 9, PAPER_A5.width - 115).forEach((line, row) => text(line, 71, box.y + 1 + row * 10, 9));
      }
    }
    text('Fotografíe una sola ficha por imagen.', 43, 466, 8);
    text('Incluya las cuatro marcas negras y el QR.', 43, 478, 8);
    text('No recorte, doble ni escriba sobre el código.', 43, 490, 8);
    text('Cada ficha solo puede contarse una vez.', 43, 502, 8);
    text(`Ficha ${index + 1} de ${codes.length}`, 43, 525, 8);
    text(`Votación: ${poll.id}`, 43, 537, 6);
    // Human-readable recovery code remains anonymous and independent of the voter.
    text('Código anónimo:', 43, 548, 6);
    text(code, 43, 558, 6);
    const qr = QRCode.create(paperQrPayload(dataset, poll.id, code), { errorCorrectionLevel: 'M' });
    const module = PAPER_QR.size / (qr.modules.size + PAPER_QR.quietModules * 2);
    for (let row = 0; row < qr.modules.size; row++) for (let column = 0; column < qr.modules.size; column++) {
      if (qr.modules.get(row, column)) page.drawRectangle({ x: PAPER_QR.x + (column + PAPER_QR.quietModules) * module,
        y: PAPER_A5.height - PAPER_QR.y - (row + PAPER_QR.quietModules + 1) * module,
        width: module + .015, height: module + .015, color: rgb(0, 0, 0) });
    }
  }
  return document.save();
}
