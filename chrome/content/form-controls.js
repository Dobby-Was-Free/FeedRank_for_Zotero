"use strict";

// Shared by the native preferences pane and the standalone chrome window.
// This module owns only form interaction state; it never reads preferences,
// credentials, files, providers or Zotero library items.
(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.FeedRankFormControls = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createModule() {
  function create(root) {
    const revisions = new Map();
    const bound = new Set();
    const requests = new Map();
    let epoch = 0;
    const element = (id) => root?.querySelector?.("#" + id) || root?.getElementById?.(id) || null;
    const revision = (id) => revisions.get(id) || 0;
    const active = (field) => {
      const document = field?.ownerDocument || root?.ownerDocument || root;
      const focused = document?.activeElement;
      return focused === field || Boolean(focused && field?.contains?.(focused));
    };
    return {
      bind(ids) {
        for (const id of ids) {
          const field = element(id);
          if (!field || bound.has(id)) continue;
          bound.add(id);
          const protect = () => {
            field.__feedRankDirty = true;
            revisions.set(id, revision(id) + 1);
          };
          // Protect an opened popup before the first choice is committed.
          // Native menulists emit command for user choices; programmatic value
          // changes emit select/ValueChange, neither of which is an edit here.
          for (const event of ["pointerdown", "mousedown", "focusin", "keydown", "input", "change", "command"]) {
            field.addEventListener(event, protect);
          }
        }
      },
      write(id, value, { force = false, checked = false, snapshot = null } = {}) {
        const field = element(id);
        if (!field) return false;
        if (snapshot && (!snapshot.has(id) || snapshot.get(id) !== revision(id))) return false;
        if (!force && (field.__feedRankDirty === true || active(field))) return false;
        const property = checked ? "checked" : "value";
        const next = checked ? value === true : String(value ?? "");
        const current = checked ? field.checked === true : String(field.value ?? "");
        // Even a same-value assignment can dismiss a native popup.
        if (current === next) return false;
        field[property] = next;
        return true;
      },
      capture(ids) {
        return new Map(ids.map((id) => [id, revision(id)]));
      },
      accept(ids, snapshot = null) {
        for (const id of ids) {
          const field = element(id);
          if (field && (!snapshot || (snapshot.has(id) && snapshot.get(id) === revision(id)))) {
            field.__feedRankDirty = false;
          }
        }
      },
      clear(ids) { this.accept(ids); },
      invalidate(group = null) {
        if (group) requests.set(group, (requests.get(group) || 0) + 1);
        else epoch++;
      },
      begin(group) {
        const request = (requests.get(group) || 0) + 1;
        requests.set(group, request);
        return { group, request, epoch };
      },
      isCurrent(token) {
        return Boolean(token) && token.epoch === epoch && requests.get(token.group) === token.request;
      },
    };
  }
  return Object.freeze({ create });
});
