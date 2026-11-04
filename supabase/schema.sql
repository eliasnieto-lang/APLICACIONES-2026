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
select jsonb_build_object('schemaVersion',1,'version',1,'settings',jsonb_build_object('version',1,'school','I.E.P. Albert Einstein','title','Selección de textos escolares 2027','eventAt','2026-11-05T17:00:00-05:00','timezone','America/Lima','venue','Sede 2, Jr. Augusto B. Leguía N.º 246, Nicrupampa','organizers','Subdirección Académica','editorsWithdrawn',false,'withdrawalReference','','directorName','','rules',jsonb_build_object('version',1,'threshold',70,'teacherCount',2,'indicatorCount',10,'presentationSeconds',600,'transitionSeconds',120,'representationMode','count','minimumRepresentation',null,'practiceGuidelines','{}'::jsonb,'lockedAt',null)),'publishers','[]'::jsonb,'series','[]'::jsonb,'offers','[]'::jsonb,'books','[]'::jsonb,'teachers','[]'::jsonb,'assignments','[]'::jsonb,'evaluations','[]'::jsonb,'reviews','[]'::jsonb,'turn',jsonb_build_object('publisherId',null,'status','ready','startedAt',null,'pausedAt',null,'pausedMilliseconds',0),'shortlists','[]'::jsonb,'sections','[]'::jsonb,'deliveries','[]'::jsonb,'rounds','[]'::jsonb,'incidents','[]'::jsonb,'audit','[]'::jsonb)
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

end $$;

create or replace function public.textos_public_state(s jsonb) returns jsonb language plpgsql stable set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare outstate jsonb:=public.textos_empty_state(); sl jsonb; ids jsonb; r jsonb; k text;
begin
 outstate:=jsonb_set(outstate,'{version}',s->'version');
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
 return outstate;
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
   if p is null then p:=jsonb_build_object('id',gen_random_uuid()::text,'version',1,'name',r->>'publisher','samplesReceived',false,'sampleNote',''); s:=public.textos_put(s,'publishers',p); end if;
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

create or replace function public.textos_upgrade_legacy(s jsonb) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare e jsonb;
begin
 for e in select value from jsonb_array_elements(coalesce(s->'evaluations','[]')) loop
  if jsonb_typeof(e->'scores')='array' and jsonb_array_length(e->'scores')=8 then
   e:=e||jsonb_build_object('scores',e->'scores'||'[null,null]'::jsonb,'evidence',coalesce(e->'evidence','["","","","","","","",""]'::jsonb)||'["",""]'::jsonb,'notes',coalesce(e->'notes','["","","","","","","",""]'::jsonb)||'["",""]'::jsonb,'status','draft','closedAt',null,'legacyIndicatorCount',8);
   s:=public.textos_put(s,'evaluations',e);
  end if;
 end loop; return s;
end $$;

create or replace function public.textos_api(p_action text, p_payload jsonb default '{}'::jsonb, p_code text default null, p_dataset text default 'real') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare
 s jsonb; result jsonb; actor_role text; actor_id text; actor_name text; uid uuid;
 a public.textos_access%rowtype; ballot public.textos_ballots%rowtype;
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
 if p_action='snapshot' then
  if actor_role='teacher' then
   s:=jsonb_set(s,'{evaluations}',coalesce((select jsonb_agg(q) from jsonb_array_elements(s->'evaluations') q where q->>'teacherId'=actor_id),'[]'));
   s:=jsonb_set(s,'{assignments}',coalesce((select jsonb_agg(q) from jsonb_array_elements(s->'assignments') q where q->>'teacherId'=actor_id),'[]'));
   s:=jsonb_set(s,'{books}',coalesce((select jsonb_agg(q) from jsonb_array_elements(s->'books') q where exists(select 1 from jsonb_array_elements(s->'assignments') asn where asn->>'bookId'=q->>'id')),'[]'));
   s:=jsonb_set(s,'{teachers}',coalesce((select jsonb_agg(q) from jsonb_array_elements(s->'teachers') q where q->>'id'=actor_id),'[]'));
   foreach k in array array['shortlists','sections','deliveries','rounds','incidents','audit'] loop s:=jsonb_set(s,array[k],'[]'); end loop;
  elsif actor_role='secretary' then foreach k in array array['evaluations','assignments','reviews'] loop s:=jsonb_set(s,array[k],'[]'); end loop; end if;
  return jsonb_build_object('state',s,'actor',jsonb_build_object('id',actor_id,'name',actor_name,'role',actor_role),'serverNow',nowat,'dataset',p_dataset);
 end if;
 if actor_role='teacher' and p_action not in ('evaluation_save','evaluation_close') then perform public.textos_fail('Operación reservada a coordinación o mesa.','PT403'); end if;
 if actor_role='secretary' and p_action not in ('publisher_save','series_save','offer_save','book_save','teacher_save','section_save','attendance_save','delivery_mark','paper_tally_save','incident_save','import_preview','import_apply') then perform public.textos_fail('Operación reservada a coordinación.','PT403'); end if;
 reason:=coalesce(p_payload->>'reason',p_payload->>'reopenReason','');
 if p_action in ('publisher_save','series_save','offer_save','book_save','teacher_save','assignment_save','section_save','incident_save') then
  keyname:=split_part(p_action,'_',1); col:=case keyname when 'publisher' then 'publishers' when 'series' then 'series' when 'offer' then 'offers' when 'book' then 'books' when 'teacher' then 'teachers' when 'assignment' then 'assignments' when 'section' then 'sections' else 'incidents' end;
  entity:=p_payload->keyname;
  if jsonb_typeof(entity) is distinct from 'object' then perform public.textos_fail('Entidad requerida.'); end if;
  entityid:=nullif(entity->>'id',''); old:=public.textos_find(s,col,entityid);
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
  old:=s->'settings'; entity:=p_payload->'settings';
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
  return jsonb_build_object('format','textos-backup-v1','dataset',p_dataset,'createdAt',nowat,'state',s,'history',coalesce((select jsonb_agg(to_jsonb(q)) from public.textos_history q where q.dataset=p_dataset),'[]'),'ballots',coalesce((select jsonb_agg(to_jsonb(q)) from public.textos_ballots q where q.dataset=p_dataset),'[]'),'aggregates',coalesce((select jsonb_agg(to_jsonb(q)) from public.textos_aggregates q where q.dataset=p_dataset),'[]'));
 elsif p_action in ('restore_preview','restore_apply') then
  backup:=p_payload->'backup'; saved:=public.textos_upgrade_legacy(backup->'state');
  if backup->>'format' is distinct from 'textos-backup-v1' or backup->>'dataset' is distinct from p_dataset then perform public.textos_fail('Respaldo incompatible o de otra jornada.'); end if;
  perform public.textos_validate_state(saved);
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
  for x in select value from jsonb_array_elements(coalesce(backup#>'{state,evaluations}','[]')) where jsonb_array_length(value->'scores')=8 loop insert into public.textos_history(dataset,entity,reference_id,actor,reason,previous) values(p_dataset,'evaluations',x->>'id',actor_name,'Migración de ocho indicadores: I9 e I10 quedan pendientes',x); end loop;
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
  s:=public.textos_upgrade_legacy(coalesce(p_payload->'state',public.textos_empty_state())); perform public.textos_validate_state(s);
  delete from public.textos_ballots where dataset='demo'; delete from public.textos_aggregates where dataset='demo'; result:=jsonb_build_object('reset',true);
 else perform public.textos_fail('Operación desconocida.','PT404');
 end if;
 perform public.textos_validate_state(s);
 -- Never put payloads, codes, choices or personally identifiable ballot data into the audit.
 s:=jsonb_set(s,'{audit}',s->'audit'||jsonb_build_array(jsonb_build_object('id',gen_random_uuid()::text,'actor',actor_name,'action',p_action,'referenceId',coalesce(entityid,p_payload->>'assignmentId',p_payload->>'roundId',p_payload->>'shortlistId',''),'reason',reason,'at',nowat,'summary','Operación confirmada en servidor')));
 s:=jsonb_set(s,'{version}',to_jsonb((s->>'version')::int+1));
 update public.textos_datasets set state=s,updated_at=nowat where id=p_dataset;
 return result;
exception when invalid_text_representation or numeric_value_out_of_range or null_value_not_allowed or check_violation then
 raise exception using errcode='PT400',message='Tipo o valor inválido en la petición.';
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
   execute format('revoke all on public.textos_datasets,public.textos_coordinators,public.textos_access,public.textos_ballots,public.textos_aggregates,public.textos_history from %I',role_name);
   for o in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'textos\_%' escape '\' loop execute format('revoke all on function %s from %I',o.signature,role_name); end loop;
   execute format('grant execute on function public.textos_api(text,jsonb,text,text) to %I',role_name);
  end if;
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
