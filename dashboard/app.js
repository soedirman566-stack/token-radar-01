// Token Radar's dashboard (radar-2). It reads window.RADAR (written beside dashboard/ by
// main.ts) and renders the ranked board, filters, a per-protocol detail view with the
// model's own inputs and the protocol's farm plan, and the live-token set kept apart.
// No network: every byte it shows is in data.js.
//
// The model, in one function, recomputed here from the snapshot figures so the page's
// numbers and board.json's numbers are visibly the same arithmetic:
//   peer multiple = the category's median market-cap/TVL over its tokenized peers
//                   (computed from the snapshot by main.ts, in DATA.peer_multiples)
//   momentum      = 1 + 0.30 x clamp(change_7d, -50, +100) / 100
//   size          = TVL over $2B compresses: max(0.50, (2e9 / tvl)^0.25), else 1
//   age           = 0.80 + min(age_days, 1095) / 1095 x 0.45 (unknown age: 1.00)
//   junk          = 0.05 for products that cannot be a launch of their own, else 1
//   implied FDV   = tvl x peer multiple x momentum x size x age x junk
//   implied value = round(implied FDV x 0.075 x p(launch))
// No protocol name is special-cased: the same function scores every row.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('app');
  var state = { q: '', category: 'all', chain: 'all', watchlist: false, tier: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };
  var M = DATA.model;

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtProb(p) { return (p * 100).toFixed(1) + '%'; }

  // The model recomputed from the row's own figures, in the same order main.ts uses.
  function impliedOf(row) {
    var growth = Math.min(M.momentum_cap, Math.max(M.momentum_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var momentum = 1 + (growth / 100) * M.momentum_weight;
    var size = row.tvl_usd > M.size_threshold_usd ? Math.max(M.size_floor, Math.pow(M.size_threshold_usd / row.tvl_usd, 0.25)) : 1;
    var age = row.age_days === null || row.age_days === undefined ? 1 : M.age_floor + (Math.min(row.age_days, M.age_days) / M.age_days) * M.age_range;
    var junk = row.junk ? M.junk_discount : 1;
    var fdv = Math.max(1, Math.round(row.tvl_usd * row.peer_multiple * momentum * size * age * junk));
    return { fdv: fdv, implied: Math.max(1, Math.round(fdv * M.airdrop_share * row.launch_probability)) };
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  function tierOf(row) {
    if (row.implied_value_usd >= 50e6) return '50m';
    if (row.implied_value_usd >= 10e6) return '10m';
    if (row.implied_value_usd >= 1e6) return '1m';
    return 'under1m';
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('wl') === '1') state.watchlist = true;
    if (params.get('tier')) state.tier = params.get('tier');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('p')) state.selected = params.get('p');
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watchlist) params.set('wl', '1');
    if (state.tier !== 'all') params.set('tier', state.tier);
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (state.watchlist && !r.watchlist) return false;
      if (state.tier !== 'all' && tierOf(r) !== state.tier) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (key === 'prob') { av = a.launch_probability; bv = b.launch_probability; }
      else if (key === 'fdv') { av = a.implied_fdv_usd; bv = b.implied_fdv_usd; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The board ranks all ' + DATA.board_size + ' genuine pre-token launch candidates. ' + DATA.junk_size + ' more pre-token protocols are set aside below the board, each labelled with why it is not a launch: their token already trades in another form. Implied value is a model, not a promise.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Genuine launch candidates' }), el('b', { text: String(DATA.genuine_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function picks() {
    var top = DATA.rows.filter(function (r) { return !r.junk; }).slice(0, 3);
    return el('section', { class: 'picks', 'aria-label': 'Worth farming now' }, top.map(function (r) {
      var check = impliedOf(r);
      return el('button', { type: 'button', class: 'pick', onclick: function () { openDetail(r.slug); } },
        el('span', { class: 'rank', text: 'Rank ' + r.rank + ' · worth farming now' }),
        el('b', { text: r.name }),
        el('span', { class: 'why', text: (r.category || 'Other') + ' · TVL ' + fmtUsd(r.tvl_usd) + ' · ' + fmtPct(r.change_7d) + ' in 7d · launch chance ' + fmtProb(r.launch_probability) }),
        el('span', { class: 'val', text: fmtUsd(r.implied_value_usd) + ' implied' + (check.implied === r.implied_value_usd ? '' : ' (recheck)') })
      );
    }));
  }

  function selectOptions(values, current, allLabel) {
    var opts = [el('option', { value: 'all', text: allLabel })];
    values.forEach(function (v) { opts.push(el('option', { value: v, text: v, selected: v === current ? 'selected' : null })); });
    return opts;
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = Array.from(new Set(DATA.rows.flatMap(function (r) { return r.chains || []; }))).sort();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var cat = el('select', { id: 'category', 'aria-label': 'Filter by category' }, selectOptions(categories, state.category, 'All categories'));
    cat.addEventListener('change', function () { state.category = cat.value; writeHash(); render(); });
    var chain = el('select', { id: 'chain', 'aria-label': 'Filter by chain' }, selectOptions(chains, state.chain, 'All chains'));
    chain.addEventListener('change', function () { state.chain = chain.value; writeHash(); render(); });
    var tier = el('select', { id: 'tier', 'aria-label': 'Filter by implied value tier' }, [
      el('option', { value: 'all', text: 'Any implied value' }),
      el('option', { value: '50m', text: 'Over $50M', selected: state.tier === '50m' ? 'selected' : null }),
      el('option', { value: '10m', text: '$10M – $50M', selected: state.tier === '10m' ? 'selected' : null }),
      el('option', { value: '1m', text: '$1M – $10M', selected: state.tier === '1m' ? 'selected' : null }),
      el('option', { value: 'under1m', text: 'Under $1M', selected: state.tier === 'under1m' ? 'selected' : null })
    ]);
    tier.addEventListener('change', function () { state.tier = tier.value; writeHash(); render(); });
    var wl = el('label', { class: 'check' },
      el('input', { type: 'checkbox', id: 'wl', checked: state.watchlist ? 'checked' : null, 'aria-label': 'Watchlist only' }),
      'Watchlist only'
    );
    wl.querySelector('input').addEventListener('change', function (e) { state.watchlist = e.target.checked; writeHash(); render(); });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), cat),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chain),
      el('div', { class: 'field' }, el('label', { for: 'tier', text: 'Implied value' }), tier),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Scope' }), wl),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? rows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchlist = false; state.tier = 'all'; writeHash(); render(); } })
      ));
    }
    var max = 0;
    list.forEach(function (r) { if (r.implied_value_usd > max) max = r.implied_value_usd; });
    if (max <= 0) max = 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var nameCell = el('div', { class: 'name' },
        el('span', null,
          el('b', { text: r.name }),
          r.watchlist ? el('span', { class: 'badge', text: 'Watchlist' }) : null,
          r.junk ? el('span', { class: 'badge junk', text: 'Not a launch' }) : null
        ),
        el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
      );
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        class: r.junk ? 'junk-row' : null,
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, nameCell),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', { class: 'num', text: fmtUsd(r.implied_fdv_usd) }),
        el('td', { class: 'num', text: fmtProb(r.launch_probability) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'tier', text: r.effort_tier }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel', id: 'board' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('fdv', 'Implied FDV'),
            sortHeader('prob', 'Launch'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Effort' })
          )),
          tbody
        )
      )
    );
  }

  // The pre-token protocols set aside: scored the same way, shown with the reason
  // each one is not a launch candidate. Not ranked, not farmable for a launch.
  function asideTable() {
    var list = DATA.not_candidates || [];
    if (list.length === 0) return null;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr', { class: 'junk-row' },
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', null, el('span', { class: 'sub', text: r.junk_reason || 'not a launch candidate' }))
      );
      tbody.appendChild(tr);
    });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'Not launch candidates (' + list.length + ')' }),
      el('p', { class: 'sub', text: 'These protocols record no token, but their token already trades in another form: an exchange, a bridge, a wrapped or staked product. They are scored the same way as the board and set aside here, so nobody farms them for a launch that cannot come.' }),
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: 'Why not a launch' }))),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status live', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var peers = DATA.peer_multiples.slice().sort(function (a, b) { return b.peers - a.peers; }).slice(0, 12);
    var peerRows = peers.map(function (p) {
      return el('tr', null,
        el('td', { text: p.category }),
        el('td', { class: 'num', text: String(p.peers) }),
        el('td', { class: 'num', text: String(p.median) }),
        el('td', { class: 'num', text: String(p.multiple) })
      );
    });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        'implied FDV = tvl_usd x peer multiple x (1 + 0.30 x clamp(change_7d, -50, 100) / 100) x size decay x (0.80 + min(age_days, 1095) / 1095 x 0.45) x junk discount (0.05, else 1)\n' +
        'implied value = round(implied FDV x 0.075 x p(launch))\n' +
        'p(launch) = 0.35 + TVL tier x 0.25 + category tokenization rate x 0.25 + age x 0.10 +/- momentum x 0.05, clamped to 0.02..0.85 (junk capped at 0.05)'
      ),
      el('p', { class: 'sub', text: 'The peer multiple is the median market-cap/TVL of the tokenized protocols in the same category, shrunk toward the global median when the category has few peers and clamped to 0.08..1.50. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses 1.00. The 7.5% airdrop share is the assumed share of the implied FDV a farmer could claim. Products whose token already trades in another form (exchanges, bridges, wrapped and staked products) are scored the same way, then set aside below the board with their reason, never ranked as farms.' }),
      el('h3', { text: 'Peer multiples by category (largest categories first)' }),
      el('table', { class: 'peers' },
        el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', text: 'Peers' }), el('th', { scope: 'col', text: 'Median mcap/TVL' }), el('th', { scope: 'col', text: 'Multiple used' }))),
        el('tbody', null, peerRows)
      )
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var check = impliedOf(row);
    var steps = row.farm_steps || [];
    var head = el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' · Watchlist' : '') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') + ' · effort ' + row.effort_tier })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    );
    dialog.appendChild(head);
    if (row.junk) {
      dialog.appendChild(el('p', { class: 'warn', text: 'Not a launch candidate: ' + (row.junk_reason || 'its token already trades in another form') + '. The farm plan below is a warning, not a recommendation.' }));
    }
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Peer multiple (' + (row.category || 'Other') + ')' }), el('b', { class: 'num', text: String(row.peer_multiple) + 'x' })),
        el('div', null, el('span', { text: 'Momentum multiplier' }), el('b', { class: 'num', text: String(row.momentum_multiplier) })),
        el('div', null, el('span', { text: 'Size multiplier' }), el('b', { class: 'num', text: String(row.size_multiplier) })),
        el('div', null, el('span', { text: 'Age multiplier (' + fmtAge(row.age_days) + ' with no token)' }), el('b', { class: 'num', text: String(row.age_multiplier) })),
        el('div', null, el('span', { text: 'Junk discount' }), el('b', { class: 'num', text: String(row.junk_multiplier) })),
        el('div', null, el('span', { text: 'Implied FDV' }), el('b', { class: 'num', text: fmtUsd(row.implied_fdv_usd) })),
        el('div', null, el('span', { text: 'Airdrop share' }), el('b', { class: 'num', text: '7.5%' })),
        el('div', null, el('span', { text: 'Launch probability' }), el('b', { class: 'num', text: fmtProb(row.launch_probability) })),
        el('div', { class: 'total' }, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(check.implied) + (check.implied === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    if (state.tab === 'pre-token') shell.appendChild(picks());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') {
      var aside = asideTable();
      if (aside) shell.appendChild(aside);
      shell.appendChild(modelPanel());
    }
    shell.appendChild(el('p', { class: 'foot', text: 'Token Radar ' + DATA.model_version + ' · snapshot ' + DATA.as_of + ' · implied value is a model, not a price; no token is promised.' }));
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
