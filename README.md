# FeedRank for Zotero

**Rank the papers in your Zotero feeds by how relevant they are to your own research — then, if you
want, mail yourself the best of them once a week.**

FeedRank reads the RSS/Atom feeds you already have in Zotero, asks the model provider you configured
in Zotero (Awesome GPT) to score each new paper against a research profile you write, and puts the
result where you already work: a sortable **Score** column, a details section in the item pane, and a
weekly digest you review before it is sent.

Nothing runs in the background by surprise: scoring happens when you ask for it, or at the one weekly
moment you set. A **manually** started digest is sent only after you press Send. Turning on
**automatic sending** gives the scheduled digest standing permission, so those runs do not ask again
— that is what the setting is for, and it is off by default.

---

## What it does

| | |
|---|---|
| **Relevance scoring** | Every new item in your feeds gets a 0–100 score with a one-sentence reason, judged against your research profile. |
| **Score column** | Sort your feed items by relevance like any other column; the number is local, not synced. |
| **Item pane details** | The score, the reason, the journal metrics behind it, and where they came from — per item. |
| **Journal metrics (optional)** | Impact factor and related signals from **EasyScholar**, with your own key. Cached locally and mirrored into the item's `Extra` field so they survive without FeedRank. |
| **Local priority signals** | A bibliometric weight and an arXiv significance reading, folded into one Priority number you control. |
| **Weekly digest (optional)** | The week's best papers, reviewed by you before sending, delivered through your own SMTP account. |
| **No account, no server** | There is no FeedRank service. Your profile, keys and scores stay in your own Zotero profile. |

## Requirements

- **Zotero 10** — the add-on is built against Zotero 10's APIs.
- At least one **feed** in your Zotero library.
- A **model provider** configured in Zotero (the Awesome GPT bridge) for scoring.
- Optional: an **EasyScholar** key for journal metrics, and an **SMTP account** for the digest.

## Install

1. Download `FeedRank-<version>.xpi` from [Releases](../../releases).
2. In Zotero: **Tools → Plugins ⚙ → Install Plugin From File…** and pick the file.
3. Restart Zotero.

Verify the download (optional, PowerShell):

```powershell
Get-FileHash .\FeedRank-0.3.0.xpi -Algorithm SHA256
# 875860ECBC5F622179F8E041B3721B721C4C65DE9EF8839A8AF62A230293DD7A
# 244,685 bytes
```

## First run

1. **Write your research profile.** Zotero → Settings → **FeedRank for Zotero** → *Research profile*.
   Plain prose works best: the topics, methods and trade-offs you care about, and what should be
   deprioritised. This text is the question every paper is judged against, so it is worth five minutes.
2. **Score something.** Tools → **FeedRank for Zotero → Score last N days…** (or *Refresh and score*
   for the usual window). A progress window shows what is happening and can be cancelled.
3. **Read the results.** The **Score** column sorts your feed items; the item pane shows the reason
   behind each number.

Optional extras:

- **Journal metrics** — Settings → FeedRank for Zotero → *EasyScholar*: save your key, then
  *Update journal info*.
- **Weekly digest** — Settings → FeedRank for Zotero → *Email delivery*: save your SMTP credentials,
  use **Test connection** (it sends nothing), then **Send test email** or **Review digest**.

## Commands

All under **Tools → FeedRank for Zotero**:

- **Refresh and score** — refresh your feeds and score everything new, in one cancellable run.
- **Score last N days…** — score the last N days without a refresh; fills the gaps and keeps the scores you have.
- **Rescore last N days…** — the same window, but replaces the stored scores: use it after changing your profile.
- **Show scored articles** — open the in-Zotero list of scored results.
- **Send weekly digest** — build this week's digest and send it, after your confirmation.
- **Update journal info** — look up journal metrics for the current scope (needs an EasyScholar key).
- **Settings…** — open the FeedRank for Zotero pane.

The same work is available where the papers are:

- **Score selected items** — right-click a selection in your library and score exactly those.
- **Rescore selected items** — the same selection, replacing the stored scores.
- **Score N days…** / **Rescore N days…** — right-click a feed in the left panel to score that feed's last N days.

## Privacy in one paragraph

FeedRank has no backend of its own: no FeedRank server, no account, no telemetry. The providers
**you** configure receive what their job needs — your research profile and the papers' metadata go
to the model provider, the publication name and your key go to EasyScholar when you enable that
lookup, and the digest goes to your own SMTP server. Nothing else leaves your machine. Your SMTP
password and EasyScholar key are stored only as OS-encrypted ciphertext in Zotero's own credential
store — never in a preference, and never in readable form in a settings file. Full detail, including
what a settings file may contain and how to remove it: [`docs/PRIVACY.md`](docs/PRIVACY.md).

## Settings, backup and reset

Every option is documented, with its default and its effect, in
[`docs/SETTINGS.md`](docs/SETTINGS.md). The same pane can **save your settings to a file**, **load them
back**, or **reset everything**. A reset returns settings to their defaults while keeping your cached
scores.

> **A settings file is private.** It contains your research profile and your mail identities — SMTP
> host, username, sender and recipient — in plain text, and it optionally carries your saved
> credentials as encrypted copies. Do not commit it, attach it to an issue, or put it in a shared
> folder. The credential copies decrypt only for the OS account that wrote them, but they are still
> credential material. The export says all of this before it writes anything, and keeps
> `feedrank-settings*.json` out of this repository by default.

## Troubleshooting

| Symptom | What to check |
|---|---|
| No scores appear | Is the research profile filled in, and is a model provider configured in Zotero? Run *Score last N days…* and watch the progress window. |
| Journal metrics missing | *Update journal info* says so when no EasyScholar key is saved. Add the key, then run it again. |
| Digest not sent | **Test connection** writes a full SMTP/TLS report — open **Connection log** in the email settings. Use **Copy sanitized log** for anything you share: it does not copy the report at all, it builds a small one from an allowlist (build, TLS mode, protocol stage, cipher names, numeric codes, timings), so identities, addresses, server text and paths are absent by construction. A **raw log is private** — it names your mail server and account — so review and redact it before sharing, and never upload credentials, settings exports or raw logs to a public issue. |
| Scores look stale | A score belongs to the profile that produced it. Change the profile and the affected scores become re-computable; *Rescore latest articles* replaces them. |

## Development

```powershell
npm test                            # 287 offline tests: no network, no Zotero
powershell -File tools\build.ps1    # -> dist\FeedRank-<version>.xpi
```

The build writes `dist/FeedRank-0.3.0.xpi`, reads the version from `manifest.json`, packages a fixed file list (the manifest, the
bootstrap, `chrome/`, `locale/`) and verifies that every packaged file is byte-identical to its source.
`tools/state-snapshot.js` records and compares the local score cache, which is how a silent change
there gets noticed.

### Publishing a release

1. Set the version in `manifest.json` (and `package.json`).
2. `powershell -File tools\build.ps1` — it packages and then re-opens the archive to compare every
   file with its source.
3. Publish the XPI as a GitHub Release asset, tagged `v<version>`.
4. Add the release to `updates.json`: Zotero reads that file from
   `applications.zotero.update_url` and offers the new version to installed copies. The
   `update_link` names the Release asset, so it can be written before the release itself exists.

The update manifest is served by GitHub Pages from this repository (Settings → Pages → Deploy
from a branch → `main` / root). Without Pages, `updates.json` is only a file in the repository
and no installed copy will ever see it.

## License

MIT — see [`LICENSE`](LICENSE).

---

## 中文简介

**FeedRank for Zotero** 把你 Zotero 订阅源里的新论文，按"与你研究的相关性"打分排序，并可选地每周把最相关的论文摘要邮件发给你。

- **评分**：用你自己写的研究简介（Research profile）当作提问，让 Zotero 中已配置的模型给每篇新论文打 0–100 分并给出一句理由。
- **看结果**：条目列表里的 **Score** 列可直接排序；条目详情面板显示分数、理由以及期刊指标来源。
- **期刊指标（可选）**：用你自己的 EasyScholar 密钥获取影响因子等信号，本地缓存，并镜像进条目的 `Extra` 字段。
- **每周摘要（可选）**：用你自己的 SMTP 账号发送，发送前可先审阅；不会自动发出未经你确认的邮件。
- **隐私**：没有 FeedRank 服务器。SMTP 密码与 EasyScholar 密钥只以**系统加密的密文**存放在 Zotero 凭据库中，绝不明文写入偏好设置或导出的设置文件。

**安装**：从 [Releases](../../releases) 下载 `FeedRank-<version>.xpi` → Zotero 中 **工具 → 插件 → ⚙ → Install Plugin From File…** → 重启 Zotero。

**上手**：设置 → FeedRank for Zotero → 填写研究简介 → 工具 → FeedRank for Zotero → **Score last N days…**

每项设置的含义与默认值见 [`docs/SETTINGS.md`](docs/SETTINGS.md)，数据流向与凭据处理见 [`docs/PRIVACY.md`](docs/PRIVACY.md)。
