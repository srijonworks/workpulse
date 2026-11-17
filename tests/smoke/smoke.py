"""WorkPulse smoke test: core flows of the v2 screens (Today, Tasks, History, Settings).

Runs real Playwright (Python, headless Chromium) against a running app. It does not
touch the repo or the user's browser profile: every check starts in a fresh, empty
browser context (so the app starts on its sample data). Screenshots are only written
when --shots DIR is given.

From the repo root (starts and stops the dev server for you; port 3000 must be free):

    npm run test:smoke

Or against a server that is already running:

    python tests/smoke/smoke.py --url http://localhost:3000

Options:  --only NAME[,NAME]   run only these checks      --list   list checks
          --shots DIR          save a screenshot on failure and after theme switches
          --headed             show the browser

The Gemini routes and the Google Sheet are always stubbed: `AiGuard` and `SheetGuard` fail a run when a request
reaches the real AI server, or when anything touches a script.google.com host. Checks that need a Sheet use
`ScriptStub` (ping, setPin, pushState, pullInbox, ackInbox, setEmail, sendTestEmail).

Exit code: 0 when every check passes (or fails only as an expected failure), 1 otherwise.
Expected failures are listed in EXPECTED_FAIL with the reason. When one starts passing it
is reported as XPASS: delete it from EXPECTED_FAIL so a regression is caught.
"""
import argparse
import datetime
import io
import json
import os
import re
import sys

from playwright.sync_api import sync_playwright, expect

try:  # Windows consoles default to cp1252 and choke on the app's symbols
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
except Exception:
    pass

# ---------------------------------------------------------------------------
# Selector map. When a label changes in the app, change it here, in one place.
# Names are accessible names (role + name) unless the key says otherwise.
# ---------------------------------------------------------------------------
SEL = {
    # top band
    "main_nav": "Main",                                   # <nav aria-label="Main">: header tabs (first), phone bottom nav (last)
    "tabs": {"today": "Today", "tasks": "Tasks", "history": "History", "settings": "Settings"},
    "search": "Search",                                   # header IconButton (Ctrl+K)
    "clock_band": "Workday clock",                        # region
    "clock_in": "Clock in",
    "clock_out": "Clock out",
    "resume_day": "Resume",
    "clock_in_dialog": "Clock in",                        # dialog name
    "came_in_at": re.compile(r"^I came in (yesterday )?at"),
    "plan_day_dialog": "Plan your day",                   # dialog after a date's first clock-in
    "plan_skip": "Skip",
    "plan_start": "Start the day",                        # footer button of Plan your day
    "plan_new_tasks": "Add today's tasks",                # textarea (aria-haspopup, not a combobox), one task per line
    "menu_move_today": "Move to today",                   # row menu
    # Today
    "task_quick_add": "Add a task for today",             # combobox; Enter = planned
    "log_quick_add": "What did you just finish?",         # combobox; Enter = log
    "log_details": "Details",                             # opens LogFormDialog
    "todays_log": re.compile(r"^Today's log"),            # region
    "todays_tasks": re.compile(r"^Today's tasks"),        # region
    "suggestions": re.compile(r"^Suggested from your activity"),  # region (the compact panel)
    "standup": "Standup",                                 # Today's log action row
    "end_day": "End my day",                              # Today's log action row, and the dialog name
    # task rows: primary button + the row menu "Actions for <title>"
    "start": "Start", "pause": "Pause", "resume": "Resume", "log_it": "Log it",
    "menu_done": "Done", "menu_block": "Block", "menu_planned": "Back to planned", "menu_delete": "Delete",
    "block_reason": "What is it waiting on?",
    "block_confirm": "Block",
    # log rows: menu "Actions for log: <first 46 chars>…"
    "menu_edit": "Edit",
    # LogFormDialog
    "log_form_new": "New log", "log_form_edit": "Edit log",   # dialog names
    "log_form_text": "What did you do?",
    "log_form_add": "Add log", "log_form_save": "Save changes",
    # History
    "week_group": re.compile(r"^Logged time per day"),
    "logs_region": re.compile(r"^Logs"),
    "export": "Export all logs",
    "export_items": ("Download CSV", "Copy as Markdown", "Print"),
    # Settings
    "theme_group": "Theme",
    "theme_tiles": {"chase": "The Chase", "timecard": "Time Card", "console": "Graphite Console"},
    "workday_hours": "Hours in your workday",
    "settings_save": "Save All Settings",
    "settings_nav": "Settings sections",
    "phone_section": "#settings-phone",                   # CSS: Settings > Phone & evening email
    "set_pin": "Set PIN", "change_pin": "Change PIN", "reset_access": "Reset phone access",
    "pin_new": "New PIN", "pin_again": "New PIN again", "phone_link": "Phone link",
    "email_on": "Send me an evening email", "email_save": "Save email settings", "email_test": "Send a test email",
    # dialogs
    "palette_trigger_key": "Control+k",
    "palette_input": "[role=dialog] input[role=combobox]",  # CSS (the quick inputs are comboboxes too)
    "end_day_steps": "Steps",                             # nav inside End my day
    "activity_dialog": "Suggest logs from my activity",
    "eod_add": re.compile(r"^Add \d+ logs?$"),            # End my day step 2 confirm
}

# check name -> reason it is expected to fail
EXPECTED_FAIL = {}

THEMES = ["chase", "timecard", "console"]
SCREENS = ["today", "tasks", "history", "settings"]
SEED_SETTINGS = {
    "googleScriptUrl": "", "geminiApiKey": "", "defaultTone": "casual", "clockInMessageEnabled": False,
    "autoDayEnabled": False,  # the start-of-day popup and automatic clock-out are switched on only in their own checks
}
IGNORED_CONSOLE = (
    re.compile(r"favicon", re.I),
    # no Gemini key in the test environment: /api/gemini/generate answers 400 and the app
    # falls back to its offline template, which is the behaviour under test
    re.compile(r"Failed to load resource: the server responded with a status of 400"),
)

CHECKS = []


def check(name):
    def deco(fn):
        CHECKS.append((name, fn))
        return fn
    return deco


# ---------------------------------------------------------------------------
# Plumbing
# ---------------------------------------------------------------------------
AI_PATH = re.compile(r"/api/(gemini/generate|synthesize-eod)(\?|$)")


def _canned_eod(route):
    """One synthesized log per project of the tasks sent, in the shape /api/synthesize-eod answers."""
    body = json.loads(route.request.post_data or "{}")
    groups = {}
    for t in body.get("tasks") or []:
        groups.setdefault(t.get("projectId") or "none", []).append(t)
    names = {pr.get("id"): pr.get("name") for pr in body.get("projects") or []}
    logs = [{
        "id": f"{pid}_completed", "splitId": f"{pid}_completed", "projectId": pid,
        "projectName": names.get(pid) or "General", "status": "completed",
        "durationMinutes": sum((t.get("elapsedSeconds") or 0) for t in ts) // 60,
        "summaryBullets": "Stub timesheet: " + "; ".join(t.get("title", "") for t in ts),
        "tags": ["#deep-work"], "taskIds": [t["id"] for t in ts],
        "underlyingTasks": [{"id": t["id"], "title": t.get("title", ""), "stage": "done",
                             "elapsedSeconds": t.get("elapsedSeconds") or 0} for t in ts],
    } for pid, ts in groups.items()]
    route.fulfill(json={"synthesizedLogs": logs, "isAIGenerated": True, "modelUsed": "stub"})


class AiGuard:
    """The AI routes never reach the real server (a Gemini key in .env.local would cost money and
    make runs vary): the context answers them with canned responses, and every request to them
    must be answered by a stub. `check()` fails the run otherwise."""

    def __init__(self, ctx):
        self.seen, self.stubbed = 0, 0
        ctx.on("request", self._on_request)
        ctx.route("**/api/gemini/generate", self.stub(
            lambda r: r.fulfill(json={"text": "Stub standup text.", "modelUsed": "stub"})))
        ctx.route("**/api/synthesize-eod", self.stub(_canned_eod))

    def _on_request(self, req):
        if AI_PATH.search(req.url):
            self.seen += 1

    def stub(self, handler):
        """Wrap a route handler so its requests count as stubbed. Tests use it for their own AI routes."""
        def run(route):
            self.stubbed += 1
            handler(route)
        return run

    def check(self):
        assert self.seen == self.stubbed,             f"{self.seen - self.stubbed} AI request(s) reached the real server (seen {self.seen}, stubbed {self.stubbed})"


REAL_SCRIPT_HOST = re.compile(r"^https?://([^/]*\.)?(script\.google\.com|script\.googleusercontent\.com)(/|$)", re.I)
SHEETS_PATH = re.compile(r"/api/sheets/proxy(\?|$)")
SCRIPT_URL = "https://script.google.com/macros/s/AKfycbSMOKE/exec"   # a made-up deployment; nothing ever answers it
PHONE_TOKEN = "a" * 64


class SheetGuard:
    """The Google Sheet never gets a real request. The page only reaches the Sheet through the local
    /api/sheets/proxy route, so that route is stubbed (a check installs its own `ScriptStub`), and any request
    straight to a script.google.com host is aborted and fails the run. A proxy request nobody stubbed gets a harmless
    failure from the default handler, which counts it in `defaulted` (never in `stubbed`).
    `check()` fails the run when a real host was asked, a proxy request fell through to the default handler, or a
    stub recorded a request it did not expect (`mismatches`). `checks` counts how often it ran."""

    def __init__(self, ctx):
        self.seen, self.stubbed, self.defaulted, self.checks = 0, 0, 0, 0
        self.real, self.mismatches = [], []
        ctx.on("request", self._on_request)
        ctx.route(REAL_SCRIPT_HOST, lambda route: route.abort())
        ctx.route("**/api/sheets/proxy", self._default)

    def _default(self, route):
        self.defaulted += 1
        route.fulfill(json={"status": "error", "message": "No Sheet in the smoke test"})

    def _on_request(self, req):
        if REAL_SCRIPT_HOST.search(req.url):
            self.real.append(req.url)
        elif SHEETS_PATH.search(req.url):
            self.seen += 1

    def stub(self, handler):
        """Wrap a route handler so its requests count as stubbed. Checks use it for their own proxy routes."""
        def run(route):
            self.stubbed += 1
            handler(route)
        return run

    def check(self):
        self.checks += 1
        assert not self.real, f"a request reached a real Google script host: {self.real[:2]}"
        assert self.defaulted == 0, (
            f"{self.defaulted} Sheet proxy request(s) were not answered by a stub (seen {self.seen}, stubbed {self.stubbed})")
        assert not self.mismatches, f"the Sheet stub saw an unexpected request: {self.mismatches[:2]}"
        assert self.seen == self.stubbed, f"Sheet proxy requests and stubbed answers differ (seen {self.seen}, stubbed {self.stubbed})"


class ScriptStub:
    """A fake Google script behind /api/sheets/proxy: ping, setPin, pushState, pullInbox, ackInbox, setEmail and
    sendTestEmail. `inbox` items are served until acked, unless `serve_again` (an ack that was lost: the same items
    come back on the next pull). `calls` holds (action, payload) in order."""

    def __init__(self, s, version=3, inbox=None, serve_again=False, versions=None, backup_text=""):
        self.version, self.serve_again = version, serve_again
        self.versions, self.backup_text = list(versions or []), backup_text
        self.guard = s.sheets
        self.inbox = list(inbox or [])
        self.calls, self.taken = [], set()
        s.page.route("**/api/sheets/proxy", s.sheets.stub(self.handle))

    def actions(self):
        return [a for a, _ in self.calls]

    def payloads(self, action):
        return [p for a, p in self.calls if a == action]

    def handle(self, route):
        body = json.loads(route.request.post_data or "{}")
        if body.get("scriptUrl") != SCRIPT_URL:
            # An assert here would only break the route handler; record it so the run fails instead.
            self.guard.mismatches.append(f"unexpected script URL {body.get('scriptUrl')}")
            route.fulfill(json={"status": "error", "message": "Unexpected script URL in the smoke stub"})
            return
        action, p = body.get("action"), body.get("payload") or {}
        self.calls.append((action, p))
        if action == "ping":
            res = {"status": "ok", "version": self.version}
        elif action == "setPin":
            res = {"status": "ok", "token": PHONE_TOKEN}
        elif action == "pullInbox":
            res = {"status": "ok", "items": [i for i in self.inbox if self.serve_again or i["id"] not in self.taken]}
        elif action == "ackInbox":
            self.taken.update(p.get("ids", []))
            res = {"status": "ok", "taken": len(p.get("ids", []))}
        elif action == "pushState":
            res = {"status": "ok", "pushedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                   "deviceChanged": False}
        elif action == "saveBackup":
            res = {"status": "ok", "version": 99, "savedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")}
        elif action == "backupInfo":
            res = {"status": "ok", "versions": self.versions}
        elif action == "loadBackup":
            res = {"status": "ok", "backup": self.backup_text, "savedAt": "2026-11-10T09:00:00.000Z"}
        elif action == "setEmail":
            res = {"status": "ok", "enabled": p.get("enabled"), "hour": p.get("hour"), "minute": p.get("minute"), "tz": p.get("tz")}
        elif action == "sendTestEmail":
            res = {"status": "ok", "sent": True, "to": "owner@gmail.com"}
        else:
            res = {"status": "error", "message": "Unknown action in the smoke stub"}
        route.fulfill(json=res)


class Session:
    """A fresh browser context with console-error capture, stubbed AI routes and a stubbed Sheet."""

    def __init__(self, pw, url, theme="chase", width=1440, height=900, headed=False, touch=False, settings=None):
        self.url = url
        self.browser = pw.chromium.launch(headless=not headed)
        self.ctx = self.browser.new_context(viewport={"width": width, "height": height}, color_scheme="light",
                                            has_touch=touch, is_mobile=touch, accept_downloads=True)
        seeded = dict(SEED_SETTINGS, theme=theme, **(settings or {}))
        self.ctx.add_init_script(
            "try{ if(!localStorage.getItem('workpulse_settings')) "
            "localStorage.setItem('workpulse_settings', %s) }catch(e){}" % json.dumps(json.dumps(seeded))
        )
        self.ai = AiGuard(self.ctx)
        self.sheets = SheetGuard(self.ctx)
        self.errors = []
        self.page = self.ctx.new_page()
        self.page.on("console", self._on_console)
        self.page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        self.page.goto(url)
        self.page.wait_for_load_state("networkidle")
        self.page.wait_for_timeout(300)

    def _on_console(self, msg):
        if msg.type == "error" and not any(p.search(msg.text) for p in IGNORED_CONSOLE):
            self.errors.append(f"console.error: {msg.text}")

    def close(self):
        self.browser.close()

    # -- helpers ----------------------------------------------------------
    def ls(self, key):
        raw = self.page.evaluate("k => localStorage.getItem(k)", key)
        return json.loads(raw) if raw else None

    def set_ls(self, key, value):
        self.page.evaluate("([k, v]) => localStorage.setItem(k, v)", [key, json.dumps(value)])

    def reload(self):
        self.page.reload()
        self.page.wait_for_load_state("networkidle")
        self.page.wait_for_timeout(300)

    def today(self):
        return self.page.evaluate(
            "() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')"
            " + '-' + String(d.getDate()).padStart(2, '0'); }")

    def day(self, offset=0):
        """The local date `offset` days from today, as YYYY-MM-DD."""
        return self.page.evaluate(
            "n => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' +"
            " String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }", offset)

    def tab(self, name):
        """Header tabs on a wide screen, the bottom nav on a phone (both are nav "Main")."""
        navs = self.page.get_by_role("navigation", name=SEL["main_nav"])
        # the tab names carry counts ("Today , 3:15 logged", "Tasks , 5 open")
        pattern = re.compile(rf"^{re.escape(SEL['tabs'][name])}\b")
        for i in range(navs.count()):
            nav = navs.nth(i)
            if nav.is_visible():
                nav.get_by_role("button", name=pattern).first.click()
                self.page.wait_for_timeout(250)
                return
        raise AssertionError(f"no visible navigation for '{name}'")

    def settings_section(self, label):
        """Settings shows one section at a time: open Settings, then pick the section in its list (a row of links on a phone)."""
        self.tab("settings")
        nav = self.page.get_by_role("navigation", name=SEL["settings_nav"])
        nav.get_by_role("link", name=label, exact=True).click()
        self.page.wait_for_timeout(150)

    def set_theme(self, theme):
        self.tab("settings")
        group = self.page.get_by_role("radiogroup", name=SEL["theme_group"])
        name = SEL["theme_tiles"][theme]
        # the radio itself is visually hidden inside its tile (a <label>): click the tile
        group.locator("label").filter(has=self.page.get_by_role("radio", name=name, exact=True)).click()
        self.page.wait_for_timeout(250)

    def html_attrs(self):
        return self.page.evaluate(
            "()=>[document.documentElement.getAttribute('data-theme'),document.documentElement.getAttribute('data-mode')]"
        )

    def clock_in_now(self):
        band = self.page.get_by_role("region", name=SEL["clock_band"])
        band.get_by_role("button", name=SEL["clock_in"], exact=True).click()
        dlg = self.page.get_by_role("dialog", name=SEL["clock_in_dialog"])
        dlg.get_by_role("button", name=SEL["clock_in"], exact=True).click()
        expect(dlg).to_have_count(0)
        self.skip_plan()

    def skip_plan(self):
        """A date's first clock-in opens Plan your day; Skip closes it without changes."""
        plan = self.page.get_by_role("dialog", name=SEL["plan_day_dialog"])
        expect(plan).to_be_visible(timeout=5000)
        plan.get_by_role("button", name=SEL["plan_skip"], exact=True).click()
        expect(plan).to_have_count(0)

    def no_overflow(self, label):
        over = self.page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
        assert over <= 1, f"{label}: page scrolls sideways by {over}px"

    def no_errors(self):
        assert not self.errors, "browser errors:\n  " + "\n  ".join(self.errors[:5])


def btn(scope, name, exact=None):
    """A button by accessible name (substring, case-insensitive; exact=True for a whole-name match) or regex."""
    return scope.get_by_role("button", name=name, exact=exact)


def task_row(page, title):
    """The <li> of a task row on the current screen."""
    return page.locator("main li").filter(has=page.get_by_text(title, exact=True)).first


def log_row(page, text):
    return page.locator("main li").filter(has=page.get_by_text(text, exact=True)).first


def row_menu(page, row, item):
    """Open the row's ⋯ menu and pick an item. Done is a visible button on the row, not a menu item."""
    if item == SEL["menu_done"]:
        row.get_by_role("button", name=re.compile(r"^Mark done: ")).click()
        page.wait_for_timeout(300)
        return
    row.get_by_role("button", name=re.compile(r"^Actions for ")).click()
    page.get_by_role("menu").get_by_role("menuitem", name=item, exact=True).click()
    page.wait_for_timeout(300)


def stage_of(s, title):
    tasks = s.ls("workpulse_backlog") or []
    t = next((t for t in tasks if t.get("title") == title), None)
    assert t is not None, f"task '{title}' not found in workpulse_backlog"
    return t.get("stage") or ("done" if t.get("completed") else "planned")


def quick_log(s, text):
    box = s.page.get_by_role("combobox", name=SEL["log_quick_add"])
    box.fill(text)
    box.press("Enter")
    s.page.wait_for_timeout(400)


def hm(minutes):
    return f"{minutes // 60}:{minutes % 60:02d}"


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
@check("app_loads")
def app_loads(s):
    assert s.html_attrs() == ["chase", "light"], f"unexpected html attrs {s.html_attrs()}"
    expect(s.page.get_by_role("region", name=SEL["todays_tasks"])).to_be_visible()
    expect(s.page.get_by_role("region", name=SEL["todays_log"])).to_be_visible()
    expect(s.page.get_by_role("region", name=SEL["clock_band"])).to_be_visible()
    s.no_errors()


@check("themes_all_screens")
def themes_all_screens(s, shots=None):
    """Settings → Appearance: each tile applies at once; every screen renders without errors or sideways scroll."""
    for theme in THEMES:
        s.set_theme(theme)
        got = s.html_attrs()
        assert got[0] == theme, f"choosing {theme} left data-theme={got[0]}"
        assert got[1] == ("dark" if theme == "console" else "light"), f"{theme}: data-mode={got[1]}"
        assert s.ls("workpulse_settings")["theme"] == theme, f"{theme} not saved at once"
        for screen in SCREENS:
            s.tab(screen)
            assert s.page.locator("main").inner_text().strip(), f"{theme}/{screen}: blank"
            s.no_overflow(f"{theme}/{screen}")
        if shots:
            s.tab("today")
            s.page.screenshot(path=os.path.join(shots, f"smoke_{theme}.png"))
    s.reload()
    assert s.html_attrs() == ["console", "dark"], f"theme not restored after reload: {s.html_attrs()}"
    s.no_errors()


@check("theme_radios_keyboard")
def theme_radios_keyboard(s):
    """The theme tiles are a radio group: an arrow key picks the next theme and it applies at once."""
    s.tab("settings")
    group = s.page.get_by_role("radiogroup", name=SEL["theme_group"])
    radios = group.get_by_role("radio")
    assert radios.count() == 3, f"expected three theme tiles, got {radios.count()}"
    group.get_by_role("radio", name=SEL["theme_tiles"]["chase"], exact=True).focus()
    s.page.keyboard.press("ArrowRight")
    s.page.wait_for_timeout(250)
    assert s.html_attrs()[0] == "timecard", f"ArrowRight did not switch to Time Card: {s.html_attrs()}"
    s.no_errors()


@check("legacy_theme_migrates")
def legacy_theme_migrates(s):
    """A stored theme from before v2 ("matrix", light mode, scanlines on) loads as Graphite Console."""
    s.set_ls("workpulse_settings", dict(SEED_SETTINGS, theme="matrix", colorMode="light", crtEffect=True))
    s.reload()
    assert s.html_attrs() == ["console", "dark"], f"legacy matrix loaded as {s.html_attrs()}"
    assert s.page.evaluate("document.documentElement.getAttribute('data-crt')") is None, "scanlines are gone in v2"
    s.tab("settings")
    expect(s.page.get_by_role("radio", name=SEL["theme_tiles"]["console"], exact=True)).to_be_checked()
    s.no_errors()


@check("office_day_hours")
def office_day_hours(s):
    s.settings_section("Office day")
    field = s.page.get_by_role("spinbutton", name=SEL["workday_hours"])
    field.fill("7.5")
    btn(s.page, SEL["settings_save"]).first.click()
    s.page.wait_for_timeout(300)
    assert s.ls("workpulse_settings").get("workdayHours") == 7.5, "office-day hours not saved"
    s.reload()
    s.settings_section("Office day")
    expect(s.page.get_by_role("spinbutton", name=SEL["workday_hours"])).to_have_value("7.5")
    s.no_errors()


@check("log_add_edit_delete")
def log_add_edit_delete(s):
    p = s.page
    text = "Smoke: wrote a log entry"
    quick_log(s, text)
    logs = s.ls("workpulse_logs")
    count = len(logs)
    assert any(l["description"] == text and l["date"] == s.today() for l in logs), "quick log not saved for today"
    expect(p.get_by_role("combobox", name=SEL["log_quick_add"])).to_have_value("")
    row = log_row(p, text)
    expect(row).to_be_visible()

    # edit in the log form
    row_menu(p, row, SEL["menu_edit"])
    dlg = p.get_by_role("dialog", name=SEL["log_form_edit"])
    expect(dlg).to_be_visible()
    ta = dlg.get_by_role("textbox", name=SEL["log_form_text"])
    expect(ta).to_have_value(text)
    edited = text + " (edited)"
    ta.fill(edited)
    btn(dlg, SEL["log_form_save"], exact=True).click()
    expect(dlg).to_have_count(0)
    logs = s.ls("workpulse_logs")
    assert len(logs) == count, "editing changed the number of logs"
    assert any(l["description"] == edited and l.get("editedAt") for l in logs), "edit not saved, or editedAt not set"

    # delete, then Undo
    row_menu(p, log_row(p, edited), SEL["menu_delete"])
    assert not any(l["description"] == edited for l in s.ls("workpulse_logs")), "delete did not remove the log"
    expect(p.get_by_text(edited, exact=True)).to_have_count(0)
    btn(p.get_by_role("region", name="Notifications"), "Undo", exact=True).click()
    p.wait_for_timeout(300)
    assert any(l["description"] == edited for l in s.ls("workpulse_logs")), "Undo did not bring the log back"
    expect(log_row(p, edited)).to_be_visible()
    s.no_errors()


@check("log_form_details")
def log_form_details(s):
    """"Details" opens the full form with what was typed in the quick log."""
    p = s.page
    text = "Smoke detailed entry"
    quick = p.get_by_role("combobox", name=SEL["log_quick_add"])
    quick.fill(text)
    dlg = p.get_by_role("dialog", name=SEL["log_form_new"])
    # Cancel (Escape) keeps the quick-log text.
    btn(p, SEL["log_details"], exact=True).click()
    expect(dlg).to_be_visible()
    p.keyboard.press("Escape")
    expect(dlg).to_have_count(0)
    expect(quick).to_have_value(text)
    btn(p, SEL["log_details"], exact=True).click()
    expect(dlg).to_be_visible()
    expect(dlg.get_by_role("textbox", name=SEL["log_form_text"])).to_have_value(text)
    btn(dlg, SEL["log_form_add"], exact=True).click()
    expect(dlg).to_have_count(0)
    assert any(l["description"] == text for l in s.ls("workpulse_logs")), "log from the form not saved"
    expect(quick).to_have_value("")
    s.no_errors()


@check("timer_ticks")
def timer_ticks(s):
    """The sample's running task ticks on Today and on Tasks, and stops when paused."""
    p = s.page
    clock = re.compile(r"\b\d{2}:\d{2}:\d{2}\b")
    running = p.locator("li.v2-running").first
    expect(running).to_be_visible()
    first = clock.findall(running.inner_text())
    assert first, "no clock on the running task"
    p.wait_for_timeout(2300)
    assert clock.findall(running.inner_text()) != first, "the Today clock did not tick"
    s.tab("tasks")
    running = p.locator("li.v2-running").first
    first = clock.findall(running.inner_text())
    p.wait_for_timeout(2300)
    assert clock.findall(running.inner_text()) != first, "the Tasks clock did not tick"
    btn(running, SEL["pause"], exact=True).click()
    p.wait_for_timeout(300)
    assert p.locator("li.v2-running").count() == 0, "a row still looks running after pause"
    paused = [t for t in s.ls("workpulse_backlog") if t.get("stage") == "paused"]
    assert paused and all((t.get("elapsedSeconds") or 0) > 0 for t in paused), "paused task lost its time"
    s.no_errors()


@check("project_completion")
def project_completion(s):
    """Typing #fr in Today's task box lists the project, Enter picks it and the task lands there; a numeric
    #212 opens nothing and the text stays whole."""
    p = s.page
    box = p.get_by_role("combobox", name=SEL["task_quick_add"])
    expect(box).to_be_visible()
    box.fill("Smoke project pick #fr")
    listbox = p.get_by_role("listbox", name="Projects")
    expect(listbox).to_be_visible()
    expect(listbox.get_by_role("option")).to_have_count(1)
    box.press("Enter")
    expect(listbox).to_have_count(0)
    expect(box).to_have_value("Smoke project pick")
    box.press("Enter")
    p.wait_for_timeout(300)
    frontend = {"id": "proj-2"}  # "Frontend & Design System" in the sample data
    task = next(t for t in s.ls("workpulse_backlog") if t["title"] == "Smoke project pick")
    assert task["projectId"] == frontend["id"], f"the task went to {task['projectId']}, not the picked project"
    assert s.ls("workpulse_settings").get("lastProjectId") == frontend["id"], "the submitted project was not remembered"
    box.fill("Review PR #212")
    expect(p.get_by_role("listbox", name="Projects")).to_have_count(0)
    box.press("Enter")
    p.wait_for_timeout(300)
    assert any(t["title"] == "Review PR #212" for t in s.ls("workpulse_backlog")), "a numeric #word must stay in the text"
    # An unmatched #word: the list offers "Create it", but Enter just adds the text as typed to the selected project.
    box.fill("Deploy #zzzz")
    expect(p.get_by_role("listbox", name="Projects").get_by_role("option")).to_have_count(1)
    box.press("Enter")
    p.wait_for_timeout(300)
    deploy = next((t for t in s.ls("workpulse_backlog") if t["title"] == "Deploy #zzzz"), None)
    assert deploy, "Enter on an unmatched #word did not add the task as typed"
    assert deploy["projectId"] == frontend["id"], "the task did not go to the selected project"
    assert not any("zzzz" in (pr.get("name") or "").lower() for pr in (s.ls("workpulse_projects") or [])), \
        "Enter on an unmatched #word created a project"
    s.no_errors()


@check("task_every_stage")
def task_every_stage(s):
    p = s.page
    title = "Smoke stage task"
    box = p.get_by_role("combobox", name=SEL["task_quick_add"])
    box.fill(title)
    box.press("Enter")
    p.wait_for_timeout(300)
    assert stage_of(s, title) == "planned", "a new task should start as planned"
    row = lambda: task_row(p, title)

    def press(label, expected):
        btn(row(), label, exact=True).click()
        p.wait_for_timeout(350)
        got = stage_of(s, title)
        assert got == expected, f"after '{label}': expected {expected}, got {got}"

    def menu(item, expected):
        row_menu(p, row(), item)
        got = stage_of(s, title)
        assert got == expected, f"after menu '{item}': expected {expected}, got {got}"

    press(SEL["start"], "in_progress")
    p.wait_for_timeout(1300)
    press(SEL["pause"], "paused")
    press(SEL["resume"], "in_progress")
    # block asks for a reason inline
    row_menu(p, row(), SEL["menu_block"])
    row().get_by_role("textbox", name=SEL["block_reason"]).fill("waiting on smoke reviewer")
    btn(row(), SEL["block_confirm"], exact=True).click()
    p.wait_for_timeout(350)
    assert stage_of(s, title) == "blocked", f"expected blocked, got {stage_of(s, title)}"
    task = next(t for t in s.ls("workpulse_backlog") if t["title"] == title)
    assert "smoke reviewer" in (task.get("blockReason") or ""), "block reason not saved"
    press(SEL["resume"], "in_progress")          # unblock
    menu(SEL["menu_planned"], "planned")
    press(SEL["start"], "in_progress")
    p.wait_for_timeout(1300)
    # (storage holds no logs until the first change, so count the task's own logs, not all logs)
    from_task = lambda: [l for l in (s.ls("workpulse_logs") or []) if l["description"] == title]
    menu(SEL["menu_done"], "done")
    assert from_task() == [], "marking a task done must not create a log"
    # "Log it" writes the log straight from the task
    btn(row(), SEL["log_it"], exact=True).click()
    p.wait_for_timeout(400)
    assert len(from_task()) == 1, "Log it did not create exactly one log"
    done = next(t for t in s.ls("workpulse_backlog") if t["title"] == title)
    assert (done.get("loggedSeconds") or 0) > 0 or done.get("isSynthesized"), "task not marked as logged"
    expect(btn(row(), "Logged")).to_be_disabled()
    s.no_errors()


@check("tasks_screen_add")
def tasks_screen_add(s):
    """The Tasks screen adds a task with a project and a due date; it lands under Upcoming."""
    p = s.page
    s.tab("tasks")
    form = p.get_by_role("form", name="Add a task")
    form.get_by_role("textbox", name="Task").fill("Smoke future task")
    due = p.evaluate("() => { const d = new Date(); d.setDate(d.getDate() + 2); return d.getFullYear() + '-' +"
                     " String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }")
    form.get_by_label("Due").fill(due)
    btn(form, "Add", exact=True).click()
    p.wait_for_timeout(300)
    task = next((t for t in s.ls("workpulse_backlog") if t["title"] == "Smoke future task"), None)
    assert task and task.get("dueDate") == due, f"task not saved with its due date: {task}"
    # A not-started task lives in the Plans column, under its own day; the started-work column never lists it.
    plans = p.get_by_role("region", name=re.compile(r"^Plans"))
    expect(plans.get_by_text("Smoke future task", exact=True)).to_be_visible()
    for left in ("Today", "Upcoming", "Done recently"):
        expect(p.get_by_role("region", name=re.compile(rf"^{left}")).get_by_text("Smoke future task", exact=True)).to_have_count(0)
    s.no_errors()


@check("office_clock")
def office_clock(s):
    p = s.page
    band = p.get_by_role("region", name=SEL["clock_band"])
    expect(band).to_contain_text("Not clocked in")
    s.clock_in_now()
    rec = (s.ls("workpulse_workdays") or {}).get(s.today())
    assert rec and rec.get("clockIn") and not rec.get("clockOut"), f"clock-in not saved: {rec}"
    shown = band.inner_text()  # innerText skips the phone layout hidden on a wide screen
    assert re.search(r"Now\s+\d{2}:\d{2}:\d{2}", shown, re.I) and re.search(r"To go", shown, re.I), f"band shows {shown!r}"
    # the band ticks by itself; the next action is no longer "Clock in"
    expect(p.get_by_role("banner").get_by_role("button", name=SEL["clock_in"], exact=True)).to_have_count(0)
    btn(band, SEL["clock_out"], exact=True).click()
    p.wait_for_timeout(300)
    rec = s.ls("workpulse_workdays")[s.today()]
    assert rec.get("clockOut"), "clock-out not saved"
    expect(band).to_contain_text("Out at")
    btn(band, SEL["resume_day"], exact=True).click()
    p.wait_for_timeout(300)
    rec = s.ls("workpulse_workdays")[s.today()]
    assert not rec.get("clockOut"), "Resume did not clear the clock-out"
    expect(btn(band, SEL["clock_out"], exact=True)).to_be_visible()
    p.wait_for_timeout(500)
    expect(p.get_by_role("dialog", name=SEL["plan_day_dialog"])).to_have_count(0)
    s.no_errors()


@check("clock_in_whatsapp_message")
def clock_in_whatsapp_message(s):
    """With the setting left at its default (on), the first clock-in opens WhatsApp Web (stubbed, never loaded) with the typed message."""
    p = s.page
    p.context.route("https://web.whatsapp.com/**", lambda route: route.fulfill(status=200, body="stub"))
    p.evaluate("""() => { const k = 'workpulse_settings'; const v = JSON.parse(localStorage.getItem(k) || '{}');
                          delete v.clockInMessageEnabled; /* absent = on */ localStorage.setItem(k, JSON.stringify(v)); }""")
    s.reload()
    btn(p.get_by_role("region", name=SEL["clock_band"]), SEL["clock_in"], exact=True).click()
    dlg = p.get_by_role("dialog", name=SEL["clock_in_dialog"])
    with p.context.expect_page() as popup:
        btn(dlg, SEL["clock_in"], exact=True).click()
    url = popup.value.url
    assert url.startswith("https://web.whatsapp.com/send?text="), url
    assert re.search(r"arrived%20at%20office%20at%20\d{2}%3A\d{2}", url), url
    popup.value.close()
    s.skip_plan()
    s.no_errors()


@check("office_clock_came_in_at")
def office_clock_came_in_at(s):
    """Forgot to clock in: "I came in at" takes an earlier time; a time later than now means yesterday."""
    p = s.page
    btn(p.get_by_role("region", name=SEL["clock_band"]), SEL["clock_in"], exact=True).click()
    dlg = p.get_by_role("dialog", name=SEL["clock_in_dialog"])
    field = dlg.locator("input[type=time]")
    now_min = p.evaluate("() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }")
    if now_min < 23 * 60 + 58:  # a time later than now is read as yesterday, and the button says so
        field.fill(hm(now_min + 2).zfill(5))
        expect(btn(dlg, SEL["came_in_at"])).to_contain_text("yesterday")
    earlier = max(0, now_min - 30)
    stamp = hm(earlier).zfill(5)
    field.fill(stamp)
    btn(dlg, SEL["came_in_at"]).click()
    expect(dlg).to_have_count(0)
    s.skip_plan()
    rec = s.ls("workpulse_workdays")[s.today()]
    local = p.evaluate("iso => { const d = new Date(iso); return String(d.getHours()).padStart(2,'0') + ':' +"
                       " String(d.getMinutes()).padStart(2,'0'); }", rec["clockIn"])
    assert local == stamp, f"clocked in at {local}, expected {stamp}"
    s.no_errors()


@check("history_week")
def history_week(s):
    p = s.page
    today = s.today()
    # storage holds no logs until the first change: one quick log writes the sample logs out too
    quick_log(s, "Smoke history entry")
    minutes = sum(l.get("durationMinutes") or 0 for l in s.ls("workpulse_logs") if l["date"] == today)
    assert minutes > 0, "the sample data should have time logged today"
    s.tab("history")
    week = p.get_by_role("group", name=SEL["week_group"])
    day = week.get_by_role("button", name=re.compile(r", today$"))
    expect(day).to_have_count(1)
    expect(day).to_contain_text(hm(minutes))
    todays = [l for l in s.ls("workpulse_logs") if l["date"] == today]
    day.click()
    p.wait_for_timeout(250)
    expect(day).to_have_attribute("aria-pressed", "true")
    # the picked day has its own panel: clock times, totals, and every log of that day
    panel = p.get_by_role("region", name=re.compile(r"^Today"))
    expect(panel).to_be_visible()
    assert panel.get_by_role("checkbox").count() == len(todays), "the picked day shows the wrong logs"
    expect(panel).to_contain_text("Worked")
    # the date field and Yesterday move the panel to another day
    btn(p, "Yesterday", exact=True).click()
    p.wait_for_timeout(250)
    yesterday = (datetime.date.fromisoformat(today) - datetime.timedelta(days=1)).isoformat()
    assert p.evaluate("() => document.querySelector('input[type=date]')?.value") == yesterday, "Yesterday did not move the day panel"
    btn(p, "Today", exact=True).click()
    p.wait_for_timeout(250)
    assert p.evaluate("() => document.querySelector('input[type=date]')?.value") == today, "Today did not bring the panel back"
    # Export menu
    btn(p, SEL["export"]).click()
    menu = p.get_by_role("menu")
    expect(menu).to_be_visible()
    for item in SEL["export_items"]:
        expect(menu.get_by_role("menuitem", name=item)).to_be_visible()
    p.keyboard.press("Escape")
    expect(menu).to_have_count(0)
    s.no_errors()


@check("end_my_day_steps")
def end_my_day_steps(s):
    p = s.page
    btn(p.get_by_role("region", name=SEL["todays_log"]), SEL["end_day"], exact=True).click()
    dlg = p.get_by_role("dialog", name=SEL["end_day"])
    expect(dlg).to_be_visible()
    steps = dlg.get_by_role("navigation", name=SEL["end_day_steps"]).get_by_role("button")
    assert steps.count() == 4, f"expected four steps, got {steps.count()}"
    for i in range(4):
        steps.nth(i).click()
        expect(steps.nth(i)).to_have_attribute("aria-current", "step")
        expect(dlg.locator("section:not([hidden]) h3")).to_be_visible()
    # Back and Next walk the rail
    steps.nth(0).click()
    btn(dlg, "Next", exact=True).click()
    current = [i for i in range(4) if steps.nth(i).get_attribute("aria-current") == "step"]
    assert current and current[0] > 0, "Next did not move on"
    p.keyboard.press("Escape")
    expect(dlg).to_have_count(0)
    s.no_errors()


def _escape_closes(s, open_fn, dialog_name, label):
    open_fn()
    dlg = s.page.get_by_role("dialog", name=dialog_name) if dialog_name else s.page.get_by_role("dialog")
    expect(dlg).to_be_visible(timeout=3000)
    s.page.keyboard.press("Escape")
    expect(dlg, f"{label}: Escape did not close it").to_have_count(0)


DIALOGS = {
    "log_form": (lambda s: btn(s.page, SEL["log_details"], exact=True).click(), SEL["log_form_new"]),
    "standup": (lambda s: btn(s.page.get_by_role("region", name=SEL["todays_log"]), SEL["standup"], exact=True).click(), None),
    "palette": (lambda s: s.page.keyboard.press(SEL["palette_trigger_key"]), None),
    "clock_in": (lambda s: btn(s.page.get_by_role("region", name=SEL["clock_band"]), SEL["clock_in"], exact=True).click(),
                 SEL["clock_in_dialog"]),
    "end_day": (lambda s: btn(s.page.get_by_role("region", name=SEL["todays_log"]), SEL["end_day"], exact=True).click(),
                SEL["end_day"]),
}


@check("modal_escape")
def modal_escape(s):
    """Every dialog closes with Escape, in every theme."""
    for theme in THEMES:
        s.set_theme(theme)
        s.tab("today")
        for kind, (opener, name) in DIALOGS.items():
            _escape_closes(s, lambda: opener(s), name, f"{kind} in {theme}")
    s.no_errors()


# -- accessibility of the shared dialog shell and keyboard flows ------------------------------
IN_DIALOG = "() => !!document.activeElement && !!document.activeElement.closest('[role=dialog]')"


@check("dialog_a11y")
def dialog_a11y(s):
    """Each dialog: named role=dialog, focus moves in, Tab/Shift+Tab stay inside, Escape closes
    and focus returns to the control that opened it."""
    p = s.page
    openers = (
        ("Log form", btn(p, SEL["log_details"], exact=True)),
        ("Standup", btn(p.get_by_role("region", name=SEL["todays_log"]), SEL["standup"], exact=True)),
        ("End my day", btn(p.get_by_role("region", name=SEL["todays_log"]), SEL["end_day"], exact=True)),
    )
    for label, trigger in openers:
        trigger.focus()
        trigger.click()
        dlg = p.get_by_role("dialog")
        expect(dlg).to_be_visible(timeout=3000)
        assert dlg.get_attribute("aria-modal") == "true", f"{label}: aria-modal missing"
        assert (dlg.get_attribute("aria-labelledby") or dlg.get_attribute("aria-label")), f"{label}: dialog has no name"
        p.wait_for_timeout(100)
        assert p.evaluate(IN_DIALOG), f"{label}: focus did not move into the dialog"
        for i in range(20):
            p.keyboard.press("Tab")
            assert p.evaluate(IN_DIALOG), f"{label}: Tab #{i + 1} left the dialog"
        for i in range(20):
            p.keyboard.press("Shift+Tab")
            assert p.evaluate(IN_DIALOG), f"{label}: Shift+Tab #{i + 1} left the dialog"
        p.keyboard.press("Escape")
        expect(p.get_by_role("dialog"), f"{label}: Escape did not close it").to_have_count(0)
        same = p.evaluate("(el) => document.activeElement === el", trigger.element_handle())
        assert same, f"{label}: focus did not return to the button that opened it"
    s.no_errors()


@check("palette_keyboard")
def palette_keyboard(s):
    """Ctrl+K, arrow keys move the highlighted result, Enter picks a log and opens it in History."""
    p = s.page
    p.keyboard.press(SEL["palette_trigger_key"])
    inp = p.locator(SEL["palette_input"])
    expect(inp).to_be_visible(timeout=3000)
    assert p.evaluate("() => document.activeElement && document.activeElement.getAttribute('role')") == "combobox", \
        "search input is not focused on open"
    inp.fill("e")
    options = p.get_by_role("option")
    assert options.count() >= 2, "need at least two results to test arrow keys"
    selected = lambda: p.evaluate(
        "() => [...document.querySelectorAll('[role=option]')].findIndex(o => o.getAttribute('aria-selected') === 'true')")
    assert selected() == 0, "first result should start highlighted"
    p.keyboard.press("ArrowDown")
    assert selected() == 1, "ArrowDown did not move the highlight"
    active = p.evaluate("() => document.activeElement.getAttribute('aria-activedescendant')")
    assert active and p.locator(f"[id='{active}']").get_attribute("aria-selected") == "true", \
        "aria-activedescendant does not point at the highlighted option"
    p.keyboard.press("ArrowUp")
    assert selected() == 0, "ArrowUp did not move the highlight back"
    log_id = p.locator("[role=option][aria-selected=true]").get_attribute("id").removeprefix("search-option-")
    p.keyboard.press("Enter")
    expect(p.get_by_role("dialog")).to_have_count(0)
    # History opens on that log's day, with the log's row shown and focused
    header_nav = p.get_by_role("navigation", name=SEL["main_nav"]).first
    expect(header_nav.get_by_role("button", name=re.compile(r"^History"))).to_have_attribute("aria-current", "page")
    row = p.locator(f'[data-log-id="{log_id}"]')
    expect(row).to_be_visible()
    expect(row).to_be_in_viewport()
    _wait_for(s, lambda: p.evaluate("id => !!document.activeElement?.closest(`[data-log-id='${id}']`)", log_id), tries=30)
    assert p.evaluate("id => !!document.activeElement?.closest(`[data-log-id='${id}']`)", log_id), "focus is not on the picked log"
    s.no_errors()


@check("toast_live_region")
def toast_live_region(s):
    """The notification region exists from the start, so screen readers announce what appears in it."""
    region = s.page.locator('[role=region][aria-label="Notifications"]')
    assert region.count() == 1, "no notifications region"
    assert region.get_attribute("aria-live") == "polite", "notifications region is not aria-live"
    s.no_errors()


@check("toast_pauses_on_hover")
def toast_pauses_on_hover(s):
    """A toast goes away by itself, but not while the pointer is on it."""
    p = s.page
    quick_log(s, "Toast test entry")
    toast = p.get_by_role("status").filter(has_text="Log added")
    expect(toast).to_be_visible(timeout=3000)
    toast.hover()
    p.wait_for_timeout(5000)  # longer than the 3.5 s a toast normally lasts
    expect(toast).to_be_visible()
    p.mouse.move(5, 400)
    expect(toast).to_have_count(0, timeout=6000)
    s.no_errors()


# -- first run, failures, sync -------------------------------------------------------------------
@check("sample_data_flow")
def sample_data_flow(s):
    """A new user sees labelled sample data and can clear it in one click, keeping their own work."""
    p = s.page
    banner = p.get_by_role("main").get_by_role("region", name="Sample data")
    expect(banner).to_be_visible(timeout=3000)
    quick_log(s, "My own entry")
    btn(banner, "Clear sample data").click()
    p.wait_for_timeout(400)
    expect(banner).to_have_count(0)
    mine = s.ls("workpulse_logs")
    assert [l["description"] for l in mine] == ["My own entry"], f"only the real log should remain: {mine}"
    assert s.ls("workpulse_projects"), "there must be a project left to log against"
    assert s.ls("workpulse_backlog") == [], "sample tasks should be gone"
    btn(p.get_by_role("region", name="Notifications"), "Undo", exact=True).click()
    p.wait_for_timeout(400)
    expect(banner).to_be_visible()
    assert len(s.ls("workpulse_logs")) == 7, "undo should restore the sample logs next to the real one"
    s.no_errors()


@check("backup_reminder")
def backup_reminder(s):
    """Quiet for demo data, shown for real work with an old or missing backup, cleared by a backup."""
    p = s.page
    reminder = p.get_by_role("region", name="Backup reminder")
    expect(reminder).to_have_count(0)  # a new user has nothing to lose yet
    quick_log(s, "Real work to protect")
    s.reload()
    expect(reminder).to_be_visible(timeout=3000)
    expect(reminder).to_contain_text("No backup yet")
    btn(reminder, "Later").click()
    expect(reminder).to_have_count(0)
    settings = s.ls("workpulse_settings")
    settings["lastBackupAt"] = "2000-01-01T00:00:00.000Z"
    s.set_ls("workpulse_settings", settings)
    s.reload()
    expect(reminder).to_contain_text(re.compile(r"Last backup \d+ days ago"))
    with p.expect_download() as dl:
        btn(reminder, "Back up now").click()
    name = dl.value.suggested_filename
    assert re.fullmatch(r"workpulse-backup-\d{4}-\d{2}-\d{2}\.json", name), f"unexpected file name {name}"
    expect(reminder).to_have_count(0)
    saved = s.ls("workpulse_settings")
    assert saved.get("lastBackupAt", "") > "2026", "backup date not recorded"
    backup = json.load(open(dl.value.path(), encoding="utf-8"))
    assert "lastBackupAt" not in backup["settings"] and "geminiApiKey" not in backup["settings"], "device-only values leaked"
    assert any(l["description"] == "Real work to protect" for l in backup["logs"]), "backup is missing the real log"
    assert "workdays" in backup, "backup has no workdays"
    s.tab("settings")
    expect(p.get_by_test_id("last-backup")).to_have_text("Last backup today")
    s.no_errors()


@check("offline_notice")
def offline_notice(s):
    p = s.page
    notice = p.get_by_role("status").filter(has_text="You are offline")
    expect(notice).to_have_count(0)
    s.ctx.set_offline(True)
    expect(notice).to_be_visible(timeout=3000)
    s.ctx.set_offline(False)
    expect(notice).to_have_count(0, timeout=3000)
    s.no_errors()


@check("not_saved_notice")
def not_saved_notice(s):
    """A save the browser refuses is kept, said out loud in a notice that stays (not a toast that fades), and written
    when storage works again, by itself or with Try again."""
    p = s.page
    notice = p.get_by_test_id("save-status")
    expect(notice).to_have_count(0)
    # the browser says it is full for every write of the logs
    p.evaluate("""() => {
        const real = Storage.prototype.setItem;
        window.__realSetItem = real;
        Storage.prototype.setItem = function (k, v) {
            if (window.__full && k === 'workpulse_logs') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
            return real.call(this, k, v);
        };
        window.__full = true;
    }""")
    text = "Smoke: written while the browser is full"
    quick_log(s, text)
    expect(notice).to_contain_text("Not saved yet", timeout=3000)
    expect(notice).to_contain_text("work logs")
    assert not any(l["description"] == text for l in (s.ls("workpulse_logs") or [])), "the log reached storage although it was full"
    p.wait_for_timeout(1500)
    expect(notice).to_contain_text("Not saved yet")  # it stays; it does not fade like a toast
    # storage works again: Try again writes the waiting log
    p.evaluate("() => { window.__full = false; }")
    p.get_by_role("button", name="Try again").click()
    expect(notice).to_have_count(0, timeout=3000)
    assert any(l["description"] == text for l in s.ls("workpulse_logs")), "the waiting log was not written after Try again"
    s.no_errors()


@check("unreadable_list_blocked")
def unreadable_list_blocked(s):
    """A list that cannot be read is never written over: the notice says so, a copy of the damaged value is kept, other
    lists still save, and "Start tags empty" replaces it only when the user chooses."""
    p = s.page
    p.evaluate("() => localStorage.setItem('workpulse_tags', '{bad')")
    s.reload()
    notice = p.get_by_test_id("save-status")
    expect(notice).to_contain_text("Your tags could not be read", timeout=3000)
    quick_log(s, "Smoke: another list still saves")
    assert any(l["description"] == "Smoke: another list still saves" for l in s.ls("workpulse_logs")), "other lists must still save"
    raw = p.evaluate("() => localStorage.getItem('workpulse_tags')")
    assert raw == "{bad", f"the damaged tags were written over: {raw!r}"
    copies = p.evaluate("() => Object.keys(localStorage).filter(k => k.startsWith('workpulse_tags_corrupt_'))")
    assert len(copies) == 1, f"expected one kept copy of the damaged tags, found {copies}"
    btn(notice, "Start tags empty").click()
    expect(notice).to_have_count(0, timeout=3000)
    assert s.ls("workpulse_tags") == [], "tags were not replaced after the user chose to start empty"
    s.no_errors()


@check("second_window_read_only")
def second_window_read_only(s):
    """Two windows must not write over each other: the second one is read-only until the user takes over."""
    p = s.page
    quick_log(s, "Smoke: first window write")
    assert not p.get_by_test_id("save-status").count(), "the first window must be free to write"
    second = s.ctx.new_page()
    second.goto(p.url)
    second.wait_for_load_state("networkidle")
    notice = second.get_by_test_id("save-status")
    expect(notice).to_contain_text("open in another window", timeout=4000)
    before = len(s.ls("workpulse_logs"))
    box = second.get_by_role("combobox", name=SEL["log_quick_add"])
    box.fill("Smoke: written in the read-only window")
    box.press("Enter")
    second.wait_for_timeout(400)
    assert len(s.ls("workpulse_logs")) == before, "a read-only window wrote to storage"
    # the first window still works
    quick_log(s, "Smoke: first window still writes")
    assert len(s.ls("workpulse_logs")) == before + 1
    second.close()
    s.no_errors()


def _auto_day_on(s, workdays=None):
    """Switches the automatic day on for this page, fixes the clock at Monday 2026-11-16 09:05 (Dhaka) and reloads."""
    from datetime import datetime, timezone
    s.ctx.clock.set_fixed_time(datetime(2026, 11, 16, 3, 5, tzinfo=timezone.utc))
    s.page.evaluate(
        "(wd) => { const s = JSON.parse(localStorage.getItem('workpulse_settings') || '{}'); s.autoDayEnabled = true;"
        " localStorage.setItem('workpulse_settings', JSON.stringify(s));"
        " localStorage.setItem('workpulse_workdays', JSON.stringify(wd)); }",
        workdays or {},
    )
    s.reload()


@check("auto_day_start_popup")
def auto_day_start_popup(s):
    """On a working day with no clock-in the start-of-day popup opens by itself, suggesting the time, and is not
    shown again once it is closed."""
    p = s.page
    _auto_day_on(s)
    dialog = p.get_by_role("dialog")
    expect(dialog).to_contain_text("You started working around", timeout=9000)
    expect(dialog).to_contain_text("confirms itself in 10 minutes")
    p.keyboard.press("Escape")
    expect(dialog).to_have_count(0, timeout=3000)
    p.wait_for_timeout(500)
    assert p.evaluate("() => localStorage.getItem('workpulse_autoday_dismissed')") == "2026-11-16"
    s.no_errors()


@check("auto_day_closes_forgotten_day")
def auto_day_closes_forgotten_day(s):
    """A day that was never clocked out is closed by itself, at a time that is not later than 23:59 of that day, and
    the person is told."""
    p = s.page
    _auto_day_on(s, {"2026-11-15": {"clockIn": "2026-11-15T03:00:00.000Z"}})
    expect(p.get_by_text("was closed automatically at")).to_be_visible(timeout=9000)
    rec = s.ls("workpulse_workdays")["2026-11-15"]
    assert rec.get("clockOut"), f"the forgotten day was not closed: {rec}"
    s.no_errors()


@check("auto_day_close_adds_logs")
def auto_day_close_adds_logs(s):
    """Two minutes after a clock-out the day is closed out by itself: a log marked Auto is added from the done task,
    it can be undone, a log written by hand is left alone, and the day is recorded so it is not done twice."""
    p = s.page
    task = {"id": "task-smoke-auto", "title": "Smoke auto task", "projectId": "proj-1", "dueDate": "2026-11-15", "completed": True,
            "stage": "done", "originalDate": "2026-11-15", "isRolledOver": False, "elapsedSeconds": 1800,
            "completedAt": "2026-11-15T08:00:00.000Z", "isRunning": False}
    manual = {"id": "log-1731000000000-hand", "date": "2026-11-15", "time": "10:00", "projectId": "proj-1", "projectName": "Core Platform & API",
              "description": "Smoke: meeting by hand", "status": "completed", "tags": [], "durationMinutes": 120, "createdAt": "2026-11-15T04:00:00.000Z"}
    p.evaluate("([ack, ackv, t, m]) => { localStorage.setItem(ack, ackv);"
               " localStorage.setItem('workpulse_backlog', JSON.stringify([t]));"
               " localStorage.setItem('workpulse_logs', JSON.stringify([m])); }",
               [ACK_KEY, ACK_VALUE, task, manual])
    _stub_activity(s)  # the scan and the AI are stubbed: two commits in a folder linked to proj-1
    _auto_day_on(s, {"2026-11-15": {"clockIn": "2026-11-15T03:00:00.000Z", "clockOut": "2026-11-15T11:00:00.000Z"}})
    expect(p.get_by_text("added automatically")).to_be_visible(timeout=40000)
    logs = s.ls("workpulse_logs")
    auto = [l for l in logs if l.get("origin") == "auto"]
    assert auto and all(l["date"] == "2026-11-15" for l in auto), f"expected auto logs for the day, got {logs}"
    assert any(l["id"] == manual["id"] for l in logs), "the log written by hand must stay"
    journal = s.ls("workpulse_journal")
    assert journal["2026-11-15"]["state"] == "done" and journal["2026-11-15"]["added"] == len(auto), journal
    # Undo takes the auto logs away and leaves the manual one
    p.get_by_role("button", name="Undo").click()
    p.wait_for_timeout(400)
    left = s.ls("workpulse_logs")
    assert not [l for l in left if l.get("origin") == "auto"] and any(l["id"] == manual["id"] for l in left), "Undo must remove only the auto logs"
    # the day is in the journal, so it is not done again after a reload
    s.reload()
    p.wait_for_timeout(2500)
    assert not [l for l in s.ls("workpulse_logs") if l.get("origin") == "auto"], "the day was closed out twice"
    s.no_errors()


@check("settings_automatic_day")
def settings_automatic_day(s):
    """Settings -> Automatic day: the switches and the projects folder are saved, and a skipped folder can be let go."""
    p = s.page
    settings = s.ls("workpulse_settings")
    settings["activityIgnoredFolders"] = ["E:\skipped\app"]
    s.set_ls("workpulse_settings", settings)
    s.reload()
    s.settings_section("Automatic day")
    day = p.get_by_role("checkbox", name=re.compile("Start and close the day automatically"))
    projects = p.get_by_role("checkbox", name=re.compile("Create projects from my folders"))
    expect(day).not_to_be_checked()  # the smoke profile starts with it off
    expect(projects).to_be_checked()
    day.check()
    projects.uncheck()
    p.locator("#watch-folder").fill("E:\Work")
    p.get_by_role("button", name=re.compile("Stop skipping")).click()
    btn(p, SEL["settings_save"]).click()
    p.wait_for_timeout(400)
    saved = s.ls("workpulse_settings")
    assert saved.get("autoDayEnabled") is None, f"automatic day should be on again (stored as absent): {saved.get('autoDayEnabled')}"
    assert saved.get("activityAutoProjects") is False, "auto projects should be off"
    assert saved.get("activityWatchFolder") == "E:\Work", saved.get("activityWatchFolder")
    assert not saved.get("activityIgnoredFolders"), "the skipped folder should be let go"
    s.no_errors()


@check("error_boundary_isolates_screen")
def error_boundary_isolates_screen(s):
    """A screen that breaks shows a plain message and a way forward, the other screens keep working, and the data is
    untouched. (?wpCrash=history breaks History on purpose; it only does anything in the development build.)"""
    p = s.page
    quick_log(s, "Smoke: data that must survive a broken screen")
    before = s.ls("workpulse_logs")
    p.goto(p.url.split("?")[0] + "?wpCrash=history")
    p.wait_for_load_state("networkidle")
    s.tab("history")
    alert = p.get_by_role("alert").filter(has_text="This screen ran into a problem")
    expect(alert).to_be_visible(timeout=3000)
    expect(alert).to_contain_text("Your data is not affected")
    # the header and the other screens still work
    s.tab("today")
    expect(p.get_by_role("combobox", name=SEL["log_quick_add"])).to_be_visible()
    expect(alert).to_have_count(0)
    # going back to the broken screen shows the message again, and Try again is offered
    s.tab("history")
    expect(alert).to_be_visible(timeout=3000)
    expect(btn(alert, "Try again")).to_be_visible()
    assert s.ls("workpulse_logs") == before, "a broken screen changed the saved logs"
    p.on("console", lambda m: None)
    s.errors = [e for e in s.errors if "Test crash requested" not in e and "The above error occurred" not in e]
    s.no_errors()


@check("error_boundary_dialog_over_page")
def error_boundary_dialog_over_page(s):
    """A dialog that breaks is replaced by a plain message over the page, and the app behind it keeps working."""
    p = s.page
    p.goto(p.url.split("?")[0] + "?wpCrash=dialog")
    p.wait_for_load_state("networkidle")
    box = p.get_by_role("alertdialog")
    expect(box).to_be_visible(timeout=3000)
    expect(box).to_contain_text("This window ran into a problem")
    expect(btn(box, "Close")).to_be_visible()
    expect(p.get_by_role("combobox", name=SEL["log_quick_add"])).to_be_attached()
    s.errors = [e for e in s.errors if "Test crash requested" not in e and "The above error occurred" not in e]
    s.no_errors()


@check("error_boundary_root_no_loop")
def error_boundary_root_no_loop(s):
    """A crash of the whole app reloads the page once, and when it crashes again stays on a plain screen instead of
    reloading for ever. The error is also sent to the server's log."""
    p = s.page
    navigations = []
    p.on("framenavigated", lambda f: navigations.append(f.url) if f == p.main_frame else None)
    logged = []
    p.on("request", lambda r: logged.append(r.post_data or "") if "/api/client-log" in r.url else None)
    p.goto(p.url.split("?")[0] + "?wpCrash=root")
    p.wait_for_timeout(4000)
    screen = p.get_by_role("alert").filter(has_text="WorkPulse ran into a problem")
    expect(screen).to_be_visible(timeout=3000)
    expect(btn(screen, "Reload WorkPulse")).to_be_visible()
    # one reload at most after the first crash: the goto itself plus one reload
    assert len(navigations) <= 3, f"the page kept reloading: {len(navigations)} navigations"
    p.wait_for_timeout(2500)
    again = len(navigations)
    p.wait_for_timeout(2500)
    assert len(navigations) == again, "the page is still reloading by itself"
    # the crash reached the server's log request (batched every 5 s)
    p.wait_for_timeout(2500)
    assert any("ran into a problem" in body for body in logged), "the crash was not sent to the server's log"
    s.errors = [e for e in s.errors if "Test crash requested" not in e and "The above error occurred" not in e]


@check("sync_button")
def sync_button(s):
    """With a Sheet linked, Today's log has a Sync button that sends the unsynced logs."""
    p = s.page
    calls = {"n": 0}

    def proxy(route):
        calls["n"] += 1
        # the automatic sync after adding a log fails; the manual Sync then succeeds
        route.fulfill(json={"status": "ok"} if calls["n"] > 1 else {"status": "error", "message": "stub failure"})

    p.route("**/api/sheets/proxy", s.sheets.stub(proxy))
    settings = s.ls("workpulse_settings") or dict(SEED_SETTINGS, theme="chase")
    settings["googleScriptUrl"] = SCRIPT_URL
    s.set_ls("workpulse_settings", settings)
    s.reload()
    quick_log(s, "Smoke sync entry")
    region = p.get_by_role("region", name=SEL["todays_log"])
    sync = btn(region, re.compile(r"^Sync 1 log to the Sheet$"))
    expect(sync).to_be_visible(timeout=3000)
    sync.click()
    expect(btn(region, "Synced", exact=True)).to_be_disabled(timeout=3000)
    assert all(l.get("syncedAt") for l in s.ls("workpulse_logs") if l["description"] == "Smoke sync entry")
    s.errors = [e for e in s.errors if "stub failure" not in e]
    s.no_errors()


ACK_KEY = "workpulse_activity_notice"
ACK_VALUE = "git+claude+opencode+codex+docs|claude"  # the data notice for the default sources and AI writer


def _open_end_day_with_done_task(s):
    """The sample's running task is marked done (it has tracked time), then End my day opens on Suggested logs."""
    p = s.page
    row_menu(p, p.locator("li.v2-running").first, SEL["menu_done"])
    btn(p.get_by_role("region", name=SEL["todays_log"]), SEL["end_day"], exact=True).click()
    dlg = p.get_by_role("dialog", name=SEL["end_day"])
    expect(dlg).to_be_visible()
    return dlg


@check("end_day_plain_wording")
def end_day_plain_wording(s):
    """End my day, Suggested logs: when the AI request fails the message is plain, the suggestions are written
    without the AI, and nothing raw ("Failed to fetch") reaches the screen."""
    p = s.page
    _stub_activity(s)
    p.route("**/api/activity/suggest", lambda route: route.abort())
    p.evaluate("([k, v]) => localStorage.setItem(k, v)", [ACK_KEY, ACK_VALUE])
    s.reload()
    dlg = _open_end_day_with_done_task(s)
    expect(dlg).to_contain_text("Showing plain wording instead", timeout=8000)
    assert dlg.get_by_text("Failed to fetch").count() == 0, "raw browser error leaked into the UI"
    expect(dlg.get_by_role("checkbox", name=re.compile(r"^Add: "))).not_to_have_count(0)
    s.errors = [e for e in s.errors if "ERR_FAILED" not in e]
    s.no_errors()


@check("end_day_merges_tasks_and_activity")
def end_day_merges_tasks_and_activity(s):
    """One page: the done task and the day's commits come up as suggestions together, Select all ticks them,
    Add writes the logs (with the task's id among their sources) and marks the task's time as logged."""
    p = s.page
    calls = _stub_activity(s)
    p.evaluate("([k, v]) => localStorage.setItem(k, v)", [ACK_KEY, ACK_VALUE])
    s.reload()
    dlg = _open_end_day_with_done_task(s)
    rows = dlg.get_by_role("checkbox", name=re.compile(r"^Add: "))
    expect(rows).to_have_count(3, timeout=8000)  # two commits and the done task, merged into one list
    assert any(i.startswith("task:") for i in calls["suggest"][-1]), "the done task was not sent with the activity"
    btn(dlg, "Select all", exact=True).click()
    expect(btn(dlg, "Clear selection", exact=True)).to_be_visible()
    for i in range(3):
        expect(rows.nth(i)).to_be_checked()
    btn(dlg, re.compile(r"^Add 3 logs$")).click()
    p.wait_for_timeout(500)
    logs = [l for l in s.ls("workpulse_logs") if any(x.startswith("task:") for x in (l.get("sourceIds") or []))]
    assert logs, "no log carries the done task as a source"
    tasks = [t for t in s.ls("workpulse_backlog") if t.get("isSynthesized") and t.get("loggedSeconds")]
    assert tasks and all(t["loggedSeconds"] == t.get("elapsedSeconds") for t in tasks), "the task's time was not marked as logged"
    s.no_errors()


@check("standup_ai_writer")
def standup_ai_writer(s):
    """The standup asks Claude by default and does not send a saved Gemini key; Gemini sends it only when chosen;
    No AI makes no request (the AI route is stubbed, so nothing real is ever called)."""
    p = s.page
    saved = s.ls("workpulse_settings")
    open_standup = lambda: btn(p.get_by_role("region", name=SEL["todays_log"]), SEL["standup"], exact=True).click()

    def standup_request():
        with p.expect_request(lambda r: "/api/gemini/generate" in r.url, timeout=5000) as info:
            open_standup()
        body = json.loads(info.value.post_data or "{}")
        expect(p.get_by_role("dialog").locator("textarea")).to_have_value("Stub standup text.", timeout=5000)
        p.keyboard.press("Escape")
        expect(p.get_by_role("dialog")).to_have_count(0)
        return body

    try:
        s.set_ls("workpulse_settings", dict(saved, geminiApiKey="AIza-smoke-key"))
        s.reload()
        body = standup_request()
        assert body.get("provider") == "claude", f"standup did not ask Claude by default: {body.get('provider')}"
        assert "customApiKey" not in body, "the Gemini key was sent although Gemini is not the AI writer"
        s.set_ls("workpulse_settings", dict(saved, geminiApiKey="AIza-smoke-key", activityAi="gemini"))
        s.reload()
        body = standup_request()
        assert body.get("provider") == "gemini" and body.get("customApiKey") == "AIza-smoke-key", f"Gemini request: {body}"
        s.set_ls("workpulse_settings", dict(saved, activityAi="none"))
        s.reload()
        seen = s.ai.seen
        open_standup()
        expect(p.get_by_role("dialog").locator("textarea")).to_have_value(re.compile("quick progress update"), timeout=5000)
        assert s.ai.seen == seen, "No AI still called the server"
        p.keyboard.press("Escape")
    finally:
        s.set_ls("workpulse_settings", saved)
        s.reload()
    s.no_errors()


# -- activity suggestions (the server is stubbed) -----------------------------------------------
def _stub_activity(s):
    p = s.page
    calls = {"scan": 0, "suggest": [], "providers": []}
    now = datetime.datetime.now(datetime.timezone.utc)
    iso = lambda m: (now - datetime.timedelta(minutes=m)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    items = [
        {"id": "git:a", "source": "git", "folder": "E:\\demo", "time": iso(60), "text": "first commit"},
        {"id": "git:b", "source": "git", "folder": "E:\\demo", "time": iso(10), "text": "second commit"},
    ]

    def scan(route):
        calls["scan"] += 1
        route.fulfill(json={"items": items, "status": {"claude": {"ok": True, "count": 0, "note": "Turned off in Settings"},
                                                       "git": {"ok": True, "count": 2}}})

    def suggest(route):
        body = json.loads(route.request.post_data)
        sent = [i["id"] for i in body["items"]]
        calls["suggest"].append(sent)
        calls["providers"].append((body["provider"], body["customApiKey"]))
        route.fulfill(json={"tasks": [{"text": "Stub task " + i.split(":")[1], "subtasks": ["Did " + i.split(":")[1]],
                                       "itemIds": [i]} for i in sent]})

    p.route("**/api/activity/scan", scan)
    p.route("**/api/activity/suggest", suggest)
    settings = s.ls("workpulse_settings") or dict(SEED_SETTINGS, theme="chase")
    settings["activityFolders"] = [{"path": "E:\\demo", "projectId": "proj-1"}]
    s.set_ls("workpulse_settings", settings)
    return calls


def _seed_clocked_in(s):
    """Clocked in a minute ago, so the next action can be about activity."""
    clock_in = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    s.set_ls("workpulse_workdays", {s.today(): {"clockIn": clock_in}})


def _wait_for(s, cond, tries=50):
    for _ in range(tries):
        try:
            if cond():
                return
        except Exception as e:  # the page is reloading (a restore or an import): look again in a moment
            if "context was destroyed" not in str(e) and "navigation" not in str(e):
                raise
        s.page.wait_for_timeout(100)


@check("activity_suggestions")
def activity_suggestions(s):
    """The full dialog (the next action under 1024 px): nothing is read before the notice is accepted, a ticked
    suggestion becomes a log, reopening shows the kept session without reading again, Scan again reads, and
    activity a log already used is not offered again."""
    p = s.page
    p.set_viewport_size({"width": 900, "height": 900})
    calls = _stub_activity(s)
    _seed_clocked_in(s)
    s.reload()

    def open_dialog(label):
        btn(p.get_by_role("banner"), label).click()
        return p.get_by_role("dialog", name=SEL["activity_dialog"])

    dlg = open_dialog(re.compile(r"^Check activity$"))
    expect(dlg).to_contain_text("Before the first scan")
    p.wait_for_timeout(800)
    assert calls["scan"] == 0 and calls["suggest"] == [], "activity was read before the notice was accepted"
    btn(dlg, "Continue").click()
    rows = dlg.get_by_label("Log text")
    expect(rows).to_have_count(2, timeout=5000)
    expect(dlg).to_contain_text("(estimated)")
    expect(dlg.get_by_label("Sub-tasks, one per line", exact=False)).to_have_count(2)
    expect(btn(dlg, "Add selected")).to_be_disabled()
    # the sample data already has 1h 30m for this project today: the warning says so
    expect(dlg).to_contain_text("You already have 1h 30m tracked or logged")
    dlg.get_by_label("Minutes").first.fill("30")
    dlg.get_by_label("Add: Stub task a").check()
    btn(dlg, "Add 1 selected").click()
    expect(rows).to_have_count(1)
    expect(dlg).to_contain_text("You already have 2h tracked or logged")
    saved = [l for l in s.ls("workpulse_logs") if l["description"] == "Stub task a"]
    assert len(saved) == 1 and saved[0]["sourceIds"] == ["git:a"], "ticked suggestion was not saved as a log"
    assert [t["title"] for t in saved[0]["underlyingTasks"]] == ["Did a"], "sub-tasks were not saved with the log"
    assert saved[0]["underlyingTasks"][0]["stage"] == "done" and saved[0]["underlyingTasks"][0]["elapsedSeconds"] == 0
    p.keyboard.press("Escape")
    expect(p.get_by_role("dialog", name=SEL["activity_dialog"])).to_have_count(0)

    # reopening (the next action now counts what is waiting) shows the kept session without reading again
    scans_before = calls["scan"]
    dlg = open_dialog(re.compile(r"^Review 1 suggestion$"))
    expect(dlg.get_by_label("Log text")).to_have_count(1, timeout=5000)
    p.wait_for_timeout(500)
    assert calls["scan"] == scans_before, "reopening the dialog read the activity again"
    suggests_before = len(calls["suggest"])
    btn(dlg, "Scan again").click()
    _wait_for(s, lambda: len(calls["suggest"]) > suggests_before)
    expect(dlg.get_by_label("Log text")).to_have_count(1, timeout=5000)
    assert calls["scan"] == scans_before + 1, "Scan again did not read the activity"
    assert calls["suggest"][-1] == ["git:b"], f"used activity was offered again: {calls['suggest'][-1]}"
    # Claude Code is the default AI, and the Gemini key is not sent unless Gemini is chosen
    assert calls["providers"][0] == ("claude", ""), f"unexpected AI request: {calls['providers'][0]}"
    p.keyboard.press("Escape")
    expect(p.get_by_role("dialog", name=SEL["activity_dialog"])).to_have_count(0)
    s.no_errors()


@check("activity_today_card")
def activity_today_card(s):
    """The compact panel on Today asks "Check activity" until the notice was accepted; after that it checks on its
    own (and every 5 minutes, unless switched off in Settings). Leaving Today and coming back keeps the session;
    "Scan again" reads again; Select all ticks every suggestion."""
    p = s.page
    calls = _stub_activity(s)
    s.reload()
    card = p.get_by_role("region", name=SEL["suggestions"])
    expect(btn(card, "Check activity", exact=True)).to_be_visible()
    p.wait_for_timeout(800)
    assert calls["scan"] == 0, "the Today card read activity on mount"
    btn(card, "Check activity", exact=True).click()
    expect(card).to_contain_text("Before the first scan")
    p.wait_for_timeout(500)
    assert calls["scan"] == 0, "activity was read before the notice was accepted"
    btn(card, "Continue").click()
    picks = card.get_by_role("checkbox", name=re.compile(r"^Add: Stub task"))
    expect(picks).to_have_count(2, timeout=5000)
    assert calls["scan"] == 1
    # Select all ticks every suggestion, and the same button clears them again
    btn(card, "Select all", exact=True).click()
    expect(picks.nth(0)).to_be_checked()
    expect(picks.nth(1)).to_be_checked()
    btn(card, "Clear selection", exact=True).click()
    expect(picks.nth(0)).not_to_be_checked()
    # leave Today and come back: the same rows, no new read
    s.tab("tasks")
    s.tab("today")
    card = p.get_by_role("region", name=SEL["suggestions"])
    expect(card.get_by_role("checkbox", name=re.compile(r"^Add: Stub task"))).to_have_count(2)
    p.wait_for_timeout(500)
    assert calls["scan"] == 1, "coming back to Today read the activity again"
    btn(card, "Scan again").click()
    _wait_for(s, lambda: calls["scan"] == 2)
    assert calls["scan"] == 2, "Scan again did not read the activity"
    expect(card.get_by_role("checkbox", name=re.compile(r"^Add: Stub task"))).to_have_count(2, timeout=5000)
    # reload: the session is gone and the notice stays accepted, so the card checks on its own, no click needed
    s.reload()
    card = p.get_by_role("region", name=SEL["suggestions"])
    expect(card.get_by_role("checkbox", name=re.compile(r"^Add: Stub task"))).to_have_count(2, timeout=8000)
    assert calls["scan"] == 3, "the Today card did not check on its own after a reload"
    expect(card).not_to_contain_text("Before the first scan")
    # switched off in Settings: no check on mount, "Check activity" reads at once
    settings = s.ls("workpulse_settings")
    settings["activityAutoScan"] = False
    s.set_ls("workpulse_settings", settings)
    s.reload()
    card = p.get_by_role("region", name=SEL["suggestions"])
    expect(btn(card, "Check activity", exact=True)).to_be_visible()
    p.wait_for_timeout(800)
    assert calls["scan"] == 3, "the card checked on mount although automatic checking is off"
    btn(card, "Check activity", exact=True).click()
    expect(card.get_by_role("checkbox", name=re.compile(r"^Add: Stub task"))).to_have_count(2, timeout=5000)
    assert calls["scan"] == 4, "Check activity did not read the activity"
    s.no_errors()


# -- task dates, Plan your day, phone sync and the Phone & evening email settings (the Sheet is stubbed) ----
def _seed_tasks(s, *specs):
    """Write pending tasks to storage and reload. Each spec is (key, title, day offset, extra fields)."""
    tasks = []
    for key, title, offset, extra in specs:
        day = s.day(offset)
        tasks.append(dict({"id": f"task-1700000000000-{key}", "title": title, "projectId": "proj-1", "dueDate": day,
                           "originalDate": day, "isRolledOver": False, "completed": False, "stage": "planned"}, **extra))
    # a reload saves the tasks in memory first (pagehide), which would overwrite a plain localStorage write:
    # an init script plants them once, before the app starts
    s.ctx.add_init_script(
        "try{ if(!sessionStorage.getItem('smoke_seeded')){ sessionStorage.setItem('smoke_seeded','1');"
        " localStorage.setItem('workpulse_backlog', %s) } }catch(e){}" % json.dumps(json.dumps(tasks)))
    s.reload()


def _due(s, title):
    t = next((t for t in (s.ls("workpulse_backlog") or []) if t.get("title") == title), None)
    assert t is not None, f"task '{title}' not found in workpulse_backlog"
    return t.get("dueDate")


def _link_phone(s, **extra):
    """Settings for a linked Sheet (URL and desktop token). Nothing is read until the page reloads."""
    settings = s.ls("workpulse_settings") or dict(SEED_SETTINGS, theme="chase")
    settings.update(googleScriptUrl=SCRIPT_URL, phoneToken=PHONE_TOKEN, **extra)
    s.set_ls("workpulse_settings", settings)


@check("task_dates_move_to_today")
def task_dates_move_to_today(s):
    """Pending tasks stay under their own date (also after a reload and a save); Move all to today and a row's
    Move to today change the date, and Undo puts it back."""
    p = s.page
    old, yest, soon = "Smoke old report", "Smoke review invoices", "Smoke tomorrow prep"
    _seed_tasks(s, ("old", old, -3, {}), ("yest", yest, -1, {}), ("soon", soon, 1, {}))
    s.tab("tasks")
    expect(p.get_by_role("heading", name=re.compile(r"^Yesterday"))).to_be_visible()
    expect(p.get_by_role("region", name=re.compile(r"^Plans")).get_by_text(soon, exact=True)).to_be_visible()
    assert p.locator("main").get_by_text(old, exact=True).count() == 1, "the old task is not listed under its date"
    # something saves the backlog, then a reload: nothing moved to today by itself
    form = p.get_by_role("form", name="Add a task")
    form.get_by_role("textbox", name="Task").fill("Smoke saver task")
    btn(form, "Add", exact=True).click()
    p.wait_for_timeout(400)
    s.reload()
    assert [_due(s, old), _due(s, yest), _due(s, soon)] == [s.day(-3), s.day(-1), s.day(1)], "a task lost its own date"
    s.tab("tasks")
    # one group: Move all to today, then Undo
    btn(p, re.compile(r"^Move all to today from Yesterday")).click()
    p.wait_for_timeout(400)
    assert _due(s, yest) == s.day(0) and _due(s, old) == s.day(-3), "Move all moved the wrong tasks"
    btn(p.get_by_role("region", name="Notifications"), "Undo", exact=True).click()
    p.wait_for_timeout(400)
    assert _due(s, yest) == s.day(-1), "Undo did not bring the date back"
    # one row: the row menu
    row_menu(p, task_row(p, old), SEL["menu_move_today"])
    assert _due(s, old) == s.day(0), "Move to today did not change the date"
    expect(task_row(p, old)).to_be_visible()
    s.no_errors()


@check("task_states_today_and_tasks")
def task_states_today_and_tasks(s):
    """Today groups tasks by state (paused and blocked of any date, up next = planned today, a line for older plans);
    the Tasks page keeps not-started tasks in Plans and started ones in the left column, never in both."""
    p = s.page
    _seed_tasks(s, ("paused", "Smoke paused old", -1, {"stage": "paused", "elapsedSeconds": 600}),
                ("blocked", "Smoke blocked old", -2, {"stage": "blocked", "blockReason": "waiting on a vendor key"}),
                ("next", "Smoke up next", 0, {}), ("plan1", "Smoke plan yesterday", -1, {}), ("plan2", "Smoke plan older", -4, {}))
    s.tab("today")
    card = p.get_by_role("region", name=SEL["todays_tasks"])
    for name, count in (("Paused", 1), ("Blocked", 1), ("Up next", 1)):
        expect(card.get_by_role("group", name=re.compile(rf"^{name}", re.I))).to_contain_text(str(count))
    expect(card.get_by_role("group", name=re.compile(r"^Running", re.I))).to_have_count(0)   # empty groups stay hidden
    expect(task_row(p, "Smoke paused old")).to_contain_text("from Yesterday")
    expect(task_row(p, "Smoke blocked old")).to_contain_text("waiting on a vendor key")
    expect(card.get_by_role("group", name=re.compile(r"^Up next")).get_by_text("Smoke up next", exact=True)).to_be_visible()
    assert card.get_by_text("Smoke plan yesterday", exact=True).count() == 0, "an older plan is listed on Today"
    # the older plans are one line that opens the Tasks page
    btn(card, re.compile(r"^2 more plans from earlier days")).click()
    expect(p.get_by_role("region", name=re.compile(r"^Plans"))).to_be_visible()   # now on the Tasks page
    plans = p.get_by_role("region", name=re.compile(r"^Plans"))
    for title in ("Smoke up next", "Smoke plan yesterday", "Smoke plan older"):
        expect(plans.get_by_text(title, exact=True)).to_have_count(1)
    for title in ("Smoke paused old", "Smoke blocked old"):
        expect(plans.get_by_text(title, exact=True)).to_have_count(0)
        assert p.locator("main").get_by_text(title, exact=True).count() == 1, f"{title} is not in exactly one place"
    s.no_errors()


@check("plan_your_day")
def plan_your_day(s):
    """The first clock-in of a date opens Plan your day; Skip changes nothing; a later visit to the same date does not
    open it again; the Today button does, and Start the day carries ticked tasks and adds the typed ones."""
    p = s.page
    carry, blocked, leave = "Smoke carry me", "Smoke blocked one", "Smoke leave me"
    _seed_tasks(s, ("carry", carry, -1, {}), ("leave", leave, -2, {}),
                ("blocked", blocked, -2, {"stage": "blocked", "blockReason": "waiting on a key"}))
    before = [(t["title"], t["dueDate"], t["stage"]) for t in s.ls("workpulse_backlog")]
    band = p.get_by_role("region", name=SEL["clock_band"])
    btn(band, SEL["clock_in"], exact=True).click()
    btn(p.get_by_role("dialog", name=SEL["clock_in_dialog"]), SEL["clock_in"], exact=True).click()
    plan = p.get_by_role("dialog", name=SEL["plan_day_dialog"])
    expect(plan).to_be_visible(timeout=5000)
    expect(plan.get_by_role("checkbox", name=re.compile(carry))).to_be_checked()
    # only not-started tasks are offered: the blocked one already shows on Today in its own group
    expect(plan.get_by_role("checkbox", name=re.compile(blocked))).to_have_count(0)
    expect(plan.get_by_role("checkbox", name=re.compile(leave))).to_be_checked()
    btn(plan, SEL["plan_skip"], exact=True).click()
    expect(plan).to_have_count(0)
    p.wait_for_timeout(400)
    assert before == [(t["title"], t["dueDate"], t["stage"]) for t in s.ls("workpulse_backlog")], "Skip changed the tasks"
    # the date already has its clock-in: a reload, or clocking out and resuming, does not ask again
    s.reload()
    btn(band, SEL["clock_out"], exact=True).click()
    btn(band, SEL["resume_day"], exact=True).click()
    p.wait_for_timeout(600)
    expect(p.get_by_role("dialog", name=SEL["plan_day_dialog"])).to_have_count(0)
    # the Today card button opens it any time
    btn(p.get_by_role("region", name=SEL["todays_tasks"]), SEL["plan_day_dialog"], exact=True).click()
    plan = p.get_by_role("dialog", name=SEL["plan_day_dialog"])
    expect(plan).to_be_visible()
    plan.get_by_role("checkbox", name=re.compile(leave)).uncheck()
    # Typed by keys: the first word completes to the full project name, then the task follows on the same line.
    area = plan.get_by_label(SEL["plan_new_tasks"], exact=True)
    area.click()
    area.press_sequentially("fr")
    expect(plan.get_by_role("listbox", name="Projects")).to_be_visible()
    area.press("Enter")
    expect(plan.get_by_role("listbox", name="Projects")).to_have_count(0)
    expect(area).to_have_value("Frontend & Design System ")
    area.press_sequentially("Smoke planned A")
    # no project selector and no "#project" sentence any more
    expect(plan.get_by_role("combobox")).to_have_count(0)
    expect(plan).not_to_contain_text("Lines without")
    # a line that starts with no project is flagged and blocks Start the day until it is fixed
    area.press("Enter")
    area.press_sequentially("Zzz nothing here")
    expect(plan).to_contain_text("No project at the start of line 2")
    expect(btn(plan, SEL["plan_start"], exact=True)).to_be_disabled()
    area.press("Control+a")
    area.press("Backspace")
    area.press_sequentially("Frontend & Design System Smoke planned A")
    area.press("Enter")
    area.press_sequentially("frontend: Smoke planned B")
    expect(plan).not_to_contain_text("No project at the start")
    btn(plan, SEL["plan_start"], exact=True).click()
    expect(plan).to_have_count(0)
    p.wait_for_timeout(400)
    assert _due(s, carry) == s.day(0), "the ticked task was not carried to today"
    assert _due(s, leave) == s.day(-2) and _due(s, blocked) == s.day(-2), "an unticked or blocked task moved"
    assert _due(s, "Smoke planned A") == s.day(0) and _due(s, "Smoke planned B") == s.day(0), "typed tasks were not added for today"
    s.no_errors()


@check("phone_inbox_pull")
def phone_inbox_pull(s):
    """With a linked Sheet the tasks typed on the phone arrive once ("from phone"), even when the same items are
    served again, show up in Plan your day, and the desktop pushes its state with the token (never a PIN)."""
    p = s.page
    items = [{"id": f"phone-17000000000{n}-abcd123{n}", "title": title, "projectId": "proj-1", "projectName": "",
              "dueDate": "", "createdAt": "2026-11-11T02:00:00.000Z"}
             for n, title in ((1, "Smoke phone paper"), (2, "Smoke phone call"))]
    stub = ScriptStub(s, inbox=items, serve_again=True)
    _link_phone(s)
    s.reload()
    count = lambda title: sum(1 for t in s.ls("workpulse_backlog") if t["title"] == title)
    _wait_for(s, lambda: count("Smoke phone paper") == 1 and count("Smoke phone call") == 1)
    assert count("Smoke phone paper") == 1 and count("Smoke phone call") == 1, "the phone tasks were not added"
    task = next(t for t in s.ls("workpulse_backlog") if t["title"] == "Smoke phone paper")
    assert task.get("fromPhone") is True and task["dueDate"] == s.day(0), f"phone task not stored as expected: {task}"
    acked = stub.payloads("ackInbox")
    assert acked and sorted(acked[0]["ids"]) == sorted(i["id"] for i in items), "the tasks were not acknowledged after saving"
    # the first clock-in pulls again; the stub serves the same items, which must not be added twice
    btn(p.get_by_role("region", name=SEL["clock_band"]), SEL["clock_in"], exact=True).click()
    btn(p.get_by_role("dialog", name=SEL["clock_in_dialog"]), SEL["clock_in"], exact=True).click()
    plan = p.get_by_role("dialog", name=SEL["plan_day_dialog"])
    expect(plan).to_be_visible(timeout=5000)
    expect(plan).to_contain_text("Smoke phone paper")
    btn(plan, SEL["plan_skip"], exact=True).click()
    expect(plan).to_have_count(0)
    assert stub.actions().count("pullInbox") >= 2, "clock-in did not pull the inbox again"
    assert count("Smoke phone paper") == 1 and count("Smoke phone call") == 1, "a served-again item was added twice"
    expect(task_row(p, "Smoke phone paper")).to_contain_text("from phone")
    # the desktop sends its state after a short pause, with the token and without a PIN
    _wait_for(s, lambda: stub.payloads("pushState"), tries=100)
    pushes = stub.payloads("pushState")
    assert pushes and pushes[-1]["token"] == PHONE_TOKEN, "no state was sent to the Sheet with the token"
    assert all("pin" not in sent for _, sent in stub.calls), "a PIN was sent in a desktop call"
    assert PHONE_TOKEN not in p.locator("body").inner_text(), "the token is shown on the page"
    s.no_errors()


@check("phone_email_settings")
def phone_email_settings(s):
    """Settings > Phone & evening email: Set PIN stores only the token, the phone link appears, Change PIN and Reset
    phone access become available, the evening email saves, and the test email shows its result sentence."""
    p = s.page
    stub = ScriptStub(s)
    settings = s.ls("workpulse_settings") or dict(SEED_SETTINGS, theme="chase")
    settings["googleScriptUrl"] = SCRIPT_URL
    s.set_ls("workpulse_settings", settings)
    s.reload()
    s.settings_section("Phone & evening email")
    sec = p.locator(SEL["phone_section"])
    sec.scroll_into_view_if_needed()
    expect(btn(sec, SEL["set_pin"], exact=True)).to_be_visible(timeout=5000)
    btn(sec, SEL["set_pin"], exact=True).click()
    form = sec.get_by_role("form", name=SEL["set_pin"])
    form.get_by_label(SEL["pin_new"], exact=True).fill("4821")
    form.get_by_label(SEL["pin_again"], exact=True).fill("4821")
    btn(form, SEL["set_pin"], exact=True).click()
    expect(sec).to_contain_text("PIN saved. Open the phone link and enter it once.", timeout=5000)
    saved = s.ls("workpulse_settings")
    assert saved.get("phoneToken") == PHONE_TOKEN, "the token was not stored"
    assert "4821" not in json.dumps(saved), "the PIN was stored on this computer"
    first = stub.payloads("setPin")[0]
    assert first["pin"] == "4821" and "token" not in first, f"unexpected setPin request {first}"
    assert sec.get_by_label(SEL["phone_link"]).inner_text().strip() == SCRIPT_URL + "?page=phone", "wrong phone link"
    expect(btn(sec, SEL["change_pin"], exact=True)).to_be_visible()
    expect(btn(sec, SEL["reset_access"], exact=True)).to_be_visible()
    # the evening email
    sec.get_by_label(SEL["email_on"]).check()
    btn(sec, SEL["email_save"], exact=True).click()
    expect(sec).to_contain_text("18:00", timeout=5000)
    saved = s.ls("workpulse_settings")
    assert saved.get("emailEnabled") is True and saved.get("emailTime") == "18:00", "email settings not saved"
    mail = stub.payloads("setEmail")[0]
    assert (mail["token"], mail["enabled"], mail["hour"], mail["minute"]) == (PHONE_TOKEN, True, 18, 0) and mail["tz"], \
        f"unexpected setEmail request {mail}"
    btn(sec, SEL["email_test"], exact=True).click()
    expect(sec).to_contain_text("Test email sent to owner@gmail.com.", timeout=5000)
    s.no_overflow("Settings")
    s.no_errors()


@check("projects_with_folder_and_trash")
def projects_with_folder_and_trash(s):
    """Settings > Projects & tags (the folder dialog is stubbed, never opened): a project is created with its folder in
    one form and saved at once, the same folder again is refused, a row's folder can be changed and its link removed,
    the colour changes, Move to trash hides it from the pickers, Restore brings it back, and Delete forever (after a
    confirmation) removes the project and its folder link. A later Save All Settings keeps the links."""
    p = s.page
    state = {"path": "C:\\work\\HMIS", "picks": 0}

    def pick(route):
        state["picks"] += 1
        route.fulfill(json={"path": state["path"]})

    p.route("**/api/pick-folder", pick)
    s.settings_section("Projects & tags")
    sec = p.locator("#settings-projects")
    sec.scroll_into_view_if_needed()

    def hmis():
        found = [x for x in s.ls("workpulse_projects") if x["name"] == "HMIS"]
        assert len(found) == 1, f"expected one HMIS project, found {len(found)}"
        return found[0]

    def folders():
        return s.ls("workpulse_settings").get("activityFolders") or []

    btn(sec, "Choose folder", exact=True).click()
    expect(sec.get_by_label("Project name")).to_have_value("HMIS", timeout=5000)
    btn(sec, "Add project", exact=True).click()
    expect(sec).to_contain_text('Project "HMIS" added and linked to that folder.', timeout=5000)
    assert state["picks"] == 1
    proj = hmis()
    assert not proj.get("isArchived") and "trashedAt" not in proj, "the project was not saved at once"
    assert folders() == [{"path": "C:\\work\\HMIS", "projectId": proj["id"]}], f"folder link not saved: {folders()}"
    expect(sec.get_by_title("C:\\work\\HMIS")).to_be_visible()

    # the same folder again changes nothing
    btn(sec, "Choose folder", exact=True).click()
    expect(sec.get_by_label("Project name")).to_have_value("HMIS", timeout=5000)
    btn(sec, "Add project", exact=True).click()
    expect(sec).to_contain_text('That folder is already linked to "HMIS".', timeout=5000)
    assert len(folders()) == 1 and hmis(), "the folder or the project was added twice"
    sec.get_by_label("Project name").fill("")

    # a later Save keeps the link that was saved from Projects
    btn(p, SEL["settings_save"]).first.click()
    assert len(folders()) == 1, "Save All Settings dropped the folder link"

    # Change a row's folder (typed), then Remove link
    btn(sec, "Change folder C:\\work\\HMIS", exact=True).click()
    sec.get_by_label("New folder").fill("C:\\work\\HMIS2")
    btn(sec, "Link folder", exact=True).click()
    expect(sec.get_by_title("C:\\work\\HMIS2")).to_be_visible(timeout=5000)
    assert folders() == [{"path": "C:\\work\\HMIS2", "projectId": proj["id"]}], f"folder not changed: {folders()}"
    btn(sec, "Remove link to C:\\work\\HMIS2", exact=True).click()
    expect(sec.get_by_title("C:\\work\\HMIS2")).to_have_count(0)
    assert folders() == [], "the folder link was not removed"
    # Add folder with the stubbed picker
    btn(sec, "Add folder to HMIS", exact=True).click()
    btn(sec, "Choose folder", exact=True).first.click()
    expect(sec.get_by_label("Folder", exact=True)).to_have_value("C:\\work\\HMIS", timeout=5000)
    btn(sec, "Link folder", exact=True).click()
    expect(sec.get_by_title("C:\\work\\HMIS")).to_be_visible(timeout=5000)
    assert len(folders()) == 1

    # colour
    btn(sec, "Change colour of HMIS", exact=True).click()
    sec.get_by_role("group", name="Colour of HMIS").get_by_role("button", name="Red").click()
    assert hmis()["color"] == "#d6455d", "the colour did not change"

    # Move to trash: gone from the pickers, listed in the Trash, and the Undo toast brings it back
    btn(sec, "Move HMIS to the Trash", exact=True).click()
    expect(sec.get_by_role("textbox", name="Name of HMIS")).to_have_count(0)
    expect(btn(sec, "Restore HMIS", exact=True)).to_be_visible()
    assert hmis().get("trashedAt"), "trashedAt was not saved"
    s.tab("today")
    options = p.get_by_label("Project", exact=True).first.locator("option").all_inner_texts()
    assert "HMIS" not in options and options, f"a trashed project is still in the quick-add list: {options}"
    s.settings_section("Projects & tags")
    sec = p.locator("#settings-projects")
    sec.scroll_into_view_if_needed()
    btn(sec, "Restore HMIS", exact=True).click()
    expect(sec.get_by_role("textbox", name="Name of HMIS")).to_be_visible()
    assert "trashedAt" not in hmis(), "Restore did not clear trashedAt"
    assert len(folders()) == 1, "the folder link was lost in the Trash"
    s.tab("today")
    assert "HMIS" in p.get_by_label("Project", exact=True).first.locator("option").all_inner_texts(), "restored project is not offered"
    s.settings_section("Projects & tags")
    sec = p.locator("#settings-projects")
    sec.scroll_into_view_if_needed()

    # Trash again, then Delete forever after the confirmation (Cancel keeps it)
    btn(sec, "Move HMIS to the Trash", exact=True).click()
    btn(sec, "Delete HMIS forever", exact=True).click()
    dlg = p.get_by_role("dialog", name=re.compile("Delete .HMIS. for good"))
    expect(dlg).to_be_visible()
    p.keyboard.press("Escape")
    expect(dlg).to_have_count(0)
    assert hmis(), "Escape on the confirmation deleted the project"
    btn(sec, "Delete HMIS forever", exact=True).click()
    btn(p.get_by_role("dialog"), "Delete forever", exact=True).click()
    expect(p.get_by_role("dialog")).to_have_count(0)
    assert not [x for x in s.ls("workpulse_projects") if x["name"] == "HMIS"], "the project was not deleted"
    assert folders() == [], "Delete forever left the folder link"
    s.no_overflow("Settings")
    s.no_errors()


@check("phone_old_script")
def phone_old_script(s):
    """A script older than version 3 gets only the update steps, no PIN or email controls."""
    p = s.page
    ScriptStub(s, version=2)
    settings = s.ls("workpulse_settings") or dict(SEED_SETTINGS, theme="chase")
    settings["googleScriptUrl"] = SCRIPT_URL
    s.set_ls("workpulse_settings", settings)
    s.reload()
    s.settings_section("Phone & evening email")
    sec = p.locator(SEL["phone_section"])
    sec.scroll_into_view_if_needed()
    expect(sec).to_contain_text("version 2", timeout=5000)
    expect(sec).to_contain_text("New version")
    expect(btn(sec, SEL["set_pin"])).to_have_count(0)
    expect(sec.get_by_label(SEL["email_on"])).to_have_count(0)
    s.no_errors()


@check("sheet_backup")
def sheet_backup(s):
    """Script version 4: the data is copied to the Sheet by itself after a change (token, no PIN, no keys, no
    screenshots), the status shows in Settings, and Restore from the Sheet downloads the current data first, then
    replaces everything through the normal import path."""
    p = s.page
    restored = "Smoke restored from the Sheet"
    logs = None
    quick_log(s, "Smoke real work")
    logs = s.ls("workpulse_logs")
    template = dict(logs[0])
    restore_log = dict(template, id="log-1700000000000-restore", description=restored)
    backup = {"schemaVersion": 1, "exportedAt": "2026-11-10T09:00:00.000Z", "logs": [restore_log], "backlog": [],
              "projects": [{"id": "proj-1700000000000", "name": "Restored project", "color": "#3366ff"}], "tags": [], "settings": {"theme": "timecard", "workdayHours": 6}, "workdays": {}}
    versions = [{"version": 7, "savedAt": "2026-11-10T09:00:00.000Z", "counts": {"logs": 1, "tasks": 0, "projects": 2}}]
    stub = ScriptStub(s, version=4, versions=versions, backup_text=json.dumps(backup))
    _link_phone(s)
    s.reload()
    # no copy yet: one is made at load, after the short pause
    _wait_for(s, lambda: stub.payloads("saveBackup"), tries=450)
    saves = stub.payloads("saveBackup")
    assert saves and saves[0]["token"] == PHONE_TOKEN, "no backup was sent to the Sheet at load"
    assert "pin" not in saves[0], "a PIN was sent with the backup"
    sent = json.loads(saves[0]["backup"])
    assert any(l["description"] == "Smoke real work" for l in sent["logs"]), "the backup is missing the real log"
    assert PHONE_TOKEN not in saves[0]["backup"] and "phoneToken" not in sent["settings"], "the token is inside the backup"
    assert "geminiApiKey" not in sent["settings"] and "imageBase64" not in saves[0]["backup"], "keys or screenshots in the backup"
    assert saves[0]["meta"]["counts"]["logs"] >= 1
    # a change is copied too
    count = len(saves)
    quick_log(s, "Smoke second log")
    _wait_for(s, lambda: len(stub.payloads("saveBackup")) > count, tries=450)
    assert len(stub.payloads("saveBackup")) > count, "a change was not copied to the Sheet"
    assert "Smoke second log" in stub.payloads("saveBackup")[-1]["backup"]
    assert (s.ls("workpulse_settings") or {}).get("sheetBackupAt", "") > "2026", "the copy time was not recorded"

    s.settings_section("Phone & evening email")
    sec = p.locator(SEL["phone_section"])
    sec.scroll_into_view_if_needed()
    status = sec.get_by_test_id("sheet-backup-status")
    expect(status).to_contain_text("Last copy to the Sheet", timeout=5000)
    expect(sec.get_by_test_id("sheet-backup-versions")).to_contain_text("1 log, 0 tasks, 2 projects", timeout=5000)
    before = len(stub.payloads("saveBackup"))
    btn(sec, "Back up to the Sheet now").click()
    expect(sec).to_contain_text("Copied to the Sheet.", timeout=5000)
    assert len(stub.payloads("saveBackup")) == before + 1, "the button did not copy"

    # restore: confirm first, nothing changes before it, the current data is downloaded, then everything is replaced
    btn(sec, "Restore this copy").click()
    dlg = p.get_by_role("dialog", name=re.compile(r"^Restore the copy from"))
    expect(dlg).to_be_visible()
    expect(dlg).to_contain_text("replaces everything on this computer")
    p.keyboard.press("Escape")
    expect(dlg).to_have_count(0)
    assert any(l["description"] == "Smoke real work" for l in s.ls("workpulse_logs")), "data changed before the confirm"
    btn(sec, "Restore this copy").click()
    with p.expect_download() as dl:
        btn(dlg, "Replace everything and restore").click()
    assert dl.value.suggested_filename.startswith("workpulse-before-restore-"), dl.value.suggested_filename
    old = json.load(open(dl.value.path(), encoding="utf-8"))
    assert any(l["description"] == "Smoke second log" for l in old["logs"]), "the current data was not downloaded first"
    p.wait_for_load_state("networkidle")
    _wait_for(s, lambda: [l["description"] for l in (s.ls("workpulse_logs") or [])] == [restored], tries=100)
    assert [l["description"] for l in s.ls("workpulse_logs")] == [restored], "the data was not replaced by the Sheet copy"
    after = s.ls("workpulse_settings")
    assert after.get("phoneToken") == PHONE_TOKEN and after.get("googleScriptUrl") == SCRIPT_URL, "this computer's Sheet link was lost"
    assert after.get("workdayHours") == 6, "the settings were not restored"
    s.no_errors()


@check("sheet_backup_old_script")
def sheet_backup_old_script(s):
    """Script version 3 (phone works): no backup is sent and Settings shows only the update steps for it."""
    p = s.page
    quick_log(s, "Smoke real work")
    stub = ScriptStub(s, version=3)
    _link_phone(s)
    s.reload()
    s.settings_section("Phone & evening email")
    sec = p.locator(SEL["phone_section"])
    sec.scroll_into_view_if_needed()
    expect(sec).to_contain_text("Backing up all your data to the Sheet needs version 4", timeout=5000)
    expect(sec).to_contain_text("New version")
    expect(btn(sec, "Back up to the Sheet now")).to_have_count(0)
    p.wait_for_timeout(500)
    assert not stub.payloads("saveBackup"), "a backup was sent to a script that cannot keep it"
    s.no_errors()


@check("sheet_safety_net")
def sheet_safety_net(s):
    """The guard itself: a request straight to a script.google.com host is aborted and recorded, and fails the run."""
    def expect_failure(text):
        try:
            s.sheets.check()
        except AssertionError as e:
            assert text in str(e), f"the safety net failed with the wrong message: {e}"
        else:
            raise AssertionError(f"the safety net did not fail the run ({text})")

    reached = s.page.evaluate("() => fetch('https://script.google.com/macros/s/AKfycbNOPE/exec').then(() => true, () => false)")
    assert reached is False, "a request to a real script host was not blocked"
    assert s.sheets.real, "the safety net did not record the request"
    expect_failure("real Google script host")
    s.sheets.real.clear()              # expected: the net works; clear it so the run does not fail

    # A proxy request nobody stubbed is answered by the default handler, which must not count as stubbed.
    answer = s.page.evaluate("() => fetch('/api/sheets/proxy', {method: 'POST', headers: {'Content-Type': 'application/json'},"
                             " body: JSON.stringify({scriptUrl: 'x', action: 'ping'})}).then(r => r.json())")
    assert answer.get("status") == "error", f"the default handler answered {answer}"
    assert s.sheets.defaulted == 1 and s.sheets.stubbed == 0, "the default handler counted as a stub"
    expect_failure("not answered by a stub")
    s.sheets.defaulted, s.sheets.seen = 0, 0

    # A stub that saw something it did not expect fails the run too.
    s.sheets.mismatches.append("test mismatch")
    expect_failure("unexpected request")
    s.sheets.mismatches.clear()
    s.sheets.check()                   # clean again: passes


# -- phones ----------------------------------------------------------------------------------------
@check("phone_pass")
def phone_pass(s):
    """390 px touch: bottom nav, compact clock band, no sideways scrolling, top bar fits, in every theme."""
    for theme in THEMES:
        ctx = s.browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
        ctx.add_init_script("try{ localStorage.setItem('workpulse_settings', %s) }catch(e){}"
                            % json.dumps(json.dumps(dict(SEED_SETTINGS, theme=theme))))
        guard = AiGuard(ctx)
        sheet_guard = SheetGuard(ctx)
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and not any(r.search(m.text) for r in IGNORED_CONSOLE)
                and errors.append(f"console.error: {m.text}"))
        try:
            page.goto(s.url)
            page.wait_for_load_state("networkidle")
            # role queries skip hidden elements: only the bottom nav is left on a phone
            navs = page.get_by_role("navigation", name=SEL["main_nav"])
            assert navs.count() == 1, f"{theme}: header tabs should hide on a phone ({navs.count()} navs shown)"
            bottom = navs.first
            expect(bottom).to_be_visible()
            box = bottom.bounding_box()
            assert box["y"] + box["height"] >= 843, f"{theme}: bottom nav is not at the bottom ({box})"
            assert bottom.get_by_role("button").count() == 4, f"{theme}: bottom nav should have four tabs"
            # clock in: the band shows Now / To go in its compact form
            band = page.get_by_role("region", name=SEL["clock_band"])
            btn(band, SEL["clock_in"], exact=True).click()
            dlg = page.get_by_role("dialog", name=SEL["clock_in_dialog"])
            btn(dlg, SEL["clock_in"], exact=True).click()
            expect(dlg).to_have_count(0)
            plan = page.get_by_role("dialog", name=SEL["plan_day_dialog"])
            expect(plan).to_be_visible(timeout=5000)
            btn(plan, SEL["plan_skip"], exact=True).click()
            expect(plan).to_have_count(0)
            shown = band.inner_text()  # innerText skips the wide layout hidden under 768 px
            assert re.search(r"Now\s+\d{2}:\d{2}:\d{2}", shown, re.I) and re.search(r"To go", shown, re.I), f"{theme}: band shows {shown!r}"
            band_h = band.bounding_box()["height"]
            assert band_h <= 160, f"{theme}: the clock band is {band_h:.0f}px tall on a phone"
            for screen in SCREENS:
                bottom.get_by_role("button", name=re.compile(rf"^{SEL['tabs'][screen]}\b")).click()
                page.wait_for_timeout(250)
                over = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                assert over <= 1, f"{theme}/{screen}: page scrolls sideways by {over}px"
                edges = page.evaluate("() => [...document.querySelectorAll('header button')].map(b => { const r ="
                                      " b.getBoundingClientRect(); return [b.getAttribute('aria-label') || b.textContent.trim(),"
                                      " Math.round(r.right), Math.round(r.height)]; })")
                for label, right, height in edges:
                    if height == 0:
                        continue  # hidden
                    assert right <= 390, f"{theme}: top bar control '{label}' is cut off (right edge {right}px)"
            assert not errors, f"{theme}: browser errors {errors[:3]}"
            guard.check()
            sheet_guard.check()
            assert sheet_guard.checks == 1, f"{theme}: the phone pass did not run the Sheet guard"
        finally:
            ctx.close()


@check("activity_phone")
def activity_phone(s):
    """On a phone the next action opens the activity dialog, and it fits the screen."""
    p = s.page
    p.set_viewport_size({"width": 390, "height": 844})
    _stub_activity(s)
    _seed_clocked_in(s)
    s.reload()
    btn(p.get_by_role("banner"), "Check activity", exact=True).click()
    dlg = p.get_by_role("dialog", name=SEL["activity_dialog"])
    expect(dlg).to_be_visible()
    box = dlg.bounding_box()
    assert box["x"] >= -1 and box["x"] + box["width"] <= 391, "the dialog does not fit the phone screen"
    p.keyboard.press("Escape")
    expect(dlg).to_have_count(0)
    s.no_overflow("phone Today")
    s.no_errors()


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("WP_URL", "http://localhost:3000"))
    ap.add_argument("--only", default="")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--shots", default="")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    if args.list:
        for name, _ in CHECKS:
            print(name + ("   [expected to fail: " + EXPECTED_FAIL[name] + "]" if name in EXPECTED_FAIL else ""))
        return 0

    only = {n.strip() for n in args.only.split(",") if n.strip()}
    if args.shots:
        os.makedirs(args.shots, exist_ok=True)
    rows, bad = [], 0
    with sync_playwright() as pw:
        for name, fn in CHECKS:
            if only and name not in only:
                continue
            session, err = None, None
            try:
                session = Session(pw, args.url, headed=args.headed)
                if name == "themes_all_screens":
                    fn(session, shots=args.shots or None)
                else:
                    fn(session)
                session.page.wait_for_timeout(100)  # let a last request reach its route handler
                session.ai.check()
                session.sheets.check()
                assert session.sheets.checks >= 1, "the Sheet guard was not run"
            except Exception as e:  # AssertionError, playwright timeouts, anything
                err = e
                if session and args.shots:
                    try:
                        session.page.screenshot(path=os.path.join(args.shots, f"FAIL_{name.replace(':', '_')}.png"))
                    except Exception:
                        pass
            finally:
                if session:
                    session.close()
            expected = name in EXPECTED_FAIL
            if err is None:
                status = "XPASS" if expected else "PASS"
            else:
                status = "XFAIL" if expected else "FAIL"
                if not expected:
                    bad += 1
            detail = ""
            if err is not None:
                first_line = str(err).strip().splitlines()[0] if str(err).strip() else type(err).__name__
                detail = first_line[:200]
                if os.environ.get("SMOKE_VERBOSE"):
                    detail = " | ".join(l.strip() for l in str(err).strip().splitlines())[:1500]
                if status == "XFAIL":
                    detail = f"(expected: {EXPECTED_FAIL[name]}) " + detail
            elif status == "XPASS":
                detail = "now passes: remove it from EXPECTED_FAIL"
            rows.append((status, name, detail))
            print(f"{status:5}  {name}  {detail}".rstrip(), flush=True)

    counts = {k: sum(1 for r in rows if r[0] == k) for k in ("PASS", "FAIL", "XFAIL", "XPASS")}
    print("\nsummary: " + ", ".join(f"{v} {k}" for k, v in counts.items()))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
