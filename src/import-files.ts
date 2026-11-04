export type ImportKind = 'titles' | 'topics' | 'practice' | 'sections';

/** Quoted fields, embedded newlines and UTF-8 BOM are supported. */
export function parseCsv(source: string): Record<string, unknown>[] {
  const input = source.replace(/^\uFEFF/, '');
  const firstLine = input.split(/\r?\n/, 1)[0] ?? '';
  const separator = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') { cell += '"'; i++; }
      else if (!quoted && cell.length) throw new Error('Comillas inesperadas en el archivo CSV.');
      else quoted = !quoted;
    } else if (ch === separator && !quoted) { row.push(cell); cell = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(cell); if (row.some(value => value.trim())) rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (quoted) throw new Error('Hay un campo entre comillas sin cerrar.');
  row.push(cell); if (row.some(value => value.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('Incluya una cabecera y al menos una fila de datos.');
  const headers = rows.shift()!.map(value => value.trim());
  if (headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error('Las columnas deben tener nombres distintos y no vacíos.');
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`Fila ${index + 2}: se esperaban ${headers.length} columnas y se encontraron ${values.length}.`);
    return Object.fromEntries(headers.map((header, column) => [header, values[column].trim()]));
  });
}

export async function readImportFile(file: File): Promise<Record<string, unknown>[]> {
  if (file.size > 8 * 1024 * 1024) throw new Error('El archivo supera 8 MB. Divídalo en archivos más pequeños.');
  if (/\.csv$/i.test(file.name)) return parseCsv(await file.text());
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Seleccione un archivo CSV UTF-8 o XLSX.');
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) throw new Error('La primera hoja debe contener una cabecera y datos.');
  if (sheet.rowCount > 20001) throw new Error('La hoja supera 20 000 filas. Divida la importación.');
  const valueOf = (cell: import('exceljs').Cell): unknown => {
    const value = cell.value;
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      if ('formula' in value || 'sharedFormula' in value) throw new Error(`Celda ${cell.address}: reemplace la fórmula por su valor antes de importar.`);
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      if ('richText' in value) return value.richText.map(part => part.text).join('');
      if ('text' in value) return value.text;
      throw new Error(`Celda ${cell.address}: contenido no admitido.`);
    }
    return value;
  };
  const headers = Array.from({ length: sheet.getRow(1).cellCount }, (_, i) => String(valueOf(sheet.getRow(1).getCell(i + 1))).trim());
  if (!headers.length || headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error('La cabecera contiene nombres vacíos o repetidos.');
  const rows: Record<string, unknown>[] = [];
  for (let index = 2; index <= sheet.rowCount; index++) {
    const values = headers.map((_, col) => valueOf(sheet.getRow(index).getCell(col + 1)));
    if (values.some(value => value !== '')) rows.push(Object.fromEntries(headers.map((header, col) => [header, values[col]])));
  }
  if (!rows.length) throw new Error('El archivo no contiene filas de datos.');
  return rows;
}
