"use strict";

window.addEventListener("load", () => {
  const args = window.arguments?.[0] || {};
  const config = args.config || {};
  const field = (id) => document.getElementById(id);
  const form = globalThis.FeedRankFormControls.create(document);
  const mainFields = Object.freeze({
    profile: "profile", explanationLanguage: "language", lookbackDays: "lookback",
    candidateLimit: "limit", batchSize: "batch", batchConcurrency: "concurrency",
    maxRetries: "retries", requestTimeoutMs: "timeout", runFrequency: "run-frequency",
    weeklyRunDay: "weekly-day", monthlyRunDay: "monthly-day", weeklyRunTime: "weekly-time",
    inputPricePerMillion: "input-price", outputPricePerMillion: "output-price", currency: "currency",
    bibliometricWeightPoints: "bibliometric-weight", arxivSignificanceSignals: "arxiv-significance-signals",
  });
  const mainDefaults = Object.freeze({
    profile: "", explanationLanguage: "zh-CN", lookbackDays: 14, candidateLimit: 20,
    batchSize: 5, batchConcurrency: 1, maxRetries: 1, requestTimeoutMs: 120000,
    runFrequency: "weekly", weeklyRunDay: 1, monthlyRunDay: 1, weeklyRunTime: "",
    inputPricePerMillion: "", outputPricePerMillion: "", currency: "USD",
    bibliometricWeightPoints: 0, arxivSignificanceSignals: "",
  });
  const mainIDs = Object.values(mainFields);
  const emailOptionIDs = ["email-max-papers", "email-min-score", "email-priority-count",
    "email-reading-count", "email-reading-enabled", "email-auto-enabled"];
  const emailConnectionIDs = ["email-host", "email-port", "email-tls-mode", "email-auth-method",
    "email-username", "email-from", "email-to"];
  const emailIDs = [...emailOptionIDs, ...emailConnectionIDs];
  const journalIDs = ["easyscholar-enabled", "easyscholar-refresh"];
  const editableIDs = [...mainIDs, ...emailIDs, ...journalIDs];
  form.bind(editableIDs);
  window.addEventListener("unload", () => form.invalidate(), { once: true });
  const readMainConfig = () => Object.fromEntries(Object.entries(mainFields)
    .map(([name, id]) => [name, field(id).value]));
  const beginReplacement = () => {
    form.invalidate();
    return { token: form.begin("settings-action"), snapshot: form.capture(editableIDs) };
  };
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
  field("run-frequency").addEventListener("command", showDayControl);
  field("run-frequency").addEventListener("change", showDayControl);
  const populateForm = (next = {}, options = {}) => {
    for (const [name, id] of Object.entries(mainFields)) {
      form.write(id, next?.[name] ?? mainDefaults[name], options);
    }
    showDayControl();
  };
  // Initial hydration is synchronous, before this listener returns control to
  // the user. A default-focused field still needs its stored value displayed.
  populateForm(args.config || {}, { force: true, snapshot: form.capture(mainIDs) });

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
  const writeEmailConfig = (email = {}, options = {}) => {
    const { connectionModes = true, ...writeOptions } = options;
    const values = {
      "email-max-papers": email.maximumPapers ?? 10,
      "email-min-score": email.minimumRelevanceScore ?? 70,
      "email-priority-count": email.priorityCount ?? 5,
      "email-reading-count": email.readingListCount ?? 30,
    };
    if (connectionModes) {
      values["email-tls-mode"] = email.tlsMode || "starttls";
      values["email-auth-method"] = email.authMethod || "plain";
    }
    for (const [id, value] of Object.entries(values)) form.write(id, value, writeOptions);
    form.write("email-reading-enabled", email.readingListEnabled === true, { ...writeOptions, checked: true });
    form.write("email-auto-enabled", email.automaticSendingEnabled === true, { ...writeOptions, checked: true });
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
  const populateEmail = async ({ force = false, snapshot = null } = {}) => {
    const token = form.begin("email");
    const revisions = snapshot || form.capture(emailIDs);
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
      if (!form.isCurrent(token)) return;
      const status = await emailService.getStatus();
      if (!form.isCurrent(token)) return;
      const connection = status.credentials || {};
      const options = { force, snapshot: revisions };
      // Apply each mode once: saved credential identity is authoritative, not
      // the digest defaults that may differ from it while status is loading.
      const emailConfig = { ...status.config };
      if (connection.configured) {
        if (connection.tlsMode != null) emailConfig.tlsMode = connection.tlsMode;
        if (connection.authMethod != null) emailConfig.authMethod = connection.authMethod;
      }
      writeEmailConfig(emailConfig, options);
      for (const name of ["host", "port", "username", "from", "to"]) {
        form.write("email-" + name, connection[name] || "", options);
      }
      field("email-preview").value = status.snapshot?.text ||
        (status.digestBuildError || previewState?.reason ||
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
        (status.snapshot?.text ? "" : " " + (status.digestBuildError || previewState?.reason || "")));
    } catch (error) {
      if (form.isCurrent(token)) emailStatus("Unable to load email status: " + String(error?.message || error));
    }
  };
  // The pane's own labels, hints and buttons, in Zotero's UI language.
  try {
    mainService?.applyPaneStrings?.(document);
  } catch (_) {}
  writeEmailConfig(emailService?.loadConfig?.() || {});
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
  const populateJournal = async ({ force = false, snapshot = null } = {}) => {
    const token = form.begin("journal");
    const revisions = snapshot || form.capture(journalIDs);
    if (!journalService?.getStatus) {
      journalStatus("Journal lookup is unavailable in this settings window.");
      return;
    }
    try {
      const status = await journalService.getStatus();
      if (!form.isCurrent(token)) return;
      const options = { force, checked: true, snapshot: revisions };
      form.write("easyscholar-enabled", status.config?.lookupEnabled === true, options);
      form.write("easyscholar-refresh", status.config?.refreshBeforeScoring === true, options);
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
      if (form.isCurrent(token)) journalStatus("Unable to load journal status: " + String(error?.message || error));
    }
  };
  void populateJournal();

  field("journal-save").addEventListener("click", () => {
    try {
      form.begin("journal");
      const snapshot = form.capture(journalIDs);
      const saved = journalService?.saveConfig?.({
        refreshBeforeScoring: field("easyscholar-refresh").checked === true,
        lookupEnabled: field("easyscholar-enabled").checked === true,
      });
      if (saved) {
        const options = { force: true, checked: true, snapshot };
        form.write("easyscholar-enabled", saved.lookupEnabled === true, options);
        form.write("easyscholar-refresh", saved.refreshBeforeScoring === true, options);
      }
      form.accept(journalIDs, snapshot);
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
          ...config, ...readMainConfig(),
        })
        : "Prompt preview is unavailable in this fallback settings dialog.";
    } catch (error) {
      preview.value = "Unable to build the prompt preview: " + String(error?.message || error);
    }
  };
  field("profile").addEventListener("input", renderPromptPreview);
  field("language").addEventListener("command", renderPromptPreview);
  field("language").addEventListener("change", renderPromptPreview);
  renderPromptPreview();

  field("email-save-options").addEventListener("click", () => {
    try {
      form.invalidate("email");
      const snapshot = form.capture([...mainIDs, ...emailIDs]);
      const mainSaved = mainService?.saveConfig
        ? mainService.saveConfig(readMainConfig()) : args.save?.(readMainConfig());
      if (mainSaved) populateForm(mainSaved, { force: true, snapshot });
      const emailSaved = emailService?.saveConfig?.(readEmailConfig());
      if (emailSaved) writeEmailConfig(emailSaved, { force: true, snapshot, connectionModes: false });
      form.accept([...mainIDs, ...emailOptionIDs], snapshot);
      renderPromptPreview();
      void populateEmail();
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
    const action = beginReplacement();
    try {
      const result = await mainService?.importSettingsFromFile?.(window);
      if (!form.isCurrent(action.token)) return;
      if (result?.cancelled) {
        void populateEmail();
        void populateJournal();
        return;
      }
      if (result?.loaded) {
        form.invalidate();
        action.token = form.begin("settings-action");
        form.accept(editableIDs, action.snapshot);
        populateForm(mainService?.loadConfig?.() || {}, { force: true, snapshot: action.snapshot });
        renderPromptPreview();
        void populateEmail({ force: true, snapshot: action.snapshot });
        void populateJournal({ force: true, snapshot: action.snapshot });
        const applied = (result.applied || []).join(", ") || "nothing";
        const lines = [result.ignored?.length
          ? mainService.t("settings.importedIgnored", { count: result.ignored.length })
          : mainService.t("settings.importedApplied", { path: result.path || "file", items: applied })];
        for (const note of result.credentialNotes || []) lines.push(note);
        settingsFileStatus(lines.join(" "));
        return;
      }
      void populateEmail();
      void populateJournal();
      settingsFileStatus(mainService.t("settings.importFailed", { reason: result?.reason || "unknown" }));
    } catch (error) {
      if (form.isCurrent(action.token)) {
        void populateEmail();
        void populateJournal();
        settingsFileStatus(String(error?.message || error));
      }
    }
  });
  field("settings-reset").addEventListener("click", async () => {
    const action = beginReplacement();
    try {
      const result = await mainService?.resetAllSettings?.(window);
      if (!form.isCurrent(action.token)) return;
      if (result?.cancelled) {
        void populateEmail();
        void populateJournal();
        return;
      }
      if (result?.reset) {
        form.invalidate();
        action.token = form.begin("settings-action");
        form.accept(editableIDs, action.snapshot);
        populateForm(mainService?.loadConfig?.() || {}, { force: true, snapshot: action.snapshot });
        renderPromptPreview();
        void populateEmail({ force: true, snapshot: action.snapshot });
        void populateJournal({ force: true, snapshot: action.snapshot });
      } else {
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
      if (form.isCurrent(action.token)) {
        void populateEmail();
        void populateJournal();
        settingsFileStatus(String(error?.message || error));
      }
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

  field("refresh-email").addEventListener("click", async () => {
    const button = field("refresh-email");
    if (!mainService?.runRefreshAndEmail || button.disabled) return;
    button.disabled = true;
    emailStatus(mainService.t("pane.checking"));
    try {
      const result = await mainService.runRefreshAndEmail(window.opener || window);
      emailStatus(result?.previewReady
        ? mainService.t("pane.refreshEmailReady", { count: result.snapshot?.recordCount || 0 })
        : result?.cancelled ? "Cancelled; no email submitted."
          : result?.reason || "Another FeedRank operation is already running.");
    } catch (error) {
      emailStatus(mainService.t("pane.refreshEmailFailed", { reason: String(error?.message || error) }));
    } finally {
      button.disabled = false;
    }
  });

  field("email-save-credentials").addEventListener("click", async () => {
    const secret = field("email-secret");
    form.invalidate("email");
    const token = form.begin("email-action");
    const snapshot = form.capture(emailConnectionIDs);
    try {
      if (!secret.value) throw new Error("Enter the SMTP server, username, sender, recipient, and password first.");
      const result = await emailService?.saveCredentials?.({
        secret: secret.value,
        ...readEmailConnection(),
        parentWindow: window.opener || window,
      });
      if (!form.isCurrent(token)) return;
      // Also retire status requests that started while secure storage awaited.
      form.invalidate("email");
      form.accept(emailConnectionIDs, snapshot);
      emailStatus(result?.warning || (result?.persistent
        ? "Credentials saved in the isolated encrypted FeedRank Login Manager entry."
        : "Credentials are available for this Zotero session only."));
    } catch (error) {
      if (form.isCurrent(token)) emailStatus("Credentials were not saved: " + String(error?.message || error));
    } finally {
      secret.value = "";
    }
  });
  field("email-clear-credentials").addEventListener("click", async () => {
    form.invalidate("email");
    const token = form.begin("email-action");
    const connectionTextIDs = ["email-host", "email-port", "email-username", "email-from", "email-to"];
    const snapshot = form.capture(connectionTextIDs);
    try {
      await emailService?.clearCredentials?.();
      if (!form.isCurrent(token)) return;
      form.invalidate("email");
      field("email-secret").value = "";
      for (const id of connectionTextIDs) form.write(id, "", { force: true, snapshot });
      form.accept(connectionTextIDs, snapshot);
      emailStatus("FeedRank email credentials cleared.");
    } catch (error) {
      if (form.isCurrent(token)) emailStatus("Credentials could not be cleared: " + String(error?.message || error));
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
    form.invalidate();
    args.save?.(readMainConfig());
    window.close();
  });
  field("cancel").addEventListener("click", () => window.close());
});
