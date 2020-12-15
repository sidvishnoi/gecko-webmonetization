/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_PaymentMethodWebMonetization_h
#define mozilla_dom_PaymentMethodWebMonetization_h

#include "mozilla/dom/MonetizationPaymentBinding.h"
#include "nsPIDOMWindow.h"
#include "nsTArray.h"

namespace mozilla::dom {

class WebMonetizationPaymentService final {
 public:
  NS_INLINE_DECL_REFCOUNTING(WebMonetizationPaymentService)

  static already_AddRefed<WebMonetizationPaymentService> GetService();

  bool IsWebMonetizationPayment(const nsAString& aSupportedMethods);
  bool IsValidWebMonetizationPaymentRequest(JSContext* aCx, JSObject* aData,
                                            nsAString& aErrorMsg);
  void CheckForValidWebMonetizationPaymentErrors(JSContext* aCx,
                                                 JSObject* aData,
                                                 ErrorResult& aRv);
  bool IsValidWebMonetizationProvider(const nsAString& aProviderUrl);

 private:
  WebMonetizationPaymentService() = default;
  ~WebMonetizationPaymentService() = default;
};

}  // end of namespace mozilla::dom

#endif
