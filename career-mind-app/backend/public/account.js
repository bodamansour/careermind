// Accounts: sign in, saved CV, the daily job feed and analysis history.
// Everything here stays hidden unless the server has accounts enabled.
(async function initAccounts() {
  let config;
  try {
    config = await apiFetch('/api/config');
  } catch (_) {
    return;
  }
  if (!config.accounts || !window.supabase) return;

  const sb = window.supabase.createClient(config.supabaseUrl, config.supabaseKey);
  let session = null;
  let profile = null;
  let signUpMode = false;

  const $ = (id) => document.getElementById(id);
  const modeTabs = document.querySelectorAll('.mode-tab');

  // ---------- API helpers ----------
  async function authHeaders() {
    const { data } = await sb.auth.getSession();
    session = data.session;
    return session ? { Authorization: `Bearer ${session.access_token}` } : {};
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}), ...(await authHeaders()) };
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      options = { ...options, body: JSON.stringify(options.json) };
    }
    return apiFetch(path, { ...options, headers });
  }

  Object.assign(account, {
    signedIn: () => !!session,
    hasCv: () => !!profile?.has_cv,
    authHeaders,
    saveInterview: (id, evaluation) =>
      api(`/api/me/analyses/${id}/interview`, { method: 'PUT', json: { evaluation } }),
    saveJob,
    onShow(name) {
      const mode = name === 'myjobs' || name === 'history' ? name : name === 'auth' ? null : 'scan';
      modeTabs.forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
      $('stageRail').classList.toggle('hidden', name === 'myjobs' || name === 'history' || name === 'auth');
    },
  });

  // ---------- Header and tabs ----------
  $('accountBar').classList.remove('hidden');
  $('modeTabs').classList.remove('hidden');

  modeTabs.forEach((tab) =>
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      if (mode === 'scan') return show(completedStages.has('dashboard') ? 'dashboard' : 'upload');
      if (!session) return show('auth');
      show(mode);
      if (mode === 'myjobs') loadFeed();
      if (mode === 'history') loadHistory();
    })
  );

  $('signInBtn').addEventListener('click', () => show('auth'));
  $('signOutBtn').addEventListener('click', async () => {
    await sb.auth.signOut();
    show('upload');
  });

  function renderAccount() {
    $('accountEmail').textContent = session ? session.user.email : '';
    $('signInBtn').classList.toggle('hidden', !!session);
    $('signOutBtn').classList.toggle('hidden', !session);

    const hasCv = !!profile?.has_cv;
    $('savedCvRow').classList.toggle('hidden', !hasCv);
    $('savedCvName').textContent = hasCv ? `(${profile.cv?.name || 'uploaded'})` : '';
    $('cvUploadBlock').classList.toggle('hidden', hasCv && $('useSavedCv').checked);

    $('cvCardTitle').textContent = hasCv
      ? `${profile.cv?.name || 'Your CV'}${profile.cv?.current_title ? ' — ' + profile.cv.current_title : ''}`
      : 'No CV yet';
    $('cvCardMeta').textContent = hasCv
      ? `Updated ${new Date(profile.cv_updated_at).toLocaleDateString()} · ${profile.cv.skills.slice(0, 8).join(', ')}`
      : 'Upload your CV once. Every job is scored against it.';
    $('profileCvLabel').textContent = hasCv ? 'Replace CV' : 'Upload CV';
  }

  $('useSavedCv').addEventListener('change', renderAccount);

  async function loadProfile() {
    profile = null;
    if (session) {
      try {
        profile = await api('/api/me');
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    renderAccount();
  }

  // ---------- Sign in / sign up ----------
  $('authToggle').addEventListener('click', () => {
    signUpMode = !signUpMode;
    $('authSubmit').textContent = signUpMode ? 'Create account' : 'Sign in';
    $('authToggle').textContent = signUpMode ? 'I already have an account' : 'Create an account instead';
    $('authPassword').autocomplete = signUpMode ? 'new-password' : 'current-password';
    $('authMessage').textContent = '';
  });

  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    const msg = $('authMessage');
    $('authSubmit').disabled = true;
    msg.textContent = '';
    try {
      if (signUpMode) {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } });
        if (error) throw error;
        if (!data.session) {
          msg.textContent = 'Check your email and click the link to confirm your account, then sign in.';
          return;
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      $('authPassword').value = '';
    } catch (err) {
      msg.textContent = err.message || 'Could not sign in.';
    } finally {
      $('authSubmit').disabled = false;
    }
  });

  // Supabase warns against awaiting its own calls inside this callback, so
  // the work runs on the next tick.
  sb.auth.onAuthStateChange((event, newSession) => {
    setTimeout(async () => {
      const was = session?.user?.id;
      session = newSession;
      if (was === newSession?.user?.id && event !== 'SIGNED_IN' && profile) return renderAccount();
      await loadProfile();
      if (event === 'SIGNED_IN' && !sections.auth.classList.contains('hidden')) {
        show('myjobs');
        loadFeed();
      }
    }, 0);
  });

  // ---------- CV ----------
  $('profileCvFile').addEventListener('change', async () => {
    const file = $('profileCvFile').files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) return toast('CV file is too large (max 4 MB).', 'error');
    const fd = new FormData();
    fd.append('cvFile', file);
    $('profileCvLabel').textContent = 'Reading CV...';
    try {
      profile = await api('/api/me/cv', { method: 'POST', body: fd });
      renderAccount();
      toast('CV saved. Scoring recent jobs against it...');
      rescore();
    } catch (err) {
      toast(err.message, 'error');
      renderAccount();
    } finally {
      $('profileCvFile').value = '';
    }
  });

  // ---------- Feed ----------
  const STATUS_ACTIONS = [
    ['saved', 'Save'],
    ['applied', 'Applied'],
    ['hidden', 'Hide'],
  ];

  function scoreClass(score) {
    if (score == null) return 'low';
    return score >= 80 ? 'high' : score >= 60 ? 'mid' : 'low';
  }

  function feedCard(m) {
    const job = m.job;
    const card = document.createElement('article');
    card.className = 'job-card feed-card';

    const badge = document.createElement('div');
    badge.className = `score-badge ${scoreClass(m.score)}`;
    badge.textContent = m.score ?? '—';
    badge.title = 'Match score';

    const body = document.createElement('div');
    body.className = 'feed-body';
    const title = document.createElement('h4');
    title.textContent = job.title;
    const meta = document.createElement('div');
    meta.className = 'job-company';
    meta.textContent = [job.company, job.location, job.source].filter(Boolean).join(' · ');
    body.append(title, meta);

    if (m.summary) {
      const sum = document.createElement('p');
      sum.className = 'feed-summary';
      sum.textContent = m.summary;
      body.appendChild(sum);
    }

    if (m.missing_skills?.length) {
      const chips = document.createElement('div');
      chips.className = 'chips';
      const label = document.createElement('span');
      label.className = 'chips-label';
      label.textContent = 'Missing:';
      chips.appendChild(label);
      m.missing_skills.slice(0, 6).forEach((s) => {
        const c = document.createElement('span');
        c.className = 'chip gap';
        c.textContent = s;
        chips.appendChild(c);
      });
      body.appendChild(chips);
    }

    const actions = document.createElement('div');
    actions.className = 'feed-actions';
    const analyze = document.createElement('button');
    analyze.className = 'btn-secondary';
    analyze.textContent = 'Full analysis →';
    analyze.addEventListener('click', () =>
      runAnalysis(() => api(`/api/me/jobs/${job.id}/analyze`, { method: 'POST' }))
    );
    actions.appendChild(analyze);

    if (/^https?:\/\//i.test(job.url || '')) {
      const link = document.createElement('a');
      link.href = job.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Posting ↗';
      actions.appendChild(link);
    }

    STATUS_ACTIONS.forEach(([status, label]) => {
      const b = document.createElement('button');
      b.className = 'link-btn';
      const on = m.status === status;
      b.textContent = on ? `${label} ✓` : label;
      b.setAttribute('aria-pressed', on);
      b.addEventListener('click', async () => {
        try {
          await api(`/api/me/jobs/${job.id}`, { method: 'PATCH', json: { status: on ? 'new' : status } });
          loadFeed();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      actions.appendChild(b);
    });

    body.appendChild(actions);
    card.append(badge, body);
    return card;
  }

  async function loadFeed() {
    const list = $('feedList');
    if (!profile?.has_cv) {
      list.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'Upload your CV above to see your matched jobs.';
      list.appendChild(p);
      return;
    }
    list.innerHTML = '<p class="hint">Loading...</p>';
    try {
      const { jobs } = await api(`/api/me/jobs?status=${$('feedStatus').value}&min=${$('feedMin').value}`);
      list.innerHTML = '';
      if (!jobs.length) {
        list.innerHTML =
          '<p class="hint">No jobs here yet. Job Hunter adds new ones every morning; you can also press “Score new jobs” or add one by hand.</p>';
        return;
      }
      jobs.forEach((m) => list.appendChild(feedCard(m)));
    } catch (err) {
      list.innerHTML = '';
      toast(err.message, 'error');
    }
  }

  $('feedStatus').addEventListener('change', loadFeed);
  $('feedMin').addEventListener('change', loadFeed);

  let rescoring = false;
  async function rescore() {
    if (rescoring) return;
    rescoring = true;
    const status = $('rescoreStatus');
    $('rescoreBtn').disabled = true;
    let total = 0;
    try {
      for (;;) {
        const r = await api('/api/me/rescore', { method: 'POST' });
        total += r.scored;
        status.textContent = r.remaining ? `Scored ${total} · ${r.remaining} left...` : `Scored ${total} job${total === 1 ? '' : 's'}.`;
        if (!r.remaining || !r.scored) break;
      }
    } catch (err) {
      status.textContent = '';
      toast(err.message, 'error');
    } finally {
      rescoring = false;
      $('rescoreBtn').disabled = false;
      if (!sections.myjobs.classList.contains('hidden')) loadFeed();
    }
  }
  $('rescoreBtn').addEventListener('click', rescore);

  async function saveJob(job, button) {
    button.disabled = true;
    button.textContent = 'Scoring...';
    try {
      const r = await api('/api/me/jobs', {
        method: 'POST',
        json: { title: job.title, company: job.company, location: job.location, url: job.url, description: job.description, source: 'adzuna' },
      });
      button.textContent = `Saved · ${r.score ?? '—'}/100`;
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Save to my jobs';
      toast(err.message, 'error');
    }
  }

  $('addJobBtn').addEventListener('click', async () => {
    const btn = $('addJobBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/me/jobs', {
        method: 'POST',
        json: { title: $('addJobTitle').value, url: $('addJobUrl').value, description: $('addJobDesc').value },
      });
      ['addJobTitle', 'addJobUrl', 'addJobDesc'].forEach((id) => ($(id).value = ''));
      toast(`Saved. Match score: ${r.score ?? '—'}/100`);
      loadFeed();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- History ----------
  async function loadHistory() {
    const list = $('historyList');
    list.innerHTML = '<p class="hint">Loading...</p>';
    try {
      const { analyses } = await api('/api/me/analyses');
      list.innerHTML = '';
      if (!analyses.length) {
        list.innerHTML = '<p class="hint">No saved analyses yet.</p>';
        return;
      }
      analyses.forEach((a) => {
        const card = document.createElement('button');
        card.className = 'job-card history-card';
        const badge = document.createElement('div');
        badge.className = `score-badge ${scoreClass(a.match_score)}`;
        badge.textContent = a.match_score ?? '—';
        const body = document.createElement('div');
        body.className = 'feed-body';
        const title = document.createElement('h4');
        title.textContent = a.job_title || 'Untitled role';
        const meta = document.createElement('div');
        meta.className = 'job-company';
        meta.textContent = `${new Date(a.created_at).toLocaleString()} · interview ${a.interview_score != null ? a.interview_score + '/100' : 'not taken'}`;
        body.append(title, meta);
        card.append(badge, body);
        card.addEventListener('click', async () => {
          try {
            loadResult(await api(`/api/me/analyses/${a.id}`));
          } catch (err) {
            toast(err.message, 'error');
          }
        });
        list.appendChild(card);
      });
    } catch (err) {
      list.innerHTML = '';
      toast(err.message, 'error');
    }
  }
})();
