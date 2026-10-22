# Job Hunter 🔎

> Part of [CareerMind](../../README.md): the candidate-side automation.

An n8n workflow that searches for entry-level tech jobs every morning, scores each one against your CV, and sends you a daily summary on WhatsApp through the WhatsApp Business Cloud API.

Scoring is done by **CareerMind only**, against the CV saved in your CareerMind account, so the score in your WhatsApp report is the same one you see in the app's **My jobs**. See [Scoring with CareerMind](#scoring-with-careermind).

> 🇪🇬 النسخة العربية تحت.

## What it does

| Time (Africa/Cairo) | Stage | Details |
|---|---|---|
| 08:00 | **Collect** | Pulls jobs from Remotive, RemoteOK, Arbeitnow and WeWorkRemotely, plus optional Greenhouse/Lever company boards and custom RSS feeds. |
| | **Filter** | Keeps titles that match your keywords and drops senior roles. Accepts only your locations or remote roles open to your region, and only jobs posted within the last 30 days. |
| | **Deduplicate** | Stores every job in an n8n Data Table so it is never processed twice. |
| | **Score** | Each fresh job goes to CareerMind (`POST /api/hunter/jobs`), which saves it to your account and rates it 0–100 against **your CV only**, with the skills you're missing. A job that fails to score is marked `score_failed` and retried on the next run; no other engine fills in a score. |
| | **Route** | Strong matches go to a "needs manual application" list, with the apply link or the email address to send your CV to. **Nothing is sent automatically** (see [Applying](#applying-always-manual)). |
| 09:00 | **Analyse** | Shows the most requested skills across the last 30 days and the average advertised salary. The average is grouped by currency and period and lists its sources. If fewer than 5 postings mention a salary, the report says the data is insufficient instead of guessing. |
| | **News** | Top Egypt tech / job-market headlines from the last 72 hours (Arabic + English), deduplicated. |
| | **Report** | Sends an approved WhatsApp template with the summary, then the full details as a follow-up message whenever the 24-hour chat window is open. On a busy day the job lists in the details are shortened (ending with `…`) so the message stays under WhatsApp's 4,096-character limit. |
| anytime | **Errors** | Every run and failure is logged to a `jh_runs` table, and failures trigger a WhatsApp alert. |

## Stack
- **n8n**: self-hosted, with Data Tables.
- **CareerMind** (this repo's app) for scoring, with your account and saved CV.
- **WhatsApp Business Cloud API** for the daily report.
- **Public job APIs and RSS**, plus Google News RSS.

## Setup
1. **Import** `workflow/job-hunter-all-in-one.json` into n8n (*Workflows → Import from File*).
2. **Create the three data tables** described in [`data-tables/schema.md`](data-tables/schema.md). Add one row to `jh_settings` using [`data-tables/jh_settings.csv`](data-tables/jh_settings.csv) as a template, with your CareerMind URL in `careermind_url` and your account email in `careermind_email`.
3. **Add credentials** in n8n:
   - **CareerMind API Key**: a *Header Auth* credential with name `x-api-key` and the same value as `CAREERMIND_API_KEY` on your CareerMind server.
   - **WhatsApp API**, using a permanent System User token and your WhatsApp Business Account ID. See [`docs/whatsapp-template.md`](docs/whatsapp-template.md).

   The export contains only credential *names*, never keys, so after importing, open the **CareerMind Score** and WhatsApp nodes and pick your credential.
4. **Create and approve** the `daily_job_report` template ([`docs/whatsapp-template.md`](docs/whatsapp-template.md)), and put your Phone Number ID in `wa_phone_number_id`.
5. Open *Workflow settings → Error workflow* and select **this same workflow**.
6. **Test:** run the *Test Search* trigger and check `jh_jobs` for scores. Then run the *Daily 9 AM Report* trigger and check WhatsApp.
7. **Publish** the workflow. It runs daily as long as your n8n instance is online.

### Applying (always manual)
Job Hunter never sends an application for you. Strong matches go to the "needs manual application" list in the report and appear in CareerMind's **My jobs**, where you open the posting, apply yourself and mark the job *Applied*. `auto_apply_enabled` is ignored.

The old email auto-apply branch (*Write Cover Letter → Download CV PDF → Mark Email Sent*) is still in the export but **disabled**, and it was never complete: the Outlook node that would send the email (**Create Application Email**) is missing. Re-enabling it would need that node, a Microsoft OAuth2 credential, and a step where you approve each email before it is sent. **Check Outlook Replies** and **Email Error Alert** are also disabled.

## Scoring with CareerMind
1. Deploy CareerMind with accounts on (see the [main README](../../README.md#my-jobs-accounts)) and set `CAREERMIND_API_KEY` on it.
2. Sign up in the app and upload your CV under **My jobs**.
3. In n8n, create the **CareerMind API Key** credential (Header Auth, name `x-api-key`) and pick it in the **CareerMind Score** node.
4. In `jh_settings`, set `careermind_url` to your app URL and `careermind_email` to your account email.

Each job is sent on its own (`report_for` = your email). CareerMind de-duplicates it by source id and posting URL, scores it, and links it to your account only. If a call fails, the job is marked `score_failed` and retried next run; if every call in a run fails (wrong key, no account, no CV, CareerMind down), the run stops and the error alert says why. Without `careermind_url` and `careermind_email` the run stops with a clear error instead of scoring some other way.

## Customize the scoring
Scoring uses the CareerMind agents' prompts (`career-mind-app/backend/services/prompts.js`) and the CV in your account. A role counts as the right level unless the Job Analyzer finds it is mid/senior/lead or needs 2+ years; the keyword, location and salary filters come from `jh_settings`.

## Check the files
```bash
node --test tests/*.test.mjs   # Node.js 21 or newer
```
- `tests/workflow.test.mjs` checks that every connection and every `$('Node')` reference points to a real node, that the export has no credential IDs or hard-coded emails/phone numbers, that every setting the workflow reads is in `jh_settings.csv`, and that every column it writes is documented in `data-tables/schema.md`.
- `tests/code-nodes.test.mjs` runs the Code nodes from the export with sample jobs: filtering by title, level, location and age, de-duplication, salary and apply-email parsing, the scoring queue, CareerMind replies (including failed calls), the manual-only routing, the report's salary and skills rules, the WhatsApp length limits, and reply matching.

Run them after re-exporting the workflow. GitHub Actions runs them on every pull request and push to `main`.

## Design principles
- **No invented experience.** Scoring is grounded strictly in your CV.
- **One scorer.** CareerMind is the only source of scores; a failure is shown as a failure, never replaced.
- **You apply.** Nothing is sent to an employer without you.
- **No fake numbers.** Salary averages show their sample size, currency and period, or say the data is insufficient.
- **"Applied" means confirmed.** A job is marked `applied_confirmed` only after a real reply from the employer.
- **Secrets stay in n8n Credentials.** None are stored in the workflow JSON.

---

## 🇪🇬 بالعربي

Workflow على n8n بيدوّر كل يوم الصبح على وظائف تقنية للمبتدئين والمتدربين. بيقيّم كل وظيفة على أساس الـCV بتاعك ويبعتلك ملخص يومي على واتساب. التقييم بيتم بـ CareerMind بس (لازم `careermind_url` و `careermind_email`)، فالدرجة اللي في واتساب هي نفسها اللي في صفحة **My jobs** في الموقع. لو التقييم فشل، الوظيفة بتتعلّم `score_failed` وبتتعاد المحاولة في التشغيل اللي بعده، ومفيش أي محرك تاني بيحط درجة بداله. ومفيش تقديم تلقائي: انت اللي بتقدّم بنفسك.

**المراحل:**
- **الساعة 8**:
  - يجمع الوظائف من مواقع عالمية مجانية.
  - يفلترها بالمسمى والمكان ويستبعد الـSenior.
  - يمنع التكرار.
  - يقيّم كل وظيفة من 0 لـ100 بناءً على الـCV بس، ومعاها سبب مختصر.
- **الساعة 9**:
  - يحلل المهارات الأكثر طلبًا ومتوسط الرواتب في آخر 30 يوم. لو البيانات قليلة بيقول كده صراحة.
  - يجمع أهم أخبار سوق العمل والتقنية في مصر خلال آخر 72 ساعة.
  - يبعت التقرير على واتساب بقالب معتمد.
- **أي وقت**: أي خطأ بيتسجل، ويوصلك تنبيه بيه على واتساب.

**التقديم:** يدوي دايمًا. الـ Job Hunter مش بيبعت أي طلب توظيف لوحده، وإعداد `auto_apply_enabled` بيتجاهل. الوظايف القوية بتظهر في قايمة "محتاجة تقديم يدوي" وفي صفحة My jobs، وانت بتقدّم وتعلّم عليها Applied. فرع الإيميل القديم موجود في الملف بس متعطّل، وعمره ما كان مكتمل لأن node الـ Outlook مش موجودة.

**التشغيل:** اتبع خطوات Setup اللي فوق: استورد الملف، واعمل الجداول، واربط CareerMind وواتساب، واعمل القالب، وجرّب، وبعدين انشر.

## License
MIT
