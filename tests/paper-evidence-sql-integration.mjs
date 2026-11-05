import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const db = process.env.TEXTOS_TEST_DB_CONTAINER, url = process.env.TEXTOS_TEST_REST_URL;
assert.match(db ?? '', /^textos-paper-evidence-[0-9]+-db$/); assert.match(url ?? '', /^http:\/\/127\.0\.0\.1:[0-9]+$/);
const env = { ...process.env }; for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
const docker = (...args) => execFileSync('docker', ['--host=unix:///var/run/docker.sock', ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const sql = value => docker('exec', '-i', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-Atc', value);
const sqlJson = value => `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString('hex')}','hex'),'UTF8')::jsonb`;
let checks = 0; const check = async (name, operation) => { await operation(); console.log(`✓ ${++checks} ${name}`); };
for (let attempt = 0; ; attempt++) { try { if ((await fetch(url)).ok) break; } catch { /* isolated startup */ } if (attempt >= 60) throw Error('PostgREST did not start.'); await new Promise(resolve => setTimeout(resolve, 100)); }
const director = sql("select public.textos_bootstrap_local('demo')"), realDirector = sql("select public.textos_bootstrap_local('real')");
async function rpc(action, payload = {}, code = director, dataset = 'demo') { const response = await fetch(`${url}/rpc/textos_api`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ p_action: action, p_payload: payload, p_code: code, p_dataset: dataset }) }); return { status: response.status, body: await response.json() }; }
async function ok(action, payload = {}, code = director, dataset = 'demo') { const response = await rpc(action, payload, code, dataset); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; }
async function reject(action, payload = {}, status = 400, code = director, dataset = 'demo') { const response = await rpc(action, payload, code, dataset); assert.equal(response.status, status, JSON.stringify(response.body)); }
const pollId = 'evidence-poll', otherPollId = 'evidence-other-poll';
const classrooms = [1, 2].flatMap(grade => ['A', 'B', 'C', 'D', 'E'].map(section => ({ id: `PRI${grade}-${section}`, gradeId: `PRI${grade}`, section, label: `${grade}.º de primaria · ${section}`, attendance: 'pending', ballotIssued: false, received: false }))).map((row, index) => ({ ...row, folio: `P1-${String(index + 1).padStart(2, '0')}` }));
const state = JSON.parse(sql('select public.textos_empty_state()'));
state.publishers = [1, 2, 3].map(index => ({ id: `evidence-publisher-${index}`, version: 1, name: `Editorial ${index}`, samplesReceived: false, sampleNote: '' }));
state.teachers = [{ id: 'evidence-teacher', version: 1, name: 'Docente de prueba', area: 'MAT', categories: ['P1'], attended: false, attendanceEvidence: '' }];
const options = state.publishers.map(({ id, name }) => ({ id, name }));
const poll = { id: pollId, version: 1, block: 'P1', areas: ['MAT', 'COM'], options: { MAT: options, COM: options }, status: 'open', rankingId: 'evidence-ranking', rankingVersion: 1, createdAt: '2026-11-04T23:00:00Z', closedAt: null, generated: 0, received: 0, counts: { MAT: { options: Object.fromEntries(options.map(item => [item.id, 0])), blank: 0, invalid: 0 }, COM: { options: Object.fromEntries(options.map(item => [item.id, 0])), blank: 0, invalid: 0 } }, results: {}, rosterVersion: 1, classrooms };
state.paperPolls = [poll, { ...structuredClone(poll), id: otherPollId }];
sql(`update public.textos_datasets set state=${sqlJson(state)} where id in ('demo','real')`);
const teacher = sql('select public.textos_code()');
sql(`insert into public.textos_access(dataset,code_hash,role,teacher_id,name,expires_at) values('demo',public.textos_hash('${teacher}'),'teacher','evidence-teacher','Docente de prueba',now()+interval '1 day')`);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
const upload = (extra = {}, variant = 0) => ({ pollId, classroomId: 'PRI1-A', filename: `ficha-${variant}.png`, mimeType: 'image/png', data: Buffer.concat([png, Buffer.from([variant])]).toString('base64'), ...extra });
let photo;
const frozenState = () => sql("select state::text from public.textos_datasets where id='demo'");

await check('fotos son privadas para Subdirección y no admiten lectura directa del navegador', async () => {
  await reject('paper_evidence_list', { pollId }, 401, null); await reject('paper_evidence_list', { pollId }, 403, teacher);
  const permissions = JSON.parse(sql("select jsonb_build_object('anon',has_table_privilege('anon','public.textos_paper_evidence','SELECT'),'auth',has_table_privilege('authenticated','public.textos_paper_evidence','SELECT'),'helper',has_function_privilege('anon','public.textos_paper_evidence_action(jsonb,text,jsonb,text,text,timestamp with time zone)','EXECUTE'))"));
  assert.deepEqual(permissions, { anon: false, auth: false, helper: false });
});
await check('adjuntar una foto guarda bytes y metadatos sin cambiar votos, asistencia ni versiones', async () => {
  const before = frozenState(); photo = await ok('paper_evidence_add', upload());
  assert.equal(photo.classroomId, 'PRI1-A'); assert.equal(photo.bytes, png.length + 1); assert.ok(photo.id); assert.equal(photo.data, undefined); assert.equal(frozenState(), before);
  assert.equal(sql('select count(*) from public.textos_paper_evidence'), '1');
});
await check('la lista y descarga corresponden solo a la votación y dataset seleccionados', async () => {
  const other = await ok('paper_evidence_add', upload({ pollId: otherPollId }));
  const real = await ok('paper_evidence_add', upload(), realDirector, 'real');
  assert.deepEqual((await ok('paper_evidence_list', { pollId })).map(item => item.id), [photo.id]);
  assert.deepEqual((await ok('paper_evidence_list', { pollId: otherPollId })).map(item => item.id), [other.id]);
  const download = await ok('paper_evidence_get', { pollId, evidenceId: photo.id }); assert.equal(download.mimeType, 'image/png'); assert.equal(Buffer.from(download.data, 'base64').toString('hex'), Buffer.concat([png, Buffer.from([0])]).toString('hex'));
  await reject('paper_evidence_get', { pollId, evidenceId: other.id }, 404); await reject('paper_evidence_get', { pollId, evidenceId: real.id }, 404);
});
await check('una misma foto se identifica sin duplicar ni consumir el cupo del aula', async () => {
  const repeated = await ok('paper_evidence_add', upload({ filename: 'otro-nombre.png' })); assert.equal(repeated.id, photo.id); assert.equal(repeated.duplicate, true);
  assert.equal((await ok('paper_evidence_list', { pollId })).length, 1);
});
await check('se rechazan archivos ajenos, tipos falsos, contenido inválido y fotos excesivas', async () => {
  await reject('paper_evidence_add', upload({ classroomId: 'PRI9-Z' })); await reject('paper_evidence_add', upload({ mimeType: 'image/svg+xml' }));
  await reject('paper_evidence_add', upload({ mimeType: 'image/jpeg' })); await reject('paper_evidence_add', upload({ data: 'no-es-base64' }));
  await reject('paper_evidence_add', upload({ data: Buffer.alloc(1048577).toString('base64') })); await reject('paper_evidence_add', upload({ filename: '' }));
  assert.equal((await ok('paper_evidence_list', { pollId })).length, 1);
});
await check('cada aula admite tres fotos distintas y permite reemplazar una sin afectar al voto', async () => {
  await ok('paper_evidence_add', upload({}, 1)); const third = await ok('paper_evidence_add', upload({}, 2)); await reject('paper_evidence_add', upload({}, 3), 409);
  const before = frozenState(); await ok('paper_evidence_delete', { pollId, evidenceId: third.id }); await reject('paper_evidence_get', { pollId, evidenceId: third.id }, 404);
  await ok('paper_evidence_add', upload({}, 3)); assert.equal((await ok('paper_evidence_list', { pollId })).length, 3); assert.equal(frozenState(), before);
});
await check('las fotos pueden adjuntarse después del cierre sin modificar el resultado', async () => {
  sql(`update public.textos_datasets set state=jsonb_set(state,'{paperPolls,0}',(state#>'{paperPolls,0}')||jsonb_build_object('status','closed','closedAt',now(),'results',jsonb_build_object('MAT',public.textos_paper_result(state#>'{paperPolls,0}','MAT'),'COM',public.textos_paper_result(state#>'{paperPolls,0}','COM')))) where id='demo'`);
  const before = frozenState(); await ok('paper_evidence_add', upload({ classroomId: 'PRI1-B' })); assert.equal(frozenState(), before);
});
await check('las proyecciones públicas y docentes no contienen fotos ni contenido base64', async () => {
  for (const projection of [(await ok('public_snapshot', {}, null)).state, (await ok('snapshot', {}, teacher)).state]) {
    const text = JSON.stringify(projection); assert.ok(!text.includes(photo.id)); assert.ok(!text.includes('iVBORw0KGgo')); assert.ok(!text.includes('evidence-add')); assert.ok(!text.includes('paperEvidence'));
  }
});
await check('reaplicar el esquema conserva las fotos y sus bytes sin alterar el padrón', async () => {
  const before = sql("select jsonb_agg(to_jsonb(e) order by id)::text from public.textos_paper_evidence e"); const stateBefore = frozenState();
  execFileSync('docker', ['--host=unix:///var/run/docker.sock', 'exec', '-i', db, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], { env, input: readFileSync(new URL('../supabase/schema.sql', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(sql("select jsonb_agg(to_jsonb(e) order by id)::text from public.textos_paper_evidence e"), before); assert.equal(frozenState(), stateBefore);
});
await check('el respaldo identifica las fotos para su descarga separada sin incluir sus bytes', async () => {
  const backup = await ok('backup_get'); assert.equal(backup.photoEvidenceExportSeparate, true); assert.equal(backup.photoEvidenceManifest.length, 5);
  assert.ok(backup.photoEvidenceManifest.some(item => item.id === photo.id)); assert.ok(backup.photoEvidenceManifest.every(item => !Object.hasOwn(item, 'content') && !Object.hasOwn(item, 'data')));
  assert.ok(!JSON.stringify(backup).includes('iVBORw0KGgo'));
});
await check('previsualizar no borra fotos y eliminar su votación retira solo los respaldos relacionados', async () => {
  const preview = await ok('data_delete_preview', { scope: 'paperPoll', ids: [pollId] }); assert.equal(preview.counts.paperEvidence, 4);
  assert.equal((await ok('paper_evidence_list', { pollId })).length, 4);
  await ok('data_delete_apply', { scope: 'paperPoll', ids: [pollId], expectedVersion: preview.stateVersion, confirmation: 'ELIMINAR' });
  assert.equal(sql(`select count(*) from public.textos_paper_evidence where dataset='demo' and poll_id='${pollId}'`), '0');
  assert.equal((await ok('paper_evidence_list', { pollId: otherPollId })).length, 1); assert.equal(sql("select count(*) from public.textos_paper_evidence where dataset='real'"), '1');
});
await check('limpiar registros huérfanos elimina solo sus fotos y respeta el otro espacio', async () => {
  const realBefore = sql("select count(*) from public.textos_paper_evidence where dataset='real'");
  sql(`select public.textos_paper_evidence_prune(jsonb_set(state,'{paperPolls}','[]'::jsonb),'demo') from public.textos_datasets where id='demo'`);
  assert.equal(sql("select count(*) from public.textos_paper_evidence where dataset='demo'"), '0'); assert.equal(sql("select count(*) from public.textos_paper_evidence where dataset='real'"), realBefore);
});
console.log(`${checks} grupos SQL/HTTP de respaldo fotográfico opcional aprobados.`);
