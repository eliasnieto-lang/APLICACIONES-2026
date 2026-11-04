-- Anonymous A5 paper ballots for the current presentation ranking.
-- This fragment is embedded in schema.sql before the owner-only RPC dispatcher.
create table if not exists public.textos_paper_tokens (
 code_hash text primary key check(code_hash ~ '^[a-f0-9]{64}$'),
 dataset text not null references public.textos_datasets(id), poll_id text not null,
 consumed boolean not null default false
);
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
 end loop;
end $$;

create or replace function public.textos_paper_action(s jsonb, p_action text, p_payload jsonb, actor_role text, actor_id text, actor_name text, p_dataset text, nowat timestamptz) returns jsonb
language plpgsql volatile set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare poll jsonb; ranking jsonb; category jsonb; ranking_options jsonb; options jsonb:='{}'; counts jsonb:='{}'; results jsonb:='{}'; tally jsonb;
 area text; chosen text; key text; expected integer; amount integer; code text; codes jsonb:='[]'; token public.textos_paper_tokens%rowtype;
 history jsonb:='[]'; result jsonb; reference_id text; reason text;
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
   if category is null or coalesce((category->>'registered')::int,0)<1 or coalesce((category->>'pending')::int,1)>0 or jsonb_typeof(category->'ranked') is distinct from 'array' or jsonb_array_length(category->'ranked')<2 then perform public.textos_fail('Se requieren al menos dos editoriales y todas las fichas cerradas en '||area||'.','PT423'); end if;
   if exists(select 1 from jsonb_array_elements(category->'ranked') q where q->'score' is null or q->'score'='null') then perform public.textos_fail('El ranking del área contiene resultados pendientes.','PT423'); end if;
   if jsonb_array_length(category->'ranked')>3 and category#>'{ranked,2,score}'=category#>'{ranked,3,score}' and category#>'{ranked,2,i2}'=category#>'{ranked,3,i2}' then perform public.textos_fail('Hay un empate en el corte del Top 3. Resuélvalo antes de preparar las fichas.','PT423'); end if;
   select coalesce(jsonb_agg(jsonb_build_object('id',q->>'publisherId','name',p->>'name') order by ord),'[]') into ranking_options from jsonb_array_elements(category->'ranked') with ordinality r(q,ord) join jsonb_array_elements(s->'publishers') p on p->>'id'=q->>'publisherId' where ord<=3;
   if jsonb_array_length(ranking_options)<2 then perform public.textos_fail('Las editoriales del ranking ya no están disponibles. Actualice el ranking.','PT409'); end if;
   options:=options||jsonb_build_object(area,ranking_options);
   counts:=counts||jsonb_build_object(area,jsonb_build_object('options',(select jsonb_object_agg(o->>'id',0) from jsonb_array_elements(ranking_options) o),'blank',0,'invalid',0));
  end loop;
  poll:=jsonb_build_object('id',gen_random_uuid()::text,'version',1,'block',p_payload->>'block','areas',p_payload->'areas','options',options,'status','open','rankingId',ranking->>'id','rankingVersion',ranking->'version','createdAt',nowat,'closedAt',null,'generated',0,'received',0,'counts',counts,'results','{}'::jsonb);
  result:=poll; reason:='Votación familiar en papel preparada desde el ranking final';
 elsif p_action in ('paper_ballots_generate','paper_scan_cast','paper_poll_close') then
  poll:=public.textos_find(s,'paperPolls',p_payload->>'pollId');
  if poll is null then perform public.textos_fail('No se encontró la votación en papel.'); end if;
  if poll->>'status' is distinct from 'open' then perform public.textos_fail('La votación en papel ya está cerrada.','PT423'); end if;
  if p_action<>'paper_scan_cast' and (not public.textos_int(p_payload->'expectedVersion') or poll->'version' is distinct from p_payload->'expectedVersion') then perform public.textos_fail('La votación cambió. Actualice antes de continuar.','PT409'); end if;
  if p_action='paper_ballots_generate' then
   if not public.textos_int(p_payload->'count') or (p_payload->>'count')::bigint not between 1 and 200 then perform public.textos_fail('Genere entre 1 y 200 fichas por lote.'); end if;
   amount:=(p_payload->>'count')::int;
   for expected in 1..amount loop
    code:=public.textos_code(); insert into public.textos_paper_tokens(code_hash,dataset,poll_id) values(public.textos_hash(code),p_dataset,poll->>'id'); codes:=codes||jsonb_build_array(code);
   end loop;
   poll:=poll||jsonb_build_object('generated',(poll->>'generated')::int+amount);
   reason:='Fichas A5 anónimas generadas';
  elsif p_action='paper_scan_cast' then
   if coalesce(p_payload->>'code','') !~ '^[a-f0-9]{64}$' then perform public.textos_fail('El código de la ficha no es válido. Vuelva a escanear el QR.'); end if;
   select q.* into token from public.textos_paper_tokens q where q.code_hash=public.textos_hash(p_payload->>'code') and q.dataset=p_dataset and q.poll_id=poll->>'id' for update;
   if not found then perform public.textos_fail('Esta ficha no fue generada para la votación seleccionada.','PT403'); end if;
   if token.consumed then perform public.textos_fail('Esta ficha ya fue contabilizada; no se suma de nuevo.','PT409'); end if;
   if jsonb_typeof(p_payload->'choices') is distinct from 'object' or (select count(*) from jsonb_object_keys(p_payload->'choices'))<>jsonb_array_length(poll->'areas') or exists(select 1 from jsonb_object_keys(p_payload->'choices') q where not(poll->'areas' ? q)) then perform public.textos_fail('Revise la lectura de todas las áreas de la ficha.'); end if;
   counts:=poll->'counts';
   for area in select jsonb_array_elements_text(poll->'areas') loop
    if not(p_payload->'choices' ? area) or jsonb_typeof(p_payload#>array['choices',area]) not in ('string','null') then perform public.textos_fail('Lectura de voto inválida.'); end if;
    chosen:=p_payload#>>array['choices',area]; tally:=counts->area;
    if chosen is null then key:='blank';
    elsif chosen='__invalid__' then key:='invalid';
    elsif exists(select 1 from jsonb_array_elements(poll#>array['options',area]) o where o->>'id'=chosen) then key:=null;
    else perform public.textos_fail('La marca corresponde a una editorial ajena a esta ficha.'); end if;
    if key is null then tally:=jsonb_set(tally,array['options',chosen],to_jsonb((tally#>>array['options',chosen])::int+1));
    else tally:=jsonb_set(tally,array[key],to_jsonb((tally->>key)::int+1)); end if;
    counts:=jsonb_set(counts,array[area],tally);
   end loop;
   update public.textos_paper_tokens set consumed=true where code_hash=token.code_hash;
   poll:=poll||jsonb_build_object('received',(poll->>'received')::int+1,'counts',counts);
   reason:='Ficha anónima contabilizada en agregados';
  else
   for area in select jsonb_array_elements_text(poll->'areas') loop results:=results||jsonb_build_object(area,public.textos_paper_result(poll,area)); end loop;
   poll:=poll||jsonb_build_object('status','closed','closedAt',nowat,'results',results);
   reason:='Recepción cerrada y resultados familiares calculados';
  end if;
  poll:=poll||jsonb_build_object('version',(poll->>'version')::int+1);
  if p_action='paper_ballots_generate' then result:=jsonb_build_object('poll',poll,'codes',codes);
  elsif p_action='paper_scan_cast' then result:=jsonb_build_object('poll',poll,'accepted',true);
  else result:=poll; end if;
 else perform public.textos_fail('Acción de papel no reconocida.');
 end if;
 reference_id:=poll->>'id';
 s:=public.textos_put(s,'paperPolls',poll);
 perform public.textos_paper_validate(s);
 -- No per-ballot history, token, code, photo or selection is returned in history/audit.
 return jsonb_build_object('state',s,'result',result,'referenceId',reference_id,'reason',reason,'history',history);
end $$;

-- Owner RPC calls this both for preview and before restore commit. No anonymous ballot can
-- become unconsumed, disappear, or move to another dataset/poll through a backup.
create or replace function public.textos_paper_restore_prepare(currentstate jsonb, savedstate jsonb, p_dataset text, paper_tokens jsonb, p_apply boolean default false) returns jsonb
language plpgsql volatile set search_path=pg_catalog,public as $$
#variable_conflict use_column
declare previous jsonb; saved jsonb; item jsonb; existing public.textos_paper_tokens%rowtype;
 area text; key text; n bigint; received bigint; count_tokens bigint; consumed_tokens bigint;
begin
 perform public.textos_paper_validate(savedstate);
 if jsonb_typeof(paper_tokens) is distinct from 'array' then perform public.textos_fail('El respaldo requiere sus códigos anónimos de papel.'); end if;
 if exists(select 1 from jsonb_array_elements(paper_tokens) q group by q->>'code_hash' having count(*)>1) then perform public.textos_fail('El respaldo repite códigos de papel.'); end if;
 for item in select value from jsonb_array_elements(paper_tokens) loop
  if jsonb_typeof(item) is distinct from 'object' or coalesce(item->>'dataset','')<>p_dataset or coalesce(item->>'code_hash','') !~ '^[a-f0-9]{64}$' or item->'consumed' is null or item->'consumed' not in ('true'::jsonb,'false'::jsonb) or public.textos_find(savedstate,'paperPolls',item->>'poll_id') is null then perform public.textos_fail('Código de respaldo ajeno, incompleto o inválido.'); end if;
  select q.* into existing from public.textos_paper_tokens q where q.code_hash=item->>'code_hash';
  if found and (existing.dataset<>p_dataset or existing.poll_id<>item->>'poll_id' or existing.consumed and item->'consumed' is distinct from 'true'::jsonb) then perform public.textos_fail('El respaldo intenta trasladar o reutilizar una ficha contabilizada.','PT409'); end if;
 end loop;
 for previous in select value from jsonb_array_elements(coalesce(currentstate->'paperPolls','[]')) loop
  if (previous->>'generated')::bigint=0 and (previous->>'received')::bigint=0 then continue; end if;
  saved:=public.textos_find(savedstate,'paperPolls',previous->>'id');
  if saved is null or (saved->>'generated')::bigint<(previous->>'generated')::bigint or (saved->>'received')::bigint<(previous->>'received')::bigint or previous->'options' is distinct from saved->'options' or previous->'areas' is distinct from saved->'areas' or previous->'block' is distinct from saved->'block' or previous->>'status'='closed' and saved->>'status'<>'closed' then perform public.textos_fail('Este respaldo retrocedería una votación en papel. Conserve la base actual y use un respaldo más reciente.','PT409'); end if;
  for area in select jsonb_array_elements_text(previous->'areas') loop
   for key in select jsonb_object_keys(previous#>array['counts',area,'options']) loop
    if (saved#>>array['counts',area,'options',key])::bigint<(previous#>>array['counts',area,'options',key])::bigint then perform public.textos_fail('El respaldo reduciría votos ya contabilizados.','PT409'); end if;
   end loop;
   if (saved#>>array['counts',area,'blank'])::bigint<(previous#>>array['counts',area,'blank'])::bigint or (saved#>>array['counts',area,'invalid'])::bigint<(previous#>>array['counts',area,'invalid'])::bigint then perform public.textos_fail('El respaldo reduciría blancos o nulos ya contabilizados.','PT409'); end if;
  end loop;
 end loop;
 if exists(select 1 from public.textos_paper_tokens q where q.dataset=p_dataset and not exists(select 1 from jsonb_array_elements(paper_tokens) b where b->>'code_hash'=q.code_hash and b->>'poll_id'=q.poll_id and (not q.consumed or b->'consumed'='true'::jsonb))) then perform public.textos_fail('El respaldo perdería códigos de papel emitidos o contabilizados.','PT409'); end if;
 for saved in select value from jsonb_array_elements(coalesce(savedstate->'paperPolls','[]')) loop
  select count(*),count(*) filter(where q->'consumed'='true'::jsonb) into count_tokens,consumed_tokens from jsonb_array_elements(paper_tokens) q where q->>'poll_id'=saved->>'id';
  if count_tokens<>(saved->>'generated')::bigint or consumed_tokens<>(saved->>'received')::bigint then perform public.textos_fail('Los códigos del respaldo no concilian con las fichas generadas y recibidas.'); end if;
  if saved->>'status'='open' and (saved->>'received')::bigint>0 and public.textos_find(currentstate,'paperPolls',saved->>'id') is null then perform public.textos_fail('Cierre esta votación en su base de origen antes de trasladarla a una instalación nueva.','PT409'); end if;
 end loop;
 if p_apply then
  for item in select value from jsonb_array_elements(paper_tokens) loop
   insert into public.textos_paper_tokens(code_hash,dataset,poll_id,consumed) values(item->>'code_hash',p_dataset,item->>'poll_id',(item->>'consumed')::boolean)
   on conflict(code_hash) do update set consumed=textos_paper_tokens.consumed or excluded.consumed;
  end loop;
 end if;
 return jsonb_build_object('state',savedstate,'blockedPollIds','[]'::jsonb);
end $$;
