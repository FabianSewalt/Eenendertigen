'use strict';
/* ============================================================
   31en — kaartspel
   app.js : deck + scoring, spelmotor, gedeelde rendering en de
            lokale "doorgeef" modus. online.js hangt hierop.
   ============================================================ */

var App = (function () {

  var VERSION = '1.1.0';

  /* ---------------- kaarten ---------------- */

  var SUITS = [
    { k: 'sp', sym: '\u2660', red: false, name: 'schoppen' },
    { k: 'ha', sym: '\u2665', red: true, name: 'harten' },
    { k: 'ru', sym: '\u2666', red: true, name: 'ruiten' },
    { k: 'kl', sym: '\u2663', red: false, name: 'klaveren' }
  ];
  var RANKS = [
    { k: '7', v: 7 }, { k: '8', v: 8 }, { k: '9', v: 9 }, { k: '10', v: 10 },
    { k: 'B', v: 10 }, { k: 'V', v: 10 }, { k: 'H', v: 10 }, { k: 'A', v: 11 }
  ];

  function suitOf(k) { for (var i = 0; i < SUITS.length; i++) if (SUITS[i].k === k) return SUITS[i]; }
  function valOf(r) { for (var i = 0; i < RANKS.length; i++) if (RANKS[i].k === r) return RANKS[i].v; return 0; }

  function buildDeck() {
    var d = [], i, j, t;
    for (i = 0; i < SUITS.length; i++) for (j = 0; j < RANKS.length; j++) d.push({ r: RANKS[j].k, s: SUITS[i].k });
    for (i = d.length - 1; i > 0; i--) { j = Math.floor(Math.random() * (i + 1)); t = d[i]; d[i] = d[j]; d[j] = t; }
    return d;
  }

  /* Beste hand: som van kaarten in dezelfde kleur. Drie dezelfde = 30.5 */
  function best(hand) {
    if (!hand || hand.length < 3) return { score: 0, suit: null, trio: false };
    var sums = {}, k;
    for (var i = 0; i < hand.length; i++) {
      k = hand[i].s;
      sums[k] = (sums[k] || 0) + valOf(hand[i].r);
    }
    var sc = 0, su = hand[0].s;
    for (k in sums) if (sums[k] > sc) { sc = sums[k]; su = k; }
    var trio = hand[0].r === hand[1].r && hand[1].r === hand[2].r;
    if (trio && 30.5 > sc) return { score: 30.5, suit: null, trio: true };
    return { score: sc, suit: su, trio: trio };
  }

  function fmt(n) { return n === 30.5 ? '30\u00BD' : String(n); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- instellingen ---------------- */

  var LS = '31en.settings';
  var DEFAULTS = {
    names: ['Speler 1', 'Speler 2', 'Speler 3'],
    lives: 3,
    rules: { bokMode: 'first', knockPenalty: false, instant31: true, allowPass: false }
  };
  var S = clone(DEFAULTS);

  function loadSettings() {
    try {
      var raw = localStorage.getItem(LS);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && o.names && o.names.length >= 2) S.names = o.names.slice(0, 5);
      if (o && o.lives) S.lives = o.lives;
      if (o && o.rules) for (var k in DEFAULTS.rules) if (k in o.rules) S.rules[k] = o.rules[k];
    } catch (e) { /* privé-modus: gewoon defaults */ }
  }
  function saveSettings() {
    try { localStorage.setItem(LS, JSON.stringify(S)); } catch (e) { }
  }

  /* ---------------- spelmotor ---------------- */

  function newGame(playerMeta, lives, rules) {
    var g = {
      rules: clone(rules),
      players: playerMeta.map(function (m, i) {
        return { id: i, pid: m.pid || null, name: m.name, lives: lives, onBok: false, hadBok: false, out: false, hand: [] };
      }),
      round: 0, startIdx: 0, bokTaken: false, result: null, note: null, phase: 'turn'
    };
    return dealRound(g, 0);
  }

  function dealRound(g, startIdx) {
    var deck = buildDeck();
    g.round += 1;
    g.startIdx = startIdx;
    for (var i = 0; i < g.players.length; i++) {
      g.players[i].hand = g.players[i].out ? [] : [deck.pop(), deck.pop(), deck.pop()];
    }
    g.middle = [deck.pop(), deck.pop(), deck.pop()];
    g.blind = deck.pop();
    g.deck = deck;
    g.middleOpen = false;
    g.current = startIdx;
    g.knocker = null;
    g.endWay = null;
    g.passStreak = 0;
    g.instant = null;
    g.result = null;
    g.note = null;
    g.phase = 'turn';
    return g;
  }

  function activeCount(g) {
    var n = 0;
    for (var i = 0; i < g.players.length; i++) if (!g.players[i].out) n++;
    return n;
  }
  function nextIdx(g, from) {
    var i = from;
    for (var k = 0; k < g.players.length; k++) {
      i = (i + 1) % g.players.length;
      if (!g.players[i].out) return i;
    }
    return from;
  }
  function isBlindTurn(g) { return !g.middleOpen && g.current === g.startIdx; }

  /* Voert een zet uit. Geeft true terug als de zet geldig was. */
  function applyAction(g, a) {
    if (g.phase !== 'turn') return false;
    var p = g.players[g.current], t;
    g.note = null;

    if (isBlindTurn(g)) {
      if (a.type === 'blindTake') { t = p.hand; p.hand = g.middle; g.middle = t; g.middleOpen = true; }
      else if (a.type === 'blindKeep' || a.type === 'skip') { g.middleOpen = true; }
      else return false;
      g.passStreak = 0;
    } else if (a.type === 'skip') {
      /* Noodgreep van de host voor een speler die weg is. Kloppen zorgt
         dat de ronde hoe dan ook afloopt; is er al geklopt, dan slaan we
         de beurt gewoon over. */
      if (g.knocker === null) { g.knocker = g.current; g.endWay = 'skip'; }
      g.passStreak = 0;
    } else {
      switch (a.type) {
        case 'swapOne':
          if (!g.middleOpen || a.i == null || a.m == null) return false;
          t = p.hand[a.i]; p.hand[a.i] = g.middle[a.m]; g.middle[a.m] = t; g.passStreak = 0; break;
        case 'swapAll':
          /* Alle drie ruilen sluit de ronde: de rest krijgt nog één beurt.
             De blinde ruil van de beginner telt hier niet mee, die loopt
             via de tak hierboven. */
          if (!g.middleOpen) return false;
          t = p.hand; p.hand = g.middle; g.middle = t; g.passStreak = 0;
          if (g.knocker === null) { g.knocker = g.current; g.endWay = 'swapAll'; }
          break;
        case 'swapBlind':
          if (a.i == null) return false;
          t = p.hand[a.i]; p.hand[a.i] = g.blind; g.blind = t; g.passStreak = 0; break;
        case 'pass':
          /* Niks doen mag altijd in de laatste ronde nadat iemand heeft
             geklopt of alles heeft geruild; daarbuiten alleen als de
             huisregel het toestaat. */
          if (!g.rules.allowPass && g.knocker === null) return false;
          g.passStreak += 1; break;
        case 'knock':
          if (g.knocker !== null) return false;
          g.knocker = g.current; g.endWay = 'knock'; g.passStreak = 0; break;
        default: return false;
      }
    }
    endTurn(g);
    return true;
  }

  function endTurn(g) {
    var sc = best(g.players[g.current].hand).score;
    if (g.rules.instant31 && sc === 31) { g.instant = g.current; return reveal(g); }
    if (g.knocker !== null && nextIdx(g, g.current) === g.knocker) return reveal(g);
    if (g.rules.allowPass && g.knocker === null && g.passStreak >= activeCount(g)) {
      if (g.deck.length >= 3) {
        g.middle = [g.deck.pop(), g.deck.pop(), g.deck.pop()];
        g.passStreak = 0;
        g.note = 'Iedereen paste \u2014 drie nieuwe kaarten in het midden.';
      } else { return reveal(g); }
    }
    g.current = nextIdx(g, g.current);
  }

  function loseLife(g, p) {
    if (p.out) return;
    if (p.lives > 0) {
      p.lives -= 1;
      if (p.lives === 0) {
        var eligible = !p.hadBok && (g.rules.bokMode === 'all' || !g.bokTaken);
        if (eligible) { p.onBok = true; p.hadBok = true; g.bokTaken = true; }
        else p.out = true;
      }
    } else if (p.onBok) { p.onBok = false; p.out = true; }
    else p.out = true;
  }

  function reveal(g) {
    var rows = [], i;
    for (i = 0; i < g.players.length; i++) {
      if (g.players[i].out) continue;
      var b = best(g.players[i].hand);
      rows.push({ i: i, score: b.score, suit: b.suit, hand: clone(g.players[i].hand) });
    }
    var losers = [], deltas = {}, min, k;
    if (g.instant !== null) {
      for (k = 0; k < rows.length; k++) if (rows[k].i !== g.instant) losers.push(rows[k].i);
    } else {
      min = rows[0].score;
      for (k = 1; k < rows.length; k++) if (rows[k].score < min) min = rows[k].score;
      for (k = 0; k < rows.length; k++) if (rows[k].score === min) losers.push(rows[k].i);
    }
    for (k = 0; k < losers.length; k++) deltas[losers[k]] = 1;
    if (g.rules.knockPenalty && g.endWay === 'knock' && deltas[g.knocker]) deltas[g.knocker] = 2;
    for (k in deltas) for (i = 0; i < deltas[k]; i++) loseLife(g, g.players[+k]);

    g.result = {
      rows: rows, losers: losers, deltas: deltas,
      instant: g.instant, knocker: g.knocker,
      draw: activeCount(g) === 0
    };
    g.phase = activeCount(g) <= 1 ? 'gameover' : 'reveal';
  }

  function nextRound(g) { return dealRound(g, nextIdx(g, g.startIdx)); }

  /* Publieke projectie voor online: geen handen, geen blinde kaart,
     midden alleen als het open ligt. */
  function publicState(g) {
    return {
      round: g.round,
      phase: g.phase,
      players: g.players.map(function (p) {
        return { id: p.id, pid: p.pid, name: p.name, lives: p.lives, onBok: p.onBok, out: p.out };
      }),
      current: g.current,
      startIdx: g.startIdx,
      middleOpen: g.middleOpen,
      middle: g.middleOpen ? g.middle : null,
      deck: g.deck.length,
      knocker: g.knocker,
      endWay: g.endWay,
      instant: g.instant,
      note: g.note,
      result: g.result,
      rules: g.rules
    };
  }

  /* ---------------- rendering: bouwstenen ---------------- */


  /* Hoe de ronde is dichtgegooid, in woorden. */
  function endWayText(st, form) {
    var w = st.endWay;
    if (form === 'short') return w === 'swapAll' ? 'ruilde alles' : w === 'skip' ? 'overgeslagen' : 'klopte';
    if (w === 'swapAll') return 'heeft alle drie geruild';
    if (w === 'skip') return 'is overgeslagen';
    return 'heeft geklopt';
  }

  function cardHTML(card, o) {
    o = o || {};
    var cls = ['card'];
    if (o.size) cls.push(o.size);
    if (o.dim) cls.push('dim');
    if (o.sel) cls.push('sel');
    if (o.act) cls.push('tap');
    var attrs = o.act ? ' data-act="' + o.act + '"' : '';
    if (o.down || !card) {
      cls.push('back');
      return '<div class="' + cls.join(' ') + '"' + attrs + '><span class="mark">31</span></div>';
    }
    var s = suitOf(card.s);
    if (s.red) cls.push('red');
    return '<div class="' + cls.join(' ') + '"' + attrs + '>' +
      '<span class="corner">' + card.r + '</span>' +
      '<span class="pip">' + s.sym + '</span>' +
      '<span class="rank">' + card.r + '</span></div>';
  }

  function meterHTML(b) {
    var pct = Math.max(0, Math.min(1, (b.score - 7) / 24)) * 100;
    var hot = b.score >= 31;
    var suit = b.suit ? suitOf(b.suit) : null;
    return '<div class="meter"><div class="head">' +
      '<span class="eyebrow">jouw stand</span>' +
      '<span class="score' + (hot ? ' hot' : '') + '">' + fmt(b.score) +
      (suit ? ' <span class="' + (suit.red ? 'suit-r' : 'suit-b') + '">' + suit.sym + '</span>' : '') +
      '</span></div><div class="track"><div class="fill" style="width:' + pct + '%"></div></div></div>';
  }

  function livesHTML(p) {
    if (p.out) return '<span style="color:var(--mint-dim)">uit</span>';
    var h = '<span class="hearts">' + new Array(p.lives + 1).join('\u2665') + '</span>';
    if (p.lives === 0 && !p.onBok) h += '<span style="color:var(--mint-dim)">\u2014</span>';
    if (p.onBok) h += '<span class="bok" title="op de bok">\uD83D\uDC10</span>';
    return h;
  }

  function scoresHTML(st) {
    var out = '<div class="scores"><div class="row between" style="margin-bottom:6px">' +
      '<span class="eyebrow">Ronde ' + st.round + '</span>' +
      '<button class="linkbtn" data-act="stop">Stoppen \u00D7</button></div><div class="list">';
    for (var i = 0; i < st.players.length; i++) {
      var p = st.players[i];
      out += '<span class="' + (p.out ? 'out' : '') + '">' + esc(p.name) + ' ' + livesHTML(p) + '</span>';
    }
    return out + '</div></div>';
  }

  /* Speeltafel. st = publieke staat, myHand = eigen kaarten (of null),
     canAct = mag deze viewer nu zetten doen. */
  function boardHTML(st, myHand, canAct, sel) {
    var blindTurn = !st.middleOpen && st.current === st.startIdx;
    var html = scoresHTML(st);

    html += '<div class="eyebrow mb">Midden' + (st.middleOpen ? '' : ' \u2014 nog dicht') + '</div>';
    html += '<div class="middle">';
    for (var i = 0; i < 3; i++) {
      var c = st.middle ? st.middle[i] : null;
      html += cardHTML(c, {
        down: !st.middleOpen,
        dim: st.middleOpen && sel === null,
        act: canAct && st.middleOpen && sel !== null ? 'mid:' + i : null
      });
    }
    html += '<div class="blindwrap">' +
      cardHTML(null, { down: true, dim: !(canAct && st.middleOpen && sel !== null), act: canAct && st.middleOpen && sel !== null ? 'blind' : null }) +
      '<div class="lbl">blind</div></div>';
    html += '</div>';
    html += '<div class="sub" style="margin:6px 0 20px">' + st.deck + ' kaarten op stapel</div>';

    if (myHand && myHand.length) {
      html += '<div class="eyebrow mb">Jouw hand</div><div class="hand">';
      for (i = 0; i < myHand.length; i++) {
        html += cardHTML(myHand[i], { size: 'lg', sel: sel === i, act: canAct && !blindTurn ? 'selCard:' + i : null });
      }
      html += '</div><div style="margin:16px 0 18px">' + meterHTML(best(myHand)) + '</div>';
    }

    if (!canAct) {
      html += '<div class="panel" style="text-align:center"><div class="sub">Aan de beurt</div>' +
        '<div style="font-family:var(--serif);font-size:22px;font-weight:700;color:var(--brass)">' +
        esc(st.players[st.current].name) + '</div></div>';
      return html;
    }

    if (blindTurn) {
      html += '<p class="mint" style="font-size:13px;margin:0 0 12px">Je bent als eerste aan de beurt. Je mag blind je hele hand ruilen met de drie dichte kaarten in het midden \u2014 je ziet ze pas daarna.</p>' +
        '<div class="pair"><button class="btn primary" data-act="blindTake">Blind ruilen</button>' +
        '<button class="btn" data-act="blindKeep">Houden</button></div>';
      return html;
    }

    var lastLap = st.knocker !== null;
    html += '<p class="sub" style="margin:0 0 10px;min-height:18px">' +
      (sel === null ? 'Tik een kaart uit je hand om te ruilen.' : 'Tik nu een middenkaart, of de blinde kaart.') + '</p>';

    /* In de laatste ronde mag je ook niks doen, ook als passen normaal
       niet mag. Buiten de laatste ronde hangt het aan de huisregel. */
    var showPass = st.rules.allowPass || lastLap;
    html += '<div class="pair" style="margin-bottom:10px">' +
      '<button class="btn" data-act="swapAll"' + (sel !== null ? ' disabled' : '') + '>Alle drie ruilen</button>' +
      (showPass ? '<button class="btn" data-act="pass"' + (sel !== null ? ' disabled' : '') + '>' +
        (lastLap ? 'Niks doen' : 'Passen') + '</button>' : '') +
      '</div>';

    if (lastLap) {
      html += '<p class="sub" style="text-align:center;color:var(--red-soft)">' +
        esc(st.players[st.knocker].name) + ' ' + endWayText(st) + ' \u2014 dit is je laatste beurt.</p>';
    } else {
      html += '<button class="btn danger" data-act="knock"' + (sel !== null ? ' disabled' : '') + '>Kloppen</button>' +
        '<p class="sub" style="text-align:center;margin-top:10px">Kloppen of alle drie ruilen sluit de ronde: iedereen krijgt daarna nog \u00e9\u00e9n beurt.</p>';
    }
    return html;
  }

  function revealHTML(st, titleOverride) {
    var r = st.result;
    var rows = r.rows.slice().sort(function (a, b) { return b.score - a.score; });
    var over = st.phase === 'gameover';
    var survivor = null, i;
    for (i = 0; i < st.players.length; i++) if (!st.players[i].out) survivor = st.players[i];

    var title = titleOverride || (over
      ? (r.draw ? 'Gelijkspel' : survivor ? esc(survivor.name) + ' wint' : 'Spel klaar')
      : r.instant !== null ? esc(st.players[r.instant].name) + ' had 31' : 'Kaarten op tafel');

    var html = scoresHTML(st);
    html += '<h1 class="title">' + title + '</h1>';
    html += '<p class="sub mb">' + (r.draw
      ? 'Even laag, en allebei het laatste leven kwijt \u2014 niemand wint.'
      : r.instant !== null
        ? 'Iedereen behalve hem verliest een leven.'
        : 'Laagste hand verliest een leven.') + '</p>';

    for (i = 0; i < rows.length; i++) {
      var row = rows[i], p = st.players[row.i], lost = r.deltas[row.i];
      html += '<div class="revrow"><div class="row between" style="margin-bottom:8px">' +
        '<span class="nm' + (lost ? ' lost' : '') + '">' + esc(p.name) +
        (r.knocker === row.i ? '<span class="sub" style="font-weight:400"> \u00B7 ' + endWayText(st, 'short') + '</span>' : '') + '</span>' +
        '<span class="row">' + (lost ? '<span class="delta">\u2212' + lost + '</span>' : '') +
        livesHTML(p) + '<span class="sc' + (row.score === 31 ? ' hot' : '') + '">' + fmt(row.score) + '</span></span>' +
        '</div><div class="hand" style="gap:6px">';
      for (var j = 0; j < row.hand.length; j++) html += cardHTML(row.hand[j], { size: 'sm' });
      html += '</div></div>';
    }
    return html;
  }

  /* ---------------- UI-plumbing ---------------- */

  var root, modalEl, toastEl, handler = null, toastTimer = null;

  function setHandler(fn) { handler = fn; }
  function paint(html) { root.innerHTML = html; window.scrollTo(0, 0); }

  function modal(html) { modalEl.innerHTML = html ? '<div class="scrim">' + html + '</div>' : ''; }
  function closeModal() { modalEl.innerHTML = ''; }

  function toast(msg) {
    if (!msg) { toastEl.innerHTML = ''; return; }
    toastEl.innerHTML = '<div class="toast">' + esc(msg) + '</div>';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.innerHTML = ''; }, 3200);
  }

  function confirmStop(onYes) {
    modal('<div class="sheet"><h2>Spel stoppen?</h2>' +
      '<p class="sub" style="margin:0 0 18px">De stand en de levens gaan verloren.</p>' +
      '<div class="pair"><button class="btn" data-act="stopNo">Doorspelen</button>' +
      '<button class="btn danger" data-act="stopYes">Stoppen</button></div></div>');
    stopCallback = onYes;
  }
  var stopCallback = null;

  /* Gedeelde klikafhandeling van de speeltafel. Geeft
     {rerender:true} of {action:{...}} terug, of null. */
  function boardClick(act, sel, setSel) {
    var i;
    if (act.indexOf('selCard:') === 0) {
      i = +act.split(':')[1];
      setSel(sel === i ? null : i);
      return { rerender: true };
    }
    if (act.indexOf('mid:') === 0) {
      if (sel === null) return null;
      i = +act.split(':')[1]; setSel(null);
      return { action: { type: 'swapOne', i: sel, m: i } };
    }
    if (act === 'blind') { if (sel === null) return null; setSel(null); return { action: { type: 'swapBlind', i: sel } }; }
    if (act === 'swapAll') { setSel(null); return { action: { type: 'swapAll' } }; }
    if (act === 'pass') { setSel(null); return { action: { type: 'pass' } }; }
    if (act === 'knock') { setSel(null); return { action: { type: 'knock' } }; }
    if (act === 'blindTake') return { action: { type: 'blindTake' } };
    if (act === 'blindKeep') return { action: { type: 'blindKeep' } };
    return null;
  }

  /* ============================================================
     LOKALE MODUS — één telefoon, doorgeven
     ============================================================ */

  var G = null, view = 'home', actor = 0, sel = null;

  function go(v) { view = v; render(); }

  function render() {
    if (view === 'home') return paint(homeHTML());
    if (view === 'rules') return paint(rulesHTML());
    if (view === 'setup') return paint(setupHTML());
    if (view === 'handoff') return paint(handoffHTML());
    if (view === 'turn') return paint(boardHTML(publicStateLocal(), G.players[G.current].hand, true, sel));
    if (view === 'turnDone') return paint(turnDoneHTML());
    if (view === 'reveal' || view === 'gameover') return paint(localRevealHTML());
  }

  /* Lokaal hoeven we niets te verbergen voor onszelf, maar we gebruiken
     dezelfde projectie zodat board/reveal identiek renderen. */
  function publicStateLocal() { return publicState(G); }

  function homeHTML() {
    return '<div class="hero">' +
      '<div class="big-num">31</div>' +
      '<div style="font-family:var(--sans);letter-spacing:.3em;text-transform:uppercase;font-size:13px;color:var(--mint)">en</div>' +
      '<p class="sub" style="margin:14px 0 30px">Drie kaarten, \u00e9\u00e9n kleur, zo dicht mogelijk bij 31.</p>' +
      '<div class="stack">' +
      '<button class="btn primary" data-act="local">Doorgeven op \u00e9\u00e9n telefoon</button>' +
      '<button class="btn" data-act="online">Online met kamercode</button>' +
      '</div>' +
      '<button class="linkbtn mt" data-act="rules">Spelregels</button>' +
      '<div class="sub" style="margin-top:24px;font-size:11px">v' + VERSION + '</div>' +
      '</div>';
  }

  function rulesHTML() {
    return '<h1 class="title mb">Spelregels</h1>' +
      '<div class="mint" style="font-size:14px;line-height:1.6">' +
      '<p>Er wordt gespeeld met 7 tot en met aas. 7 t/m 10 tellen hun eigen waarde, boer, vrouw en heer tellen 10, de aas telt 11. Je telt alleen kaarten van dezelfde kleur bij elkaar op. Drie dezelfde kaarten tellen 30\u00BD.</p>' +
      '<p>Iedereen krijgt drie kaarten. In het midden liggen drie dichte kaarten plus \u00e9\u00e9n losse blinde kaart.</p>' +
      '<p>De beginnende speler kiest blind: zijn eigen hand houden, of ruilen met de drie dichte middenkaarten. Daarna gaat het midden open en is de volgende speler aan de beurt.</p>' +
      '<p>Op je beurt ruil je \u00e9\u00e9n kaart met het midden, ruil je alle drie tegelijk, of ruil je met de blinde kaart \u2014 de kaart die jij weggeeft wordt dan de nieuwe blinde kaart. Wil je niets, dan klop je.</p>' +
      '<p>Kloppen sluit de ronde, en alle drie tegelijk ruilen doet dat ook. Alleen de blinde ruil van de beginner telt niet mee. Daarna krijgt iedereen nog \u00e9\u00e9n beurt; in die laatste beurt mag je ook niks doen. Dan gaan de kaarten open en verliest de laagste hand een leven.</p>' +
      '<p>Heeft iemand 31, dan stopt de ronde meteen en verliest de rest een leven.</p>' +
      '<p>Wie op nul levens komt gaat op de bok en krijgt daardoor nog \u00e9\u00e9n extra leven. Verliest hij daarna nog eens, dan ligt hij eruit. De laatste speler die overblijft wint.</p>' +
      '</div>' +
      '<button class="btn mt" data-act="home">Terug</button>';
  }

  function setupHTML() {
    var html = '<div class="row between mb"><h1 class="title">Nieuw spel</h1>' +
      '<button class="linkbtn" data-act="home">Terug</button></div>';

    html += '<div class="panel"><div class="eyebrow" style="margin-bottom:10px">Spelers</div>';
    for (var i = 0; i < S.names.length; i++) {
      html += '<div class="row" style="margin-bottom:8px">' +
        '<input type="text" data-name="' + i + '" value="' + esc(S.names[i]) + '" maxlength="14">' +
        (S.names.length > 2 ? '<button class="linkbtn" data-act="del:' + i + '" style="font-size:20px;padding:0 6px">\u00D7</button>' : '') +
        '</div>';
    }
    if (S.names.length < 5) html += '<button class="btn slim" data-act="addPlayer">+ Speler</button>';
    html += '</div>';

    html += '<div class="panel"><div class="row between">' +
      '<span>Levens per speler</span><div class="stepper">' +
      '<button data-act="lives:-1">\u2212</button><span class="val">' + S.lives + '</span>' +
      '<button data-act="lives:1">+</button></div></div></div>';

    html += rulesPanelHTML();
    html += '<button class="btn primary" data-act="start">Spelen</button>';
    return html;
  }

  function rulesPanelHTML() {
    var r = S.rules;
    var rows = [
      ['bok', 'Op de bok mag', r.bokMode === 'all' ? 'iedereen, 1\u00D7 per speler' : 'alleen de eerste die leeg is'],
      ['knock', 'Klopper met laagste hand', r.knockPenalty ? 'verliest 2 levens' : 'verliest 1 leven'],
      ['inst', '31 in de hand', r.instant31 ? 'meteen open, rest verliest een leven' : 'gewoon doorspelen'],
      ['pass', 'Passen zonder kloppen', r.allowPass ? 'mag' : 'kan niet \u2014 niks doen is kloppen']
    ];
    var html = '<div class="panel"><div class="eyebrow" style="margin-bottom:6px">Huisregels</div>';
    for (var i = 0; i < rows.length; i++) {
      html += '<button class="opt" data-act="rule:' + rows[i][0] + '">' +
        '<span class="lab">' + rows[i][1] + '</span><br><span class="val">' + rows[i][2] + ' \u203A</span></button>';
    }
    return html + '</div>';
  }

  function toggleRule(which) {
    var r = S.rules;
    if (which === 'bok') r.bokMode = r.bokMode === 'all' ? 'first' : 'all';
    if (which === 'knock') r.knockPenalty = !r.knockPenalty;
    if (which === 'inst') r.instant31 = !r.instant31;
    if (which === 'pass') r.allowPass = !r.allowPass;
    saveSettings();
  }

  function readNames() {
    var inputs = root.querySelectorAll('input[data-name]');
    for (var i = 0; i < inputs.length; i++) {
      var v = inputs[i].value.trim();
      S.names[+inputs[i].getAttribute('data-name')] = v || 'Speler ' + (i + 1);
    }
    saveSettings();
  }

  function handoffHTML() {
    var p = G.players[G.current];
    return '<div class="hero">' +
      '<div class="eyebrow">Geef de telefoon door aan</div>' +
      '<div style="font-family:var(--serif);font-size:40px;font-weight:900;color:var(--brass);margin:10px 0 6px">' + esc(p.name) + '</div>' +
      '<div class="mb">' + livesHTML(p) + '</div>' +
      (G.knocker !== null ? '<p style="color:var(--red-soft);font-size:14px;margin-bottom:20px">' + esc(G.players[G.knocker].name) + ' ' + endWayText(G) + ' \u2014 dit is je laatste beurt.</p>' : '<div style="height:20px"></div>') +
      '<button class="btn primary" data-act="show">Toon mijn kaarten</button>' +
      '<button class="linkbtn mt" data-act="stop">Spel stoppen</button>' +
      '</div>';
  }

  function turnDoneHTML() {
    var p = G.players[actor], b = best(p.hand);
    var head = G.instant !== null ? 'Eenendertig!'
      : G.knocker === actor ? (G.endWay === 'swapAll' ? 'Alle drie geruild \u2014 ronde gaat dicht' : 'Je hebt geklopt')
      : 'Jouw hand';
    var html = '<div class="hero"><div class="eyebrow mb">' + head + '</div><div class="hand center">';
    for (var i = 0; i < p.hand.length; i++) html += cardHTML(p.hand[i], { size: 'lg' });
    html += '</div><div style="max-width:260px;margin:20px auto 26px">' + meterHTML(b) + '</div>' +
      '<button class="btn primary" data-act="done">' + (G.phase !== 'turn' ? 'Kaarten op tafel' : 'Klaar \u2014 geef door') + '</button></div>';
    return html;
  }

  function localRevealHTML() {
    var html = revealHTML(publicStateLocal());
    html += '<div class="mt">' + (G.phase === 'gameover'
      ? '<button class="btn primary" data-act="newgame">Nieuw spel</button>'
      : '<button class="btn primary" data-act="next">Volgende ronde</button>') + '</div>';
    return html;
  }

  function startLocal() {
    readNames();
    var meta = S.names.map(function (n) { return { name: n }; });
    G = newGame(meta, S.lives, S.rules);
    sel = null;
    setHandler(localHandler);
    go('handoff');
  }

  function localHandler(act) {
    /* navigatie */
    if (act === 'local') { setHandler(localHandler); return go('setup'); }
    if (act === 'online') { closeModal(); return Online.home(); }
    if (act === 'rules') return go('rules');
    if (act === 'home') { G = null; return go('home'); }
    if (act === 'addPlayer') { readNames(); S.names.push('Speler ' + (S.names.length + 1)); saveSettings(); return go('setup'); }
    if (act.indexOf('del:') === 0) { readNames(); S.names.splice(+act.split(':')[1], 1); saveSettings(); return go('setup'); }
    if (act.indexOf('lives:') === 0) { readNames(); S.lives = Math.max(1, Math.min(9, S.lives + (+act.split(':')[1]))); saveSettings(); return go('setup'); }
    if (act.indexOf('rule:') === 0) { readNames(); toggleRule(act.split(':')[1]); return go('setup'); }
    if (act === 'start') return startLocal();
    if (act === 'newgame') { G = null; return go('setup'); }

    /* spel */
    if (act === 'stop') return confirmStop(function () { closeModal(); G = null; go('home'); });
    if (act === 'show') return go('turn');
    if (act === 'next') { G = nextRound(G); sel = null; return go('handoff'); }
    if (act === 'done') {
      if (G.phase === 'turn') { if (G.note) toast(G.note); return go('handoff'); }
      return go(G.phase);
    }

    if (view !== 'turn') return;
    var res = boardClick(act, sel, function (v) { sel = v; });
    if (!res) return;
    if (res.rerender) return render();
    actor = G.current;
    if (applyAction(G, res.action)) { sel = null; go('turnDone'); }
  }

  /* ---------------- boot ---------------- */

  function boot() {
    root = document.getElementById('app');
    modalEl = document.getElementById('modal');
    toastEl = document.getElementById('toast');
    loadSettings();
    setHandler(localHandler);

    document.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('[data-act]') : null;
      if (!el || el.disabled) return;
      var act = el.getAttribute('data-act');
      if (act === 'stopYes') { var cb = stopCallback; stopCallback = null; closeModal(); if (cb) cb(); return; }
      if (act === 'stopNo') { stopCallback = null; return closeModal(); }
      if (handler) handler(act, el);
    });

    go('home');
  }

  return {
    VERSION: VERSION,
    boot: boot, go: go, render: render,
    esc: esc, fmt: fmt, clone: clone, best: best, suitOf: suitOf,
    settings: function () { return S; }, saveSettings: saveSettings,
    engine: {
      newGame: newGame, dealRound: dealRound, nextRound: nextRound,
      applyAction: applyAction, publicState: publicState,
      nextIdx: nextIdx, activeCount: activeCount, isBlindTurn: isBlindTurn
    },
    ui: {
      paint: paint, modal: modal, closeModal: closeModal, toast: toast,
      cardHTML: cardHTML, meterHTML: meterHTML, livesHTML: livesHTML,
      scoresHTML: scoresHTML, boardHTML: boardHTML, revealHTML: revealHTML,
      rulesPanelHTML: rulesPanelHTML, toggleRule: toggleRule,
      boardClick: boardClick, confirmStop: confirmStop, setHandler: setHandler,
      localHandler: function () { return localHandler; }
    }
  };
})();
