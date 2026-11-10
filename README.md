<p align="center">
  <img src="https://raw.githubusercontent.com/Dobby-Was-Free/FeedRank_for_Zotero/main/assets/logo.svg" alt="FeedRank logo" width="120" />
</p>

<h1 align="center">FeedRank for Zotero</h1>

<p align="center"><strong>Your research feeds, ranked by relevance.</strong></p>

<p align="center">
  <a href="https://github.com/Dobby-Was-Free/FeedRank_for_Zotero/releases/latest">Download</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="https://github.com/Dobby-Was-Free/FeedRank_for_Zotero/blob/main/docs/SETTINGS.md">Settings guide</a> ·
  <a href="#privacy-and-data">Privacy</a> ·
  <a href="https://github.com/Dobby-Was-Free/FeedRank_for_Zotero/issues">Report an issue</a>
</p>

FeedRank helps you decide what to read next—without leaving Zotero. It scores papers from your existing journal and arXiv feeds against a research profile you write, using the model configured in **Awesome GPT**. Read the scores and explanations in Zotero, or receive a selected digest through your own email account.

**No separate FeedRank account, server, or RSS reader.** Awesome GPT and its configured model are needed for AI scoring; email delivery and journal-metric lookup are optional.

```text
Your Zotero feeds → Refresh → AI relevance scoring → Read in Zotero
                                                        ↓
                                              Optional email digest
```

## What you get

| Feature | How it helps |
| --- | --- |
| **Personal relevance scores** | A 0–100 score and a short explanation based on your research interests. |
| **Results inside Zotero** | A sortable Score column, per-item details, and a combined list of scored articles. |
| **Flexible scoring** | Process recent feed articles, one feed, or selected library items. Reuse cached scores or explicitly rescore. |
| **Optional journal context** | Retrieve journal metrics through EasyScholar and adjust their contribution to reading priority. |
| **Direct email delivery** | Preview a digest and send it through your own SMTP server—no additional email delivery service. |
| **An optional schedule** | Choose a daily, weekly, or monthly run while Zotero is open. Leave the run time blank for manual use only. |

## Install

You need **Zotero 10**, a working **[Awesome GPT](https://github.com/MuiseDestiny/zotero-gpt)** installation with a configured model, and at least one Zotero feed for the feed workflow.

1. Download the `.xpi` file from the **[latest release](https://github.com/Dobby-Was-Free/FeedRank_for_Zotero/releases/latest)**, rather than GitHub's source-code ZIP.
2. In Zotero, open **Tools → Plugins**, select the gear menu, and choose **Install Plugin From File…**
3. Select the `.xpi` and restart Zotero.

The published release notes report testing on **Windows with Zotero 10**. macOS also passed basic function tests, and Linux has not yet been verified. Model integration can also depend on the installed Awesome GPT version.

The 0.3.2 regression checks were run offline; they do not establish live platform compatibility for the new RSS changes.

For download verification, compare the file's SHA-256 with the digest shown for that exact release asset. Checksums belong to individual builds, not just version names.

## Quick start

### 1. Describe what matters to you

Open **Zotero Settings → FeedRank for Zotero** and edit the research-interest profile. Include your topics, methods, practical goals, and work you would rather deprioritize.

For example, replace the bracketed text in this template:

```text
My research focuses on [topics and applications].
Prioritize papers with [methods, experiments, or contributions of interest].
I am particularly interested in [current research questions].
Deprioritize [less relevant topics].
```

This profile is included in scoring requests. Do not enter confidential project details unless you are permitted to send them to your configured model provider.

### 2. Score a small set first

Choose **Tools → FeedRank for Zotero → Refresh and score**. Alternatively, use **Score last N days…** to work with articles Zotero has already collected.

Set a modest paper limit for the first run. The limit controls how many candidates are scored, so a large backlog may need more than one run. Model calls can incur provider charges.

### 3. Read the results

Sort the **Score** column, select an article to read its explanation, or open **Show scored articles** for the combined results. Use the explicit **Rescore** commands to replace earlier scores.

### Score is not the same as Priority

**Score** is the model's estimate of relevance to your profile. **Priority** adds a bounded significance bonus and is capped at 100. Depending on the article and available information, that bonus can use journal metrics or model-estimated significance; model estimates are not measured bibliometric facts.

Set the significance weight to **0** to prioritize relevance alone. Neither number establishes scientific quality, correctness, or a paper's actual importance. Use the explanation and original article to make the reading decision.

## Commands

Under **Tools → FeedRank for Zotero**:

- **Refresh and score** — refresh feeds and score eligible new or unscored articles in one cancellable run.
- **Score last N days…** — fill missing scores in a publication-date window without refreshing RSS.
- **Rescore last N days…** — replace the stored scores in that window.
- **Show scored articles** — open the combined results list.
- **Refresh & email…** — refresh feeds, fill missing scores for the daily/weekly/monthly period, then open the exact digest preview. Click Send after reviewing; no automatic-send opt-in is needed.
- **Update journal info** — look up journal metrics for the current scope with an EasyScholar key.
- **Settings…** — open the FeedRank settings pane.

Right-click library items for **Score selected items** or **Rescore selected items**.
Right-click a feed for **Score N days…** or **Rescore N days…** in that feed's scope.

## Optional email digest

Configure your provider's SMTP hostname, port, security mode, username, authorized sender, recipient, and supported credential in **Email delivery**. Use the connection settings required by your provider; some accounts require an app password or an OAuth token rather than the normal webmail password.

**Test connection** checks the connection and authentication without sending a message. **Send test email** opens a test-message preview. For a real digest, use **Rebuild digest** to prepare content from existing scores, then **Review digest** to inspect it before sending. Set the maximum paper count and minimum relevance score to keep it useful.

**Manual sending and automatic sending are different permissions.** Manual delivery requires a Send action. Enabling automatic delivery gives scheduled runs standing permission to send without another confirmation. Automatic sending is off by default.

The schedule supports **Daily, Weekly, and Monthly** repeats. Set a local run time and the applicable day, or leave the time blank to disable automatic runs. Zotero must be running; FeedRank is not an independent background service. Some command labels still say “weekly” even when a different repeat is selected. The [settings guide](https://github.com/Dobby-Was-Free/FeedRank_for_Zotero/blob/main/docs/SETTINGS.md) explains the period and missed-run behavior.

## Optional journal metrics

Enable **EasyScholar journal lookup**, save your own key, and run **Update journal info**. Journal data are cached and can contribute to Priority. Scoring remains available without EasyScholar.

Journal information can also be written to an item's **Extra** field. Unlike the local scoring cache, that metadata may travel with a saved library item through Zotero's normal synchronization or export. Disable lookup and set the significance weight to 0 for a relevance-only workflow.

## Privacy and data

FeedRank runs inside Zotero, but **local execution does not mean offline processing**.

| Connection | Information involved |
| --- | --- |
| **Feed publishers, through Zotero** | Requests to the subscriptions you refresh. |
| **The model configured in Awesome GPT** | Your research profile and the paper metadata included in the scoring prompt, such as titles, abstracts, and authors. |
| **EasyScholar, when enabled** | Your lookup key and the publication name. |
| **Your SMTP provider** | Authentication, sender and recipient information, and the email content. A connection test can authenticate without transmitting a message. |
| **GitHub / GitHub Pages** | Extension-update checks and package downloads through the configured update mechanism. |

The plugin does not require a FeedRank backend account. Scores and caches are stored locally. SMTP and EasyScholar credentials use isolated OS-encrypted storage where available; pay attention to any session-only storage warning. Your model provider's own data-handling terms still apply.

> **Keep settings exports and diagnostics private.** An exported settings file can contain your research profile and email identities in plaintext, plus optional encrypted credential copies. Connection reports can contain usernames, server details, and local paths. Never assume a “sanitized” label makes a report anonymous: review and redact it before sharing. Do not attach raw logs, settings files, Zotero profiles, or credentials to a public issue.

See the [privacy documentation](https://github.com/Dobby-Was-Free/FeedRank_for_Zotero/blob/main/docs/PRIVACY.md) for storage and export details.

## Troubleshooting

Version 0.3.2 bounds RSS update waits to 90 seconds, local data waits to 15 seconds,
and the RSS refresh phase to five minutes. Progress names the feed and stage,
shows elapsed time and feeds remaining, and offers **Skip current feed** beside
Cancel. Slow feeds are reported rather than holding the entire job indefinitely.
This stops FeedRank waiting; Zotero can still finish its native RSS work later.
FeedRank avoids starting a duplicate update while its earlier call is pending.
Skipped feeds are excluded from fallback/settle scans for that run.

Settings use Zotero's native dropdown controls. Unsaved choices and consent
checkboxes are protected from background status refreshes, including while a
menu is open. Saving digest options does not replace unsaved SMTP connection
choices; use **Save credentials** to persist the connection identity.

Progress closes on completion or failure; manually requested results and email
previews stay open for review. Large-state operations yield between chunks to
reduce main-thread blocking. Some earlier builds cannot read current saved-state
pointers, so avoid downgrading an active profile.

| Problem | Start here |
| --- | --- |
| **No new scores** | Check the profile, model configuration, candidate limit, and date window. Try a small selection and read the progress message. |
| **RSS refresh waits too long** | Check the named feed/stage timer, use Skip current feed, and review Check schedule. Zotero's underlying work may continue in the background. |
| **The model is unavailable** | Check that Awesome GPT works independently and note both plugin versions when reporting the problem. |
| **Journal metrics missing** | Save an EasyScholar key, enable lookup, and run Update journal info for the relevant scope. |
| **Email does not send** | Use Test connection and check the provider's SMTP, authentication, and account-policy requirements. Server acceptance does not guarantee inbox delivery. |
| **A scheduled run did not happen** | Confirm Zotero was open, the local run time is set, and the selected repeat/day is correct. |
| **Scores no longer fit your interests** | Update the profile and rescore the relevant articles. |

For a bug report, include your operating system, Zotero and plugin versions, reproduction steps, and a short **manually reviewed** error excerpt. Do not include your full research profile or account details. Until the diagnostics-sharing path has been fixed and tested, do not rely on **Copy sanitized log** to remove private information.

## Development

From a source checkout, use Node.js for the offline tests and PowerShell for the packaged build:

```powershell
npm test                            # 372 offline tests: no network, no Zotero
npm run benchmark                   # synthetic 2,000-paper cache; no live profile
powershell -File tools\build.ps1    # -> dist\FeedRank-<version>.xpi
```

The build writes `dist/FeedRank-0.3.2.xpi`, reads the version from `manifest.json`, packages a fixed file list (the manifest, the
bootstrap, `chrome/`, `locale/`) and verifies that every packaged file is byte-identical to its source.
`tools/state-snapshot.js` records and compares the local score cache, which is how a silent change
there gets noticed.
Runtime installation does not require Node.js or a separate application. These
checks use mock providers and Zotero environments; live performance and provider
behavior still need separate verification.

Keep source, tests, tools, and public documentation in Git. Keep generated packages in Releases and private settings, snapshots, profiles, raw logs, and detailed local test reports out of the repository.

### Publishing a release

Keep the approved version (currently 0.3.2) for ongoing local revisions. Do not
bump it for each requested fix; change it only when the user requests or approves
a new release version.

Publish project source, tests, user documentation and the release XPI only.
Detailed local test reports, settings backups, library exports and connector
data stay private. Review the staged file list before committing; do not upload
the entire workspace folder.

1. Set the version in `manifest.json` (and `package.json`).
2. `powershell -File tools\build.ps1` — it packages and then re-opens the archive to compare every
   file with its source.
3. Publish the XPI as a GitHub Release asset, tagged `v<version>`.
4. Update `updates.json`: Zotero reads that file from
   `applications.zotero.update_url` and offers the new version to installed copies. The
   `update_link` names the Release asset, so it can be written before the release itself exists.

The update manifest is served by GitHub Pages from **main / root**. Without that
publication, changing the local file does not make the release available to
installed copies.

## License and acknowledgements

[MIT License](https://github.com/Dobby-Was-Free/FeedRank_for_Zotero/blob/main/LICENSE). Built on Zotero's feed workflow, with Awesome GPT integration and optional EasyScholar lookup. FeedRank is an independent community plugin, not an official Zotero product.
