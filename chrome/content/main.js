"use strict";

(function exposeFeedRankerMain(root, factory) {
  root.FeedRankerMain = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function createMain() {
  const PLUGIN_ID = "feed-ranker@local.zotero";
  const TOOL_NAME = "FeedRank for Zotero";
  const TOOL_TAGLINE = "Your research feeds, ranked by relevance.";
  // Zotero.Prefs adds the "extensions.zotero." namespace itself. Passing a
  // fully-qualified preference here creates an invalid doubled name such as
  // "extensions.zotero.extensions.zotero.feedranker.state" and prevents a
  // completed ranking from being saved.
  const PREF_CONFIG = "feedranker.config";
  const PREF_STATE = "feedranker.state";
  // Read-only migration fallbacks for a value a user may have set manually
  // in about:config before FeedRank used the Zotero.Prefs wrapper correctly.
  const LEGACY_PREF_CONFIG = "extensions.zotero.feedranker.config";
  const LEGACY_PREF_STATE = "extensions.zotero.feedranker.state";
  // FeedRank 0.1.3 passed the legacy names to Zotero.Prefs itself. Zotero then
  // applied its namespace a second time. Preserve anything that old build did
  // manage to write, but never write this malformed namespace again.
  const BROKEN_PREF_CONFIG = "extensions.zotero.extensions.zotero.feedranker.config";
  const BROKEN_PREF_STATE = "extensions.zotero.extensions.zotero.feedranker.state";
  // Zotero preferences are individual string values. Each score record is
  // compacted, then the complete current-run cache is written across bounded
  // FeedRank-only shards. This avoids a hidden all-papers cap while keeping
  // every individual preference safely below its practical size limit.
  const MAX_PERSISTED_RANK_BYTES = 4096;
  const MAX_PERSISTED_RANK_SHARD_BYTES = 128 * 1024;
  // The primary preference retains summaries only. Full ranking records and
  // rerun references live in shards, while call/feed samples stay bounded so
  // an uncapped N-day run with batch size one cannot recreate the original
  // oversized-preference failure through its UI history.
  const MAX_PERSISTED_USAGE_CALLS = 40;
  const MAX_PERSISTED_REFRESH_FEEDS = 40;
  const MAX_PERSISTED_REFRESH_TEXT = 360;
  const MAX_PERSISTED_SCOPE_LIBRARY_IDS = 32;
  const MAX_PERSISTED_COUNT = 1000000000;
  const PREFERENCES_PANE_ID = "feed-ranker-preferences";
  // Retain the old data key so a user's existing column layout stays intact;
  // all visible wording correctly calls this a score rather than a rank.
  const SCORE_COLUMN_ID = "rank";
  const SCORE_DETAILS_PANE_ID = "feed-ranker-score-details";
  // The item-pane section needs an l10nID, not a label: Zotero's schema for `header` and
  // `sidenav` requires `l10nID` and `icon` and has no `label` child, so a label there fails
  // validation and the whole section is rejected -- which is exactly what removed the pane.
  const SCORE_DETAILS_HEADER_L10N_ID = "feed-ranker-score-details-section";
  const SCORE_DETAILS_SIDENAV_L10N_ID = "feed-ranker-score-details-sidenav";
  const ITEM_CONTEXT_MENU_ID = "feed-ranker-score-selected-items";
  const FEED_COLLECTION_CONTEXT_MENU_ID = "feed-ranker-feed-collection-actions";
  const MENU_SEPARATOR_ID = "feed-ranker-menu-separator";
  const MENU_ROOT_ID = "feed-ranker-menu";
  const MENU_POPUP_ID = "feed-ranker-menu-popup";
  const MENU_REFRESH_ID = "feed-ranker-refresh-and-score";
  const MENU_DAYS_ID = "feed-ranker-score-within-days";
  const MENU_RESCORE_DAYS_ID = "feed-ranker-rescore-within-days";
  const MENU_WEEKLY_NOW_ID = "feed-ranker-weekly-now";
  const MENU_RESULTS_ID = "feed-ranker-show-scores";
  const MENU_SETTINGS_ID = "feed-ranker-settings";
  const SCORE_COLUMN_UNSCORED_VALUE = "0000";
  /*
   * How many papers one automatic refresh may send to the model.
   *
   * This is a cost bound, not a scan bound: a refresh still inspects every feed
   * item inside the lookback window, and the newest eligible ones are chosen
   * first. The ceiling was 100, which is low enough to be hit by ordinary arXiv
   * feeds on a busy day and silently defer the remainder to a later run. Batches
   * are dispatched sequentially and each is bounded separately by the batch size,
   * so a larger run costs more but is not riskier per request.
   */
  const MAX_CANDIDATE_LIMIT = 500;
  /*
   * How many batch requests may be in flight at once.
   *
   * Batch dispatch is I/O-bound, so a sequential loop made a run cost the sum of
   * every request. A small fixed ceiling rather than a user-chosen large one: past
   * two or three, provider rate limits (429) start rejecting requests, which costs
   * more time than the parallelism saves. 1 is the default and is exactly the
   * previous behaviour.
   */
  const MAX_BATCH_CONCURRENCY = 3;
  /*
   * How often a parallel run may rewrite its progress line.
   *
   * Three workers report a stage each as they send and receive, so an unthrottled
   * line is rewritten several times a second. Nothing in it changes that fast, and
   * a line that changes faster than it can be read looks like a fault.
   */
  const PARALLEL_PROGRESS_INTERVAL_MS = 300;
  /*
   * How often the scheduled weekly run is checked for being due.
   *
   * A single long timeout to the target moment would break under suspend, resume,
   * a clock change, and a week boundary. Polling a due time and remembering the
   * week that last completed is idempotent instead.
   *
   * One minute, not five: a five-minute poll meant a run set for 16:50 could start
   * at 16:56, which is indistinguishable from a schedule that is not working --
   * that is exactly how it was reported. The check is a date comparison and a
   * string compare with no network access, so a minute costs nothing.
   */
  const WEEKLY_RUN_POLL_MS = 60 * 1000;
  /*
   * The digest is a WEEKLY digest, so the scheduled run always covers the last
   * seven calendar days -- today plus the preceding six -- rather than the
   * configurable refresh lookback. Otherwise a user with a 14-day lookback would
   * be emailed two weeks of papers as "this week", and a user with a 1-day
   * lookback would be emailed almost nothing.
   */
  const WEEKLY_LOOKBACK_DAYS = 7;
  /*
   * How long a refresh waits for Zotero to finish saving what it just fetched.
   *
   * `feed.updateFeed()` resolves when the feed has been processed, but Zotero saves
   * the items it fetched through its own path, and a feed that was already being
   * updated when this run started can resolve immediately while its items land a
   * moment later. The old behaviour read the library exactly once, straight after
   * the await, so those items were simply not in the run -- and therefore not in the
   * digest either, with nothing to say they had been missed.
   *
   * The check is bounded and self-limiting: one short wait after the refresh, and
   * further waits ONLY while items are still appearing. A quiet refresh therefore
   * costs one wait, and a busy one is followed until it stops producing.
   */
  const FEED_SETTLE_DELAY_MS = 2000;
  const FEED_SETTLE_ROUNDS = 3;
  /*
   * "HH:MM" in local time, or "" when no time is scheduled.
   *
   * A timer only runs while Zotero is running, so a scheduled time means "at this
   * time, if Zotero is open", and a missed week runs at the next launch. The parser
   * accepts a tolerant set of inputs because it is fed by a text field, and an
   * unparseable value must disable scheduling rather than silently pick a time.
   */
  function parseRunTime(value) {
    const raw = String(value == null ? "" : value).trim().toLowerCase();
    if (!raw) return "";
    const match = raw.match(/^(\d{1,2})[:.](\d{2})\s*(am|pm)?$/);
    if (!match) return "";
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const meridiem = match[3];
    if (minutes > 59) return "";
    if (meridiem) {
      if (hours < 1 || hours > 12) return "";
      if (meridiem === "pm" && hours !== 12) hours += 12;
      if (meridiem === "am" && hours === 12) hours = 0;
    }
    if (hours > 23) return "";
    return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0");
  }

  // Minutes since local midnight, or null when no time is scheduled.
  function runMinuteOfDay(time) {
    const normalized = parseRunTime(time);
    if (!normalized) return null;
    const [hours, minutes] = normalized.split(":").map(Number);
    return hours * 60 + minutes;
  }

  /*
   * The local date of the most recent scheduled moment at or before `now`.
   *
   * This single value is both the "is it due?" test and the once-per-week guard:
   * the anchor only changes when the chosen weekday and time come round again, so
   * comparing a saved anchor with the current one is exactly "has this week's run
   * already happened?". A moment later in the same week keeps the same anchor, so
   * the poll can ask every five minutes without ever firing twice, and a week that
   * was missed while Zotero was closed still has yesterday's anchor, so it is due
   * once at the next launch rather than skipped.
   */
  function weeklyRunAnchorDay(now, dayOfWeek, minuteOfDay) {
    const day = Math.min(6, Math.max(0, Math.round(Number(dayOfWeek) || 0)));
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    // How many days back the chosen weekday last occurred, today included.
    let back = (candidate.getDay() - day + 7) % 7;
    if (back === 0 && minuteOfDay != null && minutesNow < minuteOfDay) {
      // Today is the day, but the time has not arrived: the current period is
      // still the previous occurrence.
      back = 7;
    }
    candidate.setDate(candidate.getDate() - back);
    return localDayString(candidate);
  }

  // The anonymous week used when no schedule is set: the local Monday, so an
  // install with no chosen day still runs at most once a week at startup.
  function localWeekAnchorDay(now) {
    return weeklyRunAnchorDay(now, 1, null);
  }

  // Every local day is a scheduled day: today once the time has arrived, otherwise
  // yesterday. The same value answers "is it due?" and "has today's run happened?".
  function dailyRunAnchorDay(now, minuteOfDay) {
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    if (minuteOfDay != null && minutesNow < minuteOfDay) candidate.setDate(candidate.getDate() - 1);
    return localDayString(candidate);
  }

  /*
   * The local date of the most recent monthly moment at or before `now`.
   *
   * A day that a short month does not have (the 31st in April) is served on that
   * month's last day instead of being skipped: the alternative is a schedule that
   * silently misses months, and a reader who picks the 31st means "the end of the
   * month" far more often than "never in February".
   */
  function monthlyRunAnchorDay(now, dayOfMonth, minuteOfDay) {
    const wanted = Math.min(31, Math.max(1, Math.round(Number(dayOfMonth) || 1)));
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    const occurrence = (year, month) => {
      const lastDay = new Date(year, month + 1, 0).getDate();
      return new Date(year, month, Math.min(wanted, lastDay), 0, 0, 0, 0);
    };
    const thisMonth = occurrence(now.getFullYear(), now.getMonth());
    const sameDay = now.getDate() === thisMonth.getDate();
    if (sameDay && (minuteOfDay == null || minutesNow >= minuteOfDay)) return localDayString(thisMonth);
    if (thisMonth.getTime() < now.getTime() && !sameDay) return localDayString(thisMonth);
    // Either this month's moment is still ahead, or it is today but the time has not
    // arrived: the current period is last month's occurrence.
    const previousMonth = occurrence(now.getFullYear(), now.getMonth() - 1);
    return localDayString(previousMonth);
  }

  // The cadence names, bounded to the three the settings offer.
  function scheduledFrequency(value) {
    const normalized = String(value == null ? "" : value).trim().toLowerCase();
    return normalized === "daily" || normalized === "monthly" ? normalized : "weekly";
  }

  // "1st", "2nd", "3rd", "21st" -- a day of the month as a reader says it.
  function ordinalSuffix(day) {
    const value = Math.round(Number(day) || 1);
    if (value % 100 >= 11 && value % 100 <= 13) return "th";
    if (value % 10 === 1) return "st";
    if (value % 10 === 2) return "nd";
    if (value % 10 === 3) return "rd";
    return "th";
  }

  // How much of the past a scheduled run covers, and therefore how much the digest it
  // emails covers: "the email digest time span should follow the repeat frequency."
  function scheduledLookbackDays(frequency) {
    const name = scheduledFrequency(frequency);
    if (name === "daily") return 1;
    if (name === "monthly") return 30;
    return 7;
  }

  // The most recent scheduled moment at or before `now`, for the configured cadence.
  function scheduledAnchorDay(now, { runFrequency, weeklyRunDay: weekday, monthlyRunDay, weeklyRunTime }) {
    const minuteOfDay = runMinuteOfDay(weeklyRunTime);
    if (minuteOfDay == null) return "";
    const name = scheduledFrequency(runFrequency);
    if (name === "daily") return dailyRunAnchorDay(now, minuteOfDay);
    if (name === "monthly") return monthlyRunAnchorDay(now, monthlyRunDay, minuteOfDay);
    return weeklyRunAnchorDay(now, weekday, minuteOfDay);
  }

  /*
   * The next scheduled moment strictly after `now`, for the configured cadence.
   *
   * Computed by walking the anchor forward rather than by adding a fixed interval, so a
   * monthly schedule lands on its day of the month even across a short month (the 31st
   * is served on the 30th of April) and a daily one always lands on the next day.
   */
  function nextRunMoment(now, config) {
    const minuteOfDay = runMinuteOfDay(config?.weeklyRunTime);
    if (minuteOfDay == null) return null;
    const hours = Math.floor(minuteOfDay / 60);
    const minutes = minuteOfDay % 60;
    const frequency = scheduledFrequency(config.runFrequency);
    const at = (year, month, day) => new Date(year, month, day, hours, minutes, 0, 0);
    if (frequency === "daily") {
      const candidate = at(now.getFullYear(), now.getMonth(), now.getDate());
      if (candidate.getTime() > now.getTime()) return candidate;
      const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      return at(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());
    }
    if (frequency === "monthly") {
      const wanted = Math.min(31, Math.max(1, Math.round(Number(config.monthlyRunDay) || 1)));
      for (let ahead = 0; ahead <= 13; ahead += 1) {
        const month = new Date(now.getFullYear(), now.getMonth() + ahead, 1);
        const lastDay = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
        const candidate = at(month.getFullYear(), month.getMonth(), Math.min(wanted, lastDay));
        if (candidate.getTime() > now.getTime()) return candidate;
      }
      return null;
    }
    const wanted = Math.min(6, Math.max(0, Math.round(Number(config.weeklyRunDay) || 0)));
    for (let ahead = 0; ahead <= 7; ahead += 1) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
      if (day.getDay() !== wanted) continue;
      const candidate = at(day.getFullYear(), day.getMonth(), day.getDate());
      if (candidate.getTime() > now.getTime()) return candidate;
    }
    return null;
  }

  function localDayString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  /*
   * The window a digest covers, ending on `day`.
   *
   * The span is the cadence: one day for a daily run, seven for a weekly one, thirty
   * for a monthly one -- "the email digest time span should follow the repeat
   * frequency." The subject line is built from the window itself, so whatever the
   * cadence, the message states the exact range it covers.
   */
  function digestWindow(day, lookbackDays = WEEKLY_LOOKBACK_DAYS) {
    const days = Math.max(1, Math.round(Number(lookbackDays) || WEEKLY_LOOKBACK_DAYS));
    const match = String(day || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const end = match
      ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
      : new Date();
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 12);
    start.setDate(start.getDate() - (days - 1));
    return { from: localDayString(start), to: localDayString(end) };
  }

  // The weekly window, kept for the callers that are weekly by definition.
  function weeklyWindow(day) {
    return digestWindow(day, WEEKLY_LOOKBACK_DAYS);
  }

  // The anchor of the week a stored local day belongs to. Only used to migrate
  // the 0.2.6 `dailyPromptDate` marker.
  function weekAnchorForDayString(day) {
    const match = String(day || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return "";
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
    if (Number.isNaN(date.getTime())) return "";
    return localWeekAnchorDay(date);
  }

  const PROMPT_PREVIEW_CANDIDATE = Object.freeze({
    id: "<Zotero library ID:item key>",
    title: "<original Zotero title>",
    abstract: "<original Zotero abstract, when available>",
    authors: ["<original author>"],
    date: "<original publication date>",
    doi: "<original DOI, when available>",
    // A syntactically valid placeholder keeps the reviewable prompt's
    // arXiv-only optional-significance contract visible in Settings. It is
    // never sent as a real paper: actual runs replace this entire row.
    arxiv: "2401.01234",
    institutions: ["<visible Zotero institution or affiliation, when present>"],
    url: "<original URL, when available>",
    source: "<feed or selected-item source>",
  });

  class CancelledError extends Error {
    constructor() {
      super("Scoring was cancelled");
      this.name = "CancelledError";
    }
  }

  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number)) return fallback;
    return Math.min(maximum, Math.max(minimum, number));
  }

  function optionalNonNegativeNumber(value, fallback, Core) {
    // A missing field comes from an older fallback settings dialog and must
    // preserve a saved rate. A deliberately blank field means "unconfigured".
    if (value == null) return fallback;
    if (typeof value === "string" && !value.trim()) return null;
    return Core.nonNegativeNumber(value, fallback);
  }

  function boundedMultilineText(value, fallback = "", maximumLength = 12000) {
    // Keep line breaks for the user-facing tier list, while stripping control
    // characters that have no meaning in a Zotero preference value.
    if (value == null) return fallback;
    return String(value)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
      .slice(0, maximumLength)
      .trim();
  }

  // The property name under which a live Zotero item rides along on a candidate
  // for the duration of one scoring run only. A Zotero item is a complex,
  // circular object graph, so it must be stripped before anything is serialized
  // or persisted; it exists so the pre-scoring journal refresh can write Extra
  // on the real record rather than on a detached snapshot.
  const LIVE_ITEM = "__feedRankItem";

  function withoutLiveItems(value) {
    if (Array.isArray(value)) return value.map((entry) => withoutLiveItems(entry));
    if (!value || typeof value !== "object" || value instanceof Date) return value;
    const copy = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === LIVE_ITEM) continue;
      copy[key] = entry && typeof entry === "object" ? withoutLiveItems(entry) : entry;
    }
    return copy;
  }

  function cloneJSON(value) {
    return JSON.parse(JSON.stringify(withoutLiveItems(value)));
  }

  function boundedStateText(value, maximumLength) {
    if (value == null) return "";
    return String(value)
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, Math.max(0, maximumLength));
  }

  function boundedStateList(value, maximumItems, maximumItemLength) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const result = [];
    for (const entry of value) {
      const text = boundedStateText(entry, maximumItemLength);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push(text);
      if (result.length >= maximumItems) break;
    }
    return result;
  }

  function finiteNonNegativeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function boundedStateCount(value, maximum = MAX_PERSISTED_COUNT) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) return 0;
    return Math.min(maximum, number);
  }

  function utf8ByteLength(value) {
    const source = String(value == null ? "" : value);
    let bytes = 0;
    for (let index = 0; index < source.length; index++) {
      const code = source.charCodeAt(index);
      if (code <= 0x7f) {
        bytes += 1;
      } else if (code <= 0x7ff) {
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdbff &&
          index + 1 < source.length &&
          source.charCodeAt(index + 1) >= 0xdc00 && source.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  class FeedRankerService {
    constructor({ Zotero, Services, rootURI, Core, Notify, Strings, SettingsFile, Components }) {
      this.Zotero = Zotero;
      this.Services = Services;
      this.rootURI = rootURI;
      this.Core = Core;
      /*
       * The language, and the one function that produces user-facing text.
       *
       * `Strings` is optional so a bare test harness can construct the service without it;
       * `t()` then returns the key, which is loud enough to notice in a test and harmless
       * in production because bootstrap always supplies the module. The locale follows
       * Zotero's own UI language, which follows the system language.
       */
      this.Strings = Strings || null;
      this.locale = Strings?.detectLocale
        ? Strings.detectLocale({ Zotero, navigator: typeof navigator === "undefined" ? null : navigator })
        : "en-US";
      this.strings = Strings?.create ? Strings.create({ locale: this.locale }) : null;
      this.t = (key, params) => (this.strings ? this.strings.t(key, params) : String(key));
      // Settings as a file. Optional so a bare harness can construct the service; the
      // methods then report that the feature is unavailable rather than throwing.
      this.SettingsFile = SettingsFile || null;
      this.Components = Components || null;
      // Passive outcome reporting: Zotero's own bottom-right progress panel,
      // which needs no click. Optional, because a bare environment without it
      // falls back to a modal alert rather than reporting nothing.
      this.Notify = Notify || null;
      this.windowBindings = new Map();
      this.startPromise = null;
      this.weeklyStarted = false;
      // What FeedRank is doing right now. Rendered by the panes as one line, so a
      // long automatic run is visible instead of silent.
      this.runState = {
        active: false,
        kind: "",
        label: "",
        stage: "",
        startedAt: 0,
        lastFinishedAt: 0,
        lastOutcome: "",
      };
      // The sticky pop-up for a run in progress, and the last lines of the weekly
      // schedule log (which is also written to a file).
      this.runNotice = null;
      this.weeklyLogTail = [];
      // What the last completed digest did with the email, and how the last scoring
      // run split its candidates. Both are read by the window that closes a
      // scheduled run, and both are reset at the start of each run.
      this.lastDigestOutcome = null;
      this.lastRunSplit = null;
      // activeRun is a workflow-wide lock, not a ranking-progress controller.
      // It is acquired before feed refresh or Awesome GPT readiness waits.
      this.activeRun = null;
      this.activeProgress = null;
      this.shuttingDown = false;
      this.preferencePaneID = null;
      this.rankColumnKey = null;
      this.itemContextMenuKey = null;
      this.feedCollectionContextMenuKey = null;
      this.scoreDetailsPaneKey = null;
      // ItemPaneManager exposes a per-section refresh callback only from
      // onInit(). Keep it by body node so every open Zotero window can be
      // refreshed after a new score is written to the cache.
      this.scoreDetailsRefreshers = new Map();
      this.rankLookup = null;
      // Ranking and email delivery both persist state. Keep each read-modify-
      // write transaction serialized so a prepared email submission cannot
      // erase scores written by a concurrently finishing ranking (or vice
      // versa).
      this.stateMutationQueue = Promise.resolve();
      // Handle for the scheduled-run poll. Cleared on shutdown so a timer cannot
      // outlive the add-on and fire into a torn-down service.
      this.weeklyTimer = null;
    }

    async startup() {
      if (!this.startPromise) this.startPromise = this._startup();
      return this.startPromise;
    }

    async _startup() {
      await this.waitForZoteroReady();
      await this.registerNativeIntegrations();
      for (const window of this.getMainWindows()) {
        await this.onMainWindowLoad(window);
      }
      // Defer one turn so Awesome GPT's own main-window startup hook can attach
      // its verified per-window Meet bridge before the scheduled workflow waits for it.
      this.delay(750).then(() => this.startWeeklyScheduler().catch((error) => this.logError(error)));
    }

    async shutdown() {
      this.shuttingDown = true;
      // Stop the scheduled-run poll before anything else is torn down, so a tick
      // cannot fire into a half-disposed service.
      this.stopWeeklyTimer();
      this.activeRun?.cancel("shutdown");
      this.activeProgress?.cancel("shutdown");
      for (const window of new Set([...this.windowBindings.keys(), ...this.getMainWindows()])) {
        await this.onMainWindowUnload(window);
      }
      this.unregisterNativeIntegrations();
    }

    async registerNativeIntegrations() {
      const integrations = [
        ["preferences pane", () => this.registerPreferencesPane()],
        ["Score item-tree column", () => this.registerScoreColumn()],
        ["Score details item pane", () => this.registerScoreDetailsPane()],
        ["Score selected items menu", () => this.registerItemContextMenu()],
        ["Feed collection menu", () => this.registerFeedCollectionContextMenu()],
      ];
      for (const [name, register] of integrations) {
        try {
          await register();
        } catch (error) {
          // A native UI enhancement must not stop the existing refresh/ranking
          // workflow if another extension or a future Zotero build rejects it.
          this.logError(new Error("Could not register FeedRank " + name + ": " + this.safeError(error)));
        }
      }
    }

    unregisterNativeIntegrations() {
      this.scoreDetailsRefreshers.clear();
      if (this.scoreDetailsPaneKey) {
        try {
          this.Zotero.ItemPaneManager?.unregisterSection?.(this.scoreDetailsPaneKey);
        } catch (_) {}
        this.scoreDetailsPaneKey = null;
      }
      if (this.itemContextMenuKey) {
        try {
          this.Zotero.MenuManager?.unregisterMenu?.(this.itemContextMenuKey);
        } catch (_) {}
        this.itemContextMenuKey = null;
      }
      if (this.feedCollectionContextMenuKey) {
        try {
          this.Zotero.MenuManager?.unregisterMenu?.(this.feedCollectionContextMenuKey);
        } catch (_) {}
        this.feedCollectionContextMenuKey = null;
      }
      if (this.rankColumnKey) {
        try {
          this.Zotero.ItemTreeManager?.unregisterColumn?.(this.rankColumnKey);
        } catch (_) {}
        this.rankColumnKey = null;
      }
      if (this.preferencePaneID) {
        try {
          this.Zotero.PreferencePanes?.unregister?.(this.preferencePaneID);
        } catch (_) {}
        this.preferencePaneID = null;
      }
    }

    async registerPreferencesPane() {
      if (this.preferencePaneID || typeof this.Zotero.PreferencePanes?.register !== "function") return;
      this.preferencePaneID = await this.Zotero.PreferencePanes.register({
        pluginID: PLUGIN_ID,
        src: this.rootURI + "chrome/content/preferences.xhtml",
        id: PREFERENCES_PANE_ID,
        label: TOOL_NAME,
        scripts: [this.rootURI + "chrome/content/preferences.js"],
        stylesheets: [],
      });
    }

    registerScoreColumn() {
      if (this.rankColumnKey || typeof this.Zotero.ItemTreeManager?.registerColumn !== "function") return;
      const key = this.Zotero.ItemTreeManager.registerColumn({
        dataKey: SCORE_COLUMN_ID,
        // Kept as "Score" deliberately: the column is the one score a reader
        // sorts the library by, and that number is now Priority.
        label: "Score",
        pluginID: PLUGIN_ID,
        enabledTreeIDs: ["main"],
        // Zotero's built-in columns still use defaultIn to decide first-run
        // visibility. Keep this visible wherever the main item tree is shown.
        defaultIn: ["*"],
        showInColumnPicker: true,
        width: "58px",
        fixedWidth: true,
        staticWidth: true,
        minWidth: 44,
        sortReverse: true,
        zoteroPersist: ["width", "hidden", "sortDirection"],
        dataProvider: (item) => this.scoreColumnData(item),
        renderCell: (_index, data, _column, _isFirstColumn, document) => {
          const cell = document.createElement("span");
          cell.className = "feed-ranker-score-cell";
          cell.textContent = this.formatScoreColumnData(data);
          return cell;
        },
      });
      if (key) this.rankColumnKey = key;
    }

    // The chrome:// URLs of the item-pane glyphs. ItemPaneManager documents
    // 16x16 for the section header and 20x20 for the sidenav, and accepts a
    // separate darkIcon. Both are rasterised from the supplied artwork, so the
    // pane shows the real logo rather than a redrawn approximation.
    paneIconURLs() {
      return {
        header: this.rootURI + "chrome/content/feedrank-pane.png",
        sidenav: this.rootURI + "chrome/content/feedrank-pane-sidenav.png",
      };
    }

    registerScoreDetailsPane() {
      if (this.scoreDetailsPaneKey || typeof this.Zotero.ItemPaneManager?.registerSection !== "function") return;
      const icons = this.paneIconURLs();
      const key = this.Zotero.ItemPaneManager.registerSection({
        // Zotero namespaces this value using pluginID. Store the returned key
        // for unregistration instead of assuming the final pane ID.
        paneID: SCORE_DETAILS_PANE_ID,
        pluginID: PLUGIN_ID,
        // `l10nID` and `icon`, exactly as Zotero's schema requires; the text comes from the
        // FTL file injected into this window.
        header: {
          l10nID: SCORE_DETAILS_HEADER_L10N_ID,
          icon: icons.header,
        },
        sidenav: {
          l10nID: SCORE_DETAILS_SIDENAV_L10N_ID,
          icon: icons.sidenav,
        },
        onInit: ({ body, refresh }) => {
          this.scoreDetailsRefreshers.set(body, refresh);
        },
        onDestroy: ({ body }) => {
          this.scoreDetailsRefreshers.delete(body);
        },
        onItemChange: ({ item, setEnabled }) => {
          // Keep the section available for ordinary bibliographic items even
          // before they are scored. That lets a stored refresh callback turn
          // the current item's "Not scored" state into its new details
          // immediately after a scoring run.
          setEnabled(this.isRankableItem(item));
        },
        onRender: ({ body, item, setSectionSummary }) => {
          this.renderScoreDetailsPane(body, item, setSectionSummary);
        },
      });
      if (key) this.scoreDetailsPaneKey = key;
    }

    registerItemContextMenu() {
      if (this.itemContextMenuKey || typeof this.Zotero.MenuManager?.registerMenu !== "function") return;
      // MenuManager renders this as a CSS background on the item, so it must be
      // an absolute chrome:// URL. The file is full-colour artwork with alpha,
      // which Zotero draws as-is through `list-style-image`.
      const icon = this.menuIconURL();
      const darkIcon = this.menuDarkIconURL();
      const selectedFrom = (event, context) => {
        const window = event?.target?.ownerGlobal || context?.menuElem?.ownerGlobal || this.getActiveMainWindow();
        return { window, items: this.selectedItemsFromContext(context, window) };
      };
      const rankable = (context, event) => {
        const { items } = selectedFrom(event, context);
        return items.some((item) => this.isRankableItem(item));
      };
      const key = this.Zotero.MenuManager.registerMenu({
        menuID: ITEM_CONTEXT_MENU_ID,
        pluginID: PLUGIN_ID,
        target: "main/library/item",
        menus: [{
          // A submenu keeps the two FeedRank actions together and gives the
          // group a recognizable name, while the icon stays on the parent so no
          // row is left without a glyph.
          //
          // NOTE: `label` is deliberately NOT passed here. MenuManager ignores
          // it (it has no such property), so the text is set on the element in
          // onShowing via setNativeMenuLabel(). Passing it would look correct
          // and silently render nothing.
          menuType: "submenu",
          icon,
          darkIcon,
          onShowing: (event, context) => {
            this.setNativeMenuLabel(context, "FeedRank");
            // Zotero 10 may omit context.items for a right-clicked item even
            // when the selection is valid. Keep a recognizable FeedRank row
            // visible and use the active item-tree selection as a fallback.
            context?.setVisible?.(true);
            context?.setEnabled?.(rankable(context, event));
          },
          menus: [
            {
              // Text on the element, like every other row here: see the note above.
              menuType: "menuitem",
              onShowing: (event, context) => {
                this.setNativeMenuLabel(context, this.t("menu.scoreSelected"));
                context?.setEnabled?.(rankable(context, event));
              },
              onCommand: (event, context) => {
                const { window, items } = selectedFrom(event, context);
                Promise.resolve(this.rankSelectedItems(window, items))
                  .catch((error) => this.handleRunError(window, error));
              },
            },
            {
              // The replacing counterpart, with the same scope: score fills in what
              // is missing, rescore replaces what is stored.
              menuType: "menuitem",
              onShowing: (event, context) => {
                this.setNativeMenuLabel(context, this.t("menu.rescoreSelected"));
                context?.setEnabled?.(rankable(context, event));
              },
              onCommand: (event, context) => {
                const { window, items } = selectedFrom(event, context);
                Promise.resolve(this.rankSelectedItems(window, items, { mode: "rescore" }))
                  .catch((error) => this.handleRunError(window, error));
              },
            },
            {
              // Text is set in onShowing; see the note on the parent submenu.
              menuType: "menuitem",
              onShowing: (event, context) => {
                this.setNativeMenuLabel(context, this.t("menu.updateJournal"));
                context?.setEnabled?.(rankable(context, event));
              },
              onCommand: (event, context) => {
                // The journal lookup resolves its own scope from the current
                // selection, so it does not need the item list here.
                const window = event?.target?.ownerGlobal || context?.menuElem?.ownerGlobal || this.getActiveMainWindow();
                Promise.resolve(this.updateJournalInformation(window))
                  .catch((error) => this.handleRunError(window, error));
              },
            },
          ],
        }],
      });
      if (key) this.itemContextMenuKey = key;
    }

    /*
     * The chrome:// URL of the menu glyph, and its dark-theme counterpart.
     *
     * MenuManager injects these into a CSS `list-style-image` url(), so they must
     * be absolute chrome:// URLs. Zotero selects between them with a
     * `prefers-color-scheme` media query, which is why a pair is supplied: the
     * Both the menu and the item pane are given the SAME file: the artwork is
     * full colour with alpha, Zotero draws it with `list-style-image` rather than
     * masking it, so there is nothing for a dark-mode variant to do. An earlier
     * revision rendered a separate plate-backed dark icon, which was a different
     * picture from the light one and made the logo look inconsistent between
     * surfaces — exactly the complaint it was meant to fix.
     */
    menuIconURL() {
      return this.rootURI + "chrome/content/feedrank-menu.png";
    }

    /*
     * Insert this add-on's FTL file into a window so its l10nIDs resolve.
     *
     * Needed by the item-pane section, whose header takes an `l10nID` (Zotero's schema has no
     * plain label there). The menu rows do NOT use it: they set their text on the element, which
     * is the only thing Zotero's MenuManager honours.
     */
    ensureWindowLocalization(window) {
      try {
        window.MozXULElement?.insertFTLIfNeeded?.("feed-ranker.ftl");
      } catch (error) {
        this.logError(error);
      }
    }

    menuDarkIconURL() {
      return this.menuIconURL();
    }

    selectedItemsFromContext(context, fallbackWindow) {
      const direct = context?.items;
      if (Array.isArray(direct) && direct.length) return direct;
      if (direct && typeof direct !== "string" && typeof direct[Symbol.iterator] === "function") {
        try {
          const items = [...direct];
          if (items.length) return items;
        } catch (_) {}
      }
      try {
        const window = fallbackWindow || context?.menuElem?.ownerGlobal || this.getActiveMainWindow();
        const pane = window?.ZoteroPane || this.Zotero.getActiveZoteroPane?.();
        const selected = pane?.getSelectedItems?.();
        return Array.isArray(selected) ? selected : [];
      } catch (_) {
        return [];
      }
    }

    /*
     * Set an item's visible text.
     *
     * Zotero 10's MenuManager has NO `label` property: it applies only
     * `l10nID` during DOM construction, and a `label:` key in the registration
     * object is accepted by the validator but never read. So an item registered
     * with `label:` alone renders as a blank row with only its icon, and the
     * only reliable way to set text is on the element itself.
     *
     * Both the property and the attribute are set: XUL exposes `label` as a
     * property reflecting the attribute, and setting the property alone does
     * not always update the rendered text immediately.
     */
    setNativeMenuLabel(context, label) {
      const text = this.Core.text(label);
      if (!text) return;
      try {
        const element = context?.menuElem;
        if (!element) return;
        element.setAttribute("label", text);
        element.label = text;
      } catch (_) {
        // A menu element can be torn down while its popup is closing.
      }
    }

    isFeedTreeRow(row) {
      try {
        return typeof row?.isFeed === "function" ? row.isFeed() : row?.type === "feed";
      } catch (_) {
        return false;
      }
    }

    isFeedsTreeRow(row) {
      try {
        return typeof row?.isFeeds === "function" ? row.isFeeds() : row?.type === "feeds";
      } catch (_) {
        return false;
      }
    }

    feedScopeFromCollectionTreeRows(collectionTreeRows) {
      const rows = Array.isArray(collectionTreeRows) ? collectionTreeRows : [];
      if (!rows.length) return null;
      // The native Feeds root deliberately means every subscription. It wins
      // over any individual feed row if a multi-selection includes both.
      if (rows.some((row) => this.isFeedsTreeRow(row))) {
        return { kind: "all", libraryIDs: [], feeds: [], label: "all feeds" };
      }
      const feeds = [];
      const seen = new Set();
      for (const row of rows) {
        if (!this.isFeedTreeRow(row)) continue;
        const feed = row?.ref;
        const libraryID = feed?.libraryID;
        if (libraryID == null || seen.has(libraryID)) continue;
        seen.add(libraryID);
        feeds.push(feed);
      }
      if (!feeds.length) return null;
      const names = feeds.map((feed) => this.Core.text(feed?.name)).filter(Boolean);
      return {
        kind: "feeds",
        libraryIDs: feeds.map((feed) => feed.libraryID),
        feeds,
        label: names.length === 1 ? names[0] : feeds.length + " selected feeds",
      };
    }

    selectedFeedScope(window) {
      try {
        const pane = window?.ZoteroPane || this.Zotero.getActiveZoteroPane?.();
        return this.feedScopeFromCollectionTreeRows(pane?.getCollectionTreeRows?.());
      } catch (_) {
        return null;
      }
    }

    feedScopeFromMenuContext(context, fallbackWindow) {
      let rows = context?.collectionTreeRows;
      if (!Array.isArray(rows) || !rows.length) {
        try {
          const window = fallbackWindow || context?.menuElem?.ownerGlobal || this.getActiveMainWindow();
          const pane = window?.ZoteroPane || this.Zotero.getActiveZoteroPane?.();
          rows = pane?.getCollectionTreeRows?.();
        } catch (_) {
          rows = [];
        }
      }
      return this.feedScopeFromCollectionTreeRows(rows);
    }

    scoreScopeLabel(scope) {
      if (!scope || scope.kind === "all") return "all feeds";
      return scope.label || (scope.libraryIDs?.length === 1 ? "this feed" : "selected feeds");
    }

    registerFeedCollectionContextMenu() {
      if (this.feedCollectionContextMenuKey || typeof this.Zotero.MenuManager?.registerMenu !== "function") return;
      const icon = this.menuIconURL();
      const darkIcon = this.menuDarkIconURL();
      const commandWindow = (event, context) =>
        event?.target?.ownerGlobal || context?.menuElem?.ownerGlobal || this.getActiveMainWindow();
      const scopeFromContext = (context, window) => this.feedScopeFromMenuContext(context, window);
      const updateMenu = (context, label) => {
        const scope = scopeFromContext(context, context?.menuElem?.ownerGlobal);
        context?.setVisible?.(Boolean(scope));
        context?.setEnabled?.(Boolean(scope));
        this.setNativeMenuLabel(context, label(scope));
        return scope;
      };
      const key = this.Zotero.MenuManager.registerMenu({
        menuID: FEED_COLLECTION_CONTEXT_MENU_ID,
        pluginID: PLUGIN_ID,
        target: "main/library/collection",
        menus: [{
          // See the note on the item submenu: `label` is not a MenuManager
          // property, so every label below is applied in onShowing.
          //
          // Only the parent row carries the icon. Repeating the same glyph on
          // every child row made one small mark read as visual noise down the
          // submenu; the parent is what identifies the group.
          menuType: "submenu",
          icon,
          darkIcon,
          onShowing: (_event, context) => {
            updateMenu(context, () => "FeedRank");
          },
          menus: [
            {
              menuType: "menuitem",
              onShowing: (_event, context) => {
                updateMenu(context, () => this.t("menu.scoreDaysScope"));
              },
              onCommand: (event, context) => {
                const window = commandWindow(event, context);
                const scope = scopeFromContext(context, window);
                Promise.resolve(this.scoreFeedItemsWithinDays(window, scope, { confirm: false }))
                  .catch((error) => this.handleRunError(window, error));
              },
            },
            {
              // The replacing counterpart of the row above: the scope comes from
              // the same folder selection, so only the cache behaviour differs.
              menuType: "menuitem",
              onShowing: (_event, context) => {
                updateMenu(context, () => this.t("menu.rescoreDaysScope"));
              },
              onCommand: (event, context) => {
                const window = commandWindow(event, context);
                const scope = scopeFromContext(context, window);
                Promise.resolve(this.scoreFeedItemsWithinDays(window, scope, {
                  confirm: false,
                  mode: "rescore",
                })).catch((error) => this.handleRunError(window, error));
              },
            },
            {
              menuType: "menuitem",
              onShowing: (_event, context) => {
                updateMenu(context, () => this.t("menu.showScoresScope"));
              },
              onCommand: (event, context) => {
                const window = commandWindow(event, context);
                this.showStoredResults(window, scopeFromContext(context, window));
              },
            },
            // "Update journal info" is deliberately NOT offered here. Journal
            // metrics are per-publication, not per-collection, so the action
            // belongs where the user is looking at the papers themselves: the
            // item context menu, and the Tools menu. Offering it on a left-panel
            // folder made an EasyScholar request look like a collection
            // operation and put a second, differently scoped copy of one command
            // in the same submenu.
          ],
        }],
      });
      if (key) this.feedCollectionContextMenuKey = key;
    }

    async withWorkflowLock(window, kind, task, { silent = false } = {}) {
      if (this.shuttingDown) return;
      if (this.activeRun) {
        if (!silent) {
          this.notifyWarn("A feed refresh or scoring operation is already running.");
        }
        return;
      }

      const workflow = {
        kind,
        cancelled: false,
        cancelReason: "",
        progress: null,
        cancel: (reason = "cancelled") => {
          if (workflow.cancelled) return;
          workflow.cancelled = true;
          workflow.cancelReason = reason;
          workflow.progress?.cancel?.(reason);
        },
      };
      // This assignment is deliberately synchronous, before task() can reach
      // its first await. It prevents a second menu command from refreshing the
      // same feeds while the first workflow is still waiting for Awesome GPT.
      this.activeRun = workflow;
      try {
        this.throwIfCancelled(workflow);
        return await task(workflow);
      } finally {
        if (this.activeRun === workflow) this.activeRun = null;
      }
    }

    /*
     * What FeedRank is doing right now, for the panes and the menu.
     *
     * A long automatic run is otherwise invisible once its progress window is
     * behind another window: the user sees Zotero working, and no way to tell
     * whether FeedRank started, what it is on, or whether it finished. This is a
     * small record, not a second UI: the panes render it as one line, and it is
     * cleared as soon as the run ends, so it can never claim a run that is over.
     */
    setRunState(patch = {}) {
      this.runState = { ...(this.runState || {}), ...patch };
      // A repaint is best-effort: a window that is closing must not turn a
      // cosmetic update into a failure.
      try {
        this.refreshScoreDetailsPane?.();
      } catch (_) {}
      return this.runState;
    }

    /*
     * The run's own notice: the small panel in the bottom right that needs no click.
     *
     * "Display a flag ... a pop-up information that does not need me to close" was
     * the request, and this is that channel. It appears when the automatic run
     * starts, is rewritten at each stage, and closes itself when the run ends -- so
     * a long refresh is visible without the user opening anything or dismissing
     * anything.
     */
    runNoticeText(stage) {
      const state = this.runState || {};
      const started = state.startedAt ? new Date(state.startedAt).toLocaleTimeString() : "";
      return [
        stage ? this.t("run.titleStage", { stage }) : this.t("run.title"),
        started ? this.t("run.startedLine", { time: started }) : "",
        this.t("run.closes"),
      ].filter(Boolean).join("\n");
    }

    noteRunStarted(kind, label) {
      const state = this.setRunState({
        active: true,
        kind: this.Core.text(kind),
        label: this.Core.text(label),
        startedAt: Date.now(),
        stage: "starting",
      });
      this.weeklyLog("run started: " + this.Core.text(label, 200));
      try {
        // Reuse the notice the due-check already opened, or open one now for a run
        // that was started by hand. Deliberately the PASSIVE channel only: the
        // scheduled path has already said "the run is starting" in a window, and a
        // second one -- or one for a run the user just clicked -- would be noise.
        if (this.runNotice?.active) {
          this.runNotice.update(this.runNoticeText("starting"));
        } else {
          const notice = this.Notify?.begin?.(this.runNoticeText("starting"), {
            window: this.getActiveMainWindow(),
          });
          if (notice && notice.active !== false) this.runNotice = notice;
        }
      } catch (error) {
        this.logError(new Error("Could not show the FeedRank run notice: " + this.safeError(error)));
      }
      return state;
    }

    noteRunStage(stage) {
      if (!this.runState?.active) return this.runState;
      const state = this.setRunState({ stage: this.Core.text(stage) });
      this.weeklyLog("stage: " + this.Core.text(stage, 200));
      try {
        this.runNotice?.update?.(this.runNoticeText(this.Core.text(stage)));
      } catch (_) {}
      return state;
    }

    noteRunFinished(outcome = "") {
      const state = this.setRunState({
        active: false,
        kind: "",
        label: "",
        stage: "",
        startedAt: 0,
        lastFinishedAt: Date.now(),
        lastOutcome: this.Core.text(outcome),
      });
      this.weeklyLog("run finished: " + this.Core.text(outcome || "completed", 200));
      try {
        this.runNotice?.close?.(
          this.t("run.finished", { outcome: outcome || "" }),
        );
      } catch (_) {}
      this.runNotice = null;
      return state;
    }

    // The one line the panes show about the automatic run, and what it is doing.
    runStateSummary() {
      const state = this.runState || {};
      const planned = this.scheduleDescription();
      if (state.active) {
        const since = state.startedAt ? new Date(state.startedAt).toLocaleTimeString() : "";
        return "Automatic run: RUNNING" + (since ? " since " + since : "") +
          (state.stage ? " — " + state.stage : state.label ? " — " + state.label : "") +
          ". Planned: " + planned + ".";
      }
      const last = this.loadState().weeklyPromptWeek;
      /*
       * "Already done for this period" is stated, not implied.
       *
       * The marker is what silently swallowed a newly set time: the run had already
       * happened for the period, so the moment the user had just chosen could not
       * fire and nothing on screen said why.
       */
      const anchor = this.currentRunAnchor();
      const doneThisPeriod = Boolean(last) && last === anchor;
      return "Automatic run: idle. Planned: " + planned + "." +
        (doneThisPeriod
          ? " This period's run is already done (" + last + "); the next one is " +
            (this.scheduleReport().nextRun?.toLocaleString() || "later") + "."
          : last ? " Last completed for " + last + "." : "");
    }

    /*
     * Everything needed to tell whether the schedule is alive, in one string.
     *
     * Asked for after "nothing appears on the weekly run time": the pane line says
     * what happened last, but not whether the timer is armed, when the next check
     * will be, or whether this period is already done -- which is what you need to
     * decide whether the schedule is broken or simply has not come round yet. Every
     * figure here comes from the live service, not from a stored copy.
     */
    scheduleReport(now = new Date()) {
      const config = this.loadConfig();
      const state = this.runState || {};
      const stored = this.loadState();
      const scheduled = runMinuteOfDay(config.weeklyRunTime);
      const frequency = scheduledFrequency(config.runFrequency);
      const report = {
        enabled: scheduled != null,
        frequency,
        lookbackDays: scheduledLookbackDays(frequency),
        description: this.scheduleDescription(config),
        day: Math.min(6, Math.max(0, Math.round(Number(config.weeklyRunDay) || 0))),
        monthlyDay: Math.min(31, Math.max(1, Math.round(Number(config.monthlyRunDay) || 1))),
        time: scheduled == null ? "" : parseRunTime(config.weeklyRunTime),
        pollSeconds: Math.round(WEEKLY_RUN_POLL_MS / 1000),
        timerArmed: this.weeklyTimer != null,
        running: state.active === true,
        stage: this.Core.text(state.stage),
        anchor: this.currentRunAnchor(now),
        lastWeek: this.Core.text(stored.weeklyPromptWeek),
        lastFinishedAt: Number(state.lastFinishedAt) || 0,
        lastOutcome: this.Core.text(state.lastOutcome),
        nextRun: null,
      };
      report.dueNow = this.isWeeklyRunDue(now);
      if (scheduled != null) report.nextRun = nextRunMoment(now, config);
      return report;
    }

    /*
     * The short answer to "is the schedule all right?".
     *
     * Asked to be reduced: "check schedule button give too much info." It used to print
     * the poll interval, the digest span, the running state, the last completed period,
     * a poll counter and the last eight log lines -- around fifteen lines to say four
     * things. What is left is the cadence and whether the timer is armed, the next run,
     * whether this period is already served, and what the last run did. The poll counter
     * appears only when the timer is NOT armed, which is the one case where "is it
     * ticking at all?" is the question, and the twenty-line log stays in FeedRank's
     * saved state where it can be read when something actually goes wrong.
     */
    scheduleReportText() {
      const report = this.scheduleReport();
      if (!report.enabled) {
        return this.t("schedule.off") + "\n" + this.t("schedule.offHint");
      }
      const lines = [
        this.t("schedule.line", {
          when: report.description,
          armed: report.timerArmed ? this.t("schedule.armed") : this.t("schedule.notArmed"),
          running: report.running
            ? this.t("schedule.runningNow", { stage: report.stage || this.t("schedule.waiting") })
            : "",
        }),
        report.nextRun
          ? this.t("schedule.next", { when: report.nextRun.toLocaleString() })
          : this.t("schedule.nextUnknown"),
        this.t("schedule.period", {
          anchor: report.anchor,
          state: report.lastWeek === report.anchor
            ? this.t("schedule.done")
            : report.dueNow ? this.t("schedule.due") : this.t("schedule.waiting"),
        }),
      ];
      if (report.lastWeek) {
        lines.push(
          this.t("schedule.lastRun", {
            outcome: report.lastOutcome || "completed",
            at: report.lastFinishedAt
              ? this.t("schedule.at", { time: new Date(report.lastFinishedAt).toLocaleTimeString() })
              : "",
          }),
        );
      }
      if (!report.timerArmed) {
        lines.push(
          "Checks: " + (Number(this.scheduleChecks) || 0) +
            (this.lastScheduleCheckAt
              ? ", last at " + new Date(this.lastScheduleCheckAt).toLocaleTimeString()
              : "") + ".",
        );
      }
      return lines.join("\n");
    }

    beginWorkflowProgress(window, workflow, title, initialMessage = "Preparing…") {
      const progress = this.createProgress(window, title);
      if (!progress || typeof progress !== "object") return null;
      progress.workflow = workflow || null;
      this.activeProgress = progress;
      if (workflow) workflow.progress = progress;
      progress.update?.(initialMessage, 0, 1);
      return progress;
    }

    endWorkflowProgress(workflow, progress) {
      if (!progress) return;
      try {
        progress.close?.();
      } catch (_) {
        // A progress window can disappear while its parent Zotero window is
        // closing. The workflow itself remains responsible for cleanup.
      }
      if (workflow?.progress === progress) workflow.progress = null;
      if (this.activeProgress === progress) this.activeProgress = null;
    }

    async waitForAwesomeGPTWithProgress(window, workflow, title, message) {
      const progress = this.beginWorkflowProgress(window, workflow, title, message);
      try {
        const bridge = await this.waitForAwesomeGPT(window, 30000, workflow, progress);
        this.throwIfCancelled(workflow, progress);
        progress?.update?.(this.t("progress.gptReady"), 1, 1);
        return bridge;
      } finally {
        this.endWorkflowProgress(workflow, progress);
      }
    }

    isCancelled(workflow, progress) {
      return Boolean(this.shuttingDown || workflow?.cancelled || progress?.cancelled);
    }

    throwIfCancelled(workflow, progress) {
      if (workflow?.cancelled && progress && !progress.cancelled) {
        progress.cancel?.(workflow.cancelReason || "cancelled");
      }
      if (this.isCancelled(workflow, progress)) throw new CancelledError();
    }

    async waitForZoteroReady() {
      const promises = [
        this.Zotero.initializationPromise,
        this.Zotero.unlockPromise,
        this.Zotero.uiReadyPromise,
      ].filter((promise) => promise && typeof promise.then === "function");
      await Promise.all(promises);
    }

    getMainWindows() {
      try {
        const windows = this.Zotero.getMainWindows?.();
        return Array.isArray(windows) ? windows.filter((window) => window && !window.closed) : [];
      } catch (_) {
        const window = this.Zotero.getMainWindow?.();
        return window && !window.closed ? [window] : [];
      }
    }

    getActiveMainWindow(preferredWindow) {
      if (preferredWindow && !preferredWindow.closed) return preferredWindow;
      try {
        const window = this.Zotero.getMainWindow?.();
        if (window && !window.closed) return window;
      } catch (_) {
        // A window can disappear during shutdown; the caller handles no window.
      }
      return this.getMainWindows()[0];
    }

    async onMainWindowLoad(window) {
      if (!window || window.closed || this.windowBindings.has(window)) return;
      this.ensureWindowLocalization(window);
      const document = window.document;
      const menu = document.getElementById("menu_ToolsPopup");
      if (!menu) return;

      // A hot reload/update can leave a prior instance's menu nodes behind
      // before its window-unload hook runs. Remove only this add-on's exact IDs.
      for (const id of [
        MENU_ROOT_ID,
        MENU_POPUP_ID,
        MENU_SEPARATOR_ID,
        MENU_REFRESH_ID,
        MENU_DAYS_ID,
        MENU_RESCORE_DAYS_ID,
        MENU_WEEKLY_NOW_ID,
        MENU_RESULTS_ID,
        MENU_SETTINGS_ID,
        // Clean up nodes created by version 0.1.2 before replacing them with
        // the grouped submenu on a hot reload/update.
        "feed-ranker-refresh-and-rank",
        "feed-ranker-rerank-last",
        "feed-ranker-show-results",
        // The removed "Rescore latest articles" entry, so an upgraded install does
        // not keep a menu item whose command no longer exists.
        "feed-ranker-rescore-last",
      ]) {
        document.getElementById(id)?.remove();
      }

      const items = [];
      const submenu = document.createXULElement("menu");
      submenu.id = MENU_ROOT_ID;
      // The Tools submenu uses the full add-on name so it matches Zotero's
      // Plugins list and the Settings pane heading. Shorter "FeedRank" labels
      // are reserved for the per-feed submenu that nests inside it.
      submenu.setAttribute("label", TOOL_NAME);
      submenu.setAttribute("tooltiptext", TOOL_TAGLINE);
      const popup = document.createXULElement("menupopup");
      popup.id = MENU_POPUP_ID;
      submenu.appendChild(popup);
      menu.appendChild(submenu);
      items.push(submenu);
      const addItem = (id, label, callback) => {
        const item = document.createXULElement("menuitem");
        item.id = id;
        item.setAttribute("label", label);
        item.addEventListener("command", () => {
          Promise.resolve(callback()).catch((error) => this.handleRunError(window, error));
        });
        popup.appendChild(item);
      };
      const separator = document.createXULElement("menuseparator");
      separator.id = MENU_SEPARATOR_ID;
      // Exactly the names documented in README.md and quoted by the dialogs
      // below, so a message that says "use X" always matches a visible X.
      // Kept as short as the documented name allows: Zotero's Tools menu is
      // narrow and a longer label is elided.
      addItem(MENU_REFRESH_ID, this.t("menu.refresh"), () => this.runManualRefresh(window));
      addItem(MENU_DAYS_ID, this.t("menu.scoreDays"), () => this.scoreFeedItemsWithinDays(window));
      addItem(MENU_RESCORE_DAYS_ID, this.t("menu.rescoreDays"), () =>
        this.scoreFeedItemsWithinDays(window, undefined, { mode: "rescore" }));
      /*
       * The on-demand weekly command, named for what the reader gets.
       *
       * It was "Run weekly job now", which described the machinery. What arrives is
       * the week's digest -- rebuilt from this week's eligible scores and sent -- so
       * the menu says that instead.
       */
      addItem(MENU_WEEKLY_NOW_ID, this.t("menu.sendDigest"), () => this.runWeekly(new Date(), { manual: true }));
      addItem(MENU_RESULTS_ID, this.t("menu.showScores"), () => this.showStoredResults(window));
      popup.appendChild(separator);
      addItem(MENU_SETTINGS_ID, this.t("menu.settings"), () => this.openSettings(window));

      const previousFacade = window.FeedRanker;
      const facade = {
        refreshAndScore: () => this.runManualRefresh(window),
        scoreWithinDays: () => this.scoreFeedItemsWithinDays(window),
        // Two scoring functions, and only two: "score" fills in what is missing,
        // "rescore" replaces what is stored. `rescoreLast` is kept as the old name
        // for the replacing mode while any already-open dialog from an older
        // version is still alive during an update.
        rescoreWithinDays: () => this.scoreFeedItemsWithinDays(window, undefined, { mode: "rescore" }),
        rescoreLast: () => this.scoreFeedItemsWithinDays(window, undefined, { mode: "rescore" }),
        showScores: () => this.showStoredResults(window),
        // Keep private aliases while any already-open result dialog from an
        // older version is still alive during an update.
        refreshAndRank: () => this.runManualRefresh(window),
        showResults: () => this.showStoredResults(window),
        openSettings: () => this.openSettings(window),
        openItem: (itemID) => this.openFeedItem(window, itemID),
        openURL: (url) => this.openURL(url),
        previewDigest: (records, summary) => this.previewDigest(window, records, summary),
        sendDigest: (records, summary) => this.sendDigest(window, records, summary),
      };
      window.FeedRanker = facade;
      this.windowBindings.set(window, { items, previousFacade, facade });
    }

    async onMainWindowUnload(window) {
      const binding = this.windowBindings.get(window);
      if (!binding) return;
      for (const item of binding.items) {
        try {
          item.remove();
        } catch (_) {
          // The document may have been torn down already.
        }
      }
      if (window.FeedRanker === binding.facade) {
        if (binding.previousFacade === undefined) delete window.FeedRanker;
        else window.FeedRanker = binding.previousFacade;
      }
      this.windowBindings.delete(window);
    }

    readPluginPreference(key, ...legacyKeys) {
      let value;
      try {
        value = this.Zotero.Prefs.get(key);
      } catch (_) {}
      if (value != null && value !== "") return value;
      // Services.prefs uses fully-qualified keys. This fallback is strictly
      // read-only; all new values are written through Zotero.Prefs above.
      for (const legacyKey of legacyKeys) {
        if (!legacyKey) continue;
        try {
          const legacy = this.Services.prefs?.getStringPref?.(legacyKey, "");
          if (legacy) return legacy;
        } catch (_) {}
      }
      return value;
    }

    loadConfig() {
      let stored = {};
      try {
        stored = asObject(JSON.parse(this.readPluginPreference(
          PREF_CONFIG,
          LEGACY_PREF_CONFIG,
          BROKEN_PREF_CONFIG,
        ) || "{}"));
      } catch (_) {
        stored = {};
      }
      const defaults = this.Core.DEFAULT_CONFIG;
      const legacyBibliometricWeight = Math.max(
        boundedInteger(stored.journalImpactWeightPoints, 0, 0, 10),
        boundedInteger(stored.arxivSignificanceWeightPoints, 0, 0, 10),
      );
      return {
        profile: this.Core.text(stored.profile) || defaults.profile,
        explanationLanguage: this.Core.text(stored.explanationLanguage) || defaults.explanationLanguage,
        lookbackDays: boundedInteger(stored.lookbackDays, defaults.lookbackDays, 0, 365),
        candidateLimit: boundedInteger(stored.candidateLimit, defaults.candidateLimit, 1, MAX_CANDIDATE_LIMIT),
        batchSize: boundedInteger(stored.batchSize, defaults.batchSize, 1, this.Core.MAX_BATCH_SIZE || 50),
        maxRetries: boundedInteger(stored.maxRetries, defaults.maxRetries, 0, 3),
        // 1 keeps the original sequential dispatch; 2–3 overlaps the waiting.
        batchConcurrency: boundedInteger(
          stored.batchConcurrency,
          defaults.batchConcurrency,
          1,
          MAX_BATCH_CONCURRENCY,
        ),
        // "" means no scheduled run. A set time means "run on this cadence, at this
        // local time, whenever Zotero is open": daily, weekly on `weeklyRunDay`, or
        // monthly on `monthlyRunDay`. A legacy daily time from 0.2.6 is migrated to
        // the weekly cadence, because the digest became weekly and keeping a daily
        // cadence would have sent the same week's papers seven times; the frequency
        // is a setting again now, so a reader who wants daily chooses it.
        runFrequency: scheduledFrequency(stored.runFrequency ?? defaults.runFrequency),
        weeklyRunDay: boundedInteger(stored.weeklyRunDay, defaults.weeklyRunDay, 0, 6),
        monthlyRunDay: boundedInteger(stored.monthlyRunDay, defaults.monthlyRunDay, 1, 31),
        weeklyRunTime: parseRunTime(
          stored.weeklyRunTime == null ? stored.dailyRunTime : stored.weeklyRunTime,
        ),
        requestTimeoutMs: boundedInteger(
          stored.requestTimeoutMs,
          defaults.requestTimeoutMs,
          15000,
          300000,
        ),
        currency: this.Core.currencyCode(stored.currency, defaults.currency),
        inputPricePerMillion: this.Core.nonNegativeNumber(
          stored.inputPricePerMillion,
          defaults.inputPricePerMillion,
        ),
        outputPricePerMillion: this.Core.nonNegativeNumber(
          stored.outputPricePerMillion,
          defaults.outputPricePerMillion,
        ),
        // 0.2.3 consolidates the old journal/arXiv point caps into one local
        // maximum. Preserve the stronger old setting during migration rather
        // than quietly reducing either existing bonus.
        bibliometricWeightPoints: stored.bibliometricWeightPoints == null
          ? legacyBibliometricWeight
          : boundedInteger(stored.bibliometricWeightPoints, defaults.bibliometricWeightPoints, 0, 10),
        arxivSignificanceSignals: boundedMultilineText(
          stored.arxivSignificanceSignals,
          defaults.arxivSignificanceSignals,
        ),
      };
    }

    saveConfig(rawConfig) {
      const oldConfig = this.loadConfig();
      const hasSharedWeight = Object.prototype.hasOwnProperty.call(rawConfig, "bibliometricWeightPoints");
      const hasLegacyWeight = Object.prototype.hasOwnProperty.call(rawConfig, "journalImpactWeightPoints") ||
        Object.prototype.hasOwnProperty.call(rawConfig, "arxivSignificanceWeightPoints");
      const sharedWeight = hasSharedWeight
        ? boundedInteger(rawConfig.bibliometricWeightPoints, oldConfig.bibliometricWeightPoints, 0, 10)
        : hasLegacyWeight
          ? Math.max(
            boundedInteger(rawConfig.journalImpactWeightPoints, 0, 0, 10),
            boundedInteger(rawConfig.arxivSignificanceWeightPoints, 0, 0, 10),
          )
          : oldConfig.bibliometricWeightPoints;
      const config = {
        profile: this.Core.text(rawConfig.profile) || oldConfig.profile,
        explanationLanguage: this.Core.text(rawConfig.explanationLanguage) || oldConfig.explanationLanguage,
        lookbackDays: boundedInteger(rawConfig.lookbackDays, oldConfig.lookbackDays, 0, 365),
        candidateLimit: boundedInteger(rawConfig.candidateLimit, oldConfig.candidateLimit, 1, MAX_CANDIDATE_LIMIT),
        batchSize: boundedInteger(rawConfig.batchSize, oldConfig.batchSize, 1, this.Core.MAX_BATCH_SIZE || 50),
        maxRetries: boundedInteger(rawConfig.maxRetries, oldConfig.maxRetries, 0, 3),
        batchConcurrency: boundedInteger(
          rawConfig.batchConcurrency,
          oldConfig.batchConcurrency ?? this.Core.DEFAULT_CONFIG.batchConcurrency,
          1,
          MAX_BATCH_CONCURRENCY,
        ),
        // The previous value survives a garbled field, and an explicit blank is
        // how scheduling is switched off, so absence and "" must be distinguished.
        runFrequency: rawConfig.runFrequency == null
          ? (oldConfig.runFrequency ?? this.Core.DEFAULT_CONFIG.runFrequency)
          : scheduledFrequency(rawConfig.runFrequency),
        weeklyRunDay: boundedInteger(
          rawConfig.weeklyRunDay,
          oldConfig.weeklyRunDay ?? this.Core.DEFAULT_CONFIG.weeklyRunDay,
          0,
          6,
        ),
        monthlyRunDay: boundedInteger(
          rawConfig.monthlyRunDay,
          oldConfig.monthlyRunDay ?? this.Core.DEFAULT_CONFIG.monthlyRunDay,
          1,
          31,
        ),
        weeklyRunTime: rawConfig.weeklyRunTime == null
          ? oldConfig.weeklyRunTime
          : parseRunTime(rawConfig.weeklyRunTime),
        requestTimeoutMs: boundedInteger(
          rawConfig.requestTimeoutMs,
          oldConfig.requestTimeoutMs,
          15000,
          300000,
        ),
        currency: rawConfig.currency == null || !this.Core.text(rawConfig.currency)
          ? oldConfig.currency
          : this.Core.currencyCode(rawConfig.currency, oldConfig.currency),
        inputPricePerMillion: optionalNonNegativeNumber(
          rawConfig.inputPricePerMillion,
          oldConfig.inputPricePerMillion,
          this.Core,
        ),
        outputPricePerMillion: optionalNonNegativeNumber(
          rawConfig.outputPricePerMillion,
          oldConfig.outputPricePerMillion,
          this.Core,
        ),
        bibliometricWeightPoints: sharedWeight,
        arxivSignificanceSignals: boundedMultilineText(
          rawConfig.arxivSignificanceSignals,
          oldConfig.arxivSignificanceSignals,
        ),
      };
      this.Zotero.Prefs.set(PREF_CONFIG, JSON.stringify(config));
      this.rankLookup = null;
      this.refreshRankColumn();
      // A profile/settings change can invalidate the score currently visible
      // in the details section, so update any open item panes as well.
      void this.refreshScoreDetailsPane();
      /*
       * A changed weekly moment is a new moment to serve.
       *
       * Without this, the schedule could not be tested at all on the day it was
       * set: `weeklyPromptWeek` means "this week's moment has already been served",
       * and it is written by every completed run -- including "Run weekly job now".
       * So a user who ran the job by hand and then set a time for ten minutes later
       * got nothing, for the rest of the week, with no explanation. The marker is
       * cleared when the day or the time actually changes, which is exactly the
       * statement "this period starts again".
       */
      if (config.runFrequency !== oldConfig.runFrequency ||
          config.weeklyRunDay !== oldConfig.weeklyRunDay ||
          config.monthlyRunDay !== oldConfig.monthlyRunDay ||
          config.weeklyRunTime !== oldConfig.weeklyRunTime) {
        this.noteScheduleChanged(oldConfig, config);
      }
      return config;
    }

    scoreConfigFingerprint(config) {
      try {
        return boundedStateText(this.Core.rankingConfigFingerprint?.(config), 128);
      } catch (_) {
        return "";
      }
    }

    /*
     * True when a stored record was scored under the CURRENT prompt contract.
     *
     * `rankingConfigFingerprint` covers only what the model was asked -- prompt
     * version, profile, explanation language -- because the dispatch settings
     * (lookback, candidate limit, batch size, retries, timeout) cannot change an
     * answer. Records written from 0.2.8 on also carry `fingerprintScheme: 2`, which
     * is what makes that narrow comparison decisive: a scheme-2 record whose
     * fingerprint does not match was scored under a different question and must be
     * re-scored.
     *
     * A record from an older build has no scheme marker, and its single hash mixed
     * the question together with dispatch settings this build no longer tracks, so
     * the two cannot be told apart. Such a record is therefore trusted ONCE -- the
     * alternative is sending the user's whole library back to the model for answers
     * it already has -- and it is re-stamped as scheme 2 with the narrow
     * fingerprint on the next save, after which the strict comparison applies.
     */
    matchesCurrentConfig(storedFingerprint, config, record = null) {
      const stored = boundedStateText(storedFingerprint, 128);
      if (!stored) return false;
      const current = this.scoreConfigFingerprint(config);
      if (current && stored === current) return true;
      try {
        if (stored === this.Core.legacyRankingConfigFingerprint?.(config)) return true;
      } catch (_) {
        return false;
      }
      return Number(record?.fingerprintScheme) !== 2;
    }

    // True when a record's candidate+prompt fingerprint still matches, under the
    // current field set, the pre-0.2.8 one, or the one-time legacy trust above.
    matchesCurrentScore(record, candidate, config) {
      const stored = boundedStateText(record?.fingerprint, 128);
      if (!stored) return false;
      try {
        if (stored === this.Core.cacheFingerprint(candidate, config)) return true;
        if (stored === this.Core.legacyCacheFingerprint?.(candidate, config)) return true;
      } catch (_) {
        return false;
      }
      return Number(record?.fingerprintScheme) !== 2;
    }

    isCurrentScoreRecord(record, config = this.loadConfig()) {
      if (!record || typeof record !== "object") return false;
      const fingerprint = boundedStateText(record.fingerprint, 128);
      if (!fingerprint) return false;
      const storedConfigFingerprint = boundedStateText(record.configFingerprint, 128);
      // Compact records do not retain prompt text such as the abstract. Their
      // separately stored configuration fingerprint is therefore the only safe
      // way to determine whether the score matches the current settings.
      if (storedConfigFingerprint) return this.matchesCurrentConfig(storedConfigFingerprint, config, record);
      // Older full records did retain the prompt fields. Keep them usable while
      // they are migrated on the next state write.
      return this.matchesCurrentScore(record, record, config);
    }

    compactJournalEvidence(rawEvidence) {
      const evidence = asObject(rawEvidence);
      /*
       * Only a value that was actually supplied counts.
       *
       * `finiteNonNegativeNumber(null)` is 0, so an absent impact factor used to be
       * stored as a real 0 and the evidence was marked `available: true`. Nothing
       * displayed it (a zero row renders as blank) and a zero bonus is a zero bonus,
       * so it went unnoticed -- until the model's journal estimate needed to know
       * whether the lookup had found anything. Now "nothing was found" stays null.
       */
      const supplied = (value) => (value == null || value === "" ? null : finiteNonNegativeNumber(value));
      const impactFactor = supplied(evidence.impactFactor);
      const fiveYearImpactFactor = supplied(evidence.fiveYearImpactFactor);
      const jcrQuartile = boundedStateText(evidence.jcrQuartile, 32);
      if (impactFactor == null && fiveYearImpactFactor == null && !jcrQuartile) return null;
      return {
        source: "easyscholar",
        impactFactor,
        fiveYearImpactFactor,
        jcrQuartile,
        available: true,
      };
    }

    compactRankRecord(rawRecord, config) {
      const raw = asObject(rawRecord);
      const id = boundedStateText(raw.id, 256);
      const score = Number(raw.score);
      const fingerprint = boundedStateText(raw.fingerprint, 128);
      if (!id || !Number.isInteger(score) || score < 0 || score > 100 || !fingerprint) return null;

      const currentConfigFingerprint = this.scoreConfigFingerprint(config);
      let configFingerprint = boundedStateText(raw.configFingerprint, 128);
      if (configFingerprint && !this.matchesCurrentConfig(configFingerprint, config, raw)) {
        configFingerprint = "";
      }
      if (!configFingerprint) {
        // Older full records retained the prompt fields themselves, so their own
        // fingerprint can still be recomputed. A record from before 0.2.8 that
        // cannot be verified either way is kept (losing a score the user paid for
        // is worse than re-stamping it) and is written back as scheme 2 below, so
        // this trust is granted exactly once, not on every load.
        configFingerprint = this.matchesCurrentScore(raw, raw, config) ? currentConfigFingerprint : "";
      }
      // A scheme-2 record that cannot be shown or reused as a cache hit is already
      // stale. Do not consume limited preference storage retaining it.
      if (!configFingerprint && Number(raw.fingerprintScheme) === 2) return null;
      if (!configFingerprint) configFingerprint = currentConfigFingerprint;
      if (!configFingerprint) return null;

      const compact = {
        id,
        score,
        confidence: ["low", "medium", "high"].includes(raw.confidence) ? raw.confidence : "",
        reason: boundedStateText(raw.reason, 900),
        fingerprint,
        configFingerprint,
        // Which fingerprint scheme this record's hashes belong to. 2 means the
        // narrow, prompt-only pair above, whose mismatch is decisive. A record
        // written by an older build is stamped as 2 here, on the first save after
        // the upgrade, so the one-time legacy trust cannot be granted twice.
        fingerprintScheme: 2,
        rankedAt: boundedStateText(raw.rankedAt, 64),
      };
      const itemID = Number(raw.itemID);
      if (Number.isInteger(itemID) && itemID > 0) compact.itemID = itemID;
      const libraryID = Number(raw.libraryID);
      if (Number.isInteger(libraryID) && libraryID >= 0) compact.libraryID = libraryID;
      const textFields = [
        ["title", raw.title, 512],
        ["date", raw.date, 64],
        ["doi", raw.doi, 256],
        ["arxiv", raw.arxiv, 128],
        ["url", raw.url, 1024],
        ["source", raw.source, 240],
        ["publicationTitle", raw.publicationTitle, 240],
        ["itemType", raw.itemType, 80],
      ];
      for (const [key, value, maximumLength] of textFields) {
        const text = boundedStateText(value, maximumLength);
        if (text) compact[key] = text;
      }
      const authors = boundedStateList(raw.authors, 8, 96);
      if (authors.length) compact.authors = authors;
      const institutions = boundedStateList(
        raw.institutions?.length ? raw.institutions : raw.affiliations,
        4,
        120,
      );
      if (institutions.length) compact.institutions = institutions;
      if (raw.isArxiv === true || compact.arxiv) compact.isArxiv = true;

      // These fields are validated immediately after the Awesome GPT response
      // is parsed. Retain a bounded copy so reopening a saved result never
      // needs another model call to calculate or explain local Priority.
      const arxivSignificance = this.Core.normalizeArxivSignificance?.(raw.arxivSignificance);
      if (compact.isArxiv && arxivSignificance != null) {
        compact.arxivSignificance = arxivSignificance;
        const arxivSignificanceReason = this.Core.normalizeArxivSignificanceReason?.(
          raw.arxivSignificanceReason,
        );
        if (arxivSignificanceReason) compact.arxivSignificanceReason = arxivSignificanceReason;
      }
      // The model's journal-standing estimate, kept under the same rule: a bounded
      // value and its short reason, so reopening a result never needs another call.
      const journalSignificance = this.Core.normalizeJournalSignificance?.(raw.journalSignificance);
      if (journalSignificance != null) {
        compact.journalSignificance = journalSignificance;
        const journalSignificanceReason = this.Core.normalizeJournalSignificanceReason?.(
          raw.journalSignificanceReason,
        );
        if (journalSignificanceReason) compact.journalSignificanceReason = journalSignificanceReason;
      }

      for (const key of ["relevanceScore", "priorityScore", "journalImpactBonus", "arxivSignificanceBonus"]) {
        const value = finiteNonNegativeNumber(raw[key]);
        if (value != null && value <= 100) compact[key] = value;
      }
      const journal = this.compactJournalEvidence(
        raw.journalEvidence ?? raw.bibliometricEvidence?.journal,
      );
      if (journal) {
        compact.journalEvidence = journal;
        compact.bibliometricEvidence = { isArxiv: Boolean(compact.isArxiv), journal };
      }
      /*
       * The estimate has to survive compaction, or Priority would silently lose the
       * journal half of its bonus the next time the record is loaded: the bonus is
       * recalculated from the record on every read, not stored as a number.
       */
      if (Number.isInteger(compact.journalSignificance)) {
        compact.bibliometricEvidence = {
          ...(compact.bibliometricEvidence || { isArxiv: Boolean(compact.isArxiv) }),
          journalBonusSource: journal
            ? "verified-metrics"
            : "model-estimate",
        };
      }

      const serializedLength = () => utf8ByteLength(JSON.stringify(compact));
      // Prefer to keep identity, score, fingerprint, title, reason, and a DOI
      // or URL. Drop auxiliary display/priority inputs only for pathological
      // records that would otherwise make one preference write fail.
      const retainsModelArxivSignal = compact.isArxiv === true &&
        Number.isInteger(compact.arxivSignificance);
      for (const key of [
        "publicationTitle", "itemType", "institutions", "authors",
        "bibliometricEvidence", "journalEvidence", "arxivSignificanceReason",
        "journalSignificanceReason",
        "url", "doi", "arxiv", "source", "date",
      ]) {
        if (serializedLength() <= MAX_PERSISTED_RANK_BYTES) break;
        // Core uses a normalized arXiv identifier as the trust boundary for a
        // saved model signal. Never discard that identifier while retaining
        // the signal itself, even for an unusually CJK-heavy record.
        if (key === "arxiv" && retainsModelArxivSignal) continue;
        delete compact[key];
      }
      if (serializedLength() > MAX_PERSISTED_RANK_BYTES) {
        compact.reason = boundedStateText(compact.reason, 320);
        compact.title = boundedStateText(compact.title, 200);
      }
      if (serializedLength() > MAX_PERSISTED_RANK_BYTES) {
        compact.reason = boundedStateText(compact.reason, 120);
        compact.title = boundedStateText(compact.title, 96);
      }
      return compact;
    }

    compactRanksForState(rawRanks, config = this.loadConfig()) {
      const entries = [];
      for (const [mapKey, rawRecord] of Object.entries(asObject(rawRanks))) {
        const key = boundedStateText(mapKey, 256);
        if (!key) continue;
        const compact = this.compactRankRecord(rawRecord, config);
        if (!compact) continue;
        // The map key is the canonical Zotero library/key identity used by the
        // Score column. Never retain a malformed alternate identity from a
        // hand-edited preference value.
        compact.id = key;
        entries.push({
          key,
          record: compact,
          current: this.isCurrentScoreRecord(compact, config),
          rankedAt: Date.parse(compact.rankedAt) || 0,
        });
      }
      entries.sort((left, right) =>
        Number(right.current) - Number(left.current) ||
        right.rankedAt - left.rankedAt ||
        left.key.localeCompare(right.key),
      );

      const ranks = {};
      for (const entry of entries) {
        const recordBytes = utf8ByteLength(JSON.stringify(entry.record));
        if (recordBytes > MAX_PERSISTED_RANK_BYTES) {
          // This is not a retention cap: a single record has exceeded the
          // documented compact-record invariant. Fail explicitly rather than
          // silently losing a paper from an all-papers N-day scoring run.
          throw new Error("A FeedRank score record could not be compacted safely for persistence");
        }
        ranks[entry.key] = entry.record;
      }
      return ranks;
    }

    stateShardKey(generation, kind, index) {
      return "feedranker.state." + generation + "." + kind + "." + index;
    }

    validStateShardDescriptor(rawDescriptor) {
      const descriptor = asObject(rawDescriptor);
      const count = Number(descriptor.count);
      const contentHash = boundedStateText(descriptor.contentHash, 64);
      if (!Number.isSafeInteger(count) || count < 0 || !contentHash) return null;
      return { count, contentHash };
    }

    validStateShardStorage(rawStorage) {
      const storage = asObject(rawStorage);
      const generation = boundedStateText(storage.generation, 64);
      const ranks = this.validStateShardDescriptor(storage.ranks);
      const candidates = this.validStateShardDescriptor(storage.candidates);
      if (!/^v1-[a-z0-9]+-[a-z0-9]+$/i.test(generation) || !ranks || !candidates) return null;
      return { version: 1, generation, ranks, candidates };
    }

    stateShardGeneration() {
      const random = Math.random().toString(36).slice(2, 14) || "0";
      return "v1-" + Date.now().toString(36) + "-" + random;
    }

    stateEntriesHash(entries) {
      const serialized = JSON.stringify(entries);
      if (typeof this.Core.fnv1a === "function") return "fnv1a-v1:" + this.Core.fnv1a(serialized);
      return "length-" + utf8ByteLength(serialized);
    }

    shardStateEntries(entries) {
      const source = Array.isArray(entries) ? entries : [];
      const shards = [];
      let shard = [];
      let shardBytes = 2; // JSON array brackets
      for (const entry of source) {
        const serialized = JSON.stringify(entry);
        const entryBytes = utf8ByteLength(serialized);
        if (entryBytes > MAX_PERSISTED_RANK_SHARD_BYTES) {
          throw new Error("A FeedRank state entry is too large to persist safely");
        }
        const separatorBytes = shard.length ? 1 : 0;
        if (shard.length && shardBytes + separatorBytes + entryBytes > MAX_PERSISTED_RANK_SHARD_BYTES) {
          shards.push(shard);
          shard = [];
          shardBytes = 2;
        }
        shard.push(entry);
        shardBytes += (shard.length === 1 ? 0 : 1) + entryBytes;
      }
      if (shard.length) shards.push(shard);
      return shards;
    }

    loadStateShardEntries(kind, rawStorage) {
      const storage = this.validStateShardStorage(rawStorage);
      const descriptor = storage?.[kind];
      if (!storage || !descriptor) return null;
      const entries = [];
      try {
        for (let index = 0; index < descriptor.count; index++) {
          const raw = this.Zotero.Prefs.get(this.stateShardKey(storage.generation, kind, index));
          const shard = JSON.parse(raw || "[]");
          if (!Array.isArray(shard)) return null;
          entries.push(...shard);
        }
      } catch (_) {
        return null;
      }
      // A complete generation is only usable when its descriptor matches the
      // exact concatenated shard entries. In particular, a missing shard must
      // not be interpreted as an empty array and silently drop N-day results.
      if (this.stateEntriesHash(entries) !== descriptor.contentHash) return null;
      return entries;
    }

    persistStateGeneration(rawParts, previousStorage = null) {
      const parts = asObject(rawParts);
      const entriesByKind = {
        ranks: Array.isArray(parts.ranks) ? parts.ranks : [],
        candidates: Array.isArray(parts.candidates) ? parts.candidates : [],
      };
      const descriptors = {
        ranks: { contentHash: this.stateEntriesHash(entriesByKind.ranks) },
        candidates: { contentHash: this.stateEntriesHash(entriesByKind.candidates) },
      };
      const previous = this.validStateShardStorage(previousStorage);
      // One state-generation pointer covers ranks and candidate references.
      // Reuse it only when both payloads are unchanged; otherwise write every
      // shard in a new generation before the pointer is updated in saveState().
      if (previous &&
          previous.ranks.contentHash === descriptors.ranks.contentHash &&
          previous.candidates.contentHash === descriptors.candidates.contentHash) {
        return previous;
      }
      const generation = this.stateShardGeneration();
      // Write a complete new generation before the small main-state pointer is
      // changed. If an individual write fails, the previous generation remains
      // the active readable state and no paper is silently discarded.
      for (const kind of ["ranks", "candidates"]) {
        const shards = this.shardStateEntries(entriesByKind[kind]);
        descriptors[kind].count = shards.length;
        for (let index = 0; index < shards.length; index++) {
          this.Zotero.Prefs.set(
            this.stateShardKey(generation, kind, index),
            JSON.stringify(shards[index]),
          );
        }
      }
      return { version: 1, generation, ...descriptors };
    }

    clearStateGeneration(rawStorage) {
      const storage = this.validStateShardStorage(rawStorage);
      if (!storage) return;
      // This runs only after the primary pointer has committed a different
      // complete generation. Clear exact old FeedRank keys best-effort: a
      // cleanup failure leaves recoverable stale data, never the active run.
      for (const kind of ["ranks", "candidates"]) {
        const count = storage[kind]?.count || 0;
        for (let index = 0; index < count; index++) {
          const key = this.stateShardKey(storage.generation, kind, index);
          try {
            if (typeof this.Zotero.Prefs?.clear === "function") {
              this.Zotero.Prefs.clear(key);
            } else {
              this.Services.prefs?.clearUserPref?.("extensions.zotero." + key);
            }
          } catch (_) {}
        }
      }
    }

    loadPersistedRanks(rawStorage) {
      const entries = this.loadStateShardEntries("ranks", rawStorage);
      if (entries == null) return null;
      const ranks = {};
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const key = boundedStateText(entry[0], 256);
        const record = asObject(entry[1]);
        if (key && boundedStateText(record.id, 256) === key) ranks[key] = record;
      }
      return ranks;
    }

    compactLastCandidatesForState(rawCandidates) {
      const candidates = Array.isArray(rawCandidates) ? rawCandidates : [];
      const references = [];
      const seen = new Set();
      for (const rawCandidate of candidates) {
        const reference = this.candidateReferenceForState(rawCandidate);
        if (!reference) {
          // All candidates produced by FeedRank's own collectors have a
          // Zotero item ID and library/key identity. Refuse an unpersistable
          // item rather than silently losing it from an all-papers rerun.
          throw new Error("A FeedRank rerun item could not be compacted safely for persistence");
        }
        if (seen.has(reference.id)) continue;
        seen.add(reference.id);
        references.push(reference);
      }
      return references;
    }

    restoreLastCandidatesFromState(entries) {
      const restored = [];
      const seen = new Set();
      for (const rawEntry of (Array.isArray(entries) ? entries : [])) {
        const reference = this.candidateReferenceForState(rawEntry);
        if (!reference || seen.has(reference.id)) continue;
        seen.add(reference.id);
        restored.push(reference);
      }
      return restored;
    }

    candidateReferenceForState(rawCandidate) {
      const candidate = asObject(rawCandidate);
      const itemID = Number(candidate.itemID);
      const libraryID = Number(candidate.libraryID);
      const id = boundedStateText(candidate.id, 256);
      const source = boundedStateText(candidate.source, 512) || "Unnamed feed";
      const prefix = Number.isSafeInteger(libraryID) ? String(libraryID) + ":" : "";
      if (!Number.isSafeInteger(itemID) || itemID <= 0 ||
          !Number.isSafeInteger(libraryID) || libraryID < 0 ||
          !id || !prefix || !id.startsWith(prefix) || id.length <= prefix.length) {
        return null;
      }
      return {
        reference: "zotero-item-v1",
        id,
        itemID,
        libraryID,
        source,
      };
    }

    isCandidateReference(value) {
      return asObject(value).reference === "zotero-item-v1";
    }

    isLegacyStoredCandidate(value) {
      const candidate = asObject(value);
      return !this.isCandidateReference(candidate) &&
        Boolean(boundedStateText(candidate.id, 256)) &&
        Boolean(boundedStateText(candidate.title, 2000));
    }

    async itemForRerunReference(reference) {
      const itemID = Number(reference?.itemID);
      if (!Number.isSafeInteger(itemID) || itemID <= 0) return null;
      let item = null;
      try {
        const loaded = this.Zotero.Items?.get?.(itemID);
        item = loaded && typeof loaded.then === "function" ? await loaded : loaded;
      } catch (_) {}
      if (!item && typeof this.Zotero.Items?.getAsync === "function") {
        try {
          const loaded = await this.Zotero.Items.getAsync(itemID);
          item = Array.isArray(loaded) ? loaded[0] : loaded;
        } catch (_) {}
      }
      if (!this.isRankableItem(item)) return null;
      const liveID = String(item.libraryID) + ":" + this.Core.text(item.key);
      return liveID === reference.id && Number(item.libraryID) === Number(reference.libraryID)
        ? item
        : null;
    }

    async rehydrateLastCandidates(rawCandidates, workflow, progress = null) {
      const candidates = [];
      let unavailableCount = 0;
      const sourceCandidates = Array.isArray(rawCandidates) ? rawCandidates : [];
      const total = Math.max(1, sourceCandidates.length);
      for (let index = 0; index < sourceCandidates.length; index++) {
        const rawCandidate = sourceCandidates[index];
        this.throwIfCancelled(workflow, progress);
        progress?.update?.(
          "Loading recent FeedRank article " + (index + 1) + " of " + sourceCandidates.length + "…",
          index,
          total,
        );
        const reference = this.candidateReferenceForState(rawCandidate);
        const wasReference = this.isCandidateReference(rawCandidate);
        let item = null;
        if (reference) item = await this.itemForRerunReference(reference);
        this.throwIfCancelled(workflow, progress);
        if (item) {
          try {
            candidates.push(this.toCandidate(item, { name: reference.source }));
            continue;
          } catch (error) {
            this.logError(error);
          }
        }
        // Values written by releases before rerun references contained a full
        // candidate. Keep those old saved runs usable when an item is no
        // longer loaded or was removed, but never use a reference as a stale
        // article payload.
        if (!wasReference && this.isLegacyStoredCandidate(rawCandidate)) {
          candidates.push(cloneJSON(rawCandidate));
        } else {
          unavailableCount++;
        }
      }
      const deduplicated = this.Core.deduplicateCandidates(candidates);
      progress?.update?.(
        "Loaded " + deduplicated.candidates.length + " available FeedRank " +
          (deduplicated.candidates.length === 1 ? "article." : "articles."),
        sourceCandidates.length,
        total,
      );
      return {
        candidates: deduplicated.candidates,
        unavailableCount,
      };
    }

    compactUsageCall(rawUsage) {
      const raw = asObject(rawUsage);
      const compact = {
        inputTokens: boundedStateCount(raw.inputTokens),
        outputTokens: boundedStateCount(raw.outputTokens),
        totalTokens: boundedStateCount(raw.totalTokens),
        cacheReadTokens: boundedStateCount(raw.cacheReadTokens),
        cacheCreationTokens: boundedStateCount(raw.cacheCreationTokens),
        source: ["actual", "estimated", "mixed", "unknown"].includes(raw.source)
          ? raw.source
          : "estimated",
      };
      for (const key of ["batchNumber", "batchTotal", "attempt"]) {
        const value = boundedStateCount(raw[key], MAX_PERSISTED_COUNT);
        if (value) compact[key] = value;
      }
      if (raw.usageUnknown === true || compact.source === "unknown") compact.usageUnknown = true;
      return compact;
    }

    compactUsageTotal(rawUsage) {
      if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) return null;
      const compact = this.compactUsageCall(rawUsage);
      delete compact.batchNumber;
      delete compact.batchTotal;
      delete compact.attempt;
      const unknownCalls = boundedStateCount(rawUsage.unknownCalls);
      if (unknownCalls) compact.unknownCalls = unknownCalls;
      return compact;
    }

    compactUsageState(rawCalls, rawTotal, rawCallCount) {
      const calls = (Array.isArray(rawCalls) ? rawCalls : []).map((call) => this.compactUsageCall(call));
      const storedTotal = this.compactUsageTotal(rawTotal);
      const storedCount = boundedStateCount(rawCallCount);
      // Later email-state mutations load only the bounded sample. Preserve a
      // previously computed full-run aggregate instead of recomputing it from
      // that sample and silently shrinking a historic cost total.
      const preservesFullAggregate = Boolean(storedTotal && storedCount > calls.length);
      const total = preservesFullAggregate
        ? storedTotal
        : this.compactUsageTotal(this.Core.aggregateUsage(calls)) || this.compactUsageCall({});
      const callCount = preservesFullAggregate ? storedCount : calls.length;
      const retainedCalls = calls.length > MAX_PERSISTED_USAGE_CALLS
        ? calls.slice(-MAX_PERSISTED_USAGE_CALLS)
        : calls;
      return {
        calls: retainedCalls,
        total,
        callCount,
        historyTruncated: callCount > retainedCalls.length,
      };
    }

    compactRefreshForState(rawRefresh) {
      const raw = asObject(rawRefresh);
      const compact = {};
      const kind = boundedStateText(raw.kind, 64);
      const startedAt = boundedStateText(raw.startedAt, 64);
      if (kind) compact.kind = kind;
      if (startedAt) compact.startedAt = startedAt;
      for (const key of [
        "totalFeeds", "newItemCount", "duplicateCount", "limitedCount",
        "selectedItemCount", "rankableItemCount", "candidateCount", "scannedItemCount",
        "undatedItemCount", "outsideWindowItemCount", "lookbackDays",
        "fallbackLookbackDays", "fallbackScannedItemCount", "fallbackRecentItemCount",
        "fallbackCurrentScoreCount", "fallbackCandidateCount", "fallbackDuplicateCount",
        "settleRounds", "settledItemCount",
      ]) {
        if (raw[key] == null) continue;
        compact[key] = boundedStateCount(
          raw[key],
          key === "lookbackDays" || key === "fallbackLookbackDays" ? 365 : MAX_PERSISTED_COUNT,
        );
      }
      for (const key of ["lookbackStartDate", "lookbackEndDate"]) {
        const value = this.Core.text(raw[key]);
        if (/^\d{4}-\d{2}-\d{2}$/.test(value)) compact[key] = value;
      }
      if (raw.fallbackUsed === true) compact.fallbackUsed = true;
      if (raw.recoveredForRescore === true) compact.recoveredForRescore = true;
      const candidateSource = boundedStateText(raw.candidateSource, 64);
      if (candidateSource) compact.candidateSource = candidateSource;
      const compactFeedList = (key, countKey, includeMessage) => {
        const entries = Array.isArray(raw[key]) ? raw[key] : [];
        const count = Math.max(boundedStateCount(raw[countKey]), entries.length);
        compact[countKey] = count;
        compact[key] = entries.slice(0, MAX_PERSISTED_REFRESH_FEEDS).map((entry) => {
          const source = asObject(entry);
          const result = { name: boundedStateText(source.name, MAX_PERSISTED_REFRESH_TEXT) || "Unnamed feed" };
          for (const field of ["itemCount", "matchingItems", "newItems"]) {
            if (source[field] != null) result[field] = boundedStateCount(source[field]);
          }
          if (includeMessage) {
            const message = boundedStateText(source.message, MAX_PERSISTED_REFRESH_TEXT);
            if (message) result.message = message;
          }
          return result;
        });
      };
      compactFeedList("successfulFeeds", "successfulFeedCount", false);
      compactFeedList("failedFeeds", "failedFeedCount", true);
      const scope = asObject(raw.scope);
      if (Object.keys(scope).length) {
        const libraryIDs = (Array.isArray(scope.libraryIDs) ? scope.libraryIDs : [])
          .map((value) => Number(value))
          .filter((value) => Number.isSafeInteger(value) && value >= 0);
        compact.scope = {
          kind: ["all", "feeds"].includes(scope.kind) ? scope.kind : "all",
          label: boundedStateText(scope.label, MAX_PERSISTED_REFRESH_TEXT),
          libraryIDCount: Math.max(boundedStateCount(scope.libraryIDCount), libraryIDs.length),
          libraryIDs: libraryIDs.slice(0, MAX_PERSISTED_SCOPE_LIBRARY_IDS),
        };
      }
      return compact;
    }

    loadState() {
      let parsed = {};
      try {
        parsed = asObject(JSON.parse(this.readPluginPreference(
          PREF_STATE,
          LEGACY_PREF_STATE,
          BROKEN_PREF_STATE,
        ) || "{}"));
      } catch (_) {
        parsed = {};
      }
      const rawStateStorage = asObject(parsed.stateStorage);
      const declaresStateStorage = Object.keys(rawStateStorage).length > 0;
      const stateStorage = this.validStateShardStorage(rawStateStorage);
      const shardedRanks = stateStorage ? this.loadPersistedRanks(stateStorage) : null;
      const candidateEntries = stateStorage
        ? this.loadStateShardEntries("candidates", stateStorage)
        : null;
      const stateIntegrityError = declaresStateStorage && (!stateStorage ||
        shardedRanks == null || candidateEntries == null)
        ? "FeedRank saved-state integrity check failed. Existing scored results were preserved and will not be overwritten; rerun after restoring or clearing the affected FeedRank state."
        : "";
      const usage = this.compactUsageState(
        parsed.lastUsageCalls,
        parsed.lastUsageTotal,
        parsed.lastUsageCallCount,
      );
      return {
        schema: 3,
        // The anchor day of the last completed scheduled run. `dailyPromptDate`
        // is the 0.2.6 name; its week anchor is carried over so upgrading does
        // not repeat a run that already happened this week.
        weeklyPromptWeek: typeof parsed.weeklyPromptWeek === "string"
          ? parsed.weeklyPromptWeek
          : weekAnchorForDayString(parsed.dailyPromptDate),
        ranks: stateIntegrityError ? {} : shardedRanks == null ? asObject(parsed.ranks) : shardedRanks,
        lastCandidates: stateIntegrityError
          ? []
          : candidateEntries == null
            ? (Array.isArray(parsed.lastCandidates) ? parsed.lastCandidates : [])
            : this.restoreLastCandidatesFromState(candidateEntries),
        stateStorage: stateStorage || {},
        stateIntegrityError,
        lastRefresh: this.compactRefreshForState(parsed.lastRefresh),
        lastUsageCalls: usage.calls,
        lastUsageTotal: usage.total,
        lastUsageCallCount: usage.callCount,
        lastUsageHistoryTruncated: usage.historyTruncated,
        // Delivery payloads are deliberately separate from scoring data. They
        // contain no API key; a FeedRank email service validates and bounds
        // them before persistence so an exact submission can be retried with
        // the same idempotency key after a known provider failure.
        /*
         * The schedule's own log has to be LOADED, not merely saved.
         *
         * `saveState` persists whatever the state object holds, but this function
         * rebuilds the state from a fixed list of keys -- and `weeklyLog` was not
         * on it. The effect was that every single line overwrote the previous one
         * instead of being appended: the log could only ever hold the most recent
         * event, so "what happened at the scheduled time" was unanswerable exactly
         * when it mattered.
         */
        weeklyLog: (Array.isArray(parsed.weeklyLog) ? parsed.weeklyLog : [])
          .filter((line) => typeof line === "string" && line)
          .map((line) => line.slice(0, 400))
          .slice(-20),
        emailDelivery: asObject(parsed.emailDelivery),
        emailSubmissions: asObject(parsed.emailSubmissions),
        // Cached EasyScholar journal metrics, keyed by normalized publication
        // name. This holds only displayed metrics — never the secret key, which
        // lives exclusively in the journal service's Login Manager entry.
        journalCache: asObject(parsed.journalCache),
      };
    }

    saveState(state) {
      if (this.Core.text(state?.stateIntegrityError)) {
        throw new Error(this.Core.text(state.stateIntegrityError));
      }
      const config = this.loadConfig();
      const previousStorage = this.validStateShardStorage(state.stateStorage);
      state.ranks = this.compactRanksForState(asObject(state.ranks), config);
      state.lastCandidates = this.compactLastCandidatesForState(state.lastCandidates);
      state.stateStorage = this.persistStateGeneration({
        ranks: Object.entries(state.ranks),
        candidates: state.lastCandidates,
      }, state.stateStorage);
      state.lastRefresh = this.compactRefreshForState(state.lastRefresh);
      const usage = this.compactUsageState(
        state.lastUsageCalls,
        state.lastUsageTotal,
        state.lastUsageCallCount,
      );
      state.lastUsageCalls = usage.calls;
      state.lastUsageTotal = usage.total;
      state.lastUsageCallCount = usage.callCount;
      state.lastUsageHistoryTruncated = usage.historyTruncated;
      state.emailDelivery = asObject(state.emailDelivery);
      state.emailSubmissions = asObject(state.emailSubmissions);
      state.journalCache = asObject(state.journalCache);
      // Bounded here as well, so no caller can grow the persisted log without
      // limit even if it never goes through weeklyLog().
      state.weeklyLog = (Array.isArray(state.weeklyLog) ? state.weeklyLog : [])
        .filter((line) => typeof line === "string" && line)
        .map((line) => line.slice(0, 400))
        .slice(-20);
      // Only the atomic generation pointer is held in the primary state
      // preference. Both rank records and rerun references were completely
      // written before this pointer moves, so an interrupted save cannot
      // produce a partly retained N-day scoring run.
      const persistedState = {
        ...state,
        ranks: {},
        lastCandidates: [],
      };
      delete persistedState.stateIntegrityError;
      this.Zotero.Prefs.set(PREF_STATE, JSON.stringify(persistedState));
      if (previousStorage && previousStorage.generation !== state.stateStorage.generation) {
        this.clearStateGeneration(previousStorage);
      }
      this.rankLookup = null;
    }

    mutateState(mutator) {
      if (typeof mutator !== "function") {
        return Promise.reject(new Error("FeedRank state mutator must be a function"));
      }
      const run = async () => {
        const state = this.loadState();
        const result = await mutator(state);
        const nextState = result === undefined ? state : result;
        this.saveState(nextState);
        return cloneJSON(nextState);
      };
      // Keep the tail settled so one failed persistence attempt does not
      // permanently prevent a later explicit action from saving its state.
      const operation = this.stateMutationQueue.then(run, run);
      this.stateMutationQueue = operation.catch(() => {});
      return operation;
    }

    retainLatestCandidateSnapshot(state, summary) {
      const candidates = Array.isArray(summary?.candidates) ? summary.candidates : [];
      // `Rescore latest` must always refer to a complete, matching candidate
      // snapshot and refresh summary. An empty refresh is useful status, but
      // it is not a new rerun target and must never erase the last one.
      if (!candidates.length) return state;
      state.lastCandidates = cloneJSON(candidates);
      state.lastRefresh = cloneJSON(asObject(summary?.refresh));
      return state;
    }

    refreshRankColumn() {
      try {
        this.Zotero.ItemTreeManager?.refreshColumns?.();
      } catch (error) {
        this.logError(error);
      }
    }

    async refreshScoreDetailsPane() {
      const refreshersByBody = this.scoreDetailsRefreshers;
      if (this.shuttingDown || !(refreshersByBody instanceof Map) || !refreshersByBody.size) return;
      // The API intentionally exposes refresh only from each section's
      // onInit hook. A section can be destroyed while a scoring workflow is
      // completing, so a failed individual refresh is harmless.
      const refreshers = [...refreshersByBody.values()].filter((refresh) => typeof refresh === "function");
      await Promise.all(refreshers.map(async (refresh) => {
        try {
          await refresh();
        } catch (error) {
          if (!this.shuttingDown) this.logError(error);
        }
      }));
    }

    matchingRankLookup() {
      if (this.rankLookup) return this.rankLookup;
      const config = this.loadConfig();
      const records = this.loadState().ranks;
      const lookup = Object.create(null);
      for (const [id, record] of Object.entries(records)) {
        const score = Number(record?.score);
        if (!Number.isInteger(score) || score < 0 || score > 100) continue;
        if (!this.isCurrentScoreRecord(record, config)) continue;
        // Keep the whole record so scoreColumnData() can reject a cached
        // value if the currently loaded Zotero metadata has changed.
        lookup[id] = record;
      }
      this.rankLookup = lookup;
      return lookup;
    }

    matchingScoreRecord(item) {
      const libraryID = item?.libraryID;
      const key = this.Core.text(item?.key);
      if (libraryID == null || !key) return null;
      const record = this.loadState().ranks[String(libraryID) + ":" + key];
      const score = Number(record?.score);
      if (!Number.isInteger(score) || score < 0 || score > 100) return null;
      try {
        const config = this.loadConfig();
        return this.isCurrentScoreRecord(record, config)
          ? this.withLocalPriority(record, config, item)
          : null;
      } catch (_) {
        return null;
      }
    }

    currentItemForRecord(record) {
      const itemID = Number(record?.itemID);
      if (!Number.isInteger(itemID) || itemID <= 0) return null;
      try {
        const item = this.Zotero.Items?.get?.(itemID);
        // Zotero.Items.get() is synchronous for loaded items. Do not turn a
        // result-window rendering pass into a metadata load or network task.
        if (!item || typeof item.then === "function" || !this.isRankableItem(item)) return null;
        const expectedID = String(item.libraryID) + ":" + this.Core.text(item.key);
        return expectedID === String(record.id) ? item : null;
      } catch (_) {
        return null;
      }
    }

    liveCandidateMatchesScoreRecord(record, liveCandidate, config) {
      const fingerprint = boundedStateText(record?.fingerprint, 128);
      // Some legacy/test records deliberately lack a full fingerprint. Do not
      // make those records unusable solely because that older representation
      // cannot be compared; current records always have one.
      if (!fingerprint) return true;
      // Accepts the pre-0.2.8 field set as well, so a cached score survives the
      // upgrade instead of being rejected as stale.
      return this.matchesCurrentScore(record, liveCandidate, config);
    }

    withLocalPriority(record, config = this.loadConfig(), currentItem = null) {
      if (!record || typeof record !== "object") return record;
      let candidate = record;
      const item = currentItem || this.currentItemForRecord(record);
      if (item) {
        // Refresh only local evidence from the item as it exists now. This lets
        // a journal lookup performed after scoring appear without sending
        // another Awesome GPT request or writing anything back to Zotero.
        const liveCandidate = this.toCandidate(item, { name: record.source });
        // The model's optional arXiv signal belongs only to the exact metadata
        // it was scored with. A loaded item whose prompt fingerprint changed
        // is stale and must be rescored rather than inheriting that signal.
        if (!this.liveCandidateMatchesScoreRecord(record, liveCandidate, config)) return null;
        candidate = {
          ...record,
          authors: liveCandidate.authors,
          institutions: liveCandidate.institutions,
          affiliations: liveCandidate.affiliations,
          institution: liveCandidate.institution,
          arxiv: liveCandidate.arxiv || record.arxiv,
          isArxiv: liveCandidate.isArxiv,
          journalEvidence: liveCandidate.journalEvidence,
        };
      }
      const priority = this.Core.calculateLocalPriority({
        score: record.score,
        candidate,
        journalEvidence: candidate.journalEvidence ?? record?.bibliometricEvidence?.journal,
        config,
      });
      return { ...candidate, ...priority };
    }

    scoreColumnData(item) {
      const libraryID = item?.libraryID;
      const key = this.Core.text(item?.key);
      if (libraryID == null || !key) return SCORE_COLUMN_UNSCORED_VALUE;
      const record = this.matchingRankLookup()[String(libraryID) + ":" + key];
      const current = record ? this.withLocalPriority(record, this.loadConfig(), item) : null;
      // The main panel leads with Priority, not relevance: Priority is the
      // number that already folds in every local signal the user has configured,
      // so it is the one worth sorting a library by. Relevance and the component
      // breakdown stay in the results window and the item pane.
      const priority = Number(current?.priorityScore);
      if (!Number.isFinite(priority)) return SCORE_COLUMN_UNSCORED_VALUE;
      const score = Math.max(0, Math.min(100, Math.round(priority)));
      // ItemTree custom-column sorting is lexical. The prefix and fixed width
      // keep scores numerical while the renderer below shows just 0–100.
      return "1" + String(score).padStart(3, "0");
    }

    formatScoreColumnData(data) {
      const value = String(data || "");
      if (/^1\d{3}$/.test(value)) return String(Number(value.slice(1)));
      return "—";
    }

    scoreDetailText(value, maximumLength = 4000) {
      if (value == null) return "";
      if (typeof value === "number") {
        if (!Number.isFinite(value)) return "";
        if (Number.isInteger(value)) return String(value);
        return String(Math.round(value * 1000) / 1000);
      }
      if (typeof value === "boolean") return value ? "Yes" : "No";
      if (typeof value === "string") return value.replace(/\u0000/g, "").trim().slice(0, maximumLength);
      try {
        return JSON.stringify(value).slice(0, maximumLength);
      } catch (_) {
        return "";
      }
    }

    scoreDetailLabel(value) {
      return this.Core.text(value)
        .replace(/([a-z\d])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (character) => character.toUpperCase());
    }

    scoreComponentEntries(record) {
      const entries = [];
      const seen = new Set();
      const add = (label, value) => {
        const text = this.scoreDetailText(value, 1000);
        const cleanLabel = this.scoreDetailLabel(label);
        if (!cleanLabel || !text) return;
        const dedupeKey = cleanLabel.toLowerCase() + "\u0000" + text;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        entries.push([cleanLabel, text]);
      };
      const addContainer = (container) => {
        if (Array.isArray(container)) {
          container.forEach((entry, index) => {
            if (entry && typeof entry === "object" && !Array.isArray(entry)) {
              const label = entry.label || entry.name || entry.key || entry.component || ("Component " + (index + 1));
              const value = entry.value ?? entry.score ?? entry.weight ?? entry.adjustment ?? entry.amount;
              add(label, value == null ? entry : value);
            } else {
              add(this.t("item.component", { index: index + 1 }), entry);
            }
          });
          return;
        }
        if (container && typeof container === "object") {
          for (const [label, rawValue] of Object.entries(container)) {
            if (label === "score" || label === "total" || label === "finalScore") continue;
            if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
              const value = rawValue.value ?? rawValue.score ?? rawValue.weight ?? rawValue.adjustment ?? rawValue.amount;
              add(label, value == null ? rawValue : value);
            } else {
              add(label, rawValue);
            }
          }
        }
      };

      // Accept several practical future result shapes without making today's
      // simple score/confidence/reason response look incomplete.
      for (const key of ["scoreComponents", "components", "componentScores", "scoreWeights", "weights", "adjustments"]) {
        addContainer(record?.[key]);
      }
      add(this.t("item.relevanceScore"), record?.relevanceScore ?? record?.baseScore ?? record?.relevance);
      add(this.t("item.priorityScore"), record?.priorityScore);
      // A paper carries at most one bibliometric signal: a journal article gets
      // an impact-factor adjustment, an arXiv preprint gets the model's
      // qualitative-significance adjustment. These were previously two separate
      // rows, so whichever did not apply always showed a meaningless "0".
      // Report the one value actually in use, under a single label.
      const significanceAdjustment =
        record?.arxivSignificanceBonus ?? record?.significanceWeight ??
        record?.significanceScore ?? record?.arxivSignificanceWeight;
      const journalAdjustment =
        record?.journalImpactBonus ?? record?.journalImpactWeight ??
        record?.impactFactorWeight ?? record?.journalWeight;
      const appliedAdjustment = record?.bibliometricEvidence?.isArxiv === true
        ? significanceAdjustment
        : journalAdjustment ?? significanceAdjustment;
      if (appliedAdjustment != null) {
        add("Bibliometric adjustment", appliedAdjustment);
      }
      add("Institutional adjustment", record?.institutionWeight ?? record?.universityWeight ?? record?.affiliationWeight);
      add("Author H-index adjustment", record?.authorHIndexWeight ?? record?.hIndexWeight ?? record?.authorWeight);
      return entries;
    }

    bibliometricEvidenceEntries(record) {
      const evidence = record?.bibliometricEvidence;
      if (evidence == null || evidence === "") return [];
      const entries = [];
      const add = (label, value) => {
        const text = this.scoreDetailText(value, 1000);
        const cleanLabel = this.scoreDetailLabel(label);
        if (cleanLabel && text) entries.push([cleanLabel, text]);
      };
      // Current FeedRank evidence has a deliberately explicit shape. Render
      // it as readable fields rather than an opaque JSON object, while the
      // generic walker below keeps this section forward-compatible.
      const journal = evidence?.journal;
      if (journal && typeof journal === "object") {
        const source = journal.source === "easyscholar"
          ? "EasyScholar" + (journal.retrievedAt
            ? " (retrieved " + new Date(journal.retrievedAt).toLocaleDateString() + ")"
            : "")
          : journal.source;
        add(this.t("item.journalSource"), source);
        if (journal.journalName) add(this.t("item.journalMatched"), journal.journalName);
        add(this.t("item.impactFactor"), journal.impactFactor);
        add(this.t("item.impactFactor5"), journal.fiveYearImpactFactor);
        add(this.t("item.jcrQuartile"), journal.jcrQuartile);
        // Any further EasyScholar systems the user has enabled, such as the CAS
        // zone, JCI, or ESI subject, in the order the API returned them.
        for (const metric of Array.isArray(journal.metrics) ? journal.metrics : []) {
          if (["sciif", "sciif5", "sci"].includes(metric?.key)) continue;
          add(metric.label || metric.key, metric.value);
        }
        if (journal.available) {
          add(this.t("item.impactNote"), this.t("item.impactNote"));
        }
      }
      /*
       * The model's own estimate, shown when -- and only when -- the lookup found
       * nothing for the venue. It is labelled as an estimate in the row itself, and
       * says which half of Priority it fed, so a number the model guessed can never
       * be mistaken for a retrieved impact factor.
       */
      const estimate = evidence?.journalEstimate;
      if (estimate && estimate.available === true) {
        const standing = Number(estimate.journalSignificance);
        add(this.t("item.journalSource"), this.t("item.estimateSource"));
        if (Number.isInteger(standing) && standing >= 0 && standing <= 100) {
          add(this.t("item.estimateStanding"), standing + " / 100");
        }
        add(this.t("item.estimateRationale"), estimate.journalSignificanceReason);
        add("Estimate note", "Model estimate, not a retrieved metric; it feeds the journal half of Priority only");
      } else if (evidence?.journalBonusSource === "model-estimate") {
        // The stored record carries only the value, not the rebuilt evidence object.
        const standing = Number(record?.journalSignificance);
        add(this.t("item.journalSource"), this.t("item.estimateSource"));
        if (Number.isInteger(standing) && standing >= 0 && standing <= 100) {
          add(this.t("item.estimateStanding"), standing + " / 100");
        }
        add(this.t("item.estimateRationale"), record?.journalSignificanceReason);
        add("Estimate note", "Model estimate, not a retrieved metric; it feeds the journal half of Priority only");
      }
      const arxiv = evidence?.arxiv;
      if (arxiv && typeof arxiv === "object") {
        const usesModelSignificance = arxiv.usesModelSignificance === true ||
          arxiv.source === "model-supplied-arxiv-metadata";
        add("arXiv signal source", usesModelSignificance
          ? "Awesome GPT qualitative signal from supplied item metadata only"
          : arxiv.source === "user-entered-keyword-signals"
            ? "User-entered offline keyword fallback (no external lookup)"
            : arxiv.source);
        if (usesModelSignificance) {
          const significance = Number(arxiv.arxivSignificance);
          if (Number.isInteger(significance) && significance >= 0 && significance <= 100) {
            add("Qualitative arXiv significance", significance + " / 100");
          }
          add("Qualitative rationale", arxiv.arxivSignificanceReason);
        } else {
          add("Highest offline signal tier", arxiv.highestTier);
        }
        const fallback = usesModelSignificance && arxiv.offlineKeywordFallback &&
          typeof arxiv.offlineKeywordFallback === "object"
          ? arxiv.offlineKeywordFallback
          : arxiv;
        const matches = Array.isArray(fallback.matchedSignals) ? fallback.matchedSignals : [];
        if (matches.length) {
          const labels = matches.map((match) => {
            const kinds = (match?.matches || []).map((entry) => entry?.kind).filter(Boolean);
            return "Tier " + this.scoreDetailText(match?.tier) + ": " +
              this.scoreDetailText(match?.keyword) + (kinds.length ? " (" + kinds.join(", ") + ")" : "");
          }).filter(Boolean);
          add(usesModelSignificance ? "Offline fallback matches (not applied)" : "Matched offline signals", labels.join("; "));
        }
      }
      if (entries.length) return entries;
      const walk = (value, label = "Evidence", depth = 0) => {
        if (value == null) return;
        if (Array.isArray(value)) {
          if (value.every((entry) => entry == null || typeof entry !== "object")) {
            add(label, value.filter((entry) => entry != null).join(", "));
          } else if (depth < 1) {
            value.forEach((entry, index) => walk(entry, label + " " + (index + 1), depth + 1));
          } else {
            add(label, value);
          }
          return;
        }
        if (typeof value === "object") {
          if (depth < 1) {
            for (const [key, nestedValue] of Object.entries(value)) {
              walk(nestedValue, key, depth + 1);
            }
          } else {
            add(label, value);
          }
          return;
        }
        add(label, value);
      };
      walk(evidence);
      return entries;
    }

    scoreProvenanceEntries(record) {
      const entries = [];
      const add = (label, value) => {
        const text = this.scoreDetailText(value, 1000);
        if (text) entries.push([label, text]);
      };
      add(this.t("item.feed"), record?.source);
      add(this.t("item.scoredAt"), record?.rankedAt);
      add(this.t("item.provider"), record?.provider ?? record?.modelProvider);
      add(this.t("item.model"), record?.model ?? record?.modelName ?? record?.modelID);
      add(this.t("item.promptVersion"), record?.promptVersion ?? record?.rankingVersion ?? record?.scoringVersion);
      const provenance = record?.provenance;
      if (typeof provenance === "string") {
        add("Provenance", provenance);
      } else if (provenance && typeof provenance === "object" && !Array.isArray(provenance)) {
        for (const [label, value] of Object.entries(provenance)) {
          add("Provenance: " + this.scoreDetailLabel(label), value);
        }
      }
      return entries;
    }

    appendScoreDetailHeading(document, container, label) {
      const heading = document.createElement("div");
      heading.textContent = label;
      heading.style.cssText = "font-weight: 600; margin-top: 8px;";
      container.appendChild(heading);
    }

    appendScoreDetailRow(document, container, label, value, { multiline = false } = {}) {
      const text = this.scoreDetailText(value);
      if (!text) return;
      const row = document.createElement("div");
      row.style.cssText = "display: grid; grid-template-columns: minmax(105px, 36%) minmax(0, 1fr); gap: 8px; align-items: start;";
      const name = document.createElement("div");
      name.textContent = label;
      name.style.cssText = "font-weight: 600; opacity: .8;";
      const content = document.createElement("div");
      content.textContent = text;
      // `overflow-wrap: break-word`, NOT `anywhere`. With `anywhere` the browser
      // treats every character as a break opportunity when it computes the grid's
      // minimum width, so the value column can collapse and a short word is split
      // down the middle -- which is how "arXiv" was rendering as "ar" / "Xiv" in
      // this pane. `break-word` only breaks a word that cannot fit on a line of its
      // own, which is what a long unbroken URL needs and what an ordinary word
      // never does.
      content.style.cssText = multiline
        ? "white-space: pre-wrap; overflow-wrap: break-word; word-break: normal;"
        : "overflow-wrap: break-word; word-break: normal;";
      row.append(name, content);
      container.appendChild(row);
    }

    /*
     * Journal evidence for an item's pane even when the item has never been
     * scored. "Update journal info" resolves and caches metrics for any item with
     * a publication title, and writes them to Extra; without this the pane said
     * only "Not scored" and the resolved IF/JCR were visible nowhere except the
     * item's own Extra field. The evidence comes from the same cache the scoring
     * path reads, keyed the same way, so the two can never disagree.
     */
    unscoredJournalRecord(item) {
      let publicationTitle = "";
      try {
        publicationTitle = item?.getField?.("publicationTitle") || "";
      } catch (_) {
        return null;
      }
      const journal = this.journalEvidenceForPublication(publicationTitle);
      if (journal?.available !== true) return null;
      return { bibliometricEvidence: { journal } };
    }

    renderScoreDetailsPane(body, item, setSectionSummary) {
      if (!body?.ownerDocument) return;
      const document = body.ownerDocument;
      body.replaceChildren();
      const container = document.createElement("div");
      container.className = "feed-ranker-score-details";
      container.style.cssText = "display: grid; gap: 6px; padding: 2px 0 6px;";
      const record = this.matchingScoreRecord(item);
      // A run in progress is shown first, in the section that is on screen by
      // default: the settings pane is not where anyone is looking while Zotero
      // refreshes a hundred feeds.
      if (this.runState?.active) {
        const running = document.createElement("div");
        running.textContent = "FeedRank is running: " + (this.Core.text(this.runState.stage) || "working") + "…";
        running.style.cssText = "opacity: .8; font-style: italic;";
        container.appendChild(running);
      }
      if (!record) {
        // A cached journal lookup is real information about this item and must be
        // shown where the rest of the item's FeedRank information lives. Scoring
        // is what turns it into a Priority, but the retrieval itself is useful
        // immediately.
        const journalOnly = this.unscoredJournalRecord(item);
        if (journalOnly) {
          setSectionSummary?.(this.t("item.notScoredJournal"));
          const message = document.createElement("div");
          message.textContent =
            "No FeedRank score matching the current settings is cached for this item. " +
            "Journal information retrieved from EasyScholar is shown below.";
          message.style.cssText = "opacity: .8;";
          container.appendChild(message);
          this.appendScoreDetailHeading(document, container, this.t("item.headingBibliometric"));
          for (const [label, value] of this.bibliometricEvidenceEntries(journalOnly)) {
            this.appendScoreDetailRow(document, container, label, value);
          }
          body.appendChild(container);
          return;
        }
        setSectionSummary?.(this.t("item.notScored"));
        const message = document.createElement("div");
        message.textContent = this.t("item.notScoredBody");
        message.style.cssText = "opacity: .8;";
        container.appendChild(message);
        body.appendChild(container);
        return;
      }

      const score = Number(record.score);
      setSectionSummary?.(String(score) + " / 100");
      const scoreLine = document.createElement("div");
      scoreLine.textContent = String(score) + " / 100";
      scoreLine.style.cssText = "font-size: 1.35em; font-weight: 700;";
      container.appendChild(scoreLine);
      this.appendScoreDetailRow(document, container, this.t("item.confidence"), record.confidence);
      if (this.scoreDetailText(record.reason)) {
        this.appendScoreDetailHeading(document, container, this.t("item.headingWhy"));
        this.appendScoreDetailRow(document, container, this.t("item.explanation"), record.reason, { multiline: true });
      }

      const components = this.scoreComponentEntries(record);
      if (components.length) {
        this.appendScoreDetailHeading(document, container, this.t("item.headingComponents"));
        for (const [label, value] of components) {
          this.appendScoreDetailRow(document, container, label, value);
        }
      }

      const bibliometricEvidence = this.bibliometricEvidenceEntries(record);
      this.appendScoreDetailHeading(document, container, this.t("item.headingBibliometric"));
      if (bibliometricEvidence.length) {
        for (const [label, value] of bibliometricEvidence) {
          this.appendScoreDetailRow(document, container, label, value);
        }
      } else {
        const unavailable = document.createElement("div");
        unavailable.textContent = this.t("item.notAvailable");
        unavailable.style.cssText = "opacity: .8;";
        container.appendChild(unavailable);
      }

      const provenance = this.scoreProvenanceEntries(record);
      if (provenance.length) {
        this.appendScoreDetailHeading(document, container, this.t("item.headingProvenance"));
        for (const [label, value] of provenance) {
          this.appendScoreDetailRow(document, container, label, value);
        }
      }
      body.appendChild(container);
    }

    buildPromptPreview(rawConfig = this.loadConfig()) {
      const config = {
        ...this.loadConfig(),
        ...asObject(rawConfig),
      };
      return this.Core.buildRankingPrompt({
        candidates: [PROMPT_PREVIEW_CANDIDATE],
        profile: this.Core.text(config.profile),
        explanationLanguage: this.Core.text(config.explanationLanguage),
      });
    }

    /*
     * The single scheduler for the weekly run.
     *
     * `weeklyRunDay`/`weeklyRunTime` name a weekday and a local time. NOTHING is
     * refreshed because Zotero started: a blank time means there is no automatic
     * run at all, and a set time means the run happens at that moment, while Zotero
     * is open, or not until the user asks for one of the manual commands.
     *
     * Polling rather than one long timeout, because a timeout to a fixed moment
     * survives neither suspend/resume nor a clock or timezone change. The window is
     * the rest of the scheduled DAY, so a laptop that was asleep at 16:50 still runs
     * when it wakes at 17:30, while a week whose day passed with Zotero closed is
     * left alone: catching it up at the next launch is exactly the startup run this
     * no longer does.
     */
    async startWeeklyScheduler() {
      const config = this.loadConfig();
      const scheduled = runMinuteOfDay(config.weeklyRunTime);
      if (scheduled == null) {
        // Blank time: no automatic run, ever. Use the manual commands.
        this.stopWeeklyTimer();
        this.weeklyLog("schedule disabled: no run time is set");
        return;
      }
      this.startWeeklyTimer();
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      this.weeklyLog(
        "schedule armed: every " +
          days[Math.min(6, Math.max(0, Math.round(Number(config.weeklyRunDay) || 0)))] +
          " at " + parseRunTime(config.weeklyRunTime) +
          ", checked every " + Math.round(WEEKLY_RUN_POLL_MS / 1000) + "s; next due " +
          this.scheduleReport().nextRun?.toLocaleString(),
      );
    }

    /*
     * A durable line for every scheduling decision.
     *
     * A pop-up can be missed -- Zotero behind another window, a notice that came and
     * went -- and then there is no way to tell "it never ran" from "I did not see
     * it". These lines are kept in FeedRank's own persisted state, so they survive a
     * restart, need no file APIs, and are shown by Check schedule. Written
     * best-effort: a log that cannot be written must never disturb the schedule it
     * is describing.
     */
    weeklyLog(message) {
      const line = new Date().toISOString() + "  " + this.Core.text(message, 400);
      this.weeklyLogTail = [...(this.weeklyLogTail || []), line].slice(-20);
      try {
        this.mutateState((state) => {
          state.weeklyLog = [...(Array.isArray(state.weeklyLog) ? state.weeklyLog : []), line].slice(-20);
          return state;
        }).catch(() => {});
      } catch (_) {
        // Never let bookkeeping break the thing being booked.
      }
      return line;
    }

    weeklyLogLines() {
      const stored = this.loadState();
      const storedLines = Array.isArray(stored.weeklyLog) ? stored.weeklyLog : [];
      // The in-memory tail is what happened this session; the stored list is what
      // happened before the last restart. Show both, newest last.
      return [...storedLines, ...(this.weeklyLogTail || [])].slice(-20);
    }

    startWeeklyTimer() {
      this.stopWeeklyTimer();
      /*
       * A real timer, not the injected `delay`.
       *
       * `delay` is `Zotero.Promise.delay` in production but resolves immediately
       * under test, and a self-rescheduling chain built on it would spin without
       * ever yielding. `setInterval` is also what Zotero's own background modules
       * use, and it cannot stack: a slow run is excluded by the workflow lock
       * rather than queued behind itself.
       */
      this.weeklyTimer = setInterval(() => {
        this.runWeeklyIfDue().catch((error) => this.logError(error));
      }, WEEKLY_RUN_POLL_MS);
      // Do not let the poll keep the host process alive on its own. In Zotero the
      // main window already does; under a test runner nothing should hang waiting
      // for a five-minute tick that will never be wanted.
      try {
        this.weeklyTimer?.unref?.();
      } catch (_) {}
    }

    stopWeeklyTimer() {
      if (this.weeklyTimer == null) return;
      try {
        clearInterval(this.weeklyTimer);
      } catch (_) {}
      this.weeklyTimer = null;
    }

    /*
     * A changed weekly day or time starts a new period.
     *
     * `weeklyPromptWeek` means "this week's moment has already been served", and it
     * is written by EVERY completed run, including "Run weekly job now". That is
     * correct for the schedule -- a hand-run week must not be run again a minute
     * later -- but it made the schedule untestable on the day it was set: a user who
     * ran the job by hand and then set a time ten minutes later got nothing for the
     * rest of the week, with nothing anywhere saying why. Changing the moment is the
     * statement "this period starts again", so the marker is cleared and the
     * ordinary due-check decides what happens next:
     *   - a moment still ahead today waits for its minute;
     *   - a moment already past today runs at the next poll, which is the same
     *     catch-up a machine waking after the moment already gets.
     */
    noteScheduleChanged(oldConfig, config) {
      const change = this.scheduleDescription(oldConfig) + " -> " + this.scheduleDescription(config);
      this.weeklyLog("schedule changed: " + change + "; the completed-period marker was cleared");
      this.mutateState((state) => {
        state.weeklyPromptWeek = "";
        return state;
      }).catch((error) => {
        this.logError(new Error("Could not clear the completed-period marker: " + this.safeError(error)));
      });
      // Blank -> set has to arm the timer; set -> blank has to stop it.
      this.startWeeklyScheduler().catch((error) => this.logError(error));
    }

    /*
     * The cadence in one phrase, for the log, the panes, and the settings save.
     *
     * "daily at 07:30", "weekly on Wednesday at 16:50", "monthly on the 1st at 09:00",
     * or the statement that nothing is scheduled. One helper so every surface says the
     * same thing about the same configuration.
     */
    scheduleDescription(config = this.loadConfig()) {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      if (runMinuteOfDay(config?.weeklyRunTime) == null) return "no automatic run";
      const time = " at " + parseRunTime(config.weeklyRunTime);
      const frequency = scheduledFrequency(config.runFrequency);
      if (frequency === "daily") return "daily" + time;
      if (frequency === "monthly") {
        const day = Math.min(31, Math.max(1, Math.round(Number(config.monthlyRunDay) || 1)));
        return "monthly on the " + day + ordinalSuffix(day) + time;
      }
      const weekday = Math.min(6, Math.max(0, Math.round(Number(config.weeklyRunDay) || 0)));
      return "weekly on " + days[weekday] + time;
    }

    /*
     * One sentence for a settings pane, straight after a save.
     *
     * "Saved." is not an answer to "I set a time and nothing happened". This says
     * when the run will actually happen, or that this week is already done and when
     * the next one comes round.
     */
    nextRunSummary(now = new Date()) {
      const report = this.scheduleReport(now);
      if (!report.enabled) {
        return "No automatic run is scheduled: the run time is blank. Use a FeedRank menu command instead.";
      }
      const when = report.nextRun ? report.nextRun.toLocaleString() : "";
      if (report.lastWeek === report.anchor && !report.dueNow) {
        return "This week's run is already done (week of " + report.anchor + "). Next automatic run: " + when + ".";
      }
      if (report.dueNow) return "Due now: the run starts within the next minute.";
      return "Next automatic run: " + when + ".";
    }

    // The local day the current period's run belongs to: the most recent scheduled
    // moment at or before now for the configured cadence, or this week's Monday when
    // no time is set at all.
    currentRunAnchor(now = new Date()) {
      const config = this.loadConfig();
      if (runMinuteOfDay(config.weeklyRunTime) == null) return localWeekAnchorDay(now);
      return scheduledAnchorDay(now, config);
    }

    /*
     * True when the current period's scheduled moment has already passed.
     *
     * One marker answers this for every cadence, because `currentRunAnchor` is the
     * most recent moment at or before now: for a daily run it changes every day, for a
     * weekly one every chosen weekday, for a monthly one every chosen day of the month.
     * Comparing the saved marker with it is therefore exactly "has this period's run
     * already happened?", and the day-of-week gate below only applies to the weekly
     * cadence. The window stays the scheduled DAY, from the moment until midnight: a
     * machine that was asleep at the moment still runs when it wakes, while a period
     * that passed with Zotero closed is not revived at the next launch.
     */
    isWeeklyRunDue(now = new Date()) {
      const config = this.loadConfig();
      const scheduled = runMinuteOfDay(config.weeklyRunTime);
      if (scheduled == null) return false;
      const minutesNow = now.getHours() * 60 + now.getMinutes();
      const frequency = scheduledFrequency(config.runFrequency);
      /*
       * The day gate, per cadence.
       *
       * The window is the scheduled DAY, from the moment until the period ends: a machine
       * that was asleep at the moment still runs when it wakes, while a period that
       * passed with Zotero closed is not revived at the next launch. For the weekly
       * cadence that is the chosen weekday; for the monthly one it is the chosen day of
       * the month, clamped to the last day of a short month. Without the monthly gate the
       * anchor of a day that is still ahead is LAST month's occurrence, which would make
       * the run due early in the month instead of on its day.
       */
      if (frequency === "weekly") {
        const day = Math.min(6, Math.max(0, Math.round(Number(config.weeklyRunDay) || 0)));
        if (now.getDay() !== day) return false;
      } else if (frequency === "monthly") {
        const wanted = Math.min(31, Math.max(1, Math.round(Number(config.monthlyRunDay) || 1)));
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const dayOfMonth = Math.min(wanted, lastDay);
        if (now.getDate() < dayOfMonth) return false;
        if (now.getDate() === dayOfMonth && minutesNow < scheduled) return false;
      }
      if (minutesNow < scheduled) return false;
      return this.loadState().weeklyPromptWeek !== this.currentRunAnchor(now);
    }

    async runWeeklyIfDue(now = new Date()) {
      /*
       * Every poll is counted, whatever it decides.
       *
       * "Set a time then nothing happens" cannot be answered from a log that only
       * records runs: the question is whether the timer is ticking at all. These two
       * figures are in memory only -- no state write on a one-minute timer -- and
       * both panes print them, so "checked 47 times, last at 18:31:02" is visible
       * proof that the schedule is alive and simply has nothing to do yet.
       */
      this.scheduleChecks = (Number(this.scheduleChecks) || 0) + 1;
      this.lastScheduleCheckAt = Date.now();
      if (this.shuttingDown || this.weeklyStarted) return;
      if (!this.isWeeklyRunDue(now)) return;
      /*
       * The run announces itself through the corner notice and the durable log.
       *
       * It used to open a modal window here, and another when the run ended. Those
       * were built to prove a channel that could not be seen at all, and the user's
       * instruction once the schedule worked was to remove them: "remove the popup
       * window before and after the weekly schedule. It was for testing only." The
       * evidence they were there to provide is not lost -- the notice appears while
       * the run goes, `noteRunStarted`/`noteRunStage` write every stage to the log,
       * and Check schedule prints it.
       */
      const anchor = this.currentRunAnchor(now);
      this.weeklyLog("due (" + anchor + "): starting the scheduled job");
      return this.runWeekly(now);
    }

    async runWeekly(now = new Date(), { manual = false } = {}) {
      if (this.weeklyStarted || this.shuttingDown) return;
      this.weeklyStarted = true;
      const window = this.getActiveMainWindow();
      if (!window) {
        // No window yet is not a failure of the schedule: release the latch so the
        // next five-minute check can try again.
        this.weeklyStarted = false;
        return;
      }

      return this.withWorkflowLock(window, "scheduled run", async (workflow) => {
        let summary;
        /*
         * One visible window for the whole scheduled job.
         *
         * The refresh is the longest part of a scheduled run and it used to happen
         * with NO window at all -- the first thing the user saw was a scoring dialog,
         * minutes later, if they saw anything. "I cannot see any flags" was exactly
         * that: nothing on screen while the machine worked. This window opens first
         * and is handed to the scoring stage, so the invariant of one window per run
         * still holds.
         */
        const progress = this.beginWorkflowProgress(
          window,
          workflow,
          this.t("progress.weeklyRun"),
          this.t("progress.starting"),
        );
        try {
          const anchor = this.currentRunAnchor(now);
          if (this.loadState().weeklyPromptWeek === anchor && !manual) return;
          // Whatever happens from here, the window at the end reports the email of
          // THIS run rather than of an earlier one.
          this.lastDigestOutcome = null;
          this.lastRunSplit = null;

          // The flag: the automatic run says so before it does anything slow, so a
          // long refresh is never a mystery about whether FeedRank started.
          const lookbackDays = scheduledLookbackDays(this.loadConfig().runFrequency);
          this.noteRunStarted("weekly", "scheduled run for " + anchor);
          this.notifyQuiet(
            "FeedRank: the scheduled run started (" + anchor + "). " +
              "Refreshing feeds and scoring the last " + lookbackDays +
              (lookbackDays === 1 ? " day." : " days."),
          );

          this.throwIfCancelled(workflow, progress);
          this.noteRunStage("waiting for Awesome GPT");
          progress.update(this.t("progress.waitingGpt"), 0, 1);
          await this.waitForAwesomeGPT(window, 30000, workflow);
          this.throwIfCancelled(workflow, progress);
          this.noteRunStage("refreshing feeds and collecting this period's articles");
          // The digest's span, not the configured refresh lookback: a run that emails
          // one day, one week, or one month of papers must collect exactly that much.
          summary = await this.refreshAndCollect(
            window,
            { ...this.loadConfig(), lookbackDays },
            workflow,
            progress,
          );
          this.throwIfCancelled(workflow, progress);
          await this.mutateState((state) => {
            this.retainLatestCandidateSnapshot(state, summary);
            state.weeklyPromptWeek = anchor;
            return state;
          });
          // The standing approval is read once, before either branch: a week with
          // no NEW articles still has the week's already-scored articles, and the
          // digest is a digest of those.
          this.noteRunStage("checking the weekly email approval");
          const approval = await this.confirmWeeklyEmailDelivery(window);
          const autoSendApproved = approval.approved === true;
          if (!summary.candidates.length) {
            if (summary.refresh.failedFeeds?.length) this.showRefreshOutcome(window, summary.refresh);
            // Nothing new to score. Send the week's digest from the scores already
            // in the cache rather than letting the week pass in silence -- which is
            // what "the schedule is not working" looked like: no new feed items, so
            // no email, week after week.
            this.noteRunStage("sending the week's digest from the scores already stored");
            progress.update(this.t("progress.preparingDigest"), 1, 1);
            await this.sendWeeklyDigestFromCache(window, {
              autoSendApproved,
              approvalReason: approval.reason,
              reason: "no new articles needed scoring",
            });
            this.noteRunFinished("nothing new to score");
            this.reportScheduledRun(summary, { manual });
            return;
          }
          this.throwIfCancelled(workflow, progress);
          this.noteRunStage("scoring " + summary.candidates.length + " articles and emailing the digest");
          await this.rankAndDisplay(window, summary.candidates, {
            refresh: summary.refresh,
            workflow,
            // The same window carries on into the scoring stage, so the whole job is
            // still exactly one window.
            progress,
            /*
             * A scheduled run does not open the results window.
             *
             * Nobody asked for it: it appears while the machine is working
             * unattended, it is about papers the user did not select, and it stays
             * there until it is closed by hand -- so a weekly job left a dialog on
             * screen every week. The scores are in the cache and in the item pane,
             * the digest email carries them, and the window at the end of the run
             * says what happened. An explicit run (the menu command, "Run weekly job
             * now") still opens it, because that is the one case where it was asked
             * for.
             */
            showResults: manual === true,
            // What the closing window and the digest identity need: the run, the
            // standing approval, and the reason it was or was not given. The digest
            // CONTENT comes from `weeklyDigestSelection()`, so neither the candidate
            // list nor a window is passed here.
            digestRun: {
              runID: this.makeWeeklyDigestRunID(anchor),
              autoSendApproved,
              approvalReason: approval.reason,
            },
          });
          this.noteRunFinished("completed");
          this.reportScheduledRun(summary, { manual });
        } catch (error) {
          if (error instanceof CancelledError) {
            this.notifyInfo("The scheduled run was cancelled. FeedRank will try again at the next check.");
            return;
          }
          if (summary) {
            this.showRefreshOutcome(
              window,
              summary.refresh,
              "Scoring was not completed: " + this.safeError(error),
            );
          } else {
            this.notifyError(
              "The scheduled run did not start: " + this.safeError(error) + " " +
                "FeedRank will try again at its next check. Use Tools → FeedRank for Zotero → Refresh and score " +
                "if you do not want to wait.",
            );
          }
          /*
           * A failure is reported through the notice channel and the durable log.
           *
           * The modal window that used to say this is gone with the other two -- "it was
           * for testing only" -- so what is left is the message above, the log line
           * below, and the error console. The log line is the one that answers "did
           * anything happen at 16:50?" a week later.
           */
          this.weeklyLog("run FAILED: " + this.safeError(error));
          this.logError(error);
        } finally {
          // The flag clears whatever happened, so it can never claim a run that is
          // no longer running.
          if (this.runState?.active) this.noteRunFinished("did not complete");
          /*
           * Release the in-flight latch when the attempt is over, whatever happened.
           *
           * It exists to stop two attempts overlapping, but an earlier revision set
           * it and never cleared it, so ONE failure -- Awesome GPT not ready yet, a
           * refresh error, a cancelled progress window -- switched the schedule off
           * for the rest of the session and nothing ever said so. Idempotence does
           * not depend on this latch: the saved week anchor is what makes the run
           * happen at most once a week, so a failed attempt may safely retry on the
           * next check -- which is one minute away, not five.
           */
          this.weeklyStarted = false;
        }
      }, { silent: true });
    }
    /*
     * The weekly digest for a completed run: the WEEK's eligible scores.
     *
     * This used to be built from the records of the run itself, and that is what
     * produced an empty-digest refusal on a run that had just scored eight articles:
     * every one of them landed below the digest's Minimum relevance Score, while the
     * week already held 48 articles that passed it. The reader's expectation is the
     * plain one -- score this week, get this week's digest -- and it is also the
     * definition the pane already uses, so the email and the preview cannot disagree:
     * `weeklyDigestSelection()` is the single source for both, which is what its own
     * comment always claimed.
     *
     * When that selection is empty, nothing is sent and the reason is the pane's own
     * reason, worded for the reader ("3 articles were scored in the last 7 days, but
     * none reached the digest's Minimum relevance Score of 70").
     */
    async recordCompletedDigest(digestRun, window) {
      if (!digestRun) return null;
      const selection = this.weeklyDigestSelection();
      if (!selection.records.length) {
        const reason = this.Core.text(selection.reason) || "no eligible articles";
        this.lastDigestOutcome = { sent: false, message: this.t("email.nothingEligible", { reason }) };
        this.weeklyLog("digest not prepared: " + reason);
        this.notifyQuiet("The scheduled run finished with nothing to email: " + reason);
        return null;
      }
      try {
        const result = await this.Zotero.FeedRankEmail?.recordCompletedWeeklyRun?.({
          source: "weekly",
          runID: digestRun.runID,
          localDay: selection.localDay,
          records: cloneJSON(selection.records),
          window: { from: selection.window?.from, to: selection.window?.to },
          autoSendApproved: digestRun.autoSendApproved === true,
          parentWindow: window,
        });
        // The outcome is remembered whether it succeeded or not: this is what the
        // window at the end of the run reads out, so "the email is still not sent"
        // arrives as a sentence with the transport's own reason attached.
        this.lastDigestOutcome = this.digestRunOutcome(result, digestRun);
        this.weeklyLog("digest prepared from " + selection.records.length + " eligible scored " +
          (selection.records.length === 1 ? "article" : "articles") + " (" + selection.window.from +
          " to " + selection.window.to + ")");
        if (result?.autoResult && !result.autoResult.sent) {
          /*
           * An automatic send that did not happen is reported, not logged.
           *
           * This was the difference between "the schedule is not working" and
           * knowing why: the run completed, the digest was prepared, the send
           * failed, and the only trace was a line in Zotero's error console. The
           * digest is stored either way, so the message also says how to send it by
           * hand from the pane.
           */
          const reason = this.safeError(result.autoResult.message);
          this.notifyError(
            "The weekly digest was prepared but not emailed: " + reason + " " +
              "Open FeedRank settings and use Review digest to send it yourself.",
          );
          this.logError(new Error("FeedRank scheduled email was not sent: " + reason));
        }
        return result;
      } catch (error) {
        // A transport/snapshot failure must never turn an already committed,
        // successful ranking run into a failure or trigger another send.
        const reason = this.safeError(error);
        this.lastDigestOutcome = { sent: false, message: reason };
        this.weeklyLog("digest FAILED: " + reason);
        this.logError(new Error("Could not prepare FeedRank weekly email: " + reason));
        return null;
      }
    }

    /*
     * The week's digest from the scores already in the cache.
     *
     * Used by the scheduled run when it found nothing new to score. It is the same
     * statement as `recordCompletedDigest` -- the digest is the week's eligible
     * scores -- reached by a different route, so it delegates rather than
     * duplicating the definition.
     */
    async sendWeeklyDigestFromCache(window, {
      autoSendApproved = false, approvalReason = "", reason = "",
    } = {}) {
      const outcome = await this.recordCompletedDigest({
        runID: this.makeWeeklyDigestRunID(this.Core.localDay()),
        autoSendApproved,
        approvalReason,
      }, window);
      if (!outcome && reason) {
        this.weeklyLog("no digest for a quiet week (" + reason + ")");
      }
      return outcome;
    }

    /*
     * The window that closes a scheduled run.
     *
     * Two questions were unanswerable after a scheduled run: did it happen at all,
     * and did the email go out. The first is answered where the run starts; this
     * answers the second, at the moment it is decided, through the one channel that
     * has been seen to work on this machine. Deliberately three short lines --
     * feeds, articles, email -- and not a report.
     */
    reportScheduledRun(summary, { manual = false } = {}) {
      const refresh = asObject(summary?.refresh);
      const feedCount = (key) => {
        const declared = Number(refresh?.[key + "Count"]);
        return Number.isSafeInteger(declared) && declared >= 0
          ? declared
          : Array.isArray(refresh?.[key + "s"]) ? refresh[key + "s"].length : 0;
      };
      const declaredTotal = Number(refresh?.totalFeeds);
      const successes = feedCount("successfulFeed");
      const failures = feedCount("failedFeed");
      const total = Number.isSafeInteger(declaredTotal) && declaredTotal >= 0
        ? declaredTotal
        : successes + failures;
      const split = asObject(this.lastRunSplit);
      const lines = [this.t("run.outcomeHeading")];
      if (total || successes) {
        lines.push(
          this.t("run.feeds", {
            ok: successes,
            total: total || successes,
            failed: failures ? this.t("run.feedsFailed", { count: failures }) : "",
          }),
        );
      }
      if (Number(split.newlyScored) || Number(split.reused)) {
        lines.push(
          this.t("run.articles", {
            scored: Number(split.newlyScored) || 0,
            reused: Number(split.reused) || 0,
            replaced: Number(split.replaced)
              ? this.t("run.articlesReplaced", { count: Number(split.replaced) })
              : "",
          }),
        );
      } else {
        lines.push(this.t("run.articlesNone"));
      }
      lines.push(this.digestOutcomeLine(this.lastDigestOutcome));
      const text = lines.join("\n");
      this.weeklyLog("outcome (" + (manual ? "manual" : "scheduled") + "): " + text.replace(/\n/g, " | "));
      /*
       * Said through the corner notice, and written to the durable log above.
       *
       * A run the user starts by hand and a scheduled one report the same way now that
       * the modal windows are gone: the notice for whoever is watching, the log for
       * whoever was not. The email outcome is in both, which is what makes "was it
       * sent?" answerable after the fact without a window interrupting anything.
       */
      this.notifyQuiet(text);
      return text;
    }

    makeWeeklyDigestRunID(anchor) {
      // The email service stores only a compact hash of this opaque token; it
      // never persists candidate/item IDs as a delivery-run identifier.
      return "weekly:" + this.Core.text(anchor) + ":" + Date.now() + ":" +
        Math.random().toString(36).slice(2, 14);
    }

    /*
     * The weekly-delivery decision, expressed as the SETTING it already was
     * instead of a dialog.
     *
     * This used to be a modal confirmation shown before every scheduled run. A
     * dialog that appears at startup, before the user has asked for anything, is
     * the worst possible place for it, and the click it demanded carried no more
     * information than the check box does. The opt-in is now the setting itself,
     * which is where a standing decision belongs, and the notice states what was
     * decided so the run is never silent about it.
     *
     * Nothing is weakened: the setting is still required, the send still needs
     * configured credentials, and the digest is still snapshotted and frozen
     * before exactly one connection is opened.
     */
    async confirmWeeklyEmailDelivery(window) {
      const email = this.Zotero.FeedRankEmail;
      if (!email?.loadConfig || !email?.getStatus) {
        return { approved: false, reason: this.t("email.serviceMissing") };
      }
      const config = email.loadConfig();
      if (config.automaticSendingEnabled !== true) {
        return { approved: false, reason: this.t("email.approvalOff") };
      }
      let status;
      try {
        status = await email.getStatus();
      } catch (error) {
        this.logError(new Error("Could not inspect FeedRank email settings: " + this.safeError(error)));
        return {
          approved: false,
          reason: this.t("email.settingsUnreadable") + " (" + this.safeError(error) + ")",
        };
      }
      if (!status.credentials?.configured) {
        this.notifyError(
          "Weekly email is enabled but secure credentials are not configured, so this run will not send email. " +
            "Open FeedRank settings → Email digest to set them.",
        );
        return { approved: false, reason: this.t("email.noCredentials") };
      }
      // The setting is a standing approval, so it is honoured without a prompt.
      // The user is told exactly what it covered, without a click -- through the
      // passive channel only, because this is a statement of the decision, not an
      // outcome anyone has to acknowledge.
      this.notifyQuiet([
        "Weekly SMTP delivery is enabled; this completed run will be submitted.",
        "Server " + status.credentials.host + ":" + status.credentials.port +
          " (" + status.credentials.tlsMode + "), recipient " + status.credentials.to + ".",
        "Turn off the weekly-digest approval in FeedRank settings to stop this.",
      ].join("\n"));
      return {
        approved: true,
        reason: "automatic sending is enabled to " + status.credentials.to +
          " via " + status.credentials.host + ":" + status.credentials.port,
      };
    }

    /*
     * What the run says about the email, in one line, for the window at the end.
     *
     * "The email is still not sent" is unanswerable without this: the send is
     * attempted at the end of a long unattended job, and its outcome used to be a
     * passive notice on a machine where passive notices are not seen. The sentence
     * is built from the actual delivery result, so it distinguishes "sent",
     * "prepared but the send failed" (with the transport's own words), "not sent
     * because sending is off", and "there was nothing to send".
     */
    digestOutcomeLine(outcome) {
      if (!outcome) return this.t("email.notPrepared");
      if (outcome.sent === true) {
        return outcome.to ? this.t("email.sent", { to: outcome.to }) : this.t("email.sentUnknownRecipient");
      }
      const reason = this.Core.text(outcome.message) || "no reason was reported";
      return this.t("email.notSent", { reason });
    }

    /*
     * The stored delivery result as one user-facing sentence.
     *
     * The three ways a digest ends without a send -- sending was never approved,
     * the email service was not there at all, and a send that was attempted and
     * failed -- are kept apart on purpose: they need three different actions from
     * whoever reads the sentence.
     */
    digestRunOutcome(result, digestRun = {}) {
      const auto = asObject(result?.autoResult);
      if (digestRun.autoSendApproved !== true) {
        return {
          sent: false,
          message: this.t("email.notApproved", { reason:
            (this.Core.text(digestRun.approvalReason) || this.t("email.approvalOff")) }),
        };
      }
      if (!result) return { sent: false, message: this.t("email.serviceSilent") };
      if (auto.sent === true) return { sent: true, to: this.Core.text(auto.to) };
      /*
       * The service's own reason is used when it declined to prepare a send at all.
       *
       * `recordCompletedWeeklyRun` answers `{recorded: false, reason}` for a digest
       * it refuses to treat as deliverable, and that reason used to be replaced by
       * the generic "the send did not report success" -- the one sentence that
       * cannot be acted on.
       */
      const reason = this.Core.text(auto.message) ||
        (result.recorded === false ? this.Core.text(result.reason) : "") ||
        (this.Core.text(auto.status) ? this.t("email.deliveryStatus", { status: this.Core.text(auto.status) }) : "") ||
        this.t("email.sendUnreported");
      return { sent: false, message: this.safeError(reason) };
    }

    /*
     * FeedRank's own Extra lines, in the shape Green Frog established for Zotero
     * add-on data: one `Key: value` per line, so any tool that reads Extra can read
     * them, and so they survive without FeedRank's own cache.
     *
     * Only these exact labels are ever touched. Green Frog's journal keys
     * (影响因子, 5年影响因子, JCR分区 and the rest) are different keys and are left
     * byte-for-byte alone, as is anything the user wrote.
     */
    scoreExtraLabelPattern() {
      return /^\s*(FeedRank Score|FeedRank Priority)\s*[:：]\s*(.*?)\s*$/u;
    }

    // The managed lines for one scored record, or an empty map when the record
    // carries no usable number.
    scoreExtraValues(record) {
      const wanted = new Map();
      // `Number(null)` and `Number("")` are both 0, so an absent score must be
      // rejected before the conversion; otherwise a paper with no score would be
      // written into Extra as a real "FeedRank Score: 0".
      const whole = (value) => {
        if (value == null || value === "") return "";
        const number = Number(value);
        if (!Number.isFinite(number)) return "";
        return String(Math.max(0, Math.min(100, Math.round(number))));
      };
      const relevance = whole(record?.score);
      const priority = whole(record?.priorityScore);
      if (relevance) wanted.set("FeedRank Score", relevance);
      if (priority) wanted.set("FeedRank Priority", priority);
      return wanted;
    }

    /*
     * Merge those lines into an Extra value.
     *
     * The contract is the one journal-service.js already implements for the journal
     * metrics, because two add-ons writing the same field must not fight:
     *   - lines carrying other labels are preserved exactly, including blanks;
     *   - a line with one of OUR labels is replaced in place, so repeated runs
     *     cannot accumulate duplicates;
     *   - a managed label with no value is dropped rather than left stale;
     *   - only the edge blank runs an append can create are trimmed.
     * The caller compares the result with the current value and skips the save when
     * they are equal, so an unchanged score never marks an item as modified.
     */
    mergeScoreExtraText(rawExtra, record) {
      const wanted = this.scoreExtraValues(record);
      const labelPattern = this.scoreExtraLabelPattern();
      const kept = [];
      const present = new Set();
      for (const line of String(rawExtra == null ? "" : rawExtra).split(/\r?\n/)) {
        const match = line.match(labelPattern);
        if (!match) {
          kept.push(line);
          continue;
        }
        present.add(match[1]);
        const value = wanted.get(match[1]);
        if (value) kept.push(match[1] + ": " + value);
      }
      for (const [label, value] of wanted) {
        if (present.has(label)) continue;
        kept.push(label + ": " + value);
      }
      const isBlank = (line) => !this.Core.text(line);
      while (kept.length && isBlank(kept[0])) kept.shift();
      while (kept.length && isBlank(kept[kept.length - 1])) kept.pop();
      return kept.join("\n");
    }

    /*
     * Write this run's scores into the scored items' own Extra fields.
     *
     * The items are Zotero's, not FeedRank's: each one is looked up from the record,
     * updated only when the merged text actually differs, and saved through Zotero's
     * transaction API so the change syncs like any other item edit. A missing,
     * deleted, or read-only item is skipped quietly — one unwritable item must not
     * stop the rest, and must never fail a run whose scores are already committed.
     */
    async mirrorScoresToExtra(records) {
      const list = Array.isArray(records) ? records : [];
      let written = 0;
      for (const record of list) {
        if (!this.scoreExtraValues(record).size) continue;
        try {
          const item = this.currentItemForRecord(record);
          if (!item || typeof item.setField !== "function") continue;
          const current = String(item.getField("extra") || "");
          const next = this.mergeScoreExtraText(current, record);
          if (next === current) continue;
          item.setField("extra", next);
          if (typeof item.saveTx === "function") await item.saveTx();
          written++;
        } catch (error) {
          this.logError(new Error("FeedRank could not update one item's Extra field: " + this.safeError(error)));
        }
      }
      return written;
    }

    async runManualRefresh(window) {
      return this.withWorkflowLock(window, "manual refresh", async (workflow) => {
        const config = this.loadConfig();
        let summary;
        const progress = this.beginWorkflowProgress(
          window,
          workflow,
          "Refreshing FeedRank feeds",
          "Preparing feed refresh…",
        );
        try {
          this.throwIfCancelled(workflow, progress);
          // Feed retrieval does not require Awesome GPT. Refresh first so a
          // temporarily unavailable chat bridge cannot make this command look
          // as though Zotero itself did nothing.
          summary = await this.refreshAndCollect(window, config, workflow, progress);
          this.throwIfCancelled(workflow, progress);
          await this.mutateState((state) => this.retainLatestCandidateSnapshot(state, summary));
          progress?.update?.(
            summary.candidates.length
              ? "Found " + summary.candidates.length + " " +
                (summary.candidates.length === 1 ? "article" : "articles") + " ready to score."
              : "Refresh completed. No article was ready to score.",
            1,
            1,
          );
        } finally {
          // Close before the confirmation dialog and before rankAndDisplay()
          // opens its dedicated live-scoring progress window.
          this.endWorkflowProgress(workflow, progress);
        }

        if (!summary.candidates.length) {
          this.showRefreshOutcome(window, summary.refresh);
          return;
        }
        this.throwIfCancelled(workflow);
        // No confirmation: the user ran the refresh-and-score command, so the
        // scoring half of it is already approved.
        await this.waitForAwesomeGPTWithProgress(
          window,
          workflow,
          "Preparing FeedRank scoring",
          "Waiting for Awesome GPT before scoring…",
        );
        this.throwIfCancelled(workflow);
        await this.rankAndDisplay(window, summary.candidates, {
          refresh: summary.refresh,
          workflow,
        });
      });
    }

    /*
     * Rescore the last saved candidate set.
     *
     * No longer a menu command: "Rescore latest articles" was replaced by the two
     * scoped functions, Rescore last N days and Rescore selected items, whose scope
     * the user actually chooses. It is kept as the reader of the persisted
     * `lastCandidates` snapshot, which every scoring run still records, so a cleared
     * candidate set stays recoverable from the stored-feed lookback. If that
     * snapshot is ever dropped from the state, this method goes with it.
     */
    async rerankLast(window) {
      return this.withWorkflowLock(window, "manual rerank", async (workflow) => {
        const config = this.loadConfig();
        let state;
        let rehydrated;
        let refresh;
        let recoveredFromLookback = false;
        const progress = this.beginWorkflowProgress(
          window,
          workflow,
          "Preparing FeedRank rescore",
          "Loading the most recent FeedRank articles…",
        );
        try {
          state = this.loadState();
          const recoverFromStoredLookback = async (reason) => {
            // Older versions could clear the rerun snapshot after an empty
            // refresh, and feed retention can later make every saved item
            // reference unavailable. In either case recover a bounded,
            // explicitly confirmed list rather than leaving Rescore latest
            // unusable.
            recoveredFromLookback = true;
            const unavailableCount = rehydrated?.unavailableCount || 0;
            progress?.update?.(
              reason + " Checking stored articles from the last " +
                config.lookbackDays + " days…",
              0,
              1,
            );
            const recovered = await this.collectFeedItemsWithinDays(
              config.lookbackDays,
              workflow,
              null,
              progress,
            );
            const candidates = recovered.candidates.slice(0, config.candidateLimit);
            refresh = {
              ...recovered.refresh,
              recoveredForRescore: true,
              limitedCount: Math.max(0, recovered.candidates.length - candidates.length),
            };
            rehydrated = { candidates, unavailableCount };
            if (candidates.length) {
              await this.mutateState((latestState) => this.retainLatestCandidateSnapshot(
                latestState,
                { candidates, refresh },
              ));
            }
          };
          if (state.lastCandidates.length) {
            rehydrated = await this.rehydrateLastCandidates(state.lastCandidates, workflow, progress);
            refresh = state.lastRefresh;
            if (!rehydrated.candidates.length) {
              await recoverFromStoredLookback("Saved rerun articles are no longer available.");
            }
          } else {
            await recoverFromStoredLookback("No saved rerun list.");
          }
          this.throwIfCancelled(workflow, progress);
          progress?.update?.(
            rehydrated.candidates.length
              ? "Loaded " + rehydrated.candidates.length + " " +
                (rehydrated.candidates.length === 1 ? "article" : "articles") + " for rescore."
              : "No available articles were found for rescore.",
            1,
            1,
          );
        } finally {
          this.endWorkflowProgress(workflow, progress);
        }
        if (!rehydrated.candidates.length) {
          this.notifyWarn(
            recoveredFromLookback
              ? "No stored feed articles from the last " + config.lookbackDays +
                " days are available to recover for rescore. Use Score last N days once your feeds contain articles."
              : "None of the most recent feed articles is still available to rescore.",
          );
          return;
        }
        if (rehydrated.unavailableCount) {
          this.notifyWarn(
            rehydrated.unavailableCount + " saved feed article" +
              (rehydrated.unavailableCount === 1 ? " is" : "s are") +
              " no longer available and will be skipped.",
          );
        }
        // No confirmation: "Rescore latest" is the click.
        await this.waitForAwesomeGPTWithProgress(
          window,
          workflow,
          "Preparing FeedRank rescore",
          "Waiting for Awesome GPT before rescoring…",
        );
        this.throwIfCancelled(workflow);
        await this.rankAndDisplay(window, rehydrated.candidates, {
          refresh,
          force: true,
          workflow,
          // An explicit rescore re-reads the model's significance reading rather
          // than reusing the one saved with the previous score.
          rescoreArxivSignificance: true,
        });
      });
    }

    isRankableItem(item) {
      if (!item || item.id == null || item.libraryID == null || !this.Core.text(item.key)) return false;
      try {
        if (item.isAttachment?.() || item.isNote?.() || item.isAnnotation?.()) return false;
        if (typeof item.isRegularItem === "function" && !item.isRegularItem()) return false;
      } catch (_) {
        return false;
      }
      return true;
    }

    selectedItemSource(item) {
      try {
        const library = this.Zotero.Libraries?.get?.(item.libraryID);
        const name = this.Core.text(library?.name);
        if (name) return name;
      } catch (_) {}
      return "Selected items";
    }

    async rankSelectedItems(window, selectedItems, { mode = "score" } = {}) {
      return this.withWorkflowLock(window, "selected items", async (workflow) => {
        const items = Array.isArray(selectedItems) ? selectedItems : [];
        const rankableItems = items.filter((item) => this.isRankableItem(item));
        if (!rankableItems.length) {
          this.notifyWarn("Select one or more bibliographic Zotero items to score.");
          return;
        }

        const deduplicated = this.Core.deduplicateCandidates(rankableItems.map((item) =>
          this.toCandidate(item, { name: this.selectedItemSource(item) }),
        ));
        const candidates = deduplicated.candidates;
        if (!candidates.length) {
          this.notifyWarn("None of the selected items contained scorable bibliographic metadata.");
          return;
        }

        // No confirmation here. Choosing "Score selected items" or "Rescore
        // selected items" from the context menu IS the decision, and the progress
        // window has a Cancel control before any batch is dispatched.
        this.throwIfCancelled(workflow);
        await this.waitForAwesomeGPT(window, 30000, workflow);
        this.throwIfCancelled(workflow);
        await this.rankAndDisplay(window, candidates, {
          // Both modes are explicit about the paper, so both re-read the model's
          // significance reading rather than reusing a saved one.
          mode,
          rescoreArxivSignificance: true,
          refresh: {
            kind: "selection",
            startedAt: new Date().toISOString(),
            selectedItemCount: items.length,
            rankableItemCount: rankableItems.length,
            candidateCount: candidates.length,
            duplicateCount: deduplicated.duplicates.length,
          },
          workflow,
        });
      });
    }

    /*
     * Ask how many calendar days the N-day command should cover.
     *
     * It is a text prompt rather than a fixed setting because the answer is a
     * property of THIS run, not of the add-on: "the last three days" is a question
     * you ask once. The configured Lookback days is offered as the default, so
     * Enter keeps the previous behaviour, and `0` stays the documented special case
     * for today only. Anything cancelled or unparseable returns null and the caller
     * stops before reading or sending anything.
     */
    promptForLookbackDays(window, fallbackDays, scopeLabel = "all feeds", { mode = "score" } = {}) {
      const rescoring = mode === "rescore";
      const value = { value: String(fallbackDays) };
      const accepted = this.Services.prompt.prompt(
        window,
        TOOL_NAME,
        (rescoring ? "Rescore" : "Score") + " stored articles in " + scopeLabel +
          " from how many calendar days?\n\n" +
          "Enter a whole number from 0 to 365. 0 means today only; 7 means today plus the preceding 6 days." +
          (rescoring
            ? "\n\nRescore replaces the stored scores of every article it covers."
            : "\n\nArticles that already have a current score are left alone and are not sent to Awesome GPT."),
        value,
        null,
        {},
      );
      if (!accepted) return null;
      const raw = this.Core.text(value.value);
      if (!/^\d+$/.test(raw)) {
        this.notifyWarn("Enter a whole number of days from 0 to 365.");
        return null;
      }
      const days = Number(raw);
      if (!Number.isInteger(days) || days < 0 || days > 365) {
        this.notifyWarn("Enter a whole number of days from 0 to 365.");
        return null;
      }
      return days;
    }

    publicationDay(dateValue) {
      const match = this.Core.text(dateValue).match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!match) return null;
      const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
      if (
        Number.isNaN(date.getTime()) ||
        date.getFullYear() !== Number(match[1]) ||
        date.getMonth() !== Number(match[2]) - 1 ||
        date.getDate() !== Number(match[3])
      ) return null;
      return date;
    }

    lookbackRange(days, now = new Date()) {
      const requestedDays = Math.max(0, Math.floor(Number(days) || 0));
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
      const start = new Date(end);
      start.setDate(start.getDate() - (requestedDays > 0 ? requestedDays - 1 : 0));
      return {
        requestedDays,
        start,
        end,
        startDate: this.Core.localDay(start),
        endDate: this.Core.localDay(end),
      };
    }

    lookbackRangeLabel(days, now = new Date()) {
      const range = this.lookbackRange(days, now);
      if (range.requestedDays === 0) {
        return "today only (" + range.startDate + ")";
      }
      return "the last " + range.requestedDays + " calendar day" +
        (range.requestedDays === 1 ? "" : "s") + " (" + range.startDate +
        " through " + range.endDate + ")";
    }

    isWithinRequestedDays(dateValue, days, now = new Date()) {
      const articleDate = this.publicationDay(dateValue);
      if (!articleDate) return false;
      const range = this.lookbackRange(days, now);
      const startOfWindow = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate(), 0, 0, 0, 0);
      const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      return articleDate >= startOfWindow && articleDate <= endOfToday;
    }

    getFeedsForScope(scope) {
      let allFeeds = [];
      try {
        const result = this.Zotero.Feeds?.getAll?.();
        allFeeds = Array.isArray(result) ? result : [];
      } catch (_) {
        allFeeds = [];
      }
      if (!scope || scope.kind === "all") return allFeeds;
      if (scope.kind !== "feeds") return [];
      const libraryIDs = new Set((scope.libraryIDs || []).map((id) => Number(id)));
      const liveFeeds = allFeeds.filter((feed) => libraryIDs.has(Number(feed?.libraryID)));
      // A row reference remains usable while the context menu is closing, so
      // retain it as a safe fallback if Zotero has not repopulated getAll().
      if (liveFeeds.length || !Array.isArray(scope.feeds)) return liveFeeds;
      return scope.feeds.filter((feed) => libraryIDs.has(Number(feed?.libraryID)));
    }

    serializableFeedScope(scope) {
      if (!scope || scope.kind === "all") {
        return { kind: "all", label: "all feeds", libraryIDs: [] };
      }
      return {
        kind: "feeds",
        label: this.scoreScopeLabel(scope),
        libraryIDs: (scope.libraryIDs || []).map((id) => Number(id)).filter(Number.isFinite),
      };
    }

    async scoreFeedItemsWithinDays(window, requestedScope, { confirm = true, mode = "score", askDays = true } = {}) {
      // The Tools-menu commands automatically follow a selected feed or the
      // Feeds root. The collection-context command supplies its captured
      // scope explicitly so right-clicking cannot race a later selection.
      const scope = requestedScope === undefined ? this.selectedFeedScope(window) : requestedScope;
      const scopeLabel = this.scoreScopeLabel(scope);
      const configuredDays = this.loadConfig().lookbackDays;
      const rescoring = mode === "rescore";

      /*
       * "N days" asks which N.
       *
       * The command is named for a number, so it asks for one, with the configured
       * Lookback days as the default: pressing Enter keeps the old behaviour, and
       * typing a different number scores that window instead. A cancelled prompt
       * stops the command before anything is read or sent, which is the only safe
       * reading of "cancel" for a command that would otherwise spend money.
       */
      let days = configuredDays;
      if (askDays) {
        const asked = this.promptForLookbackDays(window, configuredDays, scopeLabel, { mode });
        if (asked == null) {
          this.notifyInfo("No " + (rescoring ? "rescore" : "scoring") + " was started: the number of days was not entered.");
          return;
        }
        days = asked;
      }

      return this.withWorkflowLock(window, "feed lookback scoring", async (workflow) => {
        this.throwIfCancelled(workflow);
        // This command reads the items Zotero already retains. It deliberately
        // does not refresh feeds or apply the refresh candidate limit.
        const summary = await this.collectFeedItemsWithinDays(days, workflow, scope);
        this.throwIfCancelled(workflow);
        await this.mutateState((state) => {
          this.retainLatestCandidateSnapshot(state, summary);
          return state;
        });

        if (!summary.candidates.length) {
          this.showLookbackOutcome(window, summary.refresh);
          return;
        }
        // Say which of the two functions this is, and what it will do to scores
        // that already exist: "score" fills the gaps, "rescore" replaces them.
        this.notifyInfo(
          (rescoring ? "Rescoring " : "Scoring ") + summary.candidates.length + " stored " +
            (summary.candidates.length === 1 ? "article" : "articles") + " in " + scopeLabel +
            " from " + this.lookbackRangeLabel(days) + "." +
            (rescoring ? " Stored scores in that window will be replaced." : ""),
        );
        this.throwIfCancelled(workflow);
        await this.waitForAwesomeGPT(window, 30000, workflow);
        this.throwIfCancelled(workflow);
        await this.rankAndDisplay(window, summary.candidates, {
          refresh: summary.refresh,
          workflow,
          mode,
          // An explicit N-day run re-reads the model's significance reading rather
          // than reusing the one saved with the previous score.
          rescoreArxivSignificance: true,
        });
      });
    }

    async collectFeedItemsWithinDays(days, workflow, scope = null, progress = null) {
      this.throwIfCancelled(workflow, progress);
      const feeds = this.getFeedsForScope(scope);
      const scopeData = this.serializableFeedScope(scope);
      const lookbackRange = this.lookbackRange(days);
      const refresh = {
        kind: "feed-lookback",
        startedAt: new Date().toISOString(),
        lookbackDays: days,
        lookbackStartDate: lookbackRange.startDate,
        lookbackEndDate: lookbackRange.endDate,
        scope: scopeData,
        totalFeeds: feeds.length,
        successfulFeeds: [],
        failedFeeds: [],
        scannedItemCount: 0,
        rankableItemCount: 0,
        candidateCount: 0,
        duplicateCount: 0,
        undatedItemCount: 0,
        outsideWindowItemCount: 0,
      };
      if (scope?.kind === "feeds" && !feeds.length) {
        refresh.failedFeeds.push({
          name: scopeData.label || "Selected feed",
          message: "The selected feed is no longer available.",
        });
        return { candidates: [], refresh };
      }
      if (!feeds.length) return { candidates: [], refresh };

      const matchingCandidates = [];
      for (let index = 0; index < feeds.length; index++) {
        const feed = feeds[index];
        this.throwIfCancelled(workflow, progress);
        const name = this.Core.text(feed.name) || "Unnamed feed";
        progress?.update?.(
          "Scanning " + name + " (" + (index + 1) + " of " + feeds.length + ")…",
          index,
          feeds.length,
        );
        try {
          await feed.waitForDataLoad?.("item");
          this.throwIfCancelled(workflow, progress);
          const items = await this.Zotero.Items.getAll(feed.libraryID, true, false);
          this.throwIfCancelled(workflow, progress);
          refresh.scannedItemCount += items.length;
          const rankableItems = items.filter((item) => this.isRankableItem(item));
          refresh.rankableItemCount += rankableItems.length;
          let feedMatches = 0;
          for (const item of rankableItems) {
            const candidate = this.toCandidate(item, feed);
            if (this.isWithinRequestedDays(candidate.date, days)) {
              matchingCandidates.push(candidate);
              feedMatches++;
            } else if (this.publicationDay(candidate.date)) {
              refresh.outsideWindowItemCount++;
            } else {
              // Unlike the daily new-item flow, an "within N days" request is
              // strict: undated records are reported but are not guessed to be
              // recent enough to send.
              refresh.undatedItemCount++;
            }
          }
          refresh.successfulFeeds.push({ name, itemCount: items.length, matchingItems: feedMatches });
        } catch (error) {
          if (error instanceof CancelledError) throw error;
          refresh.failedFeeds.push({ name, message: this.safeError(error) });
        }
      }

      this.throwIfCancelled(workflow, progress);
      matchingCandidates.sort((left, right) => {
        const dateOrder = String(right.date || "").localeCompare(String(left.date || ""));
        return dateOrder || String(left.id).localeCompare(String(right.id));
      });
      const deduplicated = this.Core.deduplicateCandidates(matchingCandidates);
      refresh.duplicateCount = deduplicated.duplicates.length;
      refresh.candidateCount = deduplicated.candidates.length;
      progress?.update?.(
        "Found " + refresh.candidateCount + " recent stored " +
          (refresh.candidateCount === 1 ? "article." : "articles."),
        feeds.length,
        feeds.length,
      );
      return { candidates: deduplicated.candidates, refresh };
    }

    /*
     * Wait, briefly and boundedly, for items Zotero is still saving.
     *
     * Returns the extra candidates that appeared after the refresh loop finished, so
     * a paper that landed a second late is scored and digested by THIS run instead of
     * silently waiting for the next one. Stopping as soon as a round adds nothing
     * keeps the usual case at one short wait.
     */
    async settleFeedRefresh(feeds, knownItemIDs, refresh, workflow, progress) {
      const candidates = [];
      const list = Array.isArray(feeds) ? feeds : [];
      if (!list.length) return candidates;
      for (let round = 1; round <= FEED_SETTLE_ROUNDS; round++) {
        this.throwIfCancelled(workflow, progress);
        progress?.update?.(
          "Waiting for Zotero to finish saving new feed articles" +
            (round > 1 ? " (check " + round + " of " + FEED_SETTLE_ROUNDS + ")" : "") + "…",
          0,
          1,
        );
        await this.delay(FEED_SETTLE_DELAY_MS);
        this.throwIfCancelled(workflow, progress);
        let found = 0;
        for (const feed of list) {
          try {
            const items = await this.Zotero.Items.getAll(feed.libraryID, true, false);
            for (const item of Array.isArray(items) ? items : []) {
              if (knownItemIDs.has(item.id)) continue;
              knownItemIDs.add(item.id);
              candidates.push(this.toCandidate(item, feed));
              found++;
            }
          } catch (error) {
            // A library that cannot be re-read is not a reason to fail a refresh
            // that already succeeded; the items it did return are still scored.
            if (error instanceof CancelledError) throw error;
            this.logError(new Error("FeedRank could not re-read a feed library: " + this.safeError(error)));
          }
        }
        refresh.settleRounds = round;
        if (!found) break;
        refresh.settledItemCount = (refresh.settledItemCount || 0) + found;
      }
      return candidates;
    }

    async refreshAndCollect(window, config, workflow, progress = null) {
      this.throwIfCancelled(workflow, progress);
      const feeds = this.Zotero.Feeds.getAll();
      const refresh = {
        kind: "feed-refresh",
        startedAt: new Date().toISOString(),
        totalFeeds: feeds.length,
        successfulFeeds: [],
        failedFeeds: [],
        newItemCount: 0,
        duplicateCount: 0,
        limitedCount: 0,
        fallbackUsed: false,
        fallbackScannedItemCount: 0,
        fallbackRecentItemCount: 0,
        fallbackCurrentScoreCount: 0,
        fallbackCandidateCount: 0,
        fallbackDuplicateCount: 0,
        // How the refresh waited for Zotero to finish saving, and what that found.
        settleRounds: 0,
        settledItemCount: 0,
      };
      if (!feeds.length) {
        progress?.update?.("No Zotero feeds are configured.", 1, 1);
        return { candidates: [], refresh };
      }

      const newlyCreated = [];
      // Every item id the refresh has already accounted for, so the settle check
      // below can tell "new since the update" from "already counted".
      const knownItemIDs = new Set();
      const refreshedFeeds = [];
      for (let index = 0; index < feeds.length; index++) {
        const feed = feeds[index];
        this.throwIfCancelled(workflow, progress);
        const name = this.Core.text(feed.name) || "Unnamed feed";
        progress?.update?.(
          "Refreshing " + name + " (" + (index + 1) + " of " + feeds.length + ")…",
          index,
          feeds.length,
        );
        let before;
        try {
          // Zotero's own feed scheduler waits for item data before calling the
          // per-feed updater; mirror that sequence for this manual refresh.
          await feed.waitForDataLoad?.("item");
          this.throwIfCancelled(workflow, progress);
          before = await this.Zotero.Items.getAll(feed.libraryID, true, false);
          this.throwIfCancelled(workflow, progress);
        } catch (error) {
          if (error instanceof CancelledError) throw error;
          refresh.failedFeeds.push({ name, message: this.safeError(error) });
          continue;
        }
        const beforeIDs = new Set(before.map((item) => item.id));
        for (const id of beforeIDs) knownItemIDs.add(id);
        try {
          this.throwIfCancelled(workflow, progress);
          await feed.updateFeed();
          this.throwIfCancelled(workflow, progress);
          const after = await this.Zotero.Items.getAll(feed.libraryID, true, false);
          this.throwIfCancelled(workflow, progress);
          const created = after.filter((item) => !beforeIDs.has(item.id));
          for (const item of after) knownItemIDs.add(item.id);
          newlyCreated.push(...created.map((item) => this.toCandidate(item, feed)));
          // The settle check re-reads only the feeds that actually updated; a feed
          // whose update failed cannot be the one still saving items.
          refreshedFeeds.push(feed);
          // Zotero can save items fetched before a later entry fails. Preserve
          // those real new items while reporting the feed itself as failed.
          if (feed.lastCheckError) {
            refresh.failedFeeds.push({
              name,
              message: this.Core.text(feed.lastCheckError) || "Feed update failed",
            });
          } else {
            refresh.successfulFeeds.push({ name, newItems: created.length });
          }
        } catch (error) {
          if (error instanceof CancelledError) throw error;
          refresh.failedFeeds.push({ name, message: this.safeError(error) });
        }
      }

      this.throwIfCancelled(workflow, progress);
      // Let Zotero finish saving before deciding what this run collected: an item
      // that lands a second after the refresh belongs to this run, not the next one.
      newlyCreated.push(...await this.settleFeedRefresh(
        refreshedFeeds,
        knownItemIDs,
        refresh,
        workflow,
        progress,
      ));
      this.throwIfCancelled(workflow, progress);
      refresh.newItemCount = newlyCreated.length;
      const recent = newlyCreated.filter((candidate) =>
        this.Core.withinLookback(candidate.date, config.lookbackDays),
      );
      recent.sort((left, right) => {
        const dateOrder = String(right.date || "").localeCompare(String(left.date || ""));
        return dateOrder || String(left.id).localeCompare(String(right.id));
      });
      const deduplicated = this.Core.deduplicateCandidates(recent);
      refresh.duplicateCount = deduplicated.duplicates.length;
      let candidates = deduplicated.candidates.slice(0, config.candidateLimit);
      refresh.limitedCount = Math.max(0, deduplicated.candidates.length - candidates.length);

      if (!candidates.length) {
        // A Zotero background/manual refresh can save papers just before the
        // user invokes FeedRank. New IDs can also be outside the configured
        // lookback or duplicates, leaving no eligible candidate. In either
        // case, recover only recent, currently unscored/stale feed items and
        // still require the normal user confirmation before any model call.
        progress?.update?.(
          refresh.newItemCount
            ? "No newly imported article is eligible. Checking recent stored articles…"
            : "This refresh created no new items. Checking recent stored articles…",
          feeds.length,
          feeds.length,
        );
        const fallback = await this.collectFeedItemsWithinDays(
          config.lookbackDays,
          workflow,
          null,
          progress,
        );
        this.throwIfCancelled(workflow, progress);
        const state = this.loadState();
        const unscoredOrStale = fallback.candidates.filter((candidate) => {
          try {
            const cached = state.ranks[candidate.id];
            return !cached || !this.matchesCurrentScore(cached, candidate, config);
          } catch (_) {
            // If local cache comparison cannot be made, keep the explicit
            // candidate rather than silently hiding a recent paper.
            return true;
          }
        });
        refresh.fallbackUsed = true;
        refresh.fallbackLookbackDays = config.lookbackDays;
        refresh.fallbackScannedItemCount = fallback.refresh.scannedItemCount;
        refresh.fallbackRecentItemCount = fallback.candidates.length;
        refresh.fallbackCurrentScoreCount = Math.max(
          0,
          fallback.candidates.length - unscoredOrStale.length,
        );
        refresh.fallbackCandidateCount = unscoredOrStale.length;
        refresh.fallbackDuplicateCount = fallback.refresh.duplicateCount;
        refresh.duplicateCount = fallback.refresh.duplicateCount;
        candidates = unscoredOrStale.slice(0, config.candidateLimit);
        refresh.limitedCount = Math.max(0, unscoredOrStale.length - candidates.length);
        if (candidates.length) refresh.candidateSource = "recent-stored";
      }
      progress?.update?.(
        candidates.length
          ? "Found " + candidates.length + " " +
            (candidates.length === 1 ? "article" : "articles") + " ready to score."
          : "No new or unscored recent feed articles were found.",
        feeds.length,
        feeds.length,
      );
      return { candidates, refresh };
    }

    toCandidate(item, feed) {
      const creators = typeof item.getCreators === "function"
        ? item.getCreators().map((creator) =>
          this.Core.text(creator.name || [creator.firstName, creator.lastName].filter(Boolean).join(" ")),
        ).filter(Boolean)
        : [];
      const getField = (field) => {
        try {
          return this.Core.text(item.getField(field));
        } catch (_) {
          return "";
        }
      };
      const getRawField = (field) => {
        try {
          return String(item.getField(field) ?? "");
        } catch (_) {
          return "";
        }
      };
      const itemKey = this.Core.text(item.key) || String(item.id);
      const url = getField("url");
      const doi = getField("DOI");
      const publicationTitle = getField("publicationTitle");
      const archive = getRawField("archive");
      const archiveLocation = getRawField("archiveLocation");
      const callNumber = getRawField("callNumber");
      const arxivSources = [getRawField("extra"), url];
      if (/\barxiv\b/i.test(archive) || /\barxiv\b/i.test(archiveLocation)) {
        arxivSources.push(archiveLocation, callNumber);
      }
      // DOI 10.48550/arXiv.<identifier> is an explicit arXiv DOI. Do not
      // treat arbitrary journal DOI number fragments as arXiv identifiers.
      if (/^10\.48550\/arxiv\./i.test(doi)) arxivSources.push(doi);
      const arxiv = arxivSources.map((value) => this.Core.normalizeArxiv(value)).find(Boolean) || "";
      const institutions = [...new Set([
        getField("institution"),
        getField("university"),
        getField("affiliation"),
      ].filter(Boolean))];
      return {
        id: String(item.libraryID) + ":" + itemKey,
        itemID: item.id,
        libraryID: item.libraryID,
        guid: this.Core.text(item.guid),
        title: this.Core.text(item.getDisplayTitle?.() || getField("title")),
        abstract: getField("abstractNote"),
        authors: creators,
        date: getField("date"),
        doi,
        arxiv,
        isArxiv: Boolean(arxiv),
        url,
        source: this.Core.text(feed?.name) || "Unnamed feed",
        publicationTitle,
        itemType: this.Core.text(item.itemType),
        institutions,
        affiliations: institutions,
        institution: institutions[0] || "",
        // Journal metrics come from FeedRank's own EasyScholar lookup, cached
        // and keyed by the publication title. FeedRank never writes to the item
        // unless the user has explicitly enabled saving to Extra.
        journalEvidence: this.journalEvidenceForPublication(publicationTitle),
        // Ride the live item along so the pre-scoring journal refresh can write
        // Extra on the real record. Stripped by withoutLiveItems() before any
        // serialization or persistence.
        [LIVE_ITEM]: item,
      };
    }

    // The cached EasyScholar result for one publication title, in the shape the
    // Priority calculation expects. Returns an unavailable marker rather than
    // null so callers can report "not looked up yet" distinctly.
    journalEvidenceForPublication(publicationTitle) {
      const journal = this.Zotero.FeedRankJournal;
      const title = this.Core.text(publicationTitle);
      if (!journal?.cachedResult || !title) {
        return { source: "easyscholar", impactFactor: null, fiveYearImpactFactor: null, jcrQuartile: "", available: false };
      }
      try {
        const result = journal.cachedResult(title);
        return result ? this.Core.normalizeJournalEvidence(result) : {
          source: "easyscholar",
          impactFactor: null,
          fiveYearImpactFactor: null,
          jcrQuartile: "",
          available: false,
        };
      } catch (_) {
        return { source: "easyscholar", impactFactor: null, fiveYearImpactFactor: null, jcrQuartile: "", available: false };
      }
    }

    async waitForAwesomeGPT(preferredWindow, timeoutMs, workflow, progress = null) {
      const deadline = Date.now() + timeoutMs;
      do {
        this.throwIfCancelled(workflow, progress);
        const window = this.getActiveMainWindow(preferredWindow);
        const request = window?.Meet?.OpenAI?.getGPTResponse;
        if (typeof request === "function") {
          this.throwIfCancelled(workflow, progress);
          return { window, request: request.bind(window.Meet.OpenAI) };
        }
        await this.delay(250);
        this.throwIfCancelled(workflow, progress);
      } while (Date.now() < deadline);
      this.throwIfCancelled(workflow, progress);
      throw new Error("Awesome GPT's per-window request bridge is not ready");
    }

    /*
     * Refresh EasyScholar journal information for the papers about to be
     * scored, then make the results visible to the Priority calculation.
     *
     * Two things happen here and they are deliberately separate:
     *   1. the cache is refreshed, so local Priority uses current numbers;
     *   2. when the user has opted in, the metrics are mirrored into each
     *      item's Extra field under the established labels, so they survive
     *      without FeedRank's cache.
     *
     * This never blocks a scoring run. A missing key, a disabled option, a
     * network failure or a cancel all degrade to "score with whatever evidence
     * is already cached", and the reason is reported rather than thrown.
     */
    async refreshJournalForScoring(candidates, { window, workflow = null, progress = null } = {}) {
      const journal = this.Zotero.FeedRankJournal;
      if (!journal?.refreshForScoring) return { attempted: false, reason: "unavailable" };
      const journalConfig = journal.loadConfig?.() || {};
      if (journalConfig.lookupEnabled !== true) return { attempted: false, reason: "disabled" };
      // Mirroring the metrics into each item's Extra field is not optional and
      // is not gated on the network: a resolved journal is written to the item,
      // Green Frog style. A cached entry inside the reuse window is written
      // without any request; a stale one is skipped rather than presented as
      // current. Only the re-read is behind an option.
      const wantRefresh = journalConfig.refreshBeforeScoring === true;
      // Resolve each candidate back to its live item so the Extra write targets
      // the real record, not a detached snapshot.
      const entries = [];
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const title = this.Core.text(candidate?.publicationTitle);
        if (!title) continue;
        // Prefer the live item carried on the candidate; fall back to the
        // Zotero registry for a candidate reconstructed from saved state.
        const item = candidate?.[LIVE_ITEM] || this.currentItemForRecord(candidate);
        entries.push({ publicationTitle: title, item });
      }
      if (!entries.length) return { attempted: false, reason: "no-publication-title" };

      const journalCount = new Set(
        entries.map((entry) => this.Core.text(entry.publicationTitle).toLowerCase()),
      ).size;
      progress?.update?.(
        (wantRefresh ? "Checking journal information for " : "Saving journal information for ") +
          journalCount + (journalCount === 1 ? " journal…" : " journals…"),
        0,
        journalCount,
      );
      let outcome;
      try {
        outcome = await journal.refreshForScoring(entries, {
          parentWindow: window,
          // A fetch-shaped function, never Zotero.HTTP.request: that API logs the URL and
          // redacts only a lowercase `key=`, so it would record the EasyScholar secret from
          // the `secretKey` parameter. See journal-service.js.
          request: typeof fetch === "function" ? fetch : null,
          refresh: wantRefresh,
          save: true,
          shouldStop: () => this.isCancelled(workflow, progress),
          onProgress: (name, index, total) => {
            progress?.update?.(this.t("progress.journalChecked", { name }), index - 1, total);
          },
        });
      } catch (error) {
        // A journal lookup is an enhancement; it must never turn a scoring run
        // into a failure.
        this.logError(new Error("Journal refresh before scoring failed: " + this.safeError(error)));
        return { attempted: true, reason: "error" };
      }
      if (outcome?.reason === "cancelled") this.throwIfCancelled(workflow, progress);
      if (outcome?.looked) {
        progress?.update?.(
          "Journal information updated for " + outcome.looked +
            (outcome.looked === 1 ? " journal." : " journals."),
          journalCount,
          journalCount,
        );
      }
      return outcome || { attempted: true, reason: "" };
    }

    /*
     * Ask the model for a fresh arXiv qualitative-significance reading for the
     * given arXiv candidates, instead of reusing the one saved with an earlier
     * score.
     *
     * The significance value is part of the scoring RESPONSE, so there is no way
     * to refresh it without another model call. This is therefore offered only
     * on an explicit, user-initiated scoring run — a re-score would otherwise
     * keep showing a stale significance indefinitely, because the value only
     * changes when the prompt inputs change and caches on identical metadata.
     *
     * Relevance score, confidence, and the explanation are refreshed in the same
     * call and cached normally; only the "is this cached score still usable"
     * decision changes.
     */
    arxivSignificanceToRecompute(candidates, { rescore = false } = {}) {
      const ids = new Set();
      if (rescore !== true) return ids;
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const id = this.Core.text(candidate?.id);
        if (!id) continue;
        // Only a candidate that actually carries arXiv metadata is asked about;
        // the response contract rejects a significance value on a journal item.
        if (!this.Core.hasSuppliedArxivMetadata(candidate)) continue;
        ids.add(id);
      }
      return ids;
    }

    async rankAndDisplay(window, candidates, {
      refresh = {},
      /*
       * The two scoring functions, and only two.
       *
       * "score" (the default) fills in what is missing: a stored score whose
       * question is unchanged is reused, and nothing is sent to the model for it.
       * "rescore" replaces what is stored: every candidate is scored again and its
       * record is overwritten. `force` remains as the older spelling of "rescore"
       * so an already-open dialog from a previous version keeps working.
       */
      mode = "score",
      force = false,
      workflow,
      digestRun = null,
      // An already-open progress window to report through, so a caller with earlier
      // stages (the scheduled run: refresh, settle, then scoring) does not open a
      // second one.
      progress: adoptedProgress = null,
      // A user-invoked run re-reads the model's significance rather than reusing
      // a saved one. The scheduled weekly run leaves it false so it stays cheap.
      rescoreArxivSignificance = false,
      /*
       * Whether this run may leave its results dialog on screen.
       *
       * True for everything the user asks for, because the window is the result of
       * what they asked for. False for the scheduled run, which nobody asked for:
       * the dialog is about papers the user did not select, it appears while the
       * machine works unattended, and it stays until it is closed by hand.
       */
      showResults = true,
    } = {}) {
      const rescore = mode === "rescore" || force === true;
      this.throwIfCancelled(workflow);
      const config = this.loadConfig();
      // Refresh journal information for exactly the papers about to be scored,
      // before any Priority is calculated or any model call is made. This is
      // the single choke point every scoring path passes through — selected
      // items, an N-day scan, a rescore, a manual refresh and the daily startup
      // run — so none of them can score against stale or missing evidence.
      // It is a no-op unless EasyScholar lookup is enabled and has a key, and it
      // never blocks scoring on failure.
      //
      // The whole run reports through ONE progress window: the journal step and
      // the scoring step are two stages of the same operation, so opening a
      // second dialog for the second stage only made the run look like two
      // separate prompts. A caller that already opened one for its own stages --
      // the scheduled run, whose refresh and settle happen before scoring -- hands
      // it in here, so the whole job is still exactly one window.
      const progress = adoptedProgress || this.createProgress(window, this.t("progress.scoring"));
      progress.workflow = workflow || null;
      progress.setTitle?.(this.t("progress.scoring"));
      this.activeProgress = progress;
      if (workflow) workflow.progress = progress;
      let completedUsageCalls = [];
      try {
        this.reportJournalOutcome(await this.refreshJournalForScoring(candidates, {
          window, workflow, progress,
        }), { window });
        this.throwIfCancelled(workflow, progress);

        const state = this.loadState();
        const cacheHits = [];
        const toRank = [];
        // A rescore replaces stored records; a normal score never does. In "score"
        // mode a stored record counts as usable when its question is unchanged, and
        // a candidate whose stored score is stale (the profile or language changed)
        // is re-scored because that old answer belongs to a different question.
        const restaleCount = [];
        // An explicit run re-reads the model's arXiv significance instead of
        // reusing the saved one. Everything else about a cached score still has to
        // match; this only overrides the reuse decision for arXiv candidates.
        const significanceRefresh = this.arxivSignificanceToRecompute(candidates, {
          rescore: rescoreArxivSignificance,
        });
        for (const candidate of candidates) {
          const fingerprint = this.Core.cacheFingerprint(candidate, config);
          const cached = state.ranks[candidate.id];
          const needsFreshSignificance = significanceRefresh.has(this.Core.text(candidate?.id));
          // A cached score is reused whenever the QUESTION is unchanged. Dispatch
          // settings are not part of that question, and a record saved by an older
          // build is accepted too, so an upgrade or a settings change never sends a
          // paper to the model again for an answer that is already stored.
          if (!rescore && !needsFreshSignificance && cached && this.matchesCurrentScore(cached, candidate, config)) {
            // Priority is local-only. Recalculate it under the current optional
            // weights instead of paying for another Awesome GPT request.
            cacheHits.push(this.withLocalPriority(cached, config));
          } else {
            if (cached) restaleCount.push(candidate.id);
            toRank.push({ candidate, fingerprint });
          }
        }
        // What the run is about to do, said plainly: a rescore replaces stored
        // records, and a normal score only fills the gaps (or refreshes an answer
        // whose question changed).
        this.lastRunSplit = {
          mode: rescore ? "rescore" : "score",
          reused: cacheHits.length,
          newlyScored: toRank.length - restaleCount.length,
          replaced: rescore ? toRank.length : restaleCount.length,
        };

        if (!toRank.length) {
          this.throwIfCancelled(workflow, progress);
          const completedRecords = this.Core.sortRankings(cacheHits);
          // The digest is the WEEK's eligible scores, not this run's candidate list,
          // so the argument here is the run and the window -- not the records.
          await this.recordCompletedDigest(digestRun, window);
          if (showResults !== false) {
            this.openResults(window, completedRecords, {
              refresh,
              cachedCount: cacheHits.length,
              usageCalls: [],
              message: "All selected feed articles already have matching cached scores. " +
                "Nothing was sent to the model; use a Rescore command to replace those scores.",
            });
          }
          return;
        }

        this.throwIfCancelled(workflow, progress);
        const split = this.lastRunSplit || { mode: "score", reused: 0, newlyScored: 0, replaced: 0 };
        progress.update(
          this.scoringProgressMessage(toRank.length, 0, 1, Math.ceil(toRank.length / config.batchSize)) +
            (cacheHits.length
              ? " " + cacheHits.length + " " +
                (cacheHits.length === 1 ? "article already has" : "articles already have") +
                " a current cached score and will not be sent again."
              : "") +
            (rescore
              ? " Rescore: the stored scores in scope will be replaced."
              : split.replaced
                ? " " + split.replaced + " stored " + (split.replaced === 1 ? "score is" : "scores are") +
                  " being refreshed because the profile or language changed."
                : ""),
          0,
          toRank.length,
        );
        const { records, usageCalls } = await this.rankBatches(window, toRank, config, progress, workflow);
        completedUsageCalls = usageCalls;
        this.throwIfCancelled(workflow, progress);

        // Atomic cache commit: no response becomes cached until every batch has
        // passed strict validation and the entire run is still active.
        this.throwIfCancelled(workflow, progress);
        await this.mutateState((latestState) => {
          for (const record of records) latestState.ranks[record.id] = record;
          latestState.lastCandidates = cloneJSON(candidates);
          latestState.lastRefresh = cloneJSON(refresh);
          latestState.lastUsageCalls = cloneJSON(usageCalls);
          // Keep the exact cumulative accounting separately from the bounded
          // per-call sample persisted by saveState(). A later email mutation
          // must not turn a large completed run into a total for only its last
          // few displayed calls.
          latestState.lastUsageTotal = this.Core.aggregateUsage(usageCalls);
          latestState.lastUsageCallCount = usageCalls.length;
          return latestState;
        });
        this.refreshRankColumn();
        // Item-pane rendering is a convenience UI enhancement. Its failure
        // must never turn a successfully cached feed run into a reported
        // scoring failure, particularly after a large N-day batch.
        try {
          await this.refreshScoreDetailsPane();
        } catch (error) {
          this.logError(new Error("Could not refresh FeedRank score details: " + this.safeError(error)));
        }
        // Mirror the new scores into the items themselves, the way Green Frog
        // mirrors its journal metrics: a managed line in Extra, saved on the item,
        // so the score travels with the paper through Zotero's own sync. Failures
        // are logged, never propagated: the run is already committed.
        try {
          await this.mirrorScoresToExtra(records);
        } catch (error) {
          this.logError(new Error("Could not write FeedRank scores to item Extra fields: " + this.safeError(error)));
        }
        this.throwIfCancelled(workflow, progress);
        const completedRecords = this.Core.sortRankings([...cacheHits, ...records]);
        // Scoring is committed; the digest is rebuilt from the week's eligible scores
        // and then sent, which is the order the reader asked for.
        await this.recordCompletedDigest(digestRun, window);
        if (showResults !== false) {
          this.openResults(window, completedRecords, {
            refresh,
            cachedCount: cacheHits.length,
            usageCalls,
            usageTotal: this.Core.aggregateUsage(usageCalls),
            usageCallCount: usageCalls.length,
            message: "Scoring completed with Awesome GPT.",
          });
        }
      } catch (error) {
        // Batches can complete and be billable even when the subsequent local
        // preference/shard commit fails. Preserve the complete run total so the
        // caller reports it instead of implying that the operation cost nothing.
        if (completedUsageCalls.length && error && typeof error === "object" && !error.feedRankUsage) {
          try {
            error.feedRankUsage = this.Core.aggregateUsage(completedUsageCalls);
          } catch (_) {}
        }
        throw error;
      } finally {
        this.endWorkflowProgress(workflow, progress);
      }
    }

    scoringProgressMessage(totalPapers, completedPapers, batchNumber, batchTotal, stage = "Scoring") {
      const total = Math.max(1, Math.floor(Number(totalPapers) || 0));
      const completed = Math.max(0, Math.min(total, Math.floor(Number(completedPapers) || 0)));
      const remaining = total - completed;
      const word = (n) => (n === 1 ? "article" : "articles");
      const batch = Math.max(1, Math.floor(Number(batchNumber) || 1));
      const batches = Math.max(1, Math.floor(Number(batchTotal) || 1));
      return stage + " " + total + " " + word(total) + "; " + remaining + " " +
        word(remaining) + " remaining (batch " + batch + " of " + batches + ")…";
    }

    /*
     * Dispatch every batch, up to `config.batchConcurrency` at a time.
     *
     * The work is I/O-bound — each batch is one round-trip to the provider — so a
     * sequential loop made the run cost the SUM of every request. Dispatching a few
     * at once turns that into roughly `total / concurrency`, which is the single
     * largest speedup available.
     *
     * Two invariants are preserved exactly:
     *
     *   1. **Atomic cache commit.** Every batch is still collected into `results`
     *      and returned; `rankAndDisplay` writes nothing until all of them have
     *      passed validation. Concurrency does not weaken "a later invalid batch
     *      prevents every provisional batch from entering cache".
     *   2. **Truthful accounting.** Usage is accumulated as batches settle and
     *      reported as a running total, so a cancellation or a failure carries the
     *      real billable figure for everything dispatched so far — including
     *      requests still in flight.
     *
     * Concurrency is capped at 1 by default, which is byte-for-byte the previous
     * behaviour.
     */
    async rankBatches(window, candidatesWithFingerprints, config, progress, workflow) {
      const batches = [];
      for (let index = 0; index < candidatesWithFingerprints.length; index += config.batchSize) {
        batches.push(candidatesWithFingerprints.slice(index, index + config.batchSize));
      }
      const results = [];
      const usageCalls = [];
      const totalPapers = candidatesWithFingerprints.length;
      let completedPapers = 0;
      let nextBatch = 0;
      let firstError = null;
      const concurrency = Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, Number(config.batchConcurrency) || 1));
      const parallel = concurrency > 1;
      let lastProgressAt = 0;

      const reportCumulativeUsage = () => {
        if (!usageCalls.length) return;
        progress.reportUsage?.(
          "Cumulative total for this ranking (" + usageCalls.length + " call" +
            (usageCalls.length === 1 ? "" : "s") + "): " +
            this.Core.formatUsage(this.Core.aggregateUsage(usageCalls), config),
        );
      };

      /*
       * One coherent progress line for a parallel run.
       *
       * With several calls in flight, the per-call figures are not a sequence: the
       * call number a worker is about to send and the per-call stage arrive
       * interleaved from different workers, so a line built from them jumps
       * backwards and forwards several times a second -- "call 1", "call 3", "call
       * 2" -- which is the flicker. A parallel run has no single "current call" to
       * name, so the line is built only from quantities that never decrease:
       * articles done, out of the articles in this run. The stage is reported only
       * when it says something the counters cannot, which is a retry.
       */
      const reportParallelProgress = (stage = "", force = false) => {
        const now = Date.now();
        if (!force && now - lastProgressAt < PARALLEL_PROGRESS_INTERVAL_MS) return;
        lastProgressAt = now;
        const retry = this.Core.text(stage).match(/retry\s+(\d+)/i);
        progress.update(
          "Scoring " + totalPapers + " " + (totalPapers === 1 ? "article" : "articles") +
            " · " + completedPapers + " of " + totalPapers + " done" +
            (retry ? " · retrying a call (attempt " + retry[1] + ")" : "") + "…",
          completedPapers,
          totalPapers,
        );
      };

      const collectBatch = (batch, scored) => {
        usageCalls.push(...scored.usageCalls);
        reportCumulativeUsage();
        for (const paper of scored.papers) {
          const entry = batch.find(({ candidate }) => candidate.id === paper.id);
          const record = {
            ...cloneJSON(entry.candidate),
            score: paper.score,
            confidence: paper.confidence,
            reason: paper.reason,
            fingerprint: entry.fingerprint,
            configFingerprint: this.scoreConfigFingerprint(config),
            rankedAt: new Date().toISOString(),
          };
          // The validator accepts these only for a supplied arXiv item and
          // bounds both values. They are an optional qualitative local
          // signal, never a replacement for the relevance score.
          if (Number.isInteger(paper.arxivSignificance)) {
            record.arxivSignificance = paper.arxivSignificance;
            if (typeof paper.arxivSignificanceReason === "string") {
              record.arxivSignificanceReason = paper.arxivSignificanceReason;
            }
          }
          /*
           * The model's journal-standing estimate, when the lookup found no metrics.
           *
           * Asked for after "if easy scholar cannot retreve journal information, try to
           * get a score for GPT too": the validator requires it for exactly the papers
           * with no journal object in the payload and forbids it for the rest, so it
           * can never shadow a verified impact factor.
           */
          if (Number.isInteger(paper.journalSignificance)) {
            record.journalSignificance = paper.journalSignificance;
            if (typeof paper.journalSignificanceReason === "string") {
              record.journalSignificanceReason = paper.journalSignificanceReason;
            }
          }
          // Keep the LLM relevance score and the transparent local priority
          // calculation distinct. EasyScholar journal data and offline
          // fallback keywords never enter the prompt; the optional
          // model-provided arXiv qualitative field is part of the prompt.
          results.push({
            ...record,
            ...this.Core.calculateLocalPriority({
              score: paper.score,
              candidate: record,
              journalEvidence: record.journalEvidence,
              config,
            }),
          });
        }
        completedPapers += batch.length;
      };

      // One worker per slot. Each pulls the next unclaimed batch, so a slow batch
      // does not block its slot's queue and no batch is dispatched twice.
      const runWorker = async () => {
        for (;;) {
          // A failure or a cancellation stops NEW dispatches. Batches already in
          // flight are awaited, so their usage is still counted.
          if (firstError || this.isCancelled(workflow, progress)) return;
          const index = nextBatch++;
          if (index >= batches.length) return;
          const batch = batches[index];
          if (parallel) {
            // No call number here: three calls are in flight and any one of them
            // would be wrong to name as "the current" one.
            reportParallelProgress("", true);
          } else {
            progress.update(
              this.scoringProgressMessage(totalPapers, completedPapers, index + 1, batches.length),
              completedPapers,
              totalPapers,
            );
          }
          try {
            const scored = await this.rankOneBatch(
              window,
              batch,
              config,
              progress,
              index + 1,
              batches.length,
              workflow,
              {
                completedPapers,
                totalPapers,
                // In parallel mode the per-call stage is routed to the aggregate
                // line instead of overwriting it with this call's own counters.
                onStage: parallel ? (stage) => reportParallelProgress(stage) : null,
              },
            );
            if (firstError) {
              // The run is already failing; keep the usage, discard the scores.
              usageCalls.push(...scored.usageCalls);
              reportCumulativeUsage();
              return;
            }
            collectBatch(batch, scored);
            if (parallel) reportParallelProgress("", true);
          } catch (error) {
            // The first failure decides the outcome; the rest are awaited only so
            // their billable usage is not lost.
            if (!firstError) firstError = error;
            return;
          }
        }
      };

      let finalError = null;
      try {
        this.throwIfCancelled(workflow, progress);
        await Promise.all(
          Array.from({ length: Math.min(concurrency, Math.max(1, batches.length)) }, () => runWorker()),
        );
        if (firstError) {
          finalError = firstError;
        } else {
          // Reached only when nothing was dispatched, or every dispatched batch
          // succeeded. `throwIfCancelled` returns undefined when the run is still
          // live, so this assigns only a real cancellation.
          finalError = this.throwIfCancelled(workflow, progress) || null;
        }
        if (finalError) throw finalError;
      } catch (error) {
        /*
         * Report the total for EVERY call this run made, not one batch's share.
         *
         * Two sources have to be combined, and an earlier revision lost one of
         * them: `error.feedRankUsageCalls` holds the calls of the batch that
         * failed (attached inside `rankOneBatch`), while `usageCalls` holds every
         * batch that already succeeded, plus any that settled while the failure was
         * propagating. `rankOneBatch` also sets `feedRankUsage` from its own calls
         * before rethrowing, so that pre-set figure must be recomputed rather than
         * trusted. A cancellation raised while several batches were still in flight
         * is precisely the case where the in-flight calls matter most.
         */
        const failedCalls = Array.isArray(error?.feedRankUsageCalls) ? error.feedRankUsageCalls : [];
        usageCalls.push(...failedCalls);
        if (usageCalls.length && error && typeof error === "object") {
          error.feedRankUsage = this.Core.aggregateUsage(usageCalls);
          progress.reportUsage?.(
            "Partial total for this ranking (" + usageCalls.length + " call" +
              (usageCalls.length === 1 ? "" : "s") + "): " +
              this.Core.formatUsage(error.feedRankUsage, config),
          );
        }
        throw error;
      }
      this.throwIfCancelled(workflow, progress);
      progress.update(
        "Scoring complete: " + totalPapers +
          (totalPapers === 1 ? " article scored; 0 articles remaining." : " articles scored; 0 articles remaining."),
        totalPapers,
        totalPapers,
      );
      return { records: results, usageCalls };
    }

    async rankOneBatch(window, batch, config, progress, batchNumber, batchTotal, workflow, paperProgress = null) {
      const prompt = this.Core.buildRankingPrompt({
        candidates: batch.map(({ candidate }) => candidate),
        profile: config.profile,
        explanationLanguage: config.explanationLanguage,
      });
      const suppliedTotal = Number(paperProgress?.totalPapers);
      const totalPapers = Number.isSafeInteger(suppliedTotal) && suppliedTotal >= batch.length
        ? suppliedTotal
        : batch.length;
      const suppliedCompleted = Number(paperProgress?.completedPapers);
      const completedPapers = Number.isSafeInteger(suppliedCompleted)
        ? Math.max(0, Math.min(suppliedCompleted, totalPapers - batch.length))
        : 0;
      const updateBatchProgress = (stage) => {
        // A parallel run reports through one aggregate line instead: see
        // reportParallelProgress. Its counters are monotone, so the window cannot
        // flicker between the calls that happen to be in flight.
        if (typeof paperProgress?.onStage === "function") {
          paperProgress.onStage(stage);
          return;
        }
        progress.update(
          this.scoringProgressMessage(totalPapers, completedPapers, batchNumber, batchTotal, stage),
          completedPapers,
          totalPapers,
        );
      };
      let lastError;
      const usageCalls = [];
      // A cancellation can occur after an earlier retry was dispatched. Keep
      // its non-sensitive accounting with the CancelledError so rankBatches()
      // can report a truthful partial total instead of treating it as free.
      const attachUsageCalls = (error) => {
        if (usageCalls.length && error && typeof error === "object") {
          error.feedRankUsageCalls = usageCalls.slice();
        }
        return error;
      };
      const throwIfCancelledWithUsage = () => {
        try {
          this.throwIfCancelled(workflow, progress);
        } catch (error) {
          throw attachUsageCalls(error);
        }
      };
      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        throwIfCancelledWithUsage();
        let providerUsage = null;
        let usageRecorded = false;
        // Set only after the bridge request returns normally. A synchronous
        // throw proves no request object was handed back, whereas a rejected
        // promise may already represent a provider-side, billable dispatch.
        let dispatchConfirmed = false;
        const recordUsage = (response = "") => {
          if (usageRecorded) return;
          usageRecorded = true;
          const usage = {
            batchNumber,
            batchTotal,
            attempt: attempt + 1,
            ...this.Core.normalizeUsage(providerUsage, prompt, response),
          };
          usageCalls.push(usage);
          progress.reportUsage?.(
            "Batch " + batchNumber + " call " + (attempt + 1) + ": " + this.Core.formatUsage(usage, config),
          );
        };
        const recordUnknownUsage = () => {
          if (usageRecorded || !dispatchConfirmed) return;
          usageRecorded = true;
          // The bridge did not provide usage or a response. Retain only the
          // locally estimated prompt tokens as a lower bound; do not invent
          // output tokens, a total, or a final cost for an uncertain call.
          const inputTokens = this.Core.estimateTokens(prompt);
          const usage = {
            batchNumber,
            batchTotal,
            attempt: attempt + 1,
            inputTokens,
            outputTokens: 0,
            totalTokens: inputTokens,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            source: "unknown",
            usageUnknown: true,
          };
          usageCalls.push(usage);
          progress.reportUsage?.(
            "Batch " + batchNumber + " call " + (attempt + 1) + ": " + this.Core.formatUsage(usage, config),
          );
        };
        try {
          updateBatchProgress("Sending" + (attempt ? " retry " + attempt + " for" : ""));
          const bridge = await this.waitForAwesomeGPT(window, 15000, workflow);
          throwIfCancelledWithUsage();
          const requestResult = bridge.request(prompt, {
            // These flags are verified in installed Awesome GPT 3.1.179. They
            // keep this background request out of existing chat DOM/history.
            background: true,
            includeHistory: false,
            includeSidepanelHistory: false,
            throwOnError: true,
            isCancelled: () => this.isCancelled(workflow, progress),
            onCancelled: () => {
              if (workflow) workflow.cancel("provider cancelled");
              else progress.cancel("provider cancelled");
            },
            onXhr: (xhr) => progress.attachXHR(xhr),
            callback: () => updateBatchProgress("Receiving"),
            requestTimeoutMs: config.requestTimeoutMs,
            // Direct Awesome GPT providers forward this value. Browser
            // connector mode does not, in which case normalizeUsage() labels
            // the locally computed count as an estimate.
            usageCallback: (usage) => { providerUsage = usage; },
          });
          dispatchConfirmed = true;
          const response = await requestResult;
          progress.attachXHR(null);
          throwIfCancelledWithUsage();
          recordUsage(response);
          const validation = this.Core.validateRankingResponse(
            response,
            batch.map(({ candidate }) => candidate),
          );
          if (!validation.ok) {
            throw new Error("Invalid JSON scoring response: " + validation.errors.join("; "));
          }
          return { papers: validation.papers, usageCalls };
        } catch (error) {
          progress.attachXHR(null);
          // A provider can deliver usage before surfacing an error. Report it
          // immediately rather than silently losing a billable failed attempt.
          if (providerUsage && !usageRecorded) recordUsage();
          // If the request was handed to the bridge but settles without its
          // usage callback, it may still be billable. Preserve a lower-bound
          // input estimate rather than adding a fictional response amount.
          recordUnknownUsage();
          if (this.isCancelled(workflow, progress) || error instanceof CancelledError) {
            throw attachUsageCalls(new CancelledError());
          }
          lastError = error;
          if (attempt < config.maxRetries) {
            await this.delay(500 * (attempt + 1));
            throwIfCancelledWithUsage();
          }
        }
      }
      const terminalError = lastError instanceof Error
        ? lastError
        : new Error(this.safeError(lastError || "Scoring request failed"));
      // `rankBatches()` uses this non-sensitive accounting data to show a
      // partial total if a later batch fails. It contains token counts only—
      // never a prompt, response, or provider credential.
      attachUsageCalls(terminalError);
      throw terminalError;
    }

    /*
     * Every confirmation dialog is gone, deliberately.
     *
     * `confirmScore` used to ask "Score N articles using Awesome GPT?" before any
     * provider request, and `promptForLookbackDays` asked for the day window. Both
     * are removed: each guarded an action the user had already chosen by clicking
     * it, and neither is irreversible. The one thing that genuinely IS
     * irreversible — putting a message on the wire over SMTP — is guarded by a
     * setting the user controls rather than by a dialog.
     *
     * `this.Services.prompt` is still used for the results window's own input and
     * for the fallback alert when the passive notice channel is unavailable.
     */

    createProgress(window, title) {
      const controller = {
        cancelled: false,
        currentXHR: null,
        dialog: null,
        lastUsage: "",
        lastMessage: "Preparing…",
        current: 0,
        total: 1,
        cancel: () => {
          controller.cancelled = true;
          try {
            controller.currentXHR?.abort?.();
          } catch (_) {
            // The provider may already have settled the request.
          }
          controller.update("Cancel requested…", 0, 1);
        },
        attachXHR: (xhr) => {
          controller.currentXHR = xhr || null;
          if (controller.cancelled) {
            try {
              controller.currentXHR?.abort?.();
            } catch (_) {}
          }
        },
        update: (message, current, total) => {
          controller.lastMessage = String(message || "");
          controller.current = Number(current) || 0;
          controller.total = Math.max(1, Number(total) || 1);
          try {
            controller.dialog?.FeedRankerProgress?.update(
              controller.lastMessage,
              controller.current,
              controller.total,
            );
          } catch (_) {
            // The dialog can be closing while a request settles.
          }
        },
        reportUsage: (message) => {
          controller.lastUsage = String(message || "");
          try {
            controller.dialog?.FeedRankerProgress?.setUsage?.(controller.lastUsage);
          } catch (_) {
            // The dialog can still be loading; the load listener below replays
            // the latest usage line once its script is available.
          }
        },
        setTitle: (nextTitle) => {
          controller.title = String(nextTitle || "");
          try {
            controller.dialog?.FeedRankerProgress?.setTitle?.(controller.title);
          } catch (_) {
            // Same as above: replay on load.
          }
        },
        close: () => {
          try {
            if (controller.dialog && !controller.dialog.closed) controller.dialog.close();
          } catch (_) {}
        },
      };
      const args = {
        title,
        cancel: controller.cancel,
        lastUsage: "",
        initialMessage: controller.lastMessage,
        initialCurrent: controller.current,
        initialTotal: controller.total,
      };
      const dialog = window.openDialog(
        "chrome://feedranker/content/progress.xhtml",
        "feed-ranker-progress",
        // Dependent, like every other FeedRank window: a run refreshes the item tree
        // and the item pane, and Zotero raising its own window must not bury the
        // progress (and its Cancel button) behind it.
        "chrome,dialog=no,dependent=yes,resizable,centerscreen,width=470,height=180",
        args,
      );
      controller.dialog = dialog;
      try {
        dialog?.addEventListener?.("load", () => {
          try {
            dialog.FeedRankerProgress?.update?.(
              controller.lastMessage,
              controller.current,
              controller.total,
            );
            dialog.FeedRankerProgress?.setUsage?.(controller.lastUsage);
            if (controller.title) dialog.FeedRankerProgress?.setTitle?.(controller.title);
          } catch (_) {}
        }, { once: true });
      } catch (_) {}
      return controller;
    }

    openResults(window, records, summary) {
      const config = this.loadConfig();
      // Read current Zotero item evidence synchronously when it is already
      // loaded, so a completed EasyScholar lookup is visible in the results
      // window without altering the score cache or calling Awesome GPT again.
      const localRecords = (Array.isArray(records) ? records : []).map((record) =>
        this.withLocalPriority(record, config),
      ).filter(Boolean);
      const allUsageCalls = Array.isArray(summary?.usageCalls) ? summary.usageCalls : [];
      // Progress reports every call while a run is active. Keep the dialog
      // responsive for a batch-size-one N-day run by retaining only the most
      // recent per-call details here as well; its aggregate remains exact.
      const rawUsageCalls = allUsageCalls.length > MAX_PERSISTED_USAGE_CALLS
        ? allUsageCalls.slice(-MAX_PERSISTED_USAGE_CALLS)
        : allUsageCalls;
      const usageCalls = rawUsageCalls.map((usage) => ({
        ...usage,
        display: this.Core.formatUsage(usage, config),
      }));
      const suppliedUsageTotal = this.compactUsageTotal(summary?.usageTotal);
      const suppliedUsageCallCount = boundedStateCount(summary?.usageCallCount);
      const usageCallCount = Math.max(suppliedUsageCallCount, allUsageCalls.length);
      const usageTotal = usageCallCount
        ? suppliedUsageTotal || this.Core.aggregateUsage(allUsageCalls)
        : null;
      const usageHistoryTruncated = summary?.usageHistoryTruncated === true ||
        usageCallCount > usageCalls.length;
      const dialogSummary = {
        ...asObject(summary),
        usageCalls,
        usageCallCount,
        usageHistoryTruncated,
        usageTotal: usageTotal
          ? this.Core.formatUsage(usageTotal, config)
          : "",
      };
      window.openDialog(
        "chrome://feedranker/content/rankedFeeds.xhtml",
        "feed-ranker-scored-feeds",
        /*
         * `dependent=yes` keeps the scores above the Zotero window that opened them.
         *
         * Reported from live use: "the main window would refresh and put the score
         * related window behind when I read it". Scoring refreshes the item tree and
         * the item pane, and Zotero raises its own window while it does that, so an
         * independent dialog ended up buried behind the window the reader was not
         * looking at. A dependent window is a child of its opener: it stays in front
         * of Zotero (and minimizes with it) without floating above other
         * applications, which is exactly Zotero's own convention for this -- its
         * ProgressWindow opens with "chrome,dialog=no,titlebar=no,dependent=yes".
         */
        "chrome,dialog=no,dependent=yes,resizable,centerscreen,width=1180,height=720",
        { records: cloneJSON(localRecords), summary: cloneJSON(dialogSummary) },
      );
    }

    showStoredResults(window, requestedScope) {
      const scope = requestedScope === undefined ? this.selectedFeedScope(window) : requestedScope;
      const scopeData = this.serializableFeedScope(scope);
      const state = this.loadState();
      if (this.Core.text(state.stateIntegrityError)) {
        this.notifyError(this.Core.text(state.stateIntegrityError));
        return;
      }
      const config = this.loadConfig();
      const allRecords = Object.values(state.ranks);
      const inScopeRecords = scope?.kind === "feeds"
        ? allRecords.filter((record) => scopeData.libraryIDs.includes(Number(record?.libraryID)))
        : allRecords;
      const configuredRecords = inScopeRecords.filter((record) =>
        this.isCurrentScoreRecord(record, config),
      );
      const records = this.Core.sortRankings(configuredRecords.filter((record) =>
        this.withLocalPriority(record, config),
      ));
      if (!records.length) {
        this.notifyError(
          configuredRecords.length
            ? "Cached scores in " + scopeData.label + " no longer match the currently loaded Zotero metadata. " +
              "Use Rescore last N days to recompute them."
            : inScopeRecords.length
            ? "No cached scores in " + scopeData.label + " match the current profile and settings. " +
              "Use Rescore last N days to recompute them."
            : "No cached feed scores are available yet for " + scopeData.label + ".",
        );
        return;
      }
      this.openResults(window, records, {
        refresh: state.lastRefresh,
        cachedCount: records.length,
        usageCalls: state.lastUsageCalls,
        usageTotal: state.lastUsageTotal,
        usageCallCount: state.lastUsageCallCount,
        usageHistoryTruncated: state.lastUsageHistoryTruncated,
        message: inScopeRecords.length === records.length
          ? "Stored scores in " + scopeData.label + " matching the current profile and settings. " +
            "Local priority is refreshed from current Zotero metadata."
          : "Stored scores in " + scopeData.label + " matching the current profile and settings. " +
            (inScopeRecords.length - records.length) + " stale score" +
            (inScopeRecords.length - records.length === 1 ? " was" : "s were") + " excluded. " +
            "Local priority is refreshed from current Zotero metadata.",
      });
    }

    // Retrieve journal metrics for the items in scope from EasyScholar, using
    // the user's own key. This is an explicitly user-triggered action: it never
    // runs at startup, on a timer, or as a side effect of scoring. It writes
    // nothing to Zotero items; the results are cached inside FeedRank's own
    // state and shown in the details pane.
    async updateJournalInformation(window, requestedScope) {
      const journal = this.Zotero.FeedRankJournal;
      if (!journal || typeof journal.lookupMany !== "function") {
        this.notifyError("EasyScholar lookup is not available yet. Reopen Zotero after the add-on has started.");
        return null;
      }
      const config = journal.loadConfig();
      const credentials = await journal.credentialSummary();
      const status = this.Core.getJournalLookupStatus({
        configured: credentials.configured === true,
        enabled: config.lookupEnabled === true,
      });
      if (!status.canLookup) {
        // The user just asked for journal metrics, so being told why they cannot have them is the
        // whole job of this branch -- and a quiet notice was missed.
        this.alertUser(window, status.instruction);
        return null;
      }

      const scope = requestedScope === undefined ? this.selectedFeedScope(window) : requestedScope;
      const items = await this.collectItemsForJournalLookup(window, scope);
      if (!items.length) {
        this.notifyWarn("No item with a publication title was found for the current scope.");
        return null;
      }
      const titles = [...new Set(items.map((item) => item.publicationTitle).filter(Boolean))];
      // The Extra write needs the live Zotero record, not the candidate snapshot
      // this scope walk produced, so resolve each candidate back to its item.
      // A candidate whose record is not loaded in the item tree is simply left
      // out of the write rather than being written to some other object.
      const writableItems = [];
      for (const candidate of items) {
        const live = candidate?.[LIVE_ITEM] || this.currentItemForRecord(candidate);
        if (live && typeof live.setField === "function") writableItems.push(live);
      }
      // No confirmation. Choosing "Update journal info" is the decision, and the
      // only thing it can do is cache public journal metrics and merge them into
      // Extra; the progress window is the visible record of it. Nothing here is
      // irreversible, unlike an SMTP submission, which is why the email path
      // still confirms and this one no longer does.

      const progress = this.createProgress(window, this.t("progress.updatingJournal"));
      try {
        progress.update(this.t("progress.contactingJournal"), 0, titles.length);
        const outcome = await journal.lookupMany(titles, {
          parentWindow: window,
          // A fetch-shaped function, never Zotero.HTTP.request: that API logs the URL and
          // redacts only a lowercase `key=`, so it would record the EasyScholar secret from
          // the `secretKey` parameter. See journal-service.js.
          request: typeof fetch === "function" ? fetch : null,
          items: writableItems,
        });
        progress.update(
          "Updated " + outcome.looked + " of " + titles.length + " " +
            (titles.length === 1 ? "journal" : "journals") +
            (outcome.saved ? "; " + outcome.saved + " " +
              (outcome.saved === 1 ? "item's Extra field was updated." : "items' Extra fields were updated.") : "."),
          titles.length,
          titles.length,
        );
        // Recompute local Priority for the cached scores that are affected.
        await this.refreshScoreDetailsPane();
        // The progress window already reported the count. A modal alert on top
        // of it only told the user what they had just watched happen.
        return outcome;
      } catch (error) {
        this.notifyError("The EasyScholar lookup did not complete: " + this.safeError(error));
        return null;
      } finally {
        this.endWorkflowProgress({ progress }, progress);
      }
    }

    // Distinct publication titles for the current scope: the selected items, a
    // selected collection, or every stored feed article FeedRank knows about.
    async collectItemsForJournalLookup(window, scope) {
      try {
        const pane = window?.ZoteroPane || this.Zotero.getActiveZoteroPane?.();
        const selected = pane?.getSelectedItems?.() || [];
        if (Array.isArray(selected) && selected.length) {
          return selected.map((item) => this.toCandidate(item, { name: "Selected items" }));
        }
      } catch (_) {}
      const state = this.loadState();
      const records = Object.values(asObject(state.ranks));
      const scopeData = this.serializableFeedScope(scope);
      const inScope = scope?.kind === "feeds"
        ? records.filter((record) => scopeData.libraryIDs.includes(Number(record?.libraryID)))
        : records;
      const candidates = [];
      for (const record of inScope) {
        const item = this.currentItemForRecord(record);
        if (!item) continue;
        candidates.push(this.toCandidate(item, { name: record.source }));
      }
      return candidates.filter((candidate) => this.Core.text(candidate.publicationTitle));
    }

    async invokeEmailDigest(window, action, records, summary) {
      const email = this.Zotero.FeedRankEmail;
      if (!email || typeof email[action] !== "function") {
        this.notifyError("FeedRank email is not available yet. Reopen Zotero after the add-on has finished starting.");
        return null;
      }
      try {
        // The email service receives a snapshot of the already-ranked records
        // displayed in the current dialog. It does not call Awesome GPT to
        // create a digest, and its own state layer freezes the resulting wire
        // payload before a Send control becomes available.
        return await email[action]({
          records: cloneJSON(Array.isArray(records) ? records : []),
          summary: cloneJSON(asObject(summary)),
          localDay: this.Core.localDay(),
          parentWindow: window,
        });
      } catch (error) {
        this.notifyError("Email preview could not be opened: " + this.safeError(error));
        this.logError(error);
        return null;
      }
    }

    async previewDigest(window, records, summary) {
      return this.invokeEmailDigest(window, "previewDigest", records, summary);
    }

    async sendDigest(window, records, summary) {
      // The service intentionally maps this to the same preview-first flow;
      // a separate confirmation in the preview is required before its POST.
      return this.invokeEmailDigest(window, "sendDigest", records, summary);
    }

    /*
     * Rebuild this week's digest from the scores already in the cache and submit
     * it in one step, with no preview window and no confirmation.
     *
     * The click IS the confirmation, which is the rule everywhere else in this
     * add-on. Nothing is re-ranked: the digest is regenerated from the scored
     * papers of the last seven days, so the button is fast and cannot change a
     * score. Papers whose cached score no longer matches the current profile or
     * settings are excluded, exactly as the results window excludes them, so the
     * email can never quote a score the user would not see in Zotero.
     */
    /*
     * The weekly digest's source: the scored articles of the last seven days.
     *
     * This is deliberately independent of HOW those articles were scored. An
     * earlier revision built the digest only from the scheduled run, so scoring
     * papers by hand produced no digest and no preview at all — which looked like
     * a broken feature rather than a deliberately narrow source. The digest is a
     * weekly digest of the library's recent scores, so any run that put a score in
     * the cache counts.
     *
     * Two filters keep the email honest: a score that no longer matches the
     * current profile or settings is dropped (exactly as the results window drops
     * it), and a record whose live Zotero metadata contradicts its score is
     * dropped too.
     */
    weeklyDigestRecords() {
      const config = this.loadConfig();
      const state = this.loadState();
      // The digest's span follows the cadence, so a daily schedule digests one day and
      // a monthly one digests thirty.
      const lookbackDays = scheduledLookbackDays(config.runFrequency);
      if (this.Core.text(state.stateIntegrityError)) {
        return { records: [], scoredInWindow: 0, lookbackDays, error: this.Core.text(state.stateIntegrityError) };
      }
      // Counted BEFORE the freshness filter, so "nothing was scored in this period" and
      // "what was scored no longer matches your settings" stay distinguishable.
      // They need different instructions, and one message for both was confusing.
      const scoredInWindow = Object.values(asObject(state.ranks))
        .filter((record) => record && Number.isFinite(Number(record.score)))
        .filter((record) => this.Core.withinLookback(record.date, lookbackDays));
      const current = scoredInWindow.filter((record) => this.isCurrentScoreRecord(record, config));
      const records = this.Core.sortRankings(
        current.map((record) => this.withLocalPriority(record, config)).filter(Boolean),
      );
      return { records, scoredInWindow: scoredInWindow.length, lookbackDays, config, error: "" };
    }

    /*
     * The digest selection for the configured cadence, with the reason when there is
     * not one.
     *
     * One helper for both callers -- the Rebuild button and the scheduled run -- so the
     * digest is always the same set of articles and the "why is it empty" wording cannot
     * drift between them.
     */
    weeklyDigestSelection() {
      const email = this.Zotero.FeedRankEmail;
      const { records, scoredInWindow, lookbackDays, config, error } = this.weeklyDigestRecords();
      const span = lookbackDays === 1 ? "the last day" : "the last " + lookbackDays + " days";
      if (error) return { records: [], reason: error };
      if (!records.length) {
        return {
          records: [],
          reason: scoredInWindow
            ? "The articles scored in " + span + " no longer match the current profile " +
              "and settings, so they are not in a digest. Score them again to refresh their relevance."
            : "No articles have been scored in " + span + ", so there is nothing to " +
              "build yet. Score some first.",
        };
      }
      const minimum = Number(config?.minimumRelevanceScore ?? email?.loadConfig?.().minimumRelevanceScore ?? 0);
      const eligible = records.filter((record) => Number(record.score) >= minimum);
      if (!eligible.length) {
        return {
          records: [],
          reason: records.length + (records.length === 1 ? " article was" : " articles were") +
            " scored in " + span + ", but none reached the digest's " +
            "Minimum relevance Score of " + minimum + ".",
        };
      }
      const today = this.Core.localDay();
      return {
        records: eligible,
        reason: "",
        localDay: today,
        window: digestWindow(today, lookbackDays),
        lookbackDays,
        minimum,
      };
    }

    /*
     * Rebuild the week's digest from the scores already in the cache.
     *
     * This is the "rebuild" half of the two digest functions, and the same code the
     * panes call when they open, so a hand-scored run is enough to produce a digest
     * to read. It creates a local message only: no connection, no credential, no
     * send. Review digest is the other half: it opens that exact message, and its
     * own Send button is what transmits it.
     */
    async rebuildWeeklyDigest(parentWindow) {
      const email = this.Zotero.FeedRankEmail;
      if (!email || typeof email.rebuildDigest !== "function") {
        return { available: false, reason: "FeedRank email is still starting; reopen this pane in a moment." };
      }
      const selection = this.weeklyDigestSelection();
      if (!selection.records.length) return { available: false, reason: selection.reason };
      try {
        // Content-derived, so the same week's articles always produce the same
        // digest identity rather than a new one on every rebuild. The service
        // bounds and hashes whatever it is given.
        const result = await email.rebuildDigest({
          records: cloneJSON(selection.records),
          localDay: selection.localDay,
          window: selection.window,
          runID: "preview:" + selection.localDay + ":" +
            selection.records.map((record) => record.id).join(","),
          parentWindow,
        });
        return {
          available: true,
          reason: "",
          articleCount: selection.records.length,
          window: selection.window,
          localDay: selection.localDay,
          snapshot: result?.snapshot || null,
        };
      } catch (caught) {
        return { available: false, reason: this.safeError(caught) };
      }
    }

    openSettings(window) {
      const openPreferences = this.Zotero.Utilities?.Internal?.openPreferences;
      if (this.preferencePaneID && typeof openPreferences === "function") {
        openPreferences.call(this.Zotero.Utilities.Internal, PREFERENCES_PANE_ID);
        return;
      }
      window.openDialog(
        "chrome://feedranker/content/settings.xhtml",
        "feed-ranker-settings",
        // Dependent, so the pane cannot end up behind the Zotero window whose
        // refresh or scoring run is what the user came here to change.
        "chrome,dialog=no,dependent=yes,resizable,centerscreen,width=720,height=780",
        {
          config: cloneJSON(this.loadConfig()),
          save: (config) => this.saveConfig(config),
          buildPromptPreview: (config) => this.buildPromptPreview(config),
        },
      );
    }

    showRefreshOutcome(window, refresh, suffix = "") {
      const feedCount = (key) => {
        const declared = Number(refresh?.[key + "Count"]);
        return Number.isSafeInteger(declared) && declared >= 0
          ? declared
          : Array.isArray(refresh?.[key + "s"]) ? refresh[key + "s"].length : 0;
      };
      const failures = feedCount("failedFeed");
      const successes = feedCount("successfulFeed");
      const fallbackCandidates = boundedStateCount(refresh?.fallbackCandidateCount);
      const fallbackRecent = boundedStateCount(refresh?.fallbackRecentItemCount);
      const fallbackMessage = refresh?.fallbackUsed === true
        ? fallbackCandidates
          ? (refresh.newItemCount
            ? "Newly imported items did not yield an eligible candidate. Found "
            : "This refresh imported no new items. Found ") +
              fallbackCandidates + " recent stored " +
              (fallbackCandidates === 1 ? "article that needs scoring." : "articles that need scoring.")
          : (refresh.newItemCount
            ? "Newly imported items did not yield an eligible candidate. Checked "
            : "This refresh imported no new items. Checked ") +
              fallbackRecent + " recent stored " +
              (fallbackRecent === 1 ? "article; none needs scoring." : "articles; none needs scoring.")
        : "";
      const message = [
        "Refreshed " + successes + " feed" + (successes === 1 ? "" : "s") + ".",
        failures ? failures + " feed refresh failure" + (failures === 1 ? "" : "s") + "." : "",
        refresh.newItemCount
          ? refresh.newItemCount + " new item" + (refresh.newItemCount === 1 ? "" : "s") + " found."
          : refresh?.fallbackUsed !== true ? "No newly imported feed items after this refresh." : "",
        fallbackMessage,
        suffix,
      ].filter(Boolean).join(" ");
      this.notifyInfo(message);
    }

    showLookbackOutcome(window, refresh, suffix = "") {
      const feedCount = (key) => {
        const declared = Number(refresh?.[key + "Count"]);
        return Number.isSafeInteger(declared) && declared >= 0
          ? declared
          : Array.isArray(refresh?.[key + "s"]) ? refresh[key + "s"].length : 0;
      };
      const failures = feedCount("failedFeed");
      const successes = feedCount("successfulFeed");
      const days = Number.isInteger(refresh.lookbackDays) ? refresh.lookbackDays : 0;
      const lookbackRange = /^\d{4}-\d{2}-\d{2}$/.test(this.Core.text(refresh.lookbackStartDate)) &&
        /^\d{4}-\d{2}-\d{2}$/.test(this.Core.text(refresh.lookbackEndDate))
        ? this.Core.text(refresh.lookbackStartDate) === this.Core.text(refresh.lookbackEndDate)
          ? "today only (" + this.Core.text(refresh.lookbackStartDate) + ")"
          : "from " + this.Core.text(refresh.lookbackStartDate) + " through " +
            this.Core.text(refresh.lookbackEndDate) + " (the last " + days + " calendar days)"
        : days === 0
          ? "today only"
          : "the last " + days + " calendar day" + (days === 1 ? "" : "s") + " (including today)";
      const message = [
        "Scanned " + (refresh.scannedItemCount || 0) + " stored feed " +
          ((refresh.scannedItemCount || 0) === 1 ? "item" : "items") + " across " + successes +
          " feed" + (successes === 1 ? "" : "s") + ".",
        "Found " + (refresh.candidateCount || 0) + " unique " +
          ((refresh.candidateCount || 0) === 1 ? "article" : "articles") + " published " + lookbackRange + ".",
        refresh.duplicateCount ? "Merged " + refresh.duplicateCount + " duplicate " +
          (refresh.duplicateCount === 1 ? "record" : "records") + " by DOI or arXiv identifier." : "",
        refresh.undatedItemCount ? "Skipped " + refresh.undatedItemCount + " " +
          (refresh.undatedItemCount === 1 ? "item" : "items") + " with no usable publication date." : "",
        failures ? failures + " feed scan " + (failures === 1 ? "failure." : "failures.") : "",
        suffix,
      ].filter(Boolean).join(" ");
      this.notifyInfo(message);
    }

    openFeedItem(window, itemID) {
      try {
        const pane = window.ZoteroPane || this.Zotero.getActiveZoteroPane?.();
        pane?.selectItem?.(Number(itemID));
      } catch (error) {
        this.notifyWarn("The Zotero item is no longer available.");
        this.logError(error);
      }
    }

    openURL(url) {
      if (!/^https?:\/\//i.test(String(url || ""))) return;
      this.Zotero.launchURL(url);
    }

    /*
     * Passive reporting.
     *
     * Every outcome used to arrive in a modal `alert()`, so a finished operation
     * ended by demanding a click to acknowledge something the user never asked
     * about. Results are already in the score window; anything else that needs
     * saying is said through Zotero's own bottom-right progress panel, which
     * needs no click and closes itself.
     *
     * Falls back to a modal alert ONLY when that panel is unavailable, because a
     * silent failure would be worse than a dialog.
     */
    notify(message, { kind = "info" } = {}) {
      const text = this.Core.text(message, 4000);
      if (!text) return false;
      const notify = this.Notify;
      if (notify && typeof notify[kind] === "function") {
        if (notify[kind](text)) return true;
      }
      // No passive channel: this is the one case where a dialog is justified.
      try {
        this.Services.prompt.alert(this.getActiveMainWindow(), TOOL_NAME, text);
      } catch (_) {}
      return false;
    }

    notifyInfo(message) {
      return this.notify(message, { kind: "info" });
    }

    /*
     * A notice that must never become a window.
     *
     * The scheduled run reports through a modal window at the moments that matter,
     * and `notify()` falls back to one whenever the passive panel is unavailable.
     * That fallback is right for an outcome and wrong for commentary: "this
     * completed run will be submitted, to this server", or "the digest was
     * prepared but sending is switched off", are statements of what is happening,
     * not questions, and turning each of them into a click would make an
     * unattended run demand attention it does not need.
     */
    /*
     * Settings as a file: save, load, reset.
     *
     * The picker is Gecko's own, initialised the way Zotero 10 does it (`init` takes the
     * window's browsingContext and returns a promise from `show()`). A cancelled picker is not
     * an error and says so.
     */
    /*
     * Wait for the file dialog.
     *
     * `nsIFilePicker.show()` is gone from this Gecko: the picker is opened with `open()`, which
     * takes the result as a callback. Zotero's own filePicker.mjs wraps exactly that call, so this
     * follows it -- and keeps a show() fallback for a build that still has one, rather than doing
     * nothing on either.
     */
    /*
     * Open a file with the system, and copy text, the way this Zotero does it.
     *
     * Both are one-line wrappers because the underlying calls are Zotero's, not the platform's:
     * launchFile() knows about the fallbacks nsIFile.launch() needs, and the clipboard helper works
     * in a chrome window where navigator.clipboard may not be available at all.
     */
    // What the panes show on load, so a stale build is visible instead of guessed at.
    versionLabel() {
      const version = this.Core.text(this.Zotero?.FeedRankerVersion) || "unknown";
      return "FeedRank for Zotero " + version;
    }

    /*
     * Where the connection log lives, and which one is newest.
     *
     * writeConnectionLog() names it feedrank-smtp-<timestamp>.log in the Zotero data directory (or
     * the temporary directory). The path used to be remembered in the pane that wrote it, which made
     * the log invisible from anywhere else; this looks for it instead.
     */
    connectionLogDirectories() {
      const directories = [];
      try {
        if (this.Zotero?.DataDirectory?.dir) directories.push(String(this.Zotero.DataDirectory.dir));
      } catch (_) {}
      try {
        const tmp = this.Services?.dirsvc?.get?.("TmpD", this.Components.interfaces.nsIFile);
        if (tmp?.path) directories.push(String(tmp.path));
      } catch (_) {}
      return directories;
    }

    /*
     * Write the SMTP/TLS report and return where it went.
     *
     * A named file in the Zotero data directory (or the temporary directory), written through the
     * same API the settings export uses. The reason for a failure is returned, never swallowed: a
     * button that does nothing and a log that was never written look identical from the outside.
     */
    async writeConnectionLog(text) {
      const report = String(text || "");
      if (!report) return { written: false, path: "", reason: "there is nothing to write" };
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const name = "feedrank-smtp-" + stamp + ".log";
      const failures = [];
      for (const directory of this.connectionLogDirectories()) {
        // Plain string joining: the path never depends on an nsIFile the caller might not have.
        const separator = String(directory).includes("\\") ? "\\" : "/";
        const target = String(directory).replace(/[\\/]+$/, "") + separator + name;
        try {
          await this.Zotero.File.putContentsAsync(target, report);
          return { written: true, path: target };
        } catch (error) {
          failures.push(this.safeError(error));
        }
      }
      return {
        written: false,
        path: "",
        reason: failures.length ? failures.join("; ") : "there is no writable directory to write it to",
      };
    }

    async newestConnectionLog() {
      const pattern = /^feedrank-smtp-.*\.log$/;
      const found = [];
      for (const directory of this.connectionLogDirectories()) {
        try {
          const folder = this.Zotero.File.pathToFile(directory);
          if (!folder?.exists?.()) continue;
          const entries = folder.directoryEntries;
          while (entries.hasMoreElements()) {
            const file = entries.getNext().QueryInterface(this.Components.interfaces.nsIFile);
            if (!pattern.test(String(file.leafName || ""))) continue;
            found.push({ path: String(file.path), modified: Number(file.lastModifiedTime || 0) });
          }
        } catch (error) {
          this.logError(new Error("Could not list " + directory + ": " + this.safeError(error)));
        }
      }
      found.sort((left, right) => right.modified - left.modified);
      return found[0]?.path || "";
    }

    // Resolve, read, or open the connection log. Each answer says which of the three happened.
    async connectionLogPath(known = "") {
      const remembered = this.Core.text(known, 4000);
      if (remembered) {
        try {
          const file = this.Zotero.File.pathToFile(remembered);
          if (file?.exists?.() && file.isFile?.()) return remembered;
        } catch (_) {}
      }
      return this.newestConnectionLog();
    }

    async openConnectionLog(known = "") {
      const path = await this.connectionLogPath(known);
      if (!path) return { opened: false, path: "", reason: "none" };
      const opened = this.openFileWithSystem(path);
      return { opened, path, reason: opened ? "opened" : "unopenable" };
    }

    async readConnectionLog(known = "") {
      const path = await this.connectionLogPath(known);
      if (!path) return { read: false, path: "", text: "" };
      try {
        const text = String(await this.Zotero.File.getContentsAsync(path) || "");
        return { read: Boolean(text), path, text };
      } catch (error) {
        this.logError(new Error("Could not read " + path + ": " + this.safeError(error)));
        return { read: false, path, text: "" };
      }
    }

    /*
     * The shareable copy of a connection report.
     *
     * A report is not anonymous: its last section carries the SMTP host and the account name, and the
     * security inventory repeats the server certificate's names. A username is often a personal
     * address and a hostname can name an institution, so "attach your log" is advice that can leak.
     * What a maintainer needs -- TLS version, status codes, authentication stage, versions -- survives
     * here; identities, server text and local paths do not.
     */
    sanitizeDiagnosticsReport(text) {
      const raw = String(text || "");
      const value = (pattern) => {
        const match = raw.match(pattern);
        return match ? match[1] : "";
      };
      const bool = (name) => {
        const found = value(new RegExp("^\\s*" + name + " = (true|false)\\s*$", "m"));
        return found ? name + " = " + found : "";
      };
      const number = (name, pattern) => {
        const found = value(pattern || new RegExp("^\\s*" + name + " = (\\d+)\\b", "m"));
        return found ? name + " = " + found : "";
      };
      const lines = [
        "FeedRank for Zotero - shareable SMTP/TLS diagnostics",
        "Built by allowlist: identities, addresses, server text and local paths are never copied.",
        "FeedRank " + (this.Core.text(this.Zotero && this.Zotero.FeedRankerVersion) || "unknown"),
        "",
        "[connection]",
        number("port"),
        value(/^\s*tlsMode = (implicit|starttls|none)\s*$/m) ? "tlsMode = " + value(/^\s*tlsMode = (implicit|starttls|none)\s*$/m) : "",
        value(/^\s*authMethod = (plain|login|oauth2)\s*$/m) ? "authMethod = " + value(/^\s*authMethod = (plain|login|oauth2)\s*$/m) : "",
        value(/^\s*authNegotiated = ([a-z-]{1,20})\s*$/m) ? "authNegotiated = " + value(/^\s*authNegotiated = ([a-z-]{1,20})\s*$/m) : "",
        value(/^\s*authStage = ([a-z-]{1,20})\s*$/m) ? "authStage = " + value(/^\s*authStage = ([a-z-]{1,20})\s*$/m) : "",
        value(/^\s*failure = (none|[a-z-]{1,40})\s*$/m) ? "failure = " + value(/^\s*failure = (none|[a-z-]{1,40})\s*$/m) : "",
        "",
        "[tls]",
        number("sslVersionUsed"),
        number("protocolVersion"),
        value(/^\s*cipherName = (TLS_[A-Z0-9_]+)\s*$/m) ? "cipherName = " + value(/^\s*cipherName = (TLS_[A-Z0-9_]+)\s*$/m) : "",
        number("securityState"),
        number("failedCertChain"),
        number("succeededCertChain"),
        bool("encrypted"),
        bool("protocolConfirmed"),
        bool("handshakeCompleted"),
        bool("plaintextFallbackUsed"),
        bool("securityInfoPresent"),
        bool("failedVerification"),
        value(/^\s*errorCodeString = \(empty\)\s*$/m) ? "errorCodeString = (empty)" : "",
        "",
        "[timing]",
        number("totalElapsedMs"),
        value(/^\s*timings = ((?:[a-z]+ \d+ms)(?:, [a-z]+ \d+ms)*)\s*$/m)
          ? "timings = " + value(/^\s*timings = ((?:[a-z]+ \d+ms)(?:, [a-z]+ \d+ms)*)\s*$/m)
          : "",
      ];
      const body = lines.filter((line) => line !== "" && line !== undefined);
      return [
        "FeedRank for Zotero - shareable SMTP/TLS diagnostics",
        "Built by allowlist: identities, addresses, server text and local paths are never copied.",
        "Only the fields below were read out of the report; nothing else was.",
        "",
        ...body.slice(3),
      ].join("\n");
    }

    openFileWithSystem(path) {
      const target = this.Core.text(path, 4000);
      if (!target) return false;
      try {
        if (typeof this.Zotero.launchFile === "function") {
          this.Zotero.launchFile(target);
          return true;
        }
        const file = this.Zotero.File?.pathToFile?.(target);
        if (typeof file?.launch === "function") {
          file.launch();
          return true;
        }
      } catch (error) {
        this.logError(new Error("Could not open " + target + ": " + this.safeError(error)));
      }
      return false;
    }

    copyTextToClipboard(text) {
      const value = typeof text === "string" ? text : "";
      if (!value) return false;
      try {
        const internal = this.Zotero.Utilities?.Internal;
        if (typeof internal?.copyTextToClipboard === "function") {
          internal.copyTextToClipboard(value);
          return true;
        }
      } catch (error) {
        this.logError(new Error("Clipboard copy failed: " + this.safeError(error)));
      }
      return false;
    }

    /*
     * A journal lookup that was skipped is not nothing: "no key" is the one reason the user can fix,
     * and a silent skip reads as "journal data does not work".
     */
    reportJournalOutcome(outcome, { window = null } = {}) {
      if (outcome?.reason !== "no-key") return;
      const message = this.t("journal.noKey");
      this.weeklyLog("journal lookup skipped: " + message);
      if (window) {
        this.alertUser(window, message);
        return;
      }
      // No window means nobody is watching: a scheduled run reports quietly, because a dialog at
      // three in the morning would block Zotero until someone dismissed it.
      this.notifyWarn(message);
    }

    showFilePicker(picker) {
      return new Promise((resolve, reject) => {
        if (typeof picker?.open === "function") {
          try {
            picker.open((result) => resolve(result));
          } catch (error) {
            reject(error);
          }
          return;
        }
        if (typeof picker?.show === "function") {
          Promise.resolve(picker.show()).then(resolve, reject);
          return;
        }
        reject(new Error("This Zotero build exposes no way to open the file dialog"));
      });
    }

    settingsFilePicker(window, { title, mode }) {
      const Ci = this.Components?.interfaces;
      if (!Ci?.nsIFilePicker) throw new Error("The file picker is unavailable in this build");
      const picker = this.Components.classes["@mozilla.org/filepicker;1"]
        .createInstance(Ci.nsIFilePicker);
      // init() wants a browsing context, and every failure to produce one is a dialog that
      // never appears, so the parent window is resolved rather than trusted.
      const parent = window || this.getActiveMainWindow?.() ||
        this.Services?.wm?.getMostRecentWindow?.("navigator:browser") || null;
      const context = parent?.browsingContext || null;
      if (!context) throw new Error("No window is available to show the file dialog");
      picker.init(context, title, mode);
      picker.appendFilter("FeedRank settings", "*.json");
      picker.appendFilters(Ci.nsIFilePicker.filterAll);
      picker.defaultExtension = "json";
      if (mode === Ci.nsIFilePicker.modeSave) picker.defaultString = "feedrank-settings.json";
      return picker;
    }

    /*
     * Save: settings, and -- only if the user says so -- the credentials.
     *
     * A credential in the file must not undo the OS-encrypted store, so the file can only ever
     * carry the store's own CIPHERTEXT; the plaintext never leaves the store. The ciphertext is
     * still credential material (the same OS account can decrypt it), so it is not written
     * silently: the default answer here is NO.
     */
    async exportSettingsToFile(window) {
      if (!this.SettingsFile) return { saved: false, reason: this.t("settings.unavailable") };
      let credentials = null;
      let credentialsIncluded = false;
      let target = "";
      try {
        // Where first: a cancelled dialog must end the operation before it asks anything else.
        const Ci = this.Components.interfaces;
        const picker = this.settingsFilePicker(window, {
          title: this.t("settings.exportTitle"),
          mode: Ci.nsIFilePicker.modeSave,
        });
        const result = await this.showFilePicker(picker);
        if (result === Ci.nsIFilePicker.returnCancel) {
          return { saved: false, cancelled: true, reason: this.t("settings.cancelled") };
        }
        target = picker.file?.path || "";
        if (!target) return { saved: false, reason: this.t("settings.noPath") };
      } catch (error) {
        return { saved: false, reason: this.safeError(error) };
      }
      // Then the one question a settings file may ask. The ciphertext is read but never decrypted.
      try {
        const email = await this.Zotero.FeedRankEmail?.exportStoredSecret?.();
        const scholar = await this.Zotero.FeedRankJournal?.exportStoredSecret?.();
        if (email?.ciphertext || scholar?.ciphertext) {
          const include = await this.confirmIncludeCredentials(
            window,
            [email?.ciphertext ? "smtp" : "", scholar?.ciphertext ? "scholar" : ""].filter(Boolean),
          );
          if (include) {
            credentials = { email: email?.ciphertext || "", scholar: scholar?.ciphertext || "" };
            credentialsIncluded = true;
          }
        }
      } catch (error) {
        this.weeklyLog("the saved credentials could not be read for export: " + this.safeError(error));
      }
      try {
        // The connection travels with the file: loadConfig() carries the digest options, and the
        // saved Login Manager record carries the host, port, identity and addresses.
        const emailSummary = await this.Zotero.FeedRankEmail?.credentialSummary?.();
        const emailConfig = {
          ...(this.Zotero.FeedRankEmail?.loadConfig?.() || {}),
          ...(emailSummary?.configured === true
            ? {
              host: emailSummary.host,
              port: emailSummary.port,
              tlsMode: emailSummary.tlsMode,
              authMethod: emailSummary.authMethod,
              username: emailSummary.username,
              from: emailSummary.from,
              to: emailSummary.to,
            }
            : {}),
        };
        const text = this.SettingsFile.buildExport({
          config: this.loadConfig(),
          emailConfig,
          journalConfig: this.Zotero.FeedRankJournal?.loadConfig?.() || {},
          version: this.Zotero.FeedRankerVersion || "",
          exportedAt: new Date().toISOString(),
          credentials,
        });
        await this.Zotero.File.putContentsAsync(target, text);
        // The file name, not the path: the schedule log is durable state, shown in the pane, and a
        // path there names the user's directories.
        this.weeklyLog("settings exported to " + target.split(/[\\/]/).pop());
        return { saved: true, path: target, bytes: text.length, credentialsIncluded };
      } catch (error) {
        return { saved: false, reason: this.safeError(error) };
      }
    }

    /*
     * Load: every value is validated here and bounded by the ordinary saveConfig path, so a
     * hand-edited or foreign file can only produce settings this build would accept from a pane.
     */
    async importSettingsFromFile(window) {
      if (!this.SettingsFile) return { loaded: false, reason: this.t("settings.unavailable") };
      let text;
      // Declared out here because the successful return names the file it read.
      let chosen = "";
      try {
        const Ci = this.Components.interfaces;
        const picker = this.settingsFilePicker(window, {
          title: this.t("settings.importTitle"),
          mode: Ci.nsIFilePicker.modeOpen,
        });
        const result = await this.showFilePicker(picker);
        if (result === Ci.nsIFilePicker.returnCancel) {
          return { loaded: false, cancelled: true, reason: this.t("settings.cancelled") };
        }
        chosen = picker.file?.path || "";
        if (!chosen) {
          // "No file was chosen" is the wrong explanation when the dialog said OK: report the code
          // the picker returned, so the next report says which of the two happened.
          return {
            loaded: false,
            reason: this.t("settings.noFileFromPicker", { code: String(result) }),
            pickerResult: result,
          };
        }
        text = await this.Zotero.File.getContentsAsync(chosen);
        if (!String(text || "").trim()) {
          return { loaded: false, reason: this.t("settings.importFailed", { reason: "the file is empty" }) };
        }
      } catch (error) {
        return { loaded: false, reason: this.safeError(error) };
      }
      const parsed = this.SettingsFile.parseImport(text);
      if (!parsed.ok) {
        return { loaded: false, reason: parsed.errors.join("; "), errors: parsed.errors };
      }
      const applied = [];
      try {
        if (Object.keys(parsed.config).length) {
          this.saveConfig({ ...this.loadConfig(), ...parsed.config });
          applied.push("config");
        }
        if (Object.keys(parsed.email).length && this.Zotero.FeedRankEmail?.saveConfig) {
          this.Zotero.FeedRankEmail.saveConfig(parsed.email);
          applied.push("email");
        }
        if (Object.keys(parsed.journal).length && this.Zotero.FeedRankJournal?.saveConfig) {
          this.Zotero.FeedRankJournal.saveConfig(parsed.journal);
          applied.push("journal");
        }
      } catch (error) {
        return { loaded: false, reason: this.safeError(error), applied };
      }
      /*
       * Credentials from the file, if it carried any: restored only when this machine can decrypt
       * them, and never asked about -- a blob that cannot be decrypted leaves the credential EMPTY,
       * exactly as if the file had not carried it, and the caller passes that on as a hint. There
       * is nothing for the user to decide at that point.
       */
      const credentialNotes = [];
      try {
        const emailConfig = { ...(this.Zotero.FeedRankEmail?.loadConfig?.() || {}), ...parsed.email };
        if (parsed.credentials.email) {
          const outcome = await this.Zotero.FeedRankEmail?.restoreStoredSecret?.({
            ciphertext: parsed.credentials.email,
            connection: emailConfig,
          });
          if (outcome?.restored) applied.push("smtp-password");
          credentialNotes.push(this.credentialNote("smtp", outcome));
        }
        if (parsed.credentials.scholar) {
          const outcome = await this.Zotero.FeedRankJournal?.restoreStoredSecret?.({
            ciphertext: parsed.credentials.scholar,
          });
          if (outcome?.restored) applied.push("easyscholar-key");
          credentialNotes.push(this.credentialNote("scholar", outcome));
        }
      } catch (error) {
        credentialNotes.push(this.t("settings.credentialsUnusable", { what: this.t("settings.whatCredentials") }));
        this.weeklyLog("the file's credentials were not restored: " + this.safeError(error));
      }
      // The schedule may have moved, so it is re-armed and the panes re-read it.
      await this.startWeeklyScheduler().catch?.(() => {});
      void this.refreshScoreDetailsPane();
      this.weeklyLog("settings imported from a file (" + applied.join(", ") + ")");
      return {
        loaded: true,
        path: chosen,
        applied,
        ignored: parsed.ignored,
        version: parsed.version,
        exportedAt: parsed.exportedAt,
        credentialNotes: credentialNotes.filter(Boolean),
      };
    }

    // One sentence per credential slot: restored, or empty with the reason.
    credentialNote(slot, outcome) {
      const what = this.t(slot === "smtp" ? "settings.whatSmtp" : "settings.whatScholar");
      if (outcome?.restored) return this.t("settings.credentialsRestored", { what });
      if (outcome?.reason === "undecryptable" || outcome?.reason === "not-encrypted") {
        return this.t("settings.credentialsUnusable", { what });
      }
      if (outcome?.reason === "unavailable") {
        return this.t("settings.credentialsUnavailable", { what });
      }
      if (outcome?.reason === "no-connection") {
        // The file carried the credential but no connection for it to belong to. Saying nothing
        // here is how a restored key and a missing password looked like the same result.
        return this.t("settings.credentialsNoConnection", { what });
      }
      return "";
    }

    /*
     * Reset: settings back to their defaults, scores untouched, credential links severed.
     *
     * The confirmation names all three, because they are not equivalent: settings are cheap, scores
     * cost model calls to rebuild, and the credentials are a capability -- after a reset the add-on
     * must not be able to send as the user or spend their key, so the stored secret is deleted, not
     * forgotten. `settings-file.js` owns that scope, so the sentence and the behaviour cannot drift
     * apart.
     */
    async resetAllSettings(window) {
      if (!this.SettingsFile) return { reset: false, reason: this.t("settings.unavailable") };
      const descriptor = this.SettingsFile.resetDescriptor();
      const confirmed = await this.confirmReset(window, this.SettingsFile.RESET.summary);
      if (!confirmed) return { reset: false, cancelled: true, reason: this.t("settings.cancelled") };
      const cleared = [];
      const credentialsCleared = [];
      const failures = [];
      /*
       * Credentials first, and each in its own try/catch.
       *
       * The order is deliberate: whatever else goes wrong, a reset must not leave the add-on able to
       * send as the user or spend their EasyScholar key. An earlier version cleared preferences
       * first, so a preference that threw stopped the reset before the credentials were touched.
       */
      for (const slot of descriptor.credentials) {
        const isEmail = slot === "email";
        const service = isEmail ? this.Zotero.FeedRankEmail : this.Zotero.FeedRankJournal;
        const method = isEmail ? "clearCredentials" : "clearSecretKey";
        const name = isEmail ? "SMTP password" : "EasyScholar key";
        try {
          if (typeof service?.[method] !== "function") {
            throw new Error("the " + (isEmail ? "email" : "journal") + " service is unavailable");
          }
          const outcome = await service[method]();
          if (outcome?.cleared !== true) throw new Error("the credential store did not confirm the removal");
          credentialsCleared.push(name);
        } catch (error) {
          failures.push(name);
          this.weeklyLog("reset could not remove the " + name + ": " + this.safeError(error));
        }
      }
      /*
       * Then the settings, one at a time. `clearUserPref` throws for a preference that has no user
       * value, which is not a failure -- it is already at its default -- and it must not stop the
       * preferences that do have one.
       */
      const prefsService = this.Services?.prefs;
      for (const key of descriptor.prefs) {
        try {
          if (!prefsService?.clearUserPref) throw new Error("the preference service is unavailable");
          if (prefsService.prefHasUserValue?.(key) === false) continue;
          prefsService.clearUserPref(key);
          cleared.push(key);
        } catch (error) {
          failures.push(key);
          this.weeklyLog("reset could not clear " + key + ": " + this.safeError(error));
        }
      }
      try {
        await this.mutateState((state) => {
          for (const key of descriptor.marker) state[key] = "";
          return state;
        });
      } catch (error) {
        failures.push("schedule marker");
        this.weeklyLog("reset could not clear the schedule marker: " + this.safeError(error));
      }
      this.rankLookup = null;
      this.refreshRankColumn();
      void this.refreshScoreDetailsPane();
      await this.startWeeklyScheduler().catch?.(() => {});
      if (!cleared.length && !credentialsCleared.length) {
        // Nothing was reset at all: report it instead of claiming success.
        return { reset: false, reason: failures.join("; ") || this.t("settings.resetFailed", { reason: "" }) };
      }
      this.weeklyLog("all settings reset to their defaults (" +
        [cleared.join(", "), credentialsCleared.join(", ")].filter(Boolean).join("; ") + ")");
      return { reset: true, kept: descriptor.keeps, cleared, credentialsCleared, failures };
    }

    // A modal confirmation for the one case where a credential may leave its store. Default: no.
    confirmIncludeCredentials(window, slots) {
      const prompt = this.Services?.prompt;
      const parent = window || this.getActiveMainWindow();
      const text = this.t("settings.credentialsAsk", { what: this.credentialList(slots) });
      if (typeof prompt?.confirmEx !== "function") {
        return Promise.resolve(Boolean(prompt?.confirm?.(parent, TOOL_NAME, text)));
      }
      const flags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_YES +
        prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_NO;
      const choice = prompt.confirmEx(
        parent, TOOL_NAME, text, flags, null, null, null, null,
        { defaultButton: 1 },
      );
      return Promise.resolve(choice === 0);
    }

    credentialList(slots) {
      const names = (slots || []).map((slot) =>
        this.t(slot === "smtp" ? "settings.whatSmtp" : "settings.whatScholar"));
      return names.length ? names.join(this.t("settings.and")) : this.t("settings.whatCredentials");
    }

    // A modal confirmation: this one destroys settings, so it asks.
    confirmReset(window, summary) {
      const prompt = this.Services?.prompt;
      const parent = window || this.getActiveMainWindow();
      if (typeof prompt?.confirmEx !== "function") {
        return Promise.resolve(Boolean(prompt?.confirm?.(parent, TOOL_NAME, summary)));
      }
      const flags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING +
        prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_CANCEL;
      const choice = prompt.confirmEx(
        parent, TOOL_NAME, this.t("settings.resetConfirm") + "\n\n" + summary,
        flags, this.t("settings.resetConfirmButton"), null, null, null, {},
      );
      return Promise.resolve(choice === 0);
    }

    /*
     * A message the user has to see.
     *
     * Zotero's own prompt service, which is what makes it reliable: a panel notification is quiet by
     * design, and "the notice was easy to miss" is indistinguishable from "nothing happened" -- which
     * is how a missing EasyScholar key and a missing log file were both experienced.
     */
    alertUser(window, message) {
      const text = this.Core.text(message, 2000);
      if (!text) return false;
      const parent = window || this.getActiveMainWindow();
      try {
        if (typeof this.Services?.prompt?.alert === "function") {
          this.Services.prompt.alert(parent, TOOL_NAME, text);
          return true;
        }
      } catch (error) {
        this.logError(new Error("Could not show a dialog: " + this.safeError(error)));
      }
      // The quiet notice is the fallback, never the other way round: a message that cannot be shown
      // at all is the one failure this helper must not have.
      return this.notifyWarn(text);
    }

    notifyQuiet(message) {
      const text = this.Core.text(message, 4000);
      if (!text) return false;
      try {
        return this.Notify?.info?.(text) === true;
      } catch (_) {
        return false;
      }
    }

    /*
     * The panes' language, and their own text.
     *
     * Both settings panes run in a *different* window from this service, so they cannot
     * reach the strings module directly: they ask the service. `applyPaneStrings` replaces
     * the pane's English labels, hints and buttons with the active language's, and does
     * nothing at all in English, where the markup is already the English source.
     */
    applyPaneStrings(root) {
      try {
        return this.strings?.applyPane ? this.strings.applyPane(root) === true : false;
      } catch (error) {
        this.logError(new Error("Could not localize the FeedRank pane: " + this.safeError(error)));
        return false;
      }
    }

    notifyWarn(message) {
      return this.notify(message, { kind: "warn" });
    }

    notifyError(message) {
      return this.notify(message, { kind: "error" });
    }

    /*
     * Retained for the handful of cases where a dialog is genuinely the only
     * usable channel — notably a settings-pane validation error, where the user
     * is looking at the field and a self-closing notice would be missed. New
     * outcome reporting must use notifyInfo/notifyWarn/notifyError instead.
     */
    alert(window, title, message) {
      this.Services.prompt.alert(window, this.Core.text(title) || TOOL_NAME, message);
    }

    handleRunError(window, error) {
      const partialUsage = error?.feedRankUsage;
      const partialCost = partialUsage
        ? "\nPartial total for this ranking: " + this.Core.formatUsage(partialUsage, this.loadConfig())
        : "";
      if (error instanceof CancelledError) {
        this.notifyWarn("Scoring was cancelled. No new scores were cached." + partialCost);
      } else {
        this.notifyError("The operation did not complete: " + this.safeError(error) + partialCost);
      }
      this.logError(error);
    }

    safeError(error) {
      const value = this.Core.text(error?.message || error || "Unexpected error");
      return value
        .replace(/bearer\s+\S+/gi, "Bearer [redacted]")
        .slice(0, 500);
    }

    logError(error) {
      try {
        this.Zotero.logError(error);
      } catch (_) {}
    }

    delay(milliseconds) {
      if (this.Zotero.Promise?.delay) return this.Zotero.Promise.delay(milliseconds);
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
  }

  return Object.freeze({
    create(dependencies) {
      return new FeedRankerService(dependencies);
    },
  });
});
