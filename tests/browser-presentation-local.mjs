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
   if(i===0){assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:'test-results/ficha-exposicion-movil.png',fullPage:true});}
  }
  const s=(await rpc('snapshot',{},directorCode)).state;assert.equal(s.teachers.filter(t=>t.selfRegistered).length,5);assert(s.teachers.every(t=>t.categories.length===2));assert.equal(s.assignments.length,0);
 });
 await checked('live forms close with ten observed scores and no preloaded physical-text metadata',async()=>{
  for(const [i,p] of pages.entries()){
   const sum=14+i;let remaining=sum;
   for(let k=0;k<10;k++){const value=Math.min(2,remaining);remaining-=value;await p.getByRole('button',{name:`I${k+1}: ${value} puntos`,exact:true}).click();}
   if(i===0)await p.getByLabel('Observación general (opcional)',{exact:true}).fill('Observación privada de Ana durante la exposición');
   await p.getByRole('button',{name:'Cerrar mi ficha',exact:true}).click();await p.getByText('El servidor confirmó el cierre de esta ficha.',{exact:false}).first().waitFor();
   const own=(await rpc('snapshot',{},teacherCodes[i])).state.presentationEvaluations;assert.equal(own.length,1);assert.equal(own[0].status,'closed');assert.equal(own[0].physicalText,'');assert.equal(own[0].area,'MAT');assert.equal(own[0].block,'P1');
  }
 });
 await checked('all five teacher scores contribute to the category mean and remain private',async()=>{
  const s=(await rpc('snapshot',{},directorCode)).state;const forms=s.presentationEvaluations.filter(x=>x.publisherId===publisherId&&x.block==='P1');assert.equal(forms.length,5);
  const average=forms.reduce((sum,e)=>sum+5*e.scores.reduce((a,b)=>a+b,0),0)/forms.length;assert.equal(average,80);
  const summary=await rpc('presentation_summary',{},directorCode);assert(JSON.stringify(summary).includes('80'));
  const other=await rpc('snapshot',{},teacherCodes[1]);assert(!JSON.stringify(other).includes('Observación privada de Ana'));
  await director.getByRole('button',{name:'Consolidación y ternas',exact:true}).click();await director.getByRole('heading',{name:/Consolidación/}).waitFor();
  await director.getByRole('button',{name:'Actualizar información',exact:true}).click();
  const row=director.locator('table').first().locator('tbody tr').filter({hasText:'Editorial del ensayo de exposición'});await row.locator('td').nth(4).filter({hasText:/80[.,]00/}).waitFor();assert((await row.innerText()).includes('80'));
  await director.screenshot({path:'test-results/consolidado-cinco-docentes.png',fullPage:true});
 });
 await checked('a second selected category has an independent empty form',async()=>{
  const p=pages[0];const tabs=p.locator('[aria-label="Área y bloque de evaluación"] button');await tabs.nth(1).click();await p.getByRole('button',{name:'I1: 0 puntos',exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'I1: 0 puntos',exact:true}).getAttribute('aria-pressed'),'false');
 });
 await checked('public room excludes private observations and current unpublished teacher results',async()=>{
  const p=await newPage({width:390,height:844});await p.goto(`${base}/?vista=publica&datos=demo`);await p.getByRole('heading',{name:'Selección de textos escolares 2027',exact:true}).waitFor();const text=await p.locator('body').innerText();assert(!text.includes('Observación privada de Ana'));assert(!text.includes('Alvarado'));assert(!text.includes('80.00'));assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 });
 assert.deepEqual(errors,[]);
 writeFileSync('test-results/presentation-browser-results.json',JSON.stringify({at:new Date().toISOString(),backend:'Node/Express + PostgreSQL + PostgREST reales',passed:checks.length,checks,pageErrors:errors},null,2));
}catch(error){const message=secrets.reduce((s,secret)=>secret?s.split(secret).join('[redacted]'):s,String(error?.stack||error));console.error(message);process.exitCode=1;}
finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();}
