"use strict";

window.addEventListener("load", () => {
  const args = window.arguments?.[0] || {};
  const config = args.config || {};
  const field = (id) => document.getElementById(id);
  /*
   * One function fills the form, because importing a settings file or resetting changes the stored
   * settings while this window is open. The old code filled the form once from a snapshot and then
   * called populate(), which this file never defined: both handlers threw a ReferenceError instead
   * of repopulating, so an import looked like it had done nothing at all.
   */
  const showDayControl = () => {
    const frequency = field("run-frequency").value;
    field("weekly-day").style.display = frequency === "weekly" ? "" : "none";
    field("monthly-day").style.display = frequency === "monthly" ? "" : "none";
  };
  showDayControl();
  field("run-frequency").addEventListener("change", showDayControl);
  const populateForm = (next = {}) => {
    const config = next || {};
    field("profile").value = config.profile || "";
    field("language").value = config.explanationLanguage || "zh-CN";
    field("lookback").value = config.lookbackDays ?? 14;
    field("limit").value = config.candidateLimit ?? 20;
    field("batch").value = config.batchSize ?? 5;
    field("concurrency").value = config.batchConcurrency ?? 1;
    field("retries").value = config.maxRetries ?? 1;
    field("timeout").value = config.requestTimeoutMs ?? 120000;
    field("run-frequency").value = config.runFrequency || "weekly";
    field("weekly-day").value = String(config.weeklyRunDay ?? 1);
    field("monthly-day").value = String(config.monthlyRunDay ?? 1);
    field("weekly-time").value = config.weeklyRunTime || "";
    field("input-price").value = config.inputPricePerMillion ?? "";
    field("output-price").value = config.outputPricePerMillion ?? "";
    field("currency").value = config.currency || "USD";
    field("bibliometric-weight").value = config.bibliometricWeightPoints ?? 0;
    field("arxiv-significance-signals").value = config.arxivSignificanceSignals || "";
    showDayControl();
  };
  populateForm(args.config || {});

  const emailService = window.opener?.Zotero?.FeedRankEmail || window.Zotero?.FeedRankEmail;
  const mainService = window.opener?.Zotero?.FeedRanker || window.Zotero?.FeedRanker;
  // The live build, in the group the settings-file buttons report in. Read after the service is
  // resolved: touching it earlier is a temporal-dead-zone error that would kill this whole listener.
  const settingsFileStatus0 = document.getElementById("settings-file-status");
  if (settingsFileStatus0) settingsFileStatus0.textContent = mainService?.versionLabel?.() || "";
  const emailStatus = (message) => { field("email-status").textContent = String(message || ""); };
  const readEmailConfig = () => ({
    maximumPapers: field("email-max-papers").value,
    minimumRelevanceScore: field("email-min-score").value,
    priorityCount: field("email-priority-count").value,
    readingListCount: field("email-reading-count").value,
    readingListEnabled: field("email-reading-enabled").checked === true,
    automaticSendingEnabled: field("email-auto-enabled").checked === true,
    tlsMode: field("email-tls-mode").value,
    authMethod: field("email-auth-method").value,
  });
  const readEmailConnection = () => ({
    host: field("email-host").value,
    port: field("email-port").value,
    tlsMode: field("email-tls-mode").value,
    authMethod: field("email-auth-method").value,
    username: field("email-username").value,
    from: field("email-from").value,
    to: field("email-to").value,
  });
  const writeEmailConfig = (email = {}) => {
    field("email-max-papers").value = email.maximumPapers ?? 10;
    field("email-min-score").value = email.minimumRelevanceScore ?? 70;
    field("email-priority-count").value = email.priorityCount ?? 5;
    field("email-reading-count").value = email.readingListCount ?? 30;
    field("email-reading-enabled").checked = email.readingListEnabled === true;
    field("email-auto-enabled").checked = email.automaticSendingEnabled === true;
    field("email-tls-mode").value = email.tlsMode || "starttls";
    field("email-auth-method").value = email.authMethod || "plain";
  };
  // "Last email" is the one line the pane can answer with certainty, straight
  // from the retained submission record: when a message was last accepted (or
  // last failed), and where it went.
  const formatLastDelivery = (last) => {
    if (!last) return "Nothing has been sent yet.";
    const when = new Date(last.acceptedAt || last.failedAt || last.createdAt);
    const stamp = Number.isNaN(when.getTime()) ? "at an unrecorded time" : when.toLocaleString();
    const outcome = last.accepted
      ? "sent"
      : last.status === "unknown"
        ? "delivery unknown"
        : last.status === "submitting"
          ? "submission interrupted"
          : "not accepted";
    const where = [last.to, last.host].filter(Boolean).join(" via ");
    // Never report an accepted message as anything else: name the missing record
    // instead, because the alternative told users their delivered email had failed.
    const note = last.accepted && last.recordSaved === false
      ? " (this session only: the delivery record could not be written)"
      : "";
    return "Last email: " + stamp + " — " + outcome + (where ? " · " + where : "") + note + ".";
  };
  const populateEmail = async () => {
    if (!emailService?.getStatus) {
      emailStatus("Email delivery is unavailable in this settings window.");
      return;
    }
    try {
      // Rebuild the digest from this week's cached scores first, so a manual
      // scoring run is enough to produce one to read. Nothing is sent.
      let previewState = null;
      try {
        previewState = await mainService?.rebuildWeeklyDigest?.(window.opener || window) || null;
      } catch (_) {}
      const status = await emailService.getStatus();
      writeEmailConfig(status.config);
      const connection = status.credentials || {};
      if (connection.configured) {
        field("email-tls-mode").value = connection.tlsMode;
        field("email-auth-method").value = connection.authMethod;
      }
      field("email-host").value = connection.host || "";
      field("email-port").value = connection.port || "";
      field("email-username").value = connection.username || "";
      field("email-from").value = connection.from || "";
      field("email-to").value = connection.to || "";
      field("email-preview").value = status.snapshot?.text ||
        (previewState?.reason ||
          "No completed weekly digest is available yet. It appears after a scoring run with eligible papers.");
      field("email-last").textContent = formatLastDelivery(status.lastDelivery);
      field("email-retry").disabled = !status.retryKey || status.sending;
      const current = status.currentSubmission;
      emailStatus((connection.configured
        ? "Credentials: " + (connection.persistent ? "secure Login Manager." : "session only.") +
          " Server: " + [connection.host, connection.port].filter(Boolean).join(":") +
          " (" + (connection.tlsMode || "unknown TLS mode") + ")."
        : "No credentials saved.") +
        (current
          ? " Current delivery: " + current.status +
            (current.messageSubmitted ? " (message submitted; SMTP cannot confirm inbox delivery)." : ".")
          : "") +
        (status.snapshot?.text ? "" : " " + (previewState?.reason || "")));
    } catch (error) {
      emailStatus("Unable to load email status: " + String(error?.message || error));
    }
  };
  // The pane's own labels, hints and buttons, in Zotero's UI language.
  try {
    mainService?.applyPaneStrings?.(document);
  } catch (_) {}
  writeEmailConfig();
  void populateEmail();
  /*
   * "Last email" follows the delivery, not this window.
   *
   * Asked for directly: "last email line in the menu should refresh after the email
   * sent". The digest is normally sent by the scheduled run, which has no window, so
   * the line kept whatever it read when the window was opened. The email service
   * announces every recorded outcome and this repopulates on it.
   */
  try {
    const unsubscribe = emailService?.subscribeDelivery?.(() => {
      void populateEmail();
    });
    if (typeof unsubscribe === "function") {
      window.addEventListener("unload", () => {
        try {
          unsubscribe();
        } catch (_) {}
      }, { once: true });
    }
  } catch (_) {}

  // ---- EasyScholar journal lookup ----------------------------------------
  const journalService = window.opener?.Zotero?.FeedRankJournal || window.Zotero?.FeedRankJournal;
  const journalStatus = (message) => { field("journal-status").textContent = String(message || ""); };
  const populateJournal = async () => {
    if (!journalService?.getStatus) {
      journalStatus("Journal lookup is unavailable in this settings window.");
      return;
    }
    try {
      const status = await journalService.getStatus();
      field("easyscholar-enabled").checked = status.config?.lookupEnabled === true;
      field("easyscholar-refresh").checked = status.config?.refreshBeforeScoring === true;
      const configured = status.credentials?.configured === true;
      const enabled = status.config?.lookupEnabled === true;
      journalStatus(
        (configured
          ? "EasyScholar key: " + (status.credentials.persistent ? "saved securely." : "this session only.")
          : "EasyScholar key: not set.") +
        " " +
        (!enabled
          ? "Turn on EasyScholar journal lookup, then save a key."
          : !configured
            ? "Save your EasyScholar secret key, then run Update journal info from the feed menu."
            : "Ready. Use Update journal info from the feed or item menu."),
      );
    } catch (error) {
      journalStatus("Unable to load journal status: " + String(error?.message || error));
    }
  };
  void populateJournal();

  field("journal-save").addEventListener("click", () => {
    try {
      journalService?.saveConfig?.({
        refreshBeforeScoring: field("easyscholar-refresh").checked === true,
        lookupEnabled: field("easyscholar-enabled").checked === true,
      });
      journalStatus("Journal settings saved.");
    } catch (error) {
      journalStatus("Journal settings were not saved: " + String(error?.message || error));
    }
  });
  field("journal-save-key").addEventListener("click", async () => {
    const key = field("easyscholar-key");
    try {
      if (!key.value) throw new Error("Enter your EasyScholar secret key first.");
      const result = await journalService?.saveSecretKey?.({
        secretKey: key.value,
        parentWindow: window.opener || window,
      });
      journalStatus(result?.warning || (result?.persistent
        ? "EasyScholar key saved in the isolated encrypted FeedRank entry."
        : "EasyScholar key is available for this Zotero session only."));
    } catch (error) {
      journalStatus("The EasyScholar key was not saved: " + String(error?.message || error));
    } finally {
      key.value = "";
    }
  });
  field("journal-clear-key").addEventListener("click", async () => {
    try {
      await journalService?.clearSecretKey?.();
      field("easyscholar-key").value = "";
      journalStatus("EasyScholar key cleared.");
    } catch (error) {
      journalStatus("The EasyScholar key could not be cleared: " + String(error?.message || error));
    }
  });

  const renderPromptPreview = () => {
    const preview = field("prompt-preview");
    if (!preview) return;
    try {
      preview.value = typeof args.buildPromptPreview === "function"
        ? args.buildPromptPreview({
          ...config,
          profile: field("profile").value,
          explanationLanguage: field("language").value,
          bibliometricWeightPoints: field("bibliometric-weight").value,
          arxivSignificanceSignals: field("arxiv-significance-signals").value,
        })
        : "Prompt preview is unavailable in this fallback settings dialog.";
    } catch (error) {
      preview.value = "Unable to build the prompt preview: " + String(error?.message || error);
    }
  };
  field("profile").addEventListener("input", renderPromptPreview);
  field("language").addEventListener("change", renderPromptPreview);
  renderPromptPreview();

  field("email-save-options").addEventListener("click", () => {
    try {
      writeEmailConfig(emailService?.saveConfig?.(readEmailConfig()));
      emailStatus("Digest settings saved. Automatic delivery still needs the standing approval above.");
    } catch (error) {
      emailStatus("Digest settings were not saved: " + String(error?.message || error));
    }
  });
  // Check schedule reports whether the timer is armed, when the next run is due, and
  // what the last one did. It is the only schedule control left in the pane: the
  // pop-up test and "run it now" buttons were scaffolding for diagnosing a schedule
  // that now works, and the Tools menu still runs the job on demand.
  // Settings as a file: the service owns the picker, the file and the validation.
  // The settings-file group has its own status line: a failure there must not appear in the
  // email group, where nobody looks after clicking these buttons.
  const settingsFileStatus = (message) => {
    const field = document.getElementById("settings-file-status");
    if (field) field.textContent = String(message || "");
  };

  field("settings-export").addEventListener("click", async () => {
    try {
      const result = await mainService?.exportSettingsToFile?.(window);
      if (result?.cancelled) return;
      settingsFileStatus(result?.saved
        ? mainService.t(result.credentialsIncluded
        ? "settings.exportedWithCredentials"
        : "settings.exported", { path: result.path })
        : mainService.t("settings.exportFailed", { reason: result?.reason || "unknown" }));
    } catch (error) {
      settingsFileStatus(String(error?.message || error));
    }
  });
  field("settings-import").addEventListener("click", async () => {
    try {
      const result = await mainService?.importSettingsFromFile?.(window);
      if (result?.cancelled) return;
      if (result?.loaded) {
        populateForm(mainService?.loadConfig?.() || {});
        void populateEmail();
        void populateJournal();
        const applied = (result.applied || []).join(", ") || "nothing";
        const lines = [result.ignored?.length
          ? mainService.t("settings.importedIgnored", { count: result.ignored.length })
          : mainService.t("settings.importedApplied", { path: result.path || "file", items: applied })];
        for (const note of result.credentialNotes || []) lines.push(note);
        settingsFileStatus(lines.join(" "));
        return;
      }
      settingsFileStatus(mainService.t("settings.importFailed", { reason: result?.reason || "unknown" }));
    } catch (error) {
      settingsFileStatus(String(error?.message || error));
    }
  });
  field("settings-reset").addEventListener("click", async () => {
    try {
      const result = await mainService?.resetAllSettings?.(window);
      if (result?.cancelled) return;
      if (result?.reset) {
        populateForm(mainService?.loadConfig?.() || {});
        void populateEmail();
        void populateJournal();
      }
      const partial = result?.failures?.length
        ? " " + mainService.t("settings.resetPartial", { items: result.failures.join(", ") })
        : "";
      settingsFileStatus(result?.reset
        ? mainService.t("settings.resetDone") + partial
        : mainService.t("settings.resetFailed", { reason: result?.reason || "unknown" }));
    } catch (error) {
      settingsFileStatus(String(error?.message || error));
    }
  });

  field("weekly-check").addEventListener("click", () => {
    try {
      const text = String(mainService?.scheduleReportText?.() || "The schedule cannot be inspected yet.");
      emailStatus(text);
      try {
        mainService?.notifyInfo?.(text);
      } catch (_) {}
    } catch (error) {
      emailStatus("The schedule could not be inspected: " + String(error?.message || error));
    }
  });

  field("email-save-credentials").addEventListener("click", async () => {
    const secret = field("email-secret");
    try {
      if (!secret.value) throw new Error("Enter the SMTP server, username, sender, recipient, and password first.");
      const result = await emailService?.saveCredentials?.({
        secret: secret.value,
        ...readEmailConnection(),
        parentWindow: window.opener || window,
      });
      emailStatus(result?.warning || (result?.persistent
        ? "Credentials saved in the isolated encrypted FeedRank Login Manager entry."
        : "Credentials are available for this Zotero session only."));
    } catch (error) {
      emailStatus("Credentials were not saved: " + String(error?.message || error));
    } finally {
      secret.value = "";
    }
  });
  field("email-clear-credentials").addEventListener("click", async () => {
    try {
      await emailService?.clearCredentials?.();
      field("email-secret").value = "";
      field("email-host").value = "";
      field("email-port").value = "";
      field("email-username").value = "";
      field("email-from").value = "";
      field("email-to").value = "";
      emailStatus("FeedRank email credentials cleared.");
    } catch (error) {
      emailStatus("Credentials could not be cleared: " + String(error?.message || error));
    }
  });
  // A connection test performs no MAIL FROM and transmits no message. It is a
  // separate action from "Send test email…", which does transmit one.
  //
  // The diagnostics report goes to a FILE rather than into the window. It is a
  // full runtime inventory — dozens of member names in very long lines — which no
  // control in this window displays usefully, and a file can be attached to a
  // report or searched with an editor.
  let lastLog = "";
  let lastLogPath = "";
  let lastLogError = "";
  const writeLogFile = async (report) => {
    const text = String(report || "");
    lastLog = text;
    if (!text) return "";
    // One implementation, in the service, on the API that actually writes a file. The stream this
    // window used before called the deprecated string write(), which throws in this Gecko: the log
    // was never written, so Open had nothing to open while Copy worked from memory.
    const result = await mainService?.writeConnectionLog?.(text);
    lastLogPath = result?.written ? String(result.path) : "";
    lastLogError = result?.written ? "" : String(result?.reason || "the log could not be written");
    return lastLogPath;
  };;
  // The log is shown in the window, in a folded box: nothing depends on the operating system
  // opening a file, and nothing can fail silently.
  const showLog = async () => {
    const box = field("email-log");
    if (!box) return;
    let text = lastLog || "";
    if (!text) {
      const fromDisk = await mainService?.readConnectionLog?.(lastLogPath || "");
      text = fromDisk?.text || "";
      if (fromDisk?.path) lastLogPath = fromDisk.path;
    }
    box.value = text || "No connection log has been written yet. Run Test connection first.";
    const pathField = field("email-log-path");
    if (pathField) pathField.textContent = lastLogPath ? "File on disk: " + lastLogPath : "";
  };

  field("email-test-connection").addEventListener("click", async () => {
    const button = field("email-test-connection");
    button.disabled = true;
    // Test exactly what is on screen, and leave the form intact afterwards.
    const secret = field("email-secret").value || "";
    const credentials = secret ? { ...readEmailConnection(), secret } : null;
    emailStatus("Testing the SMTP connection (no message will be sent)…");
    try {
      const result = await emailService?.testConnection?.({
        ...(secret ? {} : { connectionConfig: readEmailConnection() }),
        parentWindow: window.opener || window,
        credentials,
      });
      // Written on BOTH outcomes: a pass is what tells us which TLS members this
      // build exposes, and that is exactly what a refusal needs.
      const written = await writeLogFile(result?.diagnostics);
      await showLog();
      if (result?.ok) {
        emailStatus("Connection test passed: " + (result.protocol || "TLS") + " on " +
          result.host + ":" + result.port + " (" + result.tlsMode + "), authentication accepted. " +
          (result.protocolConfirmed === false
            ? "The build reported no TLS version; the handshake completed instead. "
            : "") +
          "No message was sent. This test does not save SMTP settings." + (secret ? " Use Save credentials to keep these settings." : ""));
      } else {
        emailStatus("Connection test failed: " + (result?.error || "unknown error") + " No message was sent." +
          (written ? " Details were written to " + written + "." : " " + (lastLogError || "the log could not be written") + "."));
      }
    } catch (error) {
      emailStatus("Connection test failed: " + String(error?.message || error) + " No message was sent.");
    } finally {
      button.disabled = false;
    }
  });
  field("email-copy-safe-diagnostics").addEventListener("click", async () => {
    let report = lastLog || "";
    if (!report) {
      const fromDisk = await mainService?.readConnectionLog?.(lastLogPath || "");
      report = fromDisk?.text || "";
    }
    if (!report) {
      emailStatus("No connection log has been written yet. Run Test connection first.");
      return;
    }
    const safe = mainService?.sanitizeDiagnosticsReport?.(report);
    if (!safe) {
      emailStatus("The shareable report could not be built (diagnostics unavailable). Nothing was copied.");
      return;
    }
    const box = field("email-log");
    if (box) box.value = safe;
    if (mainService?.copyTextToClipboard?.(safe)) {
      emailStatus("Copied a shareable report: build, TLS mode, protocol stage and error codes only.");
      return;
    }
    emailStatus("The shareable report is shown above; select and copy it from there.");
  });
  field("email-copy-diagnostics").addEventListener("click", async () => {
    if (!lastLog) {
      const fromDisk = await mainService?.readConnectionLog?.(lastLogPath || "");
      lastLog = fromDisk?.text || "";
      if (fromDisk?.path) lastLogPath = fromDisk.path;
    }
    if (!lastLog) {
      emailStatus("No connection log has been written yet. Run Test connection first.");
      return;
    }
    if (mainService?.copyTextToClipboard?.(lastLog)) {
      emailStatus("Connection log copied to the clipboard.");
      return;
    }
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(lastLog);
        emailStatus("Connection log copied to the clipboard.");
        return;
      }
    } catch (_) {
      // Fall through to naming the file, which always works.
    }
    emailStatus("The log is on disk at " + (lastLogPath || "the Zotero data folder") + ".");
  });
  const openEmailPreview = async () => {
    try {
      await emailService?.openPreview?.({ parentWindow: window.opener || window });
      await populateEmail();
    } catch (error) {
      emailStatus("Digest review is unavailable: " + String(error?.message || error));
    }
  };
  field("email-review").addEventListener("click", () => { void openEmailPreview(); });
  // Rebuild is the local half: it recreates the digest and sends nothing.
  field("email-rebuild").addEventListener("click", async () => {
    const button = field("email-rebuild");
    button.disabled = true;
    emailStatus("Rebuilding this week's digest…");
    try {
      const result = await mainService?.rebuildWeeklyDigest?.(window.opener || window);
      emailStatus(result?.available
        ? "Digest rebuilt from " + result.articleCount + " scored " +
          (result.articleCount === 1 ? "article" : "articles") +
          (result.window ? " (" + result.window.from + " to " + result.window.to + ")" : "") +
          ". Nothing was sent."
        : "The digest was not rebuilt: " + String(result?.reason || "unknown reason"));
    } catch (error) {
      emailStatus("The digest was not rebuilt: " + String(error?.message || error));
    } finally {
      button.disabled = false;
      await populateEmail();
    }
  });
  // Review is the sending path: it opens the exact frozen message, and the Send
  // button in that window is the confirmation.
  field("email-send-now")?.remove?.();
  field("email-test").addEventListener("click", async () => {
    try {
      await emailService?.sendTestEmail?.({ parentWindow: window.opener || window });
      await populateEmail();
    } catch (error) {
      emailStatus("Test-email review is unavailable: " + String(error?.message || error));
    }
  });
  field("email-retry").addEventListener("click", async () => {
    try {
      const status = await emailService?.getStatus?.();
      if (!status?.retryKey) throw new Error("No known retryable delivery is available");
      const result = await emailService.retrySubmission(status.retryKey, { parentWindow: window.opener || window });
      emailStatus(result?.message || "Retry finished.");
      await populateEmail();
    } catch (error) {
      emailStatus("Retry was not sent: " + String(error?.message || error));
    }
  });

  field("save").addEventListener("click", () => {
    args.save?.({
      profile: field("profile").value,
      explanationLanguage: field("language").value,
      lookbackDays: field("lookback").value,
      candidateLimit: field("limit").value,
      batchSize: field("batch").value,
      batchConcurrency: field("concurrency").value,
      maxRetries: field("retries").value,
      requestTimeoutMs: field("timeout").value,
      runFrequency: field("run-frequency").value,
      weeklyRunDay: field("weekly-day").value,
      monthlyRunDay: field("monthly-day").value,
      weeklyRunTime: field("weekly-time").value,
      inputPricePerMillion: field("input-price").value,
      outputPricePerMillion: field("output-price").value,
      currency: field("currency").value,
      bibliometricWeightPoints: field("bibliometric-weight").value,
      arxivSignificanceSignals: field("arxiv-significance-signals").value,
    });
    window.close();
  });
  field("cancel").addEventListener("click", () => window.close());
});
