"use strict";

window.addEventListener("load", () => {
  const args = window.arguments?.[0] || {};
  const records = (Array.isArray(args.records) ? args.records : []).map((record, originalIndex) => ({
    ...record,
    originalIndex,
  }));
  const summary = args.summary || {};
  const rows = document.getElementById("rows");
  const status = document.getElementById("summary");
  const ranker = window.opener?.FeedRanker;
  const sortState = { key: "score", direction: "desc" };
  const sortControls = {
    score: { label: "Score", direction: "desc" },
    priority: { label: "Priority", direction: "desc" },
    title: { label: "Title", direction: "asc" },
    source: { label: "Feed", direction: "asc" },
    date: { label: "Date", direction: "desc" },
    confidence: { label: "Confidence", direction: "asc" },
    reason: { label: "Relevance explanation", direction: "asc" },
    evidence: { label: "Local evidence", direction: "asc" },
  };
  for (const [key, control] of Object.entries(sortControls)) {
    control.button = document.getElementById("sort-" + key);
    control.header = document.getElementById("sort-header-" + key);
  }

  const refresh = summary.refresh || {};
  // A persisted large-run summary retains only a bounded sample of feed
  // details, but keeps the complete counts separately. Prefer those counts so
  // reopening results does not make a successful N-day scan look truncated.
  const feedEntries = (key) => Array.isArray(refresh[key]) ? refresh[key] : [];
  const feedCount = (entriesKey, countKey) => {
    const declared = Number(refresh[countKey]);
    return Number.isSafeInteger(declared) && declared >= 0
      ? declared
      : feedEntries(entriesKey).length;
  };
  const successfulFeeds = feedEntries("successfulFeeds");
  const failedFeeds = feedEntries("failedFeeds");
  const successfulFeedCount = feedCount("successfulFeeds", "successfulFeedCount");
  const failedFeedCount = feedCount("failedFeeds", "failedFeedCount");
  const isISODate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  // "(s)" is only a source-level plural marker. It must never reach the screen,
  // so every count-driven word goes through this helper.
  const plural = (count, singular, pluralForm) => {
    const n = Number(count) || 0;
    if (n === 1) return singular;
    return pluralForm == null ? singular + "s" : pluralForm;
  };
  const lookbackDescription = () => {
    const days = Number.isInteger(Number(refresh.lookbackDays))
      ? Number(refresh.lookbackDays)
      : 0;
    const start = String(refresh.lookbackStartDate || "");
    const end = String(refresh.lookbackEndDate || "");
    if (isISODate(start) && isISODate(end)) {
      return start === end
        ? "today only (" + start + ")"
        : start + " through " + end + " (last " + days + " calendar days)";
    }
    return days === 0
      ? "today only"
      : "the last " + plural(days, "calendar day") + ", including today";
  };
  const details = [];
  if (summary.message) details.push(String(summary.message));
  if (refresh.kind === "selection") {
    const selected = Number(refresh.selectedItemCount) || 0;
    const scored = Number(refresh.candidateCount) || 0;
    details.push(
      "Selected " + selected + " " + plural(selected, "item") + "; scored " +
      scored + " unique " + plural(scored, "article") + ".",
    );
  } else if (refresh.kind === "feed-lookback") {
    const scanned = Number(refresh.candidateCount) || 0;
    details.push(
      "Stored-feed scan: read " + successfulFeedCount + " of " +
      (refresh.totalFeeds || 0) + " " + plural(refresh.totalFeeds, "feed") + "; found " +
      scanned + " unique " + plural(scanned, "paper") + " from " + lookbackDescription() + ".",
    );
    if (refresh.undatedItemCount) {
      details.push(
        "Skipped " + refresh.undatedItemCount + " " +
        plural(refresh.undatedItemCount, "item") + " with no usable publication date.",
      );
    }
  } else if (Number.isFinite(refresh.totalFeeds)) {
    details.push(
      "Refresh: " + successfulFeedCount + " of " + refresh.totalFeeds + " " +
      plural(refresh.totalFeeds, "feed") + " succeeded; " + (refresh.newItemCount || 0) + " new " +
      plural(refresh.newItemCount || 0, "item") + ".",
    );
    if (refresh.fallbackUsed === true) {
      const fallbackCount = Number(refresh.fallbackCandidateCount) || 0;
      const fallbackDays = Number(refresh.fallbackLookbackDays) || 0;
      details.push(
        (refresh.newItemCount
          ? "Newly imported items did not yield an eligible candidate, so FeedRank used "
          : "No new item IDs were created by this refresh, so FeedRank used ") +
        fallbackCount + " recent unscored or stale stored " + plural(fallbackCount, "paper") +
        " from the last " + plural(fallbackDays, "day") + ".",
      );
    }
  }
  if (refresh.recoveredForRescore === true) {
    details.push("Rescore recovered its paper list from the configured stored-feed lookback.");
  }
  if (failedFeedCount) {
    const names = failedFeeds.map((feed) => String(feed.name || "Unnamed feed"));
    details.push(names.length
      ? "Failed feeds: " + names.join(", ") + "."
      : "Failed feeds: " + failedFeedCount + ".");
  }
  const retainedSamples = [];
  if (successfulFeedCount > successfulFeeds.length) {
    retainedSamples.push(successfulFeeds.length + " of " + successfulFeedCount + " successful feed details");
  }
  if (failedFeedCount > failedFeeds.length) {
    retainedSamples.push(failedFeeds.length + " of " + failedFeedCount + " failed feed details");
  }
  if (retainedSamples.length) {
    details.push("Saved summary retains " + retainedSamples.join(" and ") + ".");
  }
  if (refresh.duplicateCount) {
    details.push(
      "Merged " + refresh.duplicateCount + " duplicate " +
      plural(refresh.duplicateCount, "record") + " by DOI or arXiv identifier.",
    );
  }
  if (refresh.limitedCount) {
    details.push(
      "Skipped " + refresh.limitedCount + " " +
      plural(refresh.limitedCount, "candidate") + " because of the configured limit.",
    );
  }
  const usageCalls = Array.isArray(summary.usageCalls) ? summary.usageCalls : [];
  const declaredUsageCallCount = Number(summary.usageCallCount);
  const usageCallCount = Number.isSafeInteger(declaredUsageCallCount) && declaredUsageCallCount >= 0
    ? declaredUsageCallCount
    : usageCalls.length;
  /*
   * The total only.
   *
   * Asked for directly: "score result page can reduce the top batch information. keep the
   * total info only." One line per batch and per retry filled the top of the page with
   * detail that the total already summarises, and a long run pushed the table itself down
   * the window. The exact aggregate is unchanged and still counted across EVERY call, not
   * just the retained sample -- the sample is simply no longer printed.
   */
  if (usageCallCount) {
    details.push(
      "Total for this ranking across " + usageCallCount + " Awesome GPT " +
      plural(usageCallCount, "call") + ": " + String(summary.usageTotal || ""),
    );
  }
  if (records.some((record) => Number(record.priorityScore) !== Number(record.score))) {
    details.push(
      "Score is the Awesome GPT relevance score. Priority adds only the configured " +
      "local bibliometric signal and is capped at 100.",
    );
  }
  status.textContent = details.join("\n") || "No scoring summary is available.";

  const cell = (row, value, className) => {
    const element = document.createElement("td");
    if (className) element.className = className;
    element.textContent = value == null ? "" : String(value);
    row.appendChild(element);
    return element;
  };
  const button = (label, callback) => {
    const element = document.createElement("button");
    element.className = "action-button";
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", callback);
    return element;
  };

  const textOrder = (left, right) => String(left == null ? "" : left)
    .localeCompare(String(right == null ? "" : right), undefined, { sensitivity: "base" });
  const scoreValue = (value) => Number.isFinite(Number(value)) ? Number(value) : -1;
  const priorityValue = (record) => scoreValue(record?.priorityScore ?? record?.score);
  const localEvidenceText = (record) => {
    const evidence = record?.bibliometricEvidence || {};
    const journal = evidence?.journal || {};
    const arxiv = evidence?.arxiv || {};
    const parts = [];
    if (evidence?.isArxiv || record?.arxiv) {
      if (Number(record?.arxivSignificanceBonus) > 0) {
        parts.push("arXiv signal +" + record.arxivSignificanceBonus);
      }
      const usesModelSignificance = arxiv.usesModelSignificance === true ||
        arxiv.source === "model-supplied-arxiv-metadata";
      const significance = Number(arxiv.arxivSignificance);
      if (usesModelSignificance && Number.isInteger(significance) && significance >= 0 && significance <= 100) {
        parts.push("Model " + significance + "/100");
      }
      const fallback = usesModelSignificance && arxiv.offlineKeywordFallback &&
        typeof arxiv.offlineKeywordFallback === "object"
        ? arxiv.offlineKeywordFallback
        : arxiv;
      const matches = Array.isArray(fallback.matchedSignals) ? fallback.matchedSignals : [];
      if (!usesModelSignificance && matches.length) {
        parts.push(matches.map((match) => String(match.keyword || "signal")).join(", "));
      }
      return parts.length ? parts.join(" · ") : "No local arXiv signal";
    }
    if (Number(record?.journalImpactBonus) > 0) {
      parts.push("Journal +" + record.journalImpactBonus);
    }
    if (journal.impactFactor != null) parts.push("IF " + journal.impactFactor);
    if (journal.fiveYearImpactFactor != null) parts.push("5y IF " + journal.fiveYearImpactFactor);
    if (journal.jcrQuartile) parts.push("JCR " + journal.jcrQuartile);
    if (journal.available) parts.push("EasyScholar");
    return parts.length ? parts.join(" · ") : "No local journal evidence";
  };
  const defaultOrder = (left, right) => {
    const scoreOrder = scoreValue(right.score) - scoreValue(left.score);
    if (scoreOrder) return scoreOrder;
    const dateOrder = textOrder(right.date, left.date);
    if (dateOrder) return dateOrder;
    const titleOrder = textOrder(left.title, right.title);
    return titleOrder || left.originalIndex - right.originalIndex;
  };
  const orderFor = (left, right) => {
    const order = sortState.key === "score"
      ? scoreValue(left.score) - scoreValue(right.score)
      : sortState.key === "priority"
        ? priorityValue(left) - priorityValue(right)
        : sortState.key === "evidence"
          ? textOrder(localEvidenceText(left), localEvidenceText(right))
          : textOrder(left[sortState.key], right[sortState.key]);
    if (order) return sortState.direction === "asc" ? order : -order;
    return defaultOrder(left, right);
  };
  const sortedRecords = () => records.slice().sort(orderFor);
  const clearRows = () => {
    if (typeof rows.replaceChildren === "function") {
      rows.replaceChildren();
      return;
    }
    while (rows.firstChild) rows.removeChild(rows.firstChild);
  };
  const renderRows = () => {
    clearRows();
    const ordered = sortedRecords();
    for (const record of ordered) {
      const row = document.createElement("tr");
      cell(row, record.score, "score");
      cell(row, record.priorityScore ?? record.score, "priority");
      cell(row, record.title, "title");
      cell(row, record.source, "source");
      cell(row, record.date, "date");
      cell(row, record.confidence, "confidence");
      cell(row, record.reason, "reason");
      cell(row, localEvidenceText(record), "evidence");
      const actions = cell(row, "", "actions");
      if (record.url) {
        actions.appendChild(button("Open article", () => ranker?.openURL?.(record.url)));
      }
      if (record.itemID != null) {
        actions.appendChild(button("Show Zotero item", () => ranker?.openItem?.(record.itemID)));
      }
      rows.appendChild(row);
    }
    if (!ordered.length) {
      const row = document.createElement("tr");
      const empty = document.createElement("td");
      empty.colSpan = 9;
      empty.textContent = "No completed scores are available.";
      row.appendChild(empty);
      rows.appendChild(row);
    }
  };
  const updateSortControls = () => {
    for (const [key, control] of Object.entries(sortControls)) {
      const active = sortState.key === key;
      const direction = active ? sortState.direction : "none";
      control.header?.setAttribute?.("aria-sort", direction === "none" ? "none" : direction === "asc" ? "ascending" : "descending");
      if (control.button) {
        control.button.textContent = control.label + (active ? (direction === "asc" ? " ↑" : " ↓") : "");
        control.button.setAttribute?.("aria-label", "Sort by " + control.label + (active ? ", " + direction : ""));
      }
    }
  };
  const selectSort = (key) => {
    if (sortState.key === key) {
      sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
    } else {
      sortState.key = key;
      sortState.direction = sortControls[key].direction;
    }
    updateSortControls();
    renderRows();
  };
  for (const [key, control] of Object.entries(sortControls)) {
    control.button?.addEventListener?.("click", () => selectSort(key));
  }
  updateSortControls();
  renderRows();

  document.getElementById("rerank").addEventListener("click", () => {
    const rescore = ranker?.rescoreLast || ranker?.rerankLast;
    Promise.resolve(rescore?.()).catch(() => {});
    window.close();
  });
  // These actions deliberately pass only the ranked-result snapshot already
  // shown in this window. The email service selects/escapes it locally and
  // never requests an LLM response merely to format a digest.
  const digestRecords = () => records.map(({ originalIndex, ...record }) => record);
  document.getElementById("preview-email")?.addEventListener("click", () => {
    Promise.resolve(ranker?.previewDigest?.(digestRecords(), summary)).catch(() => {});
  });
  document.getElementById("send-digest")?.addEventListener("click", () => {
    // "Send" opens the exact-content confirmation; it never submits from
    // this results window without the user reviewing recipient and content.
    Promise.resolve(ranker?.sendDigest?.(digestRecords(), summary)).catch(() => {});
  });
  document.getElementById("close").addEventListener("click", () => window.close());
});
