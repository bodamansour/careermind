const sections = {
  upload: document.getElementById('upload-section'),
  loading: document.getElementById('loading-section'),
  dashboard: document.getElementById('dashboard-section'),
  plan: document.getElementById('plan-section'),
  interview: document.getElementById('interview-section'),
  jobs: document.getElementById('jobs-section'),
};

const stageOrder = ['upload', 'dashboard', 'plan', 'interview', 'jobs'];
const stageEls = document.querySelectorAll('.stage');
let completedStages = new Set(['upload']);

// ---------- TOASTS ----------
function toast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }, 4000);
}

// ---------- HELPERS ----------
// Fetch JSON and turn every failure (network, timeout page, non-JSON body)
// into an Error with a readable message.
async function apiFetch(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (_) {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }

  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* non-JSON body, e.g. a platform timeout page */
  }

  if (!res.ok) {
    if (data && data.error) throw new Error(data.error);
    if (res.status === 413) throw new Error('The upload is too large (max 4 MB).');
    if (res.status === 504) throw new Error('The analysis took too long. Please try again.');
    throw new Error(`Server error (HTTP ${res.status}). Please try again.`);
  }
  if (!data) throw new Error('The server sent an unexpected response.');
  return data;
}

// Scores may come back from the models as strings; keep them numeric 0-100.
function toScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

// Agents usually return skills as strings, but sometimes as objects.
function skillLabel(skill) {
  if (skill == null) return '';
  if (typeof skill !== 'object') return String(skill);
  return skill.skill || skill.name || skill.title || JSON.stringify(skill);
}

function fillList(listEl, items) {
  listEl.innerHTML = '';
  (Array.isArray(items) ? items : []).forEach((item) => {
    const li = document.createElement('li');
    li.textContent = skillLabel(item);
    listEl.appendChild(li);
  });
}

let state = {
  cv: null,
  job: null,
  matching: null,
  skillGap: null,
  roadmap: null,
  interviewSessionId: null,
  interviewScore: null,
};

function show(name) {
  Object.values(sections).forEach((s) => s.classList.add('hidden'));
  sections[name].classList.remove('hidden');

  const idx = stageOrder.indexOf(name);
  stageEls.forEach((el, i) => {
    const stageName = stageOrder[i];
    el.classList.toggle('active', i === idx);
    el.classList.toggle('done', completedStages.has(stageName) && i !== idx);
    el.classList.toggle('clickable', completedStages.has(stageName));
  });
}

stageEls.forEach((el, i) => {
  el.addEventListener('click', () => {
    const stageName = stageOrder[i];
    if (completedStages.has(stageName)) show(stageName);
  });
});

document.querySelectorAll('.back-btn').forEach((btn) => {
  btn.addEventListener('click', () => show(btn.dataset.back));
});

// file input label + drag-and-drop
const cvFileInput = document.getElementById('cvFile');
const fileDrop = document.getElementById('fileDrop');
const fileLabel = document.getElementById('fileLabel');

function setFileLabel(file) {
  fileLabel.textContent = file ? file.name : 'Drop a PDF here, or click to browse';
  fileDrop.classList.toggle('has-file', !!file);
}

cvFileInput.addEventListener('change', () => setFileLabel(cvFileInput.files[0]));

['dragover', 'dragenter'].forEach((evt) => {
  fileDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    fileDrop.classList.add('drag-over');
  });
});
['dragleave', 'dragend'].forEach((evt) => {
  fileDrop.addEventListener(evt, () => fileDrop.classList.remove('drag-over'));
});
fileDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDrop.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') {
    cvFileInput.files = e.dataTransfer.files;
    setFileLabel(file);
  } else {
    toast('Only PDF files are supported.', 'error');
  }
});

// ---------- STEP 1: Analyze ----------
const loadingMessages = [
  'Reading CV...',
  'Reading job description...',
  'Comparing skills...',
  'Mapping skill gaps...',
  'Building roadmap...',
];

document.getElementById('analyzeBtn').addEventListener('click', async () => {
  const jdText = document.getElementById('jdText').value.trim();
  const errorEl = document.getElementById('uploadError');
  errorEl.textContent = '';

  if (!cvFileInput.files[0]) {
    toast('Upload your CV as a PDF first.', 'error');
    return;
  }
  if (!jdText) {
    toast('Paste the job description first.', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('cvFile', cvFileInput.files[0]);
  formData.append('jdText', jdText);

  if (cvFileInput.files[0].size > 4 * 1024 * 1024) {
    toast('CV file is too large (max 4 MB).', 'error');
    return;
  }

  show('loading');
  let step = 0;
  const loadingText = document.getElementById('loadingText');
  const loadingInterval = setInterval(() => {
    step = (step + 1) % loadingMessages.length;
    loadingText.textContent = loadingMessages[step];
  }, 1800);

  try {
    const data = await apiFetch('/api/full-analysis', { method: 'POST', body: formData });

    state.cv = data.cv;
    state.interviewSessionId = null;
    state.interviewScore = null;
    state.job = data.job;
    state.matching = data.matching;
    state.skillGap = data.skillGap;
    state.roadmap = data.roadmap;

    clearInterval(loadingInterval);
    completedStages.add('dashboard');
    renderDashboard();
    show('dashboard');
    toast('Analysis complete.');
  } catch (err) {
    clearInterval(loadingInterval);
    show('upload');
    toast(err.message, 'error');
  }
});

// ---------- DASHBOARD ----------
const GAUGE_CIRCUMFERENCE = 327; // 2 * PI * 52

function renderDashboard() {
  const jobMatch = toScore(state.matching?.job_match_score) ?? 0;
  const interviewScore = state.interviewScore;
  const readiness = interviewScore != null
    ? Math.round((jobMatch + interviewScore) / 2)
    : jobMatch;

  document.getElementById('readinessValue').textContent = `${readiness}%`;
  document.getElementById('jobMatchScore').textContent = `${jobMatch}/100`;
  document.getElementById('interviewScoreValue').textContent =
    interviewScore != null ? `${interviewScore}/100` : 'not taken';

  const offset = GAUGE_CIRCUMFERENCE - (GAUGE_CIRCUMFERENCE * readiness) / 100;
  document.getElementById('gaugeFill').style.strokeDashoffset = offset;

  fillList(document.getElementById('matchingSkillsList'), state.matching?.matching_skills);
  fillList(document.getElementById('missingSkillsList'), state.matching?.missing_skills);
}

// ---------- CAREER PLAN ----------
document.getElementById('viewPlanBtn').addEventListener('click', () => {
  const container = document.getElementById('planWeeks');
  container.innerHTML = '';

  const weeks = Array.isArray(state.roadmap) ? state.roadmap : state.roadmap?.weeks;
  if (!Array.isArray(weeks) || weeks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'The Roadmap Agent did not return any weeks. Try running the analysis again.';
    container.appendChild(empty);
  }

  (weeks || []).forEach((week, i) => {
    const block = document.createElement('div');
    block.className = 'week-block';

    const title = document.createElement('h4');
    title.textContent = `WEEK ${week.week_number ?? i + 1} — ${week.focus || 'Focus'}`;
    block.appendChild(title);

    const topicsList = document.createElement('ul');
    fillList(topicsList, week.topics);
    block.appendChild(topicsList);

    if (week.project) {
      const project = document.createElement('div');
      project.className = 'project';
      project.textContent = `Project: ${skillLabel(week.project)}`;
      block.appendChild(project);
    }

    container.appendChild(block);
  });

  completedStages.add('plan');
  show('plan');
});

// ---------- INTERVIEW ----------
const chatWindow = document.getElementById('chatWindow');
const chatInput = document.getElementById('chatInput');
const typingIndicator = document.getElementById('typingIndicator');

function clearChat() {
  chatWindow.querySelectorAll('.msg:not(.typing)').forEach((el) => el.remove());
}

function showTyping() {
  typingIndicator.classList.remove('hidden');
  chatWindow.appendChild(typingIndicator); // keep it pinned to the bottom
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function hideTyping() {
  typingIndicator.classList.add('hidden');
}

function appendMessage(text, sender) {
  const div = document.createElement('div');
  div.className = `msg ${sender}`;
  div.textContent = text;
  chatWindow.insertBefore(div, typingIndicator);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

let interviewBusy = false;
const sendAnswerBtn = document.getElementById('sendAnswerBtn');

function setInterviewBusy(busy) {
  interviewBusy = busy;
  sendAnswerBtn.disabled = busy;
}

document.getElementById('startInterviewBtn').addEventListener('click', async () => {
  if (interviewBusy) return;
  setInterviewBusy(true);
  state.interviewSessionId = null;
  clearChat();
  document.getElementById('interviewFinal').classList.add('hidden');
  document.getElementById('chatInputRow').classList.remove('hidden');
  show('interview');
  showTyping();

  try {
    const data = await apiFetch('/api/interview/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cv: state.cv, job: state.job }),
    });

    state.interviewSessionId = data.sessionId;
    completedStages.add('interview');
    hideTyping();
    appendMessage(data.message, 'agent');
  } catch (err) {
    hideTyping();
    appendMessage('Error starting interview: ' + err.message, 'agent error');
    toast(err.message, 'error');
  } finally {
    setInterviewBusy(false);
  }
});

sendAnswerBtn.addEventListener('click', sendAnswer);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) sendAnswer();
});

async function sendAnswer() {
  const text = chatInput.value.trim();
  if (!text || !state.interviewSessionId || interviewBusy) return;

  setInterviewBusy(true);
  appendMessage(text, 'user');
  chatInput.value = '';
  showTyping();

  try {
    const data = await apiFetch('/api/interview/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.interviewSessionId, message: text }),
    });

    hideTyping();
    if (data.isFinal && data.evaluation) {
      showFinalEvaluation(data.evaluation);
    } else {
      appendMessage(data.message, 'agent');
    }
  } catch (err) {
    hideTyping();
    // Give the answer back so the candidate doesn't have to retype it.
    if (!chatInput.value) chatInput.value = text;
    appendMessage('Error: ' + err.message, 'agent error');
    toast(err.message, 'error');
  } finally {
    setInterviewBusy(false);
  }
}

function showFinalEvaluation(evalData) {
  document.getElementById('chatInputRow').classList.add('hidden');
  const finalSection = document.getElementById('interviewFinal');
  finalSection.classList.remove('hidden');

  state.interviewScore = toScore(evalData.overall_score);

  // Built with textContent: the model's text must never be parsed as HTML.
  const container = document.getElementById('finalScores');
  container.innerHTML = '';

  const metrics = document.createElement('div');
  metrics.className = 'metric-list';
  [
    ['Technical', evalData.technical_score],
    ['Communication', evalData.communication_score],
    ['Completeness', evalData.completeness_score],
    ['Overall', evalData.overall_score],
  ].forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'metric-row';
    const name = document.createElement('span');
    name.textContent = label;
    const score = document.createElement('span');
    score.className = 'mono';
    score.textContent = toScore(value) ?? '—';
    row.append(name, score);
    metrics.appendChild(row);
  });
  container.appendChild(metrics);

  [['Strengths', evalData.strengths], ['Areas to improve', evalData.areas_to_improve]].forEach(
    ([heading, items]) => {
      const h = document.createElement('h4');
      h.textContent = heading;
      h.style.marginTop = '16px';
      const ul = document.createElement('ul');
      fillList(ul, items);
      container.append(h, ul);
    }
  );

  renderDashboard();
}

// ---------- JOBS ----------
document.getElementById('viewJobsBtn').addEventListener('click', () => {
  const topSkill = skillLabel((state.matching?.matching_skills || [])[0]);
  document.getElementById('jobQuery').value = state.job?.job_title || topSkill || '';
  completedStages.add('jobs');
  show('jobs');
  searchJobs();
});

document.getElementById('searchJobsBtn').addEventListener('click', searchJobs);
document.getElementById('jobQuery').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchJobs();
});

async function searchJobs() {
  const query = document.getElementById('jobQuery').value.trim();
  const listEl = document.getElementById('jobsList');
  const errorEl = document.getElementById('jobsError');
  errorEl.textContent = '';
  listEl.innerHTML = '<p class="hint">Searching...</p>';

  if (!query) {
    listEl.innerHTML = '';
    toast('Type a role to search for.', 'error');
    return;
  }

  try {
    const data = await apiFetch(`/api/jobs/search?q=${encodeURIComponent(query)}`);

    listEl.innerHTML = '';
    if (!data.jobs || data.jobs.length === 0) {
      listEl.innerHTML = '<p class="hint">No open roles found for this search.</p>';
      return;
    }

    data.jobs.forEach((job) => {
      const card = document.createElement('div');
      card.className = 'job-card';
      const title = document.createElement('h4');
      title.textContent = job.title;
      const company = document.createElement('div');
      company.className = 'job-company';
      company.textContent = `${job.company} — ${job.location}`;
      card.append(title, company);

      // Only link to real web URLs (never javascript: or data: links).
      if (/^https?:\/\//i.test(job.url || '')) {
        const link = document.createElement('a');
        link.href = job.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'View posting →';
        card.appendChild(link);
      }
      listEl.appendChild(card);
    });
  } catch (err) {
    listEl.innerHTML = '';
    errorEl.textContent = err.message;
    toast(err.message, 'error');
  }
}
