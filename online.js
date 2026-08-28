'use strict';
/* ============================================================
   31en — ONLINE MODUS
   Kamercode via een publieke MQTT-broker, geen account nodig.
   De host draait de spelmotor: hij stuurt de publieke staat naar
   iedereen en ieders eigen drie kaarten naar een eigen topic.
   ============================================================ */

var Online = (function () {

  var BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];
  var CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var NS = '31en1/';

  var O = null;   // actieve sessie
  var sel = null;

  /* ---------------- helpers ---------------- */

  function topics(code) {
    var b = NS + code;
    return {
      lobby: b + '/lobby',
      join: b + '/join',
      act: b + '/act',
      state: b + '/state',
      p: function (pid) { return b + '/p/' + pid; }
    };
  }
  function makeCode() {
    var s = '';
    for (var i = 0; i < 5; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
    return s;
  }
  function myPid() {
    var k = '31en.pid', v;
    try { v = localStorage.getItem(k); } catch (e) { }
    if (!v) {
      v = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);
      try { localStorage.setItem(k, v); } catch (e) { }
    }
    return v;
  }
  function pub(topic, obj, retain) {
    if (!O || !O.client || !O.client.connected) return;
    try {
      O.client.publish(topic, obj === null ? '' : JSON.stringify(obj), { qos: 1, retain: !!retain });
    } catch (e) { }
  }

  /* ---------------- verbinden ---------------- */

  function connect(code, isHost, name, onReady) {
    var t = topics(code);
    O = {
      code: code, isHost: isHost, name: name, pid: myPid(), t: t,
      client: null, connected: false, brokerIdx: 0,
      lobby: null, state: null, hand: null, game: null,
      view: 'lobby', error: null
    };
    sel = null;
    App.ui.setHandler(handler);
    tryBroker(onReady);
  }

  function tryBroker(onReady) {
    if (!O) return;
    if (O.brokerIdx >= BROKERS.length) {
      O.error = 'Geen verbinding met een broker. Controleer je internet en probeer opnieuw.';
      return render();
    }
    var url = BROKERS[O.brokerIdx];
    var client = mqtt.connect(url, {
      clientId: '31en_' + Math.random().toString(16).slice(2, 10),
      clean: true, connectTimeout: 8000, reconnectPeriod: 2500, keepalive: 30
    });
    O.client = client;

    var settled = false;
    var giveUp = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { client.end(true); } catch (e) { }
      O.brokerIdx += 1;
      tryBroker(onReady);
    }, 9000);

    client.on('connect', function () {
      if (!O) return;
      settled = true;
      clearTimeout(giveUp);
      O.connected = true;
      O.error = null;
      var subs = [O.t.lobby, O.t.state, O.t.p(O.pid)];
      if (O.isHost) subs.push(O.t.join, O.t.act);
      client.subscribe(subs, { qos: 1 });
      if (onReady) { var f = onReady; onReady = null; f(); }
      render();
    });

    client.on('message', function (topic, payload) {
      if (!O) return;
      var msg = null;
      var txt = payload.toString();
      if (txt) { try { msg = JSON.parse(txt); } catch (e) { return; } }
      onMessage(topic, msg);
    });

    client.on('close', function () { if (O) { O.connected = false; render(); } });
    client.on('error', function () { });
  }

  function leave(clearRoom) {
    if (!O) return;
    if (O.isHost && clearRoom) {
      pub(O.t.lobby, null, true);
      pub(O.t.state, { phase: 'ended' }, true);
      if (O.game) for (var i = 0; i < O.game.players.length; i++) pub(O.t.p(O.game.players[i].pid), null, true);
    }
    try { O.client && O.client.end(true); } catch (e) { }
    O = null;
    sel = null;
    App.ui.setHandler(App.ui.localHandler());
    App.ui.closeModal();
    App.go('home');
  }

  /* ---------------- berichten ---------------- */

  function onMessage(topic, msg) {
    if (topic === O.t.lobby) {
      O.lobby = msg;
      if (!msg && !O.isHost) { App.ui.toast('De host heeft de kamer gesloten.'); return leave(false); }
      return render();
    }
    if (topic === O.t.state) {
      if (!msg) return;
      if (msg.phase === 'ended') {
        if (!O.isHost) { App.ui.toast('De host heeft het spel gestopt.'); return leave(false); }
        return;
      }
      O.state = msg;
      O.view = 'game';
      if (msg.note) App.ui.toast(msg.note);
      sel = null;
      return render();
    }
    if (topic === O.t.p(O.pid)) {
      O.hand = msg ? msg.hand : null;
      return render();
    }
    if (O.isHost && topic === O.t.join) return hostOnJoin(msg);
    if (O.isHost && topic === O.t.act) return hostOnAct(msg);
  }

  /* ---------------- host ---------------- */

  function hostPublishLobby() {
    pub(O.t.lobby, O.lobby, true);
    render();
  }

  function hostOnJoin(msg) {
    if (!msg || !msg.pid || !O.lobby) return;
    var ps = O.lobby.players, i;
    for (i = 0; i < ps.length; i++) {
      if (ps[i].pid === msg.pid) {          // herverbinding: naam bijwerken
        ps[i].name = msg.name || ps[i].name;
        hostPublishLobby();
        if (O.game) hostPushHands();
        return;
      }
    }
    if (O.lobby.started) return;            // spel loopt al, geen nieuwe spelers
    if (ps.length >= 5) return;
    ps.push({ pid: msg.pid, name: msg.name || 'Speler' });
    hostPublishLobby();
  }

  function hostOnAct(msg) {
    if (!msg || !O.game || O.game.phase !== 'turn') return;
    var g = O.game;
    if (g.players[g.current].pid !== msg.pid) return;   // niet aan de beurt
    if (App.engine.applyAction(g, msg.action)) hostPushState();
  }

  function hostPushHands() {
    var g = O.game;
    for (var i = 0; i < g.players.length; i++) {
      pub(O.t.p(g.players[i].pid), { hand: g.players[i].hand, round: g.round }, true);
    }
  }

  function hostPushState() {
    var g = O.game;
    hostPushHands();
    pub(O.t.state, App.engine.publicState(g), true);
    O.state = App.engine.publicState(g);
    O.hand = handFor(O.pid);
    O.view = 'game';
    if (g.note) App.ui.toast(g.note);
    sel = null;
    render();
  }

  function handFor(pid) {
    var g = O.game;
    for (var i = 0; i < g.players.length; i++) if (g.players[i].pid === pid) return g.players[i].hand;
    return null;
  }

  function hostStart() {
    var meta = O.lobby.players.map(function (p) { return { name: p.name, pid: p.pid }; });
    if (meta.length < 2) return App.ui.toast('Je hebt minstens twee spelers nodig.');
    O.game = App.engine.newGame(meta, O.lobby.lives, O.lobby.rules);
    O.lobby.started = true;
    hostPublishLobby();
    hostPushState();
  }

  function hostNextRound() {
    O.game = App.engine.nextRound(O.game);
    hostPushState();
  }

  /* ---------------- schermen ---------------- */

  function home() {
    O = null;
    App.ui.setHandler(handler);
    App.ui.paint(
      '<div class="row between mb"><h1 class="title">Online</h1>' +
      '<button class="linkbtn" data-act="oHome">Terug</button></div>' +
      '<p class="sub mb">Iedereen opent deze app op zijn eigen telefoon. E\u00e9n iemand maakt een kamer, de rest doet mee met de code. Je eigen kaarten zie je alleen op je eigen scherm.</p>' +
      '<div class="stack">' +
      '<button class="btn primary" data-act="oCreate">Kamer maken</button>' +
      '<button class="btn" data-act="oJoinForm">Meedoen met een code</button>' +
      '</div>' +
      '<p class="sub mt" style="font-size:11px">De verbinding loopt via een gratis openbare server. Prima voor onder vrienden, maar niet versleuteld \u2014 gebruik geen kamercode die je elders gebruikt.</p>'
    );
  }

  function createForm() {
    var S = App.settings();
    App.ui.paint(
      '<div class="row between mb"><h1 class="title">Kamer maken</h1>' +
      '<button class="linkbtn" data-act="online">Terug</button></div>' +
      '<div class="panel"><div class="eyebrow" style="margin-bottom:8px">Jouw naam</div>' +
      '<input type="text" id="oName" maxlength="14" value="' + App.esc(S.names[0] || '') + '"></div>' +
      '<div class="panel"><div class="row between"><span>Levens per speler</span><div class="stepper">' +
      '<button data-act="oLives:-1">\u2212</button><span class="val">' + S.lives + '</span>' +
      '<button data-act="oLives:1">+</button></div></div></div>' +
      App.ui.rulesPanelHTML() +
      '<button class="btn primary" data-act="oMake">Kamer openen</button>'
    );
  }

  function joinForm() {
    var S = App.settings();
    App.ui.paint(
      '<div class="row between mb"><h1 class="title">Meedoen</h1>' +
      '<button class="linkbtn" data-act="online">Terug</button></div>' +
      '<div class="panel"><div class="eyebrow" style="margin-bottom:8px">Kamercode</div>' +
      '<input type="text" id="oCode" class="code" maxlength="5" autocapitalize="characters" autocomplete="off"></div>' +
      '<div class="panel"><div class="eyebrow" style="margin-bottom:8px">Jouw naam</div>' +
      '<input type="text" id="oName" maxlength="14" value="' + App.esc(S.names[0] || '') + '"></div>' +
      '<button class="btn primary" data-act="oJoin">Meedoen</button>'
    );
  }

  function statusHTML() {
    return '<span class="dot ' + (O.connected ? 'on' : 'off') + '"></span> ' +
      '<span class="sub">' + (O.connected ? 'verbonden' : 'verbinden\u2026') + '</span>';
  }

  function lobbyHTML() {
    var ps = (O.lobby && O.lobby.players) || [];
    var html = '<div class="row between mb">' + statusHTML() +
      '<button class="linkbtn" data-act="oLeave">Verlaten</button></div>';
    html += '<div class="codebox mb"><div class="eyebrow">Kamercode</div>' +
      '<div class="code">' + App.esc(O.code) + '</div>' +
      '<button class="linkbtn" data-act="oShare">Code delen</button></div>';

    html += '<div class="panel"><div class="eyebrow" style="margin-bottom:10px">Spelers (' + ps.length + '/5)</div>';
    if (!ps.length) html += '<div class="sub">Nog niemand binnen.</div>';
    for (var i = 0; i < ps.length; i++) {
      html += '<div class="row between" style="padding:6px 0"><span>' + App.esc(ps[i].name) +
        (i === 0 ? '<span class="sub"> \u00B7 host</span>' : '') + '</span>' +
        (ps[i].pid === O.pid ? '<span class="sub">jij</span>' : '') + '</div>';
    }
    html += '</div>';

    if (O.isHost) {
      html += '<button class="btn primary" data-act="oStart"' + (ps.length < 2 ? ' disabled' : '') + '>Spel starten</button>';
      if (ps.length < 2) html += '<p class="sub" style="text-align:center;margin-top:10px">Wachten op minstens \u00e9\u00e9n medespeler.</p>';
    } else {
      html += '<p class="sub" style="text-align:center">Wachten tot de host start\u2026</p>';
    }
    return html;
  }

  function gameHTML() {
    var st = O.state;
    if (!st) return lobbyHTML();

    if (st.phase === 'reveal' || st.phase === 'gameover') {
      var html = App.ui.revealHTML(st);
      if (O.isHost) {
        html += '<div class="mt">' + (st.phase === 'gameover'
          ? '<button class="btn primary" data-act="oEnd">Spel afsluiten</button>'
          : '<button class="btn primary" data-act="oNext">Volgende ronde</button>') + '</div>';
      } else {
        html += '<p class="sub mt" style="text-align:center">Wachten op de host\u2026</p>';
      }
      return html;
    }

    var canAct = st.players[st.current] && st.players[st.current].pid === O.pid;
    var board = App.ui.boardHTML(st, O.hand, canAct, sel);
    if (!canAct && O.isHost) {
      board += '<button class="linkbtn" style="width:100%;text-align:center" data-act="oSkip">' +
        'Beurt van ' + App.esc(st.players[st.current].name) + ' overslaan</button>';
    }
    return board;
  }

  function render() {
    if (!O) return;
    if (O.error) {
      return App.ui.paint('<h1 class="title mb">Geen verbinding</h1><p class="sub mb">' + App.esc(O.error) + '</p>' +
        '<button class="btn" data-act="online">Opnieuw proberen</button>');
    }
    App.ui.paint(O.view === 'game' ? gameHTML() : lobbyHTML());
  }

  /* ---------------- klikafhandeling ---------------- */

  function handler(act) {
    var S = App.settings(), el;

    if (act === 'oHome' || act === 'home') { if (O) return leave(true); App.ui.setHandler(App.ui.localHandler()); return App.go('home'); }
    if (act === 'online') { if (O) { try { O.client && O.client.end(true); } catch (e) { } O = null; } return home(); }
    if (act === 'oCreate') return createForm();
    if (act === 'oJoinForm') return joinForm();
    if (act === 'rules') { App.ui.setHandler(App.ui.localHandler()); return App.go('rules'); }

    if (act.indexOf('oLives:') === 0) {
      S.lives = Math.max(1, Math.min(9, S.lives + (+act.split(':')[1])));
      App.saveSettings();
      return createForm();
    }
    if (act.indexOf('rule:') === 0) { App.ui.toggleRule(act.split(':')[1]); return createForm(); }

    if (act === 'oMake') {
      el = document.getElementById('oName');
      var hostName = (el && el.value.trim()) || 'Host';
      S.names[0] = hostName; App.saveSettings();
      var code = makeCode();
      connect(code, true, hostName, function () {
        O.lobby = {
          code: code, hostPid: O.pid, started: false,
          lives: S.lives, rules: App.clone(S.rules),
          players: [{ pid: O.pid, name: hostName }]
        };
        hostPublishLobby();
      });
      return render();
    }

    if (act === 'oJoin') {
      var codeEl = document.getElementById('oCode');
      var nameEl = document.getElementById('oName');
      var c = (codeEl && codeEl.value.trim().toUpperCase()) || '';
      var nm = (nameEl && nameEl.value.trim()) || 'Speler';
      if (c.length !== 5) return App.ui.toast('Een kamercode bestaat uit vijf tekens.');
      S.names[0] = nm; App.saveSettings();
      connect(c, false, nm, function () {
        pub(O.t.join, { pid: O.pid, name: nm });
      });
      return render();
    }

    if (act === 'oShare') {
      var txt = 'Doe mee met 31en \u2014 kamercode ' + O.code + '\n' + location.href;
      if (navigator.share) navigator.share({ text: txt }).catch(function () { });
      else if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { App.ui.toast('Code gekopieerd.'); });
      else App.ui.toast('Kamercode: ' + O.code);
      return;
    }

    if (act === 'oStart') return hostStart();
    if (act === 'oNext') return hostNextRound();
    if (act === 'oSkip') {
      if (O && O.isHost && O.game && O.game.phase === 'turn') {
        if (App.engine.applyAction(O.game, { type: 'skip' })) hostPushState();
      }
      return;
    }
    if (act === 'oEnd') return App.ui.confirmStop(function () { leave(true); });
    if (act === 'oLeave') return App.ui.confirmStop(function () { leave(O && O.isHost); });
    if (act === 'stop') return App.ui.confirmStop(function () { leave(O && O.isHost); });

    /* zetten aan tafel */
    if (!O || !O.state || O.state.phase !== 'turn') return;
    var st = O.state;
    if (!st.players[st.current] || st.players[st.current].pid !== O.pid) return;

    var res = App.ui.boardClick(act, sel, function (v) { sel = v; });
    if (!res) return;
    if (res.rerender) return render();

    if (O.isHost) {
      if (App.engine.applyAction(O.game, res.action)) hostPushState();
    } else {
      pub(O.t.act, { pid: O.pid, action: res.action });
    }
  }

  return { home: home, leave: leave };
})();
