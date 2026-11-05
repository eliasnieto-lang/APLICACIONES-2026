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
