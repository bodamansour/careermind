# Job Hunter 🔎

> Part of [CareerMind](../../README.md): the candidate-side automation.

An n8n workflow that searches for entry-level tech jobs every morning, scores each one against your CV with Google Gemini, and sends you a daily summary on WhatsApp through the WhatsApp Business Cloud API.

> 🇪🇬 النسخة العربية تحت.

## What it does

| Time (Africa/Cairo) | Stage | Details |
|---|---|---|
| 08:00 | **Collect** | Pulls jobs from Remotive, RemoteOK, Arbeitnow and WeWorkRemotely, plus optional Greenhouse/Lever company boards and custom RSS feeds. |
| | **Filter** | Keeps titles that match your keywords and drops senior roles. Accepts only your locations or remote roles open to your region, and only jobs posted within the last 30 days. |
| | **Deduplicate** | Stores every job in an n8n Data Table so it is never processed twice. |
| | **Score** | Gemini rates each fresh job 0–100 using **only your CV text**, plus a one-line reason in Arabic. Jobs that fail to score are retried on the next run. |
| | **Route** | Strong matches go to a "needs manual application" list, with the apply link or the email address to send your CV to. Email auto-apply is off by default and not complete yet (see [Auto-apply](#auto-apply-not-working-yet)). |
| | **Gap check** | *(optional)* For strong matches, CareerMind lists the skills you're missing (see [Skill gaps](#skill-gaps-from-careermind-optional)). |
| 09:00 | **Analyse** | Shows the most requested skills across the last 30 days and the average advertised salary. The average is grouped by currency and period and lists its sources. If fewer than 5 postings mention a salary, the report says the data is insufficient instead of guessing. |
| | **News** | Top Egypt tech / job-market headlines from the last 72 hours (Arabic + English), deduplicated. |
| | **Report** | Sends an approved WhatsApp template with the summary, then the full details as a follow-up message whenever the 24-hour chat window is open. On a busy day the job lists in the details are shortened (ending with `…`) so the message stays under WhatsApp's 4,096-character limit. |
| anytime | **Errors** | Every run and failure is logged to a `jh_runs` table, and failures trigger a WhatsApp alert. |

## Stack
- **n8n**: self-hosted, with Data Tables.
- **Google Gemini**: scoring uses `gemini-3.1-flash-lite`. Cover letters use `gemini-3-flash-preview` and are only needed for auto-apply.
- **WhatsApp Business Cloud API** for the daily report.
- **Public job APIs and RSS**, plus Google News RSS.

## Setup
1. **Import** `workflow/job-hunter-all-in-one.json` into n8n (*Workflows → Import from File*).
2. **Create the three data tables** described in [`data-tables/schema.md`](data-tables/schema.md). Add one row to `jh_settings` using [`data-tables/jh_settings.csv`](data-tables/jh_settings.csv) as a template, and paste your CV text into `cv_text`.
3. **Add credentials** in n8n:
   - **Google Gemini (PaLM) API** key from [Google AI Studio](https://aistudio.google.com/apikey).
   - **WhatsApp API**, using a permanent System User token and your WhatsApp Business Account ID. See [`docs/whatsapp-template.md`](docs/whatsapp-template.md).

   The export contains only credential *names*, never keys, so after importing, open each Gemini and WhatsApp node and pick your credential.
4. **Create and approve** the `daily_job_report` template ([`docs/whatsapp-template.md`](docs/whatsapp-template.md)), and put your Phone Number ID in `wa_phone_number_id`.
5. Open *Workflow settings → Error workflow* and select **this same workflow**.
6. **Test:** run the *Test Search* trigger and check `jh_jobs` for scores. Then run the *Daily 9 AM Report* trigger and check WhatsApp.
7. **Publish** the workflow. It runs daily as long as your n8n instance is online.

### Auto-apply (not working yet)
Keep `auto_apply_enabled = false`. The export is missing the Outlook node that sends the application email (**Create Application Email**). The auto-apply branch goes *Write Cover Letter → Download CV PDF → Mark Email Sent*, and **Mark Email Sent** reads that node, so a run with auto-apply on stops there with an error, and no email is sent. With auto-apply off, strong matches go to the "needs manual application" list with the email address to send your CV to, and the rest of the workflow is unaffected.

To finish it: add a Microsoft Outlook node named **Create Application Email** between **Download CV PDF** and **Mark Email Sent** that sends the cover letter with the CV attached, connect a Microsoft OAuth2 credential, then set `auto_apply_enabled = true` and `cv_pdf_url`. **Check Outlook Replies** (reply tracking) and **Email Error Alert** are in the export but disabled; enable them with the same credential.

## Skill gaps from CareerMind (optional)
Strong matches (the "needs manual application" list) can get a second check from the CareerMind app: it compares your CV with the job and lists the skills you're missing. The WhatsApp details then show them next to each job (`ناقصك: Docker, SQL`).

1. Deploy CareerMind and set `CAREERMIND_API_KEY` on it (see the [main README](../../README.md#the-match-api)).
2. In n8n, create a **Header Auth** credential named `CareerMind API Key`: name `x-api-key`, value = the same key. Pick it in the **CareerMind Gap Check** node.
3. Put your CareerMind URL in `careermind_url` in `jh_settings`.

Leave `careermind_url` empty to skip this step. If CareerMind is down, the job keeps its Gemini score and the report just shows no gaps.

## Customize the scoring
The **Score Job Match** node's prompt describes the candidate's level ("university student (penultimate year) seeking internship / entry-level / junior / graduate roles"). Edit that line if it doesn't describe you; everything else comes from `cv_text` and the other `jh_settings` columns.

## Check the files
```bash
node --test tests/*.test.mjs   # Node.js 21 or newer
```
- `tests/workflow.test.mjs` checks that every connection and every `$('Node')` reference points to a real node, that the export has no credential IDs or hard-coded emails/phone numbers, that every setting the workflow reads is in `jh_settings.csv`, and that every column it writes is documented in `data-tables/schema.md`.
- `tests/code-nodes.test.mjs` runs the Code nodes from the export with sample jobs: filtering by title, level, location and age, de-duplication, salary and apply-email parsing, the scoring queue, the manual/auto-apply routing and its daily cap, the report's salary and skills rules, the WhatsApp length limits, and reply matching.

Run them after re-exporting the workflow. GitHub Actions runs them on every pull request and push to `main`.

## Design principles
- **No invented experience.** Scoring and cover letters are grounded strictly in the CV text.
- **No fake numbers.** Salary averages show their sample size, currency and period, or say the data is insufficient.
- **"Applied" means confirmed.** A job is marked `applied_confirmed` only after a real reply from the employer.
- **Secrets stay in n8n Credentials.** None are stored in the workflow JSON.

---

## 🇪🇬 بالعربي

Workflow على n8n بيدوّر كل يوم الصبح على وظائف تقنية للمبتدئين والمتدربين. بيقيّم كل وظيفة على أساس الـCV بتاعك باستخدام Gemini، ويبعتلك ملخص يومي على واتساب.

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

**التقديم التلقائي:** لسه مش مكتمل، لأن عقدة إرسال إيميل التقديم مش موجودة في الملف. سيب `auto_apply_enabled = false`، والوظايف القوية هتظهر في قايمة "محتاجة تقديم يدوي" ومعاها الإيميل اللي تبعتله الـCV.

**التشغيل:** اتبع خطوات Setup اللي فوق: استورد الملف، واعمل الجداول، واربط Gemini وواتساب، واعمل القالب، وجرّب، وبعدين انشر.

## License
MIT
