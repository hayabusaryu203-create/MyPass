-- MaPass: cole tudo isto no SQL Editor do Supabase e clique em Run.

-- ---------- perfis ----------
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text unique not null,
  name text not null default ''
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, lower(new.email), coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- contatos (sempre nos dois sentidos) ----------
create table public.contacts (
  owner uuid not null references public.profiles on delete cascade,
  contact uuid not null references public.profiles on delete cascade,
  primary key (owner, contact)
);

create or replace function public.add_contact(contact_email text) returns json
language plpgsql security definer set search_path = public as $$
declare other public.profiles;
begin
  if auth.uid() is null then raise exception 'Faça login primeiro'; end if;
  select * into other from public.profiles where email = lower(trim(contact_email));
  if other.id is null then raise exception 'Nenhuma conta com esse e-mail. A pessoa precisa criar uma conta no MaPass antes.'; end if;
  if other.id = auth.uid() then raise exception 'Esse é o seu próprio e-mail'; end if;
  insert into public.contacts values (auth.uid(), other.id), (other.id, auth.uid()) on conflict do nothing;
  return json_build_object('id', other.id, 'name', other.name, 'email', other.email);
end $$;

revoke execute on function public.add_contact(text) from public, anon;
grant execute on function public.add_contact(text) to authenticated;

-- ---------- padrões já tentados ----------
create table public.tried (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  pattern text not null check (pattern ~ '^[1-9](-[1-9]){3,8}$'),
  ok boolean not null default false,
  n int not null,                          -- número da tentativa
  pos double precision not null default 0, -- ordem de exibição (arrastar e soltar)
  source text,                             -- quem sugeriu, quando veio de um pedido de socorro
  created_at timestamptz not null default now(),
  unique (user_id, pattern)
);

create or replace function public.reorder_tried(ids bigint[]) returns void
language sql security invoker set search_path = public as $$
  update public.tried t set pos = x.ord
  from unnest(ids) with ordinality as x(id, ord)
  where t.id = x.id and t.user_id = auth.uid();
$$;

-- ---------- pedidos de socorro ----------
create table public.help_requests (
  id bigint generated always as identity primary key,
  requester uuid not null default auth.uid() references public.profiles on delete cascade,
  helper uuid not null references public.profiles on delete cascade,
  message text not null default '',
  status text not null default 'aberto' check (status in ('aberto', 'resolvido', 'encerrado')),
  created_at timestamptz not null default now()
);

create table public.suggestions (
  id bigint generated always as identity primary key,
  request_id bigint not null references public.help_requests on delete cascade,
  author uuid not null default auth.uid() references public.profiles on delete cascade,
  pattern text not null check (pattern ~ '^[1-9](-[1-9]){3,8}$'),
  result text check (result in ('ok', 'falhou')),
  created_at timestamptz not null default now(),
  unique (request_id, pattern)
);

-- quem pediu só pode mudar o resultado da sugestão
revoke update on public.suggestions from anon, authenticated;
grant update (result) on public.suggestions to authenticated;

-- ao responder uma sugestão, ela entra no histórico de quem pediu
create or replace function public.on_suggestion_result() returns trigger
language plpgsql security definer set search_path = public as $$
declare req public.help_requests;
begin
  if new.result is null or new.result is not distinct from old.result then return new; end if;
  select * into req from public.help_requests where id = new.request_id;
  insert into public.tried (user_id, pattern, ok, n, pos, source)
  values (
    req.requester, new.pattern, new.result = 'ok',
    coalesce((select max(n) from public.tried where user_id = req.requester), 0) + 1,
    coalesce((select min(pos) from public.tried where user_id = req.requester), 0) - 1,
    (select name from public.profiles where id = new.author)
  )
  on conflict (user_id, pattern) do update set ok = public.tried.ok or excluded.ok;
  if new.result = 'ok' then
    update public.help_requests set status = 'resolvido' where id = new.request_id;
  end if;
  return new;
end $$;

create trigger suggestion_result after update of result on public.suggestions
  for each row execute function public.on_suggestion_result();

-- ---------- regras de acesso (RLS) ----------
alter table public.profiles enable row level security;
alter table public.contacts enable row level security;
alter table public.tried enable row level security;
alter table public.help_requests enable row level security;
alter table public.suggestions enable row level security;

create policy "ver a si e aos contatos" on public.profiles for select to authenticated
  using (id = auth.uid() or exists (select 1 from public.contacts c where c.owner = auth.uid() and c.contact = profiles.id));
create policy "editar o próprio perfil" on public.profiles for update to authenticated
  using (id = auth.uid());

create policy "ver meus contatos" on public.contacts for select to authenticated
  using (owner = auth.uid());
create policy "remover contato" on public.contacts for delete to authenticated
  using (owner = auth.uid() or contact = auth.uid());

-- quem está ajudando num pedido aberto vê o histórico de quem pediu
create policy "ver tentativas" on public.tried for select to authenticated
  using (user_id = auth.uid() or exists (
    select 1 from public.help_requests r
    where r.requester = tried.user_id and r.helper = auth.uid() and r.status = 'aberto'));
create policy "criar tentativas" on public.tried for insert to authenticated with check (user_id = auth.uid());
create policy "editar tentativas" on public.tried for update to authenticated using (user_id = auth.uid());
create policy "apagar tentativas" on public.tried for delete to authenticated using (user_id = auth.uid());

create policy "ver pedidos" on public.help_requests for select to authenticated
  using (requester = auth.uid() or helper = auth.uid());
create policy "pedir socorro a um contato" on public.help_requests for insert to authenticated
  with check (requester = auth.uid() and exists (
    select 1 from public.contacts c where c.owner = auth.uid() and c.contact = helper));
create policy "atualizar meu pedido" on public.help_requests for update to authenticated
  using (requester = auth.uid());

create policy "ver sugestões" on public.suggestions for select to authenticated
  using (exists (select 1 from public.help_requests r
    where r.id = request_id and (r.requester = auth.uid() or r.helper = auth.uid())));
create policy "enviar sugestão" on public.suggestions for insert to authenticated
  with check (author = auth.uid() and exists (select 1 from public.help_requests r
    where r.id = request_id and r.helper = auth.uid() and r.status = 'aberto'));
create policy "responder sugestão" on public.suggestions for update to authenticated
  using (exists (select 1 from public.help_requests r where r.id = request_id and r.requester = auth.uid()));

-- ---------- tempo real ----------
alter publication supabase_realtime add table public.help_requests, public.suggestions, public.tried;
