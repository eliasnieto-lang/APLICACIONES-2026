import test from 'node:test';
import assert from 'node:assert/strict';
import { paperClassroomRoster } from '../shared/paper-vote';
import { GRADES } from '../shared/domain';
import type { Block } from '../shared/types';

test('each paper category includes all five sections of its grades and a stable short folio per classroom', () => {
  for (const [block, expected] of [['P1', 10], ['P2', 20], ['S1', 15]] as const) {
    const roster = paperClassroomRoster(block);
    assert.equal(roster.length, expected);
    assert.equal(new Set(roster.map(item => item.id)).size, expected);
    assert.equal(new Set(roster.map(item => item.folio)).size, expected);
    for (const grade of GRADES.filter(item => item.block === block)) {
      const classrooms = roster.filter(item => item.gradeId === grade.id);
      assert.deepEqual(classrooms.map(item => item.section), ['A', 'B', 'C', 'D', 'E']);
      assert.deepEqual(classrooms.map(item => item.label), ['A', 'B', 'C', 'D', 'E'].map(section => `${grade.label} · ${section}`));
    }
    for (const [index, classroom] of roster.entries()) {
      assert.equal(classroom.id, `${classroom.gradeId}-${classroom.section}`);
      assert.equal(classroom.folio, `${block}-${String(index + 1).padStart(2, '0')}`);
      assert.equal(classroom.attendance, 'pending'); assert.equal(classroom.ballotIssued, false); assert.equal(classroom.received, false);
      assert.equal(classroom.choices, undefined);
    }
  }
  assert.equal(['P1', 'P2', 'S1'].flatMap(block => paperClassroomRoster(block as Block)).length, 45);
});

test('fresh category rosters cannot leak attendance or vote state between polls', () => {
  const first = paperClassroomRoster('P1'); const second = paperClassroomRoster('P1');
  first[0].attendance = 'absent'; first[0].received = true; first[0].choices = { MAT: 'publisher-a', COM: null };
  assert.equal(second[0].attendance, 'pending'); assert.equal(second[0].received, false); assert.equal(second[0].choices, undefined);
  assert.throws(() => paperClassroomRoster('unknown' as Block), /categoría/);
});
