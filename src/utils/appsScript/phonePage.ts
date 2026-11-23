// The phone page of the WorkPulse Apps Script: one self-contained HTML file (no external scripts, styles or
// fonts) served by doGet?page=phone. It talks to the script only through google.script.run: phoneData,
// phoneAddTask, phoneAddLog, phoneOlderLogs, phoneClockOut and phoneUndoClockOut, each checked with the PIN (see core.ts).
//
// Rules for this file:
// - The page script is plain ES5 (var, function; no let/const, arrow functions or template literals),
//   because it is embedded in the Apps Script text, which a test keeps ES5-clean.
// - Server data reaches the DOM only through textContent / createElement. Never innerHTML.
// - localStorage is touched only by readStore / writeStore / dropStore, each inside try/catch: the page
//   works with storage blocked (the PIN is then asked each time).
// - Written with String.raw so the regex backslashes survive; it must not contain a backtick or "${".
export const PHONE_PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>WorkPulse</title>
<style>
:root {
  --pitch: #0f3d2e; --chalk: #f4f1e8; --paper: #fbfaf5; --white: #ffffff; --subtle: #efebe1;
  --line: #dcd8cb; --control: #83806f; --ink: #1d2b24; --mute: #5d6b63;
  --gold: #f2b705; --gold-hover: #dba603; --on-gold: #1d1a0a; --running: #fff8e1;
  --wait: #7a5a00; --danger: #a1281f; --band-ink: #f4f1e8; --band-mute: rgba(244, 241, 232, 0.74);
  --font: Archivo, "Noto Sans Bengali", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-fig: Archivo, "Roboto Condensed", sans-serif-condensed, "Arial Narrow", system-ui, -apple-system, "Segoe UI", sans-serif;
  color-scheme: light;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
[hidden] { display: none !important; }
html { background: var(--chalk); scrollbar-color: var(--control) var(--chalk); scrollbar-width: thin; -webkit-text-size-adjust: 100%; }
body { background: var(--chalk); color: var(--ink); font: 400 15px/1.4 var(--font); -webkit-tap-highlight-color: transparent; caret-color: var(--pitch); accent-color: var(--pitch); overflow-x: hidden; }
::selection { background: rgba(242, 183, 5, 0.45); color: var(--ink); }
button, input, select { font: inherit; color: inherit; }
button { background: none; border: 0; cursor: pointer; }
:focus-visible { outline: 3px solid var(--pitch); outline-offset: 2px; }
.band :focus-visible { outline-color: var(--gold); }
.app { max-width: 560px; margin: 0 auto; min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.fig { font-family: var(--font-fig); font-weight: 700; font-stretch: 72%; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.num { font-variant-numeric: tabular-nums; }

/* Band: the scoreboard. */
.band { background: var(--pitch); color: var(--band-ink); padding: 4px 16px 0; padding-top: max(4px, env(safe-area-inset-top)); }
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; }
.brand { display: flex; align-items: center; gap: 9px; font-weight: 800; font-size: 15px; letter-spacing: 0.02em; }
.ball { width: 12px; height: 12px; border-radius: 50%; background: var(--gold); flex: none; }
.date { font-weight: 600; font-size: 13px; color: var(--band-mute); letter-spacing: 0; }
.lock { min-height: 44px; min-width: 44px; padding: 0 4px; font-size: 13px; font-weight: 600; color: var(--band-mute); text-decoration: underline; text-underline-offset: 3px; }
.score { display: flex; flex-wrap: wrap; gap: 6px 26px; padding: 4px 0 16px; }
.score:empty { display: none; }
.lab { font-size: 13px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--band-mute); margin-bottom: 4px; }
.score .fig { font-size: 40px; line-height: 0.95; }
.gold { color: var(--gold); }
.statement { font-size: 15px; font-weight: 600; color: var(--band-ink); padding: 2px 0 2px; }
.statement small { display: block; font-size: 13px; font-weight: 500; color: var(--band-mute); }

/* Clock out, inside the band. */
.clock { padding: 0 0 16px; }
.clock .lab { margin-bottom: 6px; }
.outsum { font-size: 13px; color: var(--band-mute); min-height: 18px; margin: 8px 0 12px; }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.ghost { min-height: 52px; padding: 0 16px; border: 1px solid var(--band-mute); border-radius: 6px; color: var(--band-ink); font-weight: 600; font-size: 15px; }
.outmsg { font-size: 13px; font-weight: 600; color: var(--band-ink); }
.outmsg:empty { display: none; }
.outmsg.bad { color: var(--gold); }
#outBtn + .outmsg, #outForm + .outmsg { margin-top: 10px; }
#outUndo { width: 100%; margin-top: 10px; }

/* Tabs. */
.tabs { display: flex; background: var(--paper); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 2; }
.tab { flex: 1; min-height: 50px; font-size: 15px; font-weight: 600; color: var(--mute); display: flex; align-items: center; justify-content: center; gap: 7px; }
.tab[aria-selected="true"] { color: var(--ink); box-shadow: inset 0 -3px 0 var(--pitch); }
.tab .count { font-family: var(--font-fig); font-stretch: 72%; font-weight: 700; color: var(--pitch); font-variant-numeric: tabular-nums; }
.tab:focus-visible { outline-offset: -3px; }

/* Body. */
.body { padding: 16px 16px 8px; flex: 1; }
.head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-size: 13px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin: 26px 0 8px; }
.group:first-child .head { margin-top: 0; }
.head .meta { font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--mute); white-space: nowrap; }
.card { list-style: none; background: var(--paper); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.rib { width: 6px; border-radius: 3px; align-self: stretch; min-height: 20px; background: var(--control); }
.t { display: grid; grid-template-columns: 6px minmax(0, 1fr); gap: 12px; padding: 13px 14px; border-top: 1px solid var(--line); }
.t:first-child { border-top: 0; }
.t.run { background: var(--running); }
.ti { font-weight: 600; font-size: 15px; line-height: 1.3; overflow-wrap: anywhere; }
.pr { font-size: 13px; color: var(--mute); margin-top: 3px; overflow-wrap: anywhere; }
.wait { color: var(--wait); font-weight: 600; white-space: nowrap; }
.live { color: var(--ink); font-weight: 600; }
.blocked { color: var(--danger); font-weight: 600; }
.lg { display: grid; grid-template-columns: 44px 6px minmax(0, 1fr) auto; gap: 10px; padding: 12px 14px; border-top: 1px solid var(--line); align-items: start; }
.lg:first-child { border-top: 0; }
.lg .tm { font-size: 13px; color: var(--mute); padding-top: 1px; }
.lg .ds { overflow-wrap: anywhere; }
.lg .pj { display: block; font-size: 13px; color: var(--mute); margin-top: 2px; }
.lg .mn { font-family: var(--font-fig); font-stretch: 72%; font-weight: 700; text-align: right; min-width: 36px; }
.empty { background: var(--paper); border: 1px solid var(--line); border-radius: 8px; padding: 20px 16px; }
.empty p:first-child { font-weight: 600; }
.empty p + p { margin-top: 6px; }
.empty .small { color: var(--mute); }
.small { font-size: 13px; color: var(--mute); }
.msg { font-size: 13px; font-weight: 600; min-height: 18px; }
.msg.bad { color: var(--danger); }
.msg.good { color: var(--pitch); }
.note { margin-bottom: 14px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); }
.note:empty { display: none; }
.foot { padding: 6px 16px 20px; padding-bottom: max(20px, env(safe-area-inset-bottom)); text-align: center; font-size: 13px; color: var(--mute); }
.link { min-height: 44px; padding: 0 6px; font-size: 13px; font-weight: 600; color: var(--pitch); text-decoration: underline; text-underline-offset: 3px; }
.link:disabled { color: var(--mute); text-decoration: none; cursor: default; }
.more { margin-top: 18px; text-align: center; }
.quiet { width: 100%; min-height: 48px; border: 1px solid var(--control); border-radius: 6px; background: var(--white); font-weight: 600; font-size: 15px; }
.quiet:disabled { color: var(--mute); cursor: default; background: var(--paper); }
.more .msg { margin-top: 10px; font-weight: 500; color: var(--mute); }
@keyframes arrive { from { background: rgba(242, 183, 5, 0.38); } to { background: transparent; } }
.t.new { animation: arrive 1.6s cubic-bezier(0.16, 1, 0.3, 1) both; }

/* Add form. */
.field { margin-bottom: 18px; border: 0; }
.field > label, .field legend { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.inp { width: 100%; min-height: 50px; border: 1px solid var(--control); border-radius: 6px; background: var(--white); padding: 12px; font-size: 16px; color: var(--ink); }
.inp::placeholder { color: var(--mute); opacity: 1; }
.inp:focus { border-color: var(--pitch); }
.sel { position: relative; }
.sel select { -webkit-appearance: none; appearance: none; padding-right: 42px; }
.sel svg { position: absolute; right: 14px; top: 50%; margin-top: -8px; pointer-events: none; }
.seg { display: flex; border: 1px solid var(--control); border-radius: 6px; overflow: hidden; background: var(--white); }
.seg label { flex: 1; position: relative; }
.seg label + label { border-left: 1px solid var(--control); }
.seg input { position: absolute; opacity: 0; inset: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.seg span { display: flex; align-items: center; justify-content: center; min-height: 50px; font-weight: 600; }
.seg input:checked + span { background: var(--pitch); color: var(--chalk); }
.seg input:focus-visible + span { outline: 3px solid var(--gold); outline-offset: -5px; }
.go { width: 100%; min-height: 52px; border-radius: 6px; background: var(--gold); color: var(--on-gold); font-weight: 700; font-size: 15px; }
.go:disabled { background: var(--subtle); color: var(--mute); cursor: default; }
.addmsg { margin-top: 12px; }
.subhead { font-size: 15px; font-weight: 700; margin: 28px 0 12px; padding-top: 18px; border-top: 1px solid var(--line); }
.help { margin-top: 18px; }

/* PIN. */
.pin { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 28px 28px 32px; }
.pin h1 { font-size: 28px; line-height: 1.1; font-weight: 800; letter-spacing: -0.01em; }
.pin .small { margin-top: 6px; }
.boxes { display: flex; gap: 10px; margin: 24px 0 10px; }
.boxes i { width: 52px; height: 58px; border: 1px solid var(--control); border-radius: 6px; background: var(--white); display: flex; align-items: center; justify-content: center; }
.boxes i.on { border-color: var(--pitch); }
.boxes i.on::after { content: ""; width: 14px; height: 14px; border-radius: 50%; background: var(--ink); }
.boxes i.next { border-color: var(--pitch); box-shadow: inset 0 0 0 1px var(--pitch); }
/* Two lines are always reserved, so an error never moves the heading or the keypad. */
.pinmsg { line-height: 18px; min-height: 38px; padding-top: 2px; }
.keys { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 24px; }
.key { min-height: 60px; background: var(--paper); border: 1px solid var(--line); border-radius: 8px; font-family: var(--font-fig); font-stretch: 72%; font-size: 28px; font-weight: 700; color: var(--ink); display: flex; align-items: center; justify-content: center; transition: background-color 90ms ease-out; touch-action: manipulation; }
.key:active { background: var(--subtle); }
.key:disabled { color: var(--control); cursor: default; }
.key.blank { visibility: hidden; }
.keys.wait .key { opacity: 0.55; }

.loading { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 28px; text-align: center; }
.loading .quiet { width: auto; padding: 0 22px; }

/* Hover only where there is a real pointer, so a tapped button does not stay dark on a phone. */
@media (hover: hover) {
  .lock:hover { color: var(--band-ink); }
  .quiet:not(:disabled):hover { background: var(--subtle); }
  .go:not(:disabled):hover { background: var(--gold-hover); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
</style>
</head>
<body>
<div class="app">
  <header class="band">
    <div class="top">
      <div class="brand"><span class="ball" aria-hidden="true"></span><span>WorkPulse</span><span class="date" id="bandDate"></span></div>
      <button type="button" class="lock" id="lockBtn" hidden>Lock</button>
    </div>
    <div class="score" id="score"></div>
    <div class="clock" id="clockBox" hidden>
      <button type="button" class="go" id="outBtn">Clock out</button>
      <form id="outForm" novalidate hidden>
        <label for="outTime" class="lab">Left at</label>
        <input class="inp" id="outTime" name="outTime" type="time">
        <p class="outsum" id="outSum" aria-live="polite"></p>
        <div class="row2">
          <button type="submit" class="go" id="outGo">Clock out</button>
          <button type="button" class="ghost" id="outCancel">Cancel</button>
        </div>
      </form>
      <p class="outmsg" id="outMsg" role="status"></p>
      <button type="button" class="ghost" id="outUndo" hidden>Undo clock-out</button>
    </div>
  </header>

  <main class="pin" id="pinView" hidden>
    <h1 id="pinTitle">Enter your PIN</h1>
    <p class="small" id="pinHint">Asked once on this phone.</p>
    <div class="boxes" id="boxes" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <p class="sr" id="pinCount" aria-live="polite"></p>
    <p class="msg pinmsg" id="pinMsg" role="alert"></p>
    <div class="keys" id="keys" role="group" aria-label="PIN keypad">
      <button type="button" class="key" data-d="1">1</button>
      <button type="button" class="key" data-d="2">2</button>
      <button type="button" class="key" data-d="3">3</button>
      <button type="button" class="key" data-d="4">4</button>
      <button type="button" class="key" data-d="5">5</button>
      <button type="button" class="key" data-d="6">6</button>
      <button type="button" class="key" data-d="7">7</button>
      <button type="button" class="key" data-d="8">8</button>
      <button type="button" class="key" data-d="9">9</button>
      <span class="key blank" aria-hidden="true"></span>
      <button type="button" class="key" data-d="0">0</button>
      <button type="button" class="key" id="backKey" aria-label="Delete last digit"><svg width="28" height="22" viewBox="0 0 28 22" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M9 2h16a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 25 20H9l-7.5-9z"/><path d="M13.5 7l7 8M20.5 7l-7 8"/></svg></button>
    </div>
  </main>

  <main class="loading" id="loadView">
    <p class="small" id="loadMsg" role="status">Opening WorkPulse...</p>
    <button type="button" class="quiet" id="retryBtn" hidden>Try again</button>
  </main>

  <div id="mainView" hidden>
    <div class="tabs" role="tablist" aria-label="WorkPulse">
      <button type="button" class="tab" role="tab" id="tab-tasks" aria-controls="panel-tasks" aria-selected="true">Tasks <span class="count" id="taskCount"></span></button>
      <button type="button" class="tab" role="tab" id="tab-log" aria-controls="panel-log" aria-selected="false" tabindex="-1">Log</button>
      <button type="button" class="tab" role="tab" id="tab-add" aria-controls="panel-add" aria-selected="false" tabindex="-1">Add</button>
    </div>
    <div class="body">
      <p class="msg bad note" id="mainMsg" role="alert"></p>
      <section id="panel-tasks" role="tabpanel" aria-labelledby="tab-tasks"><div id="tasksList"></div></section>
      <section id="panel-log" role="tabpanel" aria-labelledby="tab-log" hidden>
        <div id="logList"></div>
        <div class="more" id="moreBox">
          <button type="button" class="quiet" id="moreBtn">Show earlier days</button>
          <p class="msg" id="moreMsg" role="status"></p>
        </div>
      </section>
      <section id="panel-add" role="tabpanel" aria-labelledby="tab-add" hidden>
        <form id="addForm" novalidate>
          <div class="field">
            <label for="addTitle">Task</label>
            <input class="inp" id="addTitle" name="title" type="text" maxlength="200" autocomplete="off" enterkeyhint="done" placeholder="What needs doing?">
          </div>
          <div class="field">
            <label for="addProject">Project</label>
            <div class="sel">
              <select class="inp" id="addProject" name="project"></select>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#1d2b24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6"/></svg>
            </div>
          </div>
          <fieldset class="field">
            <legend>Day</legend>
            <div class="seg">
              <label><input type="radio" name="day" value="today" checked><span>Today</span></label>
              <label><input type="radio" name="day" value="tomorrow"><span>Tomorrow</span></label>
            </div>
          </fieldset>
          <button type="submit" class="go" id="addBtn">Add task</button>
          <p class="msg addmsg" id="addMsg" role="status"></p>
        </form>
        <p class="small help">It shows under Tasks right away and moves to your PC the next time WorkPulse is open there.</p>
        <h2 class="subhead">Log work done outside the office</h2>
        <form id="logForm" novalidate>
          <div class="field">
            <label for="logText">What you did</label>
            <input class="inp" id="logText" name="text" type="text" maxlength="500" autocomplete="off" enterkeyhint="done" placeholder="Fixed the pump at the site">
          </div>
          <div class="field">
            <label for="logProject">Project</label>
            <div class="sel">
              <select class="inp" id="logProject" name="logProject"></select>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#1d2b24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6"/></svg>
            </div>
          </div>
          <div class="field">
            <label for="logTime">Started at</label>
            <input class="inp" id="logTime" name="time" type="time" value="09:00">
          </div>
          <div class="field">
            <label for="logMinutes">Minutes</label>
            <input class="inp" id="logMinutes" name="minutes" type="number" min="1" max="960" step="1" inputmode="numeric" placeholder="45">
          </div>
          <fieldset class="field">
            <legend>Day</legend>
            <div class="seg">
              <label><input type="radio" name="logday" value="today" checked><span>Today</span></label>
              <label><input type="radio" name="logday" value="yesterday"><span>Yesterday</span></label>
            </div>
          </fieldset>
          <button type="submit" class="go" id="logBtn">Add log</button>
          <p class="msg addmsg" id="logMsg" role="status"></p>
        </form>
      </section>
    </div>
    <footer class="foot"><span id="asofText"></span> <span aria-hidden="true">&middot;</span> <button type="button" class="link" id="refreshBtn">Refresh</button></footer>
  </div>
</div>
<script>
(function () {
  'use strict';

  var PIN_KEY = 'workpulse_phone_pin';
  var PROJECT_KEY = 'workpulse_phone_project';
  var OFFLINE = 'Could not reach your Sheet. Check your connection and try again.';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  var S = {
    gen: 0, pin: '', entry: '', checking: false, lockedUntil: 0, lockTimer: null,
    data: null, tab: 'tasks', flash: '', adding: false, addingLog: false, refreshing: false,
    older: [], olderNext: '', olderMore: true, olderBusy: false, olderDone: false,
    outBusy: false, outReq: null
  };

  function $(id) { return document.getElementById(id); }

  // ---- Storage (best effort: the page works when the browser blocks it) ----
  function readStore(k) { try { return window.localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function writeStore(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function dropStore(k) { try { window.localStorage.removeItem(k); } catch (e) {} }

  // ---- DOM: data only ever goes in as text ----
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function setMsg(n, text, kind) {
    n.textContent = text || '';
    n.className = n.className.replace(/\s*\b(bad|good)\b/g, '') + (kind ? ' ' + kind : '');
  }

  // ---- Values ----
  function str(v) { return v == null ? '' : String(v); }
  function arr(v) { return Object.prototype.toString.call(v) === '[object Array]' ? v : []; }
  function isDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(str(v)); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtHM(min) {
    min = Math.max(0, Math.floor(Number(min) || 0));
    return Math.floor(min / 60) + ':' + pad(min % 60);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function utcOf(d) { var p = d.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function addDays(d, n) {
    var t = utcOf(d);
    t.setUTCDate(t.getUTCDate() + n);
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }
  function shortDate(d) {
    var t = utcOf(d);
    return DAYS[t.getUTCDay()] + ' ' + t.getUTCDate() + ' ' + MONTHS[t.getUTCMonth()];
  }
  function dayName(d, today) {
    if (!isDate(d)) return 'No date';
    if (d === today) return 'Today';
    if (d === addDays(today, 1)) return 'Tomorrow';
    if (d === addDays(today, -1)) return 'Yesterday';
    return shortDate(d);
  }
  function timeOf(iso) {
    var t = iso ? new Date(iso) : null;
    return t && !isNaN(t.getTime()) ? pad(t.getHours()) + ':' + pad(t.getMinutes()) : '';
  }
  function localDate(t) { return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()); }
  function hhmm(v) {
    var m = /^(\d{1,2}):(\d{2})/.exec(str(v));
    return m ? pad(+m[1]) + ':' + m[2] : '';
  }
  function safeColor(c) { return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(str(c)) ? c : ''; }

  // ---- Talking to the script ----
  function failure(code, message) { return { ok: false, code: code, message: message }; }

  // A google.script.run chain whose answer always arrives as one object through done().
  function server(done) {
    var g = window.google;
    if (!g || !g.script || !g.script.run) {
      setTimeout(function () { done(failure('offline', OFFLINE)); }, 0);
      return null;
    }
    return g.script.run
      .withSuccessHandler(function (r) { done(r && typeof r === 'object' ? r : failure('error', OFFLINE)); })
      .withFailureHandler(function () { done(failure('offline', OFFLINE)); });
  }

  function isAuthFailure(r) { return r.code === 'bad_pin' || r.code === 'locked' || r.code === 'no_pin'; }

  function normalise(r) {
    var projects = {};
    var byName = {};
    arr(r.projects).forEach(function (p) {
      if (!p || !p.id) return;
      projects[str(p.id)] = p;
      byName[str(p.name)] = p;
    });
    return {
      tasks: arr(r.tasks),
      logs: arr(r.logs),
      pending: arr(r.pending),
      projects: arr(r.projects).filter(function (p) { return p && p.id; }),
      byId: projects,
      byName: byName,
      workdays: r.workdays && typeof r.workdays === 'object' ? r.workdays : {},
      pushedAt: str(r.pushedAt),
      today: isDate(r.today) ? r.today : localDate(new Date()),
      clockOutEnabled: r.clockOutEnabled === true,
      clockOuts: arr(r.clockOuts).filter(function (c) { return c && c.id; })
    };
  }

  function colorOf(projectId, projectName) {
    var d = S.data;
    var p = (projectId && d.byId[projectId]) || (projectName && d.byName[projectName]);
    return p ? safeColor(p.color) : '';
  }

  // ---- Views ----
  function show(view) {
    $('pinView').hidden = view !== 'pin';
    $('loadView').hidden = view !== 'load';
    $('mainView').hidden = view !== 'main';
    $('lockBtn').hidden = view !== 'main';
    if (view !== 'main') { clear($('score')); $('bandDate').textContent = ''; $('clockBox').hidden = true; }
  }

  function showLoading(text, canRetry) {
    show('load');
    $('loadMsg').textContent = text;
    $('retryBtn').hidden = !canRetry;
  }

  // ---- PIN screen ----
  function renderBoxes() {
    var boxes = $('boxes').children;
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].className = i < S.entry.length ? 'on' : (i === S.entry.length && !keysLocked() ? 'next' : '');
    }
    $('pinCount').textContent = S.entry.length ? S.entry.length + ' of 4 digits entered' : '';
  }

  function keysLocked() { return S.checking || Date.now() < S.lockedUntil; }

  function renderKeys() {
    var locked = keysLocked();
    var keys = $('keys').querySelectorAll('button');
    for (var i = 0; i < keys.length; i++) keys[i].disabled = locked;
    $('keys').className = 'keys' + (S.checking ? ' wait' : '');
  }

  // Every request remembers the generation it started in. showPin (Lock, a wrong PIN, a lock-out) bumps
  // it and clears what was waiting, so a reply that arrives later is ignored instead of crashing on the
  // cleared data or filling the lists again.
  function stale(g) { return g !== S.gen || !S.pin; }

  function showPin(reason) {
    S.gen++;
    S.pin = '';
    S.data = null;
    S.refreshing = false;
    S.olderBusy = false;
    S.adding = false;
    S.outBusy = false;
    S.outReq = null;
    $('outForm').hidden = true;
    $('outGo').disabled = false;
    $('outGo').textContent = 'Clock out';
    $('outUndo').disabled = false;
    $('refreshBtn').disabled = false;
    $('refreshBtn').textContent = 'Refresh';
    $('moreBtn').disabled = false;
    $('moreBtn').textContent = 'Show earlier days';
    $('addBtn').disabled = false;
    $('addBtn').textContent = 'Add task';
    S.entry = '';
    S.checking = false;
    clear($('tasksList'));
    clear($('logList'));
    show('pin');
    var msg = '';
    if (reason) {
      if (reason.code === 'bad_pin') {
        msg = 'Wrong PIN.' + (typeof reason.triesLeft === 'number' ? ' ' + plural(reason.triesLeft, 'try', 'tries') + ' left.' : '');
      } else if (reason.code === 'locked') {
        var until = reason.lockedUntil ? new Date(reason.lockedUntil).getTime() : NaN;
        if (isNaN(until)) until = Date.now() + 15 * 60000;
        S.lockedUntil = until;
        msg = 'Too many wrong PINs. Try again at ' + timeOf(new Date(until).toISOString()) + '.';
        clearTimeout(S.lockTimer);
        S.lockTimer = setTimeout(function () {
          S.lockedUntil = 0;
          setMsg($('pinMsg'), 'You can try your PIN again.', 'good');
          renderKeys();
          renderBoxes();
        }, Math.max(1000, until - Date.now() + 500));
      } else {
        msg = str(reason.message) || OFFLINE;
      }
    }
    setMsg($('pinMsg'), msg, reason && reason.code !== 'user_lock' ? 'bad' : '');
    renderKeys();
    renderBoxes();
  }

  function press(d) {
    if (keysLocked() || S.entry.length >= 4) return;
    S.entry += d;
    renderBoxes();
    if (S.entry.length === 4) {
      S.checking = true;
      renderKeys();
      renderBoxes();
      setMsg($('pinMsg'), 'Checking...', '');
      var pin = S.entry;
      setTimeout(function () { open(pin, false); }, 120);
    }
  }

  function backspace() {
    if (keysLocked() || !S.entry) return;
    S.entry = S.entry.slice(0, -1);
    renderBoxes();
  }

  // ---- Opening with a PIN ----
  function open(pin, remembered) {
    var g = S.gen;
    var call = server(function (r) {
      if (g !== S.gen) return;
      if (r.ok) {
        S.pin = pin;
        writeStore(PIN_KEY, pin);
        S.checking = false;
        S.entry = '';
        accept(r);
        show('main');
        selectTab(S.tab, false);
        return;
      }
      if (isAuthFailure(r)) {
        dropStore(PIN_KEY);
        showPin(r);
        return;
      }
      if (remembered) {
        showLoading(str(r.message) || OFFLINE, true);
        return;
      }
      S.checking = false;
      S.entry = '';
      renderKeys();
      renderBoxes();
      setMsg($('pinMsg'), str(r.message) || OFFLINE, 'bad');
    });
    if (call) call.phoneData(pin);
  }

  function accept(r) {
    S.data = normalise(r);
    S.older = [];
    S.olderNext = '';
    S.olderMore = true;
    S.olderDone = false;
    setMsg($('moreMsg'), '', '');
    setMsg($('mainMsg'), '', 'bad');
    setMsg($('outMsg'), '', '');
    render();
  }

  function refresh() {
    if (S.refreshing || !S.pin) return;
    S.refreshing = true;
    $('refreshBtn').disabled = true;
    $('refreshBtn').textContent = 'Refreshing...';
    var g = S.gen;
    var call = server(function (r) {
      if (stale(g)) return;
      S.refreshing = false;
      $('refreshBtn').disabled = false;
      $('refreshBtn').textContent = 'Refresh';
      if (r.ok) { accept(r); return; }
      if (isAuthFailure(r)) { dropStore(PIN_KEY); showPin(r); return; }
      setMsg($('mainMsg'), 'Could not refresh. ' + (str(r.message) || OFFLINE), 'bad');
    });
    if (call) call.phoneData(S.pin);
  }

  function lock() {
    dropStore(PIN_KEY);
    S.tab = 'tasks';
    showPin({ code: 'user_lock' });
    setMsg($('pinMsg'), 'Locked. Enter your PIN to open WorkPulse.', '');
  }

  // ---- Rendering ----
  function render() {
    renderBand();
    renderClock();
    renderTasks();
    renderLog();
    renderProjects();
    renderAsof();
  }

  function figure(label, value, gold) {
    var box = el('div');
    box.appendChild(el('div', 'lab', label));
    box.appendChild(el('div', 'fig' + (gold ? ' gold' : ''), value));
    return box;
  }

  function renderBand() {
    var d = S.data;
    var score = $('score');
    clear(score);
    $('bandDate').textContent = shortDate(d.today);
    var day = d.workdays[d.today] || {};
    var inAt = day.clockIn ? new Date(day.clockIn) : null;
    if (inAt && isNaN(inAt.getTime())) inAt = null;
    if (!inAt) {
      var st = el('div', 'statement', 'Not clocked in');
      st.appendChild(el('small', null, d.pushedAt ? 'Worked time shows here once you clock in on your PC.' : 'Your PC has not sent its data yet.'));
      score.appendChild(st);
      return;
    }
    var outAt = day.clockOut ? new Date(day.clockOut) : null;
    if (outAt && isNaN(outAt.getTime())) outAt = null;
    var end = outAt ? outAt.getTime() : Date.now();
    score.appendChild(figure('Worked today', fmtHM((end - inAt.getTime()) / 60000), true));
    score.appendChild(figure('In at', timeOf(day.clockIn), false));
    if (outAt) score.appendChild(figure('Out at', timeOf(day.clockOut), false));
  }

  // ---- Clock out (script version 10) ----
  // The day the phone may close, as the script picks it: today when clocked in, else yesterday (working past midnight).
  function clockDay() {
    var d = S.data;
    var y = addDays(d.today, -1);
    var t = d.workdays[d.today];
    if (t && t.clockIn && !isNaN(new Date(t.clockIn).getTime())) return { date: d.today, w: t };
    var w = d.workdays[y];
    if (w && w.clockIn && !isNaN(new Date(w.clockIn).getTime())) return { date: y, w: w };
    return null;
  }

  function phoneOut(date, clockOut) {
    var list = S.data.clockOuts;
    for (var i = list.length - 1; i >= 0; i--) {
      if (str(list[i].date) === date && str(list[i].clockOut) === clockOut) return list[i];
    }
    return null;
  }

  function renderClock() {
    var d = S.data;
    var box = $('clockBox');
    var day = clockDay();
    var open = !!day && !day.w.clockOut;
    var mine = day && !open ? phoneOut(day.date, str(day.w.clockOut)) : null;
    if (!d.clockOutEnabled || !day || (!open && !mine)) {
      box.hidden = true;
      $('outForm').hidden = true;
      return;
    }
    box.hidden = false;
    if (!open) $('outForm').hidden = true;
    $('outBtn').hidden = !open || !$('outForm').hidden;
    $('outBtn').textContent = day.date === d.today ? 'Clock out' : 'Clock out of yesterday';
    if (mine) {
      setMsg($('outMsg'), 'Clocked out from your phone at ' + timeOf(mine.clockOut) + '. ' +
        (mine.taken ? 'Your PC has it.' : 'Your PC takes it the next time WorkPulse runs there.'), '');
      $('outUndo').hidden = !(!mine.taken && Date.parse(str(mine.undoUntil)) > Date.now());
    } else {
      $('outUndo').hidden = true;
    }
  }

  // The chosen time as a phone-local instant: today at that time, or yesterday when that is still to come.
  function chosenOut() {
    var m = /^(\d{2}):(\d{2})$/.exec($('outTime').value);
    if (!m) return null;
    var now = new Date();
    var t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2], 0, 0);
    if (t.getTime() > now.getTime() + 60000) t = new Date(t.getTime() - 86400000);
    return t;
  }

  // '' when fine, else what to fix.
  function outProblem(day, t) {
    if (!t) return 'Pick the time you left.';
    if (t.getTime() <= new Date(day.w.clockIn).getTime()) return 'Pick a time after you clocked in (' + timeOf(day.w.clockIn) + ').';
    return '';
  }

  function renderOutSum() {
    var day = clockDay();
    if (!day) return;
    var t = chosenOut();
    var problem = outProblem(day, t);
    $('outSum').textContent = problem || ('Worked ' + fmtHM((t.getTime() - new Date(day.w.clockIn).getTime()) / 60000) +
      ' since ' + timeOf(day.w.clockIn) + (day.date === S.data.today ? '' : ' yesterday') + '.');
  }

  function openOutForm() {
    var now = new Date();
    $('outTime').value = pad(now.getHours()) + ':' + pad(now.getMinutes());
    $('outForm').hidden = false;
    $('outBtn').hidden = true;
    setMsg($('outMsg'), '', '');
    renderOutSum();
    $('outTime').focus();
  }

  function closeOutForm() {
    $('outForm').hidden = true;
    renderClock();
    if (!$('outBtn').hidden) $('outBtn').focus();
  }

  function newRequestId() {
    return 'po-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function clockOut(ev) {
    ev.preventDefault();
    if (S.outBusy || !S.pin) return;
    var day = clockDay();
    if (!day || day.w.clockOut) { closeOutForm(); return; }
    var t = chosenOut();
    var problem = outProblem(day, t);
    if (problem) { setMsg($('outMsg'), problem, 'bad'); $('outTime').focus(); return; }
    // Within the current minute: the Sheet stamps its own now, to the second.
    var at = Date.now() - t.getTime() < 60000 ? '' : t.toISOString();
    // A retry after a lost answer keeps the same id, so the Sheet never closes the day twice.
    if (!S.outReq || S.outReq.at !== at) S.outReq = { id: newRequestId(), at: at };
    S.outBusy = true;
    var btn = $('outGo');
    btn.disabled = true;
    btn.textContent = 'Clocking out...';
    setMsg($('outMsg'), '', '');
    var g = S.gen;
    var call = server(function (r) {
      if (stale(g)) return;
      S.outBusy = false;
      btn.disabled = false;
      btn.textContent = 'Clock out';
      if (!r.ok) {
        if (isAuthFailure(r)) { dropStore(PIN_KEY); showPin(r); return; }
        if (r.code !== 'offline') S.outReq = null;
        setMsg($('outMsg'), str(r.message) || OFFLINE, 'bad');
        return;
      }
      S.outReq = null;
      var c = r.clockOut || {};
      var date = str(c.date);
      var w = S.data.workdays[date] || {};
      w.clockOut = str(c.clockOut);
      S.data.workdays[date] = w;
      S.data.clockOuts = S.data.clockOuts.filter(function (x) { return x.id !== c.id; });
      S.data.clockOuts.push(c);
      $('outForm').hidden = true;
      renderBand();
      renderClock();
    });
    if (call) call.phoneClockOut(S.pin, S.outReq);
  }

  function undoOut() {
    if (S.outBusy || !S.pin) return;
    var day = clockDay();
    var mine = day && day.w.clockOut ? phoneOut(day.date, str(day.w.clockOut)) : null;
    if (!mine) return;
    S.outBusy = true;
    var btn = $('outUndo');
    btn.disabled = true;
    var g = S.gen;
    var call = server(function (r) {
      if (stale(g)) return;
      S.outBusy = false;
      btn.disabled = false;
      if (!r.ok) {
        if (isAuthFailure(r)) { dropStore(PIN_KEY); showPin(r); return; }
        setMsg($('outMsg'), str(r.message) || OFFLINE, 'bad');
        if (r.code === 'taken' || r.code === 'too_late') btn.hidden = true;
        return;
      }
      delete S.data.workdays[str(mine.date)].clockOut;
      S.data.clockOuts = S.data.clockOuts.filter(function (x) { return x.id !== mine.id; });
      renderBand();
      renderClock();
      setMsg($('outMsg'), 'Clock-out undone. The day is open again.', '');
      $('outBtn').focus();
    });
    if (call) call.phoneUndoClockOut(S.pin, mine.id);
  }

  // Open tasks from the PC plus the phone tasks it has not taken yet (once each).
  function openTasks() {
    var d = S.data;
    var seen = {};
    var list = [];
    d.tasks.forEach(function (t) {
      if (!t || str(t.stage) === 'done') return;
      seen[str(t.id)] = true;
      list.push({
        id: str(t.id), title: str(t.title), project: str(t.project), projectId: str(t.projectId),
        due: str(t.dueDate), stage: str(t.stage), tracked: Number(t.trackedMinutes) || 0, waiting: false
      });
    });
    d.pending.forEach(function (p) {
      if (!p || seen[str(p.id)]) return;
      seen[str(p.id)] = true;
      list.push({
        id: str(p.id), title: str(p.title), project: str(p.projectName), projectId: str(p.projectId),
        due: str(p.dueDate), stage: 'planned', tracked: 0, waiting: true
      });
    });
    return list;
  }

  // Today, Tomorrow, Yesterday and older days newest first, then later days oldest first.
  function groupOrder(today) {
    var tomorrow = addDays(today, 1);
    return function (a, b) {
      function rank(x) {
        if (x === today) return [0, ''];
        if (x === tomorrow) return [1, ''];
        if (!isDate(x)) return [4, ''];
        if (x < today) return [2, x];
        return [3, x];
      }
      var ra = rank(a);
      var rb = rank(b);
      if (ra[0] !== rb[0]) return ra[0] - rb[0];
      if (ra[1] === rb[1]) return 0;
      if (ra[0] === 2) return ra[1] < rb[1] ? 1 : -1;
      return ra[1] < rb[1] ? -1 : 1;
    };
  }

  function groupBy(items, key) {
    var groups = {};
    var keys = [];
    items.forEach(function (it) {
      var k = it[key];
      if (!groups[k]) { groups[k] = []; keys.push(k); }
      groups[k].push(it);
    });
    return { groups: groups, keys: keys };
  }

  function groupHead(label, meta) {
    var h = el('h2', 'head');
    h.appendChild(el('span', null, label));
    h.appendChild(el('span', 'meta num', meta));
    return h;
  }

  function ribbon(color) {
    var r = el('div', 'rib');
    if (color) r.style.background = color;
    return r;
  }

  function stageLabel(t) {
    if (t.stage === 'in_progress') return { text: 'running on PC', cls: 'live' };
    if (t.stage === 'paused') return { text: 'paused', cls: '' };
    if (t.stage === 'blocked') return { text: 'blocked', cls: 'blocked' };
    return null;
  }

  function taskRow(t) {
    var li = el('li', 't' + (t.stage === 'in_progress' ? ' run' : '') + (t.id === S.flash ? ' new' : ''));
    li.appendChild(ribbon(colorOf(t.projectId, t.project)));
    var box = el('div');
    box.appendChild(el('p', 'ti', t.title || '(no title)'));
    var meta = el('p', 'pr');
    var parts = [];
    parts.push(el('span', null, t.project || 'No project'));
    if (t.waiting) {
      parts.push(el('span', 'wait', 'waiting for your PC'));
    } else {
      var st = stageLabel(t);
      if (st) parts.push(el('span', st.cls, st.text));
      if (t.tracked > 0) parts.push(el('span', 'num', fmtHM(t.tracked) + ' tracked'));
      if (!st && t.tracked <= 0) parts.push(el('span', null, 'planned'));
    }
    parts.forEach(function (p, i) {
      if (i) meta.appendChild(document.createTextNode(' · '));
      meta.appendChild(p);
    });
    box.appendChild(meta);
    li.appendChild(box);
    return li;
  }

  function emptyBox(title, line) {
    var b = el('div', 'empty');
    b.appendChild(el('p', null, title));
    if (line) b.appendChild(el('p', 'small', line));
    return b;
  }

  function renderTasks() {
    var d = S.data;
    var list = openTasks();
    var host = $('tasksList');
    clear(host);
    $('taskCount').textContent = list.length ? String(list.length) : '';
    if (!list.length) {
      host.appendChild(emptyBox('No open tasks.', 'Plan the day from the Add tab: what you add here waits for your PC.'));
      return;
    }
    var g = groupBy(list, 'due');
    g.keys.sort(groupOrder(d.today)).forEach(function (k) {
      var sec = el('section', 'group');
      var items = g.groups[k];
      sec.appendChild(groupHead(dayName(k, d.today), plural(items.length, 'task', 'tasks')));
      var ul = el('ul', 'card');
      items.forEach(function (t) { ul.appendChild(taskRow(t)); });
      sec.appendChild(ul);
      host.appendChild(sec);
    });
    S.flash = '';
  }

  function logItem(l) {
    return {
      id: str(l.id), date: str(l.date), time: hhmm(l.time), project: str(l.project),
      projectId: str(l.projectId), text: str(l.description), minutes: Number(l.minutes) || 0
    };
  }

  function byNewest(a, b) {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.time < b.time ? 1 : a.time > b.time ? -1 : 0;
  }

  function logRow(l) {
    var li = el('li', 'lg');
    li.appendChild(el('span', 'tm num', l.time));
    li.appendChild(ribbon(colorOf(l.projectId, l.project)));
    var box = el('div', 'ds');
    box.appendChild(el('span', null, l.text || '(no description)'));
    box.appendChild(el('span', 'pj', l.project || 'No project'));
    li.appendChild(box);
    var mn = el('span', 'mn', fmtHM(l.minutes));
    mn.setAttribute('aria-label', l.minutes + ' minutes');
    li.appendChild(mn);
    return li;
  }

  function renderLog() {
    var d = S.data;
    var host = $('logList');
    clear(host);
    var logs = d.logs.map(logItem).filter(function (l) { return isDate(l.date); });
    logs = logs.concat(S.older).sort(byNewest);
    if (!logs.length) {
      host.appendChild(emptyBox('No logs in the last 14 days.', 'Logs you write on your PC show here.'));
    } else {
      var g = groupBy(logs, 'date');
      g.keys.forEach(function (k) {
        var items = g.groups[k];
        var total = 0;
        items.forEach(function (l) { total += l.minutes; });
        var sec = el('section', 'group');
        sec.appendChild(groupHead(dayName(k, d.today), plural(items.length, 'log', 'logs') + ' · ' + fmtHM(total)));
        var ul = el('ul', 'card');
        items.forEach(function (l) { ul.appendChild(logRow(l)); });
        sec.appendChild(ul);
        host.appendChild(sec);
      });
    }
    $('moreBtn').hidden = !S.olderMore;
  }

  // The first page starts below the PC's 14 days (and below its oldest log), so no day shows twice.
  function firstOlderDate() {
    var d = S.data;
    var before = addDays(d.today, -13);
    d.logs.forEach(function (l) { if (isDate(l.date) && l.date < before) before = l.date; });
    return before;
  }

  function loadOlder() {
    if (S.olderBusy || !S.olderMore || !S.pin) return;
    S.olderBusy = true;
    var btn = $('moreBtn');
    btn.disabled = true;
    btn.textContent = 'Loading...';
    setMsg($('moreMsg'), '', '');
    var before = S.olderNext || firstOlderDate();
    var g = S.gen;
    var call = server(function (r) {
      if (stale(g)) return;
      S.olderBusy = false;
      btn.disabled = false;
      btn.textContent = 'Show earlier days';
      if (!r.ok) {
        if (isAuthFailure(r)) { dropStore(PIN_KEY); showPin(r); return; }
        setMsg($('moreMsg'), str(r.message) || OFFLINE, 'bad');
        return;
      }
      var shown = {};
      S.data.logs.forEach(function (l) { shown[str(l.date)] = true; });
      arr(r.logs).forEach(function (l) {
        var it = logItem(l);
        if (isDate(it.date) && !shown[it.date] && it.date < before) S.older.push(it);
      });
      S.olderNext = isDate(r.nextBefore) ? r.nextBefore : before;
      S.olderMore = r.more === true && S.olderNext < before;
      renderLog();
      if (!S.olderMore) setMsg($('moreMsg'), arr(r.logs).length ? 'That is everything in your Sheet.' : 'No earlier logs in your Sheet.', '');
    });
    if (call) call.phoneOlderLogs(S.pin, before);
  }

  function renderProjects() {
    var d = S.data;
    var sel = $('addProject');
    var keep = sel.value || readStore(PROJECT_KEY);
    clear(sel);
    var none = el('option', null, 'No project');
    none.value = '';
    sel.appendChild(none);
    d.projects.forEach(function (p) {
      var o = el('option', null, str(p.name) || 'Unnamed project');
      o.value = str(p.id);
      sel.appendChild(o);
    });
    sel.value = keep && d.byId[keep] ? keep : '';
    var lsel = $('logProject');
    var lkeep = lsel.value || keep;
    clear(lsel);
    var lnone = el('option', null, 'No project');
    lnone.value = '';
    lsel.appendChild(lnone);
    d.projects.forEach(function (p) {
      var o = el('option', null, str(p.name) || 'Unnamed project');
      o.value = str(p.id);
      lsel.appendChild(o);
    });
    lsel.value = lkeep && d.byId[lkeep] ? lkeep : '';
  }

  function renderAsof() {
    var d = S.data;
    var text;
    if (!d.pushedAt) {
      text = 'No data from your PC yet';
    } else {
      var t = new Date(d.pushedAt);
      if (isNaN(t.getTime())) text = 'No data from your PC yet';
      else if (localDate(t) === d.today) text = 'Data from your PC as of ' + timeOf(d.pushedAt);
      else text = 'Data from your PC as of ' + shortDate(localDate(t)) + ', ' + timeOf(d.pushedAt);
    }
    $('asofText').textContent = text;
  }

  // ---- Tabs ----
  var TABS = ['tasks', 'log', 'add'];
  function selectTab(name, focus) {
    S.tab = name;
    TABS.forEach(function (t) {
      var on = t === name;
      var tab = $('tab-' + t);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      $('panel-' + t).hidden = !on;
      if (on && focus) tab.focus();
    });
  }

  // ---- Add ----
  function chosenDay() {
    var r = document.querySelector('input[name="day"]:checked');
    return r && r.value === 'tomorrow' ? 'tomorrow' : 'today';
  }

  function addTask(ev) {
    ev.preventDefault();
    if (S.adding || !S.pin) return;
    var input = $('addTitle');
    var title = input.value.replace(/^\s+|\s+$/g, '');
    var msg = $('addMsg');
    if (!title) {
      setMsg(msg, 'Type a task first.', 'bad');
      input.focus();
      return;
    }
    var day = chosenDay();
    var projectId = $('addProject').value;
    S.adding = true;
    var btn = $('addBtn');
    btn.disabled = true;
    btn.textContent = 'Adding...';
    setMsg(msg, '', '');
    var g = S.gen;
    var call = server(function (r) {
      if (stale(g)) return;
      S.adding = false;
      btn.disabled = false;
      btn.textContent = 'Add task';
      if (!r.ok) {
        if (isAuthFailure(r)) { dropStore(PIN_KEY); showPin(r); return; }
        setMsg(msg, str(r.message) || OFFLINE, 'bad');
        return;
      }
      var item = r.item || {};
      S.data.pending.push(item);
      S.flash = str(item.id);
      writeStore(PROJECT_KEY, projectId);
      input.value = '';
      renderTasks();
      setMsg(msg, 'Added to ' + (day === 'tomorrow' ? 'Tomorrow' : 'Today') + ': ' + str(item.title || title) + '. It waits under Tasks for your PC.', 'good');
      input.focus();
    });
    if (call) call.phoneAddTask(S.pin, { title: title, projectId: projectId, day: day });
  }

  // ---- Add a log for a day outside the office ----
  function addLog(ev) {
    ev.preventDefault();
    if (S.addingLog || !S.pin) return;
    var msg = $('logMsg');
    var text = $('logText').value.replace(/^\s+|\s+$/g, '');
    var time = $('logTime').value;
    var minutes = parseInt($('logMinutes').value, 10);
    if (!text) { setMsg(msg, 'Type what you did first.', 'bad'); $('logText').focus(); return; }
    if (!/^\d{2}:\d{2}$/.test(time)) { setMsg(msg, 'Pick the time you started.', 'bad'); $('logTime').focus(); return; }
    if (!(minutes >= 1 && minutes <= 960)) { setMsg(msg, 'Type how many minutes it took (1 to 960).', 'bad'); $('logMinutes').focus(); return; }
    var dayRadio = document.querySelector('input[name="logday"]:checked');
    var day = dayRadio && dayRadio.value === 'yesterday' ? 'yesterday' : 'today';
    var projectId = $('logProject').value;
    S.addingLog = true;
    var btn = $('logBtn');
    btn.disabled = true;
    btn.textContent = 'Adding...';
    setMsg(msg, '', '');
    var g = S.gen;
    var call = server(function (r) {
      if (stale(g)) return;
      S.addingLog = false;
      btn.disabled = false;
      btn.textContent = 'Add log';
      if (!r.ok) {
        if (isAuthFailure(r)) { dropStore(PIN_KEY); showPin(r); return; }
        setMsg(msg, str(r.message) || OFFLINE, 'bad');
        return;
      }
      var saved = r.log || {};
      S.data.logs.push(saved);
      $('logText').value = '';
      $('logMinutes').value = '';
      renderLog();
      setMsg(msg, 'Logged for ' + (day === 'yesterday' ? 'Yesterday' : 'Today') + ': ' + str(saved.description || text) + ' (' + fmtHM(minutes) + ').', 'good');
    });
    if (call) call.phoneAddLog(S.pin, { text: text, projectId: projectId, time: time, minutes: minutes, day: day });
  }

  // ---- Wiring ----
  $('keys').addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button') : null;
    if (!b || b.disabled) return;
    if (b.id === 'backKey') backspace();
    else if (b.getAttribute('data-d')) press(b.getAttribute('data-d'));
  });
  document.addEventListener('keydown', function (ev) {
    if ($('pinView').hidden || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (/^[0-9]$/.test(ev.key)) { ev.preventDefault(); press(ev.key); }
    else if (ev.key === 'Backspace') { ev.preventDefault(); backspace(); }
  });
  TABS.forEach(function (t, i) {
    var tab = $('tab-' + t);
    tab.addEventListener('click', function () { selectTab(t, false); });
    tab.addEventListener('keydown', function (ev) {
      var step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      ev.preventDefault();
      selectTab(TABS[(i + step + TABS.length) % TABS.length], true);
    });
  });
  $('lockBtn').addEventListener('click', lock);
  $('refreshBtn').addEventListener('click', refresh);
  $('moreBtn').addEventListener('click', loadOlder);
  $('addForm').addEventListener('submit', addTask);
  $('logForm').addEventListener('submit', addLog);
  $('retryBtn').addEventListener('click', start);
  $('outBtn').addEventListener('click', openOutForm);
  $('outCancel').addEventListener('click', closeOutForm);
  $('outForm').addEventListener('submit', clockOut);
  $('outTime').addEventListener('input', renderOutSum);
  $('outUndo').addEventListener('click', undoOut);
  setInterval(function () { if (S.data && !$('mainView').hidden) { renderBand(); renderClock(); } }, 30000);

  function start() {
    var saved = readStore(PIN_KEY);
    if (/^\d{4}$/.test(saved)) {
      showLoading('Opening WorkPulse...', false);
      open(saved, true);
      return;
    }
    if (!writeStore('workpulse_phone_probe', '1')) {
      $('pinHint').textContent = 'This browser does not keep the PIN, so it is asked each time.';
    } else {
      dropStore('workpulse_phone_probe');
    }
    showPin(null);
  }

  start();
})();
</script>
</body>
</html>
`;

// The page as a script string literal: JSON-escaped and ASCII-only (\uXXXX for anything else), so no
// quote, backslash, line break or unusual character in the HTML can end or break the script string.
function scriptString(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export const SCRIPT_PHONE = `
// =========================================================================
// Phone page (doGet?page=phone)
// =========================================================================

// The whole page, one self-contained HTML file. Its source is src/utils/appsScript/phonePage.ts.
var PHONE_PAGE_HTML = ${scriptString(PHONE_PAGE_HTML)};

function servePhonePage() {
  return HtmlService.createHtmlOutput(PHONE_PAGE_HTML)
    .setTitle('WorkPulse')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
`;
