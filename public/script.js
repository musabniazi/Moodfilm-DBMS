/* ============================================================
   FILE: script.js — MoodFilm Pro (TMDb Only Version)
   No Gemini API. No quota limits. No rate limiting.
   Everything comes from TMDb — real data, real posters,
   real ratings, unlimited movies, instant search.
============================================================ */

const TMDB_IMG    = 'https://image.tmdb.org/t/p/w500';
const TMDB_IMG_LG = 'https://image.tmdb.org/t/p/w1280';

/* ── MOOD → TMDb GENRE IDs ──────────────────────────────────
   TMDb genre IDs:
   28=Action, 12=Adventure, 16=Animation, 35=Comedy,
   80=Crime, 99=Documentary, 18=Drama, 10751=Family,
   14=Fantasy, 36=History, 27=Horror, 10402=Music,
   9648=Mystery, 10749=Romance, 878=Sci-Fi,
   10770=TV Movie, 53=Thriller, 10752=War, 37=Western
*/
const MOODS = [
  { id:'happy',     label:'Happy',     emoji:'😄', color:'#FF6B6B', desc:'Feel-good & uplifting',  genres:[35,10751,16],    sort:'popularity.desc' },
  { id:'sad',       label:'Sad',       emoji:'😢', color:'#6366F1', desc:'Emotional & moving',     genres:[18],             sort:'vote_average.desc' },
  { id:'romantic',  label:'Romantic',  emoji:'❤️', color:'#EC4899', desc:'Love & passion',         genres:[10749,18],       sort:'popularity.desc' },
  { id:'thriller',  label:'Thriller',  emoji:'🔍', color:'#00F5A0', desc:'Mystery & suspense',     genres:[53,9648,80],     sort:'popularity.desc' },
  { id:'scifi',     label:'Sci-Fi',    emoji:'🤖', color:'#10B981', desc:'Sci-fi & innovation',    genres:[878,14,12],      sort:'popularity.desc' },
  { id:'action',    label:'Action',    emoji:'⚔️', color:'#EF4444', desc:'Intense & adrenaline',   genres:[28,12],          sort:'popularity.desc' },
  { id:'horror',    label:'Horror',    emoji:'👻', color:'#BF5AF2', desc:'Scary & suspenseful',    genres:[27,53],          sort:'popularity.desc' },
  { id:'animation', label:'Animation', emoji:'🎨', color:'#F97316', desc:'Fun for all ages',       genres:[16,10751,35],    sort:'popularity.desc' },
];

const MOOD_GENRES = {
  happy:     [35, 10751, 16],
  sad:       [18, 10749],
  romantic:  [10749, 18],
  thriller:  [53, 9648, 80],
  scifi:     [878, 14, 12],
  action:    [28, 12],
  horror:    [27, 53],
  animation: [16, 10751, 35],
};

async function fetchMoviesForMood(moodId) {
  const genreIds = MOOD_GENRES[moodId] || MOOD_GENRES['happy'];
  try {
    const data = await api('tmdb_mood', { genreIds, page: 1, sortBy: 'popularity.desc' });
    return data.results || [];
  } catch (err) {
    console.error('fetchMoviesForMood error:', err);
    return [];
  }
}

const CONFETTI_COLORS = ['#e50914','#FF6B6B','#00F5A0','#10b981','#f97316','#ec4899','#BF5AF2'];

let state = {
  selectedMood:  null,   /* current mood id */
  currentPage:   1,      /* current TMDb page for load more */
  searchQuery:   '',     /* current search text */
  searchPage:    1,      /* current search page for load more */
  currentMovie:  null,   /* movie shown in modal */
  favorites:     [],     /* saved movies */
  lastAction:    null,   /* for retry button */
  mode:          null,   /* 'mood' or 'search' */
  detectedMood:  null,   /* last ML-detected mood from search */
};


/* ── CALL BACKEND ───────────────────────────────────────────
   All requests go to /api/gemini on the Vercel server.
   The server holds the TMDb key — browser never sees it.
*/
async function api(type, payload = {}) {
  /* Route to correct Vercel Python endpoint based on request type */
  if (type === 'tmdb_mood' || type === 'tmdb_top' || type === 'tmdb_trending' ||
      type === 'tmdb_search' || type === 'tmdb_detail' || type === 'tmdb_similar') {
    const mood = payload.mood || state.selectedMood || 'happy';
    const page = payload.page || 1;
    const res  = await fetch(`/api/gemini?mood=${mood}&page=${page}&type=${type}${payload.query ? '&query=' + encodeURIComponent(payload.query) : ''}${payload.id ? '&id=' + payload.id : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    /* Wrap bare array in { results } for backward compat */
    return Array.isArray(data) ? { results: data } : data;
  }
  throw new Error(`Unknown api type: ${type}`);
}

async function mlApi(type, payload = {}) {
  const res = await fetch('/api/ml', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ type, payload }),
  });
  return res.json();
}

/* ── DB API ─────────────────────────────────────────────── */
async function dbApi(action, body = {}) {
  const res = await fetch(`/api/db?action=${action}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return res.json();
}

/* ── SESSION / USER ─────────────────────────────────────── */
function getOrCreateSessionId() {
  let sid = localStorage.getItem('mf_session_id');
  if (!sid) {
    sid = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    localStorage.setItem('mf_session_id', sid);
  }
  return sid;
}

async function initDbSession() {
  try {
    const sid  = getOrCreateSessionId();
    const data = await dbApi('ensure_user', { session_id: sid });
    if (data.user?.id) {
      state.userId = data.user.id;
      await syncFavoritesFromDb();
      await loadMoodHistoryFromDb();
    }
  } catch (e) {
    console.warn('DB session init failed (offline?):', e);
  }
}

/* ── SYNC FAVORITES FROM DB ─────────────────────────────── */
async function syncFavoritesFromDb() {
  if (!state.userId) return;
  try {
    const data = await dbApi('get_favorites', { user_id: state.userId });
    if (!data.favorites?.length) return;
    /* Merge DB favorites into local state without duplicates */
    const localIds = new Set(state.favorites.map(f => f.id));
    data.favorites.forEach(f => {
      if (!localIds.has(f.movie_id)) {
        state.favorites.push({
          id:           f.movie_id,
          title:        f.movie_title,
          poster:       f.poster_path ? 'https://image.tmdb.org/t/p/w500' + f.poster_path : null,
          rating:       f.vote_average,
          matchScore:   null,
        });
      }
    });
    updateFavCount();
    renderFavsSection();
  } catch (e) {
    console.warn('Sync favorites failed:', e);
  }
}

/* ── LOAD MOOD HISTORY FROM DB → LSTM ──────────────────── */
async function loadMoodHistoryFromDb() {
  if (!state.userId) return;
  try {
    const data = await dbApi('get_mood_history', { user_id: state.userId, limit: 3 });
    if (!data.history?.length) return;
    const map = {
      happy: 'happy', sad: 'sad', romantic: 'romantic',
      thriller: 'anxious', scifi: 'excited', action: 'excited',
      horror: 'anxious', animation: 'happy',
    };
    /* Pre-seed LSTM with last 3 moods (oldest first) */
    const moods = data.history.slice(0, 3).reverse();
    moods.forEach(h => {
      const m = map[h.mood] || h.mood;
      if (LSTM_MOOD_META[m]) {
        lstmMoodHistory.push(m);
        if (lstmMoodHistory.length > 3) lstmMoodHistory.shift();
      }
    });
    renderLstmPills();
  } catch (e) {
    console.warn('Load mood history failed:', e);
  }
}

function showMlBadge(mood, confidence) {
  const badge = document.getElementById('ml-mood-badge');
  if (!badge) return;
  const moodData = MOODS.find(m => m.id === mood);
  const emoji    = moodData?.emoji ?? '🧠';
  /* confidence is now 0-100 */
  badge.innerHTML =
    `🧠 AI detected mood: <span class="badge-label">${emoji} ${mood}</span>` +
    `<span class="badge-conf">(${confidence}% match)</span>`;
  badge.style.display = 'flex';
  badge.onclick = () => pickMood(mood);
}

function hideMlBadge() {
  const badge = document.getElementById('ml-mood-badge');
  if (badge) badge.style.display = 'none';
}

function showMlProcessing(visible) {
  /* No-op: hero input removed; ML Lab section handles its own state */
}

function showMlResult() {
  /* No-op: hero result panel removed */
}

function hideMlResult() {
  /* No-op: hero result panel removed */
}


/* ══════════════════════════════════════════════════════════
   ML LAB (inline section)
══════════════════════════════════════════════════════════ */
let mlLabLastMood = null;

function typeWriter(el, text, speed = 50) {
  if (!el) return;
  el.textContent = '';
  let i = 0;
  const timer = setInterval(() => {
    if (i < text.length) { el.textContent += text.charAt(i); i++; }
    else clearInterval(timer);
  }, speed);
}

async function runMlLab() {
  const textarea = document.getElementById('ml-text-input');
  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) {
    textarea.style.borderColor = '#ef4444';
    setTimeout(() => textarea.style.borderColor = '', 2000);
    showToast('Describe your mood first!', 'info');
    return;
  }

  /* Hide input, show loading, hide result panel */
  document.getElementById('ml-input-wrapper').style.display = 'none';
  document.getElementById('ml-result-panel').style.display = 'none';
  document.getElementById('ml-loading').style.display = 'block';
  const analyzeBtn = document.getElementById('ml-analyze-btn');
  if (analyzeBtn) analyzeBtn.disabled = true;

  let data;
  try {
    const [res] = await Promise.all([
      fetch('/api/ml', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ml_sentiment', payload: { text } }),
      }).then(r => r.json()),
      new Promise(r => setTimeout(r, 2000)),
    ]);
    data = res;
  } catch (err) {
    console.error('ML Lab error:', err);
    document.getElementById('ml-loading').style.display = 'none';
    if (analyzeBtn) analyzeBtn.disabled = false;
    showToast('Something went wrong. Please try again.', 'error');
    return;
  }

  /* Hide loading, re-enable button, show result panel */
  document.getElementById('ml-loading').style.display = 'none';
  if (analyzeBtn) analyzeBtn.disabled = false;
  document.getElementById('ml-result-panel').style.display = 'block';

  const { mood, confidence, keywords_found } = data || {};
  const moodData = MOODS.find(m => m.id === mood);
  const emoji    = moodData?.emoji ?? '🎭';

  /* Typewriter mood display */
  typeWriter(
    document.getElementById('ml-mood-display'),
    `${emoji} ${moodData?.label ?? mood ?? 'Unknown'} — ${confidence ?? 0}% confidence`,
    40
  );

  /* Animate confidence bar */
  setTimeout(() => {
    const bar = document.getElementById('ml-confidence-bar');
    if (bar) bar.style.width = `${confidence ?? 0}%`;
  }, 500);

  /* Keywords */
  const kwEl = document.getElementById('ml-keywords');
  if (kwEl) {
    kwEl.innerHTML = '';
    (keywords_found?.slice(0, 8) ?? []).forEach(kw => {
      const tag = document.createElement('span');
      tag.textContent = kw;
      tag.style.cssText = 'padding:4px 12px; background:rgba(191,90,242,0.2); color:#D580FF; border-radius:20px; font-size:12px; font-weight:600;';
      kwEl.appendChild(tag);
    });
  }

  /* Load movies via pickMood */
  const validMoods = ['happy','sad','romantic','thriller','scifi','action','horror','animation'];
  const moodId = validMoods.includes((mood ?? '').toLowerCase()) ? mood.toLowerCase() : 'happy';
  mlLabLastMood = moodId;

  if (state.userId) {
    dbApi('log_mood', {
      user_id:    state.userId,
      mood:       moodId,
      input_text: text,
      confidence: confidence ?? null,
    }).catch(() => {});
  }

  pickMood(moodId);

  /* Scroll to results */
  setTimeout(() => {
    document.getElementById('results-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 800);
}

function resetMlLab() {
  /* Hide result/loading panels, show input */
  document.getElementById('ml-result-panel').style.display = 'none';
  document.getElementById('ml-loading').style.display = 'none';
  document.getElementById('ml-input-wrapper').style.display = 'flex';

  /* Clear textarea */
  const textarea = document.getElementById('ml-text-input');
  if (textarea) { textarea.value = ''; textarea.style.borderColor = ''; textarea.focus(); }

  /* Reset confidence bar */
  const bar = document.getElementById('ml-confidence-bar');
  if (bar) bar.style.width = '0%';

  /* Re-enable analyze button */
  const analyzeBtn = document.getElementById('ml-analyze-btn');
  if (analyzeBtn) analyzeBtn.disabled = false;

  /* Hide movie results section and Search Again button */
  document.getElementById('results-section').style.display = 'none';
  const wrap = document.getElementById('search-again-wrap');
  if (wrap) wrap.style.display = 'none';

  /* Reset all state variables */
  state.selectedMood = null;
  state.currentPage  = 1;
  state.searchQuery  = '';
  state.searchPage   = 1;
  state.detectedMood = null;
  state.mode         = null;
  state.lastAction   = null;
  mlLabLastMood      = null;

  hideMlBadge();

  document.getElementById('ml-lab')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function mlLabSeeAll() {
  if (!mlLabLastMood) return;
  const moodData = MOODS.find(m => m.id === mlLabLastMood);
  if (moodData) {
    pickMood(mlLabLastMood);
    setTimeout(() => document.getElementById('results-section')?.scrollIntoView({ behavior:'smooth', block:'start' }), 120);
  }
}

function scrollToSection(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}


/* ══════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  state.userId = null;
  loadFavorites();
  renderHeroParticles();
  setupSearch();
  loadTrending();
  initDbSession();
  window.addEventListener('scroll', () => {
    document.getElementById('navbar')?.classList.toggle('scrolled', window.scrollY > 60);
  });
});


/* ══════════════════════════════════════════════════════════
   NAVBAR
══════════════════════════════════════════════════════════ */
function toggleMobileMenu() {
  document.getElementById('nav-links')?.classList.toggle('open');
}

function scrollTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
}


/* ══════════════════════════════════════════════════════════
   HERO PARTICLES
══════════════════════════════════════════════════════════ */
function renderHeroParticles() {
  const c = document.getElementById('hero-particles');
  if (!c) return;
  for (let i = 0; i < 22; i++) {
    const d = document.createElement('div');
    d.className = 'hero-particle';
    d.style.cssText = `
      width:${3+Math.random()*7}px; height:${3+Math.random()*7}px;
      left:${Math.random()*100}%; top:${Math.random()*100}%;
      opacity:${(.15+Math.random()*.5).toFixed(2)};
      animation-duration:${(5+Math.random()*10).toFixed(2)}s;
      animation-delay:${(Math.random()*8).toFixed(2)}s;
    `;
    c.appendChild(d);
  }
}


/* ══════════════════════════════════════════════════════════
   LSTM MOOD PREDICTOR
══════════════════════════════════════════════════════════ */
const LSTM_MOOD_META = {
  happy:     { emoji: '😄', color: '#FF6B6B' },
  sad:       { emoji: '😢', color: '#6366F1' },
  excited:   { emoji: '🎉', color: '#10B981' },
  anxious:   { emoji: '😰', color: '#EF4444' },
  romantic:  { emoji: '❤️', color: '#EC4899' },
  angry:     { emoji: '😠', color: '#DC2626' },
  bored:     { emoji: '😑', color: '#6B7280' },
  nostalgic: { emoji: '🌅', color: '#BF5AF2' },
};

let lstmMoodHistory = [];

function lstmPushMood(moodId) {
  /* Normalize to the 8 LSTM moods — map app moods to closest LSTM mood */
  const map = {
    happy: 'happy', sad: 'sad', romantic: 'romantic',
    thriller: 'anxious', scifi: 'excited', action: 'excited',
    horror: 'anxious', animation: 'happy',
  };
  const lstmMood = map[moodId] || moodId;
  if (!LSTM_MOOD_META[lstmMood]) return;

  lstmMoodHistory.push(lstmMood);
  if (lstmMoodHistory.length > 3) lstmMoodHistory.shift(); /* keep last 3 */
  renderLstmPills();
}

function renderLstmPills() {
  for (let i = 0; i < 3; i++) {
    const pill = document.getElementById(`lstm-pill-${i}`);
    if (!pill) continue;
    const mood = lstmMoodHistory[i];
    if (mood) {
      const meta = LSTM_MOOD_META[mood];
      pill.textContent = `${meta.emoji} ${mood}`;
      pill.style.borderColor = meta.color;
      pill.style.color        = meta.color;
      pill.style.background   = `${meta.color}18`;
      pill.classList.remove('lstm-pill-empty');
    } else {
      pill.textContent = '—';
      pill.style.borderColor = '';
      pill.style.color        = '';
      pill.style.background   = '';
      pill.classList.add('lstm-pill-empty');
    }
  }

  const btn  = document.getElementById('lstm-predict-btn');
  const hint = document.getElementById('lstm-hint');
  if (btn)  btn.disabled = lstmMoodHistory.length < 2;
  if (hint) hint.style.display = lstmMoodHistory.length >= 1 ? 'none' : 'block';
}

async function runLstmPredict() {
  if (lstmMoodHistory.length < 2) {
    showToast('Pick at least 2 moods first!', 'info');
    return;
  }

  document.getElementById('lstm-result').style.display  = 'none';
  document.getElementById('lstm-loading').style.display = 'block';
  document.getElementById('lstm-predict-btn').disabled  = true;

  let data;
  try {
    const res = await fetch('/api/lstm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ mood_history: lstmMoodHistory }),
    });
    data = await res.json();
  } catch (err) {
    document.getElementById('lstm-loading').style.display = 'none';
    document.getElementById('lstm-predict-btn').disabled  = false;
    showToast('LSTM prediction failed. Try again.', 'error');
    return;
  }

  document.getElementById('lstm-loading').style.display = 'none';
  document.getElementById('lstm-predict-btn').disabled  = false;

  const { predicted_mood, confidence, sequence_analysis } = data;
  if (!predicted_mood) {
    showToast('Unexpected response from LSTM.', 'error');
    return;
  }

  renderLstmResult(predicted_mood, confidence, sequence_analysis);
}

function renderLstmResult(predicted, confidence, steps) {
  const pct  = Math.round((confidence || 0) * 100);
  const meta = LSTM_MOOD_META[predicted] || { emoji: '🎭', color: '#BF5AF2' };

  /* ── Sequence timeline ── */
  const timeline = document.getElementById('lstm-timeline');
  if (timeline) {
    const allMoods = [...lstmMoodHistory, predicted];
    timeline.innerHTML = allMoods.map((m, i) => {
      const isPredicted = i === allMoods.length - 1;
      const info = LSTM_MOOD_META[m] || { emoji: '🎭', color: '#BF5AF2' };
      return `
        <div class="lstm-tl-item ${isPredicted ? 'lstm-tl-predicted' : ''}" style="animation-delay:${i * 0.12}s">
          <div class="lstm-tl-dot" style="background:${info.color}; ${isPredicted ? `box-shadow:0 0 12px ${info.color}` : ''}"></div>
          <div class="lstm-tl-mood" style="color:${info.color}">${info.emoji} ${m}</div>
          ${isPredicted ? '<div class="lstm-tl-tag">predicted</div>' : ''}
        </div>
        ${i < allMoods.length - 1 ? `<div class="lstm-tl-arrow" style="animation-delay:${i * 0.12 + 0.06}s">→</div>` : ''}
      `;
    }).join('');
  }

  /* ── Predicted badge ── */
  const badge = document.getElementById('lstm-predicted-badge');
  if (badge) {
    badge.textContent  = `${meta.emoji} ${predicted}`;
    badge.style.color  = meta.color;
    badge.style.borderColor = meta.color;
    badge.style.background  = `${meta.color}18`;
    badge.style.boxShadow   = `0 0 20px ${meta.color}40`;
  }

  /* ── Confidence bar ── */
  document.getElementById('lstm-conf-pct').textContent = `${pct}%`;
  setTimeout(() => {
    const bar = document.getElementById('lstm-conf-bar');
    if (bar) {
      bar.style.width      = `${pct}%`;
      bar.style.background = `linear-gradient(90deg, #BF5AF2, ${meta.color})`;
    }
  }, 100);

  /* ── Step analysis ── */
  const stepEl = document.getElementById('lstm-step-analysis');
  if (stepEl && steps?.length) {
    stepEl.innerHTML = `
      <div class="lstm-steps-title">Per-step gate analysis</div>
      ${steps.map(s => `
        <div class="lstm-step-row">
          <span class="lstm-step-mood">${LSTM_MOOD_META[s.input_mood]?.emoji || ''} ${s.input_mood}</span>
          <span class="lstm-step-arrow">→</span>
          <span class="lstm-step-pred">${LSTM_MOOD_META[s.top_prediction]?.emoji || ''} ${s.top_prediction}</span>
          <div class="lstm-gate-bars">
            <div class="lstm-gate-bar" title="Forget gate: ${(s.forget_gate_avg*100).toFixed(0)}%">
              <div style="width:${s.forget_gate_avg*100}%; background:#6366F1"></div>
              <span>F</span>
            </div>
            <div class="lstm-gate-bar" title="Input gate: ${(s.input_gate_avg*100).toFixed(0)}%">
              <div style="width:${s.input_gate_avg*100}%; background:#10B981"></div>
              <span>I</span>
            </div>
            <div class="lstm-gate-bar" title="Output gate: ${(s.output_gate_avg*100).toFixed(0)}%">
              <div style="width:${s.output_gate_avg*100}%; background:#FF6B6B"></div>
              <span>O</span>
            </div>
          </div>
        </div>
      `).join('')}
    `;
  }

  document.getElementById('lstm-result').style.display = 'block';
  document.getElementById('lstm-section')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetLstm() {
  lstmMoodHistory = [];
  renderLstmPills();
  document.getElementById('lstm-result').style.display  = 'none';
  document.getElementById('lstm-loading').style.display = 'none';
  const bar = document.getElementById('lstm-conf-bar');
  if (bar) { bar.style.width = '0%'; }
  document.getElementById('lstm-conf-pct').textContent = '0%';
}

function pickMood(moodId) {
  state.selectedMood = moodId;
  state.currentPage  = 1;
  state.searchQuery  = '';
  state.mode         = 'mood';

  lstmPushMood(moodId);
  if (state.userId) {
    dbApi('log_mood', { user_id: state.userId, mood: moodId }).catch(() => {});
  }

  const mood = MOODS.find(m => m.id === moodId);

  document.getElementById('results-title').textContent    = `${mood.emoji} ${mood.label} Movies`;
  document.getElementById('results-subtitle').textContent = mood.desc;

  state.lastAction = () => pickMood(moodId);
  showResults();
  fetchMoodMovies(mood, 1, false);
  setTimeout(() => document.getElementById('results-section')?.scrollIntoView({ behavior:'smooth', block:'start' }), 120);
}


/* ══════════════════════════════════════════════════════════
   FETCH MOOD MOVIES FROM TMDb
══════════════════════════════════════════════════════════ */
async function fetchMoodMovies(mood, page, append) {
  if (!append) { showLoading(true); clearGrid(); }
  try {
    /* Get popular movies for this mood's genres */
    const popularData = await api('tmdb_mood', {
      genreIds: mood.genres,
      page,
      sortBy: mood.sort,
    });

    /* Also get top rated for variety (different sort) */
    const topData = await api('tmdb_top', {
      genreIds: mood.genres,
      page,
    });

    /* Merge both lists, remove duplicates */
    const seen = new Set();
    const combined = [];
    for (const m of [...(popularData.results || []), ...(topData.results || [])]) {
      if (!seen.has(m.id) && m.poster_path) {
        seen.add(m.id);
        combined.push(m);
      }
    }

    /* Shuffle for variety */
    combined.sort(() => Math.random() - 0.5);

    showLoading(false);
    const cards = combined.map(formatTMDbMovie);

    if (append) {
      appendGrid(cards, 'movies-grid');
      showToast(`✅ ${cards.length} more movies loaded!`, 'success');
    } else {
      renderGrid(cards, 'movies-grid');
      triggerConfetti();
    }

    state.currentPage = page;

  } catch (err) {
    console.error('fetchMoodMovies error:', err);
    showLoading(false);
    showError('Could not load movies. Please try again.');
  }
}


/* ══════════════════════════════════════════════════════════
   LOAD MORE
══════════════════════════════════════════════════════════ */
async function loadMoreMovies() {
  if (state.mode === 'mood' && state.selectedMood) {
    const mood = MOODS.find(m => m.id === state.selectedMood);
    fetchMoodMovies(mood, state.currentPage + 4, true);

  } else if (state.mode === 'search' && state.searchQuery) {
    fetchSearchMovies(state.searchQuery, state.searchPage + 3, true);

  } else {
    showToast('Pick a mood or search first!', 'info');
  }
}


/* ══════════════════════════════════════════════════════════
   TRENDING
══════════════════════════════════════════════════════════ */
async function loadTrending() {
  const loading = document.getElementById('trending-loading');
  try {
    const data    = await api('tmdb_trending');
    const results = data.results || [];
    if (loading) loading.style.display = 'none';
    const cards = results.map(formatTMDbMovie);
    renderGrid(cards, 'trending-grid');
  } catch (err) {
    console.error('Trending error:', err);
    if (loading) loading.textContent = '⚠️ Could not load trending movies.';
  }
}


/* ══════════════════════════════════════════════════════════
   SEARCH
══════════════════════════════════════════════════════════ */
function setupSearch() {
  /* Hero search input removed — ML Lab textarea handles input */
}

/* Kept for backward-compat; routes to the ML Lab */
async function analyzeMoodAndSuggest() {
  scrollToSection('ml-lab');
}

async function handleSearch() {
  scrollToSection('ml-lab');
}

async function fetchSearchMovies(query, page, append) {
  try {
    const data    = await api('tmdb_search', { query, page });
    const results = (data.results || []).filter(m => m.poster_path);

    if (!append && state.userId) {
      dbApi('log_search', {
        user_id:      state.userId,
        query,
        result_count: results.length,
      }).catch(() => {});
    }

    showLoading(false);
    const cards = results.map(formatTMDbMovie);

    if (append) {
      appendGrid(cards, 'movies-grid');
      showToast(`✅ ${cards.length} more results!`, 'success');
    } else {
      renderGrid(cards, 'movies-grid');
      if (cards.length > 0) {
        triggerConfetti();
        showToast(`Found ${cards.length} movies for "${query}"!`, 'success');
      }
    }

    state.searchPage = page;

  } catch (err) {
    console.error('Search error:', err);
    showLoading(false);
    showError('Search failed. Please try again.');
  }
}

function clearResults() {
  document.getElementById('results-section').style.display = 'none';
  state.searchQuery  = '';
  state.selectedMood = null;
  state.detectedMood = null;
  state.mode         = null;
  hideMlBadge();
}

function retryLastAction() {
  document.getElementById('error-state').style.display = 'none';
  if (state.lastAction) state.lastAction();
}


/* ══════════════════════════════════════════════════════════
   FORMAT TMDb MOVIE OBJECT
   Converts raw TMDb API response into our app's format.
══════════════════════════════════════════════════════════ */
function computeMatchScore(m) {
  const moodId    = state.detectedMood || state.selectedMood;
  const moodData  = MOODS.find(md => md.id === moodId);
  const movieGenres = m.genre_ids || [];

  let score = 0;
  if (moodData?.genres?.length) {
    const overlap = movieGenres.filter(g => moodData.genres.includes(g)).length;
    score = Math.round((overlap / moodData.genres.length) * 100);
  }
  if ((m.vote_average ?? 0) > 7.5) score += 10;
  if ((m.vote_count  ?? 0) > 500)  score += 5;
  return Math.min(100, score);
}

function formatTMDbMovie(m) {
  return {
    id:         m.id,
    title:      m.title || m.original_title || 'Unknown',
    year:       m.release_date?.slice(0,4) || '',
    poster:     m.poster_path   ? TMDB_IMG    + m.poster_path   : null,
    backdrop:   m.backdrop_path ? TMDB_IMG_LG + m.backdrop_path : null,
    rating:     m.vote_average  ? m.vote_average.toFixed(1)     : null,
    plot:       m.overview || '',
    genres:     '',   /* filled by detail call in modal */
    tmdbId:     m.id,
    isAI:       false,
    matchScore: computeMatchScore(m),
  };
}


/* ══════════════════════════════════════════════════════════
   MOVIE CARD RENDERING
══════════════════════════════════════════════════════════ */
function renderGrid(movies, gridId) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.innerHTML = '';
  if (!movies?.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎬</div>
        <h3>No movies found</h3>
        <p>Try a different mood or search term</p>
      </div>`;
    return;
  }
  movies.forEach((m, i) => grid.appendChild(buildCard(m, i)));
}

function appendGrid(movies, gridId) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.querySelector('.empty-state')?.remove();
  movies.forEach((m, i) => grid.appendChild(buildCard(m, i)));
}

function buildMatchBadge(score) {
  if (score == null || (!state.selectedMood && !state.detectedMood)) return '';
  const s = Math.max(0, Math.min(100, score));
  let color, label, cls;
  if (s >= 80) { color = '#00F5A0'; label = '🎯 Perfect Match'; cls = 'match-perfect'; }
  else if (s >= 60) { color = '#FF6B6B'; label = '👍 Good Match'; cls = 'match-good'; }
  else              { color = '#BF5AF2'; label = '🔍 Explore';    cls = ''; }
  return `
    <div class="ml-score-bar ${cls}" title="ML match score: ${s}%">
      <div class="ml-score-meta">
        <span class="ml-score-label">${label}</span>
        <span class="ml-label">ML ${s}%</span>
      </div>
      <div class="ml-score-track">
        <div class="ml-score-fill" style="width:${s}%; background:${color};"></div>
      </div>
    </div>`;
}

function closeDlBanner() {
  const b = document.getElementById('dl-banner');
  if (b) b.style.display = 'none';
  document.body.classList.remove('banner-open');
  document.body.classList.add('banner-closed');
  const nav = document.getElementById('navbar');
  if (nav) nav.style.top = '0';
}

function buildCard(movie, index) {
  const card     = document.createElement('div');
  card.className = 'movie-card';
  card.style.animationDelay = `${index * 0.05}s`;

  const isFav   = state.favorites.some(f => f.id === movie.id);
  const favIcon = isFav ? '❤️' : '🤍';

  const posterHTML = movie.poster
    ? `<img src="${movie.poster}" alt="${esc(movie.title)}" loading="lazy"
         onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
       <div class="poster-fallback" style="display:none;"><div class="poster-fallback-icon">🎬</div><span>${esc(movie.title)}</span></div>`
    : `<div class="poster-fallback"><div class="poster-fallback-icon">🎬</div><span>${esc(movie.title)}</span></div>`;

  card.innerHTML = `
    <div class="movie-poster">
      ${posterHTML}
      <div class="poster-overlay">
        <div class="quick-btns">
          <button class="qbtn" title="Details" onclick="openModalBtn(event)">👁</button>
          <button class="qbtn" title="${isFav?'Remove':'Save'}" onclick="toggleFav(event,${movie.id})">${favIcon}</button>
        </div>
      </div>
      <div class="fav-badge" onclick="toggleFav(event,${movie.id})">${favIcon}</div>
    </div>
    <div class="movie-info">
      <div class="movie-title">${esc(movie.title)}</div>
      <div class="movie-meta">
        <span class="movie-year">${movie.year||'—'}</span>
        ${movie.rating ? `<div class="movie-rating">⭐ ${movie.rating}</div>` : ''}
      </div>
      ${buildMatchBadge(movie.matchScore)}
    </div>
  `;

  card.addEventListener('click', e => {
    if (!e.target.closest('.qbtn') && !e.target.closest('.fav-badge')) openModal(movie);
  });
  card._data = movie;
  return card;
}

function openModalBtn(e) {
  e.stopPropagation();
  const card = e.target.closest('.movie-card');
  if (card?._data) openModal(card._data);
}


/* ══════════════════════════════════════════════════════════
   MODAL — Full movie details from TMDb
══════════════════════════════════════════════════════════ */
async function openModal(movie) {
  state.currentMovie = movie;
  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  const isFav   = state.favorites.some(f => f.id === movie.id);

  /* Show basic info immediately while fetching details */
  content.innerHTML = `
    ${movie.backdrop ? `<div class="modal-hero"><img src="${movie.backdrop}" alt="${esc(movie.title)}" loading="lazy" /><div class="modal-hero-overlay"></div></div>` : ''}
    <div class="modal-body">
      <h2 class="modal-title">${esc(movie.title)}</h2>
      <div class="modal-badges">
        ${movie.year   ? `<span class="mbadge mbadge-year">${movie.year}</span>` : ''}
        ${movie.rating ? `<span class="mbadge mbadge-rating">⭐ ${movie.rating}</span>` : ''}
      </div>
      ${movie.plot ? `<div class="modal-plot"><label>Plot</label>${movie.plot}</div>` : ''}
      <div id="modal-details">
        <div class="loading-text"><span class="spinner-sm"></span> Loading details…</div>
      </div>
      <div class="modal-actions" style="margin-top:20px;">
        <button class="btn-primary" id="fav-modal-btn" onclick="toggleFavModal()">
          ${isFav ? '❤️ Remove Favorite' : '🤍 Save to Favorites'}
        </button>
        <button class="btn-secondary" onclick="closeModalBtn()">Close</button>
      </div>
    </div>
  `;

  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';

  /* Fetch full details in background */
  try {
    const detail = await api('tmdb_detail', { id: movie.id });
    const genres = detail.genres?.map(g => g.name).join(', ') || '';
    const director = detail.credits?.crew?.find(p => p.job === 'Director')?.name || '';
    const cast = detail.credits?.cast?.slice(0,3).map(p => p.name).join(', ') || '';
    const runtime = detail.runtime ? `${detail.runtime} min` : '';
    const tagline = detail.tagline || '';

    const detailSection = document.getElementById('modal-details');
    if (!detailSection) return;

    /* Build badges with full info */
    const badgesEl = content.querySelector('.modal-badges');
    if (badgesEl) {
      badgesEl.innerHTML = `
        ${genres  ? `<span class="mbadge mbadge-genre">${genres}</span>` : ''}
        ${movie.year   ? `<span class="mbadge mbadge-year">${movie.year}</span>` : ''}
        ${movie.rating ? `<span class="mbadge mbadge-rating">⭐ ${movie.rating}</span>` : ''}
        ${runtime ? `<span class="mbadge mbadge-year">${runtime}</span>` : ''}
      `;
    }

    if (tagline) {
      const titleEl = content.querySelector('.modal-title');
      if (titleEl) titleEl.insertAdjacentHTML('afterend', `<p style="color:var(--text2);font-style:italic;font-size:15px;margin-bottom:14px;">"${tagline}"</p>`);
    }

    detailSection.innerHTML = `
      ${director || cast ? `
        <div class="modal-info-grid" style="margin-bottom:16px;">
          ${director ? `<div class="modal-info-item"><label>Director</label><span>${director}</span></div>` : ''}
          ${cast     ? `<div class="modal-info-item"><label>Cast</label><span>${cast}</span></div>`         : ''}
        </div>` : ''}
      ${detail.homepage ? `
        <div style="margin-bottom:16px;">
          <a href="${detail.homepage}" target="_blank" class="btn-ghost" style="display:inline-block;">
            🌐 Official Website
          </a>
        </div>` : ''}
    `;

    /* Update movie object with genres for favorites */
    state.currentMovie = { ...movie, genres, director, cast };

  } catch (err) {
    const detailSection = document.getElementById('modal-details');
    if (detailSection) detailSection.innerHTML = '';
  }
}

function closeModalBtn() {
  document.getElementById('modal-overlay').classList.remove('active');
  document.body.style.overflow = '';
  state.currentMovie = null;
}

function closeModalOverlay(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModalBtn();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const o = document.getElementById('modal-overlay');
    if (o?.classList.contains('active')) closeModalBtn();
  }
});


/* ══════════════════════════════════════════════════════════
   FAVORITES
══════════════════════════════════════════════════════════ */
function loadFavorites() {
  try { state.favorites = JSON.parse(localStorage.getItem('mf_favs') || '[]'); }
  catch { state.favorites = []; }
  updateFavCount();
  if (state.favorites.length > 0) renderFavsSection();
}

function saveFavorites() {
  localStorage.setItem('mf_favs', JSON.stringify(state.favorites));
  updateFavCount();
  renderFavsSection();
}

function toggleFav(e, movieId) {
  e.stopPropagation();
  const card = e.target.closest('.movie-card');
  if (!card?._data) return;
  doToggleFav(card._data);
  const isFav = state.favorites.some(f => f.id === movieId);
  const icon  = isFav ? '❤️' : '🤍';
  const badge = card.querySelector('.fav-badge');
  const qbtn  = card.querySelectorAll('.qbtn')[1];
  if (badge) badge.textContent = icon;
  if (qbtn)  qbtn.textContent  = icon;
}

function toggleFavModal() {
  if (!state.currentMovie) return;
  doToggleFav(state.currentMovie);
  const isFav = state.favorites.some(f => f.id === state.currentMovie.id);
  const btn   = document.getElementById('fav-modal-btn');
  if (btn) btn.textContent = isFav ? '❤️ Remove Favorite' : '🤍 Save to Favorites';
}

function doToggleFav(movie) {
  const idx = state.favorites.findIndex(f => f.id === movie.id);
  if (idx === -1) {
    state.favorites.push(movie);
    showToast(`❤️ "${movie.title}" saved!`, 'success');
    if (state.userId) {
      dbApi('add_favorite', {
        user_id:      state.userId,
        movie_id:     movie.id,
        movie_title:  movie.title,
        poster_path:  movie.poster ? movie.poster.replace('https://image.tmdb.org/t/p/w500', '') : null,
        vote_average: parseFloat(movie.rating) || null,
      }).catch(() => {});
    }
  } else {
    state.favorites.splice(idx, 1);
    showToast(`Removed "${movie.title}"`, 'info');
    if (state.userId) {
      dbApi('remove_favorite', { user_id: state.userId, movie_id: movie.id }).catch(() => {});
    }
  }
  saveFavorites();
}

function updateFavCount() {
  const el = document.getElementById('fav-count');
  if (el) el.textContent = state.favorites.length;
}

function renderFavsSection() {
  const section = document.getElementById('favorites-section');
  if (!section) return;
  if (state.favorites.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  renderGrid(state.favorites, 'favorites-grid');
}

function scrollToFavorites() {
  if (state.favorites.length === 0) { showToast('No favorites yet! Click 🤍 to save movies.','info'); return; }
  document.getElementById('favorites-section')?.scrollIntoView({ behavior:'smooth' });
}


/* ══════════════════════════════════════════════════════════
   CONFETTI
══════════════════════════════════════════════════════════ */
function triggerConfetti() {
  const c = document.getElementById('confetti-container');
  if (!c) return;
  c.innerHTML = '';
  for (let i = 0; i < 35; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-piece';
    p.style.cssText = `
      left:${5+Math.random()*90}%;
      width:${7+Math.random()*9}px; height:${7+Math.random()*9}px;
      border-radius:${Math.random()>.5?'50%':'3px'};
      background:${CONFETTI_COLORS[i%CONFETTI_COLORS.length]};
      animation:confetti ${(1.1+Math.random()*1.5).toFixed(2)}s ${(Math.random()*.7).toFixed(2)}s ease-in both;
    `;
    c.appendChild(p);
  }
  setTimeout(() => { c.innerHTML = ''; }, 2800);
}


/* ══════════════════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════════════════ */
let toastT = null;
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  if (!t) return;
  if (toastT) clearTimeout(toastT);
  t.textContent = msg;
  t.className   = `toast show ${type}`;
  toastT = setTimeout(() => {
    t.classList.add('hide');
    setTimeout(() => { t.className = 'toast'; }, 320);
  }, 3200);
}


/* ══════════════════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════════════════ */
function showLoading(v) {
  const l = document.getElementById('loading-state');
  const e = document.getElementById('error-state');
  if (l) l.style.display = v ? 'block' : 'none';
  if (e) e.style.display = 'none';
}

function showError(msg) {
  document.getElementById('loading-state').style.display = 'none';
  document.getElementById('error-state').style.display   = 'block';
  document.getElementById('error-message').textContent   = msg;
}

function showResults() {
  document.getElementById('results-section').style.display = 'block';
  const wrap = document.getElementById('search-again-wrap');
  if (wrap) wrap.style.display = 'block';
}

function clearGrid() {
  const g = document.getElementById('movies-grid');
  if (g) g.innerHTML = '';
}

function esc(str) {
  return (str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


