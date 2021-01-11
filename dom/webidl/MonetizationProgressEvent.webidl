/* -*- Mode: IDL; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/.
 */

[Exposed=Window, SecureContext]
interface MonetizationProgressEvent : Event {
  [ChromeOnly] constructor(DOMString type, MonetizationProgressEventInit eventInitDict);
  readonly attribute USVString      url;
  readonly attribute DOMString      amount;
  readonly attribute DOMString      assetCode;
  readonly attribute unsigned long  assetScale;
  readonly attribute DOMString?     receipt;
};

dictionary MonetizationProgressEventInit : EventInit {
  required USVString url;
  required DOMString      amount;
  required DOMString      assetCode;
  required unsigned long  assetScale;
           DOMString?     receipt = null;
};
