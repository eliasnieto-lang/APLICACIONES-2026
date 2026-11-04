import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApi, signInCoordinator, signOut } from '../src/client';
const config={mode:'cloud' as const,url:'https://fixture.invalid',publishableKey:'public-fixture-key',coordinatorEmail:'coord@example.invalid'};
test('coordinator authentication is omitted from public projection and anonymous voting',async()=>{
  const originalFetch=globalThis.fetch;
  const memory=new Map<string,string>();
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(k:string)=>memory.get(k)||null,setItem:(k:string,v:string)=>memory.set(k,v),removeItem:(k:string)=>memory.delete(k)}});
  const calls:{url:string;headers:Record<string,string>;body:any}[]=[];
  globalThis.fetch=async(input,init)=>{
    const url=String(input);calls.push({url,headers:init?.headers as Record<string,string>,body:JSON.parse(String(init?.body||'{}'))});
    return new Response(JSON.stringify(url.includes('/auth/v1/token')?{access_token:'coordinator-jwt-fixture',refresh_token:'refresh-fixture',expires_in:3600}:{accepted:true}),{status:200});
  };
  try{
    await signInCoordinator(config,'coord@example.invalid','fixture-password');
    const client=createApi(config,'real',{coordinator:true});
    await client.call('snapshot');
    await client.call('public_snapshot');
    await client.call('vote_cast',{choices:{MAT:null},confirmed:true});
    assert.equal(calls[1].headers.Authorization,'Bearer coordinator-jwt-fixture');
    assert.equal(calls[2].headers.Authorization,undefined);
    assert.equal(calls[3].headers.Authorization,undefined);
    const ballot=createApi(config,'real',{code:'fixture-anonymous-code'});
    await ballot.call('vote_preview');
    assert.equal(calls[4].body.p_code,'fixture-anonymous-code');
    assert(!calls[4].url.includes('fixture-anonymous-code'));
    assert.equal(calls[4].headers.Authorization,undefined);
    await client.call('teacher_register',{lastNames:'Fixture',firstNames:'Docente',area:'MAT',categories:['P1','P2']});
    await client.call('director_login',{password:'director-test-secret'});
    assert.equal(calls[5].headers.Authorization,undefined);
    assert.equal(calls[6].headers.Authorization,undefined);
    assert.equal(calls[6].body.p_code,null);
    const teacher=createApi(config,'real',{code:'own-private-fixture'});
    await teacher.call('teacher_register',{lastNames:'Fixture',firstNames:'Docente',area:'MAT',categories:['P1']});
    await teacher.call('public_snapshot');
    assert.equal(calls[7].body.p_code,'own-private-fixture');
    assert.equal(calls[7].headers.Authorization,undefined);
    assert(!calls[7].url.includes('own-private-fixture'));
    assert.equal(calls[8].body.p_code,null);
    assert.equal(calls[8].headers.Authorization,undefined);
    await signOut(config);
  }finally{globalThis.fetch=originalFetch;}
});
test('password entry parses nested authentication and rate-limit errors',async()=>{
  const originalFetch=globalThis.fetch;
  try{
    const client=createApi(config,'real');
    globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:'PT401',message:'La contraseña del subdirector no es correcta.'}}),{status:401});
    await assert.rejects(client.call('director_login',{password:'wrong-fixture'}),e=>e instanceof ApiError&&e.code==='PT401'&&e.status===401&&e.message.includes('subdirector'));
    globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:'PT429',message:'Espera antes del siguiente intento.'}}),{status:429});
    await assert.rejects(client.call('director_login',{password:'wrong-fixture'}),e=>e instanceof ApiError&&e.code==='PT429'&&e.status===429&&e.message.includes('Espera'));
  }finally{globalThis.fetch=originalFetch;}
});
test('CAS conflict is visible and network failure never claims confirmation',async()=>{
  const originalFetch=globalThis.fetch;
  try{
    const client=createApi(config,'demo',{code:'teacher-fixture'});
    globalThis.fetch=async()=>new Response(JSON.stringify({code:'PT409',message:'La ficha cambió en otra pestaña.'}),{status:409});
    await assert.rejects(client.call('evaluation_save'),e=>e instanceof ApiError&&e.status===409&&e.message.includes('otra pestaña'));
    globalThis.fetch=async()=>{throw new TypeError('Network failure')};
    await assert.rejects(client.call('vote_cast'),e=>e instanceof ApiError&&e.code==='NETWORK'&&e.message.includes('todavía no está confirmada'));
  }finally{globalThis.fetch=originalFetch;}
});
