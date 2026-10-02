/* Zotero 10 bootstrap entry for FeedRank for Zotero. */

var chromeHandle;
var feedRankerContext;
var feedRankerService;
var feedRankerEmailService;
var feedRankerJournalService;

function install() {}

async function startup({ rootURI }) {
  if (rootURI.startsWith("jar:")) {
    const xpiFile = Services.io
      .newURI(rootURI)
      .QueryInterface(Components.interfaces.nsIJARURI)
      .JARFile.QueryInterface(Components.interfaces.nsIFileURL).file;
    Services.obs.notifyObservers(xpiFile, "flush-cache-entry");
  }

  const aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  chromeHandle = aomStartup.registerChrome(
    Services.io.newURI(rootURI + "manifest.json"),
    [["content", "feedranker", rootURI + "chrome/content/"]],
  );

  // The live build, readable from anywhere: a bootstrap add-on has no other way to know its own
  // version, and an empty version made "which build is running?" unanswerable.
  try {
    const manifest = JSON.parse(
      await Zotero.File.getContentsFromURLAsync(rootURI + "manifest.json"),
    );
    Zotero.FeedRankerVersion = String(manifest.version || "");
  }
  catch (error) {
    Zotero.logError(error);
  }

  feedRankerContext = { rootURI, Services, Components, Zotero };
  feedRankerContext.globalThis = feedRankerContext;
  Services.scriptloader.loadSubScriptWithOptions(
    rootURI + "chrome/content/core.js",
    { target: feedRankerContext, ignoreCache: true },
  );
  Services.scriptloader.loadSubScriptWithOptions(
    rootURI + "chrome/content/email.js",
    { target: feedRankerContext, ignoreCache: true },
  );
  // Read-only runtime inventory for the SMTP/TLS path. Loaded before the SMTP
  // modules so a diagnostic can be produced even when they fail to load.
  Services.scriptloader.loadSubScriptWithOptions(
    rootURI + "chrome/content/diagnostics.js",
    { target: feedRankerContext, ignoreCache: true },
  );
  // The SMTP socket transport must be loaded before the service that injects
  // it. It is the only module that opens a socket, and it accepts only Gecko's
  // TLS providers.
  Services.scriptloader.loadSubScriptWithOptions(
    rootURI + "chrome/content/email-smtp.js",
    { target: feedRankerContext, ignoreCache: true },
  );
  Services.scriptloader.loadSubScriptWithOptions(
    rootURI + "chrome/content/email-service.js",
    { target: feedRankerContext, ignoreCache: true },
  );
  // EasyScholar journal lookup: a pure API layer plus the service that owns the
  // user's secret key and caches results. Loaded before main.js, which wires it.
  Services.scriptloader.loadSubScriptWithOptions(
    rootURI + "chrome/content/journal.js",
    { target: feedRankerContext, ignoreCache: true },
  );
  Services.scriptloader.loadSubScriptWithOptions(
    rootURI + "chrome/content/journal-service.js",
    { target: feedRankerContext, ignoreCache: true },
  );
  // Passive notifications. Loaded early because main.js reports every outcome
  // through it, and it must exist before main is constructed.
  Services.scriptloader.loadSubScriptWithOptions(
    rootURI + "chrome/content/notify.js",
    { target: feedRankerContext, ignoreCache: true },
  );
  // User-facing text, per language, chosen from Zotero's own UI locale. Loaded before
  // main.js, which asks for every menu label, notice and report line through it.
  Services.scriptloader.loadSubScriptWithOptions(
    rootURI + "chrome/content/strings.js",
    { target: feedRankerContext, ignoreCache: true },
  );
  // Settings as a file: export, import, reset. Loaded with the text module because the export
  // format and the reset scope are user-facing decisions, not plumbing.
  Services.scriptloader.loadSubScriptWithOptions(
    rootURI + "chrome/content/settings-file.js",
    { target: feedRankerContext, ignoreCache: true },
  );
  Services.scriptloader.loadSubScriptWithOptions(
    rootURI + "chrome/content/main.js",
    { target: feedRankerContext, ignoreCache: true },
  );

  feedRankerService = feedRankerContext.FeedRankerMain.create({
    Zotero,
    Services,
    rootURI,
    Core: feedRankerContext.FeedRankerCore,
    Strings: feedRankerContext.FeedRankStrings || null,
    SettingsFile: feedRankerContext.FeedRankSettingsFile || null,
    Components,
    Notify: feedRankerContext.FeedRankNotify
      ? feedRankerContext.FeedRankNotify.create({ Zotero })
      : null,
  });
  Zotero.FeedRanker = feedRankerService;
  // FeedRankEmail is deliberately separate from both Zotero sync credentials
  // and Awesome GPT. Its only persistent secret is a namespaced Login Manager
  // entry encrypted through Zotero.OSKeyStore.
  feedRankerEmailService = feedRankerContext.FeedRankerEmailService.create({
    Zotero,
    Services,
    Components,
    Email: feedRankerContext.FeedRankerEmail,
    SMTP: feedRankerContext.FeedRankerSMTP,
    // Read-only TLS member inventory, attached to a connection-test result so a
    // refusal can be explained from the settings window without a rebuild.
    Diagnostics: feedRankerContext.FeedRankDiagnostics,
    State: {
      load: () => feedRankerService.loadState(),
      mutate: (mutator) => feedRankerService.mutateState(mutator),
    },
  });
  Zotero.FeedRankEmail = feedRankerEmailService;
  Zotero.FeedRankDiagnostics = feedRankerContext.FeedRankDiagnostics;
  // FeedRankJournal owns the EasyScholar secret key, which is stored the same
  // way as the SMTP secret: session memory, plus an OSKeyStore ciphertext in a
  // FeedRank-only Login Manager record. It never touches Zotero item fields.
  feedRankerJournalService = feedRankerContext.FeedRankerJournalService.create({
    Zotero,
    Services,
    Components,
    Journal: feedRankerContext.FeedRankerJournal,
    State: {
      load: () => feedRankerService.loadState(),
      mutate: (mutator) => feedRankerService.mutateState(mutator),
    },
  });
  Zotero.FeedRankJournal = feedRankerJournalService;
  try {
    await feedRankerEmailService.startup();
  } catch (error) {
    // Delivery recovery must never prevent scoring from starting. The service
    // remains fail-closed because its mutation path will reject until state is
    // usable; do not log request payloads or credentials here.
    Zotero.logError(error);
  }
  await feedRankerService.startup();
}

async function onMainWindowLoad({ window }) {
  await feedRankerService?.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }) {
  await feedRankerService?.onMainWindowUnload(window);
}

async function shutdown() {
  try {
    await feedRankerService?.shutdown();
  } finally {
    try {
      await feedRankerEmailService?.shutdown();
    } finally {
      try {
        await feedRankerJournalService?.shutdown();
      } finally {
        if (Zotero.FeedRankJournal === feedRankerJournalService) {
          delete Zotero.FeedRankJournal;
        }
        feedRankerJournalService = null;
      }
      if (Zotero.FeedRankEmail === feedRankerEmailService) {
        delete Zotero.FeedRankEmail;
      }
      feedRankerEmailService = null;
    }
    if (Zotero.FeedRanker === feedRankerService) {
      delete Zotero.FeedRanker;
    }
    feedRankerService = null;
    feedRankerContext = null;
    if (chromeHandle) {
      chromeHandle.destruct();
      chromeHandle = null;
    }
  }
}

function uninstall() {}
