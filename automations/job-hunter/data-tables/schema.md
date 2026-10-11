# Data tables

Create these three tables in n8n (**Overview → Data tables → Create**) with exactly these column names and types. The workflow reads the **newest** row of `jh_settings`, so to change a setting you can add a new row.

## jh_settings
| column | type | notes |
|---|---|---|
| target_keywords | string | comma-separated words that must appear in the job title |
| exclude_keywords | string | comma-separated words that drop a job (e.g. senior) |
| locations | string | accepted cities/countries |
| remote_regions | string | accepted remote regions |
| remote_ok | boolean | accept remote jobs |
| min_salary | number | 0 = no minimum |
| min_salary_currency | string | e.g. EGP |
| min_salary_period | string | month / year / hour |
| hours_window | number | a job counts as new if posted within this many hours |
| max_daily_applications | number | cap for auto-apply |
| auto_apply_threshold | number | score needed to apply (0-100) |
| report_min_score | number | minimum score to show in the report |
| auto_apply_enabled | boolean | keep false unless email sending is configured |
| cv_text | string | plain-text CV — the only source used for scoring |
| cv_pdf_url | string | direct link to the CV PDF (for email applications) |
| applicant_name / applicant_email / applicant_phone | string | used to sign cover letters |
| whatsapp_to | string | your number, international format without + |
| wa_phone_number_id | string | WhatsApp Cloud API phone number ID |
| wa_template_name | string | approved template name (default `daily_job_report`) |
| greenhouse_boards / lever_boards | string | optional company board slugs, comma-separated |
| extra_rss_feeds | string | optional extra RSS job feeds |
| news_query_en / news_query_ar | string | Google News search queries |
| careermind_url | string | optional: your CareerMind app URL (e.g. `https://my-careermind.vercel.app`). When set, strong matches get a skill-gap check through `POST /api/match` |

## jh_jobs
`job_key` string · `dedup_key` string · `source` string · `title` string · `company` string · `location` string · `work_mode` string · `salary_min` number · `salary_max` number · `salary_currency` string · `salary_period` string · `posted_at` date · `apply_url` string · `apply_email` string · `skills` string · `is_fresh` boolean · `match_score` number · `match_reason` string · `status` string · `status_note` string · `gmail_thread_id` string · `confirmation_ref` string · `applied_at` date · `confirmed_at` date · `found_at` date · `description` string · `careermind_score` number · `skill_gaps` string

Statuses: `pending_score`, `score_failed`, `scored`, `needs_manual`, `applying`, `email_sent_awaiting_confirmation`, `applied_confirmed`, `archived_old`.

## jh_runs
`run_type` string · `workflow_name` string · `execution_id` string · `status` string · `fetched_count` number · `new_count` number · `scored_count` number · `auto_applied_count` number · `manual_count` number · `error_message` string · `report_text` string
