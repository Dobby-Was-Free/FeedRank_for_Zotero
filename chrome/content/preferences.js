"use strict";

Zotero.FeedRankerPreferencePane = {
  fields: Object.freeze({
    profile: "feed-ranker-profile",
    explanationLanguage: "feed-ranker-language",
    lookbackDays: "feed-ranker-lookback",
    candidateLimit: "feed-ranker-limit",
    batchSize: "feed-ranker-batch",
    batchConcurrency: "feed-ranker-concurrency",
    maxRetries: "feed-ranker-retries",
    requestTimeoutMs: "feed-ranker-timeout",
    runFrequency: "feed-ranker-run-frequency",
    weeklyRunDay: "feed-ranker-weekly-day",
    monthlyRunDay: "feed-ranker-monthly-day",
    weeklyRunTime: "feed-ranker-weekly-time",
    currency: "feed-ranker-cost-currency",
    inputPricePerMillion: "feed-ranker-input-price",
    outputPricePerMillion: "feed-ranker-output-price",
    bibliometricWeightPoints: "feed-ranker-bibliometric-weight",
    arxivSignificanceSignals: "feed-ranker-arxiv-significance-signals",
  }),

  getService() {
    return Zotero.FeedRanker;
  },

  getEmailService() {
    return Zotero.FeedRankEmail;
  },

  getJournalService() {
    return Zotero.FeedRankJournal;
  },

  getField(root, name) {
    return root.querySelector("#" + this.fields[name]);
  },

  /*
   * Guards against a repopulate overwriting a control the user is working in.
   *
   * The EMAIL section is repopulated on pane show AND when the preview window
   * closes AND after every email action. That rewrite reset the TLS-mode and
   * authentication-method dropdowns, and a programmatic value change on a
   * `<select>` whose popup is open closes that popup — so the click landed on a
   * control that had just been reset, which is exactly the reported "sometimes I
   * cannot click the dropdown".
   *
   * The rule is deliberately conservative: a field the user has typed in or
   * chosen from is OURS until it is saved, and no automatic refresh may touch it.
   * A field the user has not touched is still refreshed normally, so saving or
   * clearing credentials continues to update the form.
   */
  markDirtyOnEdit(root, ids) {
    for (const id of ids) {
      const element = root.querySelector("#" + id);
      if (!element || element.__feedRankDirtyBound) continue;
      element.__feedRankDirtyBound = true;
      const mark = () => { element.__feedRankDirty = true; };
      element.addEventListener("input", mark);
      element.addEventListener("change", mark);
    }
  },

  // Write a value unless the user has edited that control since the last save.
  setFieldUnlessEdited(element, value) {
    if (!element || element.__feedRankDirty === true) return false;
    element.value = value ?? "";
    return true;
  },

  clearDirty(root, ids) {
    for (const id of ids) {
      const element = root.querySelector("#" + id);
      if (element) element.__feedRankDirty = false;
    }
  },

  readConfig(root) {
    const config = {};
    for (const name of Object.keys(this.fields)) {
      config[name] = this.getField(root, name)?.value ?? "";
    }
    return config;
  },

  writeConfig(root, config) {
    for (const name of Object.keys(this.fields)) {
      const field = this.getField(root, name);
      if (field) field.value = config[name] ?? "";
    }
  },

  renderPromptPreview(root) {
    const preview = root.querySelector("#feed-ranker-prompt-preview");
    if (!preview) return;
    const service = this.getService();
    if (!service?.buildPromptPreview) {
      preview.value = "FeedRank is still starting. Reopen this Settings pane in a moment.";
      return;
    }
    try {
      preview.value = service.buildPromptPreview(this.readConfig(root));
    } catch (error) {
      preview.value = "Unable to build the prompt preview: " + String(error?.message || error);
    }
  },

  /*
   * Only the day control the chosen repeat uses is on screen: the weekday for a
   * weekly run, the day of the month for a monthly one, and neither for a daily one.
   */
  syncDayControl(root) {
    const frequency = this.getField(root, "runFrequency")?.value;
    const weekday = this.getField(root, "weeklyRunDay");
    const monthly = this.getField(root, "monthlyRunDay");
    if (weekday) weekday.style.display = frequency === "weekly" ? "" : "none";
    if (monthly) monthly.style.display = frequency === "monthly" ? "" : "none";
  },

  populate(root) {
    const service = this.getService();
    const config = service?.loadConfig?.();
    if (!config) return;
    this.writeConfig(root, config);
    this.syncDayControl(root);
    const status = root.querySelector("#feed-ranker-save-status");
    if (status) status.value = "";
    this.renderPromptPreview(root);
    void this.populateEmail(root);
    void this.populateJournal(root);
  },

  save(root) {
    const service = this.getService();
    if (!service?.saveConfig) return;
    const saved = service.saveConfig(this.readConfig(root));
    this.writeConfig(root, saved);
    this.renderPromptPreview(root);
    const status = root.querySelector("#feed-ranker-save-status");
    // "Saved." alone is not an answer to "I set a time and nothing happened": the
    // schedule says when the run will actually happen, or that this week is done.
    if (status) {
      status.value = "Saved. " + (service.nextRunSummary?.() || "");
    }
  },

  // Every control the automatic refresh writes into. A user edit in any of them is
  // protected until the settings are saved.
  EMAIL_EDITABLE_FIELDS: Object.freeze([
    "host", "port", "tls-mode", "auth-method", "username", "from", "to",
    "max-papers", "min-score", "priority-count", "reading-count",
  ]),

  emailField(root, id) {
    return root.querySelector("#feed-ranker-email-" + id);
  },

  readEmailConfig(root) {
    return {
      maximumPapers: this.emailField(root, "max-papers")?.value ?? "",
      minimumRelevanceScore: this.emailField(root, "min-score")?.value ?? "",
      priorityCount: this.emailField(root, "priority-count")?.value ?? "",
      readingListCount: this.emailField(root, "reading-count")?.value ?? "",
      readingListEnabled: this.emailField(root, "reading-enabled")?.checked === true,
      automaticSendingEnabled: this.emailField(root, "auto-enabled")?.checked === true,
      tlsMode: this.emailField(root, "tls-mode")?.value ?? "",
      authMethod: this.emailField(root, "auth-method")?.value ?? "",
    };
  },

  readEmailConnection(root) {
    return {
      host: this.emailField(root, "host")?.value ?? "",
      port: this.emailField(root, "port")?.value ?? "",
      tlsMode: this.emailField(root, "tls-mode")?.value ?? "",
      authMethod: this.emailField(root, "auth-method")?.value ?? "",
      username: this.emailField(root, "username")?.value ?? "",
      from: this.emailField(root, "from")?.value ?? "",
      to: this.emailField(root, "to")?.value ?? "",
    };
  },

  // The email connection fields, by the id suffix used in the markup. Kept in one
  // place so the dirty-tracking list and the populate path cannot drift apart.
  EMAIL_CONNECTION_FIELDS: Object.freeze([
    "host", "port", "tls-mode", "auth-method", "username", "from", "to",
  ]),

  writeEmailConnection(root, connection = {}) {
    const values = {
      host: connection.host || "",
      port: connection.port || "",
      username: connection.username || "",
      from: connection.from || "",
      to: connection.to || "",
    };
    if (connection.configured) {
      values["tls-mode"] = connection.tlsMode;
      values["auth-method"] = connection.authMethod;
    }
    for (const [id, value] of Object.entries(values)) {
      // Never overwrite a control the user has edited but not yet saved.
      this.setFieldUnlessEdited(this.emailField(root, id), value);
    }
  },

  writeEmailConfig(root, config = {}) {
    const values = {
      "max-papers": config.maximumPapers ?? 10,
      "min-score": config.minimumRelevanceScore ?? 70,
      "priority-count": config.priorityCount ?? 5,
      "reading-count": config.readingListCount ?? 30,
      "tls-mode": config.tlsMode ?? "starttls",
      "auth-method": config.authMethod ?? "plain",
    };
    for (const [id, value] of Object.entries(values)) {
      // Same rule as the connection fields: an unsaved edit is the user's.
      this.setFieldUnlessEdited(this.emailField(root, id), value);
    }
    const reading = this.emailField(root, "reading-enabled");
    if (reading) reading.checked = config.readingListEnabled === true;
    const automatic = this.emailField(root, "auto-enabled");
    if (automatic) automatic.checked = config.automaticSendingEnabled === true;
  },

  /*
   * "Last email" is the one line the pane can answer with certainty, straight
   * from the retained submission record: when a message was last accepted (or
   * last failed), and where it went. A connection test never reaches MAIL FROM
   * and is excluded by the service, so it cannot be mistaken for a digest.
   */
  formatLastDelivery(last) {
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
    // A delivery whose local record could not be written is still reported as what
    // it was, with the gap named: saying "not accepted" for a message the server
    // accepted is worse than saying the record is incomplete.
    const note = last.accepted && last.recordSaved === false
      ? " (this session only: the delivery record could not be written)"
      : "";
    return "Last email: " + stamp + " — " + outcome + (where ? " · " + where : "") + note + ".";
  },

  // The log is shown in the pane, in a folded box, instead of being handed to the operating system.
  // "Open log file" was the least reliable control here: it needed a file to exist, a path to be
  // remembered, and the system to agree to open it -- and it could fail without saying anything.
  async showConnectionLog(root) {
    const box = root.querySelector("#feed-ranker-email-log");
    if (!box) return;
    let text = this.lastConnectionLog || "";
    if (!text) {
      const fromDisk = await this.getEmailService()?.readConnectionLog?.(this.lastConnectionLogPath || "");
      text = fromDisk?.text || "";
      if (fromDisk?.path) this.lastConnectionLogPath = fromDisk.path;
    }
    box.value = text || "No connection log has been written yet. Run Test connection first.";
    const pathField = root.querySelector("#feed-ranker-email-log-path");
    if (pathField) {
      pathField.textContent = this.lastConnectionLogPath ? "File on disk: " + this.lastConnectionLogPath : "";
    }
  },

  setSettingsFileStatus(root, message) {
    const field = root.querySelector("#feed-ranker-settings-file-status");
    if (!field) return;
    field.textContent = String(message || "");
  },

  setEmailStatus(root, message) {
    const field = root.querySelector("#feed-ranker-email-status");
    if (!field) return;
    // The element is a plain <div>, not a XUL <label>, so it takes text.
    field.textContent = String(message || "");
  },

  async populateEmail(root) {
    const service = this.getEmailService();
    if (!service?.getStatus) {
      this.setEmailStatus(root, "Email delivery is still starting.");
      return;
    }
    try {
      /*
       * Rebuild the digest from the cache BEFORE reading the status.
       *
       * The digest covers the scored articles of the last seven days, however they
       * were scored. An earlier build only produced one from the scheduled run, so
       * scoring papers by hand left this box showing "no digest is available yet".
       * `rebuildWeeklyDigest` writes a local message only: no connection, no send,
       * and it reports why it could not instead of failing silently.
       */
      let previewState = null;
      try {
        previewState = await this.getService()?.rebuildWeeklyDigest?.(root.ownerGlobal) || null;
      } catch (_) {
        // A digest that cannot be rebuilt must not stop the rest of the pane.
      }
      const status = await service.getStatus();
      this.writeEmailConfig(root, status.config);
      // Written through the edit guard, in one place, so the TLS-mode and
      // authentication-method dropdowns are never reset out from under a click.
      const connection = status.credentials || {};
      this.writeEmailConnection(root, connection);
      const preview = root.querySelector("#feed-ranker-email-preview");
      if (preview) {
        preview.value = status.snapshot?.text ||
          (previewState?.reason ||
            "No completed weekly digest is available yet. It appears after a scoring run with eligible papers.");
      }
      const last = root.querySelector("#feed-ranker-email-last");
      if (last) last.textContent = this.formatLastDelivery(status.lastDelivery);
      const retry = root.querySelector("#feed-ranker-email-retry-button");
      if (retry) retry.disabled = !status.retryKey || status.sending;
      const current = status.currentSubmission;
      const credentialText = connection.configured
        ? "Credentials: " + (connection.persistent ? "secure Login Manager" : "session only") +
          " · " + [connection.host, connection.port].filter(Boolean).join(":") +
          " (" + (connection.tlsMode || "unknown TLS mode") + ")"
        : "No credentials saved.";
      const deliveryText = current
        ? " Current delivery: " + current.status +
          (current.messageSubmitted ? " (message was submitted; delivery not confirmable over SMTP)" : "") + "."
        : "";
      // Why there is no preview is part of the status, not a silence.
      const previewText = status.snapshot?.text
        ? ""
        : " " + (previewState?.reason || "No digest preview is available yet.");
      this.setEmailStatus(root, credentialText + deliveryText + previewText);
    } catch (error) {
      this.setEmailStatus(root, "Unable to load email status: " + String(error?.message || error));
    }
  },

  async saveEmailOptions(root) {
    const service = this.getEmailService();
    try {
      // The weekly schedule lives in the main configuration, so this one button
      // saves both it and the digest options: they are one section on screen.
      const mainSaved = this.getService()?.saveConfig?.(this.readConfig(root));
      if (mainSaved) this.writeConfig(root, mainSaved);
      if (service?.saveConfig) {
        const saved = service.saveConfig(this.readEmailConfig(root));
        this.writeEmailConfig(root, saved);
      }
      // The edits are saved now, so the automatic refresh may own them again.
      this.clearDirty(root, this.EMAIL_EDITABLE_FIELDS);
      const status = root.querySelector("#feed-ranker-save-status");
      if (status) status.value = "";
      this.setEmailStatus(root, "Digest settings saved. Automatic delivery still needs the standing approval above.");
    } catch (error) {
      this.setEmailStatus(root, "Digest settings were not saved: " + String(error?.message || error));
    }
  },

  /*
   * Is the schedule alive? Reported, not guessed: whether the timer is armed, when
   * the next run is due, whether this week is already done, and what happened last
   * time. Asked for after "nothing appears on the weekly run time".
   */
  checkSchedule(root) {
    const service = this.getService();
    if (!service?.scheduleReportText) {
      this.setEmailStatus(root, "The schedule cannot be inspected yet: FeedRank is still starting.");
      return;
    }
    let text = "";
    try {
      text = String(service.scheduleReportText() || "");
    } catch (error) {
      this.setEmailStatus(root, "The schedule could not be inspected: " + String(error?.message || error));
      return;
    }
    this.setEmailStatus(root, text);
    // Also as a passive pop-up, because the pane may not be the window you are
    // looking at while Zotero works.
    try {
      service.notifyInfo?.(text);
    } catch (_) {}
  },


  /*
   * Settings as a file. The service owns the picker, the file and the validation; the pane
   * only reports the outcome, in the status line it already has.
   */
  async saveSettingsFile(root) {
    const service = this.getService();
    if (!service?.exportSettingsToFile) {
      this.setSettingsFileStatus(root, service?.t?.("settings.unavailable") || "FeedRank is still starting.");
      return;
    }
    const result = await service.exportSettingsToFile(root.ownerGlobal || null);
    if (result?.cancelled) return;
    this.setSettingsFileStatus(root, result?.saved
      ? service.t(result.credentialsIncluded
        ? "settings.exportedWithCredentials"
        : "settings.exported", { path: result.path })
      : service.t("settings.exportFailed", { reason: result?.reason || "unknown" }));
  },

  async loadSettingsFile(root) {
    const service = this.getService();
    if (!service?.importSettingsFromFile) {
      this.setSettingsFileStatus(root, service?.t?.("settings.unavailable") || "FeedRank is still starting.");
      return;
    }
    const result = await service.importSettingsFromFile(root.ownerGlobal || null);
    if (result?.cancelled) return;
    if (result?.loaded) {
      this.populate(root);
      const applied = (result.applied || []).join(", ") || "nothing";
      const lines = [result.ignored?.length
        ? service.t("settings.importedIgnored", { count: result.ignored.length })
        : service.t("settings.importedApplied", { path: result.path || "file", items: applied })];
      // What happened to the credentials in the file belongs on the same line: a restored
      // password, or one this machine could not decrypt and therefore left empty.
      for (const note of result.credentialNotes || []) lines.push(note);
      this.setSettingsFileStatus(root, lines.join(" "));
      return;
    }
    this.setSettingsFileStatus(root, service.t("settings.importFailed", { reason: result?.reason || "unknown" }));
  },

  async resetSettings(root) {
    const service = this.getService();
    if (!service?.resetAllSettings) {
      this.setSettingsFileStatus(root, service?.t?.("settings.unavailable") || "FeedRank is still starting.");
      return;
    }
    const result = await service.resetAllSettings(root.ownerGlobal || null);
    if (result?.cancelled) return;
    if (result?.reset) this.populate(root);
    // A partial reset must not read as a complete one: name what survived.
    const partial = result?.failures?.length
      ? " " + service.t("settings.resetPartial", { items: result.failures.join(", ") })
      : "";
    this.setSettingsFileStatus(root, result?.reset
      ? service.t("settings.resetDone") + partial
      : service.t("settings.resetFailed", { reason: result?.reason || "unknown" }));
  },

  /*
  /*
   * Run the whole weekly job now: refresh, settle, score, and the digest. Manual
   * means "do it even though this week is already marked done". The Tools menu
   * command is what reaches this now; the pane's test button is gone.
   */
  async saveEmailCredentials(root) {
    const service = this.getEmailService();
    const secret = this.emailField(root, "secret");
    if (!service?.saveCredentials || !secret?.value) {
      this.setEmailStatus(root, "Enter the SMTP server, username, sender, recipient, and password first.");
      return;
    }
    try {
      const result = await service.saveCredentials({
        secret: secret.value,
        ...this.readEmailConnection(root),
        parentWindow: root.ownerGlobal,
      });
      this.setEmailStatus(root, result.warning || (result.persistent
        ? "Credentials saved in the isolated encrypted FeedRank Login Manager entry."
        : "Credentials are available for this Zotero session only."));
      // Saved, so the automatic refresh may own these controls again.
      this.clearDirty(root, this.EMAIL_EDITABLE_FIELDS);
    } catch (error) {
      this.setEmailStatus(root, "Credentials were not saved: " + String(error?.message || error));
    } finally {
      // Never retain or redisplay the raw secret in an ordinary settings field.
      secret.value = "";
    }
  },

  async clearEmailCredentials(root) {
    const service = this.getEmailService();
    try {
      await service?.clearCredentials?.();
      const secret = this.emailField(root, "secret");
      const host = this.emailField(root, "host");
      const port = this.emailField(root, "port");
      const username = this.emailField(root, "username");
      const from = this.emailField(root, "from");
      const to = this.emailField(root, "to");
      if (secret) secret.value = "";
      if (host) host.value = "";
      if (port) port.value = "";
      if (username) username.value = "";
      if (from) from.value = "";
      if (to) to.value = "";
      // Cleared on purpose, so the protection must not keep the old values pinned.
      this.clearDirty(root, this.EMAIL_EDITABLE_FIELDS);
      this.setEmailStatus(root, "FeedRank email credentials cleared.");
    } catch (error) {
      this.setEmailStatus(root, "Credentials could not be cleared: " + String(error?.message || error));
    }
  },

  // A connection test performs no MAIL FROM and transmits no message. It is
  // deliberately a separate button from "Send test email…", which does.
  async testEmailConnection(root) {
    const service = this.getEmailService();
    if (!service?.testConnection) {
      this.setEmailStatus(root, "The SMTP connection test is unavailable.");
      return;
    }
    // Test exactly what is on screen. Previously this only read SAVED
    // credentials, so a freshly typed server and password were ignored, and the
    // subsequent refresh wiped the form — which looked like the button doing
    // nothing. Transient values are used for this one test only and are not
    // stored by it.
    const form = this.readEmailConnection(root);
    const secret = this.emailField(root, "secret")?.value || "";
    const credentials = secret ? { ...form, secret } : null;
    const button = root.querySelector("#feed-ranker-email-test-connection");
    if (button) button.disabled = true;
    this.setEmailStatus(root, "Testing the SMTP connection (no message will be sent)…");
    try {
      const result = await service.testConnection({ parentWindow: root.ownerGlobal, credentials,
        ...(secret ? {} : { connectionConfig: form }) });
      // The log is written to a FILE, on both outcomes: a pass is what tells us
      // which TLS members this build exposes, and that is what a refusal needs.
      const written = await this.writeConnectionLog(result.diagnostics);
      await this.showConnectionLog(root);
      if (result.ok) {
        this.setEmailStatus(root,
          "Connection test passed: " + (result.protocol || "TLS") + " on " +
          result.host + ":" + result.port + " (" + result.tlsMode + "), authentication accepted. " +
          (result.protocolConfirmed === false
            ? "The build reported no TLS version; the handshake completed instead. "
            : "") +
          "No message was sent. This test does not save SMTP settings." + (secret ? " Use Save credentials to keep these settings." : ""));
      } else {
        this.setEmailStatus(root,
          "Connection test failed: " + (result.error || "unknown error") + " No message was sent." +
          (written ? " Details were written to " + written + "." : " " + (this.lastConnectionLogError || "the log could not be written") + "."));
      }
    } catch (error) {
      this.setEmailStatus(root, "Connection test failed: " + String(error?.message || error) + " No message was sent.");
    } finally {
      if (button) button.disabled = false;
    }
  },

  // The most recent diagnostics report and where it landed, so the Copy and Open
  // buttons work without the log occupying a text box in the pane.
  lastConnectionLog: "",
  lastConnectionLogPath: "",

  fileForPath(path) {
    try {
      const file = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
      file.initWithPath(path);
      return file;
    } catch (_) {
      return null;
    }
  },

  /*
   * Write the diagnostics report to a file and return its path, or "" when it
   * could not be written.
   *
   * Zotero's data directory is preferred because it is the one place a Zotero
   * user can reliably find, and it survives a reboot of the temp folder. The OS
   * temp directory is the fallback when the data directory is unavailable or not
   * writable, so a failed write never costs us the report. Nothing here throws:
   * a log is a diagnostic aid, and failing to save one must not turn a connection
   * test into an error.
   */
  async writeConnectionLog(report) {
    const text = String(report || "");
    this.lastConnectionLog = text;
    if (!text) return "";
    // One implementation, in the service, on the API that works. The pane keeps the path so the
    // Open button can find it again in this session.
    const result = await this.getEmailService()?.writeConnectionLog?.(text);
    this.lastConnectionLogPath = result?.written ? String(result.path) : "";
    this.lastConnectionLogError = result?.written ? "" : String(result?.reason || "the log could not be written");
    return this.lastConnectionLogPath;
  },

  async openEmailPreview(root) {
    const service = this.getEmailService();
    try {
      // Review is preview-first on purpose: the preview window owns the Send
      // click for the exact frozen message it displays. "Rebuild and send now" is
      // the separate one-click path, with no preview at all.
      await service?.openPreview?.({ parentWindow: root.ownerGlobal });
      await this.populateEmail(root);
    } catch (error) {
      this.setEmailStatus(root, "Digest review is unavailable: " + String(error?.message || error));
    }
  },

  async openEmailTest(root) {
    const service = this.getEmailService();
    try {
      await service?.sendTestEmail?.({ parentWindow: root.ownerGlobal });
      await this.populateEmail(root);
    } catch (error) {
      this.setEmailStatus(root, "Test-email review is unavailable: " + String(error?.message || error));
    }
  },

  /*
   * Rebuild the digest and nothing else. It is the explicit form of what happens
   * whenever this pane opens, and it is what the Send button sends, so the two
   * functions stay separate: rebuild changes what is in the box, send sends it.
   */
  async rebuildDigest(root) {
    const service = this.getService();
    const button = root.querySelector("#feed-ranker-email-rebuild");
    if (!service?.rebuildWeeklyDigest) {
      this.setEmailStatus(root, "Rebuilding is unavailable: FeedRank is still starting.");
      return;
    }
    if (button) button.disabled = true;
    this.setEmailStatus(root, "Rebuilding this week's digest…");
    try {
      const result = await service.rebuildWeeklyDigest(root.ownerGlobal);
      this.setEmailStatus(root, result?.available
        ? "Digest rebuilt from " + result.articleCount + " scored " +
          (result.articleCount === 1 ? "article" : "articles") +
          (result.window ? " (" + result.window.from + " to " + result.window.to + ")" : "") +
          ". Nothing was sent."
        : "The digest was not rebuilt: " + String(result?.reason || "unknown reason"));
    } catch (error) {
      this.setEmailStatus(root, "The digest was not rebuilt: " + String(error?.message || error));
    } finally {
      if (button) button.disabled = false;
      await this.populateEmail(root);
    }
  },

  /*
   * Review is the sending path: it opens the exact frozen message, and the Send
   * button in that window is the confirmation. There is deliberately no second
   * "send it now" button in the pane, because it would be the same decision twice.
   */
  async openEmailPreview(root) {
    const service = this.getEmailService();
    try {
      await service?.openPreview?.({ parentWindow: root.ownerGlobal });
      await this.populateEmail(root);
    } catch (error) {
      this.setEmailStatus(root, "Digest review is unavailable: " + String(error?.message || error));
    }
  },

  async retryEmail(root) {
    const service = this.getEmailService();
    try {
      const status = await service?.getStatus?.();
      if (!status?.retryKey) throw new Error("No known retryable delivery is available");
      const result = await service.retrySubmission(status.retryKey, { parentWindow: root.ownerGlobal });
      this.setEmailStatus(root, result?.message || "Retry finished.");
      await this.populateEmail(root);
    } catch (error) {
      this.setEmailStatus(root, "Manual retry was not sent: " + String(error?.message || error));
    }
  },

  // ---- EasyScholar journal lookup --------------------------------------

  journalField(root, id) {
    return root.querySelector("#feed-ranker-easyscholar-" + id);
  },

  setJournalStatus(root, message) {
    const field = root.querySelector("#feed-ranker-journal-status");
    if (field) field.textContent = String(message || "");
  },

  readJournalConfig(root) {
    return {
      lookupEnabled: this.journalField(root, "enabled")?.checked === true,
      refreshBeforeScoring: this.journalField(root, "refresh")?.checked === true,
    };
  },

  writeJournalConfig(root, config = {}) {
    const enabled = this.journalField(root, "enabled");
    if (enabled) enabled.checked = config.lookupEnabled === true;
    const refresh = this.journalField(root, "refresh");
    if (refresh) refresh.checked = config.refreshBeforeScoring === true;
  },

  async populateJournal(root) {
    const service = this.getJournalService();
    if (!service?.getStatus) {
      this.setJournalStatus(root, "Journal lookup is still starting.");
      return;
    }
    try {
      const status = await service.getStatus();
      this.writeJournalConfig(root, status.config);
      const configured = status.credentials?.configured === true;
      const enabled = status.config?.lookupEnabled === true;
      const credentialText = configured
        ? "EasyScholar key: " + (status.credentials.persistent ? "saved securely" : "this session only") + "."
        : "EasyScholar key: not set.";
      const instruction = !enabled
        ? "Turn on EasyScholar journal lookup, then save a key."
        : !configured
          ? "Save your EasyScholar secret key, then run Update journal info."
          : "Ready. Use Update journal info to retrieve metrics.";
      const cacheText = status.cacheSize ? " " + status.cacheSize + " journal(s) cached." : "";
      this.setJournalStatus(root, credentialText + " " + instruction + cacheText);
    } catch (error) {
      this.setJournalStatus(root, "Unable to load journal status: " + String(error?.message || error));
    }
  },

  async saveJournalSettings(root) {
    const service = this.getJournalService();
    if (!service?.saveConfig) return;
    try {
      const config = service.saveConfig(this.readJournalConfig(root));
      this.writeJournalConfig(root, config);
      this.setJournalStatus(root, "Journal settings saved.");
    } catch (error) {
      this.setJournalStatus(root, "Journal settings were not saved: " + String(error?.message || error));
    }
  },

  async saveJournalKey(root) {
    const service = this.getJournalService();
    const key = this.journalField(root, "key");
    if (!service?.saveSecretKey || !key?.value) {
      this.setJournalStatus(root, "Enter your EasyScholar secret key first.");
      return;
    }
    try {
      const result = await service.saveSecretKey({
        secretKey: key.value,
        parentWindow: root.ownerGlobal,
      });
      this.setJournalStatus(root, result.warning || (result.persistent
        ? "EasyScholar key saved in the isolated encrypted FeedRank entry."
        : "EasyScholar key is available for this Zotero session only."));
    } catch (error) {
      this.setJournalStatus(root, "The EasyScholar key was not saved: " + String(error?.message || error));
    } finally {
      // Never retain or redisplay the raw key in an ordinary settings field.
      key.value = "";
    }
  },

  async clearJournalKey(root) {
    const service = this.getJournalService();
    try {
      await service?.clearSecretKey?.();
      const key = this.journalField(root, "key");
      if (key) key.value = "";
      this.setJournalStatus(root, "EasyScholar key cleared.");
    } catch (error) {
      this.setJournalStatus(root, "The EasyScholar key could not be cleared: " + String(error?.message || error));
    }
  },

  async updateJournalInfo(root) {
    const service = this.getService();
    if (!service?.updateJournalInformation) {
      this.setJournalStatus(root, "Journal lookup is unavailable.");
      return;
    }
    this.setJournalStatus(root, "Looking up journal information…");
    try {
      const result = await service.updateJournalInformation(root.ownerGlobal);
      this.setJournalStatus(root, result?.cancelled
        ? "Journal lookup was cancelled."
        : "Journal lookup finished. Reopen the FeedRank results to see the updated Priority.");
      await this.populateJournal(root);
    } catch (error) {
      this.setJournalStatus(root, "Journal lookup did not complete: " + String(error?.message || error));
    }
  },

  init(root) {
    if (!root || root.dataset.feedRankerInitialized === "true") return;
    root.dataset.feedRankerInitialized = "true";
    void this.showConnectionLog(root);
    // Which build is running, in the group these three buttons live in.
    this.setSettingsFileStatus(root, this.getService()?.versionLabel?.() || "");
    for (const name of Object.keys(this.fields)) {
      const field = this.getField(root, name);
      field?.addEventListener("input", () => this.renderPromptPreview(root));
      field?.addEventListener("change", () => this.renderPromptPreview(root));
    }
    // Protect the email controls from a repopulate resetting what the user is
    // editing — in particular the TLS-mode and authentication-method dropdowns,
    // whose popup closes if the value changes underneath it.
    this.markDirtyOnEdit(root, this.EMAIL_EDITABLE_FIELDS);
    const save = root.querySelector("#feed-ranker-save");
    save?.addEventListener("command", () => this.save(root));
    this.getField(root, "runFrequency")?.addEventListener("change", () => this.syncDayControl(root));
    root.querySelector("#feed-ranker-email-save-options")?.addEventListener("command", () => {
      void this.saveEmailOptions(root);
    });
    root.querySelector("#feed-ranker-weekly-check")?.addEventListener("command", () => {
      this.checkSchedule(root);
    });
    root.querySelector("#feed-ranker-settings-export")?.addEventListener("command", () => {
      void this.saveSettingsFile(root);
    });
    root.querySelector("#feed-ranker-settings-import")?.addEventListener("command", () => {
      void this.loadSettingsFile(root);
    });
    root.querySelector("#feed-ranker-settings-reset")?.addEventListener("command", () => {
      void this.resetSettings(root);
    });
    root.querySelector("#feed-ranker-email-save-credentials")?.addEventListener("command", () => {
      void this.saveEmailCredentials(root);
    });
    root.querySelector("#feed-ranker-email-clear-credentials")?.addEventListener("command", () => {
      void this.clearEmailCredentials(root);
    });
    root.querySelector("#feed-ranker-email-test-connection")?.addEventListener("command", () => {
      void this.testEmailConnection(root);
    });
    // A diagnostics report is written next to Zotero's own data rather than shown
    // in the pane. It is a full runtime inventory — dozens of member names in very
    // long lines — which no settings textarea can display usefully, and a file can
    // be attached to a report or searched with a normal editor.
    // The same log with identities, addresses, server text and local paths replaced: the copy a
    // reader can attach to an issue.
    root.querySelector("#feed-ranker-email-copy-safe-diagnostics")?.addEventListener("command", async () => {
      // The sanitizer lives on the MAIN service, not on the email service: they are separate
      // objects, and asking the wrong one returned undefined -- which the old fallback to the raw
      // text then displayed as if it had been sanitized.
      const main = this.getService();
      const email = this.getEmailService();
      let report = this.lastConnectionLog || "";
      if (!report) {
        const fromDisk = await email?.readConnectionLog?.(this.lastConnectionLogPath || "");
        report = fromDisk?.text || "";
      }
      if (!report) {
        this.setEmailStatus(root, "No connection log has been written yet. Run Test connection first.");
        return;
      }
      const safe = main?.sanitizeDiagnosticsReport?.(report);
      if (!safe) {
        // Stopping is the only honest answer: showing the raw log under a sanitized label is a
        // disclosure, and this is the surface a user is most likely to paste into a public issue.
        this.setEmailStatus(root, "The shareable report could not be built (diagnostics unavailable). Nothing was copied.");
        return;
      }
      const box = root.querySelector("#feed-ranker-email-log");
      if (box) box.value = safe;
      if (main?.copyTextToClipboard?.(safe)) {
        this.setEmailStatus(root, "Copied a shareable report: build, TLS mode, protocol stage and error codes only.");
        return;
      }
      this.setEmailStatus(root, "The shareable report is shown above; select and copy it from there.");
    });
    root.querySelector("#feed-ranker-email-copy-diagnostics")?.addEventListener("command", async () => {
      const service = this.getEmailService();
      let report = this.lastConnectionLog || "";
      if (!report) {
        // Written by an earlier session, or by the other window: read it from disk.
        const fromDisk = await service?.readConnectionLog?.(this.lastConnectionLogPath || "");
        report = fromDisk?.text || "";
        if (fromDisk?.path) this.lastConnectionLogPath = fromDisk.path;
      }
      if (!report) {
        this.setEmailStatus(root, "No connection log has been written yet. Run Test connection first.");
        return;
      }
      // The clipboard helper is on the main service too; asking the email service for it silently
      // fell through to navigator.clipboard.
      const copyService = this.getService();
      if (copyService?.copyTextToClipboard?.(report)) {
        this.setEmailStatus(root, "Connection log copied to the clipboard.");
        return;
      }
      try {
        const clipboard = root.ownerGlobal?.navigator?.clipboard;
        if (clipboard?.writeText) {
          await clipboard.writeText(report);
          this.setEmailStatus(root, "Connection log copied to the clipboard.");
          return;
        }
      } catch (_) {
        // Fall through to naming the file, which always works.
      }
      this.setEmailStatus(root, "The log is on disk at " + (this.lastConnectionLogPath || "the FeedRank data folder") + ".");
    });
    root.querySelector("#feed-ranker-email-preview-button")?.addEventListener("command", () => {
      void this.openEmailPreview(root);
    });
    root.querySelector("#feed-ranker-email-rebuild")?.addEventListener("command", () => {
      void this.rebuildDigest(root);
    });
    root.querySelector("#feed-ranker-email-test-button")?.addEventListener("command", () => {
      void this.openEmailTest(root);
    });
    root.querySelector("#feed-ranker-email-retry-button")?.addEventListener("command", () => {
      void this.retryEmail(root);
    });
    root.querySelector("#feed-ranker-journal-save")?.addEventListener("command", () => {
      void this.saveJournalSettings(root);
    });
    root.querySelector("#feed-ranker-journal-save-key")?.addEventListener("command", () => {
      void this.saveJournalKey(root);
    });
    root.querySelector("#feed-ranker-journal-clear-key")?.addEventListener("command", () => {
      void this.clearJournalKey(root);
    });
    root.querySelector("#feed-ranker-journal-update")?.addEventListener("command", () => {
      void this.updateJournalInfo(root);
    });
    /*
     * "Last email" follows the delivery, not the pane.
     *
     * Asked for directly: "last email line in the menu should refresh after the email
     * sent". The send almost never happens in this window -- the scheduled run has no
     * window at all, and Review digest sends from the preview -- so the line used to
     * keep whatever it had read when the pane was last populated, and a delivered
     * digest could sit there invisible until the pane was reopened. The email service
     * announces every recorded outcome; this listens and repopulates.
     */
    try {
      const unsubscribe = this.getEmailService()?.subscribeDelivery?.(() => {
        void this.populateEmail(root);
      });
      if (typeof unsubscribe === "function") {
        root.ownerGlobal?.addEventListener?.("unload", () => {
          try {
            unsubscribe();
          } catch (_) {}
        }, { once: true });
      }
    } catch (_) {}
    // The pane's own labels, hints and buttons, in Zotero's UI language.
    this.getService()?.applyPaneStrings?.(root);
    this.populate(root);
  },
};
