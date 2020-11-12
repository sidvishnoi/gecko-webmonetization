/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * A base class which implements nsIMonetizationLinkingElement and can
 * be subclassed by various content nodes that want to load
 * stylesheets (<style>, <link>, processing instructions, etc).
 */

#include "mozilla/dom/LinkMonetization.h"

#include "mozilla/dom/Element.h"
#include "mozilla/dom/FragmentOrElement.h"
#include "mozilla/dom/HTMLLinkElement.h"
#include "nsIContent.h"
#include "mozilla/dom/Document.h"
#include "nsUnicharUtils.h"
#include "nsCRT.h"
#include "nsXPCOMCIDInternal.h"
#include "nsUnicharInputStream.h"
#include "nsContentUtils.h"

namespace mozilla::dom {

LinkMonetization::MonetizationInfo::MonetizationInfo(
    const Document& aDocument, already_AddRefed<nsIURI> aURI,
    already_AddRefed<nsIPrincipal> aTriggeringPrincipal)
    : mURI(aURI), mTriggeringPrincipal(aTriggeringPrincipal) {}

LinkMonetization::MonetizationInfo::~MonetizationInfo() = default;

LinkMonetization::LinkMonetization()
    : mUpdatesEnabled(true), mLineNumber(1), mColumnNumber(1) {}

LinkMonetization::~LinkMonetization() {
  LinkMonetization::SetMonetization(nullptr);
}

Monetization* LinkMonetization::GetMonetizationForBindings() const {
  if (mMonetization && !mMonetization->IsComplete()) {
    return nullptr;
  }
  return mMonetization;
}

void LinkMonetization::Unlink() { LinkMonetization::SetMonetization(nullptr); }

void LinkMonetization::Traverse(nsCycleCollectionTraversalCallback& cb) {
  LinkMonetization* tmp = this;
  NS_IMPL_CYCLE_COLLECTION_TRAVERSE(mMonetization);
}

void LinkMonetization::SetMonetization(Monetization* aMonetization) {
  if (mMonetization) {
    mMonetization->SetOwningNode(nullptr);
  }

  mMonetization = aMonetization;
  if (mMonetization) {
    mMonetization->SetOwningNode(&AsContent());
  }
}

uint32_t LinkMonetization::ToLinkMask(const nsAString& aLink) {
  // Keep this in sync with sRelValues in HTMLLinkElement.cpp
  if (aLink.EqualsLiteral("monetization"))
    return LinkMonetization::eMONETIZATION;
  else
    return 0;
}

uint32_t LinkMonetization::ParseLinkTypes(const nsAString& aTypes) {
  uint32_t linkMask = 0;
  nsAString::const_iterator start, done;
  aTypes.BeginReading(start);
  aTypes.EndReading(done);
  if (start == done) return linkMask;

  nsAString::const_iterator current(start);
  bool inString = !nsContentUtils::IsHTMLWhitespace(*current);
  nsAutoString subString;

  while (current != done) {
    if (nsContentUtils::IsHTMLWhitespace(*current)) {
      if (inString) {
        nsContentUtils::ASCIIToLower(Substring(start, current), subString);
        linkMask |= ToLinkMask(subString);
        inString = false;
      }
    } else {
      if (!inString) {
        start = current;
        inString = true;
      }
    }
    ++current;
  }
  if (inString) {
    nsContentUtils::ASCIIToLower(Substring(start, current), subString);
    linkMask |= ToLinkMask(subString);
  }
  return linkMask;
}

// Result<LinkMonetization::Update, nsresult>
// LinkMonetization::UpdateMonetization(
//     nsIMonetizationLoaderObserver* aObserver) {
//   return DoUpdateMonetization(nullptr, aObserver, false);
// }

Result<LinkMonetization::Update, nsresult>
LinkMonetization::UpdateMonetizationInternal(Document* aOldDocument,
                                             bool aForceUpdate) {
  return DoUpdateMonetization(aOldDocument, aForceUpdate);
}

Result<LinkMonetization::Update, nsresult>
LinkMonetization::DoUpdateMonetization(
    Document* aOldDocument,
    //  nsIMonetizationLoaderObserver* aObserver,
    bool aForceUpdate) {
  nsIContent& thisContent = AsContent();
  if (thisContent.IsInShadowTree()) {
    return Update{};
  }

  if (mMonetization && aOldDocument) {
    // We're removing the link element from the document or shadow tree, unload
    // the stylesheet.
    //
    // We want to do this even if updates are disabled, since otherwise a sheet
    // with a stale linking element pointer will be hanging around -- not good!
    if (mMonetization->IsComplete()) {
      aOldDocument->RemoveMonetization(*mMonetization);
    }

    SetMonetization(nullptr);
  }

  Document* doc = thisContent.GetComposedDoc();

  // // Loader could be null during unlink, see bug 1425866.
  // if (!doc || !doc->CSSLoader() || !doc->CSSLoader()->GetEnabled()) {
  //   return Update{};
  // }

  // When static documents are created, stylesheets are cloned manually.
  if (!mUpdatesEnabled || doc->IsStaticDocument()) {
    return Update{};
  }

  Maybe<MonetizationInfo> info = GetMonetizationInfo();
  if (!aForceUpdate && mMonetization && info && info->mURI) {
    if (nsIURI* oldURI = mMonetization->GetMonetizationURI()) {
      bool equal;
      nsresult rv = oldURI->Equals(info->mURI, &equal);
      if (NS_SUCCEEDED(rv) && equal) {
        return Update{};
      }
    }
  }

  if (mMonetization) {
    if (mMonetization->IsComplete()) {
      doc->RemoveMonetization(*mMonetization);
    }
    SetMonetization(nullptr);
  }

  if (!info) {
    return Update{};
  }

  if (!info->mURI) {
    return Update{};
  }

  return Update{};
  // auto resultOrError = doc->CSSLoader()->LoadStyleLink(*info, aObserver);
  // if (resultOrError.isErr()) {
  //   // Don't propagate LoadStyleLink() errors further than this, since some
  //   // consumers (e.g. nsXMLContentSink) will completely abort on innocuous
  //   // things like a stylesheet load being blocked by the security system.
  //   return Update{};
  // }
  // return resultOrError;
}

}  // namespace mozilla::dom
