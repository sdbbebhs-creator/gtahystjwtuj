-- Cross-device sync setup for vocab_items / grammar_items / study_data.
-- Run once in the Supabase SQL editor (or with `supabase db push`).
-- Every statement is idempotent, so it is safe to run on a project where the
-- tables already exist.

-- 1. Tables -------------------------------------------------------------------
create table if not exists public.vocab_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at timestamp not null default now(),
  primary key (user_id, id)
);

create table if not exists public.grammar_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at timestamp not null default now(),
  primary key (user_id, id)
);

create table if not exists public.study_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  vocab jsonb not null default '[]'::jsonb,
  grammar jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- upsert(..., { onConflict: 'user_id,id' }) / { onConflict: 'user_id' } needs a
-- unique constraint on exactly those columns. These are no-ops when the primary
-- keys above already exist.
create unique index if not exists vocab_items_user_id_id_key on public.vocab_items (user_id, id);
create unique index if not exists grammar_items_user_id_id_key on public.grammar_items (user_id, id);
create unique index if not exists study_data_user_id_key on public.study_data (user_id);

-- 2. Server-side updated_at ---------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists vocab_items_set_updated_at on public.vocab_items;
create trigger vocab_items_set_updated_at
  before insert or update on public.vocab_items
  for each row execute function public.set_updated_at();

drop trigger if exists grammar_items_set_updated_at on public.grammar_items;
create trigger grammar_items_set_updated_at
  before insert or update on public.grammar_items
  for each row execute function public.set_updated_at();

drop trigger if exists study_data_set_updated_at on public.study_data;
create trigger study_data_set_updated_at
  before insert or update on public.study_data
  for each row execute function public.set_updated_at();

-- 3. Row Level Security: each user only sees / writes their own rows ----------
alter table public.vocab_items enable row level security;
alter table public.grammar_items enable row level security;
alter table public.study_data enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['vocab_items', 'grammar_items', 'study_data'] loop
    execute format('drop policy if exists "%1$s_select_own" on public.%1$I', t);
    execute format('drop policy if exists "%1$s_insert_own" on public.%1$I', t);
    execute format('drop policy if exists "%1$s_update_own" on public.%1$I', t);
    execute format('drop policy if exists "%1$s_delete_own" on public.%1$I', t);

    execute format('create policy "%1$s_select_own" on public.%1$I for select to authenticated using (auth.uid()::text = user_id::text)', t);
    execute format('create policy "%1$s_insert_own" on public.%1$I for insert to authenticated with check (auth.uid()::text = user_id::text)', t);
    execute format('create policy "%1$s_update_own" on public.%1$I for update to authenticated using (auth.uid()::text = user_id::text) with check (auth.uid()::text = user_id::text)', t);
    execute format('create policy "%1$s_delete_own" on public.%1$I for delete to authenticated using (auth.uid()::text = user_id::text)', t);
  end loop;
end;
$$;

-- 4. Realtime -----------------------------------------------------------------
-- Add the tables to the supabase_realtime publication so postgres_changes
-- events are broadcast to subscribed clients.
do $$
declare
  t text;
begin
  foreach t in array array['vocab_items', 'grammar_items', 'study_data'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
