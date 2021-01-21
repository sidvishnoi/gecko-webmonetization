/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

var EXPORTED_SYMBOLS = ["Monetization"];

/**
 * `window.monetization` interface.
 * See {@link dom/webidl/Monetization.webidl} for interface definition.
 */
class Monetization {
  init() {}

  get onprogress() {
    return this.__DOM_IMPL__.getEventHandler("onprogress");
  }

  set onprogress(handler) {
    this.__DOM_IMPL__.setEventHandler("onprogress", handler);
  }
}

Object.assign(Monetization.prototype, {
  contractID: "@mozilla.org/webmonetization/Monetization;1",
  classID: Components.ID("{880e8397-2353-4a76-b196-5544ec8cbe00}"),
  QueryInterface: ChromeUtils.generateQI([]),
});
