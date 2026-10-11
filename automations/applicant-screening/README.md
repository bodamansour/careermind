# Applicant Screening

> Part of [CareerMind](../../README.md): the recruiter-side automation.

An n8n workflow that takes a job application from a form or webhook, scores the
CV against the job with CareerMind, and saves a labeled row in Google Sheets. The
recruiter gets an email for strong applicants, and every applicant gets a
confirmation email.

It is built on the structure of my Lead Scoring workflow (Orange Digital Center
internship capstone): the same validation, duplicate check, unique IDs,
classification and Google Sheets storage, but it scores applicants against a job
instead of sales leads.

## Workflow

```
Webhook (new application)
   → Config
   → Normalize Data
   → Validate Application ──(invalid)──→ Respond: Invalid (400)
   → Duplicate Check (same email + same job)
   → Is Duplicate? ──(yes)──→ Respond: Duplicate
   → Generate Applicant ID  (APP-<time>-<execution id>)
   → CareerMind Match       (POST /api/match)
   → Final Score            (STRONG / POSSIBLE / WEAK, or REVIEW if CareerMind failed)
   → Classify ──(STRONG)──→ Alert Recruiter
   → Save to Sheet
   → Send Confirmation Email
   → Respond: Success
```

If CareerMind can't be reached, the applicant is still saved, with the category
`REVIEW` and no score, so nobody is rejected because of an outage.

## Request

`POST /webhook/applicant-screening` with JSON or a normal form:

| field | required | notes |
|---|:---:|---|
| `name` | ✅ | |
| `email` | ✅ | |
| `job_id` | ✅ | your own ID for the opening; used for duplicate checks |
| `job_description` | ✅ | the job text the CV is compared with |
| `cv_text` | ✅ | the applicant's CV as plain text |
| `job_title`, `phone`, `source` | – | |

## Setup

1. Import `workflow/applicant-screening.json` into n8n.
2. Fill in the **Config** node: company name, recruiter email, your CareerMind URL,
   and the STRONG / POSSIBLE thresholds (default 75 and 50).
3. Create a Google Sheet with a tab named `Applicants` and the columns in
   [`sheet-columns.csv`](sheet-columns.csv). Put the sheet ID in **Duplicate Check**
   and **Save to Sheet**.
4. Credentials: Google Sheets, Gmail, and a **Header Auth** credential named
   `CareerMind API Key` (name `x-api-key`, value = the `CAREERMIND_API_KEY` set on
   the CareerMind server).
5. Publish, then send a test application.

## Tests

```bash
node --test tests/*.test.mjs   # Node.js 21 or newer
```

They check that every connection and node reference is valid, that the export has
no credential IDs, that the sheet columns match `sheet-columns.csv`, and the
STRONG / POSSIBLE / WEAK / REVIEW rules of the Final Score node.
