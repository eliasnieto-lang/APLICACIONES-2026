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
