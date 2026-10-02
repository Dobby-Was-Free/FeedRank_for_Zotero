# FeedRank for Zotero — settings explained

Every setting in the FeedRank pane, what it does, and what it does not do. The
in-app hints are one line each on purpose; the detail lives here so the pane stays
readable.

---

## Settings file

Three buttons at the end of the pane, for moving a configuration between machines or starting
over.

| Button | What it does |
| --- | --- |
| **Save settings to file…** | Writes your settings to a `.json` file you choose: the research
profile, the scoring and schedule settings, the digest options, and the EasyScholar lookup
options. |
| **Load settings from file…** | Reads such a file back and applies it. Values are bounded
exactly as if you had typed them, and anything the file contains that this build does not
recognise is ignored. |
| **Reset all settings** | Returns every setting to its default, after a confirmation. **Your
cached scores and cached journal metrics are kept** — recomputing those costs model calls, so
they are never thrown away by a settings reset. |

**A saved file is private, even though it holds no readable credential.** The password and the key
themselves live in an OS-encrypted credential store (see [PRIVACY.md](PRIVACY.md)) and are never
written in readable form; an import ignores any credential-looking field, and says how many it
ignored. What the file *does* contain is your research profile and your mail identities — SMTP host,
username, sender and recipient — in plain text, plus optionally those credentials as encrypted
copies. Do not commit it, attach it to an issue, or leave it in a shared folder. After loading
settings on another machine, re-enter the password and the key.

A file from a different settings format is refused with a reason rather than partially applied,
and a file that cannot be read changes nothing at all.

## Scoring settings

| Setting | Meaning |
| --- | --- |
| **Research interest profile** | The text every candidate is judged against. Changing it invalidates matching cached scores, so the next run re-scores them. |
| **Explanation language** | The language of the one-sentence relevance explanation the model returns. It is part of the question, so changing it invalidates matching cached scores. |
| **Lookback days** (0–365) | How far back a feed refresh collects articles. 0 means today only. |
| **Papers scored per refresh** (1–500) | A cost cap, not a scan cap: every item in the lookback window is checked, and only this many of the newest are sent to the model in that refresh. |
| **Papers per Awesome GPT call** (1–50) | How many papers one request carries. Fewer, larger calls are much faster than many small ones. |
| **Requests at once** (1–3) | Overlaps the waiting between batch calls. 1 sends them one at a time. It changes dispatch only, never the prompt or the cache fingerprint. |
| **Retries per batch** (0–3) | How many times a failed call is retried, with the same bytes, before the batch is reported as failed. |
| **Request timeout (ms)** | How long one call may take before it is treated as failed. |
| **Currency code** | The currency the optional prices are entered in. |
| **Input price per 1M tokens** / **Output price per 1M tokens** | Optional rates. Without prices the cost is reported as unavailable, never as zero. |
| **Maximum significance added to total score (0–10 points)** | The shared local maximum added on top of the relevance Score. It is fed by a journal impact factor, or by the arXiv significance value, or — when the journal lookup finds nothing — by the model's own estimate of the venue. 0 disables it. |
| **Optional, one author or institution per line** | A local, offline keyword fallback for scores saved before the significance field became required. It never leaves the machine. |
| **Enable EasyScholar journal lookup** | Turns the journal lookup on. Nothing is sent anywhere until this is on and a key is saved. |
| **Re-read journal data before scoring** | Optional. A cached journal costs no request, and a failure never blocks scoring. |
| **EasyScholar secret key** | Stored in an isolated encrypted Login Manager entry, never in a preference. A resolved journal is reused with no expiry, because its metrics do not change. |

### Score and Priority

**Score** is the model's relevance judgement, 0–100. **Priority** is that Score plus the
bounded local significance bonus above, capped at 100; the results window shows both, and
the item pane explains which evidence produced the bonus. The model is asked for a journal
standing estimate only where the lookup found no usable metrics, and that estimate is
labelled as one wherever it is shown.

### The email digest

| Setting | Meaning |
| --- | --- |
| **Repeat** | **Daily**, **Weekly**, or **Monthly**. The digest's span follows it: one day, seven days, or thirty. |
| **Run day** | Weekly: which weekday. Monthly: which day of the month (31 runs on the last day of a short month). |
| **Run time** | `HH:MM` local time, or **blank** for no automatic run at all. See below. |
| **Last email** | Read-only: when a message was last accepted (or last failed), and where it went. |
| **Maximum papers** | Most papers one digest may contain. |
| **Minimum relevance Score** | Papers below this relevance Score are excluded from the digest. |
| **Priority-paper count** | How many of the top Priority papers to lead with. |
| **Optional reading-list count** | Papers from the reading list included within the maximum-paper cap. |
| **Include reading-list papers…** | Whether the optional list is used at all. |
| **Send the weekly digest automatically** | The standing approval for the scheduled send. See below. |
| **Rebuild digest** | Recreates this period's digest from the scores already in Zotero. Sends nothing. See below. |
| **Review digest** | Opens that exact message; sending it there is the confirmation. |

### The scheduled run

**The run covers the period its repeat names — one day, the last seven days, or the last
thirty — regardless of the Lookback days setting.** A daily repeat emails a daily digest
and a monthly one a monthly digest, because that is what the cadence means. The message's
**subject** always names the window it covers, for example
`FeedRank weekly digest — 2026-09-24 to 2026-09-30`, so the span is visible in the inbox
and the body starts straight at the papers.

**Repeat** is **Daily**, **Weekly**, or **Monthly**. Daily runs every day at the set time;
Weekly runs on the chosen **Run day**; Monthly runs on the chosen day of the month, and a
day a short month does not have (the 31st in April) is served on that month's last day
rather than skipped.

**Nothing is refreshed because Zotero started.** The automatic run happens at the time you
set, while Zotero is open, and at no other moment. A blank time means there is no automatic
run at all, and you drive the work from the **Tools → FeedRank for Zotero** commands
instead — **Send weekly digest** performs the whole job on demand.

**Run time** is a local `HH:MM`. `08:00`, `8:05`, `1:30pm` all parse.

The window for a scheduled run is the rest of the scheduled **day** (or, for a monthly
repeat, the rest of the month): a machine that was asleep at 16:50 still runs when it wakes
at 17:30, and a period that went by with Zotero closed is left alone rather than caught up
at the next launch. That is also why the setting polls rather than setting one alarm — a
single long timer would not survive suspend, resume, or a clock change — and why a run
cannot repeat: the period it belongs to is recorded when it succeeds. Changing the repeat,
the day, or the time starts a new period, so a schedule you have just set can be tested
without waiting for the next one.

A garbled time disables scheduling rather than guessing at one; clearing the field
is how you switch the automatic run off. An installation upgrading from 0.2.6 or
earlier, which had a **Daily run time**, keeps that time on the weekly cadence; the digest
became weekly in 0.2.8, and the **Repeat** setting is how a daily or monthly cadence is
chosen deliberately.
**The one limitation, stated plainly: a timer only runs while Zotero is running.**
Zotero is a desktop application, not a service, so a scheduled time means *at that
time, if Zotero is open that day*. If the day passes with Zotero closed, that week's
automatic run does not happen — open Zotero and use the manual commands, which do
the same work on demand.

### What the scheduled run does, in order

1. Wait for Zotero and Awesome GPT to be ready.
2. Refresh every Zotero feed, one after another.
3. **Wait for Zotero to finish saving** what it just fetched — see below.
4. Score the week's articles that do not already have a current score.
5. Prepare the digest, and email it if the standing approval is on.

**Step 3 exists because a refresh can finish before Zotero has finished saving.**
`updateFeed()` resolves when the feed has been processed, but the items it fetched are
saved through Zotero's own path, and a feed that was already updating when the run
started can resolve immediately while its articles land a moment later. The run waits
two seconds and looks again, and keeps looking — up to three times — **only while
articles are still appearing**. A quiet refresh therefore costs one two-second check.
Without it, an article saved a second after the refresh was not in that run and not in
the digest, and nothing said it had been missed.

Step 5 sends even when step 4 scored nothing new: the digest is a digest of the last
seven days of scores, so a quiet week still gets its email.

### Scheduled delivery

**Send the weekly digest automatically** is the whole approval. A checked setting
is a standing decision, so the scheduled run submits the digest without a dialog;
the run states which server and recipient it covered through a passive notice in
the corner — and, from 0.2.9, the window that closes the run states the delivery
outcome itself (`Email: SENT to …`, or `Email: NOT SENT — <reason>`). Clearing this
box stops it. A checked box alone is never enough:
credentials must be configured, and the digest is still snapshotted and frozen
before exactly one connection is opened.

### Rebuild digest, and Review digest

Two buttons, two functions, deliberately separate.

**Rebuild digest** recreates this week's digest from the scored articles already in
Zotero. It does not re-score anything and does not refresh feeds, so it cannot
change a score or cost a model call. Cached scores that no longer match the current
profile or settings are excluded, exactly as the results window excludes them, so
the email never quotes a score you would not see in Zotero. If nothing has been
scored in the last seven days — or nothing clears the digest's **Minimum relevance
Score** — it says which of those it is and builds nothing. Rebuilding is also what
happens automatically whenever this pane opens, so the box in front of you is
always this week's digest as it stands.

**Review digest** opens that exact frozen message in the preview window, and the
Send button *there* is the confirmation. There is deliberately no separate "send it
now" button in the settings pane: it would be the same decision twice, and the
message you reviewed is the message that goes out. Everything still goes through
every guard unchanged — bounded and validated, frozen into wire bytes, persisted
before the socket opens, and blocked from being sent twice while a submission is in
flight.

### Where the digest comes from, and why it can be empty

The digest is built from the **scored articles of the last seven days**, however
they were scored — a scheduled run, **Refresh and score**, **Score last N days**,
or **Score selected items**. Opening the pane rebuilds it from the cache, so scoring
papers by hand is enough to make a digest appear. Building one writes a local
preference only: it opens no connection and sends nothing.

If the preview is empty, the pane says which of these it is:

- **Nothing has been scored in the last seven days** — score some first.
- **The articles scored in the last seven days no longer match the current profile
  and settings** — a cached score is only reused while its relevance evidence still
  matches what you configured. Score them again to refresh them.
- **None of them reached the digest's Minimum relevance Score** — lower that
  threshold, or wait for papers that match your profile better.

### Submitting a message

**Review digest** opens the preview window, which shows the exact frozen subject,
recipients, and body. Your click there is the confirmation — there is no second
dialog repeating the same text. What protects you is a record, not a prompt: the
frozen message is persisted *before* the connection opens, and the saved
connection identity is re-checked against it, so the message you reviewed is the
message that goes out. If the server, addresses, TLS mode, or secret changed since
the preview, nothing is sent.

### What "Retry unsent digest" is for

Two different failures, two different words, and the difference matters:

- **Retry unsent digest** re-sends a message the server **provably did not accept**
  — a transient `4xx`, or a connection that failed before the message was
  submitted. Nothing was delivered, so re-sending it cannot create a duplicate. The
  button is disabled unless such a message exists, and the retry reuses the frozen
  bytes exactly.
- **An unknown outcome** is the dangerous case: the connection died at or after the
  terminating dot, so FeedRank cannot prove whether the message was delivered. It is
  never retried automatically and **Retry unsent digest** refuses it. The preview
  window offers a separate, explicitly labelled resend for that case, which states
  the duplicate risk. Check the mailbox first: a resend can deliver a second copy,
  and FeedRank cannot remove it.

There is no longer a settings tick box for that resend. It was a second confirmation
of the same decision the labelled button already asks for, and the click is the
confirmation everywhere else in this add-on.

### TLS mode and authentication method

Choose the mode your provider documents. The authentication method is a
preference within its credential family: password methods `AUTH PLAIN` and
`AUTH LOGIN` may negotiate between each other. `AUTH XOAUTH2` uses an OAuth access
token and never falls back to a password method; passwords are never interpreted
as bearer tokens. Unsupported mechanisms are refused before credentials are sent.

Version **0.2.6** corrects a FeedRank AUTH LOGIN protocol bug: earlier builds
attached the username to `AUTH LOGIN` and then sent it again after the next
challenge. Servers that accepted the initial username expected the password
there and could return `535` even with a valid configured credential. LOGIN now
uses the canonical three-step exchange: bare `AUTH LOGIN`, one base64 username,
then one base64 password. Upgrade before interpreting earlier LOGIN failures as
evidence of a bad password. No automatic retry or mechanism switch follows 535.

Version **0.2.7** added **Requests at once** (see
[Requests at once](#requests-at-once)) and re-laid out both settings panes.

Version **0.2.8** made the digest weekly (see
[the weekly run](#the-weekly-run)), removed the manual-resend tick box, added
**Last email**, split the digest into **Rebuild digest** and **Send digest now**,
moved **Send test email** beside
**Test connection**, labelled the **Email connection log**, gave every box one
width and one height, made **Score last N days…** and **Rescore last N days…** ask
for the window, and made FeedRank write its scores into the item's `Extra` field.
The SMTP transport itself is unchanged from 0.2.6.

Version **0.2.9** changed how a run speaks, not how the server is reached. A scheduled
run opens a **window** when its time arrives and a second one when it finishes, stating
what it did and whether the digest email left (`Email: SENT to …`, or
`Email: NOT SENT — <reason>`). A scheduled run no longer opens the
results window; the commands and the menu's on-demand job still do. **Check schedule** now
prints a log that accumulates up to twenty lines — before this version each line replaced
the previous one, so the log could never show more than the last event.

Version **0.2.10** makes a changed schedule actually take effect. A completed run records
the week it served, and the on-demand job counts as one — so setting a later time on a
day that had already run did nothing at all for the rest of the week. Saving a different
**Weekly run day** or **Weekly run time** now clears that record and re-arms the timer: a
time still ahead today runs at its minute, and one already past runs at the next check.
The save button answers with `Next automatic run: <date time>` (or `This week's run is
already done (week of …)`), and **Check schedule**
adds a poll count so a live timer is distinguishable from a week that is already served.
Every FeedRank window (scores, progress, settings, email preview) is now a dependent child
of the Zotero window, so a refresh cannot push it behind the main window.

Version **0.2.11** sends the week's digest from a scheduled run. It is built from the same
selection the digest pane shows — this week's scored articles that clear **Minimum relevance
Score** — rather than from only the articles that run happened to score; a run whose own
articles all fell below that minimum used to end with an email that refused to send because
it had nothing in it. The Tools menu's on-demand command is renamed **Send weekly digest**
(it was *Run weekly job now*) and still does the whole job: refresh, score, rebuild this
week's digest, send. The **Test the pop-up** and **Run weekly job now** buttons and the
**Automatic run** line are gone from both settings panes; **Check schedule** is the one
schedule control left, and it reports the timer, the next run, and the log. **Last email**
now updates itself the moment a send finishes, whichever window sent it.

Also in **0.2.11**: when the journal lookup has no metrics for a paper's venue, the scoring
model is asked for a **journal standing estimate** — a cautious integer from 0 to 100 with a
one-sentence rationale — and that estimate feeds the journal half of Priority under the
weight in [Maximum significance added to total score](#maximum-significance-added-to-total-score). It is used only where no usable
metrics were found, so a retrieved impact factor always wins; the item pane labels it
"Journal standing, estimated by the model" with "Model estimate, not a retrieved metric".
Your journal data itself is still never sent to the model. Articles scored before this
version keep their score and do not gain an estimate — use a Rescore command for those.

Report build **6** shows `authStage` and `authReplies` (step labels and numerical
reply codes only). A corrected run normally shows `LOGIN command → 334`,
`LOGIN username → 334`, `LOGIN secret → 235`. A 535 still does not distinguish
incorrect credentials from a provider's client-login policy. Neither the password
nor its base64 form appears in the trace or authentication transcript.

For one university provider, a credential-free live probe verified
its SMTP host, port **994**, **Implicit TLS**, with TLS 1.3, a validated
a matching certificate, and a Coremail SMTP greeting. STARTTLS is the wrong
mode for this endpoint: it waits for a plaintext greeting while the server waits
for a TLS ClientHello. This failure happens before EHLO or authentication and
does not indicate a bad password. Port 465 timed out from the current network;
this does not prove it is unavailable everywhere.

Use your full address as the configured username and your authorized sender address. AUTH LOGIN can be selected, but acceptance of your credential has not
been verified by development tests. Consult your provider's current client-access policy
for whether your account requires a client authorization code/app password.
Do not paste a credential into a diagnostic report.

Changing the port or TLS mode on screen now affects **Test connection**, including
when using a saved credential for the same host and username. The test does not
save changes. To keep the corrected connection for digest sending, enter the
credential and click **Save credentials**. The stored connection's TLS/auth mode
is shown on reopening settings. A different host/username or password-to-OAuth
switch requires a new credential; FeedRank never forwards a saved secret there.

### The connection log

**Test connection** proves reachability, TLS negotiation, and credential
acceptance without issuing `MAIL FROM`, `RCPT TO`, or `DATA` — no message of any
kind is transmitted. It fills the **Connection log** on a pass as well as a
failure, because a pass is what establishes which TLS members your Zotero build
actually exposes.

The log lists every readable member on each TLS object next to the members
FeedRank reads, so "this build does not report a version" can be told apart from
"this connection is not encrypted". A member whose getter raises is reported as
`THREW <error>` rather than omitted. It also stamps how long each stage took, so a
slow connection can be seen rather than guessed at.

The log reads no secret, opens no socket of its own, and sends nothing. It is a
diagnostics aid; you do not need to read it unless something fails.

### A rejected password

`535 Authentication unsuccessful` means the server rejected authentication; it
does not by itself prove the password is wrong. Follow the provider's documented
method. Use an app password only where the provider officially permits it.

**Outlook.com requires Modern Authentication/OAuth2** according to Microsoft's
[SMTP settings](https://support.microsoft.com/en-us/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040).
Repeated password tests can contribute to an account lockout. This build has
low-level XOAUTH2 token authentication but does **not** yet implement Microsoft
interactive sign-in or token refresh. Selecting XOAUTH2 and entering a password
is not a substitute for an OAuth flow. Microsoft documents the delegated
`https://outlook.office.com/SMTP.Send` scope and device authorization in its
[SMTP OAuth guide](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth).

The connection log carries the server's own response. If SMTP AUTH is disabled
by an organization, contact its administrator; FeedRank does not bypass that
policy. Connection tests never send messages and never automatically retry AUTH.

---

## Where results appear

- **The score window** carries the outcome: every paper with its relevance score,
  Priority, confidence, explanation, and the full component breakdown.
- **The library's Score column** shows Priority, so a library can be sorted by
  what matters.
- **The item pane** shows the same detail for one item, and shows journal
  information retrieved from EasyScholar even for an item that has not been
  scored.
- **A notice in the bottom corner** carries everything else — a refresh summary, a
  cancellation, a failure. It needs no click and closes itself.

There are no confirmation dialogs. Choosing a command is the decision.
