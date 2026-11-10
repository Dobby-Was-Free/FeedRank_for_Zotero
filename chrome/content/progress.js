"use strict";

window.addEventListener("load", () => {
  const args = window.arguments?.[0] || {};
  document.title = args.title || "FeedRank for Zotero";
  const message = document.getElementById("message");
  const usage = document.getElementById("usage");
  const progress = document.getElementById("progress");
  const cancel = document.getElementById("cancel");
  const skip = document.getElementById("skip-current");
  if (args.cancelLabel) cancel.textContent = String(args.cancelLabel);
  if (skip && args.skipLabel) skip.textContent = String(args.skipLabel);
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
  const setCanSkip = (enabled) => {
    if (!skip) return;
    const active = Boolean(enabled) && !cancelled && !args.isComplete?.();
    skip.disabled = !active;
    skip.hidden = !active;
  };
  const requestCancel = () => {
    // A programmatic completion close is not a user cancellation. Closing the
    // title bar while a run is active still requests cancellation as before.
    if (cancelled || args.isComplete?.()) return;
    cancelled = true;
    cancel.disabled = true;
    setCanSkip(false);
    message.textContent = "Cancel requested…";
    try {
      args.cancel?.();
    } catch (_) {}
  };

  cancel.addEventListener("click", requestCancel);
  skip?.addEventListener("click", () => {
    if (skip.disabled || cancelled || args.isComplete?.()) return;
    setCanSkip(false);
    try { args.skipCurrentFeed?.(); } catch (_) {}
  });
  window.addEventListener("unload", requestCancel, { once: true });
  update(args.initialMessage || "Preparing…", args.initialCurrent, args.initialTotal);
  setUsage(args.lastUsage);
  setCanSkip(args.canSkipCurrentFeed?.());
  window.FeedRankerProgress = { update, setUsage, setTitle, setCanSkip };
});
