-- CareerMind accounts: profiles (CV), shared job pool, per-user matches, saved analyses.
-- Apply in the Supabase SQL editor, or with `supabase db push`.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  cv_text text,
  cv_profile jsonb,
  cv_updated_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index profiles_email_idx on public.profiles (lower(email));

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  external_id text not null,
  url text,
  title text not null,
  company text,
  location text,
  description text,
  salary text,
  apply_email text,
  posted_at timestamptz,
  analysis jsonb,
  created_at timestamptz not null default now(),
  unique (source, external_id)
);
create index jobs_created_at_idx on public.jobs (created_at desc);

create table public.job_matches (
  user_id uuid not null references public.profiles(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  score smallint check (score between 0 and 100),
  matching_skills text[] not null default '{}',
  partial_match_skills text[] not null default '{}',
  missing_skills text[] not null default '{}',
  summary text,
  status text not null default 'new' check (status in ('new','saved','applied','hidden')),
  scored_at timestamptz not null default now(),
  primary key (user_id, job_id)
);
create index job_matches_user_score_idx on public.job_matches (user_id, score desc);
create index job_matches_job_idx on public.job_matches (job_id);

create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  job_title text,
  match_score smallint,
  result jsonb not null,
  interview jsonb,
  created_at timestamptz not null default now()
);
create index analyses_user_idx on public.analyses (user_id, created_at desc);
create index analyses_job_idx on public.analyses (job_id);

-- The server uses the secret key (bypasses RLS). These policies only matter
-- for direct browser access with the publishable key.
alter table public.profiles enable row level security;
alter table public.jobs enable row level security;
alter table public.job_matches enable row level security;
alter table public.analyses enable row level security;

create policy "own profile read" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "own profile update" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy "jobs readable" on public.jobs for select to authenticated using (true);
create policy "own matches read" on public.job_matches for select to authenticated using ((select auth.uid()) = user_id);
create policy "own matches update" on public.job_matches for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own analyses read" on public.analyses for select to authenticated using ((select auth.uid()) = user_id);
create policy "own analyses delete" on public.analyses for delete to authenticated using ((select auth.uid()) = user_id);

revoke update on public.job_matches from authenticated;
grant update (status) on public.job_matches to authenticated;
revoke update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

-- A profile row for every new user
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, new.raw_user_meta_data ->> 'full_name', new.email);
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
