-- Local PostgreSQL only; run as owner before schema.sql. No embedded password.
begin;
do $$begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 if not exists(select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit; end if;
end $$;
grant anon,authenticated to authenticator;
grant usage on schema public to anon,authenticated;
commit;
