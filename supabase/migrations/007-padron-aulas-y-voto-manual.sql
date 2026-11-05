-- Selección de textos 2027. Apply as database owner; rerunnable, isolated textos_ objects.
begin;
create table if not exists public.textos_datasets (
  id text primary key check (id in ('real','demo')), state jsonb not null, updated_at timestamptz not null default now()
);
create table if not exists public.textos_coordinators (user_id uuid primary key, name text not null default 'Coordinación');
create table if not exists public.textos_access (
  id uuid primary key default gen_random_uuid(), dataset text not null references public.textos_datasets(id),
  code_hash text not null unique, role text not null check(role in ('coordinator','secretary','teacher')),
  teacher_id text, name text not null, expires_at timestamptz not null, revoked boolean not null default false,
  check ((role='teacher') = (teacher_id is not null))
);
-- Private server-side credentials. Reruns preserve the installed password and throttle.
create table if not exists public.textos_director_credentials (
  dataset text primary key references public.textos_datasets(id), salt text not null check(salt ~ '^[a-f0-9]{64}$'),
  iterations integer not null check(iterations between 100000 and 1000000), password_hash text not null check(password_hash ~ '^[a-f0-9]{64}$')
);
create table if not exists public.textos_login_limits (
  dataset text primary key references public.textos_datasets(id), failures integer not null default 0 check(failures>=0),
  window_started_at timestamptz not null default now(), blocked_until timestamptz
);

-- No section, representative, chosen option or vote record exists in this table.
create table if not exists public.textos_ballots (
  code_hash text primary key, dataset text not null references public.textos_datasets(id), round_id text not null,
  consumed boolean not null default false
);
create index if not exists textos_ballots_round_idx on public.textos_ballots(dataset,round_id);
-- Aggregates deliberately have no ballot/code/identity column.
create table if not exists public.textos_aggregates (
  dataset text not null references public.textos_datasets(id), round_id text not null, area text not null check(area in ('MAT','COM')),
  option_id text not null, votes integer not null default 0 check(votes>=0), primary key(dataset,round_id,area,option_id)
);
create table if not exists public.textos_history (
  id bigint generated always as identity primary key, dataset text not null, entity text not null,
  reference_id text not null, actor text not null, reason text not null, previous jsonb not null, at timestamptz not null default now()
);

create or replace function public.textos_empty_state() returns jsonb language sql immutable set search_path=pg_catalog,public as $$
select jsonb_build_object('schemaVersion',1,'version',1,'settings',jsonb_build_object('version',1,'evaluationMode','presentation','presentationScaleMax',4,'school','I.E.P. Albert Einstein','title','Selección de textos escolares 2027','eventAt','2026-11-05T17:00:00-05:00','timezone','America/Lima','venue','Sede 2, Jr. Augusto B. Leguía N.º 246, Nicrupampa','organizers','Subdirección Académica','editorsWithdrawn',false,'withdrawalReference','','directorName','','rules',jsonb_build_object('version',1,'threshold',70,'teacherCount',2,'indicatorCount',10,'presentationSeconds',600,'transitionSeconds',120,'representationMode','count','minimumRepresentation',null,'practiceGuidelines','{}'::jsonb,'lockedAt',null)),'presentationEvaluations','[]'::jsonb,'presentationShortlists','[]'::jsonb,'publishers','[]'::jsonb,'series','[]'::jsonb,'offers','[]'::jsonb,'books','[]'::jsonb,'teachers','[]'::jsonb,'assignments','[]'::jsonb,'evaluations','[]'::jsonb,'reviews','[]'::jsonb,'turn',jsonb_build_object('publisherId',null,'status','ready','startedAt',null,'pausedAt',null,'pausedMilliseconds',0),'shortlists','[]'::jsonb,'sections','[]'::jsonb,'deliveries','[]'::jsonb,'rounds','[]'::jsonb,'incidents','[]'::jsonb,'audit','[]'::jsonb)
$$;
insert into public.textos_datasets(id,state) values ('real',public.textos_empty_state()),('demo',public.textos_empty_state()) on conflict do nothing;
insert into public.textos_coordinators(user_id,name) values ('b5f3904c-4557-4779-9879-33068ae28fa8','Coordinación') on conflict do nothing;

create or replace function public.textos_fail(message text, code text default 'PT400') returns void language plpgsql set search_path=pg_catalog,public as $$ begin raise exception using errcode=code,message=message; end $$;
create or replace function public.textos_hash(code text) returns text language sql immutable strict set search_path=pg_catalog,public as $$select encode(sha256(convert_to(code,'UTF8')),'hex')$$;
create or replace function public.textos_code() returns text language sql volatile set search_path=pg_catalog,public as $$select replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','')$$;
create or replace function public.textos_find(s jsonb, collection text, wanted text) returns jsonb language sql immutable set search_path=pg_catalog,public as $$ select x from jsonb_array_elements(coalesce(s->collection,'[]')) x where x->>'id'=wanted limit 1 $$;
create or replace function public.textos_put(s jsonb, collection text, entity jsonb) returns jsonb language sql immutable set search_path=pg_catalog,public as $$ select jsonb_set(s,array[collection],coalesce((select jsonb_agg(x) from jsonb_array_elements(coalesce(s->collection,'[]')) x where x->>'id'<>entity->>'id'),'[]')||jsonb_build_array(entity)) $$;
create or replace function public.textos_int(v jsonb, nullable boolean default false) returns boolean language sql immutable set search_path=pg_catalog,public as $$select case when v is null or v='null' then nullable else jsonb_typeof(v)='number' and v::text ~ '^[0-9]+$' end$$;
create or replace function public.textos_grades(block text) returns jsonb language sql immutable set search_path=pg_catalog,public as $$select case block when 'P1' then '["PRI1","PRI2"]'::jsonb when 'P2' then '["PRI3","PRI4","PRI5","PRI6"]'::jsonb when 'S1' then '["SEC1","SEC2","SEC3"]'::jsonb else '[]'::jsonb end$$;
create or replace function public.textos_block(grade text) returns text language sql immutable set search_path=pg_catalog,public as $$select case when grade in ('PRI1','PRI2') then 'P1' when grade in ('PRI3','PRI4','PRI5','PRI6') then 'P2' when grade in ('SEC1','SEC2','SEC3') then 'S1' end$$;
create or replace function public.textos_scores(scores jsonb, complete boolean default false) returns numeric language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare x jsonb; total integer:=0; pending boolean:=false;
begin
 if jsonb_typeof(scores) is distinct from 'array' or jsonb_array_length(scores)<>10 then perform public.textos_fail('La ficha requiere diez indicadores.'); end if;
 for x in select value from jsonb_array_elements(scores) loop
  if x='null' then pending:=true; elsif x not in ('0'::jsonb,'1'::jsonb,'2'::jsonb) then perform public.textos_fail('Puntaje inválido: use 0, 1, 2 o pendiente.'); else total:=total+x::integer; end if;
 end loop;
 if pending then if complete then perform public.textos_fail('Hay indicadores pendientes.'); end if; return null; end if;
 return total*5;
end $$;

create or replace function public.textos_validate_book(b jsonb) returns void language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare x jsonb; y jsonb; n integer; p text; k text;
begin
 if nullif(trim(b->>'title'),'') is null or nullif(trim(b->>'edition'),'') is null or nullif(trim(b->>'code'),'') is null or public.textos_block(b->>'gradeId') is null then perform public.textos_fail('Texto: código, título, edición y grado válidos son obligatorios.'); end if;
 if not public.textos_int(b->'sampleQuantity') or not public.textos_int(b->'availableWeeks',true) then perform public.textos_fail('Cantidades del texto inválidas.'); end if;
 if b->'declaredBasePrice'<>'null' and (jsonb_typeof(b->'declaredBasePrice')<>'number' or (b->>'declaredBasePrice')::numeric<0) then perform public.textos_fail('Precio inválido.'); end if;
 if jsonb_typeof(b->'checks') is distinct from 'array' or jsonb_typeof(b->'components') is distinct from 'array' or jsonb_typeof(b->'topics') is distinct from 'array' or jsonb_typeof(b->'chapters') is distinct from 'array' or jsonb_typeof(b->'practice') is distinct from 'array' or jsonb_typeof(b->'bimesters') is distinct from 'array' then perform public.textos_fail('Colecciones de expediente inválidas.'); end if;
 if jsonb_array_length(b->'checks')<>8 then perform public.textos_fail('Se requieren ocho filtros ministeriales.'); end if;
 for x in select value from jsonb_array_elements(b->'checks') loop if coalesce(x->>'status','') not in ('pending','pass','fail') or (x->>'status'<>'pending' and nullif(trim(x->>'evidence'),'') is null) then perform public.textos_fail('Filtro ministerial sin estado o sustento válido.'); end if; end loop;
 if jsonb_array_length(b->'bimesters')<>4 then perform public.textos_fail('Se requieren cuatro bimestres.'); end if;
 for x in select value from jsonb_array_elements(b->'bimesters') loop if not public.textos_int(x,true) then perform public.textos_fail('Bimestres: use enteros no negativos o pendiente.'); end if; if x='0' and nullif(trim(b->>'workloadNote'),'') is null then perform public.textos_fail('Un bimestre verificado sin temas requiere observación.'); end if; end loop;
 for x in select value from jsonb_array_elements(b->'components') loop if not public.textos_int(x->'quantity') or (x->'unitPrice'<>'null' and (jsonb_typeof(x->'unitPrice')<>'number' or (x->>'unitPrice')::numeric<0)) then perform public.textos_fail('Cantidad o precio de componente inválido.'); end if; end loop;
 if exists(select 1 from jsonb_array_elements(b->'topics') x group by x->>'code' having count(*)>1) or exists(select 1 from jsonb_array_elements(b->'topics') x group by x->>'order' having count(*)>1) then perform public.textos_fail('Tema o posición anual duplicado.'); end if;
 for x in select value from jsonb_array_elements(b->'topics') loop
  if nullif(x->>'code','') is null or not public.textos_int(x->'order') or (x->>'order')::int<1 or (x->'bimester'<>'null' and x->'bimester' not in ('1','2','3','4')) then perform public.textos_fail('Tema: código, orden o bimestre inválido.'); end if;
  if nullif(x->>'revisitOf','') is not null and not exists(select 1 from jsonb_array_elements(b->'topics') y where y->>'code'=x->>'revisitOf' and y->>'code'<>x->>'code') then perform public.textos_fail('El tema retomado debe referir otro tema existente.'); end if;
 end loop;
 for x in select value from jsonb_array_elements(b->'chapters') loop if not public.textos_int(x->'topicCount',true) then perform public.textos_fail('Cantidad de temas del capítulo inválida.'); end if; end loop;
 for x in select value from jsonb_array_elements(b->'practice') loop
  foreach k in array array['baseCount','workbookCount','optionalCount'] loop if not public.textos_int(x->k,true) then perform public.textos_fail('Conteo de práctica inválido.'); end if; end loop;
  if not public.textos_int(x->'position') or (x->>'position')::int<1 then perform public.textos_fail('Posición de muestra inválida.'); end if;
 end loop;
 if coalesce(b->>'supportKind','') not in ('none','platform','equivalent') or coalesce(b->>'workloadMode','') not in ('quick','detailed') then perform public.textos_fail('Modalidad de expediente inválida.'); end if;
 foreach k in array array['teacherSupport','studentSupport'] loop
  x:=b->k; if x->'extraCost'<>'null' and (jsonb_typeof(x->'extraCost')<>'number' or (x->>'extraCost')::numeric<0) then perform public.textos_fail('Costo de apoyo inválido.'); end if;
 end loop;
end $$;

create or replace function public.textos_support_limit(b jsonb) returns integer language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare t jsonb:=b->'teacherSupport'; u jsonb:=b->'studentSupport'; a boolean; c boolean;
begin
 if b->>'supportStatus'='pending' or b->>'supportStatus'='declared' then return null; end if;
 if b->>'supportKind'='none' and b->>'supportStatus'='not_offered' then return 0; end if;
 if b->>'supportKind'='equivalent' and not coalesce((b->>'equivalentAuthorized')::boolean,false) then return null; end if;
 if t->>'status' in ('pending','declared') or u->>'status' in ('pending','declared') then return null; end if;
 a:=t->>'status'='verified' and coalesce((t->>'included')::boolean,false) and nullif(trim(t->>'action'),'') is not null and nullif(trim(t->>'evidence'),'') is not null and nullif(t->>'testedAt','') is not null;
 c:=u->>'status'='verified' and coalesce((u->>'included')::boolean,false) and nullif(trim(u->>'action'),'') is not null and nullif(trim(u->>'evidence'),'') is not null and nullif(u->>'testedAt','') is not null;
 if t->>'status'='verified' and not a or u->>'status'='verified' and not c then return null; end if;
 return a::int+c::int;
end $$;

-- Strict pedagogical gates shared with shared/domain.ts.
-- Included by schema.sql after its basic helpers; this file has no transaction boundary.
create or replace function public.textos_profile_functional(p jsonb) returns boolean
language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare k text; action_text text; concrete boolean;
begin
 if p->>'status'='not_offered' or (p->>'status'='verified' and not coalesce((p->>'included')::boolean,false)) then return false; end if;
 if p->>'status' is distinct from 'verified' then return null; end if;
 foreach k in array array['access','devices','connection','mobile','offline','validity','renewal','support','action','evidence','testedAt'] loop
  if jsonb_typeof(p->k) is distinct from 'string' or nullif(trim(p->>k),'') is null then return null; end if;
 end loop;
 action_text:=translate(lower(trim(p->>'action')),'áéíóúüñ','aeiouun');
 concrete:=action_text ~ '(guia|planific|practic|asign|tarea|actividad|resultado|retroaliment|resolv|realiz|correg|leer|produc|unidad|ejercicio|consigna|lectura|aprendiz|sesion de clase)';
 if not concrete and action_text ~ '(acceso|ingres|acced|abrir|inicio|login|portada|pagina promocional)' then return null; end if;
 return true;
end $$;

create or replace function public.textos_support_limit(b jsonb) returns integer
language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare a boolean; c boolean;
begin
 if b->>'supportKind'='none' and b->>'supportStatus' in ('verified','not_offered') then return 0; end if;
 if b->>'supportStatus' is distinct from 'verified' or b->>'supportKind'='none'
  or (b->>'supportKind'='equivalent' and not coalesce((b->>'equivalentAuthorized')::boolean,false)) then return null; end if;
 a:=public.textos_profile_functional(b->'teacherSupport'); c:=public.textos_profile_functional(b->'studentSupport');
 if a is null or c is null then return null; end if;
 return a::integer+c::integer;
end $$;

create or replace function public.textos_dossier_ready(s jsonb,b jsonb) returns boolean
language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare o jsonb; x jsonb; y jsonb; k text; detailed boolean; topics jsonb; rawtopics jsonb; topic jsonb;
 n integer; pos integer; positions integer[]; actual_bimesters integer[]:=array[0,0,0,0];
 btotal integer:=0; ctotal integer:=0; chapter_count integer; expected integer; matches integer;
 note_present boolean; base numeric; hasbase boolean:=false; component_price numeric;
begin
 if b is null or not coalesce((b->>'active')::boolean,false) then return false; end if;
 o:=public.textos_find(s,'offers',b->>'offerId');
 if o is null or o->>'status' is distinct from 'offered' or b->>'edition' is distinct from o->>'edition'
  or public.textos_block(b->>'gradeId') is distinct from o->>'block' then return false; end if;
 if not coalesce((b->>'dossierClosed')::boolean,false) then return false; end if;
 foreach k in array array['title','edition','ministerialReference','obnate','obnateSource','dossierReference','priceSource','priceValidity','workloadSource'] loop
  if jsonb_typeof(b->k) is distinct from 'string' or nullif(trim(b->>k),'') is null then return false; end if;
 end loop;
 if nullif(trim(s#>>array['settings','rules','practiceGuidelines',(o->>'area')||'-'||(b->>'gradeId')]),'') is null then return false; end if;
 if jsonb_typeof(b->'checks') is distinct from 'array' then return false; end if;
 if jsonb_array_length(b->'checks')<>8 then return false; end if;
 for x in select value from jsonb_array_elements(b->'checks') loop
  if x->>'status' is distinct from 'pass' or nullif(trim(x->>'evidence'),'') is null then return false; end if;
 end loop;
 if b->>'priceStatus' is distinct from 'verified' or b->>'workloadStatus' is distinct from 'verified'
  or b->>'practiceStatus' is distinct from 'verified' or public.textos_support_limit(b) is null then return false; end if;
 -- A declared package price is authoritative; missing component prices stay unknown.
 if jsonb_typeof(b->'declaredBasePrice')='number' then
  base:=(b->>'declaredBasePrice')::numeric; if base<0 then return false; end if;
 else
  base:=0;
  for x in select value from jsonb_array_elements(coalesce(b->'components','[]')) where not coalesce((value->>'optional')::boolean,false) loop
   hasbase:=true;
   if not public.textos_int(x->'quantity') or coalesce((x->>'quantity')::integer,0)<1 or jsonb_typeof(x->'unitPrice') is distinct from 'number' then return false; end if;
   component_price:=(x->>'unitPrice')::numeric; if component_price<0 then return false; end if;
   base:=base+(x->>'quantity')::integer*component_price;
  end loop;
  if not hasbase then return false; end if;
 end if;
 note_present:=nullif(trim(b->>'workloadNote'),'') is not null;
 rawtopics:=coalesce(b->'topics','[]');
 if jsonb_typeof(rawtopics) is distinct from 'array' or jsonb_typeof(b->'bimesters') is distinct from 'array'
  or jsonb_typeof(b->'chapters') is distinct from 'array' then return false; end if;
 if jsonb_array_length(b->'bimesters')<>4 then return false; end if;
 detailed:=jsonb_array_length(rawtopics)>0 or b->>'workloadMode'='detailed';
 if detailed then
  if jsonb_array_length(rawtopics)=0 then return false; end if;
  if exists(select 1 from jsonb_array_elements(rawtopics) t group by t->>'code' having count(*)>1) then return false; end if;
  for x in select value from jsonb_array_elements(rawtopics) loop
   if nullif(trim(x->>'code'),'') is null then return false; end if;
   if nullif(x->>'revisitOf','') is not null and not coalesce((x->>'distinctLesson')::boolean,false) then
    if not exists(select 1 from jsonb_array_elements(rawtopics) t where (t->>'code'=x->>'revisitOf' or t->>'id'=x->>'revisitOf')
      and t<>x and nullif(t->>'revisitOf','') is null) then return false; end if;
   end if;
  end loop;
  select coalesce(jsonb_agg(t order by (t->>'order')::integer),'[]') into topics
   from jsonb_array_elements(rawtopics) t where nullif(t->>'revisitOf','') is null or coalesce((t->>'distinctLesson')::boolean,false);
  n:=jsonb_array_length(topics);
  if exists(select 1 from jsonb_array_elements(topics) t group by t->>'order' having count(*)>1) then return false; end if;
  for x in select value from jsonb_array_elements(topics) loop
   if not public.textos_int(x->'order') or coalesce((x->>'order')::integer,0)<1
    or coalesce(x->>'bimester','') not in ('1','2','3','4')
    or nullif(trim(x->>'name'),'') is null or nullif(trim(x->>'chapter'),'') is null or nullif(trim(x->>'pages'),'') is null then return false; end if;
   pos:=(x->>'bimester')::integer; actual_bimesters[pos]:=actual_bimesters[pos]+1;
  end loop;
  for pos in 1..4 loop
   x:=b->'bimesters'->(pos-1);
   if public.textos_int(x) and (x::text)::integer<>actual_bimesters[pos] and not note_present then return false; end if;
  end loop;
  for x in select value from jsonb_array_elements(b->'chapters') loop
   select count(*) into expected from jsonb_array_elements(topics) t where t->>'chapter'=x->>'name';
   if public.textos_int(x->'topicCount') and (x->>'topicCount')::integer<>expected and not note_present then return false; end if;
  end loop;
 else
  n:=0;
  for pos in 1..4 loop
   x:=b->'bimesters'->(pos-1);
   if not public.textos_int(x) then return false; end if;
   actual_bimesters[pos]:=(x::text)::integer; n:=n+actual_bimesters[pos];
  end loop;
  if jsonb_array_length(b->'chapters')=0 then return false; end if;
  for x in select value from jsonb_array_elements(b->'chapters') loop
   if not public.textos_int(x->'topicCount') or nullif(trim(x->>'name'),'') is null or nullif(trim(x->>'source'),'') is null then return false; end if;
   ctotal:=ctotal+(x->>'topicCount')::integer;
  end loop;
  if ctotal<>n and not note_present then return false; end if;
 end if;
 if 0=any(actual_bimesters) and not note_present then return false; end if;
 if n<1 or jsonb_typeof(b->'practice') is distinct from 'array' then return false; end if;
 positions:=case when n=1 then array[1] when n=2 then array[1,2] else array[1,(n+1)/2,n] end;
 foreach pos in array positions loop
  if detailed then
   topic:=topics->(pos-1);
   select count(*) into matches from jsonb_array_elements(b->'practice') p where p->>'topicId'=topic->>'id' or p->>'topicId'=topic->>'code';
   select p into y from jsonb_array_elements(b->'practice') p where p->>'topicId'=topic->>'id' or p->>'topicId'=topic->>'code' limit 1;
  else
   select count(*) into matches from jsonb_array_elements(b->'practice') p where p->>'position'=pos::text;
   select p into y from jsonb_array_elements(b->'practice') p where p->>'position'=pos::text limit 1;
  end if;
  if matches<>1 or y->>'position' is distinct from pos::text or not public.textos_int(y->'baseCount')
   or not coalesce((y->>'verified')::boolean,false) or nullif(trim(y->>'evidence'),'') is null
   or nullif(trim(y->>'topicName'),'') is null or nullif(trim(y->>'pages'),'') is null then return false; end if;
 end loop;
 return true;
end $$;

-- All candidates in one shared review must be complete before its figures are comparable.
-- The category function additionally checks that this review covers the whole cutoff cohort.
create or replace function public.textos_additional(s jsonb,o jsonb,only_grade text default null) returns numeric
language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare review jsonb; rid text; oid text; candidate jsonb; gs jsonb; grade text; b jsonb;
 initial jsonb; extra jsonb; e jsonb; initial_mean numeric; extra_mean numeric;
 subtotal numeric:=0; selected_total numeric:=null; grade_count integer; lim integer;
begin
 select r into review from jsonb_array_elements(coalesce(s->'reviews','[]')) with ordinality rr(r,ord)
  where r->>'categoryId'=(o->>'area')||'-'||(o->>'block') and nullif(trim(r->>'unitReference'),'') is not null
   and nullif(trim(r->>'reason'),'') is not null order by ord desc limit 1;
 if review is null or not (review->'offerIds' ? (o->>'id')) then return null; end if;
 rid:=review->>'id';
 for oid in select jsonb_array_elements_text(review->'offerIds') loop
  candidate:=public.textos_find(s,'offers',oid);
  if candidate is null or candidate->>'status'<>'offered' or (candidate->>'area')||'-'||(candidate->>'block')<>review->>'categoryId' then return null; end if;
  gs:=case when only_grade is null then public.textos_grades(candidate->>'block') else jsonb_build_array(only_grade) end;
  subtotal:=0; grade_count:=0;
  for grade in select jsonb_array_elements_text(gs) loop
   if (select count(*) from jsonb_array_elements(s->'books') bk where bk->>'offerId'=oid and bk->>'gradeId'=grade and coalesce((bk->>'active')::boolean,false))<>1 then return null; end if;
   select bk into b from jsonb_array_elements(s->'books') bk where bk->>'offerId'=oid and bk->>'gradeId'=grade and coalesce((bk->>'active')::boolean,false);
   if not public.textos_dossier_ready(s,b) then return null; end if;
   if (select count(*) from jsonb_array_elements(s->'assignments') a where a->>'bookId'=b->>'id' and a->>'kind'='initial')<>2
    or (select count(*) from jsonb_array_elements(s->'assignments') a where a->>'bookId'=b->>'id' and a->>'kind'='additional' and a->>'reviewId'=rid)<>2 then return null; end if;
   select coalesce(jsonb_agg(ev),'[]') into initial from jsonb_array_elements(s->'assignments') a
    join jsonb_array_elements(s->'evaluations') ev on ev->>'assignmentId'=a->>'id'
    where a->>'bookId'=b->>'id' and a->>'kind'='initial' and ev->>'bookId'=b->>'id' and ev->>'teacherId'=a->>'teacherId'
     and ev->>'status'='closed' and ev->>'bookVersion'=b->>'version' and ev->>'rulesVersion'=s#>>'{settings,rules,version}';
   select coalesce(jsonb_agg(ev),'[]') into extra from jsonb_array_elements(s->'assignments') a
    join jsonb_array_elements(s->'evaluations') ev on ev->>'assignmentId'=a->>'id'
    where a->>'bookId'=b->>'id' and a->>'kind'='additional' and a->>'reviewId'=rid
     and ev->>'bookId'=b->>'id' and ev->>'teacherId'=a->>'teacherId' and ev->>'status'='closed'
     and ev->>'bookVersion'=b->>'version' and ev->>'rulesVersion'=s#>>'{settings,rules,version}';
   if jsonb_array_length(initial)<>2 or jsonb_array_length(extra)<>2
    or (select count(distinct ev->>'teacherId') from jsonb_array_elements(initial) ev)<>2
    or (select count(distinct ev->>'teacherId') from jsonb_array_elements(extra) ev)<>2
    or exists(select 1 from jsonb_array_elements(extra) ev where not exists(select 1 from jsonb_array_elements(initial) ie where ie->>'teacherId'=ev->>'teacherId')) then return null; end if;
   lim:=public.textos_support_limit(b);
   for e in select value from jsonb_array_elements(initial||extra) loop
    if coalesce((e->>'legacyIndicatorCount')::integer,10)<10 or jsonb_array_length(e->'evidence')<>10
     or exists(select 1 from jsonb_array_elements_text(e->'evidence') ref where nullif(trim(ref),'') is null)
     or (coalesce((e->>'objection')::boolean,false) and nullif(trim(e->>'objectionDetail'),'') is null)
     or (e#>>'{scores,9}')::integer>lim or (lim<2 and (e#>>'{scores,9}')::integer<>lim) then return null; end if;
    if public.textos_scores(e->'scores',true) is null then return null; end if;
   end loop;
   select avg(public.textos_scores(ev->'scores',true)) into initial_mean from jsonb_array_elements(initial) ev;
   select avg(public.textos_scores(ev->'scores',true)) into extra_mean from jsonb_array_elements(extra) ev;
   subtotal:=subtotal+(initial_mean+extra_mean)/2; grade_count:=grade_count+1;
  end loop;
  if grade_count<>jsonb_array_length(gs) or grade_count=0 then return null; end if;
  if oid=o->>'id' then selected_total:=subtotal/grade_count; end if;
 end loop;
 return selected_total;
end $$;

create or replace function public.textos_book_assessment(s jsonb, b jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare es jsonb; score numeric; i2 numeric; reason jsonb:='[]'; st text:='eligible'; x jsonb; n integer;
begin
 if b is null or not coalesce((b->>'active')::boolean,false) then return jsonb_build_object('bookId',b->>'id','state','not_offered','score',null,'i2',null,'reasons',jsonb_build_array('Sin oferta para el grado')); end if;
 if exists(select 1 from jsonb_array_elements(b->'checks') x where x->>'status'='fail') then st:='ineligible'; reason:=reason||'"Incumplimiento de filtro ministerial"'; end if;
 if not public.textos_dossier_ready(s,b) then
  if st<>'ineligible' then st:='pending'; end if; reason:=reason||'"Verificaciones del expediente pendientes"';
 end if;
 select coalesce(jsonb_agg(e),'[]') into es from jsonb_array_elements(s->'evaluations') e join jsonb_array_elements(s->'assignments') a on a->>'id'=e->>'assignmentId' where a->>'bookId'=b->>'id' and a->>'kind'='initial' and e->>'status'='closed' and e->>'bookVersion'=b->>'version' and e->>'rulesVersion'=s#>>'{settings,rules,version}' and coalesce((e->>'legacyIndicatorCount')::integer,10)=10 and jsonb_array_length(e->'evidence')=10 and not exists(select 1 from jsonb_array_elements_text(e->'evidence') ref where nullif(trim(ref),'') is null) and (not coalesce((e->>'objection')::boolean,false) or nullif(trim(e->>'objectionDetail'),'') is not null) and public.textos_support_limit(b) is not null and (e#>>'{scores,9}')::int<=public.textos_support_limit(b) and (public.textos_support_limit(b)=2 or (e#>>'{scores,9}')::int=public.textos_support_limit(b));
 if jsonb_array_length(es)<>2 or (select count(distinct e->>'teacherId') from jsonb_array_elements(es) e)<>2 then
  if st<>'ineligible' then st:='pending'; end if; reason:=reason||'"Se requieren dos fichas cerradas de docentes distintos y de esta edición"';
 else
  select avg(public.textos_scores(e->'scores',true)),avg((e#>>'{scores,1}')::numeric) into score,i2 from jsonb_array_elements(es) e;
  if score<(s#>>'{settings,rules,threshold}')::numeric then st:='ineligible'; reason:=reason||jsonb_build_array('Nota del grado menor al corte institucional'); end if;
 end if;
 return jsonb_build_object('bookId',b->>'id','state',st,'score',score,'i2',i2,'reasons',reason);
end $$;

create or replace function public.textos_offer_assessment(s jsonb, o jsonb, only_grade text default null) returns jsonb language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare gs jsonb; g text; b jsonb; a jsonb; rows jsonb:='[]'; score numeric; i2 numeric; extra numeric; st text:='eligible'; reasons jsonb:='[]';
begin
 if o->>'status'='withdrawn' then return jsonb_build_object('offerId',o->>'id','state','withdrawn','score',null,'i2',null,'additional',null,'grades','[]'::jsonb,'reasons',jsonb_build_array(o->>'withdrawalReason')); end if;
 gs:=case when only_grade is null then public.textos_grades(o->>'block') else jsonb_build_array(only_grade) end;
 for g in select jsonb_array_elements_text(gs) loop
  select x into b from jsonb_array_elements(s->'books') x where x->>'offerId'=o->>'id' and x->>'gradeId'=g and coalesce((x->>'active')::boolean,false);
  a:=public.textos_book_assessment(s,b); rows:=rows||jsonb_build_array(a);
  if a->>'state' in ('not_offered','ineligible') then st:='ineligible'; elsif a->>'state'='pending' and st='eligible' then st:='pending'; end if;
 end loop;
 -- A missing assessment always blocks publication, even when another grade already fails.
 if exists(select 1 from jsonb_array_elements(rows) x where x->>'state'='pending') then st:='pending'; end if;
 if not exists(select 1 from jsonb_array_elements(rows) x where x->'score'='null') then select avg((x->>'score')::numeric),avg((x->>'i2')::numeric) into score,i2 from jsonb_array_elements(rows) x; end if;
 extra:=public.textos_additional(s,o,only_grade);
 return jsonb_build_object('offerId',o->>'id','state',st,'score',score,'i2',i2,'additional',extra,'grades',rows,'reasons',reasons);
end $$;

create or replace function public.textos_category(s jsonb, category text, only_grade text default null) returns jsonb language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare candidates jsonb:='[]'; ranked jsonb; o jsonb; a jsonb; n integer; third jsonb; fourth jsonb; finalists jsonb; st text; tied jsonb:='[]';
begin
 if category !~ '^(MAT|COM)-(P1|P2|S1)$' then perform public.textos_fail('Categoría inválida.'); end if;
 for o in select x from jsonb_array_elements(s->'offers') x where (x->>'area')||'-'||(x->>'block')=category loop candidates:=candidates||jsonb_build_array(public.textos_offer_assessment(s,o,only_grade)); end loop;
 select coalesce(jsonb_agg(x order by (x->>'score')::numeric desc nulls last,(x->>'i2')::numeric desc nulls last),'[]') into ranked from jsonb_array_elements(candidates) x where x->>'state'='eligible';
 if jsonb_array_length(ranked)>3 then
  third:=ranked->2; fourth:=ranked->3;
  if third->'score'=fourth->'score' and third->'i2'=fourth->'i2' and exists(select 1 from jsonb_array_elements(ranked) x where x->'score'=third->'score' and x->'i2'=third->'i2' and x->'additional'='null') then
   select jsonb_agg(case when x->'score'=third->'score' and x->'i2'=third->'i2' then x||jsonb_build_object('additional',null) else x end) into candidates from jsonb_array_elements(candidates) x;
  end if;
 end if;
 select coalesce(jsonb_agg(x order by (x->>'score')::numeric desc nulls last,(x->>'i2')::numeric desc nulls last,(x->>'additional')::numeric desc nulls last),'[]') into ranked from jsonb_array_elements(candidates) x where x->>'state'='eligible';
 n:=jsonb_array_length(ranked); st:='ready';
 if exists(select 1 from jsonb_array_elements(candidates) x where x->>'state'='pending') then st:='review'; elsif n<3 then st:='less_than_three';
 elsif n>3 then
  third:=ranked->2; fourth:=ranked->3;
  if third->'score'=fourth->'score' and third->'i2'=fourth->'i2' and (third->'additional'='null' or fourth->'additional'='null' or third->'additional'=fourth->'additional') then
   st:='tie'; select jsonb_agg(x->'offerId') into tied from jsonb_array_elements(ranked) x where x->'score'=third->'score' and x->'i2'=third->'i2';
  end if;
 end if;
 select coalesce(jsonb_agg(x->'offerId'),'[]') into finalists from (select value x from jsonb_array_elements(ranked) with ordinality r(value,ord) where ord<=3) q;
 if st<>'ready' then finalists:='[]'; end if;
 return jsonb_build_object('categoryId',category,'state',st,'ranked',candidates,'finalists',finalists,'tied',tied,'reasons',jsonb_build_array(case st when 'review' then 'Quedan ofertas pendientes en esta categoría' when 'tie' then 'Empate en el corte: requiere revisión comparable' when 'less_than_three' then 'Menos de tres ofertas comunes aptas' else '' end));
end $$;

create or replace function public.textos_source_target(source text) returns text language plpgsql immutable set search_path=pg_catalog,public as $$
declare v text:=regexp_replace(translate(lower(trim(source)),'áéíóúüñ.º°ª','aeiouun'),'\s+',' ','g'); m text[]; num integer; level text;
begin
 if v ~ '^(ini5|inicial ?5( anos)?|5 ?anos|5 de inicial|inicial de 5 anos)$' then return 'PRI1'; end if;
 m:=regexp_match(v,'^(pri|sec)([1-6])$');
 if m is not null then level:=m[1]; num:=m[2]::int;
 else
  m:=regexp_match(v,'([1-6])(ro|do|to|er)? *(de *)?(primaria|secundaria)');
  if m is not null then num:=m[1]::int; level:=case m[4] when 'primaria' then 'pri' else 'sec' end;
  else m:=regexp_match(v,'(primaria|secundaria) *([1-6])'); if m is not null then num:=m[2]::int; level:=case m[1] when 'primaria' then 'pri' else 'sec' end; end if; end if;
 end if;
 if level='pri' then return case when num=6 then 'SEC1' else 'PRI'||(num+1)::text end; end if;
 if level='sec' and num<3 then return 'SEC'||(num+1)::text; end if;
 return null;
end $$;

create or replace function public.textos_validate_state(s jsonb) returns void language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare k text; x jsonb; y jsonb; z jsonb; o jsonb;
begin
 if s->>'schemaVersion' is distinct from '1' or jsonb_typeof(s->'settings') is distinct from 'object' then perform public.textos_fail('Formato de respaldo incompatible.'); end if;
 foreach k in array array['publishers','series','offers','books','teachers','assignments','evaluations','reviews','shortlists','sections','rounds','incidents','audit','deliveries'] loop
  if jsonb_typeof(s->k) is distinct from 'array' then perform public.textos_fail('Colección inválida: '||k); end if;
  if k not in ('audit','deliveries') and exists(select 1 from jsonb_array_elements(s->k) z where jsonb_typeof(z) is distinct from 'object' or nullif(trim(z->>'id'),'') is null or not public.textos_int(z->'version') or (z->>'version')::int<1) then perform public.textos_fail('Identificador o versión inválida: '||k); end if;
  if k not in ('audit','deliveries') and exists(select 1 from jsonb_array_elements(s->k) x group by x->>'id' having count(*)>1) then perform public.textos_fail('Identificador duplicado: '||k); end if;
 end loop;
 if jsonb_typeof(s#>'{settings,rules}') is distinct from 'object' or jsonb_typeof(s#>'{settings,rules,threshold}') is distinct from 'number' or not (s#>'{settings,rules}' ? 'minimumRepresentation') or coalesce(s#>>'{settings,rules,representationMode}','') not in ('count','percentage') or jsonb_typeof(s#>'{settings,rules,practiceGuidelines}') is distinct from 'object' then perform public.textos_fail('Reglas incompletas.'); end if;
 if s#>'{settings,rules,minimumRepresentation}'<>'null' and ((s#>>'{settings,rules,minimumRepresentation}')::numeric<0 or (s#>>'{settings,rules,representationMode}'='percentage' and (s#>>'{settings,rules,minimumRepresentation}')::numeric>100) or (s#>>'{settings,rules,representationMode}'='count' and not public.textos_int(s#>'{settings,rules,minimumRepresentation}'))) then perform public.textos_fail('Representación mínima inválida.'); end if;
 if s#>>'{settings,rules,teacherCount}'<>'2' or s#>>'{settings,rules,indicatorCount}'<>'10' or not public.textos_int(s#>'{settings,rules,version}') or (s#>>'{settings,rules,threshold}')::numeric not between 0 and 100 or not public.textos_int(s#>'{settings,rules,presentationSeconds}') or (s#>>'{settings,rules,presentationSeconds}')::int<1 or not public.textos_int(s#>'{settings,rules,transitionSeconds}') or s#>>'{settings,rules,representationMode}' not in ('count','percentage') or (s#>'{settings,rules,minimumRepresentation}'<>'null' and ((s#>>'{settings,rules,minimumRepresentation}')::numeric<0 or (s#>>'{settings,rules,minimumRepresentation}')::numeric>10000)) then perform public.textos_fail('Reglas inválidas.'); end if;
 for x in select value from jsonb_array_elements(s->'series') loop if public.textos_find(s,'publishers',x->>'publisherId') is null or nullif(trim(x->>'name'),'') is null then perform public.textos_fail('Serie sin editorial o nombre.'); end if; end loop;
 for x in select value from jsonb_array_elements(s->'offers') loop
  if public.textos_find(s,'series',x->>'seriesId') is null or x->>'area' not in ('MAT','COM') or x->>'block' not in ('P1','P2','S1') or nullif(x->>'edition','') is null or x->>'status' not in ('offered','withdrawn') then perform public.textos_fail('Oferta inválida.'); end if;
  if x->>'status'='withdrawn' and nullif(trim(x->>'withdrawalReason'),'') is null then perform public.textos_fail('El retiro requiere motivo.'); end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(s->'offers') x where x->>'status'='offered' group by x->>'seriesId',x->>'area',x->>'block' having count(*)>1) then perform public.textos_fail('Una serie solo puede tener una edición ofrecida por área y bloque.'); end if;
 for x in select value from jsonb_array_elements(s->'books') loop
  perform public.textos_validate_book(x); o:=public.textos_find(s,'offers',x->>'offerId');
  if o is null or public.textos_block(x->>'gradeId')<>o->>'block' or x->>'edition'<>o->>'edition' then perform public.textos_fail('El texto cruza grado/bloque/oferta.'); end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(s->'books') x group by x->>'code' having count(*)>1) then perform public.textos_fail('Código de texto duplicado.'); end if;
 if exists(select 1 from jsonb_array_elements(s->'books') x where (x->>'active')::boolean group by x->>'offerId',x->>'gradeId' having count(*)>1) then perform public.textos_fail('Dos textos activos para la misma oferta/grado.'); end if;
 for x in select value from jsonb_array_elements(s->'assignments') loop
  if public.textos_find(s,'books',x->>'bookId') is null or public.textos_find(s,'teachers',x->>'teacherId') is null or x->>'kind' not in ('initial','additional') then perform public.textos_fail('Asignación sin texto/docente válido.'); end if;
  if x->>'kind'='additional' then
   y:=public.textos_find(s,'reviews',x->>'reviewId'); z:=public.textos_find(s,'books',x->>'bookId');
   if y is null or not (y->'offerIds' ? (z->>'offerId')) or not exists(select 1 from jsonb_array_elements(s->'assignments') ia where ia->>'kind'='initial' and ia->>'bookId'=x->>'bookId' and ia->>'teacherId'=x->>'teacherId') then perform public.textos_fail('La revisión adicional requiere una solicitud comparable y los mismos docentes.'); end if;
  end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(s->'assignments') x group by x->>'bookId',x->>'teacherId',x->>'kind',coalesce(x->>'reviewId','') having count(*)>1) or exists(select 1 from jsonb_array_elements(s->'assignments') x where x->>'kind'='initial' group by x->>'bookId' having count(*)>2) then perform public.textos_fail('Docente duplicado o más de dos evaluadores iniciales por texto.'); end if;
 for x in select value from jsonb_array_elements(s->'evaluations') loop
  perform public.textos_scores(x->'scores',x->>'status'='closed'); y:=public.textos_find(s,'assignments',x->>'assignmentId');
  if y is null or y->>'bookId'<>x->>'bookId' or y->>'teacherId'<>x->>'teacherId' then perform public.textos_fail('Ficha incompatible con su asignación.'); end if;
  if jsonb_array_length(x->'evidence')<>10 or jsonb_array_length(x->'notes')<>10 then perform public.textos_fail('La ficha requiere diez referencias y observaciones.'); end if;
  if x->>'status'='closed' and exists(select 1 from jsonb_array_elements_text(x->'evidence') v where nullif(trim(v),'') is null) then perform public.textos_fail('Ficha cerrada sin sustento por indicador.'); end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(s->'evaluations') x group by x->>'assignmentId' having count(*)>1) then perform public.textos_fail('Ficha duplicada.'); end if;
 for x in select value from jsonb_array_elements(s->'sections') loop
  if public.textos_source_target(x->>'sourceGrade') is not null and public.textos_source_target(x->>'sourceGrade') is distinct from x->>'gradeId' then perform public.textos_fail('El grado de origen no corresponde al grado representado 2027.'); end if;
  if public.textos_block(x->>'gradeId') is null or nullif(trim(x->>'label'),'') is null or nullif(trim(x->>'sourceGrade'),'') is null or (x->'accredited'='true' and public.textos_source_target(x->>'sourceGrade') is null) then perform public.textos_fail('Sección o grado inválido.'); end if; end loop;
 if exists(select 1 from jsonb_array_elements(s->'sections') x group by lower(x->>'sourceGrade'),lower(x->>'label') having count(*)>1) then perform public.textos_fail('Sección de origen duplicada en el padrón.'); end if;
 if exists(select 1 from jsonb_array_elements(s->'sections') x group by x->>'gradeId',lower(x->>'label') having count(*)>1) then perform public.textos_fail('Representación duplicada por sección/grado.'); end if;
 for x in select value from jsonb_array_elements(s->'shortlists') loop
  if coalesce(x->>'categoryId','') !~ '^(MAT|COM)-(P1|P2|S1)$' or coalesce(x->>'status','') not in ('draft','published','superseded') or coalesce(x->>'scope','') not in ('block','grade') or jsonb_typeof(x->'offerIds') is distinct from 'array' or jsonb_typeof(x->'gradeIds') is distinct from 'array' then perform public.textos_fail('Versión de terna inválida.'); end if;
  if jsonb_array_length(x->'offerIds') not between 1 and 3 or (select count(distinct q) from jsonb_array_elements(x->'offerIds') q)<>jsonb_array_length(x->'offerIds') then perform public.textos_fail('Terna con alternativas duplicadas o más de tres.'); end if;
  for y in select value from jsonb_array_elements(x->'offerIds') loop
   z:=public.textos_find(s,'offers',y#>>'{}'); if z is null or (z->>'area')||'-'||(z->>'block')<>x->>'categoryId' then perform public.textos_fail('La terna cruza área/bloque/oferta.'); end if;
  end loop;
  if exists(select 1 from jsonb_array_elements_text(x->'gradeIds') q where public.textos_block(q) is distinct from split_part(x->>'categoryId','-',2)) then perform public.textos_fail('Grado ajeno a la terna.'); end if;
  if x->>'status'='published' and (x->'directorApproved' is distinct from 'true'::jsonb or nullif(trim(x->>'folio'),'') is null or (jsonb_array_length(x->'offerIds')<3 and x->'article113' is distinct from 'true'::jsonb)) then perform public.textos_fail('Terna publicada sin validación o excepción documentada.'); end if;
 end loop;
 for x in select value from jsonb_array_elements(s->'rounds') loop
  if public.textos_block(x->>'gradeId') is null or coalesce(x->>'mode','') not in ('paper','digital') or coalesce(x->>'status','') not in ('draft','open','closed','suspended','void') or jsonb_typeof(x->'areas') is distinct from 'array' or jsonb_typeof(x->'options') is distinct from 'object' or jsonb_typeof(x->'counts') is distinct from 'object' then perform public.textos_fail('Ronda de votación inválida.'); end if;
  if jsonb_array_length(x->'areas') not between 1 and 2 or (select count(distinct q) from jsonb_array_elements(x->'areas') q)<>jsonb_array_length(x->'areas') or exists(select 1 from jsonb_array_elements_text(x->'areas') q where q not in ('MAT','COM')) then perform public.textos_fail('Áreas de ronda inválidas.'); end if;
  if not public.textos_int(x->'number') or (x->>'number')::int not between 1 and 2 or not public.textos_int(x->'minimumRequired') or not public.textos_int(x->'delivered') or not public.textos_int(x->'deposited') or (x->>'deposited')::int>(x->>'delivered')::int then perform public.textos_fail('Cantidades de ronda inválidas.'); end if;
  for k in select jsonb_array_elements_text(x->'areas') loop
   y:=public.textos_find(s,'shortlists',x#>>array['shortlistIds',k]);
   if y is null or y->>'categoryId'<>k||'-'||public.textos_block(x->>'gradeId') or not(y->'gradeIds' ? (x->>'gradeId')) or jsonb_typeof(x#>array['options',k]) is distinct from 'array' then perform public.textos_fail('La cédula carece de una terna del grado/área.'); end if;
   if (x->>'number')::int=1 then z:=y->'offerIds'; else o:=public.textos_find(s,'rounds',x->>'parentId'); if o is null then perform public.textos_fail('Segunda vuelta sin ronda original.'); end if; z:=o#>array['results',k,'tiedIds']; end if;
   if (select jsonb_agg(q order by q) from jsonb_array_elements(z) q) is distinct from (select jsonb_agg(q order by q) from jsonb_array_elements(x#>array['options',k]) q) then perform public.textos_fail('Opciones de cédula ajenas a la terna o segunda vuelta.'); end if;
   if jsonb_typeof(x#>array['counts',k,'options']) is distinct from 'object' or not public.textos_int(x#>array['counts',k,'blank']) or not public.textos_int(x#>array['counts',k,'invalid']) or exists(select 1 from jsonb_each(x#>array['counts',k,'options']) q where not public.textos_int(q.value) or not(x#>array['options',k] ? q.key)) then perform public.textos_fail('Conteos de ronda inválidos.'); end if;
  end loop;
 end loop;
 if exists(select 1 from jsonb_array_elements(s->'deliveries') q group by q->>'roundId',q->>'sectionId' having count(*)>1) then perform public.textos_fail('Entrega duplicada.'); end if;
 for x in select value from jsonb_array_elements(s->'deliveries') loop
  y:=public.textos_find(s,'rounds',x->>'roundId'); z:=public.textos_find(s,'sections',x->>'sectionId');
  if y is null or z is null or y->>'gradeId'<>z->>'gradeId' or x->'delivered' is null or x->'delivered' not in ('true'::jsonb,'false'::jsonb) then perform public.textos_fail('Entrega con sección/grado/ronda inválidos.'); end if;
 end loop;

 perform public.textos_presentation_validate(s);
 perform public.textos_question_validate(s);
 perform public.textos_jornada_validate(s);
 perform public.textos_paper_validate(s);
end $$;

create or replace function public.textos_public_state(s jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare outstate jsonb:=public.textos_empty_state(); sl jsonb; ids jsonb; r jsonb; k text;
begin
 outstate:=jsonb_set(outstate,'{version}',s->'version');
 if s->'presentationDraw' is not null then outstate:=jsonb_set(outstate,'{presentationDraw}',public.textos_jornada_draw_public(s->'presentationDraw')); end if;
 if s->'presentationQuestions' is not null then outstate:=jsonb_set(outstate,'{presentationQuestions}',public.textos_question_public(s->'presentationQuestions')); end if;
 outstate:=jsonb_set(outstate,'{paperPolls}',public.textos_paper_public(coalesce(s->'paperPolls','[]')));
 outstate:=jsonb_set(outstate,'{settings}',s->'settings'); outstate:=jsonb_set(outstate,'{turn}',s->'turn');
 outstate:=jsonb_set(outstate,'{publishers}',coalesce((select jsonb_agg(jsonb_build_object('id',x->>'id','version',x->'version','name',x->>'name','samplesReceived',x->'samplesReceived','sampleNote','')) from jsonb_array_elements(s->'publishers') x),'[]'));
 select coalesce(jsonb_agg(x-'snapshot'||jsonb_build_object('snapshot',jsonb_build_object('assessment',jsonb_build_object('categoryId',x->>'categoryId','state','published','finalists',x->'offerIds','ranked',coalesce((select jsonb_agg(jsonb_build_object('offerId',a->>'offerId','score',a->'score','i2',a->'i2','grades',coalesce((select jsonb_agg(g-'reasons') from jsonb_array_elements(a->'grades') g where exists(select 1 from jsonb_array_elements(x#>'{snapshot,books}') bk where bk->>'id'=g->>'bookId' and x->'gradeIds' ? (bk->>'gradeId'))),'[]'))) from jsonb_array_elements(x#>'{snapshot,assessment,ranked}') a where x->'offerIds' ? (a->>'offerId')),'[]')),'rules',x#>'{snapshot,rules}'))),'[]') into sl from jsonb_array_elements(s->'shortlists') x where x->>'status'='published';
 -- Snapshot only includes pedagogic ranking after authorized publication, never provisional scores.
 outstate:=jsonb_set(outstate,'{shortlists}',sl);
 select coalesce(jsonb_agg(distinct id),'[]') into ids from jsonb_array_elements(sl) x cross join lateral jsonb_array_elements(x->'offerIds') id;
 outstate:=jsonb_set(outstate,'{offers}',coalesce((select jsonb_agg(x) from jsonb_array_elements(s->'offers') x where ids ? (x->>'id')),'[]'));
 outstate:=jsonb_set(outstate,'{series}',coalesce((select jsonb_agg(x) from jsonb_array_elements(s->'series') x where exists(select 1 from jsonb_array_elements(outstate->'offers') o where o->>'seriesId'=x->>'id')),'[]'));
 outstate:=jsonb_set(outstate,'{books}',coalesce((select jsonb_agg(x-'checks'-'obnateSource'-'ministerialReference'-'dossierReference') from jsonb_array_elements(s->'books') x where ids ? (x->>'offerId') and (x->>'active')::boolean and exists(select 1 from jsonb_array_elements(sl) q where q->'offerIds' ? (x->>'offerId') and q->'gradeIds' ? (x->>'gradeId'))),'[]'));
 outstate:=jsonb_set(outstate,'{rounds}',coalesce((select jsonb_agg(x) from jsonb_array_elements(s->'rounds') x where x->>'status'='closed'),'[]'));
 return public.textos_presentation_public_state(outstate||jsonb_build_object('presentationShortlists',coalesce(s->'presentationShortlists','[]')));
end $$;

create or replace function public.textos_round_result(r jsonb, area text) returns jsonb language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare n integer; maxvotes integer; tied jsonb; state text; winner text;
begin
 select coalesce(sum(value::text::integer),0),coalesce(max(value::text::integer),0) into n,maxvotes from jsonb_each(coalesce(r#>array['counts',area,'options'],'{}'));
 select coalesce(jsonb_agg(key),'[]') into tied from jsonb_each(coalesce(r#>array['counts',area,'options'],'{}')) where value::text::integer=maxvotes and maxvotes>0;
 state:=case when (r->>'deposited')::integer<(r->>'minimumRequired')::integer then 'insufficient_representation' when n=0 then 'no_valid_votes' when jsonb_array_length(tied)>1 then 'tie' when jsonb_array_length(tied)=1 then 'winner' else 'pending' end;
 if state='winner' then winner:=tied->>0; end if;
 return jsonb_build_object('state',state,'winnerId',winner,'tiedIds',case when state='tie' then tied else '[]'::jsonb end);
end $$;

create or replace function public.textos_blank_support() returns jsonb language sql immutable set search_path=pg_catalog,public as $$ select jsonb_build_object('access','','devices','','connection','','mobile','','offline','','validity','','included',true,'extraCost',null,'renewal','','support','','action','','evidence','','testedAt','','status','pending') $$;

create or replace function public.textos_blank_book() returns jsonb language sql immutable set search_path=pg_catalog,public as $$
select jsonb_build_object('id','','version',0,'code','','offerId','','gradeId','PRI1','title','','edition','','authors','','active',true,'obnate','','obnateSource','','ministerialReference','','checks',(select jsonb_agg(jsonb_build_object('status','pending','evidence','','note','')) from generate_series(1,8)),'sampleTable','','sampleQuantity',0,'familyAvailability','','components','[]'::jsonb,'declaredBasePrice',null,'priceSource','','priceValidity','','priceStatus','declared','workloadMode','quick','bimesters','[null,null,null,null]'::jsonb,'chapters','[]'::jsonb,'topics','[]'::jsonb,'workloadSource','','mappingOrigin','editorial','workloadStatus','pending','workloadNote','','availableWeeks',null,'practice','[]'::jsonb,'practiceStatus','pending','supportKind','none','equivalentAuthorized',false,'supportStatus','pending','supportNote','','teacherSupport',public.textos_blank_support(),'studentSupport',public.textos_blank_support(),'dossierClosed',false,'dossierReference','')
$$;

create or replace function public.textos_import(s jsonb, kind text, rows jsonb) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare r jsonb; x jsonb; b jsonb; p jsonb; se jsonb; o jsonb; n integer:=1; topic jsonb; v text;
begin
 if coalesce(kind,'') not in ('titles','topics','practice','sections') or jsonb_typeof(rows) is distinct from 'array' or jsonb_array_length(rows)>2000 then perform public.textos_fail('Importación inválida; máximo 2000 filas.'); end if;
 for r in select value from jsonb_array_elements(rows) loop
  n:=n+1;
  if kind='titles' then
   if exists(select 1 from jsonb_array_elements(s->'books') z where z->>'code'=r->>'code') then perform public.textos_fail('Fila '||n||': código de texto duplicado.'); end if;
   select z into p from jsonb_array_elements(s->'publishers') z where lower(z->>'name')=lower(r->>'publisher');
   if p is null then if s->'presentationDraw' is not null and ((s#>>'{turn,startedAt}') is not null or jsonb_array_length(s#>'{presentationDraw,completedPublisherIds}')>0) then perform public.textos_fail('La jornada sorteada ya comenzó. No puede importar editoriales nuevas.','PT423'); end if; p:=jsonb_build_object('id',gen_random_uuid()::text,'version',1,'name',r->>'publisher','samplesReceived',false,'sampleNote',''); s:=public.textos_put(s,'publishers',p); end if;
   select z into se from jsonb_array_elements(s->'series') z where z->>'publisherId'=p->>'id' and lower(z->>'name')=lower(r->>'series');
   if se is null then se:=jsonb_build_object('id',gen_random_uuid()::text,'version',1,'publisherId',p->>'id','name',r->>'series'); s:=public.textos_put(s,'series',se); end if;
   select z into o from jsonb_array_elements(s->'offers') z where z->>'seriesId'=se->>'id' and z->>'area'=r->>'area' and z->>'block'=r->>'block' and z->>'edition'=r->>'edition';
   if o is null then o:=jsonb_build_object('id',gen_random_uuid()::text,'version',1,'seriesId',se->>'id','area',r->>'area','block',r->>'block','edition',r->>'edition','status','offered','withdrawalReason',''); s:=public.textos_put(s,'offers',o); end if;
   b:=public.textos_blank_book()||jsonb_build_object('id',gen_random_uuid()::text,'version',1,'offerId',o->>'id')||(r-array['publisher','series','area','block']); s:=public.textos_put(s,'books',b);
  elsif kind in ('topics','practice') then
   select z into b from jsonb_array_elements(s->'books') z where z->>'code'=r->>'bookCode' and (z->>'active')::boolean;
   if b is null then perform public.textos_fail('Fila '||n||': texto no encontrado.'); end if;
   if coalesce((b->>'dossierClosed')::boolean,false) then perform public.textos_fail('Fila '||n||': expediente cerrado; reabra con motivo.','PT423'); end if;
   if kind='topics' then
    if exists(select 1 from jsonb_array_elements(b->'topics') z where z->>'code'=r->>'code' or z->'order'=r->'order') then perform public.textos_fail('Fila '||n||': tema o posición duplicado.'); end if;
    x:=(r-'bookCode')||jsonb_build_object('id',gen_random_uuid()::text); b:=jsonb_set(b,'{topics}',b->'topics'||jsonb_build_array(x)); b:=jsonb_set(b,'{workloadMode}','"detailed"');
   else
    if exists(select 1 from jsonb_array_elements(b->'practice') z where z->'position'=r->'position') then perform public.textos_fail('Fila '||n||': muestra duplicada.'); end if;
    select z into topic from jsonb_array_elements(b->'topics') z where z->>'code'=r->>'topicCode';
    if nullif(r->>'topicCode','') is not null and topic is null then perform public.textos_fail('Fila '||n||': tema de muestra no encontrado.'); end if;
    x:=(r-array['bookCode','topicCode'])||jsonb_build_object('topicId',coalesce(topic->>'id','')); b:=jsonb_set(b,'{practice}',b->'practice'||jsonb_build_array(x));
   end if;
   b:=jsonb_set(b,'{version}',to_jsonb((b->>'version')::int+1)); s:=public.textos_put(s,'books',b);
  else
   if exists(select 1 from jsonb_array_elements(s->'sections') z where z->>'gradeId'=r->>'gradeId' and lower(z->>'label')=lower(r->>'label')) then perform public.textos_fail('Fila '||n||': sección duplicada.'); end if;
   s:=public.textos_put(s,'sections',r||jsonb_build_object('id',gen_random_uuid()::text,'version',1));
  end if;
 end loop;
 perform public.textos_validate_state(s); return s;
end $$;

-- Metadata-only upgrade: missing live rubric metadata always means the historical 0–2 scale.
-- Stored marks and published percentage figures are never multiplied or reinterpreted.
create or replace function public.textos_presentation_upgrade_scale(s jsonb) returns jsonb
language plpgsql immutable strict set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare e jsonb; migrated jsonb; item record;
begin
 if jsonb_typeof(s) is distinct from 'object' then return s; end if;
 if jsonb_typeof(s->'settings')='object' and s#>'{settings,presentationScaleMax}' is distinct from '4'::jsonb then
  s:=jsonb_set(s,'{settings,presentationScaleMax}','4');
  s:=jsonb_set(s,'{settings,version}',to_jsonb(coalesce((s#>>'{settings,version}')::integer,0)+1));
 end if;
 if not (s ? 'presentationEvaluations') then s:=jsonb_set(s,'{presentationEvaluations}','[]'); end if;
 if not (s ? 'presentationShortlists') then s:=jsonb_set(s,'{presentationShortlists}','[]'); end if;
 if jsonb_typeof(s->'presentationEvaluations')='array' then
  for item in select value,ordinality from jsonb_array_elements(s->'presentationEvaluations') with ordinality loop
   e:=item.value;
   if jsonb_typeof(e)='object' and not (e ? 'scaleMax') then
    s:=jsonb_set(s,array['presentationEvaluations',(item.ordinality-1)::text],e||jsonb_build_object('scaleMax',2));
   end if;
  end loop;
 end if;
 if jsonb_typeof(s->'presentationShortlists')='array' then
  for item in select value,ordinality from jsonb_array_elements(s->'presentationShortlists') with ordinality loop
   e:=item.value; migrated:=e;
   if jsonb_typeof(e->'snapshot')='object' and not ((e->'snapshot') ? 'scaleMax') then migrated:=jsonb_set(migrated,'{snapshot,scaleMax}','2'); end if;
   if e->>'status'='published' and migrated#>'{snapshot,scaleMax}' is distinct from '4'::jsonb then
    migrated:=migrated||jsonb_build_object('status','superseded','version',(e->>'version')::integer+1);
   end if;
   if migrated is distinct from e then s:=jsonb_set(s,array['presentationShortlists',(item.ordinality-1)::text],migrated); end if;
  end loop;
 end if;
 return s;
end $$;

create or replace function public.textos_upgrade_legacy(s jsonb) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare e jsonb;
begin
 for e in select value from jsonb_array_elements(coalesce(s->'evaluations','[]')) loop
  if jsonb_typeof(e->'scores')='array' and jsonb_array_length(e->'scores')=8 then
   e:=e||jsonb_build_object('scores',e->'scores'||'[null,null]'::jsonb,'evidence',coalesce(e->'evidence','["","","","","","","",""]'::jsonb)||'["",""]'::jsonb,'notes',coalesce(e->'notes','["","","","","","","",""]'::jsonb)||'["",""]'::jsonb,'status','draft','closedAt',null,'legacyIndicatorCount',8);
   s:=public.textos_put(s,'evaluations',e);
  end if;
 end loop; return public.textos_presentation_upgrade_scale(s);
end $$;

-- Built-in SHA-256 only: works on local PostgreSQL and Supabase without extensions.
create or replace function public.textos_password_hash(password text, salt text, iterations integer) returns text
language plpgsql immutable strict set search_path=pg_catalog,public as $$
declare digest bytea; salt_bytes bytea:=decode(salt,'hex'); i integer;
begin
 if iterations not between 100000 and 1000000 then perform public.textos_fail('Configuración de acceso inválida.'); end if;
 digest:=sha256(convert_to(password,'UTF8')||salt_bytes);
 for i in 2..iterations loop digest:=sha256(digest||salt_bytes); end loop;
 return encode(digest,'hex');
end $$;

create or replace function public.textos_canonical_name(name text) returns text
language sql immutable strict set search_path=pg_catalog,public as $$
select regexp_replace(translate(lower(trim(name)),'áéíóúüñàèìòùâêîôûäëïöç','aeiouunaeiouaeiouaeioc'),'[[:space:]]+',' ','g')
$$;

create or replace function public.textos_teacher_profile(profile jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog,public as $$
declare first_names text; last_names text; categories jsonb; item jsonb;
begin
 if jsonb_typeof(profile->'firstNames') is distinct from 'string' or jsonb_typeof(profile->'lastNames') is distinct from 'string' then perform public.textos_fail('Ingrese sus apellidos y nombres.'); end if;
 first_names:=regexp_replace(trim(profile->>'firstNames'),'[[:space:]]+',' ','g');
 last_names:=regexp_replace(trim(profile->>'lastNames'),'[[:space:]]+',' ','g');
 if length(first_names) not between 2 and 100 or length(last_names) not between 2 and 100
  or first_names !~ '^[[:alpha:]][[:alpha:] .''’\-]*$' or last_names !~ '^[[:alpha:]][[:alpha:] .''’\-]*$' then perform public.textos_fail('Ingrese nombres y apellidos válidos, de 2 a 100 caracteres cada uno.'); end if;
 if jsonb_typeof(profile->'area') is distinct from 'string' or coalesce(profile->>'area','') not in ('MAT','COM') then perform public.textos_fail('Seleccione Matemática o Comunicación.'); end if;
 if jsonb_typeof(profile->'categories') is distinct from 'array' then perform public.textos_fail('Seleccione al menos una categoría.'); end if;
 if jsonb_array_length(profile->'categories') not between 1 and 3 then perform public.textos_fail('Seleccione una o más categorías válidas.'); end if;
 for item in select value from jsonb_array_elements(profile->'categories') loop
  if item not in ('"P1"'::jsonb,'"P2"'::jsonb,'"S1"'::jsonb) then perform public.textos_fail('Categoría no válida.'); end if;
 end loop;
 if (select count(distinct value) from jsonb_array_elements(profile->'categories'))<>jsonb_array_length(profile->'categories') then perform public.textos_fail('No repita categorías.'); end if;
 select jsonb_agg(value order by ord) into categories from (values ('P1',1),('P2',2),('S1',3)) v(value,ord) where profile->'categories' ? value;
 return jsonb_build_object('name',last_names||' '||first_names,'firstNames',first_names,'lastNames',last_names,'area',profile->>'area','categories',categories,'selfRegistered',true);
end $$;

-- Explicit role projection also protects registration when the caller has a coordinator JWT.
create or replace function public.textos_snapshot(s jsonb, actor_role text, actor_id text, actor_name text, dataset text, nowat timestamptz) returns jsonb
language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare k text;
begin
 s:=s||jsonb_build_object('presentationEvaluations',coalesce(s->'presentationEvaluations','[]'),'presentationShortlists',coalesce(s->'presentationShortlists','[]'));
 if s->'presentationRanking' is not null then s:=jsonb_set(s,'{presentationRanking,stale}',to_jsonb(not public.textos_jornada_ranking_current(s))); end if;
 if actor_role='teacher' then
  s:=s-'presentationRanking'-'paperPolls';
  if s->'presentationQuestions' is not null then s:=jsonb_set(s,'{presentationQuestions}',public.textos_question_teacher(s->'presentationQuestions')); end if;
  if s->'presentationDraw' is not null then s:=jsonb_set(s,'{presentationDraw}',public.textos_jornada_draw_public(s->'presentationDraw')); end if;
  s:=jsonb_set(s,'{evaluations}',coalesce((select jsonb_agg(q) from jsonb_array_elements(s->'evaluations') q where q->>'teacherId'=actor_id),'[]'));
  s:=jsonb_set(s,'{assignments}',coalesce((select jsonb_agg(q) from jsonb_array_elements(s->'assignments') q where q->>'teacherId'=actor_id),'[]'));
  s:=jsonb_set(s,'{books}',coalesce((select jsonb_agg(q) from jsonb_array_elements(s->'books') q where exists(select 1 from jsonb_array_elements(s->'assignments') asn where asn->>'bookId'=q->>'id')),'[]'));
  s:=jsonb_set(s,'{teachers}',coalesce((select jsonb_agg(q) from jsonb_array_elements(s->'teachers') q where q->>'id'=actor_id),'[]'));
  foreach k in array array['shortlists','sections','deliveries','rounds','incidents','audit','reviews'] loop s:=jsonb_set(s,array[k],'[]'); end loop;
  s:=public.textos_presentation_teacher_state(s,actor_id);
 elsif actor_role='secretary' then
  s:=s-'presentationRanking'-'paperPolls';
  foreach k in array array['evaluations','assignments','reviews','presentationEvaluations'] loop s:=jsonb_set(s,array[k],'[]'); end loop;
 end if;
 return jsonb_build_object('state',s,'actor',jsonb_build_object('id',actor_id,'name',actor_name,'role',actor_role),'serverNow',nowat,'dataset',dataset);
end $$;

-- Seed only a salted digest; never place the password in public client configuration.
insert into public.textos_director_credentials(dataset,salt,iterations,password_hash)
select id,'11e4e537491f46dfff427e120b1dbfd99ef37ac8310a07f3f3d9e4ca5b2cb14b',120000,'209c229fc5a43edfbbac8f4f503494a7f1e68d57d76df5f93f36678aeaf6185a' from public.textos_datasets on conflict do nothing;

-- BEGIN QUESTION HELPERS
-- BEGIN REQUIRED QUESTION HELPERS
-- Subdirección records a single confirmation that the required exchange occurred.
-- Each evaluator scores I11 independently; this record never authorizes a grade.

create or replace function public.textos_question_find(s jsonb,publisher_id text) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select q from jsonb_array_elements(coalesce(s->'presentationQuestions','[]')) q
 where q->>'publisherId'=publisher_id and q->>'status'='answered' limit 1
$$;

create or replace function public.textos_question_validate(s jsonb) returns void
language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare q jsonb; key text; asked timestamptz; answered timestamptz; updated timestamptz;
begin
 if s->'presentationQuestions' is null then return; end if;
 if jsonb_typeof(s->'presentationQuestions') is distinct from 'array' then perform public.textos_fail('El registro de preguntas debe ser una lista.'); end if;
 if exists(select 1 from jsonb_array_elements(s->'presentationQuestions') x group by x->>'id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(s->'presentationQuestions') x group by x->>'publisherId' having count(*)>1) then
  perform public.textos_fail('Solo corresponde una confirmación de pregunta por editorial.');
 end if;
 for q in select value from jsonb_array_elements(s->'presentationQuestions') loop
  if jsonb_typeof(q) is distinct from 'object' or nullif(trim(q->>'id'),'') is null
   or public.textos_find(s,'publishers',q->>'publisherId') is null
   or not public.textos_int(q->'version') or (q->>'version')::int<1
   or coalesce(q->>'status','') not in ('draft','answered')
   or jsonb_typeof(q->'updatedAt') is distinct from 'string' then
   perform public.textos_fail('Registro de confirmación de pregunta inválido.');
  end if;
  if q ? 'confirmed' and (jsonb_typeof(q->'confirmed') is distinct from 'boolean'
   or (q->'confirmed'='true'::jsonb) is distinct from (q->>'status'='answered')) then
   perform public.textos_fail('La confirmación de pregunta debe coincidir con su estado.');
  end if;
  -- The former detailed fields remain valid in existing records and backups.
  foreach key in array array['representativeName','question','answer'] loop
   if q ? key and jsonb_typeof(q->key) is distinct from 'string' then perform public.textos_fail('Los datos anteriores de la pregunta deben ser texto.'); end if;
  end loop;
  if q ? 'area' and q->'area'<>'null'::jsonb and coalesce(q->>'area','') not in ('MAT','COM') then perform public.textos_fail('Área de pregunta inválida.'); end if;
  if length(q->>'representativeName')>160 or length(q->>'question')>2000 or length(q->>'answer')>3000 then perform public.textos_fail('El registro de pregunta supera la longitud permitida.'); end if;
  begin
   if nullif(q->>'updatedAt','') is null then perform public.textos_fail('La confirmación requiere fecha de actualización.'); end if;
   updated:=(q->>'updatedAt')::timestamptz;
   asked:=nullif(q->>'askedAt','')::timestamptz;
   answered:=nullif(q->>'answeredAt','')::timestamptz;
   if not isfinite(updated) or asked is not null and not isfinite(asked) or answered is not null and not isfinite(answered) then perform public.textos_fail('La fecha de confirmación no es válida.'); end if;
  exception when invalid_datetime_format or datetime_field_overflow then perform public.textos_fail('La fecha de pregunta o respuesta no es válida.'); end;
  if q->>'status'='answered' and (asked is null or answered is null or answered<asked or updated<answered) then
   perform public.textos_fail('La confirmación requiere fechas coherentes.');
  end if;
  if q->>'status'='answered' and not(q ? 'confirmed') and (nullif(trim(q->>'representativeName'),'') is null
   or coalesce(q->>'area','') not in ('MAT','COM') or nullif(trim(q->>'question'),'') is null or nullif(trim(q->>'answer'),'') is null) then
   perform public.textos_fail('El registro anterior requiere conservar el representante, la pregunta y la respuesta.');
  end if;
 end loop;
end $$;

create or replace function public.textos_question_can_finish(s jsonb,publisher_id text) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
 select exists(select 1 from jsonb_array_elements(coalesce(s->'presentationQuestions','[]')) q
  where q->>'publisherId'=publisher_id and q->>'status'='answered'
  and nullif(q->>'askedAt','') is not null and nullif(q->>'answeredAt','') is not null
  and (q->'confirmed'='true'::jsonb or not(q ? 'confirmed') and q->>'area' in ('MAT','COM')
   and nullif(trim(q->>'representativeName'),'') is not null and nullif(trim(q->>'question'),'') is not null and nullif(trim(q->>'answer'),'') is not null))
$$;

-- Enumerate projections so restored private fields cannot become public.
create or replace function public.textos_question_public(questions jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',q->>'id','publisherId',q->>'publisherId','version',q->'version',
  'confirmed',coalesce(q->'confirmed','true'::jsonb),'representativeName','','area',q->>'area','question',q->>'question','answer',q->>'answer','status',q->>'status',
  'askedAt',q->'askedAt','answeredAt',q->'answeredAt','updatedAt',q->>'updatedAt')) order by ord),'[]'::jsonb)
 from jsonb_array_elements(coalesce(questions,'[]')) with ordinality item(q,ord) where q->>'status'='answered'
$$;

create or replace function public.textos_question_teacher(questions jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',q->>'id','publisherId',q->>'publisherId','version',q->'version',
  'confirmed',coalesce(q->'confirmed','true'::jsonb),'representativeName',q->>'representativeName','area',q->>'area','question',q->>'question','answer',q->>'answer','status',q->>'status',
  'askedAt',q->'askedAt','answeredAt',q->'answeredAt','updatedAt',q->>'updatedAt')) order by ord),'[]'::jsonb)
 from jsonb_array_elements(coalesce(questions,'[]')) with ordinality item(q,ord) where q->>'status'='answered'
$$;

create or replace function public.textos_question_action(s jsonb,p_action text,p_payload jsonb,actor_role text,actor_id text,actor_name text,p_dataset text,nowat timestamptz) returns jsonb
language plpgsql volatile set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare publisher_id text:=p_payload->>'publisherId'; old jsonb; entity jsonb; reason text:=trim(coalesce(p_payload->>'reason',''));
 history jsonb:='[]'; status text; key text; finished boolean; changed boolean;
begin
 if actor_role is distinct from 'coordinator' then perform public.textos_fail('Solo Subdirección confirma la pregunta y respuesta de la editorial.','PT403'); end if;
 if p_action is distinct from 'presentation_question_save' then perform public.textos_fail('Operación de preguntas desconocida.','PT404'); end if;
 if public.textos_find(s,'publishers',publisher_id) is null then perform public.textos_fail('La editorial no existe en esta jornada.','PT404'); end if;
 if p_payload ? 'confirmed' then
  if jsonb_typeof(p_payload->'confirmed') is distinct from 'boolean' then perform public.textos_fail('La confirmación debe ser una casilla válida.'); end if;
  status:=case when p_payload->'confirmed'='true'::jsonb then 'answered' else 'draft' end;
  if p_payload ? 'status' and p_payload->>'status' is distinct from status then perform public.textos_fail('La confirmación y el estado no coinciden.'); end if;
 else
  status:=p_payload->>'status';
  if coalesce(status,'') not in ('draft','answered') then perform public.textos_fail('Confirme que la pregunta fue formulada y respondida.'); end if;
 end if;
 foreach key in array array['representativeName','question','answer'] loop
  if p_payload ? key and jsonb_typeof(p_payload->key) is distinct from 'string' then perform public.textos_fail('Los datos anteriores de la pregunta deben ser texto.'); end if;
 end loop;
 if p_payload ? 'area' and coalesce(p_payload->>'area','') not in ('MAT','COM') then perform public.textos_fail('Área de pregunta inválida.'); end if;
 if length(p_payload->>'representativeName')>160 or length(p_payload->>'question')>2000 or length(p_payload->>'answer')>3000 or length(reason)>1000 then perform public.textos_fail('El registro de pregunta supera la longitud permitida.'); end if;
 select q into old from jsonb_array_elements(coalesce(s->'presentationQuestions','[]')) q where q->>'publisherId'=publisher_id;
 if not public.textos_int(p_payload->'expectedVersion') or (p_payload->>'expectedVersion')::int<>coalesce((old->>'version')::int,0) then
  perform public.textos_fail('La confirmación cambió en otra pantalla. Actualice antes de guardar.','PT409');
 end if;
 -- Checkbox-only requests preserve former transcripts without requiring them again.
 entity:=coalesce(old,'{}');
 foreach key in array array['representativeName','area','question','answer'] loop
  if p_payload ? key then entity:=entity||jsonb_build_object(key,case when key='area' then p_payload->>key else trim(p_payload->>key) end); end if;
 end loop;
 changed:=old is null or old->>'status' is distinct from status
  or (entity-'confirmed') is distinct from (old-'confirmed');
 finished:=coalesce(s#>'{presentationDraw,completedPublisherIds}' ? publisher_id,false)
  or coalesce(s#>>'{turn,publisherId}'=publisher_id and s#>>'{turn,status}'='finished',false);
 -- A deleted confirmation can be restored after finalization without altering grades.
 if old->>'status'='answered' and changed and finished then perform public.textos_fail('La exposición ya finalizó; su confirmación se conserva.','PT423'); end if;
 if not changed then return jsonb_build_object('state',s,'result',old,'referenceId',old->>'id','reason','Confirmación ya registrada sin cambios','history',history); end if;
 entity:=entity||jsonb_build_object('id',coalesce(old->>'id',gen_random_uuid()::text),'publisherId',publisher_id,
  'version',case when old is null then (s->>'version')::int+1 else (old->>'version')::int+1 end,'confirmed',status='answered','status',status,
  'askedAt',case when status='answered' then coalesce(nullif(old->'askedAt','null'::jsonb),to_jsonb(nowat)) else 'null'::jsonb end,
  'answeredAt',case when status='answered' then coalesce(nullif(old->'answeredAt','null'::jsonb),to_jsonb(nowat)) else 'null'::jsonb end,'updatedAt',nowat);
 if old is not null then history:=jsonb_build_array(jsonb_build_object('entity','presentationQuestions','referenceId',old->>'id','previous',old,'reason',coalesce(nullif(reason,''),'Actualización de la confirmación de pregunta obligatoria'))); end if;
 s:=public.textos_put(s,'presentationQuestions',entity);
 perform public.textos_question_validate(s);
 return jsonb_build_object('state',s,'result',entity,'referenceId',entity->>'id',
  'reason',case when status='answered' then 'Pregunta del representante y respuesta de la editorial confirmadas' else 'Confirmación de pregunta desmarcada' end,'history',history);
end $$;
-- END REQUIRED QUESTION HELPERS
-- END QUESTION HELPERS

-- BEGIN LIVE PRESENTATION HELPERS
-- Live presentations: independent of historical book dossiers and two-review assignments.
-- Insert before textos_api; only textos_api is granted to application roles.
-- Each stored rubric owns its scale. Missing historical metadata means 0–2.
create or replace function public.textos_presentation_scores(scores jsonb, scale_max integer default 4, complete boolean default false) returns numeric
language plpgsql immutable set search_path=pg_catalog,public as $$
declare x jsonb; total integer:=0; pending boolean:=false;
begin
 if scale_max is null or scale_max not in (2,4) then perform public.textos_fail('Escala de exposición inválida.'); end if;
 if jsonb_typeof(scores) is distinct from 'array' then perform public.textos_fail('La ficha requiere diez indicadores.'); end if;
 if jsonb_array_length(scores)<>10 then perform public.textos_fail('La ficha requiere diez indicadores.'); end if;
 for x in select value from jsonb_array_elements(scores) loop
  if x='null'::jsonb then pending:=true;
  elsif not public.textos_int(x) then perform public.textos_fail('Use enteros de 0 a '||scale_max||' o pendiente.');
  elsif (x::text)::numeric>scale_max then perform public.textos_fail('Use enteros de 0 a '||scale_max||' o pendiente.');
  else total:=total+(x::text)::integer;
  end if;
 end loop;
 if pending then
  if complete then perform public.textos_fail('Hay indicadores pendientes.'); end if;
  return null;
 end if;
 return total*100::numeric/(10*scale_max);
end $$;

-- Rubric metadata preserves the original ten-criterion percentages without conversion.
create or replace function public.textos_presentation_score_of(e jsonb, complete boolean default false) returns numeric
language plpgsql immutable set search_path=pg_catalog,public as $$
declare base numeric; maximum integer; response jsonb;
begin
 maximum:=case when e->'scaleMax'='4'::jsonb then 4 else 2 end;
 base:=public.textos_presentation_scores(e->'scores',maximum,complete);
 if e ? 'rubricVersion' and e->'rubricVersion' is distinct from '2'::jsonb then perform public.textos_fail('Versión de rúbrica inválida.'); end if;
 if e ? 'questionVersion' and e->'questionVersion'<>'null'::jsonb and (not public.textos_int(e->'questionVersion') or (e->>'questionVersion')::numeric<1) then perform public.textos_fail('La versión histórica de pregunta debe ser un entero positivo o quedar vacía.'); end if;
 if e->'rubricVersion'='2'::jsonb then
  if maximum<>4 then perform public.textos_fail('La rúbrica de once criterios requiere escala 0–4.'); end if;
  response:=e->'responseScore';
  if response is null or response<>'null'::jsonb and (not public.textos_int(response) or response::numeric>4) then perform public.textos_fail('La respuesta requiere un entero de 0 a 4 o pendiente.'); end if;
  if response='null'::jsonb then
   if complete then perform public.textos_fail('Falta valorar la respuesta a la pregunta obligatoria.'); end if;
   return null;
  end if;
  if base is null then return null; end if;
  return (base*40/100+response::numeric)*100/44;
 end if;
 return base;
end $$;

create or replace function public.textos_presentation_current(s jsonb, e jsonb) returns boolean
language plpgsql stable set search_path=pg_catalog,public as $$
begin
 if e is null or e->>'status'<>'closed' or e->'scaleMax' is distinct from '4'::jsonb or e->'rubricVersion' is distinct from '2'::jsonb then return false; end if;
 return public.textos_presentation_score_of(e,true) is not null;
end $$;

create or replace function public.textos_presentation_teacher_matches(t jsonb, area text, block text) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(t->>'area'=area and jsonb_typeof(t->'categories')='array' and t->'categories' ? block,false)
$$;

create or replace function public.textos_presentation_publisher_available(s jsonb, publisher_id text, area text, block text) returns boolean
language sql stable set search_path=pg_catalog,public as $$
 select public.textos_find(s,'publishers',publisher_id) is not null and (
  not exists(select 1 from jsonb_array_elements(coalesce(s->'offers','[]')) o join jsonb_array_elements(coalesce(s->'series','[]')) r on r->>'id'=o->>'seriesId' where r->>'publisherId'=publisher_id)
  or exists(select 1 from jsonb_array_elements(coalesce(s->'offers','[]')) o join jsonb_array_elements(coalesce(s->'series','[]')) r on r->>'id'=o->>'seriesId' where r->>'publisherId'=publisher_id and o->>'status'='offered' and o->>'area'=area and o->>'block'=block)
 )
$$;

create or replace function public.textos_presentation_validate(s jsonb) returns void
language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare e jsonb; q jsonb; t jsonb; c text;
begin
 if s#>'{settings,presentationScaleMax}' is not null and s#>'{settings,presentationScaleMax}' not in ('2'::jsonb,'4'::jsonb) then perform public.textos_fail('Escala de exposición inválida.'); end if;
 foreach c in array array['presentationEvaluations','presentationShortlists'] loop
  if s ? c and jsonb_typeof(s->c) is distinct from 'array' then perform public.textos_fail('Colección de exposición inválida.'); end if;
 end loop;
 for t in select value from jsonb_array_elements(coalesce(s->'teachers','[]')) loop
  if t ? 'area' or t ? 'categories' or t->'selfRegistered'='true'::jsonb then
   if coalesce(t->>'area','') not in ('MAT','COM') or jsonb_typeof(t->'categories') is distinct from 'array' then perform public.textos_fail('Seleccione área y al menos una categoría docente.'); end if;
   if jsonb_array_length(t->'categories')<1 or exists(select 1 from jsonb_array_elements(t->'categories') q where q not in ('"P1"'::jsonb,'"P2"'::jsonb,'"S1"'::jsonb))
    or jsonb_array_length(t->'categories')<>(select count(distinct q) from jsonb_array_elements(t->'categories') q) then perform public.textos_fail('Categorías docentes inválidas.'); end if;
  end if;
 end loop;
 for e in select value from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) loop
  if jsonb_typeof(e) is distinct from 'object' or nullif(e->>'id','') is null or not public.textos_int(e->'version') or (e->>'version')::int<1
   or public.textos_find(s,'teachers',e->>'teacherId') is null or public.textos_find(s,'publishers',e->>'publisherId') is null
   or coalesce(e->>'area','') not in ('MAT','COM') or coalesce(e->>'block','') not in ('P1','P2','S1')
   or coalesce(e->>'status','') not in ('draft','closed') or not public.textos_int(e->'rulesVersion') or (e->>'rulesVersion')::int<1
   or jsonb_typeof(e->'notes') is distinct from 'array' or jsonb_typeof(e->'generalObservation') is distinct from 'string'
   or jsonb_typeof(e->'physicalText') is distinct from 'string' or jsonb_typeof(e->'updatedAt') is distinct from 'string'
   or (e ? 'materialViewed' and jsonb_typeof(e->'materialViewed') is distinct from 'boolean') then perform public.textos_fail('Ficha de exposición inválida.'); end if;
  if jsonb_array_length(e->'notes')<>10 or exists(select 1 from jsonb_array_elements(e->'notes') q where jsonb_typeof(q)<>'string') then perform public.textos_fail('Las diez observaciones pueden quedar vacías, pero deben ser texto.'); end if;
  if e ? 'scaleMax' and e->'scaleMax' not in ('2'::jsonb,'4'::jsonb) then perform public.textos_fail('Escala de la ficha inválida.'); end if;
  perform public.textos_presentation_score_of(e,e->>'status'='closed');
  if (e->>'status'='closed' and (jsonb_typeof(e->'closedAt') is distinct from 'string' or nullif(e->>'closedAt','') is null))
   or (e->>'status'='draft' and e->'closedAt' is distinct from 'null'::jsonb) then perform public.textos_fail('Fecha de cierre de exposición inválida.'); end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) e group by e->>'id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) e group by e->>'teacherId',e->>'publisherId',e->>'area',e->>'block' having count(*)>1) then perform public.textos_fail('Una ficha de exposición por docente, editorial, área y categoría.'); end if;
 for e in select value from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) loop
  if jsonb_typeof(e) is distinct from 'object' or nullif(e->>'id','') is null or not public.textos_int(e->'version') or (e->>'version')::int<1
   or coalesce(e->>'area','') not in ('MAT','COM') or coalesce(e->>'block','') not in ('P1','P2','S1')
   or e->>'categoryId' is distinct from (e->>'area')||'-'||(e->>'block') or coalesce(e->>'status','') not in ('draft','published','superseded')
   or jsonb_typeof(e->'publisherIds') is distinct from 'array' or jsonb_typeof(e->'snapshot') is distinct from 'object' then perform public.textos_fail('Preselección de exposición inválida.'); end if;
  if jsonb_array_length(e->'publisherIds') not between 1 and 3 or (e->>'status'='published' and jsonb_array_length(e->'publisherIds')<>3) or jsonb_array_length(e->'publisherIds')<>(select count(distinct q) from jsonb_array_elements(e->'publisherIds') q)
   or exists(select 1 from jsonb_array_elements_text(e->'publisherIds') q where public.textos_find(s,'publishers',q) is null) then perform public.textos_fail('Preselección: una a tres editoriales distintas.'); end if;
  if e#>'{snapshot,scaleMax}' is not null and e#>'{snapshot,scaleMax}' not in ('2'::jsonb,'4'::jsonb) then perform public.textos_fail('Escala de la terna inválida.'); end if;
  if e->>'status'='published' then
   if e#>'{snapshot,scaleMax}' is distinct from '4'::jsonb then perform public.textos_fail('La publicación vigente requiere la escala actual 0–4.'); end if;
   if e->'directorApproved' is distinct from 'true'::jsonb or jsonb_typeof(e->'statement') is distinct from 'string' or nullif(trim(e->>'statement'),'') is null
    or jsonb_typeof(e->'folio') is distinct from 'string' or nullif(trim(e->>'folio'),'') is null
    or not public.textos_int(e->'rulesVersion') or (e->>'rulesVersion')::int<1
    or jsonb_typeof(e->'publishedAt') is distinct from 'string' or nullif(trim(e->>'publishedAt'),'') is null then perform public.textos_fail('La terna publicada requiere aprobación, apreciación, folio, reglas y fecha válidos.'); end if;
   begin
    if not isfinite((e->>'publishedAt')::timestamptz) then perform public.textos_fail('Fecha de publicación inválida.'); end if;
   exception when invalid_datetime_format or datetime_field_overflow then perform public.textos_fail('Fecha de publicación inválida.');
   end;
  end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) e group by e->>'id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) e where e->>'status'='published' group by e->>'categoryId' having count(*)>1) then perform public.textos_fail('Versiones de preselección duplicadas.'); end if;
end $$;

create or replace function public.textos_presentation_publisher_summary(s jsonb, publisher_id text, area text, block text) returns jsonb
language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare registered integer; closed integer; drafts integer; pending_scale integer; pending_question integer; score numeric; i2 numeric; available boolean;
begin
 available:=public.textos_presentation_publisher_available(s,publisher_id,area,block);
 with registered_teachers as (
  select t from jsonb_array_elements(coalesce(s->'teachers','[]')) t where public.textos_presentation_teacher_matches(t,area,block)
 ), forms as (
  select t,e from registered_teachers left join lateral (
   select e from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) e
   where e->>'teacherId'=t->>'id' and e->>'publisherId'=publisher_id and e->>'area'=area and e->>'block'=block
   order by (e->>'version')::int desc limit 1
  ) x on true
 ) select count(*),count(*) filter(where public.textos_presentation_current(s,e)),count(*) filter(where e->>'status'='draft'),
  count(*) filter(where e is not null and coalesce(e->'scaleMax','2'::jsonb)='2'::jsonb),
  count(*) filter(where e->'scaleMax'='4'::jsonb and e->'rubricVersion' is distinct from '2'::jsonb),
  avg(public.textos_presentation_score_of(e,true)) filter(where public.textos_presentation_current(s,e)),
  avg((e#>>'{scores,1}')::numeric) filter(where public.textos_presentation_current(s,e))
 into registered,closed,drafts,pending_scale,pending_question,score,i2 from forms;
 if not available then registered:=0; closed:=0; drafts:=0; pending_scale:=0; pending_question:=0; score:=null; i2:=null; end if;
 return jsonb_build_object('publisherId',publisher_id,'area',area,'block',block,'registered',registered,'closed',closed,'drafts',drafts,'pending',registered-closed,'pendingScaleUpdate',pending_scale,'pendingQuestionUpdate',pending_question,'score',score,'i2',i2,
  'state',case when registered=0 or closed<registered then 'pending' else 'eligible' end);
end $$;

create or replace function public.textos_presentation_category(s jsonb, area text, block text) returns jsonb
language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare ranked jsonb; eligible jsonb; finalists jsonb:='[]'; tied jsonb:='[]'; reasons jsonb:='[]'; item jsonb; boundary jsonb;
 registered integer; closed integer; pending integer; pending_scale integer; pending_question integer; n integer; state text; published boolean;
begin
 if coalesce(area,'') not in ('MAT','COM') or coalesce(block,'') not in ('P1','P2','S1') then perform public.textos_fail('Área o categoría de exposición inválida.'); end if;
 select count(*) into registered from jsonb_array_elements(coalesce(s->'teachers','[]')) t where public.textos_presentation_teacher_matches(t,area,block);
 select coalesce(jsonb_agg(q order by (q->>'score')::numeric desc nulls last,(q->>'i2')::numeric desc nulls last,q->>'publisherId'),'[]') into ranked
 from (select public.textos_presentation_publisher_summary(s,p->>'id',area,block) q from jsonb_array_elements(coalesce(s->'publishers','[]')) p where public.textos_presentation_publisher_available(s,p->>'id',area,block)) summaries;
 select coalesce(sum((q->>'closed')::int),0),coalesce(sum((q->>'pending')::int),0),coalesce(sum((q->>'pendingScaleUpdate')::int),0),coalesce(sum((q->>'pendingQuestionUpdate')::int),0) into closed,pending,pending_scale,pending_question from jsonb_array_elements(ranked) q;
 select coalesce(jsonb_agg(q order by ord),'[]') into eligible from jsonb_array_elements(ranked) with ordinality x(q,ord) where q->>'state'='eligible';
 n:=jsonb_array_length(eligible);
 for item in select value from jsonb_array_elements(eligible) limit 3 loop finalists:=finalists||jsonb_build_array(item->>'publisherId'); end loop;
 if n>3 then
  boundary:=eligible->2;
  if boundary->'score'=eligible#>'{3,score}' and boundary->'i2'=eligible#>'{3,i2}' then
   select coalesce(jsonb_agg(q->>'publisherId'),'[]') into tied from jsonb_array_elements(eligible) q where q->'score'=boundary->'score' and q->'i2'=boundary->'i2';
  end if;
 end if;
 published:=exists(select 1 from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) q where q->>'area'=area and q->>'block'=block and q->>'status'='published' and q#>'{snapshot,scaleMax}'='4'::jsonb and q#>'{snapshot,rubricVersion}'='2'::jsonb);
 state:=case when registered=0 or pending>0 or jsonb_array_length(ranked)=0 then 'pending' when jsonb_array_length(tied)>0 then 'tie' when n<3 then 'less_than_three' else 'ready' end;
 if registered=0 then reasons:=reasons||jsonb_build_array('No hay docentes registrados en esta área y categoría.'); end if;
 if pending>0 then reasons:=reasons||jsonb_build_array('Quedan '||pending||' fichas por cerrar.'); end if;
 if pending_question>0 then reasons:=reasons||jsonb_build_array(pending_question||' fichas anteriores requieren completar la pregunta obligatoria.'); end if;
 if n<3 then reasons:=reasons||jsonb_build_array('Hay '||n||' editoriales con todas sus fichas cerradas; se requieren tres para la votación familiar. No se exige puntaje mínimo.'); end if;
 if jsonb_array_length(tied)>0 then reasons:=reasons||jsonb_build_array('Persiste un empate en el corte después de comparar I2.'); end if;
 if jsonb_array_length(tied)>0 then finalists:='[]'; end if;
 return jsonb_build_object('categoryId',area||'-'||block,'area',area,'block',block,'state',case when published and state in ('ready','less_than_three') and n>0 then 'published' else state end,'registered',registered,'closed',closed,'pending',pending,'pendingScaleUpdate',pending_scale,'pendingQuestionUpdate',pending_question,'ranked',ranked,'finalists',finalists,'tied',tied,'reasons',reasons);
end $$;

create or replace function public.textos_presentation_teacher_state(s jsonb, actor_id text) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select jsonb_set(jsonb_set(s,'{presentationEvaluations}',coalesce((select jsonb_agg(e) from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) e where e->>'teacherId'=actor_id),'[]')),
  '{presentationShortlists}','[]')
$$;

-- Enumerate the public projection, including restored snapshots: custom fields and raw
-- teacher sheets must never become public merely because they were in a backup.
create or replace function public.textos_presentation_public_shortlist(e jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare a jsonb:=e#>'{snapshot,assessment}'; ranked jsonb; publishers jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object('publisherId',q->>'publisherId','area',q->>'area','block',q->>'block',
  'registered',case when public.textos_int(q->'registered') then q->'registered' else '0'::jsonb end,
  'closed',case when public.textos_int(q->'closed') then q->'closed' else '0'::jsonb end,
  'pending',case when public.textos_int(q->'pending') then q->'pending' else '0'::jsonb end,
  'drafts',case when public.textos_int(q->'drafts') then q->'drafts' else '0'::jsonb end,
  'pendingScaleUpdate',case when public.textos_int(q->'pendingScaleUpdate') then q->'pendingScaleUpdate' else '0'::jsonb end,
  'score',case when jsonb_typeof(q->'score')='number' then q->'score' else 'null'::jsonb end,
  'i2',case when jsonb_typeof(q->'i2')='number' then q->'i2' else 'null'::jsonb end,'state',q->>'state')),'[]') into ranked
 from jsonb_array_elements(case when jsonb_typeof(a->'ranked')='array' then a->'ranked' else '[]'::jsonb end) q;
 select coalesce(jsonb_agg(jsonb_build_object('id',q->>'id','name',q->>'name')),'[]') into publishers
 from jsonb_array_elements(case when jsonb_typeof(e#>'{snapshot,publishers}')='array' then e#>'{snapshot,publishers}' else '[]'::jsonb end) q;
 a:=jsonb_build_object('categoryId',a->>'categoryId','area',a->>'area','block',a->>'block','state',a->>'state',
  'registered',case when public.textos_int(a->'registered') then a->'registered' else '0'::jsonb end,
  'closed',case when public.textos_int(a->'closed') then a->'closed' else '0'::jsonb end,
  'pending',case when public.textos_int(a->'pending') then a->'pending' else '0'::jsonb end,
  'pendingScaleUpdate',case when public.textos_int(a->'pendingScaleUpdate') then a->'pendingScaleUpdate' else '0'::jsonb end,
  'ranked',ranked,'finalists',case when jsonb_typeof(a->'finalists')='array' then (select coalesce(jsonb_agg(q),'[]') from jsonb_array_elements(a->'finalists') q where jsonb_typeof(q)='string') else '[]'::jsonb end,
  'tied',case when jsonb_typeof(a->'tied')='array' then (select coalesce(jsonb_agg(q),'[]') from jsonb_array_elements(a->'tied') q where jsonb_typeof(q)='string') else '[]'::jsonb end,
  'reasons',case when jsonb_typeof(a->'reasons')='array' then (select coalesce(jsonb_agg(q),'[]') from jsonb_array_elements(a->'reasons') q where jsonb_typeof(q)='string') else '[]'::jsonb end);
 return jsonb_build_object('id',e->>'id','version',e->'version','categoryId',e->>'categoryId','area',e->>'area','block',e->>'block',
  'publisherIds',e->'publisherIds','status','published','statement',e->>'statement','folio',e->>'folio',
  'directorApproved',e->'directorApproved','publishedAt',e->'publishedAt','rulesVersion',e->'rulesVersion',
  'snapshot',jsonb_build_object('assessment',a,'publishers',publishers,'scaleMax',case when e#>'{snapshot,scaleMax}'='4'::jsonb then 4 else 2 end,'rubricVersion',e#>'{snapshot,rubricVersion}','threshold',case when jsonb_typeof(e#>'{snapshot,threshold}')='number' then e#>'{snapshot,threshold}' else 'null'::jsonb end));
end $$;

create or replace function public.textos_presentation_public_state(s jsonb) returns jsonb
language sql stable set search_path=pg_catalog,public as $$
 select jsonb_set(jsonb_set(s,'{presentationEvaluations}','[]'),'{presentationShortlists}',coalesce((select jsonb_agg(public.textos_presentation_public_shortlist(e)) from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) e where e->>'status'='published' and e#>'{snapshot,scaleMax}'='4'::jsonb and e#>'{snapshot,rubricVersion}'='2'::jsonb),'[]'))
$$;

create or replace function public.textos_presentation_api(s jsonb, p_action text, p_payload jsonb, actor_role text, actor_id text, actor_name text, nowat timestamptz) returns jsonb
language plpgsql set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare ev jsonb; entity jsonb; t jsonb; q jsonb; assessment jsonb; notes jsonb; question jsonb; history jsonb:='[]'; result jsonb;
 area text; block text; publisher_id text; reason text; expected integer; v integer;
begin
 if coalesce(p_action,'') not in ('presentation_save','presentation_close','presentation_restart_scale','presentation_enable_question','presentation_reopen','presentation_summary','presentation_shortlist_publish') then perform public.textos_fail('Operación de exposición desconocida.','PT404'); end if;
 if jsonb_typeof(p_payload) is distinct from 'object' then perform public.textos_fail('Petición de exposición inválida.'); end if;
 if p_action in ('presentation_save','presentation_close','presentation_restart_scale','presentation_enable_question') then
  if actor_role is distinct from 'teacher' then perform public.textos_fail('Solo el docente puede emitir su propia ficha de exposición.','PT403'); end if;
  t:=public.textos_find(s,'teachers',actor_id);
  if t is null then perform public.textos_fail('Perfil docente no encontrado.','PT403'); end if;
 elsif p_action='presentation_summary' then
  if coalesce(actor_role,'') not in ('coordinator','secretary') then perform public.textos_fail('Operación reservada a coordinación o mesa.','PT403'); end if;
 else
  if actor_role is distinct from 'coordinator' then perform public.textos_fail('Operación reservada a coordinación.','PT403'); end if;
 end if;
 if p_action in ('presentation_save','presentation_close','presentation_restart_scale') and p_payload->'scaleMax' is distinct from '4'::jsonb then
  perform public.textos_fail('La escala cambió a 0–4. Actualice la aplicación antes de guardar.','PT409');
 end if;
 if p_action in ('presentation_save','presentation_close','presentation_restart_scale','presentation_enable_question') and p_payload->'rubricVersion' is distinct from '2'::jsonb then perform public.textos_fail('La ficha ahora incluye la pregunta obligatoria. Actualice la aplicación.','PT409'); end if;
 if p_action='presentation_save' then
  area:=p_payload->>'area'; block:=p_payload->>'block'; publisher_id:=p_payload->>'publisherId';
  if not public.textos_presentation_teacher_matches(t,area,block) then perform public.textos_fail('La ficha no corresponde al área y las categorías de su perfil.','PT403'); end if;
  if not public.textos_presentation_publisher_available(s,publisher_id,area,block) then perform public.textos_fail('La editorial no participa en esta área y categoría.','PT403'); end if;
  select e into ev from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) e where e->>'teacherId'=actor_id and e->>'publisherId'=publisher_id and e->>'area'=area and e->>'block'=block;
 elsif p_action in ('presentation_close','presentation_restart_scale','presentation_enable_question','presentation_reopen') then
  ev:=public.textos_find(s,'presentationEvaluations',p_payload->>'evaluationId');
  if ev is null then perform public.textos_fail('Ficha de exposición no encontrada.','PT404'); end if;
  area:=ev->>'area'; block:=ev->>'block'; publisher_id:=ev->>'publisherId';
  if p_action in ('presentation_close','presentation_restart_scale','presentation_enable_question') and (ev->>'teacherId'<>actor_id or not public.textos_presentation_teacher_matches(t,area,block)) then perform public.textos_fail('Solo puede cerrar su propia ficha dentro de su perfil.','PT403'); end if;
  if p_action in ('presentation_close','presentation_restart_scale','presentation_enable_question') and not public.textos_presentation_publisher_available(s,publisher_id,area,block) then perform public.textos_fail('La editorial ya no participa en esta área y categoría.','PT403'); end if;
 end if;
 if p_action in ('presentation_save','presentation_close','presentation_restart_scale','presentation_enable_question') then
  if not public.textos_int(p_payload->'expectedVersion') then perform public.textos_fail('La ficha requiere su versión para evitar sobrescrituras.','PT409'); end if;
  expected:=(p_payload->>'expectedVersion')::int;
  if expected<>coalesce((ev->>'version')::int,0) then perform public.textos_fail('La ficha cambió en otra pestaña; conserve su borrador y recargue.','PT409'); end if;
  if p_action in ('presentation_save','presentation_close') and ev is not null and ev->'scaleMax' is distinct from '4'::jsonb then perform public.textos_fail('Esta ficha usa la escala histórica 0–2. Inicie explícitamente una nueva valoración 0–4.','PT409'); end if;
  if p_action='presentation_restart_scale' and ev->'scaleMax'='4'::jsonb then perform public.textos_fail('La ficha ya usa la escala actual 0–4.','PT409'); end if;
  if p_action='presentation_enable_question' and (ev->'scaleMax' is distinct from '4'::jsonb or ev->'rubricVersion'='2'::jsonb) then perform public.textos_fail('Esta ficha no requiere habilitar la pregunta.','PT409'); end if;
  if p_action in ('presentation_save','presentation_close') and ev is not null and ev->'rubricVersion' is distinct from '2'::jsonb then perform public.textos_fail('Complete explícitamente la ficha con la pregunta antes de guardar.','PT409'); end if;
  if p_action not in ('presentation_restart_scale','presentation_enable_question') and ev->>'status'='closed' then perform public.textos_fail('La ficha está cerrada; coordinación puede reabrir con motivo.','PT423'); end if;
 end if;
 if p_action='presentation_save' then
  perform public.textos_presentation_scores(p_payload->'scores',4);
  perform public.textos_presentation_score_of(p_payload||jsonb_build_object('scaleMax',4),false);
  notes:=coalesce(p_payload->'notes','["","","","","","","","","",""]'::jsonb);
  if jsonb_typeof(notes) is distinct from 'array' then perform public.textos_fail('Observaciones inválidas.'); end if;
  if jsonb_array_length(notes)<>10 or exists(select 1 from jsonb_array_elements(notes) q where jsonb_typeof(q)<>'string') then perform public.textos_fail('Las diez observaciones son opcionales y deben ser texto.'); end if;
  if (p_payload ? 'generalObservation' and jsonb_typeof(p_payload->'generalObservation') is distinct from 'string') or (p_payload ? 'physicalText' and jsonb_typeof(p_payload->'physicalText') is distinct from 'string')
   or (p_payload ? 'materialViewed' and jsonb_typeof(p_payload->'materialViewed') is distinct from 'boolean') then perform public.textos_fail('Datos de observación inválidos.'); end if;
  entity:=coalesce(ev,'{}')||jsonb_build_object('id',coalesce(ev->>'id',gen_random_uuid()::text),'version',coalesce((ev->>'version')::int,0)+1,'publisherId',publisher_id,'teacherId',actor_id,'area',area,'block',block,'scaleMax',4,'rubricVersion',2,'responseScore',p_payload->'responseScore','questionVersion',coalesce(p_payload->'questionVersion',ev->'questionVersion','null'::jsonb),'scores',p_payload->'scores','notes',notes,'generalObservation',coalesce(p_payload->>'generalObservation',''),'physicalText',coalesce(p_payload->>'physicalText',''),'status','draft','closedAt',null,'updatedAt',nowat,'rulesVersion',s#>'{settings,rules,version}');
  if p_payload ? 'materialViewed' then entity:=entity||jsonb_build_object('materialViewed',p_payload->'materialViewed'); end if;
  if nullif(s#>>'{settings,rules,lockedAt}','') is null then
   s:=jsonb_set(s,'{settings,rules,lockedAt}',to_jsonb(nowat));
   s:=jsonb_set(s,'{settings,version}',to_jsonb(coalesce((s#>>'{settings,version}')::int,0)+1));
  end if;
 elsif p_action='presentation_close' then
  perform public.textos_presentation_score_of(ev,true);
  entity:=ev||jsonb_build_object('status','closed','closedAt',nowat,'updatedAt',nowat,'version',(ev->>'version')::int+1);
 elsif p_action='presentation_restart_scale' then
  reason:='Actualización explícita de escala 0–2 a 0–4';
  entity:=ev||jsonb_build_object('scaleMax',4,'rubricVersion',2,'responseScore',null,'questionVersion',null,'scores','[null,null,null,null,null,null,null,null,null,null]'::jsonb,'status','draft','closedAt',null,'updatedAt',nowat,'rulesVersion',s#>'{settings,rules,version}','version',(ev->>'version')::int+1);
 elsif p_action='presentation_enable_question' then
  reason:='Actualización explícita de la ficha con la pregunta obligatoria';
  entity:=ev||jsonb_build_object('rubricVersion',2,'responseScore',null,'questionVersion',null,'status','draft','closedAt',null,'updatedAt',nowat,'rulesVersion',s#>'{settings,rules,version}','version',(ev->>'version')::int+1);
 elsif p_action='presentation_reopen' then
  reason:=trim(coalesce(p_payload->>'reason',''));
  if reason='' or jsonb_typeof(p_payload->'reason') is distinct from 'string' then perform public.textos_fail('Indique el motivo de la reapertura.'); end if;
  if ev->>'status'<>'closed' then perform public.textos_fail('La ficha ya está abierta.','PT409'); end if;
  entity:=ev||jsonb_build_object('status','draft','closedAt',null,'updatedAt',nowat,'version',(ev->>'version')::int+1);
  for q in select e from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) e where e->>'area'=area and e->>'block'=block and e->>'status'='published' loop
   history:=history||jsonb_build_array(jsonb_build_object('entity','presentationShortlists','referenceId',q->>'id','previous',q,'reason',reason));
   s:=public.textos_put(s,'presentationShortlists',q||jsonb_build_object('status','superseded','version',(q->>'version')::int+1));
  end loop;
 elsif p_action='presentation_summary' then
  if p_payload ? 'area' or p_payload ? 'block' then result:=public.textos_presentation_category(s,p_payload->>'area',p_payload->>'block');
  else
   select jsonb_agg(public.textos_presentation_category(s,a,b) order by a,b) into result from unnest(array['MAT','COM']) a cross join unnest(array['P1','P2','S1']) b;
  end if;
  return jsonb_build_object('state',s,'result',result,'history',history);
 elsif p_action='presentation_shortlist_publish' then
  area:=p_payload->>'area'; block:=p_payload->>'block'; assessment:=public.textos_presentation_category(s,area,block);
  if p_payload->'directorApproved' is distinct from 'true'::jsonb or jsonb_typeof(p_payload->'statement') is distinct from 'string' or jsonb_typeof(p_payload->'folio') is distinct from 'string' or nullif(trim(p_payload->>'statement'),'') is null or nullif(trim(p_payload->>'folio'),'') is null then perform public.textos_fail('La publicación requiere aprobación de Dirección, apreciación y folio.'); end if;
  if s#>'{settings,editorsWithdrawn}' is distinct from 'true'::jsonb or nullif(trim(s#>>'{settings,withdrawalReference}'),'') is null then perform public.textos_fail('La publicación requiere el retiro documentado de las editoriales y su referencia.','PT423'); end if;
  if assessment->>'state' not in ('ready','published') or jsonb_array_length(assessment->'finalists')<>3 then perform public.textos_fail('La clasificación para votación familiar requiere tres editoriales con todas sus fichas cerradas y ningún empate pendiente; no exige puntaje mínimo.','PT423'); end if;
  for q in select e from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) e where e->>'area'=area and e->>'block'=block and e->>'status'='published' loop
   history:=history||jsonb_build_array(jsonb_build_object('entity','presentationShortlists','referenceId',q->>'id','previous',q,'reason','Nueva publicación de la preselección de exposición'));
   s:=public.textos_put(s,'presentationShortlists',q||jsonb_build_object('status','superseded','version',(q->>'version')::int+1));
  end loop;
  select coalesce(max((e->>'version')::int),0)+1 into v from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) e where e->>'area'=area and e->>'block'=block;
  entity:=jsonb_build_object('id',gen_random_uuid()::text,'version',v,'categoryId',area||'-'||block,'area',area,'block',block,'publisherIds',assessment->'finalists','status','published','statement',p_payload->>'statement','folio',p_payload->>'folio','directorApproved',true,'publishedAt',nowat,'rulesVersion',s#>'{settings,rules,version}','snapshot',jsonb_build_object('assessment',assessment,'scaleMax',4,'rubricVersion',2,'threshold',0,'publishers',coalesce((select jsonb_agg(jsonb_build_object('id',p->>'id','name',p->>'name')) from jsonb_array_elements(coalesce(s->'publishers','[]')) p where assessment->'finalists' ? (p->>'id')),'[]')));
  s:=public.textos_put(s,'presentationShortlists',entity);
  return jsonb_build_object('state',s,'result',entity,'history',history);
 end if;
 if ev is not null then history:=history||jsonb_build_array(jsonb_build_object('entity','presentationEvaluations','referenceId',ev->>'id','previous',ev,'reason',coalesce(nullif(reason,''),p_action))); end if;
 s:=public.textos_put(s,'presentationEvaluations',entity);
 return jsonb_build_object('state',s,'result',entity,'history',history);
end $$;
-- END LIVE PRESENTATION HELPERS

-- BEGIN JORNADA HELPERS
-- Only textos_api holds the dataset lock, authenticates the actor and persists
-- these pure state transitions. Helpers are not public RPC entry points.

-- Enumerate the schedule projection: restored custom fields never become public.
create or replace function public.textos_jornada_draw_public(d jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select case when d is null or d='null'::jsonb then null else jsonb_build_object(
  'id',d->>'id','version',d->'version',
  'publishers',coalesce((select jsonb_agg(jsonb_build_object('id',p->>'id','name',p->>'name') order by ord)
   from jsonb_array_elements(d->'publishers') with ordinality q(p,ord)),'[]'::jsonb),
  'completedPublisherIds',d->'completedPublisherIds','createdAt',d->>'createdAt','createdBy','Subdirección'
 ) end
$$;

create or replace function public.textos_jornada_fingerprint(s jsonb) returns text
language sql immutable set search_path=pg_catalog,public as $$
 select encode(sha256(convert_to(jsonb_build_object(
  'publishers',coalesce(s->'publishers','[]'),
  'series',coalesce(s->'series','[]'),'offers',coalesce(s->'offers','[]'),
  'teachers',coalesce(s->'teachers','[]'),
  'evaluations',coalesce(s->'presentationEvaluations','[]'),
  'rules',s#>'{settings,rules}',
  'draw',s->'presentationDraw'
 )::text,'UTF8')),'hex')
$$;

create or replace function public.textos_jornada_ranking_current(s jsonb) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(s#>>'{presentationRanking,sourceFingerprint}'=public.textos_jornada_fingerprint(s),false)
$$;

create or replace function public.textos_jornada_validate(s jsonb) returns void
language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare d jsonb; r jsonb; p jsonb; c jsonb; item jsonb; i integer; n integer;
begin
 d:=s->'presentationDraw'; r:=s->'presentationRanking';
 if d is not null and d<>'null'::jsonb then
  if jsonb_typeof(d) is distinct from 'object' or nullif(trim(d->>'id'),'') is null
   or not public.textos_int(d->'version') or (d->>'version')::int<1
   or jsonb_typeof(d->'publishers') is distinct from 'array'
   or jsonb_typeof(d->'completedPublisherIds') is distinct from 'array'
   or jsonb_typeof(d->'createdAt') is distinct from 'string'
   or jsonb_typeof(d->'createdBy') is distinct from 'string' then
   perform public.textos_fail('Sorteo de participación inválido.');
  end if;
  n:=jsonb_array_length(d->'publishers');
  if n<1 or n<>(select count(distinct q->>'id') from jsonb_array_elements(d->'publishers') q) then
   perform public.textos_fail('El sorteo requiere editoriales distintas.');
  end if;
  for p in select value from jsonb_array_elements(d->'publishers') loop
   if jsonb_typeof(p) is distinct from 'object' or nullif(trim(p->>'id'),'') is null
    or nullif(trim(p->>'name'),'') is null or public.textos_find(s,'publishers',p->>'id') is null then
    perform public.textos_fail('El sorteo contiene una editorial desconocida.');
   end if;
  end loop;
  if jsonb_array_length(d->'completedPublisherIds')>n then perform public.textos_fail('Avance de exposiciones inválido.'); end if;
  for i in 0..jsonb_array_length(d->'completedPublisherIds')-1 loop
   if d#>array['completedPublisherIds',i::text] is distinct from d#>array['publishers',i::text,'id'] then
    perform public.textos_fail('Las exposiciones deben seguir el orden sorteado.');
   end if;
  end loop;
  begin perform (d->>'createdAt')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then perform public.textos_fail('Fecha de sorteo inválida.'); end;
 end if;
 if r is not null and r<>'null'::jsonb then
  if d is null or d='null'::jsonb or jsonb_typeof(r) is distinct from 'object'
   or nullif(trim(r->>'id'),'') is null or not public.textos_int(r->'version') or (r->>'version')::int<1
   or r->>'drawId' is distinct from d->>'id'
   or jsonb_typeof(r->'categories') is distinct from 'array'
   or jsonb_array_length(r->'categories')<>6 or jsonb_typeof(r->'provisional') is distinct from 'boolean'
   or jsonb_typeof(r->'createdAt') is distinct from 'string' or coalesce(r->>'sourceFingerprint','') !~ '^[0-9a-f]{64}$' then
   perform public.textos_fail('Ranking de exposiciones inválido.');
  end if;
  if (select count(distinct q->>'categoryId') from jsonb_array_elements(r->'categories') q)<>6 then perform public.textos_fail('Categorías de ranking duplicadas.'); end if;
  for c in select value from jsonb_array_elements(r->'categories') loop
   if c->>'categoryId' !~ '^(MAT|COM)-(P1|P2|S1)$' or c->>'categoryId' is distinct from (c->>'area')||'-'||(c->>'block')
    or not public.textos_int(c->'registered') or not public.textos_int(c->'closed') or not public.textos_int(c->'pending')
    or jsonb_typeof(c->'ranked') is distinct from 'array' then perform public.textos_fail('Categoría de ranking inválida.'); end if;
   for item in select value from jsonb_array_elements(c->'ranked') loop
    if public.textos_find(s,'publishers',item->>'publisherId') is null or not public.textos_int(item->'registered')
     or not public.textos_int(item->'closed') or not public.textos_int(item->'pending')
     or not (item ? 'score')
     or (item->'score'<>'null'::jsonb and (jsonb_typeof(item->'score') is distinct from 'number' or (item->>'score')::numeric not between 0 and 100)) then
     perform public.textos_fail('Puntaje del ranking inválido.');
    end if;
   end loop;
   -- Formal publication can change category.state without changing any score.
   if public.textos_jornada_ranking_current(s) and (c-'state') is distinct from (public.textos_presentation_category(s,c->>'area',c->>'block')-'state') then
    perform public.textos_fail('El ranking no coincide con las fichas cerradas de su versión.');
   end if;
  end loop;
  if (r->>'provisional')::boolean is distinct from exists(select 1 from jsonb_array_elements(r->'categories') q where (q->>'pending')::int>0) then
   perform public.textos_fail('La condición provisional del ranking no coincide con sus pendientes.');
  end if;
  begin perform (r->>'createdAt')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then perform public.textos_fail('Fecha de ranking inválida.'); end;
 end if;
end $$;

create or replace function public.textos_jornada_action(s jsonb,p_action text,p_payload jsonb,actor_role text,actor_id text,actor_name text,p_dataset text,nowat timestamptz) returns jsonb
language plpgsql volatile set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare old jsonb; entity jsonb; history jsonb:='[]'; publishers jsonb; categories jsonb:='[]'; assessment jsonb;
 area text; block text; reason text:=coalesce(p_payload->>'reason',''); provisional boolean:=false;
begin
 if actor_role is distinct from 'coordinator' then perform public.textos_fail('Operación reservada a Subdirección.','PT403'); end if;
 if p_action='presentation_draw' then
  old:=s->'presentationDraw';
  if old='null'::jsonb then old:=null; end if;
  if not public.textos_int(p_payload->'expectedVersion') or (p_payload->>'expectedVersion')::int<>coalesce((old->>'version')::int,0) then
   perform public.textos_fail('El sorteo cambió. Actualice la información antes de continuar.','PT409');
  end if;
  if p_payload->'confirmArrivals' is distinct from 'true'::jsonb then perform public.textos_fail('Confirme el cierre del registro de editoriales antes de sortear.'); end if;
  if jsonb_array_length(s->'publishers')<1 then perform public.textos_fail('Registre las editoriales que llegaron antes de sortear.','PT423'); end if;
  if s#>>'{turn,status}'='running' then perform public.textos_fail('Pause o finalice el reloj antes de sortear.','PT423'); end if;
  if old is not null then
   if jsonb_array_length(old->'completedPublisherIds')>0 or s#>>'{turn,startedAt}' is not null then
    perform public.textos_fail('El orden ya se utilizó. No puede repetirse el sorteo después de iniciar las exposiciones.','PT423');
   end if;
   if length(trim(reason))<8 then perform public.textos_fail('Documente el motivo para repetir el sorteo (mínimo ocho caracteres).'); end if;
   history:=history||jsonb_build_array(jsonb_build_object('entity','presentationDraw','referenceId',old->>'id','previous',old,'reason',reason));
  else reason:='Sorteo del orden de participación'; end if;
  -- Random ordering is produced by the server; clients cannot supply a seed or order.
  select jsonb_agg(jsonb_build_object('id',p->>'id','name',p->>'name') order by gen_random_uuid()) into publishers from jsonb_array_elements(s->'publishers') p;
  entity:=jsonb_build_object('id',gen_random_uuid()::text,'version',coalesce((old->>'version')::int,0)+1,
   'publishers',publishers,'completedPublisherIds','[]'::jsonb,'createdAt',nowat,'createdBy',actor_name);
  if s#>>'{turn,startedAt}' is not null or s#>>'{turn,publisherId}' is not null then
   history:=history||jsonb_build_array(jsonb_build_object('entity','turn','referenceId',coalesce(s#>>'{turn,publisherId}','legacy'),'previous',s->'turn','reason','Preparación del primer orden sorteado; reloj anterior conservado'));
  end if;
  s:=jsonb_set(s,'{presentationDraw}',entity);
  s:=s-'presentationRanking';
  s:=jsonb_set(s,'{turn}',jsonb_build_object('publisherId',publishers#>>'{0,id}','status','ready','startedAt',null,'pausedAt',null,'pausedMilliseconds',0));
 elsif p_action='presentation_ranking_generate' then
  old:=s->'presentationRanking';
  if old='null'::jsonb then old:=null; end if;
  if not public.textos_int(p_payload->'expectedVersion') or (p_payload->>'expectedVersion')::int<>coalesce((old->>'version')::int,0) then
   perform public.textos_fail('El ranking cambió. Actualice la información antes de continuar.','PT409');
  end if;
  if s->'presentationDraw' is null or s->'presentationDraw'='null'::jsonb
   or jsonb_array_length(s#>'{presentationDraw,publishers}')<1
   or jsonb_array_length(s#>'{presentationDraw,completedPublisherIds}')<>jsonb_array_length(s#>'{presentationDraw,publishers}')
   or s#>>'{turn,status}'<>'finished' then
   perform public.textos_fail('Finalice todas las exposiciones del orden sorteado antes de generar el ranking.','PT423');
  end if;
  if exists(select 1 from jsonb_array_elements(s->'publishers') p where not exists(select 1 from jsonb_array_elements(s#>'{presentationDraw,publishers}') q where q->>'id'=p->>'id')) then
   perform public.textos_fail('Hay editoriales nuevas que no participaron en el sorteo. Revise el registro de la jornada.','PT423');
  end if;
  if s#>>'{settings,evaluationMode}'='presentation' and exists(select 1 from jsonb_array_elements(s#>'{presentationDraw,publishers}') p where not public.textos_question_can_finish(s,p->>'id')) then perform public.textos_fail('Registre la pregunta obligatoria y la respuesta de cada editorial antes de generar el ranking.','PT423'); end if;
  foreach area in array array['MAT','COM'] loop
   foreach block in array array['P1','P2','S1'] loop
    assessment:=public.textos_presentation_category(s,area,block);
    categories:=categories||jsonb_build_array(assessment);
    if (assessment->>'pending')::int>0 then provisional:=true; end if;
   end loop;
  end loop;
  entity:=jsonb_build_object('id',gen_random_uuid()::text,'version',coalesce((old->>'version')::int,0)+1,
   'createdAt',nowat,'drawId',s#>>'{presentationDraw,id}','categories',categories,'provisional',provisional,
   'sourceFingerprint',public.textos_jornada_fingerprint(s),'stale',false);
  reason:='Ranking de exposiciones calculado con fichas cerradas de la escala vigente';
  if old is not null then history:=history||jsonb_build_array(jsonb_build_object('entity','presentationRanking','referenceId',old->>'id','previous',old,'reason',reason)); end if;
  s:=jsonb_set(s,'{presentationRanking}',entity);
 else perform public.textos_fail('Operación de jornada desconocida.','PT404'); end if;
 perform public.textos_jornada_validate(s);
 return jsonb_build_object('state',s,'result',entity,'referenceId',entity->>'id','reason',reason,'history',history);
end $$;

-- Call before changing the clock. This updates completion atomically with finish.
-- With no draw, legacy manual turns keep their original behavior.
create or replace function public.textos_jornada_turn(s jsonb,command text,publisherid text,expected_turn jsonb default null) returns jsonb
language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare d jsonb:=s->'presentationDraw'; nextid text; currentid text:=s#>>'{turn,publisherId}'; n integer;
begin
 if expected_turn is not null and expected_turn is distinct from s->'turn' then
  perform public.textos_fail('El turno cambió en otra pantalla. Actualice antes de controlar el reloj.','PT409');
 end if;
 if d is null or d='null'::jsonb then return s; end if;
 perform public.textos_jornada_validate(s);
 if expected_turn is distinct from s->'turn' then
  perform public.textos_fail('El turno cambió en otra pantalla. Actualice antes de controlar el reloj.','PT409');
 end if;
 n:=jsonb_array_length(d->'completedPublisherIds'); nextid:=d#>>array['publishers',n::text,'id'];
 if command in ('start','next') then
  if s#>>'{turn,status}' not in ('ready','finished') then perform public.textos_fail('Finalice el turno actual antes de iniciar el siguiente.','PT423'); end if;
  if nextid is null then perform public.textos_fail('Todas las exposiciones sorteadas ya finalizaron.','PT423'); end if;
  if publisherid is distinct from nextid then perform public.textos_fail('Inicie la siguiente editorial del orden sorteado.','PT409'); end if;
  if exists(select 1 from jsonb_array_elements(s->'publishers') p where not exists(select 1 from jsonb_array_elements(d->'publishers') q where q->>'id'=p->>'id')) then
   perform public.textos_fail('El registro de editoriales cambió después del sorteo. Actualice el sorteo antes de iniciar.','PT423');
  end if;
 elsif command='finish' then
  if s#>>'{turn,status}' not in ('running','paused') or currentid is distinct from nextid then
   perform public.textos_fail('Solo puede finalizar la exposición activa del orden sorteado.','PT409');
  end if;
  d:=jsonb_set(d,'{completedPublisherIds}',d->'completedPublisherIds'||jsonb_build_array(currentid));
  d:=jsonb_set(d,'{version}',to_jsonb((d->>'version')::int+1));
  s:=jsonb_set(s,'{presentationDraw}',d);
 end if;
 return s;
end $$;

-- END JORNADA HELPERS

-- BEGIN PAPER HELPERS
-- A5 ballots per classroom for current polls; anonymous ballots remain compatible.
-- This fragment is embedded in schema.sql before the owner-only RPC dispatcher.
create table if not exists public.textos_paper_tokens (
 code_hash text primary key check(code_hash ~ '^[a-f0-9]{64}$'),
 dataset text not null references public.textos_datasets(id), poll_id text not null,
 consumed boolean not null default false
);
alter table public.textos_paper_tokens add column if not exists classroom_id text;
create unique index if not exists textos_paper_tokens_classroom_idx on public.textos_paper_tokens(dataset,poll_id,classroom_id) where classroom_id is not null;
create index if not exists textos_paper_tokens_poll_idx on public.textos_paper_tokens(dataset,poll_id);
alter table public.textos_paper_tokens enable row level security;
revoke all on public.textos_paper_tokens from public;
do $$declare role_name text; begin
 foreach role_name in array array['anon','authenticated'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on public.textos_paper_tokens from %I',role_name); end if;
 end loop;
end $$;

create or replace function public.textos_paper_result(poll jsonb, area text) returns jsonb
language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare n integer; maximum integer; tied jsonb;
begin
 select coalesce(sum(value::text::int),0),coalesce(max(value::text::int),0) into n,maximum from jsonb_each(coalesce(poll#>array['counts',area,'options'],'{}'));
 select coalesce(jsonb_agg(key order by key),'[]') into tied from jsonb_each(coalesce(poll#>array['counts',area,'options'],'{}')) where value::text::int=maximum and maximum>0;
 return jsonb_build_object('state',case when n=0 then 'no_valid_votes' when jsonb_array_length(tied)>1 then 'tie' else 'winner' end,
  'winnerId',case when jsonb_array_length(tied)=1 then tied->>0 else null end,
  'tiedIds',case when jsonb_array_length(tied)>1 then tied else '[]'::jsonb end);
end $$;


create or replace function public.textos_paper_classrooms(block text) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',grade||'-'||section,'gradeId',grade,'section',section,
  'label',right(grade,1)||'.º de '||case when left(grade,3)='PRI' then 'primaria' else 'secundaria' end||' · '||section,
  'folio',block||'-'||lpad(((grade_order-1)*5+section_order)::text,2,'0'),
  'attendance','pending','ballotIssued',false,'received',false,'voteVersion',0,'recordedAt',null,'correctedAt',null
 ) order by grade_order,section_order),'[]'::jsonb)
 from jsonb_array_elements_text(public.textos_grades(block)) with ordinality g(grade,grade_order)
 cross join unnest(array['A','B','C','D','E']) with ordinality h(section,section_order)
$$;

create or replace function public.textos_paper_choices_validate(poll jsonb,choices jsonb) returns void
language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare area text; chosen text;
begin
 if jsonb_typeof(choices) is distinct from 'object' or (select count(*) from jsonb_object_keys(choices))<>jsonb_array_length(poll->'areas')
  or exists(select 1 from jsonb_object_keys(choices) q where not(poll->'areas' ? q)) then perform public.textos_fail('Registre una respuesta de cada área de la ficha.'); end if;
 for area in select jsonb_array_elements_text(poll->'areas') loop
  if not(choices ? area) or jsonb_typeof(choices->area) not in ('string','null') then perform public.textos_fail('Voto inválido.'); end if;
  chosen:=choices->>area;
  if chosen is not null and chosen<>'__invalid__' and not exists(select 1 from jsonb_array_elements(poll#>array['options',area]) o where o->>'id'=chosen) then
   perform public.textos_fail('La opción pertenece a otra votación o editorial.');
  end if;
 end loop;
end $$;

create or replace function public.textos_paper_tally(poll jsonb,choices jsonb,direction integer) returns jsonb
language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare area text; chosen text; key text; tally jsonb; counts jsonb:=poll->'counts'; n bigint;
begin
 if direction not in (-1,1) then perform public.textos_fail('Ajuste de conteo inválido.'); end if;
 perform public.textos_paper_choices_validate(poll,choices);
 for area in select jsonb_array_elements_text(poll->'areas') loop
  chosen:=choices->>area; tally:=counts->area;
  key:=case when chosen is null then 'blank' when chosen='__invalid__' then 'invalid' else null end;
  if key is null then
   n:=(tally#>>array['options',chosen])::bigint+direction;
   if n<0 then perform public.textos_fail('El ajuste reduciría un conteo por debajo de cero.'); end if;
   tally:=jsonb_set(tally,array['options',chosen],to_jsonb(n));
  else
   n:=(tally->>key)::bigint+direction;
   if n<0 then perform public.textos_fail('El ajuste reduciría un conteo por debajo de cero.'); end if;
   tally:=jsonb_set(tally,array[key],to_jsonb(n));
  end if;
  counts:=jsonb_set(counts,array[area],tally);
 end loop;
 return poll||jsonb_build_object('counts',counts);
end $$;

create or replace function public.textos_paper_roster_validate(poll jsonb) returns void
language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare expected jsonb; classroom jsonb; original jsonb; area text; option jsonb; n bigint; recorded timestamptz; corrected timestamptz;
begin
 if not(poll ? 'rosterVersion') then
  if poll ? 'classrooms' then perform public.textos_fail('El padrón de aulas requiere su versión.'); end if;
  return;
 end if;
 if poll->'rosterVersion' is distinct from '1'::jsonb or jsonb_typeof(poll->'classrooms') is distinct from 'array' then perform public.textos_fail('Padrón de aulas inválido.'); end if;
 expected:=public.textos_paper_classrooms(poll->>'block');
 if jsonb_array_length(poll->'classrooms')<>jsonb_array_length(expected)
  or exists(select 1 from jsonb_array_elements(poll->'classrooms') q group by q->>'id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(poll->'classrooms') q group by q->>'folio' having count(*)>1) then perform public.textos_fail('Cada grado debe tener exactamente las cinco secciones A, B, C, D y E.'); end if;
 for classroom in select value from jsonb_array_elements(poll->'classrooms') loop
  select q into original from jsonb_array_elements(expected) q where q->>'id'=classroom->>'id';
  if original is null or jsonb_typeof(classroom) is distinct from 'object' or classroom->'gradeId' is distinct from original->'gradeId'
   or classroom->'section' is distinct from original->'section' or classroom->'label' is distinct from original->'label' or classroom->'folio' is distinct from original->'folio'
   or coalesce(classroom->>'attendance','') not in ('pending','present','absent')
   or jsonb_typeof(classroom->'ballotIssued') is distinct from 'boolean' or jsonb_typeof(classroom->'received') is distinct from 'boolean' then
   perform public.textos_fail('El aula, folio o asistencia no corresponde al padrón de la categoría.');
  end if;
  if classroom->'received'='true'::jsonb then
   if classroom->'ballotIssued' is distinct from 'true'::jsonb or classroom->>'attendance'<>'present'
    or not public.textos_int(classroom->'voteVersion') or (classroom->>'voteVersion')::bigint<1 then perform public.textos_fail('Un voto recibido requiere aula presente, ficha y versión.'); end if;
   perform public.textos_paper_choices_validate(poll,classroom->'choices');
   begin
    recorded:=nullif(classroom->>'recordedAt','')::timestamptz; corrected:=nullif(classroom->>'correctedAt','')::timestamptz;
    if recorded is null or not isfinite(recorded) or corrected is not null and (not isfinite(corrected) or corrected<recorded or (classroom->>'voteVersion')::bigint<2) then perform public.textos_fail('Las fechas de registro y corrección del aula no son coherentes.'); end if;
   exception when invalid_datetime_format or datetime_field_overflow then perform public.textos_fail('Fecha de registro del voto inválida.'); end;
  elsif classroom->'choices' is not null and classroom->'choices'<>'null'::jsonb
   or classroom->'voteVersion' is not null and classroom->'voteVersion'<>'0'::jsonb then perform public.textos_fail('Un aula sin voto recibido no puede tener una opción registrada.');
  end if;
 end loop;
 if (select count(*) from jsonb_array_elements(poll->'classrooms') q where q->'ballotIssued'='true'::jsonb)<>(poll->>'generated')::bigint
  or (select count(*) from jsonb_array_elements(poll->'classrooms') q where q->'received'='true'::jsonb)<>(poll->>'received')::bigint then perform public.textos_fail('Las fichas generadas y recibidas no concilian con las aulas.'); end if;
 for area in select jsonb_array_elements_text(poll->'areas') loop
  for option in select value from jsonb_array_elements(poll#>array['options',area]) loop
   select count(*) into n from jsonb_array_elements(poll->'classrooms') q where q->'received'='true'::jsonb and q#>>array['choices',area]=option->>'id';
   if n<>(poll#>>array['counts',area,'options',option->>'id'])::bigint then perform public.textos_fail('El conteo no coincide con los votos registrados por aula.'); end if;
  end loop;
  select count(*) into n from jsonb_array_elements(poll->'classrooms') q where q->'received'='true'::jsonb and q#>array['choices',area]='null'::jsonb;
  if n<>(poll#>>array['counts',area,'blank'])::bigint then perform public.textos_fail('Los blancos no coinciden con los votos por aula.'); end if;
  select count(*) into n from jsonb_array_elements(poll->'classrooms') q where q->'received'='true'::jsonb and q#>>array['choices',area]='__invalid__';
  if n<>(poll#>>array['counts',area,'invalid'])::bigint then perform public.textos_fail('Los nulos no coinciden con los votos por aula.'); end if;
 end loop;
end $$;

-- Parents may compare the latest recorded option with their classroom's paper.
-- Only the explicitly authorized classroom roll call is public, never token hashes.
create or replace function public.textos_paper_public(polls jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',p->>'id','version',p->'version','block',p->>'block','areas',p->'areas','options',p->'options',
  'status',p->>'status','rosterVersion',1,'generated',p->'generated','received',p->'received','counts',p->'counts','results',p->'results',
  'classrooms',coalesce((select jsonb_agg(jsonb_build_object('id',c->>'id','gradeId',c->>'gradeId','section',c->>'section','label',c->>'label',
   'folio',c->>'folio','attendance',c->>'attendance','received',c->'received',
   'voteVersion',c->'voteVersion','recordedAt',c->'recordedAt','correctedAt',c->'correctedAt')
   ||case when c->'received'='true'::jsonb then jsonb_build_object('choices',c->'choices') else '{}'::jsonb end order by ord)
   from jsonb_array_elements(p->'classrooms') with ordinality q(c,ord)),'[]'::jsonb)) order by poll_order),'[]'::jsonb)
 from jsonb_array_elements(coalesce(polls,'[]')) with ordinality q(p,poll_order) where p->'rosterVersion'='1'::jsonb
$$;

create or replace function public.textos_paper_validate(s jsonb) returns void
language plpgsql immutable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare poll jsonb; option jsonb; area text; key text; tally jsonb; tally_total bigint;
begin
 if s ? 'paperPolls' and jsonb_typeof(s->'paperPolls') is distinct from 'array' then perform public.textos_fail('Colección de votaciones en papel inválida.'); end if;
 if exists(select 1 from jsonb_array_elements(coalesce(s->'paperPolls','[]')) q group by q->>'id' having count(*)>1) then perform public.textos_fail('Votación en papel duplicada.'); end if;
 for poll in select value from jsonb_array_elements(coalesce(s->'paperPolls','[]')) loop
  if nullif(poll->>'id','') is null or not public.textos_int(poll->'version') or (poll->>'version')::bigint<1 or coalesce(poll->>'block','') not in ('P1','P2','S1') or coalesce(poll->>'status','') not in ('open','closed') then perform public.textos_fail('Votación en papel inválida.'); end if;
  if nullif(poll->>'rankingId','') is null or not public.textos_int(poll->'rankingVersion') or (poll->>'rankingVersion')::bigint<1 or nullif(poll->>'createdAt','') is null then perform public.textos_fail('La votación requiere referencia al ranking original.'); end if;
  if not public.textos_int(poll->'generated') or not public.textos_int(poll->'received') or (poll->>'generated')::bigint<(poll->>'received')::bigint then perform public.textos_fail('Las fichas recibidas exceden las generadas.'); end if;
  if jsonb_typeof(poll->'areas') is distinct from 'array' or jsonb_typeof(poll->'options') is distinct from 'object' or jsonb_typeof(poll->'counts') is distinct from 'object' or jsonb_typeof(poll->'results') is distinct from 'object' then perform public.textos_fail('Áreas, opciones o conteos de papel inválidos.'); end if;
  if jsonb_array_length(poll->'areas') not between 1 and 2 or exists(select 1 from jsonb_array_elements_text(poll->'areas') a where a not in ('MAT','COM')) or (select count(distinct a) from jsonb_array_elements_text(poll->'areas') a)<>jsonb_array_length(poll->'areas') then perform public.textos_fail('Áreas de votación en papel inválidas.'); end if;
  if exists(select 1 from jsonb_object_keys(poll->'options') k where not(poll->'areas' ? k)) or exists(select 1 from jsonb_object_keys(poll->'counts') k where not(poll->'areas' ? k)) or exists(select 1 from jsonb_object_keys(poll->'results') k where not(poll->'areas' ? k)) then perform public.textos_fail('La ficha incluye un área que no le corresponde.'); end if;
  for area in select jsonb_array_elements_text(poll->'areas') loop
   if jsonb_typeof(poll#>array['options',area]) is distinct from 'array' then perform public.textos_fail('Opciones de papel inválidas.'); end if;
   if jsonb_array_length(poll#>array['options',area]) not between 2 and 3 or (select count(distinct q->>'id') from jsonb_array_elements(poll#>array['options',area]) q)<>jsonb_array_length(poll#>array['options',area]) then perform public.textos_fail('Se requieren dos o tres opciones diferentes en cada área.'); end if;
   for option in select value from jsonb_array_elements(poll#>array['options',area]) loop
    if jsonb_typeof(option) is distinct from 'object' or nullif(trim(option->>'id'),'') is null or nullif(trim(option->>'name'),'') is null or option->>'id' in ('__invalid__','__blank__') then perform public.textos_fail('Alternativa de papel inválida.'); end if;
   end loop;
   tally:=poll#>array['counts',area];
   if jsonb_typeof(tally) is distinct from 'object' or jsonb_typeof(tally->'options') is distinct from 'object' or not public.textos_int(tally->'blank') or not public.textos_int(tally->'invalid') then perform public.textos_fail('Escrutinio en papel inválido.'); end if;
   if (select count(*) from jsonb_object_keys(tally->'options'))<>jsonb_array_length(poll#>array['options',area]) or exists(select 1 from jsonb_each(tally->'options') e where not public.textos_int(e.value) or not exists(select 1 from jsonb_array_elements(poll#>array['options',area]) o where o->>'id'=e.key)) then perform public.textos_fail('Conteo de una alternativa ajena o ausente.'); end if;
   select coalesce(sum(value::text::bigint),0)+(tally->>'blank')::bigint+(tally->>'invalid')::bigint into tally_total from jsonb_each(tally->'options');
   if tally_total<>(poll->>'received')::bigint then perform public.textos_fail('El conteo no concilia con las fichas recibidas.'); end if;
   if poll->>'status'='closed' and poll#>array['results',area] is distinct from public.textos_paper_result(poll,area) then perform public.textos_fail('El resultado de papel no corresponde a sus conteos.'); end if;
   if poll->>'status'='open' and poll#>array['results',area] is not null then perform public.textos_fail('Una votación abierta no declara ganadores.'); end if;
  end loop;
  if poll->>'status'='closed' and nullif(poll->>'closedAt','') is null then perform public.textos_fail('Falta la fecha de cierre de votación.'); end if;
  perform public.textos_paper_roster_validate(poll);
 end loop;
end $$;

create or replace function public.textos_paper_action(s jsonb, p_action text, p_payload jsonb, actor_role text, actor_id text, actor_name text, p_dataset text, nowat timestamptz) returns jsonb
language plpgsql volatile set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare poll jsonb; ranking jsonb; category jsonb; ranking_options jsonb; options jsonb:='{}'; counts jsonb:='{}'; results jsonb:='{}';
 area text; key text; expected integer; amount integer; code text; codes jsonb:='[]'; ballots jsonb:='[]'; token public.textos_paper_tokens%rowtype;
 history jsonb:='[]'; result jsonb; reference_id text; reason text; classroom jsonb; updated_classroom jsonb; classrooms jsonb; selected jsonb; selected_classroom_id text;
 roster boolean; attendance text; previous_poll jsonb;
begin
 if actor_role is distinct from 'coordinator' then perform public.textos_fail('Solo Subdirección administra la votación familiar en papel.','PT403'); end if;
 if p_action='paper_poll_create' then
  ranking:=s->'presentationRanking';
  if ranking is null or ranking='null' or ranking->>'id' is distinct from p_payload->>'rankingId' or not public.textos_int(p_payload->'expectedRankingVersion') or ranking->'version' is distinct from p_payload->'expectedRankingVersion' then perform public.textos_fail('El ranking cambió. Actualice antes de preparar las fichas.','PT409'); end if;
  if ranking->'provisional' is distinct from 'false'::jsonb or not public.textos_jornada_ranking_current(s) then perform public.textos_fail('Complete todas las evaluaciones y genere un ranking final actualizado antes de votar.','PT423'); end if;
  if coalesce(p_payload->>'block','') not in ('P1','P2','S1') or jsonb_typeof(p_payload->'areas') is distinct from 'array' then perform public.textos_fail('Seleccione categoría y áreas para la ficha.'); end if;
  if jsonb_array_length(p_payload->'areas') not between 1 and 2 or exists(select 1 from jsonb_array_elements_text(p_payload->'areas') q where q not in ('MAT','COM')) or (select count(distinct q) from jsonb_array_elements_text(p_payload->'areas') q)<>jsonb_array_length(p_payload->'areas') then perform public.textos_fail('Seleccione una o dos áreas sin repetir.'); end if;
  if exists(select 1 from jsonb_array_elements(coalesce(s->'paperPolls','[]')) q where q->>'status'='open' and q->>'block'=p_payload->>'block' and exists(select 1 from jsonb_array_elements_text(p_payload->'areas') a where q->'areas' ? a)) then perform public.textos_fail('Ya existe una votación abierta para esa categoría y área.','PT409'); end if;
  for area in select jsonb_array_elements_text(p_payload->'areas') loop
   category:=public.textos_presentation_category(s,area,p_payload->>'block');
   if category is null or coalesce((category->>'registered')::int,0)<1 or coalesce((category->>'pending')::int,1)>0 or jsonb_typeof(category->'ranked') is distinct from 'array' or jsonb_array_length(category->'ranked')<3 then perform public.textos_fail('Se requieren tres editoriales y todas las fichas cerradas en '||area||'.','PT423'); end if;
   if exists(select 1 from jsonb_array_elements(category->'ranked') q where q->'score' is null or q->'score'='null') then perform public.textos_fail('El ranking del área contiene resultados pendientes.','PT423'); end if;
   if jsonb_array_length(category->'ranked')>3 and category#>'{ranked,2,score}'=category#>'{ranked,3,score}' and category#>'{ranked,2,i2}'=category#>'{ranked,3,i2}' then perform public.textos_fail('Hay un empate en el corte del Top 3. Resuélvalo antes de preparar las fichas.','PT423'); end if;
   select coalesce(jsonb_agg(jsonb_build_object('id',q->>'publisherId','name',p->>'name') order by ord),'[]') into ranking_options from jsonb_array_elements(category->'ranked') with ordinality r(q,ord) join jsonb_array_elements(s->'publishers') p on p->>'id'=q->>'publisherId' where ord<=3;
   if jsonb_array_length(ranking_options)<>3 then perform public.textos_fail('Las editoriales del ranking ya no están disponibles. Actualice el ranking.','PT409'); end if;
   options:=options||jsonb_build_object(area,ranking_options);
   counts:=counts||jsonb_build_object(area,jsonb_build_object('options',(select jsonb_object_agg(o->>'id',0) from jsonb_array_elements(ranking_options) o),'blank',0,'invalid',0));
  end loop;
  poll:=jsonb_build_object('id',gen_random_uuid()::text,'version',1,'block',p_payload->>'block','areas',p_payload->'areas','options',options,'status','open','rankingId',ranking->>'id','rankingVersion',ranking->'version','createdAt',nowat,'closedAt',null,'generated',0,'received',0,'counts',counts,'results','{}'::jsonb,'rosterVersion',1,'classrooms',public.textos_paper_classrooms(p_payload->>'block'));
  result:=poll; reason:='Votación familiar en papel preparada desde el ranking final';

 elsif p_action in ('paper_ballots_generate','paper_scan_cast','paper_poll_close','paper_attendance_save','paper_manual_cast','paper_manual_correct') then
  poll:=public.textos_find(s,'paperPolls',p_payload->>'pollId');
  if poll is null then perform public.textos_fail('No se encontró la votación en papel.'); end if;
  if poll->>'status' is distinct from 'open' then perform public.textos_fail('La votación en papel ya está cerrada.','PT423'); end if;
  if p_action<>'paper_scan_cast' and (not public.textos_int(p_payload->'expectedVersion') or poll->'version' is distinct from p_payload->'expectedVersion') then perform public.textos_fail('La votación cambió. Actualice antes de continuar.','PT409'); end if;
  roster:=poll->'rosterVersion'='1'::jsonb;
  if p_action in ('paper_attendance_save','paper_manual_cast','paper_manual_correct') then
   if not coalesce(roster,false) then perform public.textos_fail('Esta votación anterior no tiene padrón por aula. Prepare una votación nueva para usar folios y transcripción por aula.','PT423'); end if;
   select q into classroom from jsonb_array_elements(poll->'classrooms') q
    where (nullif(p_payload->>'classroomId','') is not null and q->>'id'=p_payload->>'classroomId')
     or (nullif(p_payload->>'classroomId','') is null and q->>'folio'=upper(trim(p_payload->>'folio')));
   if classroom is null then perform public.textos_fail('Seleccione un aula o folio de esta categoría.'); end if;
   selected_classroom_id:=classroom->>'id';
  end if;
  if p_action='paper_ballots_generate' then
   if coalesce(roster,false) then
    if p_payload ? 'count' then perform public.textos_fail('Las fichas se generan por aula; seleccione el padrón en la versión actualizada.'); end if;
    if p_payload ? 'classroomIds' then
     selected:=p_payload->'classroomIds';
     if jsonb_typeof(selected) is distinct from 'array' or jsonb_array_length(selected)<1
      or (select count(distinct q) from jsonb_array_elements_text(selected) q)<>jsonb_array_length(selected)
      or exists(select 1 from jsonb_array_elements(selected) q where jsonb_typeof(q) is distinct from 'string')
      or exists(select 1 from jsonb_array_elements_text(selected) q where not exists(select 1 from jsonb_array_elements(poll->'classrooms') c where c->>'id'=q)) then perform public.textos_fail('Seleccione aulas diferentes del padrón de esta categoría.'); end if;
    else select coalesce(jsonb_agg(q->>'id'),'[]') into selected from jsonb_array_elements(poll->'classrooms') q where q->>'attendance'<>'absent' and q->'ballotIssued'='false'::jsonb and q->'received'='false'::jsonb; end if;
    if jsonb_array_length(selected)=0 then perform public.textos_fail('No hay aulas pendientes de emitir. Seleccione una ficha sin voto recibido para reimprimirla.','PT423'); end if;
    classrooms:=poll->'classrooms';
    for classroom in select value from jsonb_array_elements(poll->'classrooms') q where selected ? (q->>'id') loop
     if classroom->>'attendance'='absent' then perform public.textos_fail('No se emiten fichas para un aula marcada Sin asistencia.','PT423'); end if;
     if classroom->'received'='true'::jsonb then perform public.textos_fail('El aula ya tiene su voto registrado; no se emite otra ficha.','PT409'); end if;
     selected_classroom_id:=classroom->>'id';
     select q.* into token from public.textos_paper_tokens q where q.dataset=p_dataset and q.poll_id=poll->>'id' and q.classroom_id=selected_classroom_id for update;
     if found and token.consumed then perform public.textos_fail('La ficha de esta aula ya fue contabilizada.','PT409'); end if;
     if not found then
      code:=public.textos_code(); insert into public.textos_paper_tokens(code_hash,dataset,poll_id,classroom_id) values(public.textos_hash(code),p_dataset,poll->>'id',selected_classroom_id);
     end if;
     updated_classroom:=classroom||jsonb_build_object('ballotIssued',true);
     select jsonb_agg(case when q->>'id'=selected_classroom_id then updated_classroom else q end order by ord) into classrooms from jsonb_array_elements(classrooms) with ordinality item(q,ord);
     codes:=codes||jsonb_build_array(classroom->>'folio');
     ballots:=ballots||jsonb_build_array(jsonb_build_object('classroomId',selected_classroom_id,'classroomLabel',classroom->>'label','folio',classroom->>'folio'));
    end loop;
    poll:=poll||jsonb_build_object('classrooms',classrooms,'generated',(select count(*) from jsonb_array_elements(classrooms) q where q->'ballotIssued'='true'::jsonb));
    reason:='Fichas A5 por aula generadas con folios cortos';
   else
    if not public.textos_int(p_payload->'count') or (p_payload->>'count')::bigint not between 1 and 200 then perform public.textos_fail('Genere entre 1 y 200 fichas por lote.'); end if;
    amount:=(p_payload->>'count')::int;
    for expected in 1..amount loop
     code:=public.textos_code(); insert into public.textos_paper_tokens(code_hash,dataset,poll_id) values(public.textos_hash(code),p_dataset,poll->>'id'); codes:=codes||jsonb_build_array(code);
    end loop;
    poll:=poll||jsonb_build_object('generated',(poll->>'generated')::int+amount);
    reason:='Fichas A5 anónimas anteriores generadas';
   end if;
  elsif p_action='paper_attendance_save' then
   attendance:=p_payload->>'attendance';
   if coalesce(attendance,'') not in ('pending','present','absent') then perform public.textos_fail('Seleccione asistencia pendiente, presente o Sin asistencia.'); end if;
   if classroom->'received'='true'::jsonb and attendance<>'present' then perform public.textos_fail('Esta aula ya tiene un voto recibido; no puede marcarse Sin asistencia.','PT423'); end if;
   updated_classroom:=classroom||jsonb_build_object('attendance',attendance);
   select jsonb_agg(case when q->>'id'=selected_classroom_id then updated_classroom else q end order by ord) into classrooms from jsonb_array_elements(poll->'classrooms') with ordinality item(q,ord);
   poll:=poll||jsonb_build_object('classrooms',classrooms);
   reason:='Asistencia del aula '||(classroom->>'label')||' registrada';
  elsif p_action in ('paper_manual_cast','paper_manual_correct') then
   perform public.textos_paper_choices_validate(poll,p_payload->'choices');
   if p_action='paper_manual_correct' then
    if classroom->'received' is distinct from 'true'::jsonb then perform public.textos_fail('El aula todavía no tiene un voto registrado que corregir.','PT423'); end if;
    if not public.textos_int(p_payload->'expectedVoteVersion') or classroom->'voteVersion' is distinct from p_payload->'expectedVoteVersion' then perform public.textos_fail('El voto del aula cambió. Actualice antes de corregirlo.','PT409'); end if;
    reason:=trim(coalesce(p_payload->>'reason',''));
    if jsonb_typeof(p_payload->'reason') is distinct from 'string' or length(reason)<8 or length(reason)>1000 then perform public.textos_fail('Explique el motivo de la corrección (entre 8 y 1000 caracteres).'); end if;
    history:=jsonb_build_array(jsonb_build_object('entity','paperClassroomVotes','referenceId',(poll->>'id')||':'||selected_classroom_id,'previous',classroom,'reason',reason));
    poll:=public.textos_paper_tally(public.textos_paper_tally(poll,classroom->'choices',-1),p_payload->'choices',1);
    updated_classroom:=classroom||jsonb_build_object('choices',p_payload->'choices','voteVersion',(classroom->>'voteVersion')::int+1,'correctedAt',nowat);
    reason:='Corrección de voto del aula '||(classroom->>'label')||': '||reason;
   else
    if p_payload->'confirmation' is distinct from 'true'::jsonb then perform public.textos_fail('Confirme que transcribió las opciones de la ficha en papel.'); end if;
    if classroom->'received'='true'::jsonb then perform public.textos_fail('Esta aula ya tiene un voto contabilizado; use Corregir voto si hay un error.','PT409'); end if;
    if classroom->>'attendance'='absent' then perform public.textos_fail('Esta aula está marcada Sin asistencia. Corrija primero su asistencia para registrar un voto.','PT423'); end if;
    select q.* into token from public.textos_paper_tokens q where q.dataset=p_dataset and q.poll_id=poll->>'id' and q.classroom_id=selected_classroom_id for update;
    if found and token.consumed then perform public.textos_fail('Esta ficha ya fue contabilizada; no se suma de nuevo.','PT409'); end if;
    if found then update public.textos_paper_tokens set consumed=true where code_hash=token.code_hash;
    else
     code:=public.textos_code(); insert into public.textos_paper_tokens(code_hash,dataset,poll_id,classroom_id,consumed) values(public.textos_hash(code),p_dataset,poll->>'id',selected_classroom_id,true);
    end if;
    poll:=public.textos_paper_tally(poll,p_payload->'choices',1);
    poll:=poll||jsonb_build_object('received',(poll->>'received')::int+1,'generated',(poll->>'generated')::int+case when classroom->'ballotIssued'='true'::jsonb then 0 else 1 end);
    updated_classroom:=classroom||jsonb_build_object('attendance','present','ballotIssued',true,'received',true,'choices',p_payload->'choices','voteVersion',1,'recordedAt',nowat,'correctedAt',null);
    reason:='Voto transcrito del aula '||(classroom->>'label');
   end if;
   select jsonb_agg(case when q->>'id'=selected_classroom_id then updated_classroom else q end order by ord) into classrooms from jsonb_array_elements(poll->'classrooms') with ordinality item(q,ord);
   poll:=poll||jsonb_build_object('classrooms',classrooms);
  elsif p_action='paper_scan_cast' then
   if coalesce(roster,false) then perform public.textos_fail('Las fichas por aula se registran manualmente por aula o folio corto.','PT423'); end if;
   if coalesce(p_payload->>'code','') !~ '^[a-f0-9]{64}$' then perform public.textos_fail('El código de la ficha anterior no es válido.'); end if;
   select q.* into token from public.textos_paper_tokens q where q.code_hash=public.textos_hash(p_payload->>'code') and q.dataset=p_dataset and q.poll_id=poll->>'id' for update;
   if not found then perform public.textos_fail('Esta ficha no fue generada para la votación seleccionada.','PT403'); end if;
   if token.consumed then perform public.textos_fail('Esta ficha ya fue contabilizada; no se suma de nuevo.','PT409'); end if;
   poll:=public.textos_paper_tally(poll,p_payload->'choices',1);
   update public.textos_paper_tokens set consumed=true where code_hash=token.code_hash;
   poll:=poll||jsonb_build_object('received',(poll->>'received')::int+1);
   reason:='Ficha anónima anterior contabilizada en agregados';
  else
   for area in select jsonb_array_elements_text(poll->'areas') loop results:=results||jsonb_build_object(area,public.textos_paper_result(poll,area)); end loop;
   poll:=poll||jsonb_build_object('status','closed','closedAt',nowat,'results',results);
   reason:='Recepción cerrada y resultados familiares calculados';
  end if;
  poll:=poll||jsonb_build_object('version',(poll->>'version')::int+1);
  if p_action='paper_ballots_generate' then result:=jsonb_build_object('poll',poll,'codes',codes,'ballots',ballots);
  elsif p_action in ('paper_scan_cast','paper_manual_cast','paper_manual_correct') then result:=jsonb_build_object('poll',poll,'accepted',true,'corrected',p_action='paper_manual_correct');
  else result:=poll; end if;
 else perform public.textos_fail('Acción de papel no reconocida.');
 end if;
 reference_id:=poll->>'id';
 s:=public.textos_put(s,'paperPolls',poll);
 perform public.textos_paper_validate(s);
 return jsonb_build_object('state',s,'result',result,'referenceId',reference_id,'reason',reason,'history',history);
end $$;

-- Restore never reopens a used ballot, erases an issued classroom or reverts a correction.
create or replace function public.textos_paper_restore_prepare(currentstate jsonb, savedstate jsonb, p_dataset text, paper_tokens jsonb, p_apply boolean default false) returns jsonb
language plpgsql volatile set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare previous jsonb; saved jsonb; item jsonb; existing public.textos_paper_tokens%rowtype;
 area text; key text; count_tokens bigint; consumed_tokens bigint; classroom jsonb; saved_classroom jsonb; linked_poll jsonb;
begin
 perform public.textos_paper_validate(savedstate);
 if jsonb_typeof(paper_tokens) is distinct from 'array' then perform public.textos_fail('El respaldo requiere sus fichas de papel.'); end if;
 if exists(select 1 from jsonb_array_elements(paper_tokens) q group by q->>'code_hash' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(paper_tokens) q where nullif(q->>'classroom_id','') is not null group by q->>'poll_id',q->>'classroom_id' having count(*)>1) then perform public.textos_fail('El respaldo repite una ficha o aula.'); end if;
 for item in select value from jsonb_array_elements(paper_tokens) loop
  linked_poll:=public.textos_find(savedstate,'paperPolls',item->>'poll_id');
  if jsonb_typeof(item) is distinct from 'object' or coalesce(item->>'dataset','')<>p_dataset or coalesce(item->>'code_hash','') !~ '^[a-f0-9]{64}$'
   or item->'consumed' is null or item->'consumed' not in ('true'::jsonb,'false'::jsonb) or linked_poll is null then perform public.textos_fail('Ficha de respaldo ajena, incompleta o inválida.'); end if;
  if linked_poll->'rosterVersion'='1'::jsonb then
   select q into classroom from jsonb_array_elements(linked_poll->'classrooms') q where q->>'id'=item->>'classroom_id';
   if classroom is null or classroom->'ballotIssued' is distinct from 'true'::jsonb or classroom->'received' is distinct from item->'consumed' then perform public.textos_fail('La ficha del respaldo no coincide con el aula y su voto recibido.'); end if;
  elsif nullif(item->>'classroom_id','') is not null then perform public.textos_fail('Una ficha anterior no puede atribuirse a un aula nueva.'); end if;
  select q.* into existing from public.textos_paper_tokens q where q.code_hash=item->>'code_hash';
  if found and (existing.dataset<>p_dataset or existing.poll_id<>item->>'poll_id' or existing.classroom_id is distinct from item->>'classroom_id'
   or existing.consumed and item->'consumed' is distinct from 'true'::jsonb) then perform public.textos_fail('El respaldo intenta trasladar o reutilizar una ficha contabilizada.','PT409'); end if;
 end loop;
 for previous in select value from jsonb_array_elements(coalesce(currentstate->'paperPolls','[]')) loop
  if (previous->>'generated')::bigint=0 and (previous->>'received')::bigint=0 and previous->'rosterVersion' is distinct from '1'::jsonb then continue; end if;
  saved:=public.textos_find(savedstate,'paperPolls',previous->>'id');
  if saved is null or (saved->>'generated')::bigint<(previous->>'generated')::bigint or (saved->>'received')::bigint<(previous->>'received')::bigint
   or previous->'options' is distinct from saved->'options' or previous->'areas' is distinct from saved->'areas' or previous->'block' is distinct from saved->'block'
   or previous->>'status'='closed' and saved->>'status'<>'closed' then perform public.textos_fail('Este respaldo retrocedería una votación en papel. Conserve la base actual y use un respaldo más reciente.','PT409'); end if;
  if previous->'rosterVersion'='1'::jsonb then
   if saved->'rosterVersion' is distinct from '1'::jsonb or (saved->>'version')::bigint<(previous->>'version')::bigint then perform public.textos_fail('El respaldo retrocedería la versión del padrón o de sus votos.','PT409'); end if;
   for classroom in select value from jsonb_array_elements(previous->'classrooms') loop
    select q into saved_classroom from jsonb_array_elements(saved->'classrooms') q where q->>'id'=classroom->>'id';
    if saved_classroom is null or classroom->'ballotIssued'='true'::jsonb and saved_classroom->'ballotIssued' is distinct from 'true'::jsonb
     or classroom->'received'='true'::jsonb and (saved_classroom->'received' is distinct from 'true'::jsonb
      or (saved_classroom->>'voteVersion')::bigint<(classroom->>'voteVersion')::bigint
      or saved_classroom->'voteVersion'=classroom->'voteVersion' and saved_classroom->'choices' is distinct from classroom->'choices') then
     perform public.textos_fail('El respaldo perdería un aula, voto recibido o corrección posterior.','PT409');
    end if;
   end loop;
  else
   for area in select jsonb_array_elements_text(previous->'areas') loop
    for key in select jsonb_object_keys(previous#>array['counts',area,'options']) loop
     if (saved#>>array['counts',area,'options',key])::bigint<(previous#>>array['counts',area,'options',key])::bigint then perform public.textos_fail('El respaldo reduciría votos ya contabilizados.','PT409'); end if;
    end loop;
    if (saved#>>array['counts',area,'blank'])::bigint<(previous#>>array['counts',area,'blank'])::bigint or (saved#>>array['counts',area,'invalid'])::bigint<(previous#>>array['counts',area,'invalid'])::bigint then perform public.textos_fail('El respaldo reduciría blancos o nulos ya contabilizados.','PT409'); end if;
   end loop;
  end if;
 end loop;
 if exists(select 1 from public.textos_paper_tokens q where q.dataset=p_dataset and not exists(select 1 from jsonb_array_elements(paper_tokens) b where b->>'code_hash'=q.code_hash and b->>'poll_id'=q.poll_id and b->>'classroom_id' is not distinct from q.classroom_id and (not q.consumed or b->'consumed'='true'::jsonb))) then perform public.textos_fail('El respaldo perdería fichas de papel emitidas o contabilizadas.','PT409'); end if;
 for saved in select value from jsonb_array_elements(coalesce(savedstate->'paperPolls','[]')) loop
  select count(*),count(*) filter(where q->'consumed'='true'::jsonb) into count_tokens,consumed_tokens from jsonb_array_elements(paper_tokens) q where q->>'poll_id'=saved->>'id';
  if count_tokens<>(saved->>'generated')::bigint or consumed_tokens<>(saved->>'received')::bigint then perform public.textos_fail('Las fichas del respaldo no concilian con las generadas y recibidas.'); end if;
  if saved->>'status'='open' and (saved->>'received')::bigint>0 and public.textos_find(currentstate,'paperPolls',saved->>'id') is null then perform public.textos_fail('Cierre esta votación en su base de origen antes de trasladarla a una instalación nueva.','PT409'); end if;
 end loop;
 if p_apply then
  for item in select value from jsonb_array_elements(paper_tokens) loop
   insert into public.textos_paper_tokens(code_hash,dataset,poll_id,classroom_id,consumed) values(item->>'code_hash',p_dataset,item->>'poll_id',item->>'classroom_id',(item->>'consumed')::boolean)
   on conflict(code_hash) do update set consumed=textos_paper_tokens.consumed or excluded.consumed;
  end loop;
 end if;
 return jsonb_build_object('state',savedstate,'blockedPollIds','[]'::jsonb);
end $$;
-- END PAPER HELPERS

-- BEGIN DATA CLEANUP HELPERS
-- Administrative deletion is explicit, previewed and scoped to one dataset.
-- The RPC authenticates and locks the dataset before invoking this helper.
create or replace function public.textos_cleanup_mentions(doc jsonb, ids jsonb) returns boolean
language sql immutable set search_path=pg_catalog,public as $$
 select coalesce(exists(select 1 from jsonb_path_query(coalesce(doc,'null'),'$.**') v where jsonb_typeof(v)='string' and coalesce(ids,'[]') ? (v#>>'{}')),false)
$$;
create or replace function public.textos_cleanup_without(s jsonb, collection text, ids jsonb) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select jsonb_set(s,array[collection],coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(s->collection,'[]')) v where not(coalesce(ids,'[]') ? (v->>'id'))),'[]'))
$$;
create or replace function public.textos_cleanup_plan(s jsonb, payload jsonb) returns jsonb
language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare scope text:=payload->>'scope'; ids jsonb:=coalesce(payload->'ids','[]'); selected jsonb; removed jsonb:='{}'; allids jsonb:='[]'; names jsonb:='[]';
 nextstate jsonb:=s; catalogstate jsonb:=s; rewritten jsonb:='[]'; labels jsonb:='[]'; counts jsonb:='{}'; consequences jsonb:='[]'; affected jsonb:='[]'; publishers jsonb:='[]'; offerids jsonb:='[]';
 c text; col text; id text; area text; block text; v jsonb; q jsonb; more jsonb; before_rem jsonb; n integer; response_count integer:=0;
 clear_draw boolean:=false; clear_rank boolean:=false;
begin
 if coalesce(scope,'') not in ('all','publisher','teacher','presentationEvaluation','paperPoll','draw','ranking','historical','series','offer','book','section','incident','question') then perform public.textos_fail('Seleccione qué información desea eliminar.'); end if;
 if jsonb_typeof(ids) is distinct from 'array' or jsonb_array_length(ids)>2000 or exists(select 1 from jsonb_array_elements(ids) x where jsonb_typeof(x)<>'string' or nullif(trim(x#>>'{}'),'') is null) or (select count(distinct x) from jsonb_array_elements(ids) x)<>jsonb_array_length(ids) then perform public.textos_fail('Seleccione registros diferentes y válidos.'); end if;
 foreach c in array array['publishers','series','offers','books','teachers','assignments','evaluations','presentationEvaluations','presentationShortlists','reviews','shortlists','sections','rounds','incidents','presentationQuestions'] loop removed:=removed||jsonb_build_object(c,'[]'::jsonb); end loop;
 col:=case scope when 'publisher' then 'publishers' when 'teacher' then 'teachers' when 'presentationEvaluation' then 'presentationEvaluations' when 'paperPoll' then 'paperPolls' when 'series' then 'series' when 'offer' then 'offers' when 'book' then 'books' when 'section' then 'sections' when 'incident' then 'incidents' when 'question' then 'presentationQuestions' end;
 removed:=removed||jsonb_build_object('paperPolls','[]'::jsonb);
 if col is not null then
  if jsonb_array_length(ids)<1 then perform public.textos_fail('Seleccione al menos un registro.'); end if;
  for id in select jsonb_array_elements_text(ids) loop
   v:=public.textos_find(s,col,id); if v is null then perform public.textos_fail('Uno de los registros ya no existe. Actualice la información.','PT409'); end if;
   labels:=labels||jsonb_build_array(coalesce(v->>'name',v->>'title',case when scope='presentationEvaluation' then coalesce(public.textos_find(s,'teachers',v->>'teacherId')->>'name','Docente')||' · '||coalesce(public.textos_find(s,'publishers',v->>'publisherId')->>'name','Editorial')||' · '||(v->>'area')||'-'||(v->>'block') when scope='paperPoll' then 'Votación '||(v->>'block') when scope='question' then 'Pregunta · '||coalesce(public.textos_find(s,'publishers',v->>'publisherId')->>'name','Editorial') end,v->>'label',v->>'description',id));
  end loop;
  removed:=jsonb_set(removed,array[col],ids);
 elsif jsonb_array_length(ids)>0 then perform public.textos_fail('Esta opción no admite registros individuales.');
 end if;
 if scope='all' then
  labels:='["Todos los datos ingresados de esta jornada"]';
  nextstate:=public.textos_empty_state()||jsonb_build_object('version',s->'version','settings',jsonb_set(s->'settings','{rules,lockedAt}','null')||jsonb_build_object('version',coalesce((s#>>'{settings,version}')::int,0)+1,'editorsWithdrawn',false,'withdrawalReference',''),'paperPolls','[]'::jsonb,'presentationQuestions','[]'::jsonb);
  foreach c in array array['publishers','series','offers','books','teachers','assignments','evaluations','presentationEvaluations','presentationShortlists','reviews','shortlists','sections','rounds','incidents','presentationQuestions','paperPolls'] loop
   removed:=jsonb_set(removed,array[c],coalesce((select jsonb_agg(x->>'id') from jsonb_array_elements(coalesce(s->c,'[]')) x),'[]'));
  end loop;
  clear_draw:=s->'presentationDraw' is not null; clear_rank:=s->'presentationRanking' is not null;
  consequences:=consequences||jsonb_build_array('Se vaciarán los registros y votos de esta jornada. Se conservarán la configuración y el acceso de Subdirección.','Los accesos docentes emitidos para esta jornada dejarán de funcionar.');
 else
  if scope='historical' then
   labels:='["Archivo de evaluaciones y elecciones anteriores"]';
   foreach c in array array['books','assignments','evaluations','reviews','shortlists','sections','rounds'] loop removed:=jsonb_set(removed,array[c],coalesce((select jsonb_agg(x->>'id') from jsonb_array_elements(coalesce(s->c,'[]')) x),'[]')); end loop;
   consequences:=consequences||jsonb_build_array('Se eliminará el archivo por libro y grado; las editoriales, ofertas y evaluaciones de exposición se conservarán.');
  end if;
  if scope='draw' then clear_draw:=true; clear_rank:=true; end if;
  if scope='ranking' then clear_rank:=true; labels:='["Ranking / Top"]'; end if;
  if scope='draw' then labels:='["Sorteo y cronómetro"]'; end if;
  -- Catalog dependencies can span reviews and their additional assignments.
  loop
   before_rem:=removed;
   for v in select value from jsonb_array_elements(coalesce(s->'series','[]')) loop if removed->'publishers' ? (v->>'publisherId') then removed:=jsonb_set(removed,'{series}',(removed->'series')||case when removed->'series' ? (v->>'id') then '[]'::jsonb else jsonb_build_array(v->>'id') end); end if; end loop;
   for v in select value from jsonb_array_elements(coalesce(s->'offers','[]')) loop if removed->'series' ? (v->>'seriesId') and not(removed->'offers' ? (v->>'id')) then removed:=jsonb_set(removed,'{offers}',removed->'offers'||jsonb_build_array(v->>'id')); end if; end loop;
   for v in select value from jsonb_array_elements(coalesce(s->'books','[]')) loop if removed->'offers' ? (v->>'offerId') and not(removed->'books' ? (v->>'id')) then removed:=jsonb_set(removed,'{books}',removed->'books'||jsonb_build_array(v->>'id')); end if; end loop;
   for v in select value from jsonb_array_elements(coalesce(s->'reviews','[]')) loop if public.textos_cleanup_mentions(v,(removed->'offers')||(removed->'books')) and not(removed->'reviews' ? (v->>'id')) then removed:=jsonb_set(removed,'{reviews}',removed->'reviews'||jsonb_build_array(v->>'id')); end if; end loop;
   for v in select value from jsonb_array_elements(coalesce(s->'assignments','[]')) loop if ((removed->'books' ? (v->>'bookId')) or (removed->'teachers' ? (v->>'teacherId')) or (removed->'reviews' ? (v->>'reviewId'))) and not(removed->'assignments' ? (v->>'id')) then removed:=jsonb_set(removed,'{assignments}',removed->'assignments'||jsonb_build_array(v->>'id')); end if; end loop;
   for v in select value from jsonb_array_elements(coalesce(s->'evaluations','[]')) loop if ((removed->'books' ? (v->>'bookId')) or (removed->'teachers' ? (v->>'teacherId')) or (removed->'assignments' ? (v->>'assignmentId'))) and not(removed->'evaluations' ? (v->>'id')) then removed:=jsonb_set(removed,'{evaluations}',removed->'evaluations'||jsonb_build_array(v->>'id')); end if; end loop;
   exit when before_rem=removed;
  end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'presentationEvaluations','[]')) loop
   if ((removed->'publishers' ? (v->>'publisherId')) or (removed->'teachers' ? (v->>'teacherId'))) and not(removed->'presentationEvaluations' ? (v->>'id')) then removed:=jsonb_set(removed,'{presentationEvaluations}',removed->'presentationEvaluations'||jsonb_build_array(v->>'id')); end if;
   if removed->'presentationEvaluations' ? (v->>'id') then affected:=affected||jsonb_build_array((v->>'area')||'-'||(v->>'block')); end if;
  end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'teachers','[]')) loop if removed->'teachers' ? (v->>'id') then names:=names||jsonb_build_array(v->>'name'); for block in select jsonb_array_elements_text(coalesce(v->'categories','[]')) loop affected:=affected||jsonb_build_array((v->>'area')||'-'||block); end loop; end if; end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'publishers','[]')) loop if removed->'publishers' ? (v->>'id') then publishers:=publishers||jsonb_build_array(v->>'id'); clear_draw:=true; end if; end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'offers','[]')) loop if removed->'offers' ? (v->>'id') then q:=public.textos_find(s,'series',v->>'seriesId'); affected:=affected||jsonb_build_array((v->>'area')||'-'||(v->>'block')); publishers:=publishers||jsonb_build_array(q->>'publisherId'); end if; end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'presentationQuestions','[]')) loop
   if removed->'publishers' ? (v->>'publisherId') and not(removed->'presentationQuestions' ? (v->>'id')) then removed:=jsonb_set(removed,'{presentationQuestions}',removed->'presentationQuestions'||jsonb_build_array(v->>'id')); end if;
  end loop;
  foreach c in array array['publishers','series','offers'] loop catalogstate:=public.textos_cleanup_without(catalogstate,c,removed->c); end loop;
  if jsonb_array_length(publishers)>0 then
   foreach area in array array['MAT','COM'] loop foreach block in array array['P1','P2','S1'] loop
    if exists(select 1 from jsonb_array_elements_text(publishers) p where public.textos_presentation_publisher_available(s,p,area,block) or public.textos_presentation_publisher_available(catalogstate,p,area,block)) then affected:=affected||jsonb_build_array(area||'-'||block); end if;
   end loop; end loop;
  end if;
  -- Published snapshots may mention a removed entry outside their finalist list.
  select coalesce(jsonb_agg(x),'[]') into allids from jsonb_each(removed) e cross join lateral jsonb_array_elements(e.value) x;
  select coalesce(jsonb_agg(distinct b->>'offerId'),'[]') into offerids from jsonb_array_elements(coalesce(s->'books','[]')) b where exists(select 1 from jsonb_array_elements(coalesce(s->'assignments','[]')) a where removed->'assignments' ? (a->>'id') and a->>'bookId'=b->>'id');
  for v in select value from jsonb_array_elements(coalesce(s->'shortlists','[]')) loop if (public.textos_cleanup_mentions(v,allids) or public.textos_cleanup_mentions(v->'offerIds',offerids)) and not(removed->'shortlists' ? (v->>'id')) then removed:=jsonb_set(removed,'{shortlists}',removed->'shortlists'||jsonb_build_array(v->>'id')); end if; end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) loop if (affected ? ((v->>'area')||'-'||(v->>'block')) or public.textos_cleanup_mentions(v,allids)) and not(removed->'presentationShortlists' ? (v->>'id')) then removed:=jsonb_set(removed,'{presentationShortlists}',removed->'presentationShortlists'||jsonb_build_array(v->>'id')); end if; end loop;
  loop
   before_rem:=removed;
   for v in select value from jsonb_array_elements(coalesce(s->'rounds','[]')) loop if ((removed->'rounds' ? (v->>'parentId')) or public.textos_cleanup_mentions(v->'shortlistIds',removed->'shortlists') or exists(select 1 from jsonb_array_elements(coalesce(s->'sections','[]')) sec where removed->'sections' ? (sec->>'id') and sec->>'gradeId'=v->>'gradeId')) and not(removed->'rounds' ? (v->>'id')) then removed:=jsonb_set(removed,'{rounds}',removed->'rounds'||jsonb_build_array(v->>'id')); end if; end loop;
   exit when before_rem=removed;
  end loop;
  for v in select value from jsonb_array_elements(coalesce(s->'paperPolls','[]')) loop if exists(select 1 from jsonb_array_elements_text(v->'areas') a where affected ? (a||'-'||(v->>'block'))) or public.textos_cleanup_mentions(v,removed->'publishers') then if not(removed->'paperPolls' ? (v->>'id')) then removed:=jsonb_set(removed,'{paperPolls}',removed->'paperPolls'||jsonb_build_array(v->>'id')); end if; end if; end loop;
  clear_rank:=clear_rank or jsonb_array_length(affected)>0 or jsonb_array_length(removed->'publishers')>0 or jsonb_array_length(removed->'teachers')>0;
  select coalesce(jsonb_agg(x),'[]') into allids from jsonb_each(removed) e cross join lateral jsonb_array_elements(e.value) x;
  for v in select value from jsonb_array_elements(coalesce(s->'incidents','[]')) loop if allids ? (v->>'referenceId') and not(removed->'incidents' ? (v->>'id')) then removed:=jsonb_set(removed,'{incidents}',removed->'incidents'||jsonb_build_array(v->>'id')); end if; end loop;
  for c in select jsonb_object_keys(removed) loop nextstate:=public.textos_cleanup_without(nextstate,c,removed->c); end loop;
  nextstate:=jsonb_set(nextstate,'{deliveries}',coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(s->'deliveries','[]')) v where not(removed->'rounds' ? (v->>'roundId')) and not(removed->'sections' ? (v->>'sectionId'))),'[]'));
  -- A removed book must not remain an unresolved supersedes reference.
  nextstate:=jsonb_set(nextstate,'{books}',coalesce((select jsonb_agg(case when removed->'books' ? (v->>'supersedesId') then v-'supersedesId' else v end) from jsonb_array_elements(coalesce(nextstate->'books','[]')) v),'[]'));
  if scope='question' then consequences:=consequences||jsonb_build_array('Se eliminará solo la confirmación; las fichas, sus puntajes, el sorteo y los resultados se conservarán.'); end if;
  if clear_draw then nextstate:=nextstate-'presentationDraw'; nextstate:=jsonb_set(nextstate,'{turn}',public.textos_empty_state()->'turn'); consequences:=consequences||jsonb_build_array('El sorteo y el cronómetro se reiniciarán.'); end if;
  if clear_rank then nextstate:=nextstate-'presentationRanking'; consequences:=consequences||jsonb_build_array('El ranking se eliminará y deberá generarse nuevamente.'); end if;
  select coalesce(jsonb_agg(x),'[]') into allids from jsonb_each(removed) e cross join lateral jsonb_array_elements(e.value) x;
  nextstate:=jsonb_set(nextstate,'{audit}',coalesce((select jsonb_agg(v) from jsonb_array_elements(coalesce(s->'audit','[]')) v where not(allids ? (v->>'referenceId')) and not(names ? (v->>'actor'))),'[]'));
 end if;
 for c in select jsonb_object_keys(removed) loop counts:=counts||jsonb_build_object(c,jsonb_array_length(removed->c)); end loop;
 counts:=counts||jsonb_build_object('deliveries',jsonb_array_length(coalesce(s->'deliveries','[]'))-jsonb_array_length(coalesce(nextstate->'deliveries','[]')),'presentationDraw',case when clear_draw and s->'presentationDraw' is not null then 1 else 0 end,'presentationRanking',case when clear_rank and s->'presentationRanking' is not null then 1 else 0 end,'responseScores',response_count);
 if jsonb_array_length(removed->'paperPolls')>0 then consequences:=consequences||jsonb_build_array('Se eliminarán las votaciones en papel afectadas, sus votos y los códigos de sus fichas.'); end if;
 if jsonb_array_length(removed->'rounds')>0 then consequences:=consequences||jsonb_build_array('Se eliminarán las rondas anteriores afectadas, sus conteos y códigos de voto.'); end if;
 if jsonb_array_length(removed->'teachers')>0 and scope<>'all' then consequences:=consequences||jsonb_build_array('Los accesos de los docentes eliminados dejarán de funcionar.'); end if;
 perform public.textos_validate_state(nextstate);
 select coalesce(jsonb_agg(x),'[]') into allids from jsonb_each(removed) e cross join lateral jsonb_array_elements(e.value) x;
 return jsonb_build_object('state',nextstate,'removed',removed,'allIds',allids||rewritten,'teacherNames',names,'preview',jsonb_build_object('stateVersion',(s->>'version')::int,'scope',scope,'ids',ids,'labels',labels,'counts',counts,'consequences',consequences,'requiresFullConfirmation',scope='all'));
end $$;

create or replace function public.textos_cleanup_action(s jsonb,p_action text,p_payload jsonb,actor_role text,actor_id text,actor_name text,p_dataset text,nowat timestamptz) returns jsonb
language plpgsql volatile set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare plan jsonb; preview jsonb; removed jsonb; scope text:=p_payload->>'scope'; n integer; col text; counts jsonb;
begin
 if actor_role is distinct from 'coordinator' then perform public.textos_fail('Solo Subdirección puede eliminar información.','PT403'); end if;
 if p_action not in ('data_delete_preview','data_delete_apply') then perform public.textos_fail('Operación de eliminación no reconocida.'); end if;
 plan:=public.textos_cleanup_plan(s,p_payload); preview:=plan->'preview'; removed:=plan->'removed'; counts:=preview->'counts';
 select count(*) into n from public.textos_access a where a.dataset=p_dataset and a.role='teacher' and (scope='all' or removed->'teachers' ? a.teacher_id); counts:=counts||jsonb_build_object('teacherAccesses',n);
 select count(*) into n from public.textos_ballots b where b.dataset=p_dataset and (scope='all' or removed->'rounds' ? b.round_id); counts:=counts||jsonb_build_object('ballots',n);
 select count(*) into n from public.textos_aggregates b where b.dataset=p_dataset and (scope='all' or removed->'rounds' ? b.round_id); counts:=counts||jsonb_build_object('voteAggregates',n);
 select count(*) into n from public.textos_paper_tokens b where b.dataset=p_dataset and (scope='all' or removed->'paperPolls' ? b.poll_id); counts:=counts||jsonb_build_object('paperTokens',n);
 select count(*) into n from public.textos_paper_evidence b where b.dataset=p_dataset and (scope='all' or removed->'paperPolls' ? b.poll_id); counts:=counts||jsonb_build_object('paperEvidence',n);
 select count(*) into n from public.textos_history h where h.dataset=p_dataset and (scope='all' or plan->'allIds' ? h.reference_id or plan->'teacherNames' ? h.actor or public.textos_cleanup_mentions(h.previous,plan->'allIds')); counts:=counts||jsonb_build_object('history',n);
 preview:=jsonb_set(preview,'{counts}',counts);
 if p_action='data_delete_preview' then return jsonb_build_object('state',s,'result',preview,'referenceId',scope,'reason','','history','[]'::jsonb); end if;
 if not public.textos_int(p_payload->'expectedVersion') or p_payload->'expectedVersion' is distinct from s->'version' then perform public.textos_fail('La información cambió. Revise nuevamente lo que se eliminará.','PT409'); end if;
 if p_payload->>'confirmation' is distinct from (case when scope='all' then 'ELIMINAR TODO' else 'ELIMINAR' end) then perform public.textos_fail('Confirme expresamente la eliminación seleccionada.'); end if;
 delete from public.textos_access a where a.dataset=p_dataset and a.role='teacher' and (scope='all' or removed->'teachers' ? a.teacher_id);
 delete from public.textos_ballots b where b.dataset=p_dataset and (scope='all' or removed->'rounds' ? b.round_id);
 delete from public.textos_aggregates b where b.dataset=p_dataset and (scope='all' or removed->'rounds' ? b.round_id);
 delete from public.textos_paper_tokens b where b.dataset=p_dataset and (scope='all' or removed->'paperPolls' ? b.poll_id);
 delete from public.textos_paper_evidence b where b.dataset=p_dataset and (scope='all' or removed->'paperPolls' ? b.poll_id);
 delete from public.textos_history h where h.dataset=p_dataset and (scope='all' or plan->'allIds' ? h.reference_id or plan->'teacherNames' ? h.actor or public.textos_cleanup_mentions(h.previous,plan->'allIds'));
 return jsonb_build_object('state',plan->'state','result',jsonb_build_object('deleted',true,'preview',preview),'referenceId',scope,'reason','Eliminación administrativa de información confirmada','history','[]'::jsonb);
end $$;
-- END DATA CLEANUP HELPERS

-- BEGIN PAPER EVIDENCE HELPERS
-- BEGIN PAPER EVIDENCE HELPERS
-- Optional private photos. They document the paper record; they never recognize,
-- authorize or count a vote, and may be added after the election is closed.
create table if not exists public.textos_paper_evidence (
 id uuid primary key default gen_random_uuid(),
 dataset text not null references public.textos_datasets(id),
 poll_id text not null, classroom_id text not null,
 filename text not null check(length(filename) between 1 and 160),
 mime_type text not null check(mime_type in ('image/jpeg','image/png','image/webp')),
 content bytea not null check(octet_length(content) between 16 and 1048576),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 unique(dataset,poll_id,classroom_id,sha256)
);
create index if not exists textos_paper_evidence_poll_idx on public.textos_paper_evidence(dataset,poll_id);
alter table public.textos_paper_evidence enable row level security;
revoke all on public.textos_paper_evidence from public;
do $$declare role_name text; begin
 foreach role_name in array array['anon','authenticated'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on public.textos_paper_evidence from %I',role_name); end if;
 end loop;
end $$;

create or replace function public.textos_paper_evidence_metadata(e public.textos_paper_evidence) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',e.id,'pollId',e.poll_id,'classroomId',e.classroom_id,
  'filename',e.filename,'mimeType',e.mime_type,'bytes',octet_length(e.content),'createdAt',e.created_at)
$$;

create or replace function public.textos_paper_evidence_prune(s jsonb,p_dataset text) returns void
language sql volatile set search_path=pg_catalog,public as $$
 delete from public.textos_paper_evidence e where e.dataset=p_dataset and not exists(
  select 1 from jsonb_array_elements(coalesce(s->'paperPolls','[]')) p
  cross join lateral jsonb_array_elements(coalesce(p->'classrooms','[]')) c
  where p->>'id'=e.poll_id and p->'rosterVersion'='1'::jsonb and c->>'id'=e.classroom_id
 )
$$;

create or replace function public.textos_paper_evidence_action(s jsonb,p_action text,p_payload jsonb,actor_role text,p_dataset text,nowat timestamptz) returns jsonb
language plpgsql volatile set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare poll jsonb; classroom jsonb; entry public.textos_paper_evidence%rowtype;
 target_poll_id text:=p_payload->>'pollId'; target_classroom_id text:=p_payload->>'classroomId';
 filename text; mime text; raw bytea; digest text; result jsonb;
begin
 if actor_role is distinct from 'coordinator' then perform public.textos_fail('Solo Subdirección consulta o adjunta fotos de respaldo.','PT403'); end if;
 if p_action not in ('paper_evidence_add','paper_evidence_list','paper_evidence_get','paper_evidence_delete') then perform public.textos_fail('Operación de respaldo fotográfico desconocida.','PT404'); end if;
 poll:=public.textos_find(s,'paperPolls',target_poll_id);
 if poll is null or poll->'rosterVersion' is distinct from '1'::jsonb then perform public.textos_fail('Seleccione una votación con padrón de aulas.','PT404'); end if;
 if p_action='paper_evidence_list' then
  select coalesce(jsonb_agg(public.textos_paper_evidence_metadata(e) order by e.classroom_id,e.created_at,e.id),'[]') into result
   from public.textos_paper_evidence e where e.dataset=p_dataset and e.poll_id=target_poll_id;
  return jsonb_build_object('result',result);
 end if;
 if p_action in ('paper_evidence_get','paper_evidence_delete') then
  select e.* into entry from public.textos_paper_evidence e
   where e.dataset=p_dataset and e.poll_id=target_poll_id and e.id::text=p_payload->>'evidenceId' for update;
  if not found then perform public.textos_fail('No se encontró esa foto en la votación seleccionada.','PT404'); end if;
  if p_action='paper_evidence_get' then return jsonb_build_object('result',public.textos_paper_evidence_metadata(entry)||jsonb_build_object('data',encode(entry.content,'base64'))); end if;
  delete from public.textos_paper_evidence where id=entry.id;
  return jsonb_build_object('result',jsonb_build_object('deleted',true,'id',entry.id));
 end if;
 select c into classroom from jsonb_array_elements(coalesce(poll->'classrooms','[]')) c where c->>'id'=target_classroom_id;
 if classroom is null then perform public.textos_fail('Seleccione el aula de esta ficha.','PT400'); end if;
 if jsonb_typeof(p_payload->'filename') is distinct from 'string' or jsonb_typeof(p_payload->'mimeType') is distinct from 'string'
  or jsonb_typeof(p_payload->'data') is distinct from 'string' then perform public.textos_fail('Seleccione una foto válida de la ficha.'); end if;
 filename:=trim(p_payload->>'filename'); mime:=p_payload->>'mimeType';
 if length(filename) not between 1 and 160 or filename ~ '[[:cntrl:]]' then perform public.textos_fail('El nombre de la foto no es válido.'); end if;
 if mime not in ('image/jpeg','image/png','image/webp') then perform public.textos_fail('Use una foto JPG, PNG o WebP.'); end if;
 if length(p_payload->>'data') not between 24 and 1398104 or p_payload->>'data' !~ '^[A-Za-z0-9+/]+={0,2}$' then perform public.textos_fail('La foto no tiene un formato válido o supera el tamaño permitido.'); end if;
 begin raw:=decode(p_payload->>'data','base64');
 exception when invalid_parameter_value then perform public.textos_fail('No se pudo abrir el contenido de la foto.'); end;
 if octet_length(raw) not between 16 and 1048576 then perform public.textos_fail('La foto supera el tamaño permitido.'); end if;
 if (mime='image/jpeg' and (substring(raw from 1 for 3)<>decode('ffd8ff','hex') or substring(raw from octet_length(raw)-1 for 2)<>decode('ffd9','hex')))
  or (mime='image/png' and substring(raw from 1 for 8)<>decode('89504e470d0a1a0a','hex'))
  or (mime='image/webp' and (substring(raw from 1 for 4)<>decode('52494646','hex') or substring(raw from 9 for 4)<>decode('57454250','hex'))) then
  perform public.textos_fail('El contenido no corresponde al tipo de foto indicado.');
 end if;
 digest:=encode(sha256(raw),'hex');
 select e.* into entry from public.textos_paper_evidence e where e.dataset=p_dataset and e.poll_id=target_poll_id and e.classroom_id=target_classroom_id and e.sha256=digest;
 if found then return jsonb_build_object('result',public.textos_paper_evidence_metadata(entry)||jsonb_build_object('duplicate',true)); end if;
 if (select count(*) from public.textos_paper_evidence e where e.dataset=p_dataset and e.poll_id=target_poll_id and e.classroom_id=target_classroom_id)>=3 then perform public.textos_fail('El aula ya tiene tres fotos de respaldo. Elimine una si necesita reemplazarla.','PT409'); end if;
 insert into public.textos_paper_evidence(dataset,poll_id,classroom_id,filename,mime_type,content,sha256,created_at)
  values(p_dataset,target_poll_id,target_classroom_id,filename,mime,raw,digest,nowat) returning * into entry;
 return jsonb_build_object('result',public.textos_paper_evidence_metadata(entry));
end $$;
-- END PAPER EVIDENCE HELPERS
-- END PAPER EVIDENCE HELPERS

create or replace function public.textos_api(p_action text, p_payload jsonb default '{}'::jsonb, p_code text default null, p_dataset text default 'real') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare
 s jsonb; result jsonb; actor_role text; actor_id text; actor_name text; uid uuid;
 a public.textos_access%rowtype; ballot public.textos_ballots%rowtype;
 credential public.textos_director_credentials%rowtype; login_limit public.textos_login_limits%rowtype; authenticated_password boolean;
 entity jsonb; old jsonb; b jsonb; assignment jsonb; ev jsonb; x jsonb; y jsonb; z jsonb; r jsonb; parent jsonb; shortlist jsonb; category jsonb;
 col text; keyname text; entityid text; id text; v_area text; grade text; code text; reason text; offerid text; command text; k text; g text; teacher text;
 n integer; v integer; count_n integer; total integer; limit_n integer; expected integer; lim integer; min_required integer;
 codes jsonb:='[]'; opts jsonb; counts jsonb; list jsonb; finalids jsonb; nowat timestamptz:=clock_timestamp(); changed boolean:=true; is_restore boolean:=false;
 backup jsonb; saved jsonb; mismatch boolean; rowrec record;
begin
 if coalesce(p_dataset,'') not in ('real','demo') or p_action is null or jsonb_typeof(p_payload) is distinct from 'object' then perform public.textos_fail('Petición inválida.'); end if;
 if octet_length(p_payload::text)>16000000 then perform public.textos_fail('La petición supera 16 MB.','PT413'); end if;
 -- One dataset lock serializes all state transitions, CAS, token consumption and aggregates.
 select d.state into s from public.textos_datasets d where d.id=p_dataset for update;
 if p_action='director_login' then
  insert into public.textos_login_limits(dataset) values(p_dataset) on conflict do nothing;
  select t.* into login_limit from public.textos_login_limits t where t.dataset=p_dataset for update;
  if login_limit.blocked_until>nowat then
   perform set_config('response.status','429',true);
   return jsonb_build_object('error',jsonb_build_object('code','PT429','message','Espere un minuto antes de volver a ingresar.'));
  end if;
  select t.* into credential from public.textos_director_credentials t where t.dataset=p_dataset;
  if credential.dataset is null then perform public.textos_fail('El acceso de Subdirección aún no está configurado.','PT423'); end if;
  if jsonb_typeof(p_payload->'password') is distinct from 'string' or length(p_payload->>'password') not between 1 and 256 then
   authenticated_password:=false;
  else
   authenticated_password:=public.textos_password_hash(p_payload->>'password',credential.salt,credential.iterations)=credential.password_hash;
  end if;
  if not authenticated_password then
   if login_limit.window_started_at<nowat-interval '15 minutes' then login_limit.failures:=0; login_limit.window_started_at:=nowat; end if;
   update public.textos_login_limits set failures=login_limit.failures+1,window_started_at=login_limit.window_started_at,
    blocked_until=case when login_limit.failures+1>=5 then nowat+interval '1 minute' end where dataset=p_dataset;
   -- Do not RAISE here: an exception would roll back the failed-attempt counter.
   perform set_config('response.status','401',true);
   return jsonb_build_object('error',jsonb_build_object('code','PT401','message','Contraseña incorrecta.'));
  end if;
  update public.textos_login_limits set failures=0,window_started_at=nowat,blocked_until=null where dataset=p_dataset;
  code:=public.textos_code();
  insert into public.textos_access(dataset,code_hash,role,name,expires_at) values(p_dataset,public.textos_hash(code),'coordinator','Subdirección',nowat+interval '180 days') returning id::text into actor_id;
  return jsonb_build_object('code',code,'snapshot',public.textos_snapshot(s,'coordinator',actor_id,'Subdirección',p_dataset,nowat));
 end if;
 if p_action='teacher_register' then
  entity:=public.textos_teacher_profile(p_payload);
  if p_code is not null then
   select t.* into a from public.textos_access t where t.code_hash=public.textos_hash(p_code) and t.dataset=p_dataset and t.role='teacher' and not t.revoked and t.expires_at>nowat;
   if not found then perform public.textos_fail('Su sesión venció. Solicite a Subdirección su enlace privado de recuperación.','PT401'); end if;
   actor_id:=a.teacher_id; old:=public.textos_find(s,'teachers',actor_id);
   if old is null then perform public.textos_fail('El perfil requiere recuperación por Subdirección.','PT401'); end if;
  end if;
  -- A name is never an authentication factor, including names already in legacy data.
  if exists(select 1 from jsonb_array_elements(s->'teachers') q where q->>'id' is distinct from actor_id and public.textos_canonical_name(q->>'name') in (public.textos_canonical_name(entity->>'name'),public.textos_canonical_name((entity->>'firstNames')||' '||(entity->>'lastNames')))) then
   perform public.textos_fail('Este docente ya está registrado. Solicite a Subdirección su enlace privado de recuperación.','PT409');
  end if;
  if actor_id is null then actor_id:=gen_random_uuid()::text; end if;
  entity:=coalesce(old,jsonb_build_object('attended',false,'attendanceEvidence',''))||entity||jsonb_build_object('id',actor_id,'version',coalesce((old->>'version')::integer,0)+1);
  s:=public.textos_put(s,'teachers',entity);
  -- Enrollment changes the cohort. Preserve a published result as history before
  -- admitting a new member or moving a teacher between areas/categories.
  if old is null or (old->>'area') is distinct from (entity->>'area')
   or not (coalesce(old->'categories','[]') @> (entity->'categories') and (entity->'categories') @> coalesce(old->'categories','[]')) then
   for x in select q from jsonb_array_elements(coalesce(s->'presentationShortlists','[]')) q
    where q->>'status'='published' and (((q->>'area')=(entity->>'area') and (entity->'categories') ? (q->>'block'))
     or ((q->>'area')=(old->>'area') and coalesce(old->'categories','[]') ? (q->>'block'))) loop
    insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous,at)
     values(p_dataset,'presentationShortlists',x->>'id',entity->>'name','Inscripción/actualización docente',x,nowat);
    s:=public.textos_put(s,'presentationShortlists',x||jsonb_build_object('status','superseded','version',(x->>'version')::int+1));
   end loop;
  end if;
  if old is not null then insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,'teachers',actor_id,entity->>'name','Actualización del perfil docente',old); end if;
  perform public.textos_validate_state(s);
  s:=jsonb_set(s,'{audit}',s->'audit'||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'actor',entity->>'name','action','teacher_register','referenceId',actor_id,'reason','Inscripción/actualización docente','at',nowat,'summary','Perfil docente confirmado en servidor')));
  s:=jsonb_set(s,'{version}',to_jsonb((s->>'version')::int+1));
  update public.textos_datasets set state=s,updated_at=nowat where id=p_dataset;
  if p_code is null then
   code:=public.textos_code();
   insert into public.textos_access(dataset,code_hash,role,teacher_id,name,expires_at) values(p_dataset,public.textos_hash(code),'teacher',actor_id,entity->>'name',nowat+interval '180 days');
  else
   code:=p_code; update public.textos_access set name=entity->>'name' where dataset=p_dataset and teacher_id=actor_id;
  end if;
  return jsonb_build_object('code',code,'snapshot',public.textos_snapshot(s,'teacher',actor_id,entity->>'name',p_dataset,nowat));
 end if;
 if p_action='public_snapshot' then return jsonb_build_object('state',public.textos_public_state(s),'actor',jsonb_build_object('id','public','name','Proyección','role','public'),'serverNow',nowat,'dataset',p_dataset); end if;
 if p_action in ('vote_preview','vote_cast') then
  if p_code is null then perform public.textos_fail('Código de cédula requerido.','PT401'); end if;
  select t.* into ballot from public.textos_ballots t where t.code_hash=public.textos_hash(p_code) and t.dataset=p_dataset for update;
  if not found then perform public.textos_fail('Código no válido.','PT401'); end if;
  if ballot.consumed then perform public.textos_fail('Esta cédula ya fue recibida.','PT409'); end if;
  r:=public.textos_find(s,'rounds',ballot.round_id);
  if r is null or r->>'status'<>'open' or r->>'mode'<>'digital' then perform public.textos_fail('La ronda digital no está abierta.','PT423'); end if;
  if p_action='vote_preview' then
   opts:='{}';
   for v_area in select jsonb_array_elements_text(r->'areas') loop
    list:='[]';
    for offerid in select jsonb_array_elements_text(r#>array['options',v_area]) loop
     x:=public.textos_find(s,'offers',offerid); y:=public.textos_find(s,'series',x->>'seriesId'); z:=public.textos_find(s,'publishers',y->>'publisherId');
     select q into b from jsonb_array_elements(s->'books') q where q->>'offerId'=offerid and q->>'gradeId'=r->>'gradeId' and (q->>'active')::boolean;
     list:=list||jsonb_build_array(jsonb_build_object('id',offerid,'label',(z->>'name')||' — '||(y->>'name'),'title',b->>'title','edition',b->>'edition','publisher',z->>'name'));
    end loop;
    opts:=opts||jsonb_build_object(v_area,list);
   end loop;
   return jsonb_build_object('roundId',r->>'id','gradeId',r->>'gradeId','number',r->'number','areas',r->'areas','options',opts,'confirmed',false);
  end if;
  if p_payload->'confirmed' is distinct from 'true'::jsonb or jsonb_typeof(p_payload->'choices') is distinct from 'object' then perform public.textos_fail('Confirme su cédula.'); end if;
  if exists(select 1 from jsonb_object_keys(p_payload->'choices') q where not (r->'areas' ? q)) then perform public.textos_fail('La cédula incluye un área ajena a esta ronda.'); end if;
  if (r->>'deposited')::int >= (r->>'delivered')::int then perform public.textos_fail('Se recibieron todas las cédulas entregadas.','PT423'); end if;
  for v_area in select jsonb_array_elements_text(r->'areas') loop
   if not (p_payload->'choices' ? v_area) then perform public.textos_fail('Seleccione una opción o blanco en cada área.'); end if;
   offerid:=p_payload#>>array['choices',v_area];
   if offerid is not null and not (r#>array['options',v_area] ? offerid) then perform public.textos_fail('Opción ajena a esta cédula.'); end if;
   insert into public.textos_aggregates(dataset,round_id,area,option_id,votes) values(p_dataset,r->>'id',v_area,coalesce(offerid,'__blank__'),1) on conflict(dataset,round_id,area,option_id) do update set votes=textos_aggregates.votes+1;
  end loop;
  update public.textos_ballots set consumed=true where code_hash=ballot.code_hash;
  r:=r||jsonb_build_object('deposited',(r->>'deposited')::int+1,'version',(r->>'version')::int+1); s:=public.textos_put(s,'rounds',r); s:=jsonb_set(s,'{version}',to_jsonb((s->>'version')::int+1));
  update public.textos_datasets set state=s,updated_at=nowat where id=p_dataset;
  -- No audit event and no stored payload: only aggregate counters and consumed hash survive.
  return jsonb_build_object('accepted',true);
 end if;
 -- auth.uid() is supplied by Supabase; local owner bootstrap does not create/replace it.
 if to_regprocedure('auth.uid()') is not null then execute 'select auth.uid()' into uid;
 else begin uid:=nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'; exception when others then uid:=null; end; end if;
 if uid is not null and exists(select 1 from public.textos_coordinators c where c.user_id=uid) then actor_role:='coordinator'; actor_id:=uid::text; select c.name into actor_name from public.textos_coordinators c where c.user_id=uid;
 elsif p_code is not null then
  select t.* into a from public.textos_access t where t.code_hash=public.textos_hash(p_code) and t.dataset=p_dataset and not t.revoked and t.expires_at>nowat;
  if found then actor_role:=a.role; actor_id:=coalesce(a.teacher_id,a.id::text); actor_name:=a.name; end if;
 end if;
 if actor_role is null then perform public.textos_fail('Acceso individual requerido.','PT401'); end if;
 if p_action='snapshot' then return public.textos_snapshot(s,actor_role,actor_id,actor_name,p_dataset,nowat); end if;
 if actor_role='teacher' and p_action not in ('evaluation_save','evaluation_close','presentation_save','presentation_close','presentation_restart_scale','presentation_enable_question') then perform public.textos_fail('Operación reservada a coordinación o mesa.','PT403'); end if;
 if actor_role='secretary' and p_action not in ('publisher_save','series_save','offer_save','book_save','teacher_save','section_save','attendance_save','delivery_mark','paper_tally_save','incident_save','import_preview','import_apply','presentation_summary') then perform public.textos_fail('Operación reservada a coordinación.','PT403'); end if;
 reason:=coalesce(p_payload->>'reason',p_payload->>'reopenReason','');
 if p_action in ('data_delete_preview','data_delete_apply') then
  saved:=public.textos_cleanup_action(s,p_action,p_payload,actor_role,actor_id,actor_name,p_dataset,nowat);
  if p_action='data_delete_preview' then return saved->'result'; end if;
  s:=saved->'state'; result:=saved->'result'; entityid:=saved->>'referenceId'; reason:=coalesce(saved->>'reason',reason);
 elsif p_action='presentation_question_save' then
  saved:=public.textos_question_action(s,p_action,p_payload,actor_role,actor_id,actor_name,p_dataset,nowat);
  s:=saved->'state'; result:=saved->'result'; entityid:=saved->>'referenceId'; reason:=coalesce(saved->>'reason',reason);
  for x in select value from jsonb_array_elements(coalesce(saved->'history','[]')) loop
   insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous,at) values(p_dataset,x->>'entity',x->>'referenceId',actor_name,coalesce(x->>'reason',''),x->'previous',nowat);
  end loop;
 elsif p_action in ('paper_evidence_add','paper_evidence_list','paper_evidence_get','paper_evidence_delete') then
  saved:=public.textos_paper_evidence_action(s,p_action,p_payload,actor_role,p_dataset,nowat);
  return saved->'result';
 elsif p_action in ('paper_poll_create','paper_ballots_generate','paper_scan_cast','paper_poll_close','paper_attendance_save','paper_manual_cast','paper_manual_correct') then
  saved:=public.textos_paper_action(s,p_action,p_payload,actor_role,actor_id,actor_name,p_dataset,nowat);
  s:=saved->'state'; result:=saved->'result'; entityid:=saved->>'referenceId'; reason:=coalesce(saved->>'reason',reason);
  for x in select value from jsonb_array_elements(coalesce(saved->'history','[]')) loop
   insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous,at) values(p_dataset,x->>'entity',x->>'referenceId',actor_name,coalesce(x->>'reason',''),x->'previous',nowat);
  end loop;
 elsif p_action in ('presentation_draw','presentation_ranking_generate') then
  saved:=public.textos_jornada_action(s,p_action,p_payload,actor_role,actor_id,actor_name,p_dataset,nowat);
  s:=saved->'state'; result:=saved->'result'; entityid:=saved->>'referenceId'; reason:=coalesce(saved->>'reason',reason);
  for x in select value from jsonb_array_elements(coalesce(saved->'history','[]')) loop
   insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous,at) values(p_dataset,x->>'entity',x->>'referenceId',actor_name,coalesce(x->>'reason',''),x->'previous',nowat);
  end loop;
 elsif p_action in ('presentation_save','presentation_close','presentation_restart_scale','presentation_enable_question','presentation_reopen','presentation_summary','presentation_shortlist_publish') then
  saved:=public.textos_presentation_api(s,p_action,p_payload,actor_role,actor_id,actor_name,nowat);
  s:=saved->'state'; result:=saved->'result'; entityid:=result->>'id';
  if p_action='presentation_summary' then return result; end if;
  for x in select value from jsonb_array_elements(coalesce(saved->'history','[]')) loop
   insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous,at) values(p_dataset,x->>'entity',x->>'referenceId',actor_name,coalesce(x->>'reason',''),x->'previous',nowat);
  end loop;
 elsif p_action in ('publisher_save','series_save','offer_save','book_save','teacher_save','assignment_save','section_save','incident_save') then
  keyname:=split_part(p_action,'_',1); col:=case keyname when 'publisher' then 'publishers' when 'series' then 'series' when 'offer' then 'offers' when 'book' then 'books' when 'teacher' then 'teachers' when 'assignment' then 'assignments' when 'section' then 'sections' else 'incidents' end;
  entity:=p_payload->keyname;
  if jsonb_typeof(entity) is distinct from 'object' then perform public.textos_fail('Entidad requerida.'); end if;
  entityid:=nullif(entity->>'id',''); old:=public.textos_find(s,col,entityid);
  if keyname='publisher' and s->'presentationDraw' is not null and ((s#>>'{turn,startedAt}') is not null or jsonb_array_length(s#>'{presentationDraw,completedPublisherIds}')>0) and (old is null or entity->>'name' is distinct from old->>'name') then perform public.textos_fail('El sorteo ya comenzó. Conserve las editoriales y sus nombres durante esta jornada.','PT423'); end if;
  if entityid is not null and old is null then perform public.textos_fail('Registro no encontrado.','PT404'); end if;
  if old is not null and coalesce((entity->>'version')::int,-1)<>(old->>'version')::int then perform public.textos_fail('El registro cambió en otra sesión; recargue antes de guardar.','PT409'); end if;
  if entityid is null then entityid:=gen_random_uuid()::text; v:=1; else v:=(old->>'version')::int+1; end if;
  entity:=entity||jsonb_build_object('id',entityid,'version',v);
  if keyname in ('publisher','series','teacher') and nullif(trim(entity->>'name'),'') is null then perform public.textos_fail('Nombre obligatorio.'); end if;
  if actor_role='secretary' and keyname='teacher' and old is not null and (entity-'attended'-'attendanceEvidence'-'version')<>(old-'attended'-'attendanceEvidence'-'version') then perform public.textos_fail('Mesa solo registra asistencia docente.','PT403'); end if;
  if keyname='assignment' and old is not null and entity-'version'<>old-'version' and exists(select 1 from jsonb_array_elements(s->'evaluations') q where q->>'assignmentId'=entityid) then perform public.textos_fail('Asignación con ficha: conserve su historial.','PT423'); end if;
  if keyname='offer' then
   if old is not null and exists(select 1 from jsonb_array_elements(s->'shortlists') q where q->>'status'='published' and q->'offerIds' ? entityid) then perform public.textos_fail('Oferta en terna publicada; reabra la versión antes de modificar.','PT423'); end if;
   if entity->>'status'='withdrawn' then entity:=entity||jsonb_build_object('withdrawnAt',nowat); end if;
  end if;
  if keyname='book' then
   if old is not null then
    if exists(select 1 from jsonb_array_elements(s->'evaluations') q where q->>'bookId'=entityid) and (entity->>'title'<>old->>'title' or entity->>'edition'<>old->>'edition' or entity->>'offerId'<>old->>'offerId' or entity->>'gradeId'<>old->>'gradeId') then perform public.textos_fail('Título o edición nuevos requieren un nuevo texto, sin reutilizar fichas.','PT423'); end if;
    if exists(select 1 from jsonb_array_elements(s->'shortlists') q where q->>'status'='published' and q->'offerIds' ? (old->>'offerId')) then perform public.textos_fail('Texto en terna publicada; reabra primero.','PT423'); end if;
    if (old->>'dossierClosed')::boolean and entity-'version'<>old-'version' and nullif(trim(reason),'') is null then perform public.textos_fail('La corrección de expediente cerrado requiere motivo.'); end if;
   elsif nullif(p_payload->>'supersedes','') is not null or nullif(entity->>'supersedesId','') is not null then
    id:=coalesce(p_payload->>'supersedes',entity->>'supersedesId'); x:=public.textos_find(s,'books',id);
    if x is null or nullif(trim(reason),'') is null then perform public.textos_fail('Sustitución requiere texto anterior y motivo.'); end if;
    if exists(select 1 from jsonb_array_elements(s->'shortlists') q where q->>'status'='published' and q->'offerIds' ? (x->>'offerId')) then perform public.textos_fail('La oferta tiene una terna publicada.','PT423'); end if;
    s:=public.textos_put(s,'books',x||jsonb_build_object('active',false,'version',(x->>'version')::int+1));
    entity:=entity||jsonb_build_object('supersedesId',id);
   end if;
  end if;
  if keyname='section' then
   if old is not null and exists(select 1 from jsonb_array_elements(s->'deliveries') q where q->>'sectionId'=entityid) and entity-'version'<>old-'version' then perform public.textos_fail('Sección con entrega registrada; documente incidencia.','PT423'); end if;
   if p_payload->'remove'='true' then s:=jsonb_set(s,'{sections}',coalesce((select jsonb_agg(q) from jsonb_array_elements(s->'sections') q where q->>'id'<>entityid),'[]')); result:=jsonb_build_object('removed',true); else s:=public.textos_put(s,col,entity); result:=entity; end if;
  else
   if keyname='incident' then entity:=entity||jsonb_build_object('actor',actor_name,'createdAt',coalesce(old->>'createdAt',nowat::text)); end if;
   s:=public.textos_put(s,col,entity); result:=entity;
  end if;
  if old is not null then insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,col,entityid,actor_name,reason,old); end if;
 elsif p_action='settings_save' then
  old:=s->'settings'; entity:=p_payload->'settings'; entity:=entity||jsonb_build_object('presentationScaleMax',4);
  if coalesce((p_payload->>'expectedVersion')::int,-1)<>(old->>'version')::int then perform public.textos_fail('La configuración cambió en otra sesión.','PT409'); end if;
  if entity->'rules'<>old->'rules' and exists(select 1 from jsonb_array_elements(s->'rounds') q where q->>'status'<>'void') then perform public.textos_fail('Las reglas de representación y evaluación ya están fijadas para las rondas.','PT423'); end if;
  if old#>'{rules,lockedAt}'<>'null' and entity->'rules'<>old->'rules' then
   if nullif(trim(reason),'') is null then perform public.textos_fail('Reglas bloqueadas; reapertura requiere motivo.','PT423'); end if;
   if exists(select 1 from jsonb_array_elements(s->'rounds') q where q->>'status'<>'void') then perform public.textos_fail('No se pueden alterar reglas utilizadas en votación.','PT423'); end if;
   entity:=jsonb_set(entity,'{rules,version}',to_jsonb((old#>>'{rules,version}')::int+1)); entity:=jsonb_set(entity,'{rules,lockedAt}','null');
   for ev in select value from jsonb_array_elements(s->'evaluations') loop
    insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,'evaluations',ev->>'id',actor_name,reason,ev);
    s:=public.textos_put(s,'evaluations',ev||jsonb_build_object('status','draft','closedAt',null,'rulesVersion',entity#>'{rules,version}','version',(ev->>'version')::int+1));
   end loop;
   for x in select value from jsonb_array_elements(s->'shortlists') loop s:=public.textos_put(s,'shortlists',x||jsonb_build_object('status','superseded','version',(x->>'version')::int+1)); end loop;
  else entity:=jsonb_set(entity,'{rules,version}',old#>'{rules,version}'); entity:=jsonb_set(entity,'{rules,lockedAt}',old#>'{rules,lockedAt}'); end if;
  entity:=entity||jsonb_build_object('version',(old->>'version')::int+1,'timezone','America/Lima'); s:=jsonb_set(s,'{settings}',entity); result:=entity;
  insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,'settings','settings',actor_name,reason,old);
 elsif p_action='attendance_save' then
  entity:=public.textos_find(s,'teachers',p_payload->>'teacherId'); if entity is null then perform public.textos_fail('Docente no encontrado.','PT404'); end if;
  entity:=entity||jsonb_build_object('attended',p_payload->'present','attendanceEvidence',coalesce(p_payload->>'evidence',''),'version',(entity->>'version')::int+1); s:=public.textos_put(s,'teachers',entity); result:=entity;
 elsif p_action='access_create' then
  if coalesce(p_payload->>'role','') not in ('teacher','secretary') then perform public.textos_fail('Rol de acceso inválido.'); end if;
  if p_payload->>'role'='teacher' and public.textos_find(s,'teachers',p_payload->>'teacherId') is null then perform public.textos_fail('Docente no encontrado.'); end if;
  code:=public.textos_code();
  insert into public.textos_access(dataset,code_hash,role,teacher_id,name,expires_at) values(p_dataset,public.textos_hash(code),p_payload->>'role',case when p_payload->>'role'='teacher' then p_payload->>'teacherId' end,coalesce(nullif(p_payload->>'name',''),public.textos_find(s,'teachers',p_payload->>'teacherId')->>'name','Secretaría'),coalesce((p_payload->>'expiresAt')::timestamptz,nowat+interval '7 days')) returning name into teacher;
  result:=jsonb_build_object('code',code,'role',p_payload->>'role','name',teacher);
 elsif p_action in ('evaluation_save','evaluation_close','evaluation_reopen') then
  assignment:=public.textos_find(s,'assignments',p_payload->>'assignmentId');
  if assignment is null then perform public.textos_fail('Asignación no encontrada.','PT404'); end if;
  if p_action<>'evaluation_reopen' and (actor_role<>'teacher' or assignment->>'teacherId'<>actor_id) then perform public.textos_fail('Solo el docente asignado puede emitir su ficha.','PT403'); end if;
  select q into ev from jsonb_array_elements(s->'evaluations') q where q->>'assignmentId'=assignment->>'id';
  b:=public.textos_find(s,'books',assignment->>'bookId');
  if not (b->>'active')::boolean then perform public.textos_fail('El texto fue sustituido o retirado.','PT423'); end if;
  if p_action='evaluation_reopen' then
   if actor_role<>'coordinator' then perform public.textos_fail('Solo coordinación puede reabrir.','PT403'); end if;
   if ev is null or nullif(trim(reason),'') is null then perform public.textos_fail('Reapertura requiere ficha y motivo.'); end if;
   if exists(select 1 from jsonb_array_elements(s->'shortlists') q where q->>'status'='published' and q->'offerIds' ? (b->>'offerId')) then perform public.textos_fail('Reabra primero la terna afectada.','PT423'); end if;
   entity:=ev||jsonb_build_object('status','draft','closedAt',null,'version',(ev->>'version')::int+1,'bookVersion',b->'version','rulesVersion',s#>'{settings,rules,version}','updatedAt',nowat);
  else
   expected:=coalesce((p_payload->>'expectedVersion')::int,-1);
   if expected<>coalesce((ev->>'version')::int,0) then perform public.textos_fail('La ficha cambió en otra pestaña; conserve el borrador y resuelva el conflicto.','PT409'); end if;
   if ev->>'status'='closed' then perform public.textos_fail('La ficha está cerrada; coordinación debe reabrir con motivo.','PT423'); end if;
   if p_action='evaluation_save' then
    perform public.textos_scores(p_payload->'scores');
    if jsonb_typeof(p_payload->'evidence') is distinct from 'array' or jsonb_array_length(p_payload->'evidence')<>10 or jsonb_typeof(p_payload->'notes') is distinct from 'array' or jsonb_array_length(p_payload->'notes')<>10 then perform public.textos_fail('Se requieren diez referencias y observaciones.'); end if;
    entity:=(coalesce(ev,'{}')-'legacyIndicatorCount')||jsonb_build_object('id',coalesce(ev->>'id',gen_random_uuid()::text),'version',coalesce((ev->>'version')::int,0)+1,'assignmentId',assignment->>'id','bookId',b->>'id','teacherId',actor_id,'bookVersion',b->'version','rulesVersion',s#>'{settings,rules,version}','scores',p_payload->'scores','evidence',p_payload->'evidence','notes',p_payload->'notes','objection',coalesce(p_payload->'objection','false'::jsonb),'objectionDetail',coalesce(p_payload->>'objectionDetail',''),'status','draft','closedAt',null,'updatedAt',nowat);
   else
    if ev is null then perform public.textos_fail('Guarde la ficha antes de cerrarla.'); end if;
    perform public.textos_scores(ev->'scores',true);
    if exists(select 1 from jsonb_array_elements_text(ev->'evidence') q where nullif(trim(q),'') is null) then perform public.textos_fail('Cada indicador requiere referencia de evidencia para cerrar.'); end if;
    if (ev->>'objection')::boolean and nullif(trim(ev->>'objectionDetail'),'') is null then perform public.textos_fail('Detalle la objeción antes de cerrar.'); end if;
    lim:=public.textos_support_limit(b);
    if lim is null then perform public.textos_fail('I10 pendiente: aún falta verificar el apoyo ofrecido.'); end if;
    if (ev#>>'{scores,9}')::int>lim or (lim<2 and (ev#>>'{scores,9}')::int<>lim) then perform public.textos_fail('I10 debe reflejar las acciones incluidas realmente verificadas.'); end if;
    if ev->>'bookVersion'<>b->>'version' or ev->>'rulesVersion'<>s#>>'{settings,rules,version}' then perform public.textos_fail('El expediente o las reglas cambiaron; vuelva a guardar la ficha.','PT409'); end if;
    entity:=ev||jsonb_build_object('status','closed','closedAt',nowat,'updatedAt',nowat,'version',(ev->>'version')::int+1);
   end if;
   if s#>'{settings,rules,lockedAt}'='null' then s:=jsonb_set(s,'{settings,rules,lockedAt}',to_jsonb(nowat)); end if;
  end if;
  if ev is not null then insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,'evaluations',ev->>'id',actor_name,coalesce(nullif(reason,''),p_action),ev); end if;
  s:=public.textos_put(s,'evaluations',entity); result:=entity;
 elsif p_action='review_request' then
  category:=public.textos_category(s,p_payload->>'categoryId');
  if category->>'state'<>'tie' or nullif(trim(p_payload->>'unitReference'),'') is null or nullif(trim(reason),'') is null then perform public.textos_fail('Una segunda revisión requiere empate de corte, unidad adicional y motivo.'); end if;
  if jsonb_typeof(p_payload->'offerIds') is distinct from 'array' or jsonb_array_length(p_payload->'offerIds')<>(select count(distinct q) from jsonb_array_elements(p_payload->'offerIds') q) then perform public.textos_fail('Seleccione todas las series empatadas, sin duplicados.'); end if;
  if p_payload->'offerIds'<>category->'tied' and (select jsonb_agg(q order by q) from jsonb_array_elements(p_payload->'offerIds') q)<>(select jsonb_agg(q order by q) from jsonb_array_elements(category->'tied') q) then perform public.textos_fail('La revisión debe incluir todas las series del empate de corte.'); end if;
  if exists(select 1 from jsonb_array_elements(s->'reviews') q where q->>'categoryId'=p_payload->>'categoryId') then perform public.textos_fail('Ya existe una revisión adicional para esta categoría.','PT423'); end if;
  entity:=jsonb_build_object('id',gen_random_uuid()::text,'version',1,'categoryId',p_payload->>'categoryId','offerIds',p_payload->'offerIds','unitReference',p_payload->>'unitReference','reason',reason); s:=public.textos_put(s,'reviews',entity);
  for assignment in select q from jsonb_array_elements(s->'assignments') q where q->>'kind'='initial' and exists(select 1 from jsonb_array_elements(s->'books') bk where bk->>'id'=q->>'bookId' and p_payload->'offerIds' ? (bk->>'offerId')) loop
   s:=public.textos_put(s,'assignments',assignment||jsonb_build_object('id',gen_random_uuid()::text,'version',1,'kind','additional','reviewId',entity->>'id'));
  end loop; result:=entity;
 elsif p_action='turn_control' then
  s:=public.textos_jornada_turn(s,p_payload->>'command',p_payload->>'publisherId',p_payload->'expectedTurn');
  if p_payload->>'command'='finish' and s#>>'{settings,evaluationMode}'='presentation' and not public.textos_question_can_finish(s,s#>>'{turn,publisherId}') then perform public.textos_fail('Antes de finalizar, marque la casilla que confirma que se hizo la pregunta y la editorial respondió.','PT423'); end if;
  entity:=s->'turn'; command:=p_payload->>'command';
  if command in ('start','next') then
   id:=p_payload->>'publisherId'; if public.textos_find(s,'publishers',id) is null then perform public.textos_fail('Seleccione una editorial.'); end if;
   entity:=jsonb_build_object('publisherId',id,'status','running','startedAt',nowat,'pausedAt',null,'pausedMilliseconds',0);
  elsif command='pause' and entity->>'status'='running' then entity:=entity||jsonb_build_object('status','paused','pausedAt',nowat);
  elsif command='resume' and entity->>'status'='paused' then entity:=entity||jsonb_build_object('status','running','pausedMilliseconds',(entity->>'pausedMilliseconds')::numeric+extract(epoch from nowat-(entity->>'pausedAt')::timestamptz)*1000,'pausedAt',null);
  elsif command='finish' then entity:=entity||jsonb_build_object('status','finished','pausedAt',nowat);
  else perform public.textos_fail('Transición de reloj no válida.','PT409'); end if;
  s:=jsonb_set(s,'{turn}',entity); result:=entity;
 elsif p_action in ('shortlist_publish','shortlist_exception') then
  if p_payload->'directorApproved' is distinct from 'true'::jsonb or nullif(trim(p_payload->>'folio'),'') is null or not (s#>>'{settings,editorsWithdrawn}')::boolean or nullif(trim(s#>>'{settings,withdrawalReference}'),'') is null then perform public.textos_fail('Publicación requiere validación de Dirección, folio y retiro documentado de editoriales.'); end if;
  if p_action='shortlist_publish' then
   id:=p_payload->>'categoryId'; category:=public.textos_category(s,id);
   if category->>'state'<>'ready' then perform public.textos_fail('La categoría no está lista: '||(category->>'state')||'.','PT423'); end if;
   finalids:=category->'finalists'; list:=public.textos_grades(split_part(id,'-',2));
  else
   grade:=p_payload->>'gradeId'; v_area:=p_payload->>'area'; if public.textos_block(grade) is null or v_area not in ('MAT','COM') then perform public.textos_fail('Grado/área inválidos.'); end if;
   id:=v_area||'-'||public.textos_block(grade); category:=public.textos_category(s,id,grade); finalids:=p_payload->'offerIds'; list:=jsonb_build_array(grade);
   if public.textos_category(s,id)->>'state' not in ('less_than_three','review') then perform public.textos_fail('Use la terna común cuando existen tres alternativas aptas.'); end if;
   if exists(select 1 from jsonb_array_elements((public.textos_category(s,id))->'ranked') q where q->>'state'='pending') then perform public.textos_fail('Las fichas pendientes no prueban falta de oferta.','PT423'); end if;
   if jsonb_typeof(finalids) is distinct from 'array' or jsonb_array_length(finalids)<1 or jsonb_array_length(finalids)>3 or (select count(distinct q) from jsonb_array_elements(finalids) q)<>jsonb_array_length(finalids) or nullif(trim(reason),'') is null then perform public.textos_fail('Terna excepcional requiere 1 a 3 alternativas distintas y justificación.'); end if;
   if jsonb_array_length(finalids)<3 and (p_payload->'article113' is distinct from 'true'::jsonb or not exists(select 1 from jsonb_array_elements(s->'incidents') q where q->>'folio'=p_payload->>'folio' and nullif(trim(q->>'resolution'),'') is not null)) then perform public.textos_fail('Falta de pluralidad: registre incidencia art. 11.3 resuelta con el mismo folio.'); end if;
   for offerid in select jsonb_array_elements_text(finalids) loop
    x:=public.textos_find(s,'offers',offerid);
    if x is null or (x->>'area')||'-'||(x->>'block')<>id or public.textos_offer_assessment(s,x,grade)->>'state'<>'eligible' then perform public.textos_fail('La alternativa excepcional no es apta en ese grado.'); end if;
   end loop;
  end if;
  if exists(select 1 from jsonb_array_elements(s->'shortlists') q where q->>'categoryId'=id and q->>'status'='published' and (q->>'scope'='block' or q->'gradeIds'=list)) then perform public.textos_fail('Ya hay una versión publicada; reabra con motivo.','PT423'); end if;
  entity:=jsonb_build_object('id',gen_random_uuid()::text,'version',coalesce((select max((q->>'version')::int) from jsonb_array_elements(s->'shortlists') q where q->>'categoryId'=id),0)+1,'categoryId',id,'gradeIds',list,'offerIds',finalids,'status','published','scope',case when p_action='shortlist_publish' then 'block' else 'grade' end,'statement',coalesce(p_payload->>'statement',''),'folio',p_payload->>'folio','reason',reason,'directorApproved',true,'article113',coalesce(p_payload->'article113','false'::jsonb),'publishedAt',nowat,'rulesVersion',s#>'{settings,rules,version}','snapshot',jsonb_build_object('series',s->'series','publishers',s->'publishers','assessment',category,'rules',s#>'{settings,rules}','books',coalesce((select jsonb_agg(q) from jsonb_array_elements(s->'books') q where finalids ? (q->>'offerId') and list ? (q->>'gradeId') and (q->>'active')::boolean),'[]'),'offers',coalesce((select jsonb_agg(q) from jsonb_array_elements(s->'offers') q where finalids ? (q->>'id')),'[]')));
  s:=public.textos_put(s,'shortlists',entity); result:=entity;
 elsif p_action='shortlist_reopen' then
  entity:=public.textos_find(s,'shortlists',p_payload->>'shortlistId'); if entity is null or nullif(trim(reason),'') is null then perform public.textos_fail('Terna y motivo requeridos.'); end if;
  if exists(select 1 from jsonb_array_elements(s->'rounds') q where q->>'status'<>'void' and (q#>>'{shortlistIds,MAT}'=entity->>'id' or q#>>'{shortlistIds,COM}'=entity->>'id')) then perform public.textos_fail('La terna ya se utilizó en una ronda; resuelva los efectos mediante incidencia y anulación.','PT423'); end if;
  insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,'shortlists',entity->>'id',actor_name,reason,entity);
  entity:=entity||jsonb_build_object('status','superseded','version',(entity->>'version')::int+1); s:=public.textos_put(s,'shortlists',entity); result:=entity;
 elsif p_action in ('round_create','runoff_open') then
  if p_action='round_create' then
   grade:=p_payload->>'gradeId'; list:=coalesce(p_payload->'areas','["MAT","COM"]'::jsonb); parent:=null; n:=1;
   if public.textos_block(grade) is null or jsonb_typeof(list) is distinct from 'array' or jsonb_array_length(list) not between 1 and 2 or exists(select 1 from jsonb_array_elements_text(list) q where q not in ('MAT','COM')) or (select count(distinct q) from jsonb_array_elements(list) q)<>jsonb_array_length(list) then perform public.textos_fail('Grado/áreas inválidos.'); end if;
   if exists(select 1 from jsonb_array_elements(s->'rounds') q where q->>'gradeId'=grade and q->>'status'<>'void' and exists(select 1 from jsonb_array_elements_text(list) ar where q->'areas' ? ar)) then perform public.textos_fail('Ya existe ronda para ese grado/área; use segunda vuelta.','PT423'); end if;
  else
   parent:=public.textos_find(s,'rounds',p_payload->>'roundId'); v_area:=p_payload->>'area';
   if parent is null or parent->>'status'<>'closed' or parent#>>array['results',v_area,'state']<>'tie' or (parent->>'number')::int>=2 then perform public.textos_fail('Segunda vuelta exige empate familiar en una primera ronda cerrada.'); end if;
   if exists(select 1 from jsonb_array_elements(s->'rounds') q where q->>'parentId'=parent->>'id' and q->'areas' ? v_area and q->>'status'<>'void') then perform public.textos_fail('Ya existe segunda vuelta para esta área.','PT409'); end if;
   grade:=parent->>'gradeId'; list:=jsonb_build_array(v_area); n:=(parent->>'number')::int+1;
  end if;
  if coalesce(p_payload->>'mode',parent->>'mode','') not in ('paper','digital') or (parent is null and p_payload->'physicalReviewConfirmed' is distinct from 'true'::jsonb) then perform public.textos_fail('Seleccione modalidad y confirme la revisión física.'); end if;
  opts:='{}'; counts:='{}'; saved:='{}';
  for v_area in select jsonb_array_elements_text(list) loop
   if parent is null then
    select q into shortlist from jsonb_array_elements(s->'shortlists') q where q->>'status'='published' and q->>'categoryId'=v_area||'-'||public.textos_block(grade) and q->'gradeIds' ? grade order by (q->>'scope'='grade') desc limit 1;
    if shortlist is null then perform public.textos_fail('Falta terna publicada para '||v_area||' y '||grade||'.','PT423'); end if;
    finalids:=shortlist->'offerIds'; id:=shortlist->>'id';
   else finalids:=parent#>array['results',v_area,'tiedIds']; id:=parent#>>array['shortlistIds',v_area]; end if;
   opts:=opts||jsonb_build_object(v_area,finalids); saved:=saved||jsonb_build_object(v_area,id);
   select coalesce(jsonb_object_agg(q,0),'{}') into x from jsonb_array_elements_text(finalids) q;
   counts:=counts||jsonb_build_object(v_area,jsonb_build_object('options',x,'blank',0,'invalid',0));
  end loop;
  if s#>'{settings,rules,minimumRepresentation}'='null' then perform public.textos_fail('Dirección debe fijar la representación mínima antes de abrir rondas.','PT423'); end if;
  select count(*) into total from jsonb_array_elements(s->'sections') q where q->>'gradeId'=grade;
  min_required:=case s#>>'{settings,rules,representationMode}' when 'percentage' then ceil(total*(s#>>'{settings,rules,minimumRepresentation}')::numeric/100)::int else (s#>>'{settings,rules,minimumRepresentation}')::int end;
  entity:=jsonb_build_object('id',gen_random_uuid()::text,'version',1,'gradeId',grade,'number',n,'areas',list,'mode',coalesce(p_payload->>'mode',parent->>'mode'),'status','draft','shortlistIds',saved,'options',opts,'physicalReviewConfirmed',true,'minimumRequired',min_required,'delivered',0,'deposited',0,'counts',counts,'results','{}'::jsonb,'parentId',parent->>'id','openedAt',null,'closedAt',null,'reconciliationReason','');
  s:=public.textos_put(s,'rounds',entity); result:=entity;
 elsif p_action in ('round_open','delivery_mark','paper_tally_save','round_close','ballots_generate','round_reconcile') then
  r:=public.textos_find(s,'rounds',p_payload->>'roundId'); if r is null then perform public.textos_fail('Ronda no encontrada.','PT404'); end if;
  if p_action='round_open' then
   if r->>'status'<>'draft' or r->'physicalReviewConfirmed' is distinct from 'true'::jsonb then perform public.textos_fail('Solo puede abrir una ronda preparada y revisada.','PT423'); end if;
   for v_area in select jsonb_array_elements_text(r->'areas') loop
    shortlist:=public.textos_find(s,'shortlists',r#>>array['shortlistIds',v_area]);
    if shortlist is null or shortlist->>'status' is distinct from 'published' then perform public.textos_fail('La terna fue reabierta; prepare otra ronda.','PT423'); end if;
   end loop;
   r:=r||jsonb_build_object('status','open','openedAt',nowat);
  elsif p_action='delivery_mark' then
   if r->>'status' not in ('draft','open') then perform public.textos_fail('La ronda no recibe entregas.','PT423'); end if;
   entity:=public.textos_find(s,'sections',p_payload->>'sectionId');
   if entity is null or entity->>'gradeId'<>r->>'gradeId' or entity->'accredited' is distinct from 'true'::jsonb or nullif(trim(entity->>'accreditationEvidence'),'') is null then perform public.textos_fail('La sección debe estar acreditada para el grado representado.'); end if;
   if p_payload->'delivered' is null or p_payload->'delivered' not in ('true'::jsonb,'false'::jsonb) then perform public.textos_fail('Entrega inválida.'); end if;
   if p_payload->'delivered'='false' and ((r->>'deposited')::int>0 or exists(select 1 from public.textos_ballots q where q.dataset=p_dataset and q.round_id=r->>'id')) then perform public.textos_fail('No reduzca el padrón entregado después de generar o recibir cédulas.','PT423'); end if;
   s:=jsonb_set(s,'{deliveries}',coalesce((select jsonb_agg(q) from jsonb_array_elements(s->'deliveries') q where not(q->>'roundId'=r->>'id' and q->>'sectionId'=entity->>'id')),'[]')||jsonb_build_array(jsonb_build_object('roundId',r->>'id','sectionId',entity->>'id','delivered',p_payload->'delivered')));
   select count(*) into n from jsonb_array_elements(s->'deliveries') q where q->>'roundId'=r->>'id' and q->'delivered'='true'; r:=r||jsonb_build_object('delivered',n);
  elsif p_action='ballots_generate' then
   if r->>'mode'<>'digital' or r->>'status'<>'open' then perform public.textos_fail('Solo se generan cédulas en una ronda digital abierta.','PT423'); end if;
   select count(*) into n from public.textos_ballots q where q.dataset=p_dataset and q.round_id=r->>'id';
   count_n:=coalesce((p_payload->>'count')::int,(r->>'delivered')::int-n);
   if count_n<1 or count_n>500 or n+count_n>(r->>'delivered')::int then perform public.textos_fail('Cantidad excede las representaciones con entrega acreditada o el máximo de 500.'); end if;
   for v in 1..count_n loop code:=public.textos_code(); insert into public.textos_ballots(code_hash,dataset,round_id) values(public.textos_hash(code),p_dataset,r->>'id'); codes:=codes||jsonb_build_array(code); end loop;
   result:=jsonb_build_object('codes',codes);
  elsif p_action='paper_tally_save' then
   if r->>'mode'<>'paper' or r->>'status'<>'open' then perform public.textos_fail('El escrutinio en papel exige su modalidad y ronda abierta.','PT423'); end if;
   if coalesce((p_payload->>'expectedVersion')::int,-1)<>(r->>'version')::int then perform public.textos_fail('El escrutinio cambió en otra sesión.','PT409'); end if;
   if not public.textos_int(p_payload->'deposited') or (p_payload->>'deposited')::int>(r->>'delivered')::int then perform public.textos_fail('Las cédulas depositadas exceden las entregadas.'); end if;
   counts:=p_payload->'counts';
   if exists(select 1 from jsonb_object_keys(counts) q where not(r->'areas' ? q)) then perform public.textos_fail('El escrutinio incluye un área ajena a esta ronda.'); end if;
   for v_area in select jsonb_array_elements_text(r->'areas') loop
    x:=counts->v_area;
    if jsonb_typeof(x->'options') is distinct from 'object' or not public.textos_int(x->'blank') or not public.textos_int(x->'invalid') then perform public.textos_fail('Blancos, nulos y opciones requieren enteros no negativos.'); end if;
    if (select count(*) from jsonb_each(x->'options'))<>jsonb_array_length(r#>array['options',v_area]) then perform public.textos_fail('Incluya exactamente todas las opciones de la cédula.'); end if;
    total:=(x->>'blank')::int+(x->>'invalid')::int;
    for rowrec in select key,value from jsonb_each(x->'options') loop
     if not(r#>array['options',v_area] ? rowrec.key) or not public.textos_int(rowrec.value) then perform public.textos_fail('Opción o cantidad del escrutinio inválida.'); end if;
     total:=total+rowrec.value::text::int;
    end loop;
    if total<>(p_payload->>'deposited')::int then perform public.textos_fail('No concilian opciones, blancos y nulos con las cédulas depositadas.'); end if;
   end loop;
   r:=r||jsonb_build_object('deposited',p_payload->'deposited','counts',counts);
  elsif p_action='round_close' then
   if r->>'status'<>'open' then perform public.textos_fail('La ronda no está abierta.','PT423'); end if;
   if r->>'mode'='digital' then
    counts:='{}';
    for v_area in select jsonb_array_elements_text(r->'areas') loop
     select coalesce(jsonb_object_agg(q,coalesce(ag.votes,0)),'{}') into opts from jsonb_array_elements_text(r#>array['options',v_area]) q left join public.textos_aggregates ag on ag.dataset=p_dataset and ag.round_id=r->>'id' and ag.area=v_area and ag.option_id=q;
     select coalesce(sum(ag.votes),0) into n from public.textos_aggregates ag where ag.dataset=p_dataset and ag.round_id=r->>'id' and ag.area=v_area and ag.option_id='__blank__';
     counts:=counts||jsonb_build_object(v_area,jsonb_build_object('options',opts,'blank',n,'invalid',0));
    end loop; r:=jsonb_set(r,'{counts}',counts);
   end if;
   result:='{}'; for v_area in select jsonb_array_elements_text(r->'areas') loop result:=result||jsonb_build_object(v_area,public.textos_round_result(r,v_area)); end loop;
   r:=r||jsonb_build_object('status','closed','closedAt',nowat,'results',result);
  else
   if r->>'status'<>'suspended' or p_payload->>'action'<>'void-and-restart' or nullif(trim(reason),'') is null then perform public.textos_fail('Conciliación requiere ronda suspendida, motivo y anulación documentada.'); end if;
   r:=r||jsonb_build_object('status','void','reconciliationReason',reason);
   entity:=r||jsonb_build_object('id',gen_random_uuid()::text,'version',1,'status','draft','parentId',case when (r->>'number')::int=2 then r->>'parentId' else r->>'id' end,'deposited',0,'delivered',0,'results','{}'::jsonb,'openedAt',null,'closedAt',null);
   counts:='{}'; for v_area in select jsonb_array_elements_text(r->'areas') loop select jsonb_object_agg(q,0) into opts from jsonb_array_elements_text(r#>array['options',v_area]) q; counts:=counts||jsonb_build_object(v_area,jsonb_build_object('options',opts,'blank',0,'invalid',0)); end loop;
   entity:=jsonb_set(entity,'{counts}',counts); s:=public.textos_put(s,'rounds',entity); result:=entity;
  end if;
  r:=r||jsonb_build_object('version',(r->>'version')::int+1); s:=public.textos_put(s,'rounds',r);
  if p_action not in ('ballots_generate','round_reconcile') then result:=r; end if;
 elsif p_action in ('import_preview','import_apply') then
  if p_action='import_preview' then
   begin
    saved:=public.textos_import(s,p_payload->>'kind',p_payload->'rows');
    return jsonb_build_object('valid',true,'errors','[]'::jsonb,'warnings','[]'::jsonb,'rows',p_payload->'rows');
   exception when others then return jsonb_build_object('valid',false,'errors',jsonb_build_array(jsonb_build_object('row',0,'field','','message',sqlerrm)),'warnings','[]'::jsonb,'rows',p_payload->'rows'); end;
  end if;
  if p_payload->'confirmed' is distinct from 'true'::jsonb then perform public.textos_fail('Confirme la previsualización antes de importar.'); end if;
  s:=public.textos_import(s,p_payload->>'kind',p_payload->'rows'); result:=jsonb_build_object('imported',jsonb_array_length(p_payload->'rows'));
 elsif p_action='backup_get' then
  return jsonb_build_object('format','textos-backup-v1','dataset',p_dataset,'createdAt',nowat,'state',s,'history',coalesce((select jsonb_agg(to_jsonb(q)) from public.textos_history q where q.dataset=p_dataset),'[]'),'ballots',coalesce((select jsonb_agg(to_jsonb(q)) from public.textos_ballots q where q.dataset=p_dataset),'[]'),'aggregates',coalesce((select jsonb_agg(to_jsonb(q)) from public.textos_aggregates q where q.dataset=p_dataset),'[]'),'paperTokens',coalesce((select jsonb_agg(to_jsonb(q)) from public.textos_paper_tokens q where q.dataset=p_dataset),'[]'),'photoEvidenceExportSeparate',true,'photoEvidenceManifest',coalesce((select jsonb_agg(jsonb_build_object('id',q.id,'pollId',q.poll_id,'classroomId',q.classroom_id,'filename',q.filename,'mimeType',q.mime_type,'bytes',octet_length(q.content),'createdAt',q.created_at)) from public.textos_paper_evidence q where q.dataset=p_dataset),'[]'));
 elsif p_action in ('restore_preview','restore_apply') then
  backup:=p_payload->'backup'; saved:=public.textos_upgrade_legacy(backup->'state');
  if backup->>'format' is distinct from 'textos-backup-v1' or backup->>'dataset' is distinct from p_dataset then perform public.textos_fail('Respaldo incompatible o de otra jornada.'); end if;
  perform public.textos_validate_state(saved);
  perform public.textos_paper_restore_prepare(s,saved,p_dataset,coalesce(backup->'paperTokens','[]'),false);
  if jsonb_typeof(backup->'ballots') is distinct from 'array' or jsonb_typeof(backup->'aggregates') is distinct from 'array' then perform public.textos_fail('Respaldo sin consumo y conteos.'); end if;
  list:='[]';
  for r in select value from jsonb_array_elements(s->'rounds') loop
   x:=public.textos_find(saved,'rounds',r->>'id');
   if exists(select 1 from public.textos_ballots q where q.dataset=p_dataset and q.round_id=r->>'id' and q.consumed and not exists(select 1 from jsonb_array_elements(backup->'ballots') q2 where q2->>'code_hash'=q.code_hash and q2->'consumed'='true')) or (r->>'deposited')::int>coalesce((x->>'deposited')::int,0) or (r->>'status'='closed' and x->>'status' is distinct from 'closed') or ((r->>'deposited')::int>0 and exists(select 1 from public.textos_aggregates ag where ag.dataset=p_dataset and ag.round_id=r->>'id' and not exists(select 1 from jsonb_array_elements(backup->'aggregates') ba where ba->>'round_id'=ag.round_id and ba->>'area'=ag.area and ba->>'option_id'=ag.option_id and ba->>'votes'=ag.votes::text))) then list:=list||jsonb_build_array(r->>'id'); end if;
  end loop;
  -- A fresh real installation cannot know which codes were consumed after this
  -- backup. Imported active rounds need reconciliation before any new voting.
  if p_dataset='real' then
   for r in select value from jsonb_array_elements(saved->'rounds') loop
    if r->>'status' in ('draft','open') and public.textos_find(s,'rounds',r->>'id') is null then list:=list||jsonb_build_array(r->>'id'); end if;
   end loop;
  end if;
  if p_action='restore_preview' then return jsonb_build_object('valid',true,'dataset',p_dataset,'version',saved->'version','suspendedRoundIds',list,'books',jsonb_array_length(saved->'books'),'evaluations',jsonb_array_length(saved->'evaluations'),'rounds',jsonb_array_length(saved->'rounds')); end if;
  if p_payload->>'confirmation' is distinct from 'RESTAURAR' or nullif(trim(reason),'') is null then perform public.textos_fail('Restauración requiere confirmación RESTAURAR y motivo.'); end if;
  perform public.textos_paper_restore_prepare(s,saved,p_dataset,coalesce(backup->'paperTokens','[]'),true);
  for x in select value from jsonb_array_elements(coalesce(backup#>'{state,evaluations}','[]')) where jsonb_array_length(value->'scores')=8 loop insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,'evaluations',x->>'id',actor_name,'Migración de ocho indicadores: I9 e I10 quedan pendientes',x); end loop;
  -- Keep incoming old live rubric originals before metadata-only scale migration.
  for x in select value from jsonb_array_elements(coalesce(backup#>'{state,presentationEvaluations}','[]')) loop
   if public.textos_find(saved,'presentationEvaluations',x->>'id') is distinct from x then insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,'presentationEvaluations',x->>'id',actor_name,'Restauración de escala histórica 0–2 sin conversión numérica',x); end if;
  end loop;
  for x in select value from jsonb_array_elements(coalesce(backup#>'{state,presentationShortlists}','[]')) loop
   if public.textos_find(saved,'presentationShortlists',x->>'id') is distinct from x then insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,'presentationShortlists',x->>'id',actor_name,'Restauración de publicación histórica con su escala original',x); end if;
  end loop;
  -- Keep a complete pre-restore history; access credentials are never imported.
  insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,'restore',p_dataset,actor_name,reason,s);
  for id in select jsonb_array_elements_text(list) loop
   r:=public.textos_find(s,'rounds',id); x:=coalesce(public.textos_find(saved,'rounds',id),r);
   x:=x||jsonb_build_object('status','suspended','reconciliationReason',case when r is null then 'Ronda real importada sin historial local de consumo: requiere conciliación.' else 'Restauración anterior a votos conocidos: requiere conciliación.' end,'version',greatest(coalesce((r->>'version')::int,0),(x->>'version')::int)+1);
   saved:=public.textos_put(saved,'rounds',x);
  end loop;
  -- Only non-divergent rounds may replace their aggregate snapshot.
  delete from public.textos_aggregates q where q.dataset=p_dataset and not(list ? q.round_id);
  for x in select value from jsonb_array_elements(backup->'aggregates') loop
   if x->>'dataset'<>p_dataset or not public.textos_int(x->'votes') or public.textos_find(saved,'rounds',x->>'round_id') is null then perform public.textos_fail('Agregado de respaldo inválido.'); end if;
   if not(list ? (x->>'round_id')) or public.textos_find(s,'rounds',x->>'round_id') is null then insert into public.textos_aggregates(dataset,round_id,area,option_id,votes) values(p_dataset,x->>'round_id',x->>'area',x->>'option_id',(x->>'votes')::int) on conflict(dataset,round_id,area,option_id) do update set votes=excluded.votes; end if;
  end loop;
  for x in select value from jsonb_array_elements(backup->'ballots') loop
   if x->>'dataset'<>p_dataset or x->>'code_hash' !~ '^[a-f0-9]{64}$' or public.textos_find(saved,'rounds',x->>'round_id') is null then perform public.textos_fail('Autorización de respaldo inválida.'); end if;
   insert into public.textos_ballots(code_hash,dataset,round_id,consumed) values(x->>'code_hash',p_dataset,x->>'round_id',(x->>'consumed')::boolean) on conflict(code_hash) do update set consumed=textos_ballots.consumed or excluded.consumed;
  end loop;
  for x in select value from jsonb_array_elements(coalesce(backup->'history','[]'::jsonb)) loop
   if x->>'dataset'<>p_dataset or jsonb_typeof(x->'previous') is distinct from 'object' then perform public.textos_fail('Historial de respaldo inválido.'); end if;
   if not exists(select 1 from public.textos_history h where h.dataset=p_dataset and h.entity=x->>'entity' and h.reference_id=x->>'reference_id' and h.previous=x->'previous') then insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous,at) values(p_dataset,x->>'entity',x->>'reference_id',x->>'actor',x->>'reason',x->'previous',(x->>'at')::timestamptz); end if;
  end loop;
  s:=saved; result:=jsonb_build_object('restored',true,'suspendedRoundIds',list); is_restore:=true;
 elsif p_action='demo_reset' then
  if p_dataset<>'demo' then perform public.textos_fail('Solo se puede reiniciar la demostración ficticia.','PT403'); end if;
  for x in select value from jsonb_array_elements(coalesce(p_payload#>'{state,evaluations}','[]')) where jsonb_array_length(value->'scores')=8 loop insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,'evaluations',x->>'id',actor_name,'Migración de ocho indicadores: I9 e I10 quedan pendientes',x); end loop;
  saved:=public.textos_upgrade_legacy(coalesce(p_payload->'state',public.textos_empty_state())); perform public.textos_validate_state(saved);
  for x in select value from jsonb_array_elements(coalesce(p_payload#>'{state,presentationEvaluations}','[]')) loop
   if public.textos_find(saved,'presentationEvaluations',x->>'id') is distinct from x then insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,'presentationEvaluations',x->>'id',actor_name,'Migración de escala histórica sin conversión numérica',x); end if;
  end loop;
  for x in select value from jsonb_array_elements(coalesce(p_payload#>'{state,presentationShortlists}','[]')) loop
   if public.textos_find(saved,'presentationShortlists',x->>'id') is distinct from x then insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,'presentationShortlists',x->>'id',actor_name,'Migración de publicación histórica con su escala original',x); end if;
  end loop;
  s:=saved;
  delete from public.textos_paper_evidence where dataset='demo'; delete from public.textos_paper_tokens where dataset='demo'; delete from public.textos_ballots where dataset='demo'; delete from public.textos_aggregates where dataset='demo'; result:=jsonb_build_object('reset',true);
 else perform public.textos_fail('Operación desconocida.','PT404');
 end if;
 perform public.textos_validate_state(s);
 perform public.textos_paper_evidence_prune(s,p_dataset);
 -- Never put payloads, codes, choices or personally identifiable ballot data into the audit.
 s:=jsonb_set(s,'{audit}',s->'audit'||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'actor',actor_name,'action',p_action,'referenceId',coalesce(entityid,p_payload->>'assignmentId',p_payload->>'roundId',p_payload->>'shortlistId',''),'reason',reason,'at',nowat,'summary','Operación confirmada en servidor')));
 s:=jsonb_set(s,'{version}',to_jsonb((s->>'version')::int+1));
 update public.textos_datasets set state=s,updated_at=nowat where id=p_dataset;
 return result;
exception when invalid_text_representation or numeric_value_out_of_range or null_value_not_allowed or check_violation then
 raise exception using errcode='PT400',message='Tipo o valor inválido en la petición.';
end $$;

-- Preserve exact originals once, then mark legacy live scales and retire old current publications.
-- This block is also safe on fresh installations and when the whole schema is reapplied.
do $$
declare d record; upgraded jsonb; e jsonb; previous_settings jsonb; migration_at timestamptz:=clock_timestamp();
begin
 for d in select id,state from public.textos_datasets order by id for update loop
  upgraded:=public.textos_presentation_upgrade_scale(d.state);
  if upgraded is distinct from d.state then
   for e in select value from jsonb_array_elements(coalesce(d.state->'presentationEvaluations','[]')) loop
    if public.textos_find(upgraded,'presentationEvaluations',e->>'id') is distinct from e then
     insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous,at) values(d.id,'presentationEvaluations',e->>'id','Migración de escala','Escala histórica 0–2 conservada; nueva valoración 0–4 requiere intervención del docente',e,migration_at);
    end if;
   end loop;
   for e in select value from jsonb_array_elements(coalesce(d.state->'presentationShortlists','[]')) loop
    if public.textos_find(upgraded,'presentationShortlists',e->>'id') is distinct from e then
     insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous,at) values(d.id,'presentationShortlists',e->>'id','Migración de escala','Publicación histórica conservada con su escala original',e,migration_at);
    end if;
   end loop;
   if upgraded->'settings' is distinct from d.state->'settings' then
    insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous,at) values(d.id,'settings','settings','Migración de escala','Nueva escala de exposición 0–4; reglas históricas de libros conservadas',d.state->'settings',migration_at);
   end if;
   upgraded:=jsonb_set(upgraded,'{audit}',coalesce(upgraded->'audit','[]')||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'actor','Migración de escala','action','presentation_scale_upgrade','referenceId',d.id,'reason','Escala histórica conservada; nueva valoración 0–4','at',migration_at,'summary','Actualización de metadatos sin conversión numérica de fichas')));
   upgraded:=jsonb_set(upgraded,'{version}',to_jsonb((d.state->>'version')::integer+1));
   perform public.textos_validate_state(upgraded);
   update public.textos_datasets set state=upgraded,updated_at=migration_at where id=d.id;
  end if;
 end loop;
end $$;

-- Owner-only bootstrap, never executable through PostgREST.
create or replace function public.textos_bootstrap_local(dataset text default 'real') returns text language plpgsql security definer set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare code text;
begin
 if coalesce(dataset,'') not in ('real','demo') then perform public.textos_fail('Dataset inválido.'); end if;
 if exists(select 1 from public.textos_access a where a.dataset=textos_bootstrap_local.dataset and a.role='coordinator' and not a.revoked and a.expires_at>now()) then perform public.textos_fail('Ya existe coordinación local activa; conserve el código privado.','PT409'); end if;
 code:=public.textos_code(); insert into public.textos_access(dataset,code_hash,role,name,expires_at) values(dataset,public.textos_hash(code),'coordinator','Coordinación local',now()+interval '180 days'); return code;
end $$;

alter table public.textos_director_credentials enable row level security;
alter table public.textos_login_limits enable row level security;
revoke all on public.textos_director_credentials,public.textos_login_limits from public;
alter table public.textos_datasets enable row level security;
alter table public.textos_coordinators enable row level security;
alter table public.textos_access enable row level security;
alter table public.textos_ballots enable row level security;
alter table public.textos_aggregates enable row level security;
alter table public.textos_history enable row level security;
-- The RPC is the only application entry point. No PUBLIC defaults on helpers.
do $$declare o record; role_name text; begin
 for o in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'textos\_%' escape '\' loop execute format('revoke all on function %s from public',o.signature); end loop;
 foreach role_name in array array['anon','authenticated'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then
   execute format('revoke all on public.textos_datasets,public.textos_coordinators,public.textos_access,public.textos_ballots,public.textos_aggregates,public.textos_history,public.textos_director_credentials,public.textos_login_limits from %I',role_name);
   for o in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'textos\_%' escape '\' loop execute format('revoke all on function %s from %I',o.signature,role_name); end loop;
   execute format('grant execute on function public.textos_api(text,jsonb,text,text) to %I',role_name);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
