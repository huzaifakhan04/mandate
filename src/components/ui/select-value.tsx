"use client";

import { createElement, useSyncExternalStore } from "react";

const noop = () => () => {};
const supportsBaseSelect = () => typeof CSS !== "undefined" && CSS.supports("appearance", "base-select");

/**
 * Put this as the first child of a <select>. In browsers with customizable
 * select (`appearance: base-select`) it renders the select's button with a
 * <selectedcontent> slot, so the closed field can ellipsize its label and
 * keep clear of the chevron. It renders nothing on the server and in other
 * browsers, so the HTML stays a plain native select there.
 */
export function SelectValue() {
  const supported = useSyncExternalStore(noop, supportsBaseSelect, () => false);
  if (!supported) {
    return null;
  }
  return createElement("button", { type: "button" }, createElement("selectedcontent"));
}
