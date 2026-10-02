"use strict";

/*
 * FeedRank for Zotero — user-facing text, in one place, per language.
 *
 * Asked for after the English text had grown over a dozen revisions: "Do a final check
 * of all display/notice/popup texts. Make all text concise and precise" and "Add a chinese
 * version too. switch based on system language."
 *
 * Two rules the module exists to enforce:
 *
 *   1. Text is DATA, not a literal buried in a branch. Every user-facing sentence lives
 *      here once, so the same statement cannot drift between the notice, the log line and
 *      the pane, and so a translation cannot miss one copy of it.
 *   2. The language follows Zotero's own UI language, which follows the system language on
 *      a fresh installation. `Zotero.locale` is the value Zotero itself uses, so a reader
 *      who runs Zotero in Chinese gets FeedRank in Chinese with no separate setting.
 *
 * `t()` is deliberately synchronous: it is called from a running workflow's progress
 * updates and from notice rendering, where an async formatter would leak a promise into
 * paths that must not await. A missing key falls back to `en-US` and then to the key
 * itself, which is visible and greppable rather than silently empty.
 */

(function exposeFeedRankStrings(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FeedRankStrings = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createStrings() {
  const DEFAULT_LOCALE = "en-US";
  const SUPPORTED_LOCALES = Object.freeze(["en-US", "zh-CN"]);

  /*
   * The messages. Keys are grouped by the surface that shows them.
   *
   * English values are the audited, concise wording; the Chinese column says the same
   * thing in the same register. `{name}` placeholders are substituted by `t()`.
   */
  const STRINGS = {
    "en-US": {
      // -- Tools menu and the folder menu --------------------------------------
      "menu.refresh": "Refresh and score",
      "menu.scoreDays": "Score last N days…",
      "menu.rescoreDays": "Rescore last N days…",
      "menu.sendDigest": "Send weekly digest",
      "menu.showScores": "Show scored articles",
      "menu.settings": "Settings…",
      "menu.updateJournal": "Update journal info",
      "menu.scoreDaysScope": "Score N days…",
      "menu.rescoreDaysScope": "Rescore N days…",
      "menu.showScoresScope": "Show scores",
      "menu.scoreSelected": "Score selected items",
      "menu.rescoreSelected": "Rescore selected items",
      "item.sectionHeader": "FeedRank Score",
      "item.sectionSidenav": "FeedRank Score Details",

      // -- The run, in the corner notice ---------------------------------------
      "run.title": "FeedRank scheduled run",
      "run.titleStage": "FeedRank scheduled run: {stage}",
      "run.startedLine": "Started {time}.",
      "run.closes": "This notice closes itself.",
      "run.finished": "FeedRank scheduled run finished: {outcome}",
      "run.started": "Scheduled run started for {anchor}. Refreshing and scoring the last {days}.",
      "run.cancelled": "Scheduled run cancelled. It will try again at the next check.",
      "run.notStarted": "Scheduled run did not start: {error} Try again at the next check.",
      "run.didNotFinish": "Scheduled run did not finish: {error}",
      "run.busy": "A feed refresh or scoring operation is already running.",
      "run.outcomeHeading": "FeedRank scheduled run finished.",
      "run.feeds": "Feeds: {ok} of {total} updated{failed}.",
      "run.feedsFailed": ", {count} failed",
      "run.articles": "Articles: {scored} newly scored, {reused} already current{replaced}.",
      "run.articlesReplaced": ", {count} rescored",
      "run.articlesNone": "Articles: nothing new needed scoring.",

      // -- The email outcome ---------------------------------------------------
      "email.sent": "Email: SENT to {to}.",
      "email.sentUnknownRecipient": "Email: SENT.",
      "email.notSent": "Email: NOT SENT — {reason}.",
      "email.notPrepared": "Email: no digest was prepared for this run.",
      "email.approvalOff": "automatic sending is off in FeedRank settings",
      "email.noCredentials": "no SMTP credentials are stored",
      "email.serviceMissing": "the FeedRank email service is not available",
      "email.serviceSilent": "the FeedRank email service did not answer",
      "email.settingsUnreadable": "the email settings could not be read",
      "email.nothingEligible": "nothing eligible to email ({reason})",
      "email.notApproved": "sending was not approved for this run ({reason})",
      "email.sendUnreported": "the send did not report success",
      "email.deliveryStatus": "the delivery ended as {status}",
      "email.preparedNotSent": "Digest prepared but not emailed: {reason} Open FeedRank settings and use Review digest.",

      // -- The schedule report (Check schedule) --------------------------------
      "schedule.off": "Schedule: OFF — no run time is set.",
      "schedule.offHint": "Set a repeat, a day and a time in FeedRank settings, or use the FeedRank menu.",
      "schedule.line": "Schedule: {when} — {armed}{running}.",
      "schedule.armed": "armed",
      "schedule.notArmed": "NOT armed",
      "schedule.runningNow": ", RUNNING now: {stage}",
      "schedule.next": "Next run: {when}.",
      "schedule.nextUnknown": "Next run: unknown.",
      "schedule.period": "This period ({anchor}): {state}.",
      "schedule.done": "already done",
      "schedule.due": "DUE NOW",
      "schedule.waiting": "waiting",
      "schedule.lastRun": "Last run: {outcome}{at}.",
      "schedule.at": " at {time}",
      "schedule.checks": "Checks: {count}{last}.",
      "schedule.checksLast": ", last at {time}",
      "schedule.daily": "daily at {time}",
      "schedule.weekly": "weekly on {day} at {time}",
      "schedule.monthly": "monthly on the {day} at {time}",
      "schedule.none": "no automatic run",
      "schedule.nextRunNow": "Due now: it starts within the next minute.",
      "schedule.nextRunAt": "Next automatic run: {when}.",
      "schedule.periodDone": "This period's run is done ({anchor}). Next automatic run: {when}.",
      "schedule.noTime": "No automatic run: the run time is blank. Use a FeedRank menu command.",

      // -- Progress window -----------------------------------------------------
      "progress.weeklyRun": "FeedRank scheduled run",
      "progress.starting": "Starting the scheduled run…",
      "progress.waitingGpt": "Waiting for Awesome GPT…",
      "progress.gptReady": "Awesome GPT is ready.",
      "progress.refreshing": "Refreshing feeds…",
      "progress.updatingJournal": "Updating journal information",
      "progress.contactingJournal": "Contacting EasyScholar…",
      "progress.journalChecked": "Checking {name}…",
      "progress.journalUpdated": "Journal information updated for {count}.",
      "progress.preparingDigest": "Preparing the digest from stored scores…",
      "progress.scoring": "Scoring feed articles",
      "progress.cancelHint": "Cancel stops the run; nothing partial is cached.",

      // -- Item pane -----------------------------------------------------------
      "item.notScored": "Not scored",
      "item.notScoredJournal": "Not scored · journal data available",
      "item.notScoredBody": "No FeedRank score matching the current settings is cached for this item.",
      "item.notScoredJournalBody": "No matching score is cached. Journal data retrieved from EasyScholar is shown below.",
      "item.running": "FeedRank is running: {stage}…",
      "item.headingWhy": "Why this score",
      "item.headingComponents": "Score components",
      "item.headingBibliometric": "Bibliometric evidence",
      "item.headingProvenance": "Provenance",
      "item.confidence": "Confidence",
      "item.explanation": "Explanation",
      "item.relevanceScore": "Relevance score",
      "item.priorityScore": "Priority score",
      "item.component": "Component {index}",
      "item.journalSource": "Journal data source",
      "item.journalMatched": "Journal matched",
      "item.impactFactor": "Impact factor",
      "item.impactFactor5": "5-year impact factor",
      "item.jcrQuartile": "JCR quartile",
      "item.impactNote": "Raw value, capped locally and not field-normalized",
      "item.estimateSource": "Awesome GPT estimate (the journal lookup returned nothing)",
      "item.estimateStanding": "Journal standing, estimated by the model",
      "item.estimateRationale": "Estimate rationale",
      "item.estimateNote": "Model estimate, not a retrieved metric; it feeds the journal half of Priority only",
      "item.arxivSource": "arXiv signal source",
      "item.arxivModelSource": "Awesome GPT qualitative signal from supplied item metadata only",
      "item.arxivOfflineSource": "User-entered offline keyword fallback (no external lookup)",
      "item.arxivSignificance": "Qualitative arXiv significance",
      "item.arxivRationale": "Qualitative rationale",
      "item.arxivTier": "Highest offline signal tier",
      "item.feed": "Feed/source",
      "item.scoredAt": "Scored",
      "item.provider": "Provider",
      "item.model": "Model",
      "item.promptVersion": "Prompt version",
      "item.notAvailable": "Not available for this score.",
      "item.priorityNote": "Score is the model's relevance score; Priority adds one capped local bonus.",

      // -- Results window ------------------------------------------------------
      "results.title": "FeedRank for Zotero — Scored articles",
      "results.score": "Score",
      "results.priority": "Priority",
      "results.titleColumn": "Title",
      "results.feed": "Feed",
      "results.date": "Date",
      "results.confidence": "Confidence",
      "results.reason": "Relevance explanation",
      "results.evidence": "Local evidence",
      "results.actions": "Actions",
      "results.openArticle": "Open article",
      "results.showItem": "Show Zotero item",
      "results.previewEmail": "Preview email",
      "results.sendDigest": "Send digest…",
      "results.rescore": "Rescore latest",
      "results.close": "Close",
      "results.total": "Total for this ranking across {calls}: {usage}",
      "results.empty": "No scored articles match the current settings.",
      "results.savedSample": "Saved results retain a bounded sample of feed and call details.",

      // -- Settings panes: status lines ----------------------------------------
      "pane.saved": "Saved.",
      "pane.scheduleOff": "No automatic run is scheduled: the run time is blank.",
      "pane.checking": "Starting the job: refresh, score, digest…",
      "pane.notYet": "FeedRank is still starting. Reopen this pane in a moment.",
      "pane.previewUnavailable": "No digest preview yet: {reason}",
      "pane.noCredentials": "No credentials saved.",
      "pane.credentialsSession": "Credentials: session only.",
      "pane.nothingSent": "Nothing has been sent yet.",
      "settings.unavailable": "The settings-file feature is unavailable: FeedRank is still starting.",
      "settings.exportTitle": "Save FeedRank settings",
      "settings.importTitle": "Load FeedRank settings",
      "settings.cancelled": "cancelled",
      "settings.noPath": "no file was chosen",
      "settings.resetConfirm": "Reset every FeedRank setting to its default?",
      "settings.resetConfirmButton": "Reset settings",
      "settings.exported": "Settings saved to {path} (no password or key is included).",
      "settings.exportedWithCredentials": "Settings saved to {path}, including your saved credentials as encrypted copies.",
      "settings.exportFailed": "The settings could not be saved: {reason}",
      "settings.imported": "Settings loaded from {path}.",
      "settings.importedApplied": "Settings loaded from {path}. Applied: {items}.",
      "settings.noFileFromPicker": "The file dialog closed without a file (result {code}). Nothing was loaded.",
      "settings.importedIgnored": "Settings loaded, and {count} credential-looking field(s) ignored.",
      "settings.importFailed": "The settings could not be loaded: {reason}",
      "settings.resetDone": "All settings are back at their defaults, and the saved password and key were removed. Your cached scores were kept.",
      "settings.resetFailed": "The settings could not be reset: {reason}",
      "journal.noKey": "Journal metrics were skipped: no EasyScholar key is saved. Add one in FeedRank settings to use journal data.",
      "settings.resetPartial": "These did not reset: {items} — try again, or remove them in about:config.",
      "settings.whatSmtp": "SMTP password",
      "settings.whatScholar": "EasyScholar key",
      "settings.whatCredentials": "saved credentials",
      "settings.and": " and ",
      "settings.credentialsAsk": "This file can also carry {what} as ENCRYPTED copies: exactly the ciphertext your OS credential store holds. The key that unlocks it stays in this machine's OS key store, so the copies work only for this OS account on this machine \u2014 not on another computer, and not after that key store is reset. Anyone who can use this computer account can decrypt them, so treat the file like a password. Include them?",
      "settings.credentialsRestored": "The {what} from the file was restored.",
      "settings.credentialsUnusable": "The {what} in the file could not be decrypted on this machine — the key that unlocks it lives in the OS key store of the computer that wrote the file — so it was left empty. Enter it again in the settings.",
      "settings.credentialsUnavailable": "The {what} in the file was not restored: secure storage is unavailable in this session.",
      "settings.credentialsNoConnection": "The {what} in the file was not restored: the file carries no SMTP connection for it to belong to. Save the connection and import again.",
    },
    "zh-CN": {
      "menu.refresh": "刷新并评分",
      "menu.scoreDays": "为最近 N 天评分…",
      "menu.rescoreDays": "重新评分最近 N 天…",
      "menu.sendDigest": "立即发送周报",
      "menu.showScores": "查看已评分的文章",
      "menu.settings": "设置…",
      "menu.updateJournal": "更新期刊信息",
      "menu.scoreDaysScope": "为 N 天内评分…",
      "menu.rescoreDaysScope": "重新评分 N 天内…",
      "menu.showScoresScope": "查看评分",
      "menu.scoreSelected": "为选中的条目评分",
      "menu.rescoreSelected": "重新评分为选中的条目",
      "item.sectionHeader": "FeedRank 评分",
      "item.sectionSidenav": "FeedRank 评分详情",

      "run.title": "FeedRank 定时任务",
      "run.titleStage": "FeedRank 定时任务：{stage}",
      "run.startedLine": "开始于 {time}。",
      "run.closes": "此提示会自动关闭。",
      "run.finished": "FeedRank 定时任务完成：{outcome}",
      "run.started": "定时任务已开始（{anchor}）。正在刷新并评分最近 {days}。",
      "run.cancelled": "定时任务已取消，将在下次检查时重试。",
      "run.notStarted": "定时任务未启动：{error} 将在下次检查时重试。",
      "run.didNotFinish": "定时任务未完成：{error}",
      "run.busy": "已有刷新或评分任务正在运行。",
      "run.outcomeHeading": "FeedRank 定时任务已完成。",
      "run.feeds": "订阅源：{ok}/{total} 已更新{failed}。",
      "run.feedsFailed": "，{count} 个失败",
      "run.articles": "文章：新评分 {scored} 篇，已有评分 {reused} 篇{replaced}。",
      "run.articlesReplaced": "，重新评分 {count} 篇",
      "run.articlesNone": "文章：没有需要新评分的内容。",

      "email.sent": "邮件：已发送至 {to}。",
      "email.sentUnknownRecipient": "邮件：已发送。",
      "email.notSent": "邮件：未发送 — {reason}。",
      "email.notPrepared": "邮件：本次运行没有生成摘要。",
      "email.approvalOff": "FeedRank 设置中已关闭自动发送",
      "email.noCredentials": "未保存 SMTP 凭据",
      "email.serviceMissing": "FeedRank 邮件服务不可用",
      "email.serviceSilent": "FeedRank 邮件服务没有响应",
      "email.settingsUnreadable": "无法读取邮件设置",
      "email.nothingEligible": "没有可发送的内容（{reason}）",
      "email.notApproved": "本次运行未获发送许可（{reason}）",
      "email.sendUnreported": "发送未报告成功",
      "email.deliveryStatus": "投递结果为 {status}",
      "email.preparedNotSent": "摘要已生成但未发送：{reason} 请在 FeedRank 设置中使用“查看摘要”手动发送。",

      "schedule.off": "计划：已关闭 — 未设置运行时间。",
      "schedule.offHint": "请在 FeedRank 设置中选择重复方式、日期和时间，或使用 FeedRank 菜单。",
      "schedule.line": "计划：{when} — {armed}{running}。",
      "schedule.armed": "已就绪",
      "schedule.notArmed": "未就绪",
      "schedule.runningNow": "，正在运行：{stage}",
      "schedule.next": "下次运行：{when}。",
      "schedule.nextUnknown": "下次运行：未知。",
      "schedule.period": "本周期（{anchor}）：{state}。",
      "schedule.done": "已完成",
      "schedule.due": "现在到期",
      "schedule.waiting": "等待中",
      "schedule.lastRun": "上次运行：{outcome}{at}。",
      "schedule.at": "，{time}",
      "schedule.checks": "检查次数：{count}{last}。",
      "schedule.checksLast": "，最近 {time}",
      "schedule.daily": "每天 {time}",
      "schedule.weekly": "每周{day} {time}",
      "schedule.monthly": "每月 {day} 日 {time}",
      "schedule.none": "没有自动运行",
      "schedule.nextRunNow": "现在到期：将在下一分钟内开始。",
      "schedule.nextRunAt": "下次自动运行：{when}。",
      "schedule.periodDone": "本周期已运行（{anchor}）。下次自动运行：{when}。",
      "schedule.noTime": "没有自动运行：运行时间为空。请使用 FeedRank 菜单命令。",

      "progress.weeklyRun": "FeedRank 定时任务",
      "progress.starting": "正在启动定时任务…",
      "progress.waitingGpt": "正在等待 Awesome GPT…",
      "progress.gptReady": "Awesome GPT 已就绪。",
      "progress.refreshing": "正在刷新订阅源…",
      "progress.updatingJournal": "正在更新期刊信息",
      "progress.contactingJournal": "正在连接 EasyScholar…",
      "progress.journalChecked": "正在检查 {name}…",
      "progress.journalUpdated": "已更新 {count} 个期刊的信息。",
      "progress.preparingDigest": "正在用已有评分生成摘要…",
      "progress.scoring": "正在评分订阅文章",
      "progress.cancelHint": "取消会终止本次运行，不会缓存任何部分结果。",

      "item.notScored": "未评分",
      "item.notScoredJournal": "未评分 · 有期刊数据",
      "item.notScoredBody": "缓存中没有与当前设置匹配的 FeedRank 评分。",
      "item.notScoredJournalBody": "缓存中没有匹配的评分。以下显示从 EasyScholar 获取的期刊数据。",
      "item.running": "FeedRank 正在运行：{stage}…",
      "item.headingWhy": "评分理由",
      "item.headingComponents": "评分构成",
      "item.headingBibliometric": "文献计量依据",
      "item.headingProvenance": "来源信息",
      "item.confidence": "置信度",
      "item.explanation": "说明",
      "item.relevanceScore": "相关性评分",
      "item.priorityScore": "综合优先级",
      "item.component": "第 {index} 项",
      "item.journalSource": "期刊数据来源",
      "item.journalMatched": "匹配期刊",
      "item.impactFactor": "影响因子",
      "item.impactFactor5": "五年影响因子",
      "item.jcrQuartile": "JCR 分区",
      "item.impactNote": "原始数值，仅在本地封顶，未按学科归一化",
      "item.estimateSource": "Awesome GPT 估算（期刊查询无结果）",
      "item.estimateStanding": "模型估算的期刊水平",
      "item.estimateRationale": "估算理由",
      "item.estimateNote": "模型估算，非检索到的指标；仅用于优先级的期刊部分",
      "item.arxivSource": "arXiv 信号来源",
      "item.arxivModelSource": "Awesome GPT 依据所提供条目信息给出的定性信号",
      "item.arxivOfflineSource": "用户输入的离线关键词回退（不联网查询）",
      "item.arxivSignificance": "arXiv 定性重要性",
      "item.arxivRationale": "定性理由",
      "item.arxivTier": "离线信号最高层级",
      "item.feed": "订阅源",
      "item.scoredAt": "评分时间",
      "item.provider": "服务商",
      "item.model": "模型",
      "item.promptVersion": "提示词版本",
      "item.notAvailable": "本次评分无此信息。",
      "item.priorityNote": "Score 为模型的相关性评分；Priority 在此基础上加入一个封顶的本地加成。",

      "results.title": "FeedRank for Zotero — 已评分文章",
      "results.score": "评分",
      "results.priority": "优先级",
      "results.titleColumn": "标题",
      "results.feed": "订阅源",
      "results.date": "日期",
      "results.confidence": "置信度",
      "results.reason": "相关性说明",
      "results.evidence": "本地依据",
      "results.actions": "操作",
      "results.openArticle": "打开文章",
      "results.showItem": "在 Zotero 中显示",
      "results.previewEmail": "预览邮件",
      "results.sendDigest": "发送摘要…",
      "results.rescore": "重新评分最近文章",
      "results.close": "关闭",
      "results.total": "本次评分共 {calls}：{usage}",
      "results.empty": "没有符合当前设置的已评分文章。",
      "results.savedSample": "已保存的结果仅保留部分订阅源与调用明细。",

      "pane.saved": "已保存。",
      "pane.scheduleOff": "未安排自动运行：运行时间为空。",
      "pane.checking": "正在启动任务：刷新、评分、摘要…",
      "pane.notYet": "FeedRank 仍在启动，请稍后重新打开此面板。",
      "pane.previewUnavailable": "尚无摘要预览：{reason}",
      "pane.noCredentials": "未保存凭据。",
      "pane.credentialsSession": "凭据：仅本次会话。",
      "pane.nothingSent": "尚未发送任何邮件。",
      "settings.unavailable": "设置文件功能尚不可用：FeedRank 仍在启动。",
      "settings.exportTitle": "保存 FeedRank 设置",
      "settings.importTitle": "载入 FeedRank 设置",
      "settings.cancelled": "已取消",
      "settings.noPath": "未选择文件",
      "settings.resetConfirm": "要把所有 FeedRank 设置恢复为默认值吗？",
      "settings.resetConfirmButton": "重置设置",
      "settings.exported": "设置已保存到 {path}（不包含密码或密钥）。",
      "settings.exportedWithCredentials": "设置已保存到 {path}，其中包含以加密形式保存的凭据副本。",
      "settings.exportFailed": "设置保存失败：{reason}",
      "settings.imported": "已从 {path} 载入设置。",
      "settings.importedApplied": "已从 {path} 载入设置，已应用：{items}。",
      "settings.noFileFromPicker": "文件对话框未返回文件（返回码 {code}），未载入任何内容。",
      "settings.importedIgnored": "设置已载入，忽略了 {count} 个疑似凭据的字段。",
      "settings.importFailed": "设置载入失败：{reason}",
      "settings.resetDone": "所有设置已恢复默认值，保存的密码和密钥已删除；已缓存的评分保留不变。",
      "settings.resetFailed": "设置重置失败：{reason}",
      "journal.noKey": "已跳过期刊指标：未保存 EasyScholar 密钥。请在 FeedRank 设置中添加密钥后使用期刊数据。",
      "settings.resetPartial": "以下项目未能重置：{items}——请重试，或在 about:config 中手动删除。",
      "settings.whatSmtp": "SMTP 密码",
      "settings.whatScholar": "EasyScholar 密钥",
      "settings.whatCredentials": "已保存的凭据",
      "settings.and": "和",
      "settings.credentialsAsk": "该文件还可以携带{what}的加密副本：内容与本机操作系统凭据库中的密文完全相同。解密用的密钥保存在本机操作系统密钥库中，因此只有本机的这个系统账户能解开——换一台电脑、或该密钥库被重置后都无法解开；但能使用本机这个系统账户的人都可以解密，请把该文件当作密码对待。要包含吗？",
      "settings.credentialsRestored": "文件中的{what}已恢复。",
      "settings.credentialsUnusable": "文件中的{what}在这台机器上无法解密（密钥保存在写入该文件的那台电脑的系统密钥库中），已留空——请在设置中重新输入。",
      "settings.credentialsUnavailable": "文件中的{what}未能恢复：本次会话无法使用安全存储。",
      "settings.credentialsNoConnection": "文件中的{what}未能恢复：文件里没有可归属的 SMTP 连接信息。请先保存连接设置，再重新导入。"
    },
  };

  /*
   * The settings panes' own text, keyed by the control id the pane already uses.
   *
   * English is NOT repeated here: the XHTML markup is the English source, and it is only
   * replaced when another language is active. That keeps one English copy of every label
   * instead of two that can disagree.
   */
  const PANE_TEXT = {
    "zh-CN": {
      "feed-ranker-profile": { label: "研究兴趣简介", hint: "修改后，匹配的已缓存评分会失效；不会改动 Zotero 条目本身。" },
      "feed-ranker-language": { label: "说明语言" },
      "feed-ranker-lookback": { label: "回溯天数（0–365）" },
      "feed-ranker-limit": { label: "每次刷新评分篇数（1–500）", hint: "回溯窗口内的条目都会检查，只把最新的这些篇发给模型。" },
      "feed-ranker-batch": { label: "每次 GPT 调用篇数（1–50）", hint: "调用次数更少、每次更大，比多次小调用快得多。" },
      "feed-ranker-concurrency": { label: "并发请求数（1–3）", hint: "重叠等待时间；1 表示逐个发送。" },
      "feed-ranker-retries": { label: "每批重试次数（0–3）" },
      "feed-ranker-timeout": { label: "请求超时（毫秒）" },
      "feed-ranker-input-price": { label: "输入价格 / 百万 token", hint: "可选。未填价格时费用显示为不可用，而不是 0。" },
      "feed-ranker-output-price": { label: "输出价格 / 百万 token" },
      "feed-ranker-cost-currency": { label: "货币代码" },
      "feed-ranker-bibliometric-weight": { label: "计入总分的最大加成（0–10 分）", hint: "三项共用一个上限：期刊影响因子、arXiv 重要性，或模型对期刊的估算。0 表示关闭。" },
      "feed-ranker-arxiv-significance-signals": { label: "可选，每行一位作者或机构", hint: "本地离线使用，仅用于重要性字段成为必需之前保存的评分。" },
      "feed-ranker-easyscholar-enabled": { label: "启用 EasyScholar 期刊查询" },
      "feed-ranker-easyscholar-refresh": { label: "评分前重新读取期刊指标" },
      "feed-ranker-easyscholar-key": { label: "EasyScholar 密钥", hint: "已解析的期刊会一直复用，因为指标不会变化。用“更新期刊信息”可重新读取。" },
      "feed-ranker-run-frequency": { label: "重复方式", hint: "摘要覆盖与重复方式对应的天数：1 天、7 天或 30 天的评分。" },
      "feed-ranker-weekly-day": { label: "运行日", hint: "每周按星期；每月按日期（31 日在短月按当月最后一天运行）。" },
      "feed-ranker-weekly-time": { label: "运行时间（HH:MM）", hint: "Zotero 启动时不会运行。留空即关闭自动运行，可用 FeedRank 菜单手动执行。" },
      "feed-ranker-email-max-papers": { label: "最多文章数（1–100）" },
      "feed-ranker-email-min-score": { label: "最低相关性评分（0–100）" },
      "feed-ranker-email-priority-count": { label: "优先文章数" },
      "feed-ranker-email-reading-count": { label: "可选阅读清单数量" },
      "feed-ranker-email-reading-enabled": { label: "在文章数上限内包含可选阅读清单" },
      "feed-ranker-email-auto-enabled": { label: "自动发送周报", hint: "定时发送的长期授权。关闭后定时任务不会发邮件。" },
      "feed-ranker-email-host": { label: "SMTP 服务器" },
      "feed-ranker-email-port": { label: "SMTP 端口" },
      "feed-ranker-email-tls-mode": { label: "TLS 模式" },
      "feed-ranker-email-auth-method": { label: "认证方式", hint: "以服务器公布的列表为准：FeedRank 使用其中最强的机制。" },
      "feed-ranker-email-username": { label: "SMTP 用户名" },
      "feed-ranker-email-secret": { label: "SMTP 密码或应用专用密码", hint: "绝不写入 FeedRank 首选项。请使用服务商签发的应用密码。" },
      "feed-ranker-email-from": { label: "发件人地址" },
      "feed-ranker-email-to": { label: "收件人" },
      "feed-ranker-email-save-options": { label: "保存摘要设置" },
      "feed-ranker-weekly-check": { label: "检查计划" },
      "feed-ranker-email-save-credentials": { label: "保存凭据" },
      "feed-ranker-email-clear-credentials": { label: "清除凭据" },
      "feed-ranker-email-test-connection": { label: "测试连接" },
      "feed-ranker-email-test-button": { label: "发送测试邮件" },
      "feed-ranker-email-preview-button": { label: "查看摘要" },
      "feed-ranker-email-rebuild": { label: "重新生成摘要" },
      "feed-ranker-email-retry-button": { label: "重试未发送的摘要" },
      "feed-ranker-email-copy-diagnostics": { label: "复制连接日志" },
      "feed-ranker-email-copy-safe-diagnostics": { label: "复制脱敏日志" },
      "feed-ranker-email-log": { hint: "连接日志内容（只读）。" },
      "feed-ranker-email-log-path": { hint: "日志文件在磁盘上的位置。" },
      "feed-ranker-journal-save": { label: "保存期刊设置" },
      "feed-ranker-journal-save-key": { label: "保存密钥" },
      "feed-ranker-journal-clear-key": { label: "清除密钥" },
      "feed-ranker-journal-update": { label: "更新期刊信息" },
      "run-frequency": { label: "重复方式", hint: "摘要覆盖与重复方式对应的天数：1 天、7 天或 30 天的评分。" },
      "weekly-day": { label: "运行日", hint: "每周按星期；每月按日期（31 日在短月按当月最后一天运行）。" },
      "weekly-time": { label: "运行时间（HH:MM）", hint: "Zotero 启动时不会运行。留空即关闭自动运行，可用 FeedRank 菜单手动执行。" },
      "monthly-day": { label: "每月日期（1–31）" },
      "weekly-check": { label: "检查计划" },
      "bibliometric-weight": { label: "计入总分的最大加成（0–10 分）", hint: "三项共用一个上限：期刊影响因子、arXiv 重要性，或模型对期刊的估算。0 表示关闭。" },
      "profile": { label: "研究兴趣简介", hint: "修改后，匹配的已缓存评分会失效；不会改动 Zotero 条目本身。" },
      "language": { label: "说明语言" },
      "lookback": { label: "回溯天数（0–365）" },
      "limit": { label: "每次刷新评分篇数（1–500）" },
      "batch": { label: "每次 GPT 调用篇数（1–50）" },
      "concurrency": { label: "并发请求数（1–3）" },
      "retries": { label: "每批重试次数（0–3）" },
      "timeout": { label: "请求超时（毫秒）" },
      "input-price": { label: "输入价格 / 百万 token" },
      "output-price": { label: "输出价格 / 百万 token" },
      "currency": { label: "货币代码" },
      "arxiv-significance-signals": { label: "arXiv 离线关键词回退（可选）" },
      "easyscholar-key": { label: "EasyScholar 密钥" },
      "email-max-papers": { label: "最多文章数（1–100）" },
      "email-min-score": { label: "最低相关性评分（0–100）" },
      "email-priority-count": { label: "优先文章数" },
      "email-reading-count": { label: "可选阅读清单数量" },
      "email-reading-enabled": { label: "在文章数上限内包含阅读清单文章" },
      "email-auto-enabled": { label: "自动发送周报", hint: "定时发送的长期授权。关闭后定时任务不会发邮件。" },
      "email-host": { label: "SMTP 服务器" },
      "email-port": { label: "SMTP 端口" },
      "email-tls-mode": { label: "TLS 模式" },
      "email-auth-method": { label: "认证方式", hint: "以服务器公布的列表为准：FeedRank 使用其中最强的机制。" },
      "email-username": { label: "SMTP 用户名" },
      "email-secret": { label: "SMTP 密码或应用专用密码", hint: "绝不写入 FeedRank 首选项。请使用服务商签发的应用密码。" },
      "email-from": { label: "发件人地址" },
      "email-to": { label: "收件人" },
      "email-save-options": { label: "保存摘要设置" },
      "save": { label: "保存" },
      "cancel": { label: "取消" },
      "email-save-credentials": { label: "保存凭据" },
      "email-clear-credentials": { label: "清除凭据" },
      "email-test-connection": { label: "测试连接" },
      "email-preview": { label: "摘要预览" },
      "email-retry": { label: "重试未发送的摘要" },
      "journal-save": { label: "保存期刊设置" },
      "journal-save-key": { label: "保存密钥" },
      "journal-clear-key": { label: "清除密钥" },
      "feed-ranker-save": { label: "保存设置" },
      "feed-ranker-monthly-day": { hint: "每月按此日期运行；若当月没有该日，则在当月最后一天运行。" },
      "feed-ranker-prompt-preview": { label: "将要发送的提示词预览" },
      "feed-ranker-email-preview": { label: "当前摘要预览" },
      "easyscholar-enabled": { label: "启用 EasyScholar 期刊查询" },
      "easyscholar-refresh": { label: "评分前重新读取期刊指标" },
      "prompt-preview": { label: "提示词预览" },
      "email-test": { label: "发送测试邮件…" },
      "email-copy-diagnostics": { label: "复制日志" },
      "email-copy-safe-diagnostics": { label: "复制脱敏日志" },
      "email-log": { hint: "连接日志内容（只读）。" },
      "email-log-path": { hint: "日志文件在磁盘上的位置。" },
      "email-rebuild": { label: "重新生成摘要" },
      "email-review": { label: "查看摘要" },
      "feed-ranker-settings-export": { label: "保存设置到文件…" },
      "feed-ranker-settings-import": { label: "从文件载入设置…" },
      "feed-ranker-settings-reset": { label: "重置所有设置" },
      "feed-ranker-settings-file-title": { label: "设置文件" },
      "settings-export": { label: "保存设置到文件…" },
      "settings-import": { label: "从文件载入设置…" },
      "settings-reset": { label: "重置所有设置" },
    },
  };

  /*
   * The panes' static sentences, keyed by the `data-i18n` attribute on the element.
   *
   * Headings, descriptions, subheads, action-row captions and the read-only value lines have
   * no control of their own, which is why they stayed English while every labelled field was
   * already translated. English is not repeated here: the markup carries it.
   */
  const PANE_STATIC = {
    "zh-CN": {
      "pane.preferences.connection": "连接",
      "pane.preferences.connection-log": "连接日志",
      "pane.preferences.email-connection-log": "邮件连接日志",
      "pane.preferences.connection-log-show": "显示连接日志",
  "pane.settingsFile.heading": "设置文件",
  "pane.settingsFile.action": "备份",
  "pane.settingsFile.hint": "保存设置，可选择附带加密的凭据副本。重置会删除密码和密钥，评分保留。",
      "pane.preferences.credentials": "凭据",
      "pane.preferences.digest": "摘要",
      "pane.preferences.easyscholar-journal-lookup": "EasyScholar 期刊查询",
      "pane.preferences.email-connection": "邮件连接",
      "pane.preferences.email-digest": "邮件摘要",
      "pane.preferences.key": "密钥",
      "pane.preferences.lookup": "查询",
      "pane.preferences.nothing-has-been-sent": "尚未发送任何邮件。",
      "pane.preferences.on-the-repeat-you": "按你选择的重复方式，FeedRank 会刷新订阅源、评分该时段的文章并发送摘要。通过已验证的 TLS 直接使用 SMTP。",
      "pane.preferences.optional-significance-weight": "可选的显著性加成",
      "pane.preferences.preview-and-sending": "预览与发送",
      "pane.preferences.read-only-and-it": "只读。它有意占满整行：载荷行远宽于任何一列。打开此面板不会向 Awesome GPT 发送请求。",
      "pane.preferences.retry": "重试",
      "pane.preferences.schedule": "计划",
      "pane.preferences.score-is-awesome-gpt": "Score 是 Awesome GPT 的相关性评分；Priority 在此基础上加入一个很小的、封顶的本地加成。",
      "pane.preferences.scoring-prompt-preview": "评分提示词预览",
      "pane.preferences.scoring-settings": "评分设置",
      "pane.preferences.sending-is-the-confirmation": "点击发送即为确认，不会再弹出第二个对话框。“查看摘要”会打开将要发出的那封已冻结的邮件。",
      "pane.preferences.server-first-then-the": "先填服务器，再填凭据。密码绝不写入首选项。",
      "pane.preferences.your-research-feeds-ranked": "你的研究订阅源，按相关性排序。每项设置都在插件旁的 SETTINGS.md 中有说明。",
      "pane.preferences.arxiv-offline-keyword-fallback": "arXiv 离线关键词回退",
      "pane.preferences.digest-contents": "摘要内容",
      "pane.preferences.scheduled-delivery": "定时发送",
      "pane.preferences.token-and-cost-estimate": "token 与费用估算",
      "pane.settings.easyscholar-journal-lookup": "EasyScholar 期刊查询",
      "pane.settings.email-connection": "邮件连接",
      "pane.settings.email-connection-log": "邮件连接日志",
      "pane.settings.connection-log-show": "显示连接日志",
      "pane.settings.email-digest": "邮件摘要",
      "pane.settings.nothing-has-been-sent": "尚未发送任何邮件。",
      "pane.settings.optional-significance-weight": "可选的显著性加成",
      "pane.settings.preview-rebuild-and-sending": "预览、重新生成与发送",
      "pane.settings.scoring": "评分",
      "pane.settings.scoring-prompt-preview": "评分提示词预览",
      "pane.settings.token-and-cost-estimate": "token 与费用估算",
    },
  };

  function normalizeLocale(value) {
    const tag = String(value == null ? "" : value).trim().toLowerCase();
    if (!tag) return DEFAULT_LOCALE;
    if (tag.startsWith("zh")) return "zh-CN";
    return DEFAULT_LOCALE;
  }

  /*
   * The active language.
   *
   * `Zotero.locale` is Zotero's own UI locale, which is the system language on a fresh
   * installation and the user's explicit choice otherwise -- exactly the switch that was
   * asked for. The fallbacks exist for the panes, which run in a second window, and for
   * tests.
   */
  function detectLocale({ Zotero, navigator: navigatorLike } = {}) {
    const candidates = [
      Zotero?.locale,
      Zotero?.Prefs?.get?.("intl.locale.requested"),
      navigatorLike?.language,
      navigatorLike?.languages?.[0],
    ];
    for (const candidate of candidates) {
      const text = String(candidate == null ? "" : candidate).trim();
      if (text) return normalizeLocale(text);
    }
    return DEFAULT_LOCALE;
  }

  function format(template, params) {
    if (!params) return template;
    return String(template).replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
  }

  function create({ locale = DEFAULT_LOCALE } = {}) {
    const active = normalizeLocale(locale);
    const table = STRINGS[active] || STRINGS[DEFAULT_LOCALE];
    const fallback = STRINGS[DEFAULT_LOCALE];

    /*
     * Synchronous by design. A missing key falls back to English and then to the key
     * itself, so a missing translation shows up as a visible `key.name` instead of an
     * empty notice.
     */
    function t(key, params) {
      const name = String(key == null ? "" : key);
      const template = table[name] ?? fallback[name];
      if (template == null) return name;
      return format(template, params);
    }

    /*
     * Replace the pane's own English labels, hints and buttons, by control id.
     *
     * Nothing happens in English: the markup already carries it. Every lookup is guarded,
     * because a pane may be a version behind the dictionary while it is being edited, and
     * a missing id must never break the settings window.
     */
    function applyPane(root) {
      if (!root) return false;
      let applied = applyLabels(root);
      applied = applyStatic(root, applied);
      return applied > 0;
    }

    /*
     * Control labels, hints and buttons, by the id the pane already uses.
     *
     * Nothing happens in English: the markup already carries it. Every lookup is guarded,
     * because a pane may be a version behind the dictionary while it is being edited, and a
     * missing id must never break the settings window.
     */
    function applyLabels(root) {
      const text = PANE_TEXT[active] || {};
      let applied = 0;
      for (const [id, entry] of Object.entries(text)) {
        const control = root.querySelector("#" + id);
        if (!control) continue;
        const label = entry.label ? root.querySelector('label[for="' + id + '"]') : null;
        if (label && entry.label) {
          label.textContent = entry.label;
          applied += 1;
        } else if (control.tagName?.toLowerCase() === "button" && entry.label) {
          control.textContent = entry.label;
          if (control.hasAttribute("label")) control.setAttribute("label", entry.label);
          applied += 1;
        } else if (control.parentElement?.tagName?.toLowerCase() === "label" && entry.label) {
          // A check box: the label wraps the input, so only its trailing text node may be
          // replaced -- replacing textContent would delete the input itself.
          const wrapper = control.parentElement;
          for (let index = wrapper.childNodes.length - 1; index >= 0; index -= 1) {
            const node = wrapper.childNodes[index];
            if (node.nodeType === 3 && String(node.nodeValue || "").trim()) {
              node.nodeValue = " " + entry.label;
              applied += 1;
              break;
            }
          }
        }
        if (entry.hint) {
          const row = control.closest?.("html\\:div, div") || control.parentElement;
          const scope = control.closest?.(".feed-ranker-ctl") || control.closest?.(".ctl") || row;
          const hint = scope?.querySelector?.(".feed-ranker-hint, .hint");
          if (hint) {
            hint.textContent = entry.hint;
            applied += 1;
          }
        }
      }
      return applied;
    }

    /*
     * The static sentences: headings, descriptions, subheads, action-row captions and the
     * read-only value lines, keyed by the element's `data-i18n` attribute.
     */
    function applyStatic(root, applied) {
      const statics = PANE_STATIC[active];
      if (!statics || typeof root.querySelectorAll !== "function") return applied;
      for (const node of root.querySelectorAll("[data-i18n]")) {
        const value = statics[node.getAttribute("data-i18n")];
        if (value) {
          node.textContent = value;
          applied += 1;
        }
      }
      return applied;
    }
    return Object.freeze({ locale: active, t, applyPane });
  }

  return Object.freeze({
    DEFAULT_LOCALE,
    SUPPORTED_LOCALES,
    STRINGS,
    PANE_TEXT,
    PANE_STATIC,
    normalizeLocale,
    detectLocale,
    format,
    create,
    // The language names, for a pane that wants to show which one is active.
    localeLabel: (locale) => (normalizeLocale(locale) === "zh-CN" ? "中文" : "English"),
  });
});
