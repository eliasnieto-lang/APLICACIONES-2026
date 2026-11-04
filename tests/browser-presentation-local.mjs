// A local disposable development installation only. All mutations use demo.
import {chromium} from 'playwright';
import {readFileSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import assert from 'node:assert/strict';
import {emptyState} from '../shared/defaults.ts';
const base=process.env.TEXTOS_BROWSER_URL||'http://127.0.0.1:8080';
if(!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(base))throw Error('Use a local disposable installation.');
const password=readFileSync('local/director-test-password','utf8').trim();
const owner=readFileSync('local/demo-owner-code.txt','utf8').trim();
const secrets=[password,owner];
async function rpc(action,payload={},code=owner){const r=await fetch(`${base}/api/rpc`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_action:action,p_payload:payload,p_code:code,p_dataset:'demo'})});const value=await r.json();if(!r.ok)throw Error(`${action}: ${value.error?.message??value.message}`);return value;}
await rpc('demo_reset',{state:emptyState()});
mkdirSync('test-results',{recursive:true});rmSync('test-results/presentation-browser-results.json',{force:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const errors=[],checks=[],contexts=[];
const checked=async(name,fn)=>{await fn();checks.push(name);console.log(`✓ ${name}`)};
async function newPage(viewport={width:1360,height:960}){const c=await browser.newContext({viewport});contexts.push(c);const p=await c.newPage();p.setDefaultTimeout(25000);p.on('pageerror',e=>errors.push(e.message));return p;}
async function landing(p){await p.goto(`${base}/?datos=demo`);await p.getByRole('button',{name:'INGRESAR COMO DOCENTE EVALUADOR',exact:true}).waitFor();}
let directorCode,publisherId;
const director=await newPage();
try{
 await checked('two direct entry choices; Subdirector password is checked by the server',async()=>{
  await landing(director);await director.screenshot({path:'test-results/acceso-directo.png',fullPage:true});
  assert.equal(await director.getByRole('button',{name:'INGRESAR COMO SUBDIRECTOR',exact:true}).count(),1);
  await director.getByRole('button',{name:'INGRESAR COMO SUBDIRECTOR',exact:true}).click();
  assert.equal(await director.locator('input[type=email]').count(),0);
  await director.getByLabel('Contraseña del subdirector').fill('incorrecta');await director.getByRole('button',{name:'Ingresar a la jornada',exact:true}).click();
  await director.getByRole('alert').waitFor();assert.equal(await director.getByRole('heading',{name:'Acceso del subdirector',exact:true}).count(),1);
  await director.getByLabel('Contraseña del subdirector').fill(password);await director.getByRole('button',{name:'Ingresar a la jornada',exact:true}).click();
  await director.getByRole('button',{name:'Preparar jornada',exact:true}).first().waitFor();
  const session=await director.evaluate(()=>JSON.parse(sessionStorage.getItem('textos-entry-session-v1:demo')||'null'));directorCode=session.code;secrets.push(directorCode);
  const stored=await director.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));assert(!stored.includes(password));
 });
 await checked('editorial registration makes live forms available without books or dossiers',async()=>{
  await director.getByRole('button',{name:'Preparar jornada',exact:true}).first().click();
  await director.getByLabel('Nombre de la editorial',{exact:true}).fill('Editorial del ensayo de exposición');
  await director.getByRole('button',{name:'Guardar editorial',exact:true}).click();await director.getByText('Editorial guardada. Sus fichas estarán disponibles para los docentes inscritos.',{exact:true}).waitFor();
  const state=(await rpc('snapshot',{},directorCode)).state;publisherId=state.publishers[0].id;assert.equal(state.books.length,0);assert.equal(state.assignments.length,0);
  await rpc('turn_control',{command:'start',publisherId,expectedTurn:state.turn},directorCode);
  const question=await rpc('presentation_question_save',{publisherId,expectedVersion:0,representativeName:'Representante del ensayo',area:'MAT',question:'¿Cómo apoya la propuesta los diferentes ritmos de aprendizaje?',answer:'La propuesta ofrece actividades de refuerzo y profundización con orientaciones para el docente.',status:'answered'},directorCode);assert.equal(question.version,1);assert.equal(question.status,'answered');
 });
 const names=[['Alvarado','Ana'],['Benítez','Bruno'],['Cáceres','Carla'],['Dávila','Diego'],['Espinoza','Elena']];
 const pages=[],teacherCodes=[];
 await checked('five teachers register without password and can choose multiple categories',async()=>{
  for(const [i,[last,first]] of names.entries()){
   const p=await newPage(i===0?{width:390,height:844}:undefined);await landing(p);await p.getByRole('button',{name:'INGRESAR COMO DOCENTE EVALUADOR',exact:true}).click();
   assert.equal(await p.locator('input[type=password]').count(),0);
   await p.getByLabel('Apellidos',{exact:true}).fill(last);await p.getByLabel('Nombres',{exact:true}).fill(first);await p.getByRole('radio',{name:'Matemática',exact:true}).check();
   const boxes=p.locator('.entry-block-options input[type=checkbox]');await boxes.nth(0).check();await boxes.nth(1).check();
   await p.getByRole('button',{name:'Comenzar mi evaluación',exact:true}).click();await p.getByRole('heading',{name:'Evaluar exposición',exact:true}).waitFor();
   const active=await p.evaluate(()=>JSON.parse(sessionStorage.getItem('textos-entry-session-v1:demo')||'null'));teacherCodes.push(active.code);secrets.push(active.code);pages.push(p);
   if(i===0){await p.getByLabel('Referencia MINEDU de I1',{exact:true}).waitFor();const guide=await fetch(`${base}/referencias/guia-minedu-textos-2013.pdf`);assert.equal(guide.status,200);assert((guide.headers.get('content-type')||'').includes('application/pdf'));assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:'test-results/ficha-exposicion-movil.png',fullPage:true});}
  }
  const s=(await rpc('snapshot',{},directorCode)).state;assert.equal(s.teachers.filter(t=>t.selfRegistered).length,5);assert(s.teachers.every(t=>t.categories.length===2));assert.equal(s.assignments.length,0);
 });
 await checked('live forms close with eleven observed scores and no preloaded physical-text metadata',async()=>{
  for(const [i,p] of pages.entries()){
   const sum=28+i*2;let remaining=sum;
   for(let k=0;k<10;k++){const value=Math.min(4,remaining);remaining-=value;await p.getByRole('button',{name:new RegExp(`^I${k+1}: ${value} puntos`)}).click();}
   await p.getByRole('button',{name:/^I11: 1 puntos/}).click();
   if(i===0)await p.getByLabel('Observación general (opcional)',{exact:true}).fill('Observación privada de Ana durante la exposición');
   await p.getByRole('button',{name:'Cerrar mi ficha',exact:true}).click();await p.getByText('El servidor confirmó el cierre de esta ficha.',{exact:false}).first().waitFor();
   const own=(await rpc('snapshot',{},teacherCodes[i])).state.presentationEvaluations;assert.equal(own.length,1);assert.equal(own[0].status,'closed');assert.equal(own[0].physicalText,'');assert.equal(own[0].area,'MAT');assert.equal(own[0].block,'P1');assert.equal(own[0].scaleMax,4);assert.equal(own[0].rubricVersion,2);assert.equal(own[0].responseScore,1);assert.equal(own[0].questionVersion,1);
  }
 });
 await checked('all five teacher scores contribute to the category mean and remain private',async()=>{
  const s=(await rpc('snapshot',{},directorCode)).state;const forms=s.presentationEvaluations.filter(x=>x.publisherId===publisherId&&x.block==='P1');assert.equal(forms.length,5);
  const average=forms.reduce((sum,e)=>sum+100*(e.scores.reduce((a,b)=>a+b,0)+e.responseScore)/44,0)/forms.length;assert(Math.abs(average-75)<1e-9);
  const summary=await rpc('presentation_summary',{},directorCode);assert(JSON.stringify(summary).includes('75'));
  const other=await rpc('snapshot',{},teacherCodes[1]);assert(!JSON.stringify(other).includes('Observación privada de Ana'));
  await director.getByRole('button',{name:'Consolidación y ternas',exact:true}).click();await director.getByRole('heading',{name:/Consolidación|Resultados/}).waitFor();
  await director.getByRole('button',{name:'Actualizar información',exact:true}).click();
  const row=director.locator('table').first().locator('tbody tr').filter({hasText:'Editorial del ensayo de exposición'});await row.locator('td').nth(4).filter({hasText:/75[.,]00/}).waitFor();assert((await row.innerText()).includes('75'));
  await director.screenshot({path:'test-results/consolidado-cinco-docentes.png',fullPage:true});
 });
 await checked('Subdirector dropdowns filter records without changing the official mean',async()=>{
  const state=(await rpc('snapshot',{},directorCode)).state;
  await director.getByLabel('Editorial',{exact:true}).selectOption(publisherId);
  const firstTeacher=state.teachers.find(t=>t.lastNames==='Alvarado');
  await director.getByLabel(/^Docente/).selectOption(firstTeacher.id);
  await director.getByLabel('Estado',{exact:true}).selectOption('closed');
  await director.getByRole('tab',{name:'Fichas docentes',exact:true}).waitFor();
  assert.equal(await director.locator('table.consolidation-records tbody tr').count(),1);
  assert((await director.locator('table.consolidation-records').innerText()).includes('65.91'));
  const official=await rpc('presentation_summary',{area:'MAT',block:'P1'},directorCode);assert.equal(official.ranked[0].score,75);
  await director.getByRole('button',{name:/^Ver ficha de Alvarado/}).click();
  const modal=director.getByRole('dialog',{name:'Ficha docente',exact:true});await modal.waitFor();assert((await modal.innerText()).includes('Sin valoración'));
  await modal.getByRole('button',{name:'Cerrar ventana',exact:true}).click();
  await director.getByRole('button',{name:'Limpiar filtros',exact:true}).click();
  await director.getByRole('tab',{name:'Resultados',exact:true}).click();
  await director.getByLabel('Área',{exact:true}).selectOption('COM');await director.getByLabel('Categoría',{exact:true}).selectOption('S1');
  assert.equal(await director.getByLabel(/^Docente/).locator('option').count(),1);
  await director.getByLabel('Área',{exact:true}).selectOption('MAT');await director.getByLabel('Categoría',{exact:true}).selectOption('P1');
  assert((await director.locator('table.consolidation-results').innerText()).includes('75'));
  await director.screenshot({path:'test-results/consolidado-desplegables-real.png',fullPage:true});
 });
 await checked('a second selected category has an independent empty form',async()=>{
  const p=pages[0];const tabs=p.locator('[aria-label="Área y bloque de evaluación"] button');await tabs.nth(1).click();await p.getByRole('button',{name:/^I1: 0 puntos/}).waitFor();assert.equal(await p.getByRole('button',{name:/^I1: 0 puntos/}).getAttribute('aria-pressed'),'false');
 });
 await checked('legacy 0–2 grades retain 14/20=70 and require an explicit fresh 0–4 review',async()=>{
  const backup=await rpc('backup_get',{},directorCode);
  const teacher=backup.state.teachers.find(t=>t.lastNames==='Alvarado');
  const legacy={id:'legacy-scale-browser-form',version:1,publisherId,teacherId:teacher.id,area:'MAT',block:'P2',scaleMax:2,scores:[2,2,2,2,1,1,1,1,1,1],notes:Array(10).fill(''),generalObservation:'Observación anterior conservada',physicalText:'Ejemplar de prueba',status:'closed',closedAt:'2026-11-04T12:00:00Z',updatedAt:'2026-11-04T12:00:00Z',rulesVersion:backup.state.settings.rules.version};
  backup.state.presentationEvaluations.push(legacy);
  await rpc('restore_apply',{backup,confirmation:'RESTAURAR',reason:'Ensayo aislado de conservación de una ficha anterior'},directorCode);
  const p=pages[0];await p.getByRole('button',{name:'Actualizar información',exact:true}).click();
  await p.getByRole('button',{name:'Evaluar con nueva escala',exact:true}).waitFor();
  const text=await p.locator('main').innerText();assert(text.includes('14'));assert(text.includes('70'));
  const old=(await rpc('snapshot',{},teacherCodes[0])).state.presentationEvaluations.find(e=>e.id===legacy.id);assert.deepEqual(old.scores,legacy.scores);assert.equal(old.scaleMax,2);
  await p.getByRole('button',{name:'Evaluar con nueva escala',exact:true}).click();
  await p.getByRole('button',{name:/^I1: 4 puntos/}).waitFor();
  const fresh=(await rpc('snapshot',{},teacherCodes[0])).state.presentationEvaluations.find(e=>e.id===legacy.id);assert.equal(fresh.scaleMax,4);assert.equal(fresh.rubricVersion,2);assert.equal(fresh.responseScore,null);assert.equal(fresh.questionVersion,null);assert(fresh.scores.every(v=>v===null));assert.equal(fresh.status,'draft');
  const retained=await rpc('backup_get',{},directorCode);assert(retained.history.some(h=>h.reference_id===legacy.id&&h.previous.scaleMax===2&&h.previous.scores.reduce((a,b)=>a+b,0)===14));
 });
 await checked('public room excludes private observations and current unpublished teacher results',async()=>{
  const p=await newPage({width:390,height:844});await p.goto(`${base}/?vista=publica&datos=demo`);await p.getByRole('heading',{name:'Selección de textos escolares 2027',exact:true}).waitFor();const text=await p.locator('body').innerText();assert(!text.includes('Observación privada de Ana'));assert(!text.includes('Alvarado'));assert(!text.includes('75.00'));assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 });
 assert.deepEqual(errors,[]);
 writeFileSync('test-results/presentation-browser-results.json',JSON.stringify({at:new Date().toISOString(),backend:'Node/Express + PostgreSQL + PostgREST reales',passed:checks.length,checks,pageErrors:errors},null,2));
}catch(error){const message=secrets.reduce((s,secret)=>secret?s.split(secret).join('[redacted]'):s,String(error?.stack||error));console.error(message);process.exitCode=1;}
finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();}
