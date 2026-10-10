<div align="center">

# CareerMind AI

**A multi-agent readiness scan for your next role.**

Upload your CV, paste the job you want, and six specialized AI agents tell you how
well you match, what you're missing, how to close the gap, and whether you're ready
for the interview.

![Node.js](https://img.shields.io/badge/Node.js-24.x-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)
![AiMicromind](https://img.shields.io/badge/Agents-AiMicromind%20%2F%20Flowise-8b7cff)
![Deploy](https://img.shields.io/badge/Deploy-Vercel%20%7C%20Render-00d9a3)

<img src="docs/screenshots/02-readout.png" alt="CareerMind readiness readout" width="820" />

</div>

---

## Contents

- [Why CareerMind](#why-careermind)
- [Screenshots](#screenshots)
- [The 6 agents](#the-6-agents)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [API reference](#api-reference)
- [Error handling](#error-handling)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)

## Why CareerMind

Most "CV vs. job" tools stop at a match percentage. CareerMind goes further:

| Feature | What you get |
| --- | --- |
| **Job match score** | Your CV broken down against the job into matching, partial and missing skills. |
| **Skill-gap reasoning** | For every missing skill: *why* it matters for this role, what to study, and a project to build. |
| **Week-by-week roadmap** | The gaps turned into a concrete learning plan. |
| **AI mock interview** | Questions grounded in your real CV and the job's requirements, scored on Technical, Communication, Completeness and Overall. |
| **Open roles** *(optional)* | Live job listings matched to your profile via the Adzuna API. |

## Screenshots

> Screenshots were captured with sample data.

| Intake | Readiness readout |
| --- | --- |
| ![Intake](docs/screenshots/01-intake.png) | ![Readout](docs/screenshots/02-readout.png) |
| **Development plan** | **Mock interview** |
| ![Plan](docs/screenshots/03-plan.png) | ![Interview](docs/screenshots/04-interview.png) |
| **Interview result** | **Open roles** |
| ![Result](docs/screenshots/05-interview-result.png) | ![Jobs](docs/screenshots/06-jobs.png) |

## The 6 agents

Instead of asking one general-purpose model to do everything, CareerMind splits the
work across **six agents with one job each**. Every agent is its own AiMicromind
(Flowise) chatflow, so you can tune, test and swap them on their own.

| # | Agent | Input | Output | Env variable |
|---|-------|-------|--------|--------------|
| 1 | **CV Analyzer** | Raw text extracted from the CV PDF | Structured profile: name, title, experience, skills… | `CV_ANALYZER_URL` |
| 2 | **Job Analyzer** | The pasted job description | Structured job: `job_title`, required skills, seniority… | `JOB_ANALYZER_URL` |
| 3 | **Matching Agent** | Output of agents 1 + 2 | `job_match_score` (0–100), `matching_skills`, `partial_match_skills`, `missing_skills` | `MATCHING_URL` |
| 4 | **Skill Gap Agent** | Missing + partial skills and the job data | For each gap: why it matters, what to study, a project to build | `SKILLGAP_URL` |
| 5 | **Roadmap Agent** | The skill-gap analysis | `weeks[]` — each with `week_number`, `focus`, `topics[]`, `project` | `ROADMAP_URL` |
| 6 | **Interview Agent** | CV + job data, then the candidate's answers | Interview questions one at a time, then a final JSON evaluation | `INTERVIEW_URL` |

### 1. CV Analyzer
Turns unstructured CV text into clean JSON. Everything downstream depends on it, so
its System Message should be strict about returning **JSON only**.

### 2. Job Analyzer
Does the same for the job description: the title, the must-have and nice-to-have
skills, and the level of the role. It runs **in parallel** with the CV Analyzer.

### 3. Matching Agent
Compares the two profiles skill by skill and produces the job match score shown on
the readiness gauge, plus the *Matching* and *Gaps* lists.

### 4. Skill Gap Agent
Reasons about each missing or partial skill **in the context of this job** — not just
"learn Docker", but why the role needs it and a concrete project that proves it.

### 5. Roadmap Agent
Turns the gap analysis into a week-by-week development plan with topics and a
hands-on project per week.

### 6. Interview Agent
Runs a conversational mock interview. Each request carries the same `sessionId`, so
the flow's Buffer Memory remembers the conversation. When the agent is done, it
replies with a JSON evaluation:

```json
{
  "technical_score": 72,
  "communication_score": 85,
  "completeness_score": 70,
  "overall_score": 76,
  "strengths": ["..."],
  "areas_to_improve": ["..."]
}
```

The backend detects this reply automatically and the UI shows the scored result. The
overall readiness becomes the average of the job match score and the interview score.

## Architecture

```mermaid
flowchart LR
    U([Browser]) -- "CV PDF + job description" --> API[Express API]
    API -- "PDF → text (unpdf)" --> API

    subgraph Analysis["POST /api/full-analysis"]
        direction LR
        A1[1. CV Analyzer]
        A2[2. Job Analyzer]
        A3[3. Matching Agent]
        A4[4. Skill Gap Agent]
        A5[5. Roadmap Agent]
        A1 --> A3
        A2 --> A3
        A3 --> A4 --> A5
    end

    API --> A1
    API --> A2
    A5 -- "cv, job, matching, skillGap, roadmap" --> U

    U -- "/api/interview/*  (sessionId)" --> A6[6. Interview Agent]
    U -- "/api/jobs/search" --> AZ[(Adzuna API)]
```

```
career-mind-app/backend/
├── server.js               # Express app: routes, health check, JSON error handler
├── routes/
│   ├── analyze.js          # PDF parsing + agents 1–5
│   ├── interview.js        # Agent 6 (start / message)
│   └── jobs.js             # Adzuna job search
├── services/
│   └── aimicromind.js      # Agent registry, HTTP calls, error mapping, JSON parsing
└── public/                 # Frontend (vanilla HTML / CSS / JS)
```

**Tech stack:** Node.js + Express · AiMicromind (Flowise) for agent hosting ·
OpenRouter for LLM access · `unpdf` for PDF text extraction · vanilla HTML/CSS/JS ·
Adzuna API for job search.

## Getting started

### Prerequisites

- **Node.js 20+** (24.x recommended; production pins 24.x)
- An [AiMicromind](https://aimicromind.com) account with the six chatflows created
- *(Optional)* a free [Adzuna](https://developer.adzuna.com/) API key for job search

### 1. Install

```bash
git clone https://github.com/bodamansour/careermind-ai.git
cd careermind-ai/career-mind-app/backend
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

For each agent, open its chatflow in AiMicromind → click **API** → copy the
prediction URL into `.env` (replace every `REPLACE_ME`). See
[Configuration](#configuration) for the full list.

### 3. Run

```bash
npm start
```

Open **http://localhost:3000**. To check your setup, open
**http://localhost:3000/api/health**. It lists any agent URL that is still missing.
The server also prints a warning on startup.

## Configuration

| Variable | Required | Description |
| --- | :---: | --- |
| `CV_ANALYZER_URL` | ✅ | Prediction URL of the CV Analyzer chatflow |
| `JOB_ANALYZER_URL` | ✅ | Prediction URL of the Job Analyzer chatflow |
| `MATCHING_URL` | ✅ | Prediction URL of the Matching Agent chatflow |
| `SKILLGAP_URL` | ✅ | Prediction URL of the Skill Gap Agent chatflow |
| `ROADMAP_URL` | ✅ | Prediction URL of the Roadmap Agent chatflow |
| `INTERVIEW_URL` | ✅ | Prediction URL of the Interview Agent chatflow |
| `AIMICROMIND_API_KEY` | – | Only if your chatflows use *API Key* authorization |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | – | Turns on the *Open roles* step |
| `ADZUNA_COUNTRY` | – | Two-letter job market code (`gb`, `us`, `in`, `de`, …). Default `gb` |
| `FLOW_TIMEOUT_MS` | – | Max wait per agent call in ms. Default `90000` |
| `PORT` | – | Local port. Default `3000` (Render sets this for you) |

> **Job search:** LinkedIn has no public API for personalized job recommendations,
> so CareerMind uses Adzuna, which aggregates listings from many sources. Egypt is not
> currently an Adzuna market, so pick the closest one. Without Adzuna keys, the app
> still works fully and the Jobs step shows a clear "not configured" message.

## Deployment

The backend serves both the API and the frontend, so you deploy **one service**.

### Option A — Vercel

`server.js` exports the Express app, which Vercel's Express support detects with no
extra config. Files in `public/` are served from Vercel's CDN.

1. Import the repo at [vercel.com/new](https://vercel.com/new).
2. Set **Root Directory** to `career-mind-app/backend`. Leave the framework preset
   as detected (Express / Other), with no build command.
3. Under **Environment Variables**, add the variables from
   [Configuration](#configuration).
4. Deploy, then open `https://<your-app>.vercel.app/api/health` to check the config.

> **Limits on Vercel:** request bodies are capped at 4.5 MB (CV uploads are capped at
> 4 MB for this reason). The full analysis makes four rounds of agent calls in a row,
> so it can take a while. If you see timeouts, raise the function's max duration in
> *Project Settings → Functions* or use Render.

### Option B — Render

The repo includes a [`render.yaml`](render.yaml) Blueprint.

1. In Render, click **New + → Blueprint** and pick this repo.
2. Fill in the secret values Render asks for (the agent URLs and optional keys).
3. Click **Apply**. Render runs `npm ci`, starts the app with `npm start`, and
   health-checks `/api/health`.

<details>
<summary>Manual setup (without the Blueprint)</summary>

- **New + → Web Service**, connect the repo
- **Root Directory:** `career-mind-app/backend`
- **Build Command:** `npm ci` · **Start Command:** `npm start`
- **Health Check Path:** `/api/health`
- Add the environment variables from [Configuration](#configuration)

</details>

> Render's free plan sleeps after inactivity, so the first request after a while can
> take ~30–60 s.

## API reference

All endpoints return JSON. Errors always have the shape `{ "error": "<message>" }`.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/api/health` | – | `{ status, missingConfig[], jobSearch }` |
| `POST` | `/api/full-analysis` | multipart: `cvFile` (PDF ≤ 4 MB), `jdText` | `{ cv, job, matching, skillGap, roadmap }` |
| `POST` | `/api/interview/start` | `{ cv, job }` | `{ sessionId, message, isFinal: false }` |
| `POST` | `/api/interview/message` | `{ sessionId, message }` | `{ message, isFinal, evaluation }` |
| `GET` | `/api/jobs/search?q=<role>` | – | `{ jobs: [{ title, company, location, url }] }` |

## Error handling

Every failure returns a clear, specific message, and the UI shows it as a toast.

| Situation | Status | Example message |
| --- | :---: | --- |
| Missing file / job description, input too long | 400 | `No CV file uploaded.` |
| File is not a PDF, or is corrupted / password-protected | 400 | `The uploaded file is not a PDF…` |
| Scanned / image-only PDF | 400 | `Could not extract any text from the PDF…` |
| CV larger than 4 MB | 413 | `CV file is too large (max 4 MB).` |
| Agent URL not set | 503 | `Matching Agent is not configured. Set MATCHING_URL…` |
| Agent flow not found / wrong API key | 502 | `Roadmap Agent flow was not found (HTTP 404). Check ROADMAP_URL.` |
| Agent returned non-JSON | 502 | `Skill Gap Agent returned an unexpected format…` |
| Agent too slow | 504 | `Interview Agent took too long to respond…` |
| Job search not configured | 503 | `Job search is not configured yet…` |

The server logs the details (HTTP status, start of the raw reply) for debugging. It
never sends stack traces to the client. On the frontend, network failures and non-JSON
responses (for example, a platform timeout page) also become readable messages, and
all model output is rendered as plain text, never as HTML.

## Troubleshooting

- **`/api/health` shows `degraded`** — one or more agent URLs are missing or still
  contain `REPLACE_ME`. The `missingConfig` field lists them.
- **"… returned an unexpected format"** — the model added prose around its JSON. The
  parser already handles code fences and surrounding text. If it still fails, check
  the raw reply in the server logs and make that agent's System Message stricter
  ("Respond with JSON only, no extra text").
- **"… rejected the request (HTTP 401/403)"** — the chatflow uses API-key auth. Set
  `AIMICROMIND_API_KEY`.
- **Interview never shows a result** — the final evaluation must be JSON with a
  numeric (or numeric-string) `overall_score`.

## Roadmap

- [ ] Accounts and saved scans (PostgreSQL)
- [ ] OCR for scanned CVs
- [ ] Streaming agent progress to the loading screen
- [ ] Exportable PDF report of the readiness scan
