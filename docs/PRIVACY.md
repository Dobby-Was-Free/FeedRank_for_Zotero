# Privacy

FeedRank runs entirely inside Zotero. It has no server, no account, and no telemetry: nothing
is sent anywhere except the four destinations you configure yourself.

### Saved credentials in a settings file

A settings file never contains a password or a key in readable form. The optional credential
section carries only what Zotero's own OS key store already holds -- Gecko's `OSKeyStore`
ciphertext (`oskv1:` plus base64) -- and it is **not included unless you answer yes** to the
question asked at export time.

That ciphertext is not portable, and the limits matter:

- **Another computer**: cannot decrypt it. The key is not in the file; it is derived from platform
  key storage (Keychain, DPAPI, libsecret) for the OS account that wrote the file.
- **Another OS account on the same computer**: cannot decrypt it, for the same reason. Zotero's own
  wrapper lists "profile copied to a different OS user" among the values that cannot be recovered.
- **Anyone who can use that same computer account**: **can** decrypt it, and can equally read the
  credential straight out of Zotero. The file adds no new exposure to someone already inside your
  account, but it does survive a reset: treat it like a password and delete it when it is no longer
  needed.
- **Rotation**: if you reset because you think a credential leaked, change the password at the mail
  provider (and rotate the EasyScholar key) as well. Deleting the file or resetting FeedRank does
  not invalidate a copy someone else already has.

On import, a credential whose ciphertext this machine cannot decrypt is **left empty** and reported;
nothing is written that would fail later.

## What leaves your machine, and only when you ask for it

| Destination | What is sent | When |
| --- | --- | --- |
| Awesome GPT (the model you use there) | The paper metadata in the scoring prompt: title,
abstract, authors, date, DOI/arXiv id, URL, feed name, plus your research profile and the
explanation language. | When you run a scoring command or the scheduled run. |
| EasyScholar | Your key and the publication name being looked up. | Only if you enable the
journal lookup and save a key. |
| Your SMTP server | The digest message. | Only if you enable sending, or press Send. |
| Nothing else | — | — |

**Journal metrics are never sent to the model.** The EasyScholar result stays local, is cached in
Zotero's preferences, and can be mirrored into the item's `Extra` field so it travels with the
paper through Zotero's own sync.

## Where each secret lives

- **SMTP password** and **EasyScholar key**: an OS-encrypted credential in a FeedRank-only Login
  Manager entry (`Zotero.OSKeyStore`, so the OS key store — Keychain on macOS, DPAPI on Windows —
  holds the encryption key). Never written to a preference, never in an `Extra` field, never in the
  journal or score cache.
- **Research profile, schedule, email settings**: ordinary Zotero preferences under
  `extensions.zotero.feedranker.*`. No secret is ever stored there.
- **Scores and cached journal metrics**: Zotero preferences and state shards. They stay on your
  machine and are removed by deleting the add-on's preferences.

## What is deliberately never logged

A key that appears in a log is a key that has leaked, so the credential-bearing request is kept
away from every logging boundary:

- The EasyScholar lookup is performed with `fetch`, **not** `Zotero.HTTP.request`. Zotero's request
  logger builds its display string from the URL it is handed and redacts only a lowercase `key=`
  (`http.js`, `_requestInternal`), and its `options.displayURL` is honoured by `download()` alone —
  so a `secretKey` parameter passed there would be written into debug output whenever debug logging
  is on, regardless of `debug: false`. The lookup therefore never enters that API.
- Every message, error and diagnostic that mentions the request uses a masked URL
  (`secretKey=********`), never the real one.
- A build with no `fetch` fails closed with a message that names no secret, rather than falling
  back to a path that would log it.
- `tests/core.test.js` pins this with a synthetic key: it asserts that the lookup does not go
  through `Zotero.HTTP.request`, that nothing written to `Zotero.debug`/`Zotero.logError` contains
  the key (raw or percent-encoded), and that a thrown error never carries it.

## Settings files

**Save settings to file** never writes a credential in readable form: the SMTP password and the
EasyScholar key are excluded by construction (`chrome/content/settings-file.js` fails the export
rather than drop a field it does not recognise), and an import ignores any credential-looking key.
That is not the same as the file being safe to publish. It contains, in plain text:

- your **research profile**, which reveals your interests and possibly unpublished plans;
- the **SMTP host**, which can identify your institution or provider;
- the **SMTP username**, sender and recipient addresses, which identify the accounts involved;
- optionally, your saved credentials as **encrypted copies** — still credential material, since the
  same OS account on the same machine can decrypt them.

Treat a settings file as private: keep it out of repositories, issues and shared folders, and
delete it when the restore it was made for is done. `.gitignore` excludes `feedrank-settings*.json`
for exactly this reason. The encrypted credential copies exist so a reset can be undone on the same
machine; on another machine, re-enter the password and the key.

## Publication hygiene

- No personal data ships in the package: the default research profile is a neutral instruction,
  and a test walks every shipped file for an email address, an absolute user path, a local Zotero
  profile directory, or personal-research wording.
- Icon metadata is stripped (`logo_small.png` carried XMP editing history); pixels are verified
  byte-identical after stripping.
- `private/` holds development history and is excluded by `.gitignore`.
