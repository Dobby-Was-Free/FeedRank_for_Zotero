"use strict";

window.addEventListener("load", () => {
  const args = window.arguments?.[0] || {};
  document.title = args.title || "FeedRank for Zotero";
  const message = document.getElementById("message");
  const usage = document.getElementById("usage");
  const progress = document.getElementById("progress");
  const cancel = document.getElementById("cancel");
  let cancelled = false;

  const update = (nextMessage, current = 0, total = 1) => {
    message.textContent = String(nextMessage || "");
    progress.max = Math.max(1, Number(total) || 1);
    progress.value = Math.max(0, Math.min(progress.max, Number(current) || 0));
  };
  const setUsage = (nextUsage) => {
    usage.textContent = String(nextUsage || "");
  };
  // One scoring run does several things in sequence. Retitling the single
  // progress window keeps that visible without opening a second dialog.
  const setTitle = (nextTitle) => {
    document.title = String(nextTitle || "") || "FeedRank for Zotero";
  };
  const requestCancel = () => {
    if (cancelled) return;
    cancelled = true;
    cancel.disabled = true;
    message.textContent = "Cancel requested…";
    try {
      args.cancel?.();
    } catch (_) {}
  };

  cancel.addEventListener("click", requestCancel);
  window.addEventListener("unload", requestCancel, { once: true });
  update(args.initialMessage || "Preparing…", args.initialCurrent, args.initialTotal);
  setUsage(args.lastUsage);
  window.FeedRankerProgress = { update, setUsage, setTitle };
});
