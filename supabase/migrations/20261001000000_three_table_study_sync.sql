-- VocabBank: canonical 3-table cloud persistence + atomic JSONB study updates.
-- vocab_items / grammar_items = content only.
-- study_data = all learning state: FSRS, progress, settings, history.

alter table public.study_data
  add column if not exists progress jsonb not null default '{}'::jsonb,
  add column if not exists settings jsonb not null default '{}'::jsonb,
  add column if not exists history jsonb not null default '[]'::jsonb;

alter table public.study_data alter column vocab set default '{}'::jsonb;
alter table public.study_data alter column grammar set default '{}'::jsonb;

-- DELETE realtime payloads must include user_id so clients never process another user's row.
alter table public.vocab_items replica identity full;
alter table public.grammar_items replica identity full;
alter table public.study_data replica identity full;

-- Atomic single-card FSRS update. Different devices updating different cards do not
-- read-modify-write the whole map in the browser, so one review cannot erase another.
create or replace function public.upsert_study_entry(p_kind text, p_item_id text, p_entry jsonb)
returns void
language plpgsql
security invoker
as $$
declare
  uid uuid := auth.uid();
  column_name text := case when p_kind = 'vocab' then 'vocab' when p_kind = 'grammar' then 'grammar' else null end;
begin
  if uid is null then raise exception 'Not authenticated'; end if;
  if column_name is null then raise exception 'Invalid study kind'; end if;

  insert into public.study_data(user_id, vocab, grammar)
  values (uid, '{}'::jsonb, '{}'::jsonb)
  on conflict (user_id) do nothing;

  if column_name = 'vocab' then
    update public.study_data
    set vocab = jsonb_set(coalesce(vocab, '{}'::jsonb), array[p_item_id], p_entry, true)
    where user_id = uid;
  else
    update public.study_data
    set grammar = jsonb_set(coalesce(grammar, '{}'::jsonb), array[p_item_id], p_entry, true)
    where user_id = uid;
  end if;
end;
$$;

create or replace function public.remove_study_entry(p_kind text, p_item_id text)
returns void
language plpgsql
security invoker
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Not authenticated'; end if;
  if p_kind = 'vocab' then
    update public.study_data set vocab = coalesce(vocab, '{}'::jsonb) - p_item_id where user_id = uid;
  elsif p_kind = 'grammar' then
    update public.study_data set grammar = coalesce(grammar, '{}'::jsonb) - p_item_id where user_id = uid;
  else
    raise exception 'Invalid study kind';
  end if;
end;
$$;

-- Realtime remains enabled for exactly the three canonical tables.
do $$
declare t text;
begin
  foreach t in array array['vocab_items','grammar_items','study_data'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- Merge progress/settings as latest snapshot while UNION-merging review history,
-- so two devices cannot erase each other's review logs.
create or replace function public.merge_study_meta(p_progress jsonb, p_settings jsonb, p_history jsonb)
returns void
language plpgsql
security invoker
as $$
declare
  uid uuid := auth.uid();
  merged_history jsonb;
begin
  if uid is null then raise exception 'Not authenticated'; end if;

  insert into public.study_data(user_id, vocab, grammar, progress, settings, history)
  values (uid, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb)
  on conflict (user_id) do nothing;

  select coalesce(jsonb_agg(value order by value->>'timestamp'), '[]'::jsonb)
    into merged_history
  from (
    select value
    from jsonb_array_elements(
      coalesce((select history from public.study_data where user_id = uid), '[]'::jsonb)
      || coalesce(p_history, '[]'::jsonb)
    ) as value
    group by value
  ) deduped;

  update public.study_data
  set progress = coalesce(p_progress, progress),
      settings = coalesce(p_settings, settings),
      history = merged_history
  where user_id = uid;
end;
$$;
