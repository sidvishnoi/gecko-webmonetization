/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["MonetizationChild"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
XPCOMUtils.defineLazyModuleGetters(this, {
  MonetizationLoader: "resource:///modules/MonetizationLoader.jsm",
});

class MonetizationChild extends JSWindowActorChild {
  constructor() {
    super();
    this._monetizationLoader = null;
  }

  get monetizationLoader() {
    if (!this._monetizationLoader) {
      this._monetizationLoader = new MonetizationLoader(this);
    }
    return this._monetizationLoader;
  }

  onHeadParsed(event) {
    if (event.target.ownerDocument != this.document) {
      return;
    }
    this.monetizationLoader.onPageShow(this.document);
  }

  onPageShow(event) {
    if (event.target != this.document) {
      return;
    }
    this.monetizationLoader.onPageShow(this.document);
  }

  onPageHide(event) {
    if (event.target != this.document) {
      return;
    }
    this._monetizationLoader?.onPageHide(this.document);
  }

  onVisibilityChange(event) {
    if (
      event.target != this.document ||
      this.document.ownerGlobal != this.contentWindow
    ) {
      // Verify if these cases are even possible.
      return;
    }

    // TODO: there must be a better way t
    const url = this.document.location;
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return;
    }

    this.monetizationLoader.onVisbilityChange(this.document);
  }

  onLinkEvent(event) {
    let link = event.target;
    // Ignore sub-frames (bugs 305472, 479408).
    if (link.ownerGlobal != this.contentWindow) {
      return;
    }
    if (!link.relList.contains("monetization")) {
      return;
    }
    // We also check .getAttribute, since an empty href attribute will give us
    // a link.href that is the same as the document.
    if (!link.href || !link.getAttribute("href")) {
      return;
    }

    this.monetizationLoader.onLinkEvent(link.ownerDocument);
  }

  receiveMessage(msg) {
    switch (msg.name) {
      case "monetization:refresh:request": {
        const sessionId = msg.data;
        if (this.monetizationLoader.sessionId === sessionId) {
          this.monetizationLoader.doUpdateMonetization(this.document, true);
          return Promise.resolve({
            oldSessionId: sessionId,
            newSessionId: this.monetizationLoader.sessionId,
          });
        }
        break;
      }
      case "monetization:complete:request": {
        const details = Cu.cloneInto(msg.json, this.document);
        const eventInit = {
          url: this.monetizationLoader.currentPaymentInfo.paymentPointerUri
            .spec,
          amount: details.amount.value,
          assetCode: details.amount.assetCode,
          assetScale: details.amount.assetScale,
          receipt: details.receipt,
        };
        this.contentWindow.monetization.dispatchEvent(
          new this.contentWindow.MonetizationProgressEvent(
            "progress",
            eventInit
          )
        );
        break;
      }
    }
    return null;
  }

  handleEvent(event) {
    switch (event.type) {
      case "pageshow":
        return this.onPageShow(event);
      case "pagehide":
        return this.onPageHide(event);
      case "visibilitychange":
        return this.onVisibilityChange(event);
      case "DOMHeadElementParsed":
        return this.onHeadParsed(event);
      default:
        return this.onLinkEvent(event);
    }
  }
}
