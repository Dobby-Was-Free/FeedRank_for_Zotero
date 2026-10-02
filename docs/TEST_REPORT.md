# Test report — FeedRank for Zotero 0.3.0

Every test in this repository runs **offline**. There is no network access, no SMTP
connection, no Zotero instance and no model call: the HTTP, transport, credential-store and
Zotero environments are fakes built for the purpose, and the assertions are made against the
bytes and strings that would have crossed each boundary.

## Running the suites

```
npm test     # all seven suites
npm run build  # writes dist/FeedRank-<version>.xpi, named from manifest.json
```

## What each suite covers

| Suite | Tests | Covers |
| --- | --- | --- |
| `tests/core.test.js` | Core scoring, journal lookup, state, shipped privacy contracts | 145 |
| `tests/email.test.js` | Digest rendering, SMTP/TLS behaviour | 52 |
| `tests/email-service.test.js` | Credential storage, submissions, retries, delivery state | 35 |
| `tests/settings-file.test.js` | Settings export, import, credentials section, reset scope | 9 |
| `tests/strings.test.js` | Localisation, pane contracts, packaging hygiene | 12 |
| `tests/notify.test.js` | Notices and their failure modes | 5 |
| `tests/main.test.js` | Schedule, runs, settings file, credentials, dialogs | 29 |
state sharding, Priority calculation, the schedule (daily/weekly/monthly anchors, due windows,
catch-up), the settings panes, item-pane and results rendering, Extra-field mirroring, and the
privacy and logging-boundary checks. |
| `tests/email.test.js` | 52 | Digest selection and rendering, author/institution lines, HTML
escaping of hostile paper metadata, MIME construction, dot-stuffing, and the SMTP command and
TLS gates. |
| `tests/email-service.test.js` | 33 | The delivery state machine: prepare, persist before connect,
submit, retry, unknown outcomes, duplicate prevention, credential handling, and the arguments
handed to the transport. |
| `tests/strings.test.js` | 8 | English/Chinese parity, locale detection, settings-pane coverage,
package privacy, and the artifact-naming rule. |
| `tests/notify.test.js` | 5 | The passive notice channel, including that a panel which refuses to
open is reported rather than assumed. |
| `tests/main.test.js` | 19 | The service's own surface: schedule reporting, run outcomes and
their wording, the digest outcome line, and that a scheduled run opens no window. |

## What these tests do not establish

- They do not run inside Zotero. Live Zotero 10 behaviour — menu registration, item-pane
  sections, progress windows, the OS key store — is verified by using the add-on, not here.
- They do not contact EasyScholar, an SMTP server, or a model provider. Live credentials,
  deliverability and provider policies are outside their reach.
- They are not a security audit. They pin the behaviours that have been reasoned about,
  including the guarantee that the EasyScholar key never reaches a logging boundary, but a
  passing suite is not a substitute for review.

## Privacy

See [PRIVACY.md](PRIVACY.md): what leaves the machine, where each secret is stored, and what is
deliberately never logged.
