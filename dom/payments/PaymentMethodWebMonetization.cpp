/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "PaymentMethodWebMonetization.h"
#include "PaymentAddress.h"
#include "mozilla/Preferences.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/ErrorResult.h"
#include "mozilla/dom/MonetizationPaymentBinding.h"
#include "nsArrayUtils.h"
#include "nsCharSeparatedTokenizer.h"
#include "nsDataHashtable.h"

namespace mozilla::dom {

StaticRefPtr<WebMonetizationPaymentService> gWebMonetizationPaymentService;

already_AddRefed<WebMonetizationPaymentService>
WebMonetizationPaymentService::GetService() {
  if (!gWebMonetizationPaymentService) {
    gWebMonetizationPaymentService = new WebMonetizationPaymentService();
    ClearOnShutdown(&gWebMonetizationPaymentService);
  }
  RefPtr<WebMonetizationPaymentService> service =
      gWebMonetizationPaymentService;
  return service.forget();
}

bool WebMonetizationPaymentService::IsWebMonetizationPayment(
    const nsAString& aSupportedMethods) {
  return aSupportedMethods.Equals(u"monetization"_ns);
}

bool WebMonetizationPaymentService::IsValidWebMonetizationPaymentRequest(
    JSContext* aCx, JSObject* aData, nsAString& aErrorMsg) {
  if (!aData) {
    aErrorMsg.AssignLiteral("methodData.data is required.");
    return false;
  }
  JS::RootedValue data(aCx, JS::ObjectValue(*aData));

  PaymentMethodMonetizationRequest request;
  if (!request.Init(aCx, data)) {
    aErrorMsg.AssignLiteral(
        "Fail to convert methodData.data to PaymentMethodMonetizationRequest.");
    return false;
  }

  if (!request.mPaymentProvider.WasPassed()) {
    aErrorMsg.AssignLiteral("methodData.data.paymentProvider is required.");
    return false;
  }
  const auto provider = request.mPaymentProvider.Value();
  if (!IsValidWebMonetizationProvider(provider)) {
    aErrorMsg.Assign(provider + u" is not an valid payment provider."_ns);
    return false;
  }

  return true;
}

// TODO: `aProvider` should be a URL.
// TODO: `Preferences::GetString` should not be called on each PaymentRequest.
// NOTE: In future, this will come from "user preferences" interface.
bool WebMonetizationPaymentService::IsValidWebMonetizationProvider(
    const nsAString& aProviderUrl) {
  nsAutoString supportedProvider;
  Preferences::GetString("dom.payments.request.monetization.provider",
                         supportedProvider);
  return aProviderUrl.Equals(supportedProvider);
}

void WebMonetizationPaymentService::CheckForValidWebMonetizationPaymentErrors(
    JSContext* aCx, JSObject* aData, ErrorResult& aRv) {
  MOZ_ASSERT(aData, "Don't pass null data");
  JS::RootedValue data(aCx, JS::ObjectValue(*aData));

  // XXX
  PaymentMethodMonetizationErrors bcError;
  if (!bcError.Init(aCx, data)) {
    aRv.NoteJSContextException(aCx);
  }
}
}  // namespace mozilla::dom
