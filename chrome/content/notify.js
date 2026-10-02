"use strict";

/*
 * FeedRank for Zotero — passive notifications.
 *
 * FeedRank used to report every outcome with a modal `alert()` after the
 * operation had already finished. That is a dialog the user must dismiss to
 * learn something they did not ask a question about, and a run could end with a
 * confirmation dialog, two progress windows and a result alert stacked up.
 *
 * This module reports outcomes the way Zotero itself does: through
 * `Zotero.ProgressWindow`, which is the small panel that appears in the BOTTOM
 * RIGHT of the main window, needs no click, and closes itself. Zotero's own
 * "no PDF found" and file-import notices use exactly this, so it is the
 * established convention rather than an invention.
 *
 * Design rules:
 *   - A notice is NEVER required to proceed. Every call is wrapped so a failure
 *     to display one cannot fail the operation that produced it.
 *   - No notice is modal, and none takes focus.
 *   - Every notice auto-closes. The delay is a parameter, because a one-line
 *     success and a multi-line summary should not linger for the same time.
 *   - The text is bounded, because this renders in a small panel.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FeedRankNotify = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DEFAULT_DELAY_MS = 4000;
  const ERROR_DELAY_MS = 9000;
  const MAX_HEADLINE = 120;
  const MAX_LINES = 6;
  const MAX_LINE = 200;

  function text(value, maximum = MAX_LINE) {
    return String(value == null ? "" : value)
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, Math.max(0, maximum));
  }

  /**
   * Split a message into a headline and bounded detail lines. Callers pass
   * whatever they have — a sentence, or a sentence plus a list — and this keeps
   * the panel small without silently dropping information.
   */
  function splitMessage(message) {
    const raw = String(message == null ? "" : message).replace(/\r\n?/g, "\n");
    const paragraphs = raw.split("\n").map((line) => text(line)).filter(Boolean);
    if (!paragraphs.length) return { headline: "", lines: [] };
    const [headline, ...rest] = paragraphs;
    return {
      headline: headline.slice(0, MAX_HEADLINE),
      lines: rest.slice(0, MAX_LINES),
    };
  }

  /**
   * @param {object} deps  { Zotero }
   * @returns {{show: function, info: function, warn: function, error: function}}
   */
  function create(deps = {}) {
    const Zotero = deps.Zotero;

    function show(message, { delay = DEFAULT_DELAY_MS, window: parentWindow = null } = {}) {
      const { headline, lines } = splitMessage(message);
      if (!headline) return false;
      let progressWindow = null;
      try {
        if (typeof Zotero?.ProgressWindow !== "function") return false;
        const options = parentWindow ? { window: parentWindow } : {};
        progressWindow = new Zotero.ProgressWindow(options);
        // No CSS icon key is passed. Zotero's icon classes come from its own
        // stylesheet, and an unrecognised key would render an empty span; plain
        // text is what this notice needs.
        progressWindow.changeHeadline(headline);
        for (const line of lines) progressWindow.addDescription(line);
        /*
         * `show()` answers whether Zotero actually opened the panel.
         *
         * It returns false when there is no window to attach it to, and the whole
         * value of this function is that its answer can be trusted: callers fall
         * back to a real dialog when it says the notice was not shown, so claiming
         * success for a panel that never appeared is worse than reporting the
         * failure.
         */
        if (progressWindow.show() !== true) {
          try {
            progressWindow.close();
          } catch (_) {}
          return false;
        }
        // `requireMouseOver: false` means the panel closes after `delay` whether
        // or not the pointer ever entered it, which is the whole point: the user
        // must not have to touch a notice for it to go away.
        progressWindow.startCloseTimer(delay, false);
        return true;
      } catch (_) {
        // A notice is a convenience. Failing to show one must never surface as a
        // failure of the operation that produced it, so this swallows the error
        // rather than reporting it anywhere the user would have to act on.
        try {
          progressWindow?.close?.();
        } catch (_) {}
        return false;
      }
    }

    function info(message, options = {}) {
      if (typeof Zotero?.ProgressWindow !== "function") return false;
      // A single line is what the panel shows by default, so a one-sentence
      // message is passed through whole rather than split.
      return show(message, { delay: DEFAULT_DELAY_MS, ...options });
    }

    /*
     * A notice that STAYS until the caller closes it, for work that takes minutes.
     *
     * The scheduled run used to have nothing on screen while it refreshed feeds, so
     * there was no way to tell whether it had started at all. A normal notice
     * disappears after a few seconds, which is useless for that; this one appears
     * when the run starts, is rewritten as the run moves from stage to stage, and
     * closes itself when the run ends.
     *
     * It is still passive in every sense that matters: no click to dismiss it, no
     * focus taken, and every call is wrapped so a failure to display one can never
     * fail the run that produced it. `Zotero.ProgressWindow` cannot clear the lines
     * it has already been given, so an update closes that panel and opens a fresh
     * one -- a handful of times per run, for a panel that is a few lines tall.
     */
    function begin(message, { window: parentWindow = null } = {}) {
      let current = null;
      let lastMessage = "";
      const handle = {
        active: false,
        update(nextMessage) {
          const text = String(nextMessage == null ? "" : nextMessage);
          if (!text || text === lastMessage) return false;
          lastMessage = text;
          return render(text);
        },
        // Show a final message, then let the panel close itself after `delay`.
        close(finalMessage = "", { delay = DEFAULT_DELAY_MS } = {}) {
          const text = String(finalMessage == null ? "" : finalMessage);
          if (text) {
            lastMessage = text;
            if (render(text, delay)) {
              handle.active = false;
              return true;
            }
          }
          handle.active = false;
          try {
            current?.close?.();
          } catch (_) {}
          current = null;
          return false;
        },
      };

      function render(text, delay = null) {
        const { headline, lines } = splitMessage(text);
        if (!headline) return false;
        try {
          if (typeof Zotero?.ProgressWindow !== "function") return false;
          try {
            current?.close?.();
          } catch (_) {}
          const options = parentWindow ? { window: parentWindow } : {};
          const panel = new Zotero.ProgressWindow(options);
          panel.changeHeadline(headline);
          for (const line of lines) panel.addDescription(line);
          if (panel.show() !== true) {
            try {
              panel.close();
            } catch (_) {}
            throw new Error("The Zotero progress panel could not be opened");
          }
          // No timer while the run is going: that is the whole point of a sticky
          // notice. A final message gets one, so the last state is readable and then
          // clears itself.
          if (delay != null) panel.startCloseTimer(delay, false);
          current = panel;
          handle.active = true;
          return true;
        } catch (_) {
          try {
            current?.close?.();
          } catch (_) {}
          current = null;
          handle.active = false;
          return false;
        }
      }

      render(String(message == null ? "" : message));
      return handle;
    }

    function warn(message, options = {}) {
      return show(message, { delay: DEFAULT_DELAY_MS + 2000, ...options });
    }

    function error(message, options = {}) {
      return show(message, { delay: ERROR_DELAY_MS, ...options });
    }

    return Object.freeze({ show, info, warn, error, begin, DEFAULT_DELAY_MS, ERROR_DELAY_MS });
  }

  return Object.freeze({
    DEFAULT_DELAY_MS,
    ERROR_DELAY_MS,
    MAX_HEADLINE,
    MAX_LINES,
    splitMessage,
    text,
    create,
  });
});
