(function () {
  'use strict';

  const MAX_GUESSES = 5;
  const DAY_MS = 86400000;

  const EPOCH_Y = 2026, EPOCH_M = 7, EPOCH_D = 5;
  const EPOCH = Date.UTC(EPOCH_Y, EPOCH_M, EPOCH_D);

  const REVEAL_SPEAKER_FROM = 4;
  const MAX_SUGGESTIONS = 8;

  const KEY_GAMES = 'exterminadle:games';
  const KEY_STATS = 'exterminadle:stats';
  const KEY_SEEN_HELP = 'exterminadle:seen-help';

  const MAX_STORED_GAMES = 80;

  const SPOILER_WINDOW = 7;

  const $ = (id) => document.getElementById(id);

  const el = {
    game: $('game'), loading: $('loading'),
    puzzleNo: $('puzzle-no'), puzzleDate: $('puzzle-date'),
    pips: $('pips'), quoteStack: $('quote-stack'),
    guessing: $('guessing'), form: $('guess-form'),
    input: $('guess-input'), suggestions: $('suggestions'),
    submit: $('submit-btn'), hint: $('hint-line'),
    result: $('result'), verdict: $('result-verdict'),
    answerTitle: $('answer-title'), answerMeta: $('answer-meta'),
    unseen: $('unseen'), unseenList: $('unseen-list'),
    share: $('btn-share'), countdown: $('countdown'), countdownLine: $('countdown-line'),
    backdrop: $('modal-backdrop'), help: $('modal-help'), stats: $('modal-stats'),
    btnHelp: $('btn-help'), btnStats: $('btn-stats'), toast: $('toast'),
    archive: $('modal-archive'), archiveList: $('archive-list'), archiveDate: $('archive-date'),
    banner: $('archive-banner'), bannerText: $('banner-text'), puzzleLine: $('puzzle-line'),
    btnArchive: $('btn-archive'), btnRandom: $('btn-random'),
    btnToday: $('btn-today'), btnAnother: $('btn-another'), btnBackToday: $('btn-back-today'),
    btnAnotherBanner: $('btn-another-banner'),
  };

  let episodes = [];
  let episode = null;

  let dayIdx = 0;
  let todayIdx = 0;
  let mode = 'daily';
  let puzzleNo = 0;

  let game = { guesses: [], done: false, won: false };
  let matches = [];
  let activeMatch = -1;
  let countdownTimer = null;

  function normalise(s) {
    return s.toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9 ]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
    }
  }

  function toast(msg, ms = 2200) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  const SHUFFLE_SEED = 0x9e3779b9;
  const orderCache = new Map();

  function orderForLap(lap) {
    const cached = orderCache.get(lap);
    if (cached) return cached;

    const n = episodes.length;
    const order = Array.from({ length: n }, (_, i) => i);
    let state = (SHUFFLE_SEED + Math.imul(lap, 0x6d2b79f5)) >>> 0;
    const rand = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }

    if (lap > 0 && order[0] === orderForLap(lap - 1)[n - 1]) {
      [order[0], order[1]] = [order[1], order[0]];
    }

    orderCache.set(lap, order);
    return order;
  }

  function todayIndex() {
    const now = new Date();
    const localMidnight = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.max(0, Math.floor((localMidnight - EPOCH) / DAY_MS));
  }

  function activeIndex() {
    const forced = new URLSearchParams(location.search).get('day');
    const today = todayIndex();
    if (forced === null || forced === '' || !Number.isFinite(Number(forced))) return today;
    return Math.max(0, Math.min(today, Math.floor(Number(forced))));
  }

  const mod = (n, m) => ((n % m) + m) % m;

  const episodeIndexForDay = (i) => {
    const d = Math.max(0, i);
    return orderForLap(Math.floor(d / episodes.length))[mod(d, episodes.length)];
  };

  const episodeForDay = (i) => episodes[episodeIndexForDay(i)];

  function randomEpisodeIndex() {
    const soon = new Set();
    for (let d = todayIdx; d <= todayIdx + SPOILER_WINDOW; d++) soon.add(episodeIndexForDay(d));
    const current = episodes.indexOf(episode);
    const pool = [];
    for (let i = 0; i < episodes.length; i++) {
      if (i !== current && !soon.has(i)) pool.push(i);
    }
    if (!pool.length) return current >= 0 ? current : 0;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const dateForIndex = (i) => new Date(EPOCH_Y, EPOCH_M, EPOCH_D + i);

  const indexForDate = (d) =>
    Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EPOCH) / DAY_MS);

  const formatDate = (d) =>
    d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

  function isoDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function goToDay(i) {
    location.assign(i === todayIdx ? location.pathname : `${location.pathname}?day=${i}`);
  }

  function goToPractice(i) {
    location.assign(`${location.pathname}?ep=${encodeURIComponent(episodes[i].id)}`);
  }

  const blankStats = () => ({
    played: 0, wins: 0, streak: 0, best: 0, lastPuzzle: null,
    dist: [0, 0, 0, 0, 0],
  });

  function recordResult(stats, won, guessCount, puzzle) {
    stats.played += 1;
    if (won) {
      stats.wins += 1;
      stats.dist[guessCount - 1] += 1;

      stats.streak = stats.lastPuzzle === puzzle - 1 ? stats.streak + 1 : 1;
      stats.best = Math.max(stats.best, stats.streak);
    } else {
      stats.streak = 0;
    }
    stats.lastPuzzle = puzzle;
    return stats;
  }

  function renderStats(highlight) {
    const s = readJSON(KEY_STATS, blankStats());
    $('st-played').textContent = s.played;
    $('st-winpct').textContent = s.played ? Math.round((s.wins / s.played) * 100) : 0;
    $('st-streak').textContent = s.streak;
    $('st-best').textContent = s.best;

    const max = Math.max(1, ...s.dist);
    $('dist').innerHTML = s.dist.map((count, i) => {
      const pct = Math.max(8, (count / max) * 100);
      const cls = ['dist-bar', count ? 'filled' : '', highlight === i + 1 ? 'current' : '']
        .filter(Boolean).join(' ');
      return `<div class="dist-row"><span>${i + 1}</span>` +
             `<span class="${cls}" style="width:${pct}%">${count}</span></div>`;
    }).join('');
  }

  function revealedCount() {
    if (game.done) return game.won ? game.guesses.length : MAX_GUESSES;
    return Math.min(game.guesses.length + 1, MAX_GUESSES);
  }

  function renderPips() {
    const wrong = game.won ? game.guesses.length - 1 : game.guesses.length;
    el.pips.innerHTML = Array.from({ length: MAX_GUESSES }, (_, i) => {
      let cls = '';
      if (i < wrong) cls = 'used';
      else if (game.won && i === wrong) cls = 'won';
      return `<li class="${cls}"></li>`;
    }).join('');
  }

  function renderQuotes() {
    const shown = revealedCount();
    el.quoteStack.innerHTML = episode.quotes.slice(0, shown).map((q, i) => {
      const isLatest = i === shown - 1;
      const speaker = (i + 1) >= REVEAL_SPEAKER_FROM || game.done
        ? `<cite class="quote-speaker">${q.speaker}</cite>`
        : '';
      return `<figure class="quote${isLatest ? '' : ' past'}">` +
             `<span class="quote-num">Fragment ${i + 1} of ${MAX_GUESSES}</span>` +
             `<blockquote class="quote-text">${q.text}</blockquote>${speaker}</figure>`;
    }).join('');
  }

  function renderWrongGuesses() {
    const wrong = game.guesses.filter((g) => g !== episode.title);
    const existing = el.guessing.querySelector('.wrong-list');
    if (existing) existing.remove();
    if (!wrong.length) return;
    const ul = document.createElement('ul');
    ul.className = 'wrong-list';
    ul.innerHTML = wrong.map((g) => `<li>${g}</li>`).join('');
    el.guessing.appendChild(ul);
  }

  function exterminate() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (document.querySelector('.exterminate-fx')) return;

    const fx = document.createElement('div');
    fx.className = 'exterminate-fx';
    fx.setAttribute('aria-hidden', 'true');
    fx.innerHTML = '<span>EXTERMINATE!</span>';
    document.body.appendChild(fx);
    setTimeout(() => fx.remove(), 2000);
  }

  function renderUnseen() {
    const from = revealedCount();
    const rest = episode.quotes.slice(from);
    el.unseen.hidden = rest.length === 0;
    if (!rest.length) { el.unseenList.innerHTML = ''; return; }
    el.unseenList.innerHTML = rest.map((q, i) => (
      `<figure class="unseen-quote">` +
      `<span class="quote-num">Fragment ${from + i + 1} of ${MAX_GUESSES}</span>` +
      `<blockquote class="quote-text">${q.text}</blockquote>` +
      `<cite class="quote-speaker">${q.speaker}</cite></figure>`
    )).join('');
  }

  function renderResult() {
    if (!game.done) { el.result.hidden = true; el.guessing.hidden = false; return; }

    el.guessing.hidden = true;
    el.result.hidden = false;
    el.verdict.textContent = game.won
      ? `Identified in ${game.guesses.length}.`
      : 'EXTERMINATED!';
    el.verdict.className = `result-verdict ${game.won ? 'win' : 'lose'}`;
    el.answerTitle.textContent = episode.title;

    const bits = [];
    if (episode.doctor) bits.push(`${episode.doctor} Doctor`);
    if (episode.series) bits.push(`Series ${episode.series}`);
    if (episode.airdate) bits.push(episode.airdate);
    el.answerMeta.textContent = bits.join(' · ');

    renderUnseen();
    el.btnBackToday.hidden = mode === 'daily';

    el.countdownLine.hidden = mode !== 'daily';
    if (mode === 'daily') startCountdown();
  }

  function renderHint() {
    if (game.done || el.hint.classList.contains('wrong')) return;
    const left = MAX_GUESSES - game.guesses.length;
    el.hint.innerHTML = 'Select from the database. ' +
      `<span id="guesses-left">${left}</span> attempt${left === 1 ? '' : 's'} remain` +
      `${left === 1 ? 's' : ''}.`;
  }

  function render() {
    renderPips();
    renderQuotes();
    renderWrongGuesses();
    renderResult();
    renderHint();
  }

  function statusBadge(entry) {
    if (!entry) return '<span class="badge none">not played</span>';
    if (!entry.done) return '<span class="badge part">in progress</span>';
    return entry.won
      ? `<span class="badge win">${entry.guesses.length}/${MAX_GUESSES}</span>`
      : '<span class="badge lose">missed</span>';
  }

  function renderArchive() {
    const games = loadGames();
    const earliest = dateForIndex(0);

    el.archiveDate.min = isoDate(earliest);
    el.archiveDate.max = isoDate(dateForIndex(todayIdx));
    el.archiveDate.value = isoDate(dateForIndex(dayIdx));

    const from = Math.max(0, todayIdx - 29);
    const rows = [];
    for (let i = todayIdx; i >= from; i--) {
      const label = formatDate(dateForIndex(i)) + (i === todayIdx ? ' (today)' : '');
      rows.push(
        `<li><button type="button" class="archive-row${i === dayIdx ? ' current' : ''}" data-day="${i}">` +
        `<span class="ar-date">${label}</span>` +
        `<span class="ar-no">#${i + 1}</span>${statusBadge(games[i + 1])}</button></li>`,
      );
    }
    el.archiveList.innerHTML = rows.join('');
  }

  function closeSuggestions() {
    el.suggestions.hidden = true;
    el.suggestions.innerHTML = '';
    el.input.setAttribute('aria-expanded', 'false');
    el.input.removeAttribute('aria-activedescendant');
    matches = [];
    activeMatch = -1;
  }

  function renderSuggestions() {
    if (!matches.length) return closeSuggestions();
    el.suggestions.innerHTML = matches.map((ep, i) => (
      `<li id="sug-${i}" role="option" aria-selected="${i === activeMatch}" data-i="${i}">` +
      `${ep.title}<span class="sug-meta">S${ep.series}</span></li>`
    )).join('');
    el.suggestions.hidden = false;
    el.input.setAttribute('aria-expanded', 'true');
    if (activeMatch >= 0) el.input.setAttribute('aria-activedescendant', `sug-${activeMatch}`);
  }

  function updateMatches() {
    const q = normalise(el.input.value);
    const already = new Set(game.guesses);
    if (!q) { closeSuggestions(); el.submit.disabled = true; return; }

    const starts = [];
    const contains = [];
    for (const ep of episodes) {
      if (already.has(ep.title)) continue;
      const idx = ep.norm.indexOf(q);
      if (idx === 0) starts.push(ep);
      else if (idx > 0) contains.push(ep);
      if (starts.length >= MAX_SUGGESTIONS) break;
    }
    matches = starts.concat(contains).slice(0, MAX_SUGGESTIONS);
    activeMatch = matches.length ? 0 : -1;
    renderSuggestions();
    el.submit.disabled = !exactMatch();
  }

  function exactMatch() {
    const q = normalise(el.input.value);
    return episodes.find((ep) => ep.norm === q) || null;
  }

  function chooseSuggestion(i) {
    const ep = matches[i];
    if (!ep) return;
    el.input.value = ep.title;
    closeSuggestions();
    el.submit.disabled = false;
    el.input.focus();
  }

  function loadGames() {
    const games = readJSON(KEY_GAMES, null);
    return games && typeof games === 'object' ? games : {};
  }

  function gameKey() {
    return mode === 'practice' ? `ep:${episode.id}` : String(puzzleNo);
  }

  function saveState() {
    const key = gameKey();
    const games = loadGames();
    games[key] = {
      guesses: game.guesses, done: game.done, won: game.won, t: Date.now(),
    };

    const keys = Object.keys(games)
      .sort((a, b) => (games[b].t || 0) - (games[a].t || 0));
    for (const k of keys.slice(MAX_STORED_GAMES)) if (k !== key) delete games[k];
    writeJSON(KEY_GAMES, games);
  }

  function submitGuess(title) {
    if (game.done) return;
    game.guesses.push(title);

    if (title === episode.title) {
      game.won = true;
      game.done = true;
    } else if (game.guesses.length >= MAX_GUESSES) {
      game.done = true;
    }

    if (game.done) {
      if (!game.won) exterminate();
      if (mode === 'daily') {
        const stats = recordResult(
          readJSON(KEY_STATS, blankStats()),
          game.won, game.guesses.length, puzzleNo,
        );
        writeJSON(KEY_STATS, stats);
        setTimeout(() => {
          renderStats(game.won ? game.guesses.length : null);
          openModal(el.stats);
        }, 1400);
      }
    } else {
      el.hint.textContent = 'Incorrect. Additional data released.';
      el.hint.classList.add('wrong');
      setTimeout(() => { el.hint.classList.remove('wrong'); renderHint(); }, 1600);
    }

    el.input.value = '';
    closeSuggestions();
    el.submit.disabled = true;
    saveState();
    render();
  }

  function shareText() {
    const score = game.won ? `${game.guesses.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
    const wrong = game.won ? game.guesses.length - 1 : MAX_GUESSES;
    const squares = '\u{1F7E5}'.repeat(wrong) + (game.won ? '\u{1F7E9}' : '');

    const label = mode === 'practice'
      ? 'Exterminadle (practice)'
      : `Exterminadle #${puzzleNo}${mode === 'archive' ? ' (archive)' : ''}`;
    return `${label} ${score}\n${squares}\n${location.origin}${location.pathname}`;
  }

  async function doShare() {
    const text = shareText();
    try {
      await navigator.clipboard.writeText(text);
      toast('Transmission copied');
    } catch {
      if (navigator.share) {
        try { await navigator.share({ text }); return; } catch {  }
      }
      toast('Transmission failed. Select the text manually');
    }
  }

  function startCountdown() {
    if (countdownTimer) return;
    const tick = () => {
      const now = new Date();

      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      let s = Math.max(0, Math.floor((next.getTime() - now.getTime()) / 1000));
      const h = String(Math.floor(s / 3600)).padStart(2, '0');
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const sec = String(s % 60).padStart(2, '0');
      el.countdown.textContent = `${h}:${m}:${sec}`;
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  let lastFocus = null;

  const MODALS = () => [el.help, el.stats, el.archive];

  function openModal(modal) {
    lastFocus = document.activeElement;
    el.backdrop.hidden = false;
    for (const m of MODALS()) m.hidden = m !== modal;
    modal.querySelector('.close-btn').focus();
  }

  function closeModal() {
    el.backdrop.hidden = true;
    for (const m of MODALS()) m.hidden = true;
    if (lastFocus) lastFocus.focus();
    else if (!game.done) el.input.focus();
  }

  function bindEvents() {
    el.input.addEventListener('input', updateMatches);

    el.input.addEventListener('keydown', (e) => {
      if (el.suggestions.hidden) {
        if (e.key === 'ArrowDown') { updateMatches(); e.preventDefault(); }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        activeMatch = (activeMatch + step + matches.length) % matches.length;
        renderSuggestions();
      } else if (e.key === 'Enter' && activeMatch >= 0 && !exactMatch()) {
        e.preventDefault();
        chooseSuggestion(activeMatch);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeSuggestions();
      } else if (e.key === 'Tab' && activeMatch >= 0) {
        e.preventDefault();
        chooseSuggestion(activeMatch);
      }
    });

    el.suggestions.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li) { e.preventDefault(); chooseSuggestion(Number(li.dataset.i)); }
    });

    el.input.addEventListener('blur', () => setTimeout(closeSuggestions, 120));

    el.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const ep = exactMatch();
      if (!ep) { toast('Select a title from the database'); return; }
      if (game.guesses.includes(ep.title)) { toast('That title has already been attempted'); return; }
      submitGuess(ep.title);
    });

    el.share.addEventListener('click', doShare);
    el.btnHelp.addEventListener('click', () => openModal(el.help));
    el.btnStats.addEventListener('click', () => { renderStats(null); openModal(el.stats); });
    el.btnArchive.addEventListener('click', () => { renderArchive(); openModal(el.archive); });

    for (const btn of [el.btnRandom, el.btnAnother, el.btnAnotherBanner]) {
      btn.addEventListener('click', () => goToPractice(randomEpisodeIndex()));
    }
    for (const btn of [el.btnToday, el.btnBackToday]) {
      btn.addEventListener('click', () => goToDay(todayIdx));
    }

    el.archiveList.addEventListener('click', (e) => {
      const btn = e.target.closest('.archive-row');
      if (btn) goToDay(Number(btn.dataset.day));
    });

    el.archiveDate.addEventListener('change', () => {
      const [y, m, d] = el.archiveDate.value.split('-').map(Number);
      if (!y || !m || !d) return;

      const i = indexForDate(new Date(y, m - 1, d));
      if (i < 0 || i > todayIdx) { toast('No record for that date'); return; }
      goToDay(i);
    });

    el.backdrop.addEventListener('click', (e) => {
      if (e.target === el.backdrop || e.target.hasAttribute('data-close')) closeModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.backdrop.hidden) closeModal();
    });
  }

  async function init() {
    let data;
    try {
      const res = await fetch('data/episodes.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      el.loading.textContent =
        'Could not load the episode data. If you opened this file directly, serve the folder over HTTP instead.';
      console.error(err);
      return;
    }

    episodes = data.episodes.map((ep) => ({ ...ep, norm: normalise(ep.title) }));
    episodes.sort((a, b) => a.title.localeCompare(b.title, 'en'));

    todayIdx = todayIndex();

    const epParam = new URLSearchParams(location.search).get('ep');
    const practice = epParam ? episodes.findIndex((e) => e.id === epParam) : -1;

    if (practice >= 0) {
      mode = 'practice';
      episode = episodes[practice];
      dayIdx = todayIdx;
    } else {
      dayIdx = activeIndex();
      mode = dayIdx === todayIdx ? 'daily' : 'archive';
      puzzleNo = dayIdx + 1;
      episode = episodeForDay(dayIdx);
    }

    const saved = loadGames()[gameKey()];
    if (saved) {
      game = { guesses: saved.guesses || [], done: !!saved.done, won: !!saved.won };
    }

    el.banner.hidden = mode === 'daily';
    el.btnAnotherBanner.hidden = mode !== 'practice';
    el.bannerText.textContent = mode === 'practice'
      ? 'Practice drill, target selected at random. Your record is not affected.'
      : 'Archive interrogation. Your record is not affected.';

    if (mode === 'practice') {
      el.puzzleLine.textContent = 'Practice drill';
    } else {
      el.puzzleNo.textContent = `#${puzzleNo}`;
      el.puzzleDate.textContent = formatDate(dateForIndex(dayIdx));
    }

    el.loading.hidden = true;
    el.game.hidden = false;
    bindEvents();
    render();

    if (!localStorage.getItem(KEY_SEEN_HELP)) {
      openModal(el.help);
      try { localStorage.setItem(KEY_SEEN_HELP, '1'); } catch {  }
    } else if (!game.done) {
      el.input.focus();
    }
  }

  init();
})();
