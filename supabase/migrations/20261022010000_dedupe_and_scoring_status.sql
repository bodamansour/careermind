-- 1. De-duplicate jobs by their posting URL as well as (source, external_id).
--    url_key is the normalized URL (set by the server); generic pages such as
--    https://company.com/careers are left null so different jobs aren't merged.
alter table public.jobs add column url_key text;
alter table public.jobs add column sources text[] not null default '{}';
create unique index jobs_url_key_idx on public.jobs (url_key) where url_key is not null;
update public.jobs set sources = array[source] where sources = '{}';

-- 2. A failed score is stored as a retryable state, never replaced by another engine.
alter table public.job_matches
  add column score_status text not null default 'scored' check (score_status in ('scored', 'failed')),
  add column score_error text,
  add column origin text not null default 'job-hunter';
alter table public.job_matches
  add constraint job_matches_scored_has_score check (score_status <> 'scored' or score is not null);

-- 3. Users only see jobs that are in their own list.
drop policy "jobs readable" on public.jobs;
create policy "own jobs readable" on public.jobs for select to authenticated
  using (exists (select 1 from public.job_matches m where m.job_id = jobs.id and m.user_id = (select auth.uid())));

-- 4. CV text and profile are written by the server only.
revoke insert, delete on public.profiles from authenticated, anon;
revoke all on public.jobs, public.job_matches, public.analyses from anon;
