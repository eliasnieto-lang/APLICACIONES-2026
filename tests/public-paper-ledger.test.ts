import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PublicPaperLedger from '../src/components/PublicPaperLedger';
import { paperClassroomRoster, type PaperPoll } from '../shared/paper-vote';

function pollFixture(): PaperPoll {
  const classrooms = paperClassroomRoster('P1');
  Object.assign(classrooms[0], { attendance: 'present', ballotIssued: true, received: true, choices: { MAT: 'editorial-b', COM: null }, voteVersion: 2, recordedAt: '2026-11-04T20:00:00Z', correctedAt: '2026-11-04T20:01:00Z' });
  Object.assign(classrooms[1], { attendance: 'present', ballotIssued: true, received: true, choices: { MAT: '__invalid__', COM: 'editorial-a' }, voteVersion: 1, recordedAt: '2026-11-04T20:00:00Z' });
  classrooms[2].attendance = 'absent';
  return { id: 'public-classroom-poll', version: 3, block: 'P1', areas: ['MAT', 'COM'], options: { MAT: [{ id: 'editorial-a', name: 'Editorial A' }, { id: 'editorial-b', name: 'Editorial B' }, { id: 'editorial-c', name: 'Editorial C' }], COM: [{ id: 'editorial-a', name: 'Editorial A' }, { id: 'editorial-b', name: 'Editorial B' }, { id: 'editorial-c', name: 'Editorial C' }] }, status: 'open', rankingId: 'ranking', rankingVersion: 1, createdAt: '2026-11-04T19:00:00Z', closedAt: null, generated: 2, received: 2, counts: {}, results: {}, rosterVersion: 1, classrooms };
}

test('public classroom ledger distinguishes selected options, blank, null vote and absent classrooms', () => {
  const poll = pollFixture();
  const html = renderToStaticMarkup(createElement(PublicPaperLedger, { polls: [poll] }));
  assert.match(html, /Votación por aula/); assert.match(html, /P1-01/); assert.match(html, /1.º de primaria · A/);
  assert.match(html, /Editorial B/); assert.match(html, /Voto en blanco/); assert.match(html, /Voto nulo/);
  assert.match(html, /Sin asistencia/); assert.match(html, /Pendiente de transcribir/); assert.match(html, /Revisado · versión 2/);
  assert.match(html, /Registro en curso/); assert.match(html, /2 de 10 aulas con voto registrado/);
  assert.doesNotMatch(html, /<button|contenteditable|<input/);
});

test('public ledger preserves the same options after closing and never serializes private extras', () => {
  const poll = pollFixture(); poll.status = 'closed';
  Object.assign(poll, { code_hash: 'SECRET_HASH', photos: 'PRIVATE_PHOTO', privateReason: 'PRIVATE_REASON' });
  const html = renderToStaticMarkup(createElement(PublicPaperLedger, { polls: [poll] }));
  assert.match(html, /Votación cerrada/); assert.match(html, /Editorial B/);
  assert.doesNotMatch(html, /SECRET_HASH|PRIVATE_PHOTO|PRIVATE_REASON/);
});

test('legacy anonymous elections are never relabeled or exposed as classroom votes', () => {
  const poll = pollFixture(); delete poll.rosterVersion; delete poll.classrooms;
  assert.equal(renderToStaticMarkup(createElement(PublicPaperLedger, { polls: [poll] })), '');
});
