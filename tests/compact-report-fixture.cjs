// A real native-text PDF modeled on a compact school report table. Area labels
// share the first competency's row, long labels wrap, and each grade is a
// separately positioned PDF text item. The fourth printed bimester is excluded
// from the I–III evaluation. No extraction or application behavior is mocked.
function makeCompactPdf(settings, { code, name, grade, section = 'F', grades = ['C', 'B', 'A', 'AD'], gradesByArea = {}, additionalAreas = [] }) {
  const clean = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[()\\]/g, '\\$&');
  const commands = [];
  const text = (value, x, y, size = 7.5) => commands.push(`BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${clean(value)}) Tj ET`);
  const line = (x1, y1, x2, y2) => commands.push(`${x1} ${y1} m ${x2} ${y2} l S`);
  const wrap = (value, width) => {
    const lines = [];
    for (const word of value.split(/\s+/)) {
      if (!lines.length || `${lines.at(-1)} ${word}`.length > width) lines.push(word);
      else lines[lines.length - 1] += ` ${word}`;
    }
    return lines;
  };
  text('INFORME DE PROGRESO DEL ESTUDIANTE', 35, 809, 12);
  text(`Codigo del estudiante: ${code}`, 35, 791, 9);
  text(`Apellidos y nombres: ${name}`, 35, 776, 9);
  text(`Grado: ${grade}   Seccion: ${section}   Periodo: 2026`, 35, 761, 9);
  commands.push('0.35 w');
  const boundaries = [30, 130, 416, 455, 494, 533, 572];
  const gradeCenters = [432, 471, 510, 549];
  const top = 741;
  text('AREA', 35, 716, 8);
  text('COMPETENCIAS', 135, 716, 8);
  text('BIMESTRES', 459, 729, 8);
  ['I', 'II', 'III', 'IV'].forEach((bimester, index) => text(bimester, gradeCenters[index], 715, 8));
  line(30, top, 572, top);
  line(416, 723, 572, 723);
  line(30, 706, 572, 706);
  let rowTop = 706;
  for (const area of [...settings.areas, ...additionalAreas]) {
    const areaLines = wrap(area.name, 19);
    for (const [index, competency] of area.competencies.entries()) {
      const competencyLines = wrap(competency, 53);
      const printedLines = Math.max(competencyLines.length, index === 0 ? areaLines.length : 1);
      const height = Math.max(additionalAreas.length ? 20 : 25, printedLines * 10 + 9);
      if (index === 0) areaLines.forEach((value, offset) => text(value, 35, rowTop - 12 - offset * 10));
      competencyLines.forEach((value, offset) => text(value, 135, rowTop - 12 - offset * 10));
      const rowGrades = gradesByArea[area.id]?.[index] ?? grades;
      gradeCenters.forEach((x, column) => text(rowGrades[column] ?? '', x, rowTop - 12, 8));
      rowTop -= height;
      line(index === area.competencies.length - 1 ? 30 : 130, rowTop, 572, rowTop);
    }
  }
  boundaries.forEach(x => line(x, top, x, rowTop));
  const stream = commands.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let result = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

module.exports = { makeCompactPdf };
