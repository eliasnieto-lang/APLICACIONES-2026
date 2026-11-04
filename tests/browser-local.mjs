// Run only against a disposable local development installation, never production.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';
import { demoState } from '../shared/defaults.ts';
const base=process.env.TEXTOS_BROWSER_URL||'http://127.0.0.1:8080';
if(!/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/.test(base))throw Error('Only a local test URL is allowed.');
const owner=readFileSync('local/demo-owner-code.txt','utf8').trim();
const realOwner=readFileSync('local/owner-code.txt','utf8').trim();
async function rpc(action,payload={},code=owner,dataset='demo'){
  const r=await fetch(`${base}/api/rpc`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({p_action:action,p_payload:payload,p_code:code,p_dataset:dataset})});
  const value=await r.json();if(!r.ok)throw Error(`${action}: ${value.message}`);return value;
}
rmSync('test-results/browser-results.json',{force:true});
const fixture=demoState();await rpc('demo_reset',{state:fixture});
const first=fixture.books[0];const a=fixture.assignments.find(x=>x.bookId===first.id&&x.teacherId===fixture.teachers[0].id);const b=fixture.assignments.find(x=>x.bookId===first.id&&x.teacherId===fixture.teachers[1].id);
await rpc('evaluation_reopen',{assignmentId:a.id,reason:'Ensayo de navegador en demostración'});
await rpc('evaluation_reopen',{assignmentId:b.id,reason:'Ensayo simultáneo en demostración'});
const teacherA=(await rpc('access_create',{role:'teacher',teacherId:a.teacherId})).code;
const teacherB=(await rpc('access_create',{role:'teacher',teacherId:b.teacherId})).code;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const errors=[];const results=[];mkdirSync('test-results',{recursive:true});
const check=async(name,operation)=>{await operation();results.push(name);console.log(`✓ ${name}`)};
const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(20000);
async function login(target,code,coordinator=false,dataset='demo'){
  await target.goto(base);await target.getByRole('heading',{name:'Acceso a la jornada'}).waitFor();
  await target.getByLabel('Espacio de trabajo').selectOption(dataset);
  if(coordinator)await target.getByRole('button',{name:'Coordinación',exact:true}).click();
  await target.getByLabel(coordinator?'Código privado de coordinación':'Tu código individual',{exact:true}).fill(code);
  await target.getByRole('button',{name:'Entrar a la jornada',exact:true}).click();
  await target.getByRole('button',{name:'Salir',exact:true}).waitFor();
}
try{
  await check('correct application identity, working coordinator login and empty real dataset',async()=>{
    await login(page,realOwner,true,'real');assert((await page.title()).includes('Selección de textos escolares 2027'));
    await page.getByRole('heading',{name:/Elegir con evidencia/}).waitFor();
    assert.equal((await rpc('snapshot',{},realOwner,'real')).state.books.length,0);
    await page.screenshot({path:'test-results/panel-jornada-real.png',fullPage:true});
  });
  await login(page,owner,true);
  await check('catalog CSV preview is validated on real backend and requires explicit confirmation',async()=>{
    await page.getByRole('button',{name:'Preparar jornada',exact:true}).first().click();
    await page.getByRole('button',{name:'Importar CSV / XLSX',exact:true}).click();
    const csv='code,publisher,series,area,gradeId,title,edition,declaredBasePrice,priceSource\nBROWSER-MAT-PRI1,Editorial ensayo navegador,Serie ensayo navegador,MAT,PRI1,Texto ficticio ensayo,2027,120.50,Cotización de prueba\n';
    await page.getByLabel('Archivo CSV o XLSX').setInputFiles({name:'ensayo.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
    await page.getByText(/Listo para revisar y confirmar/).waitFor();
    assert.equal((await rpc('snapshot')).state.books.some(x=>x.code==='BROWSER-MAT-PRI1'),false);
    await page.getByRole('checkbox',{name:/Revisé las filas/}).check();
    await page.getByRole('button',{name:'Confirmar importación de 1 filas',exact:true}).click();
    await page.getByText('Carga aplicada y confirmada en servidor.',{exact:true}).waitFor();
    const imported=(await rpc('snapshot')).state.books.find(x=>x.code==='BROWSER-MAT-PRI1');assert(imported);assert.equal(imported.declaredBasePrice,120.5);assert.equal(imported.components.length,0);
  });
  await check('closed dossier correction records a reason and preserves its preceding version',async()=>{
    await page.getByRole('button',{name:/Títulos y expedientes/}).click();
    await page.getByLabel('Abrir expediente',{exact:true}).selectOption(fixture.books[1].id);
    await page.getByLabel('Ejemplares recibidos',{exact:true}).fill('3');
    await page.getByLabel('Motivo de la corrección',{exact:true}).fill('Conteo presencial actualizado en demostración');
    await page.getByRole('button',{name:'Guardar expediente',exact:true}).click();
    await page.getByText('Expediente guardado en servidor.',{exact:true}).first().waitFor();
    const changed=(await rpc('snapshot')).state.books.find(x=>x.id===fixture.books[1].id);assert.equal(changed.sampleQuantity,3);assert.equal(changed.version,2);
    const backup=await rpc('backup_get');assert(backup.history.some(x=>x.reference_id===changed.id&&x.reason==='Conteo presencial actualizado en demostración'));
  });
  const contextA=await browser.newContext({viewport:{width:1200,height:900}});const contextB=await browser.newContext({viewport:{width:1200,height:900}});
  const pa=await contextA.newPage();const pb=await contextB.newPage();pa.on('pageerror',e=>errors.push(e.message));pb.on('pageerror',e=>errors.push(e.message));
  await Promise.all([login(pa,teacherA),login(pb,teacherB)]);
  await check('two separate teacher sessions see own evaluations and independent saved drafts',async()=>{
    await pa.getByRole('heading',{name:'Mis evaluaciones',exact:true}).waitFor();
    await pb.getByRole('heading',{name:'Mis evaluaciones',exact:true}).waitFor();
    await pa.getByLabel('Texto que va a evaluar').selectOption(a.id);await pb.getByLabel('Texto que va a evaluar').selectOption(b.id);
    await pa.getByLabel('Observación individual',{exact:true}).first().fill('Observación privada A del ensayo de navegador');
    await pa.getByText('Guardado en servidor',{exact:true}).waitFor({timeout:30000});
    assert.equal((await pb.locator('body').innerText()).includes('Observación privada A del ensayo de navegador'),false);
    const remote=await rpc('snapshot',{},teacherB);assert.equal(JSON.stringify(remote).includes('Observación privada A del ensayo de navegador'),false);
    await pa.screenshot({path:'test-results/evaluacion-docente.png',fullPage:true});
  });
  await check('offline local draft recovers after reentry and only server confirms closure',async()=>{
    await pa.route('**/api/rpc',route=>{const p=route.request().postDataJSON();return p.p_action==='evaluation_save'?route.abort('failed'):route.continue()});
    await pa.getByLabel('Observación individual',{exact:true}).first().fill('Borrador recuperable tras corte de red');
    await pa.getByText(/Sin conexión\. La operación/).waitFor({timeout:30000});
    await pa.unroute('**/api/rpc');await login(pa,teacherA);
    await pa.getByRole('button',{name:'Recuperar borrador',exact:true}).waitFor();await pa.getByRole('button',{name:'Recuperar borrador',exact:true}).click();
    await pa.getByText('Guardado en servidor',{exact:true}).waitFor({timeout:30000});
    assert.equal(await pa.getByLabel('Observación individual',{exact:true}).first().inputValue(),'Borrador recuperable tras corte de red');
    await pa.getByRole('button',{name:'Cerrar ficha explícitamente',exact:true}).click();
    await pa.getByText('Ficha cerrada por el servidor. Sus puntajes originales se conservan.',{exact:true}).waitFor({timeout:30000});
    assert.equal((await rpc('snapshot',{},teacherA)).state.evaluations.find(x=>x.assignmentId===a.id).status,'closed');
    assert.equal((await rpc('snapshot',{},teacherB)).state.evaluations.find(x=>x.assignmentId===b.id).status,'draft');
  });
  await check('public projection contains no teacher identity or draft before authorized shortlist',async()=>{
    const pub=await browser.newPage({viewport:{width:390,height:844}});await pub.goto(`${base}/?vista=publica&datos=demo`);
    await pub.getByRole('heading',{name:'Selección de textos escolares 2027'}).waitFor();
    const text=await pub.locator('body').innerText();assert(!text.includes('Docente Ana'));assert(!text.includes('Observación privada'));assert(!text.includes('Borrador recuperable'));
    assert(await pub.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await pub.screenshot({path:'test-results/sala-publica-movil.png',fullPage:true});await pub.close();
  });
  await check('PDF assessment downloads from the running application',async()=>{
    await page.getByRole('button',{name:'Actas y respaldos',exact:true}).click();
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'Descargar PDF A4',exact:true}).click();
    const file=await download;assert(file.suggestedFilename().endsWith('.pdf'));await file.saveAs('test-results/ficha-navegador.pdf');
  });
  await contextA.close();await contextB.close();assert.deepEqual(errors,[]);
  writeFileSync('test-results/browser-results.json',JSON.stringify({application:'Selección de textos escolares 2027',backend:'PostgreSQL 16 + PostgREST + Node Express',at:new Date().toISOString(),passed:results.length,checks:results,pageErrors:errors},null,2));
}catch(error){await page.screenshot({path:'test-results/browser-failure.png',fullPage:true}).catch(()=>{});writeFileSync('test-results/browser-failure.txt',await page.locator('body').innerText().catch(()=>''));throw error;}finally{await browser.close();}
