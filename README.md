# CareerMind AI

An AI system that helps job seekers actually prepare for the role they want — not
just check if their CV matches a job description, but understand what they're
missing, how to fix it, and whether they're ready to walk into the interview.

Upload a CV and paste a target job description, and CareerMind AI runs it through
a pipeline of specialized AI agents to produce a full readiness assessment: a job
match score, a reasoned skill-gap breakdown, a personalized learning roadmap, and
an AI-driven mock interview scored across four dimensions.

## Features

- **Job Match Score** — breaks the CV down against the job description into
  matching, partial, and missing skills.
- **Skill Gap Reasoning** — for every missing skill, explains *why* it matters for
  this specific role, what to study, and a concrete project to build.
- **Week-by-Week Roadmap** — turns identified gaps into an actionable learning plan.
- **AI Mock Interview** — questions grounded in the candidate's real CV and the
  job's requirements, with live evaluation and a final scored breakdown
  (Technical, Communication, Completeness, Overall).
- **Optional Job Search** — surfaces open roles matching the candidate's profile
  via the Adzuna API.

## Architecture

Rather than relying on a single general-purpose model for everything, the system
is built as **6 specialized AI agents**, each with one responsibility:

```
CV Analyzer → Job Analyzer → Matching Agent → Skill Gap Agent → Roadmap Agent → Interview Agent
```

Splitting the logic this way keeps each agent's output more reliable and makes the
full pipeline easier to debug, test, and extend independently.

## Tech Stack

- **Orchestration**: AiMicromind (agent workflow hosting)
- **LLM Access**: OpenRouter
- **Backend**: Node.js / Express — PDF parsing, pipeline orchestration
- **Frontend**: Vanilla HTML/CSS/JS, built around a "readiness scan" experience
- **Job Search**: Adzuna API (optional)

---

## Setup

```bash
cd backend
npm install
cp .env.example .env
```

Open `.env` and replace every `REPLACE_ME` with the real flow ID from AiMicromind
(open each chatflow → click **API** → copy the URL). The CV Analyzer URL is already
filled in from what we set up earlier.

If any of your chatflows require an API Key (instead of "No Authorization"), also set
`AIMICROMIND_API_KEY` in `.env`.

## Run

```bash
npm start
```

Open **http://localhost:3000** in your browser.

## How It Works

- **Upload page**: user uploads a CV (PDF) and pastes a Job Description.
- Backend extracts text from the PDF (`pdf-parse`), then calls, in order:
  CV Analyzer → Job Analyzer → Matching Agent → Skill Gap Agent → Roadmap Agent.
- **Dashboard**: shows Career Readiness %, Job Match score, matching skills, top gaps.
- **View Career Plan**: shows the week-by-week roadmap.
- **Start Mock Interview**: opens a chat with the Interview Agent. Each answer you send
  keeps the same `sessionId` so the agent's Buffer Memory remembers the conversation.
  When the agent sends back its final JSON evaluation, the app detects it automatically
  and shows the scored results instead of a chat bubble.

## Job Search (Optional)

The "Find open roles" step uses [Adzuna](https://developer.adzuna.com/)'s free API — a
legitimate alternative to LinkedIn, since LinkedIn does not offer a public API for
personalized job recommendations (that access is limited to approved commercial
partners only). To enable it:

1. Create a free account at developer.adzuna.com.
2. Copy your `app_id` and `app_key` into `.env` as `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`.
3. Set `ADZUNA_COUNTRY` to the closest supported market (gb, us, in, de, fr, ca...).
   Egypt is not directly supported — pick the nearest match or leave it as `gb`.

If you skip this, the app still works fully — you'll just see a message on the Jobs
step instead of results.

## Roadmap / Known Limitations (MVP)

- No database — nothing is saved between page reloads. Persistent accounts and a
  database (e.g. PostgreSQL) are planned next.
- No user accounts/login yet.
- The `parseModelJSON` helper in `services/aimicromind.js` tries several strategies to
  pull JSON out of a model reply (clean JSON, ```json fences, or the first {...} block
  found). If one of your agents' replies still fails to parse, check its raw text in the
  server logs and adjust the agent's System Message to be even stricter about
  "JSON only, no extra text".
- Flowise/AiMicromind's prediction API sometimes wraps the reply differently
  (`{ "text": "..." }` vs a raw string). `callFlow()` already handles the common shapes,
  but if a specific flow behaves differently, log `response.data` for that call and adjust.
