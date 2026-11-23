"""Browser check of the phone page (the HTML the Google script serves at ?page=phone).

Run by hand from the repo root (not part of `npm run test:smoke`; no dev server needed):

    python tests/smoke/phone_page.py <screenshot dir>

It reads PHONE_PAGE_HTML from src/utils/appsScript/phonePage.ts (through tsx), serves it at a fake https
origin so localStorage works, and replaces google.script.run with a stub that answers phoneData,
phoneAddTask, phoneOlderLogs, phoneClockOut and phoneUndoClockOut from canned data. Screenshots (390x844) go to the directory given.
"""
import json
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright, expect

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
URL = "https://phone.workpulse.test/exec"
PIN = "2468"
TODAY = "2026-11-11"
NOW = "2026-11-11T07:00:00.000Z"  # 13:00 in Dhaka
HOSTILE = "<img src=x onerror=window.__pwned=1>"
LONG = ("Prepare the quarterly attendance and leave balance reconciliation for every section, "
        "including the night shift exceptions, before the progress meeting")


def page_html():
    code = "import { PHONE_PAGE_HTML } from './src/utils/appsScript/phonePage.ts'; process.stdout.write(PHONE_PAGE_HTML);"
    out = subprocess.run("npx tsx -e " + json.dumps(code), cwd=ROOT, shell=True, capture_output=True, check=True)
    return out.stdout.decode("utf-8")


PROJECTS = [
    {"id": "p1", "name": "BGB Portal", "color": "#2e86de"},
    {"id": "p2", "name": "HR Dashboard", "color": "#e07a2f"},
    {"id": "p3", "name": "Meetings", "color": "#8e5bd6"},
    {"id": "p4", "name": "WorkPulse", "color": "#2aa876"},
]


def task(i, title, pid, pname, due, stage="planned", tracked=0, from_phone=False):
    return {"id": "task-" + str(i), "title": title, "project": pname, "projectId": pid, "dueDate": due,
            "stage": stage, "trackedMinutes": tracked, "completedAt": "", "fromPhone": from_phone}


def log(i, date, time, pid, pname, text, minutes):
    return {"id": "log-" + str(i), "date": date, "time": time, "project": pname, "projectId": pid,
            "description": text, "status": "completed", "minutes": minutes}


FULL = {
    "ok": True,
    "today": TODAY,
    "pushedAt": "2026-11-11T03:55:00.000Z",
    "workdayHours": 8,
    "projects": PROJECTS,
    "workdays": {TODAY: {"clockIn": "2026-11-11T03:48:00.000Z", "clockOut": ""}},
    "tasks": [
        task(1, "Fix date filter on attendance report", "p1", "BGB Portal", TODAY, "in_progress", 72),
        task(2, "Monthly progress meeting", "p3", "Meetings", TODAY),
        task(3, HOSTILE, "p2", "HR Dashboard", TODAY),
        task(4, LONG, "p2", "HR Dashboard", TODAY, "blocked", 15),
        task(5, "Write migration for leave balance table", "p2", "HR Dashboard", "2026-11-10", "paused", 70),
        task(6, "Review pull request #212", "p1", "BGB Portal", "2026-11-10"),
        task(7, "Draft RFC for search indexing", "p1", "BGB Portal", "2026-11-09"),
        task(8, "Finished already", "p1", "BGB Portal", TODAY, "done", 30),
    ],
    "pending": [
        {"id": "phone-1", "title": "Review leave-balance migration with Rafiq", "projectId": "p4",
         "projectName": "WorkPulse", "dueDate": TODAY, "createdAt": "2026-11-11T02:10:00.000Z"},
    ],
    "logs": [
        log(1, TODAY, "11:58", "p1", "BGB Portal", "Reviewed search PR #212, requested index change", 34),
        log(2, TODAY, "10:40", "p2", "HR Dashboard", "Leave balance: schema review with Rafiq", 52),
        log(3, "2026-11-10", "17:30", "p4", "WorkPulse", "Deployed WorkPulse suggestions build", 52),
        log(4, "2026-11-10", "15:05", "p1", "BGB Portal", "Built attendance filters and fixed the timezone bug in date ranges", 130),
        log(5, "2026-11-10", "12:20", "p3", "Meetings", "Progress meeting with section head", 60),
        log(6, "2026-11-10", "10:10", "p2", "HR Dashboard", HOSTILE, 226),
    ],
}

CLOCK = dict(FULL, clockOutEnabled=True, clockOuts=[])

EMPTY = {"ok": True, "today": TODAY, "pushedAt": "", "workdayHours": 8, "projects": [], "workdays": {},
         "tasks": [], "pending": [], "logs": []}

MANY = dict(FULL)
MANY["tasks"] = [task(100 + i, ("Task number %d for the backlog" % (i + 1)) if i != 3 else LONG,
                      PROJECTS[i % 4]["id"], PROJECTS[i % 4]["name"],
                      ["2026-11-11", "2026-11-12", "2026-11-10", "2026-11-06", "2026-11-14"][i % 5],
                      ["planned", "paused", "blocked", "in_progress", "planned"][i % 5], (i * 17) % 200)
                 for i in range(30)]

OLDER_PAGES = {
    # before -> answer
    "2026-10-29": {"ok": True, "logs": [log(20, "2026-10-28", "16:00", "", "BGB Portal", "Older work on the portal", 95),
                                         log(21, "2026-10-27", "09:30", "", "Meetings", "Planning", 30)],
                   "nextBefore": "2026-10-27", "more": True},
    "2026-10-27": {"ok": True, "logs": [log(22, "2026-10-20", "11:00", "", "HR Dashboard", "First HR task", 45)],
                   "nextBefore": "2026-10-20", "more": False},
}

STUB = r"""
(function () {
  window.__calls = [];
  var seed = window.__seed || {};
  window.__answers = { data: seed.data || null, older: seed.older || {}, fail: false };
  function runner() {
    var ok = null, bad = null;
    var r = {
      withSuccessHandler: function (f) { ok = f; return r; },
      withFailureHandler: function (f) { bad = f; return r; }
    };
    // The answer is worked out when the reply is sent, so a test can change __answers in between.
    function answer(name, args, value) {
      window.__calls.push({ fn: name, args: JSON.parse(JSON.stringify(args)) });
      setTimeout(function () {
        if (window.__answers.fail) { bad && bad(new Error('NetworkError')); return; }
        ok && ok(JSON.parse(JSON.stringify(value())));
      }, window.__answers.delay || 60);
    }
    r.phoneData = function (pin) {
      var a = window.__answers;
      answer('phoneData', [pin], function () {
        return a.locked ? a.locked : pin === '2468' ? a.data : { ok: false, code: 'bad_pin', message: 'That PIN is not right.', triesLeft: 3 };
      });
    };
    r.phoneAddTask = function (pin, task) {
      var id = 'phone-new-' + window.__calls.length;
      answer('phoneAddTask', [pin, task], function () {
        return { ok: true, item: { id: id, title: task.title, projectId: task.projectId, projectName: '',
          dueDate: task.day === 'tomorrow' ? '2026-11-12' : '2026-11-11', createdAt: new Date().toISOString() } };
      });
    };
    r.phoneClockOut = function (pin, req) {
      answer('phoneClockOut', [pin, req], function () {
        var made = new Date().getTime();
        return { ok: true, clockOut: { id: req.id, date: '2026-11-11', clockOut: req.at || new Date(made).toISOString(), taken: false,
          undoUntil: new Date(made + 600000).toISOString() } };
      });
    };
    r.phoneUndoClockOut = function (pin, id) {
      answer('phoneUndoClockOut', [pin, id], function () { return { ok: true }; });
    };
    r.phoneOlderLogs = function (pin, before) {
      answer('phoneOlderLogs', [pin, before], function () {
        return window.__answers.older[before] || { ok: true, logs: [], nextBefore: before, more: false };
      });
    };
    return r;
  }
  window.google = { script: {} };
  Object.defineProperty(window.google.script, 'run', { get: runner });
})();
"""

failures = []


def check(cond, what):
    print(("PASS " if cond else "FAIL ") + what)
    if not cond:
        failures.append(what)


def no_hscroll(page, where):
    w = page.evaluate("[document.documentElement.scrollWidth, document.documentElement.clientWidth]")
    check(w[0] <= w[1], "no horizontal scroll: " + where + " (%d <= %d)" % (w[0], w[1]))


def new_page(browser, html, data, block_storage=False):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, timezone_id="Asia/Dhaka")
    ctx.add_init_script("window.__seed = " + json.dumps({"data": data, "older": OLDER_PAGES}) + ";")
    ctx.add_init_script(STUB)
    if block_storage:
        ctx.add_init_script("Object.defineProperty(window, 'localStorage', { get: function () { throw new Error('SecurityError'); } });")
    ctx.route(URL, lambda route: route.fulfill(status=200, content_type="text/html; charset=utf-8", body=html))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.clock.set_fixed_time(NOW)
    page.goto(URL)
    return ctx, page, errors


def enter(page, pin):
    for d in pin:
        page.click('#keys button[data-d="%s"]' % d)


def main():
    if len(sys.argv) < 2:
        print("usage: python tests/smoke/phone_page.py <screenshot dir>")
        sys.exit(2)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    shot = lambda page, name, full=False: page.screenshot(path=os.path.join(out, name + ".png"), full_page=full)
    html = page_html()

    with sync_playwright() as p:
        browser = p.chromium.launch()

        # ---- PIN, wrong PIN, right PIN, Tasks ----
        ctx, page, errors = new_page(browser, html, FULL)
        expect(page.locator("#pinView")).to_be_visible()
        check(page.locator("#mainView").is_hidden(), "PIN screen first, no data shown")
        shot(page, "01-pin")
        no_hscroll(page, "PIN")

        enter(page, "1111")
        expect(page.locator("#pinMsg")).to_contain_text("Wrong PIN.")
        check("3 tries left" in page.inner_text("#pinMsg"), "wrong PIN says how many tries are left")
        check(page.locator("#boxes i.on").count() == 0, "boxes are cleared after a wrong PIN")
        shot(page, "02-wrong-pin")

        page.keyboard.type(PIN)  # a hardware keyboard works too
        expect(page.locator("#mainView")).to_be_visible()
        heads = page.locator("#tasksList .head > span:first-child").all_text_contents()
        check(heads[:3] == ["Today", "Yesterday", "Mon 9 Nov"], "task groups Today, Yesterday, Mon 9 Nov: %s" % heads)
        check(page.inner_text("#taskCount") == "8", "Tasks tab counts 7 open PC tasks + 1 phone task (done one left out)")
        check("Finished already" not in page.inner_text("#tasksList"), "done tasks are not listed")
        check(page.locator("#tasksList .ti", has_text=HOSTILE).count() == 1, "hostile title renders as text")
        check(page.evaluate("window.__pwned") is None, "hostile title did not run")
        check(page.locator("#tasksList img").count() == 0, "no element was created from a title")
        check(page.locator("#tasksList .wait").count() == 1, "phone task shows 'waiting for your PC'")
        check(page.locator(".score .fig.gold").count() == 1, "band shows worked time")
        score = page.text_content("#score")
        check("3:12" in score and "09:48" in score, "band shows worked 3:12 and in at 09:48: " + score)
        check("Data from your PC as of 09:55" in page.inner_text("#asofText"), "as-of line shows 09:55")
        check(page.locator("#clockBox").is_hidden(), "no Clock out button with a script that does not offer it (before version 10)")
        check(page.evaluate("localStorage.getItem('workpulse_phone_pin')") == PIN, "PIN remembered on this phone")
        shot(page, "03-tasks")
        shot(page, "03-tasks-full", True)
        no_hscroll(page, "Tasks")

        # ---- Log + Earlier ----
        page.click("#tab-log")
        heads = page.locator("#logList .head").all_inner_texts()
        check(len(heads) == 2 and "2 logs" in heads[0] and "1:26" in heads[0], "Today total 2 logs, 1:26: %s" % heads[:1])
        check("4 logs" in heads[1] and "7:48" in heads[1], "Yesterday total 4 logs, 7:48: %s" % heads[1:])
        check(page.evaluate("window.__pwned") is None, "hostile log text did not run")
        shot(page, "04-log")
        page.click("#moreBtn")
        expect(page.locator("#logList .group")).to_have_count(4)
        calls = page.evaluate("window.__calls.filter(function (c) { return c.fn === 'phoneOlderLogs'; })")
        check(calls[0]["args"] == [PIN, "2026-10-29"], "first Earlier page asks before 2026-10-29: %s" % calls[0]["args"])
        expect(page.locator("#moreBtn")).to_be_visible()
        page.click("#moreBtn")
        expect(page.locator("#logList .group")).to_have_count(5)
        calls = page.evaluate("window.__calls.filter(function (c) { return c.fn === 'phoneOlderLogs'; })")
        check(calls[1]["args"] == [PIN, "2026-10-27"], "second page uses nextBefore 2026-10-27")
        check(page.locator("#moreBtn").is_hidden(), "Earlier button goes when more is false")
        check("everything" in page.inner_text("#moreMsg"), "says that is everything")
        shot(page, "05-log-earlier-full", True)
        no_hscroll(page, "Log")

        # ---- Add (Tomorrow) ----
        page.click("#tab-add")
        shot(page, "06-add")
        page.click("#addBtn")
        expect(page.locator("#addMsg")).to_have_text("Type a task first.")
        page.fill("#addTitle", "Call the vendor about the scanner")
        page.select_option("#addProject", "p3")
        page.click(".seg label:has-text('Tomorrow')")
        page.click("#addBtn")
        expect(page.locator("#addMsg")).to_contain_text("Added to Tomorrow")
        add = page.evaluate("window.__calls.filter(function (c) { return c.fn === 'phoneAddTask'; })[0]")
        check(add["args"][0] == PIN and add["args"][1] == {"title": "Call the vendor about the scanner", "projectId": "p3", "day": "tomorrow"},
              "phoneAddTask got day 'tomorrow': %s" % add["args"])
        check(page.input_value("#addTitle") == "", "title cleared for the next task")
        shot(page, "07-add-done")
        page.click("#tab-tasks")
        heads = page.locator("#tasksList .head > span:first-child").all_text_contents()
        check(heads[:2] == ["Today", "Tomorrow"], "Tomorrow group appears right after Today: %s" % heads)
        tomorrow = page.locator("#tasksList .group").nth(1)
        check("Call the vendor about the scanner" in tomorrow.inner_text() and "waiting for your PC" in tomorrow.inner_text(),
              "new task shows at once under Tomorrow with the waiting mark")
        check(page.inner_text("#taskCount") == "9", "count goes to 9")
        page.wait_for_timeout(1700)
        shot(page, "08-tasks-after-add")

        # ---- Lock, then reload with a remembered PIN ----
        page.click("#lockBtn")
        expect(page.locator("#pinView")).to_be_visible()
        check(page.evaluate("localStorage.getItem('workpulse_phone_pin')") is None, "Lock forgets the PIN")
        check(page.locator("#tasksList .t").count() == 0, "Lock removes the data from the page")
        shot(page, "09-locked-by-user")
        enter(page, PIN)
        expect(page.locator("#mainView")).to_be_visible()
        page.reload()
        expect(page.locator("#mainView")).to_be_visible()
        check(page.locator("#pinView").is_hidden(), "a remembered PIN opens straight to Tasks")

        # ---- Lockout ----
        page.evaluate("window.__answers.locked = { ok: false, code: 'locked', message: 'Too many wrong PINs. Try again in 15 minutes.', lockedUntil: '2026-11-11T07:15:00.000Z' }")
        page.click("#refreshBtn")
        expect(page.locator("#pinView")).to_be_visible()
        expect(page.locator("#pinMsg")).to_contain_text("Too many wrong PINs. Try again at 13:15.")
        check(page.locator("#keys button[data-d='1']").is_disabled(), "keypad is off while locked")
        shot(page, "10-lockout")
        no_hscroll(page, "lockout")
        check(not errors, "no page errors: %s" % errors)
        ctx.close()

        # ---- Empty states, storage blocked ----
        ctx, page, errors = new_page(browser, html, EMPTY, block_storage=True)
        check("asked each time" in page.inner_text("#pinHint"), "blocked storage: hint says the PIN is asked each time")
        enter(page, PIN)
        expect(page.locator("#mainView")).to_be_visible()
        check("No open tasks." in page.inner_text("#tasksList"), "empty Tasks state")
        check("Not clocked in" in page.inner_text("#score"), "band says Not clocked in")
        check("No data from your PC yet" in page.inner_text("#asofText"), "as-of says no data yet")
        shot(page, "11-empty-tasks")
        page.click("#tab-log")
        check("No logs in the last 14 days." in page.inner_text("#logList"), "empty Log state")
        shot(page, "12-empty-log")
        page.click("#tab-add")
        page.fill("#addTitle", "Works without storage")
        page.click("#addBtn")
        expect(page.locator("#addMsg")).to_contain_text("Added to Today")
        check(not errors, "no page errors with storage blocked: %s" % errors)
        ctx.close()

        # ---- 30 tasks with a long title ----
        ctx, page, errors = new_page(browser, html, MANY)
        enter(page, PIN)
        expect(page.locator("#mainView")).to_be_visible()
        heads = page.locator("#tasksList .head > span:first-child").all_text_contents()
        check(heads == ["Today", "Tomorrow", "Yesterday", "Fri 6 Nov", "Sat 14 Nov"], "30 tasks: group order %s" % heads)
        check(page.inner_text("#taskCount") == "31", "30 tasks + 1 phone task counted")
        shot(page, "13-many-tasks")
        shot(page, "13-many-tasks-full", True)
        no_hscroll(page, "30 tasks")
        check(not errors, "no page errors: %s" % errors)
        ctx.close()

        # ---- Lock pressed while requests are still pending ----
        ctx, page, errors = new_page(browser, html, FULL)
        enter(page, PIN)
        expect(page.locator("#mainView")).to_be_visible()
        page.evaluate("window.__answers.delay = 500")
        page.click("#tab-add")
        page.fill("#addTitle", "Secret task typed before Lock")
        # Add, Earlier and Refresh all wait for their reply, then Lock is pressed.
        page.evaluate("document.getElementById('addBtn').click(); document.getElementById('moreBtn').click(); document.getElementById('refreshBtn').click();")
        sent = page.evaluate("window.__calls.map(function (c) { return c.fn; })")
        check("phoneAddTask" in sent and "phoneOlderLogs" in sent and sent.count("phoneData") == 2,
              "Add, Earlier and Refresh are all waiting for a reply when Lock is pressed: %s" % sent)
        page.click("#lockBtn")
        expect(page.locator("#pinView")).to_be_visible()
        page.wait_for_timeout(900)  # every delayed reply has arrived by now
        check(not errors, "Lock with pending requests: no page errors: %s" % errors)
        check(page.locator("#pinView").is_visible() and page.locator("#mainView").is_hidden(), "still on the PIN screen after the late replies")
        check(page.locator("#tasksList").inner_html() == "" and page.locator("#logList").inner_html() == "",
              "late replies did not refill the hidden lists")
        body = page.inner_text("body") + page.evaluate("document.getElementById('tasksList').textContent + document.getElementById('logList').textContent")
        check("Fix date filter" not in body and "Reviewed search PR" not in body and "Secret task" not in body,
              "no private text is left in the page after Lock")
        check(page.locator("#refreshBtn").is_enabled() and page.inner_text("#refreshBtn") == "Refresh",
              "Refresh button is not left stuck after Lock")
        page.evaluate("window.__answers.delay = 60")
        enter(page, PIN)
        expect(page.locator("#mainView")).to_be_visible()
        check(page.locator("#tasksList .ti").count() > 0, "the page opens normally again after unlocking")
        check(not errors, "no page errors after unlocking again: %s" % errors)
        ctx.close()

        # ---- Clock out from the phone (script version 10) ----
        ctx, page, errors = new_page(browser, html, CLOCK)
        enter(page, PIN)
        expect(page.locator("#mainView")).to_be_visible()
        expect(page.locator("#outBtn")).to_be_visible()
        check(page.locator("#outForm").is_hidden(), "the time form waits for the button")
        shot(page, "15-clock-out-button")
        page.click("#outBtn")
        expect(page.locator("#outForm")).to_be_visible()
        check(page.input_value("#outTime") == "13:00", "Left at starts at now (13:00): " + page.input_value("#outTime"))
        check("Worked 3:12 since 09:48" in page.inner_text("#outSum"), "worked preview: " + page.inner_text("#outSum"))
        shot(page, "16-clock-out-form")
        no_hscroll(page, "clock out form")
        page.fill("#outTime", "09:30")
        check("after you clocked in (09:48)" in page.inner_text("#outSum"), "a time before the clock-in is flagged")
        page.click("#outGo")
        expect(page.locator("#outMsg")).to_contain_text("after you clocked in")
        check(page.evaluate("window.__calls.filter(function (c) { return c.fn === 'phoneClockOut'; }).length") == 0,
              "nothing is sent for a time before the clock-in")
        page.fill("#outTime", "12:30")
        check("Worked 2:42" in page.inner_text("#outSum"), "preview follows the time: " + page.inner_text("#outSum"))
        page.click("#outGo")
        expect(page.locator("#outMsg")).to_contain_text("Clocked out from your phone at 12:30")
        call = page.evaluate("window.__calls.filter(function (c) { return c.fn === 'phoneClockOut'; })[0]")
        check(call["args"][0] == PIN and call["args"][1]["at"] == "2026-11-11T06:30:00.000Z" and call["args"][1]["id"].startswith("po-"),
              "phoneClockOut got the 12:30 instant and a request id: %s" % call["args"])
        check("Out at" in page.text_content("#score") and "12:30" in page.text_content("#score"), "band shows Out at 12:30")
        check(page.locator("#outBtn").is_hidden() and page.locator("#outForm").is_hidden(), "button and form go once out")
        expect(page.locator("#outUndo")).to_be_visible()
        shot(page, "17-clocked-out")
        page.click("#outUndo")
        expect(page.locator("#outMsg")).to_contain_text("Clock-out undone")
        check(page.locator("#outBtn").is_visible() and "Out at" not in page.text_content("#score"), "Undo opens the day again")
        shot(page, "18-undone")
        check(not errors, "clock out: no page errors: %s" % errors)
        ctx.close()

        ctx, page, errors = new_page(browser, html, dict(CLOCK, clockOutEnabled=False))
        enter(page, PIN)
        expect(page.locator("#mainView")).to_be_visible()
        check(page.locator("#clockBox").is_hidden(), "switched off on the PC: no Clock out button")
        ctx.close()

        # ---- Offline ----
        ctx, page, errors = new_page(browser, html, FULL)
        page.evaluate("window.__answers.fail = true")
        enter(page, PIN)
        expect(page.locator("#pinMsg")).to_contain_text("Could not reach your Sheet")
        shot(page, "14-offline")
        ctx.close()

        browser.close()

    print()
    print("%d failed" % len(failures) if failures else "All phone page checks passed.")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
