import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyState } from '../shared/defaults';
import { PRESENTATION_INDICATORS } from '../shared/presentation';
import { editorialAgenda, editorialAgendaSegments, editorialDurationText } from '../shared/editorial-agenda';
import EditorialInstructions from '../src/components/EditorialInstructions';

function instructions(seconds: number, compact = false) {
  const settings = emptyState().settings; settings.rules.presentationSeconds = seconds;
  const html = renderToStaticMarkup(createElement(EditorialInstructions, { settings, compact }));
  return { html, text: html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') };
}

test('editorial instructions use the configured duration and give one shared time to all representatives', () => {
  const real = instructions(900).text;
  assert.match(real, /Tiempo total por editorial: 15 minutos/);
  assert.match(real, /dos o más representantes.*mismo tiempo total/);
  assert.match(real, /No se asigna un tiempo adicional por persona/);
  assert.match(real, /cumplimiento del tiempo.*dentro de I3/);
  const demo = instructions(60, true).text;
  assert.match(demo, /Tiempo total por editorial: 1 minuto/);
  assert.doesNotMatch(demo, /Tiempo total por editorial: 15 minutos/);
});

test('the displayed procedure separates draw, evaluation, mandatory withdrawal, results, sample review and family choice', () => {
  const text = instructions(900).text;
  const headings = ['Registro y sorteo del orden', 'Exposición de la propuesta', 'Evaluación de los docentes y pregunta obligatoria', 'Retiro obligatorio del auditorio', 'Exposición de resultados y tres finalistas', 'Mesas de muestra y votación de las familias'];
  const positions = headings.map(heading => text.indexOf(heading));
  assert.ok(positions.every(index => index >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(text, /TODOS LOS REPRESENTANTES EDITORIALES DEBEN ABANDONAR EL AUDITORIO/);
  assert.match(text, /antes de exponer los resultados/);
  assert.match(text, /no intervienen.*resultados.*votación/);
  assert.match(text, /tres propuestas finalistas por cada área y grupo de grados/);
  assert.match(text, /tiempo de visita fijado por Subdirección/);
  assert.match(text, /no queda determinada por el primer puesto docente/);
});

test('representatives are told the actual eleven criteria, scale, per-area public prices and edition requirements', () => {
  const { html, text } = instructions(900);
  assert.equal((html.match(/data-criterion="I\d+"/g) ?? []).length, 11);
  for (const indicator of PRESENTATION_INDICATORS) assert.ok(text.includes(indicator.label));
  assert.match(text, /máximo de 44 puntos/);
  for (const label of ['0 · Sin valoración', '1 · En inicio', '2 · En proceso', '3 · Logrado', '4 · Destacado']) assert.ok(text.includes(label));
  assert.match(text, /año de edición y el precio de venta al público del kit o pack de cada área: Matemática y Comunicación/);
  assert.match(text, /componentes opcionales, cualquier costo adicional.*condiciones de los beneficios/);
  assert.match(text, /No se limita la participación a dos docentes/);
  assert.match(text, /cero elegido aporta cero/);
  assert.match(text, /respaldo fotográfico es opcional/);
  assert.doesNotMatch(text, /umbral de 70|exige.{0,20}70 puntos|escanee|rellene un código/i);
});

test('reference agenda covers the exact configured turn without adding time and formats short demonstrations correctly', () => {
  for (const seconds of [1, 45, 60, 600, 900, 1200]) {
    const agenda = editorialAgendaSegments(seconds);
    assert.equal(agenda[0].startSeconds, 0);
    assert.equal(agenda.at(-1)!.endSeconds, seconds);
    assert.equal(agenda.reduce((sum, item) => sum + item.endSeconds - item.startSeconds, 0), seconds);
    assert.ok(agenda.every((item, index) => item.endSeconds > item.startSeconds && (!index || item.startSeconds === agenda[index - 1].endSeconds)));
  }
  assert.deepEqual(editorialAgenda(900).at(-1), ['13:30–15:00', 'Cierre y pregunta del representante docente']);
  assert.equal(editorialDurationText(90), '1 minuto y 30 segundos');
  assert.equal(editorialDurationText(45), '45 segundos');
  for (const invalid of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => editorialAgenda(invalid));
});
