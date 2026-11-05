import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyState } from '../shared/defaults';
import type { AuditoriumDisplay } from '../shared/auditorium';
import AuditoriumScreen, { visibleAuditoriumDisplay } from '../src/components/AuditoriumScreen';

const start = '2026-11-05T15:00:00.000Z';
function fixture() {
  const state = emptyState();
  state.publishers = Array.from({ length: 6 }, (_, index) => ({ id: `p${index + 1}`, version: 1, name: `Editorial ${index + 1}`, samplesReceived: false, sampleNote: '' }));
  const display: AuditoriumDisplay = { schemaVersion: 1, version: 1, mode: 'samples', rankingId: 'rank', rankingVersion: 2, visit: { status: 'running', durationSeconds: 600, remainingSeconds: 600, startedAt: start, endsAt: '2026-11-05T15:10:00.000Z' }, categories: [
    { area: 'MAT', block: 'P1', publishers: state.publishers.slice(0, 3).map(({ id, name }, index) => ({ id, name, score: index * 25 })) },
    { area: 'COM', block: 'P1', publishers: state.publishers.slice(3).map(({ id, name }, index) => ({ id, name, score: 90 - index * 5 })) },
  ] };
  state.settings.auditoriumDisplay = display;
  return { state, display };
}
const render = (state: ReturnType<typeof emptyState>, now = Date.parse(start)) => renderToStaticMarkup(createElement(AuditoriumScreen, { state, now }));

test('public sample projection shows exactly three finalists per area with zero scores and the families final choice', () => {
  const { state } = fixture();
  state.teachers = [{ id: 'teacher-secret', version: 1, name: 'DOCENTE PRIVADO', attended: true, attendanceEvidence: 'CONSTANCIA PRIVADA' }];
  const text = render(state);
  assert.match(text, /Visita a las mesas de muestra/); assert.match(text, /10:00/);
  assert.match(text, /Matemática/); assert.match(text, /Comunicación/); assert.match(text, /0[.,]0 \/ 100/);
  for (let index = 1; index <= 6; index++) assert.match(text, new RegExp(`Editorial ${index}`));
  assert.match(text, /Los docentes orientan; las familias deciden/); assert.match(text, /El primer puesto docente no determina/);
  assert.doesNotMatch(text, /DOCENTE PRIVADO|CONSTANCIA PRIVADA|teacher-secret/);
});

test('public visit deadline survives a new render and paused/finished visits never consume additional time', () => {
  const { state, display } = fixture();
  assert.match(render(state, Date.parse(start) + 90_000), /08:30/);
  assert.match(render(structuredClone(state), Date.parse(start) + 90_000), /08:30/);
  display.visit!.status = 'paused'; display.visit!.remainingSeconds = 123; display.visit!.endsAt = null;
  assert.match(render(state, Date.parse(start) + 86_400_000), /02:03/); assert.match(render(state), /Visita pausada/);
  display.visit!.status = 'finished'; display.visit!.remainingSeconds = 0;
  const ended = render(state); assert.match(ended, /00:00/); assert.match(ended, /Tiempo de visita concluido/); assert.match(ended, /Regresen al auditorio/);
  assert.match(ended, /ficha A5/); assert.doesNotMatch(ended, /-00:/);
});

test('deleted editorials remove their entire category rather than leaving an incomplete or invented finalist list', () => {
  const { state } = fixture();
  state.publishers = state.publishers.filter(publisher => publisher.id !== 'p1');
  const text = render(state); assert.doesNotMatch(text, /Editorial 1|Editorial 2|Editorial 3/);
  assert.match(text, /Editorial 4/); assert.equal(visibleAuditoriumDisplay(state)?.categories.length, 1);
  state.publishers = [];
  assert.equal(render(state), ''); assert.equal(visibleAuditoriumDisplay(state), null);
});

test('instructions can be projected before editorials register and malformed or future display metadata is ignored', () => {
  const { state } = fixture(); state.publishers = [];
  state.settings.auditoriumDisplay = { schemaVersion: 1, version: 2, mode: 'instructions', categories: [] };
  assert.match(render(state), /INDICACIONES GENERALES/);
  assert.doesNotMatch(render(state), /Tiempo restante para visitar las mesas/);
  state.settings.auditoriumDisplay = { schemaVersion: 99, mode: 'samples' } as never;
  assert.equal(render(state), '');
  state.settings.auditoriumDisplay = null;
  assert.equal(render(state), '');
});
