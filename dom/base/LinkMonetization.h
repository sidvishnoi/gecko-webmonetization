/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef mozilla_dom_LinkMonetization_h
#define mozilla_dom_LinkMonetization_h

#include "mozilla/RefPtr.h"
#include "nsINode.h"
#include "mozilla/Attributes.h"
#include "mozilla/Result.h"
#include "mozilla/Unused.h"
#include "nsISupports.h"
#include "nsTArray.h"
#include "mozilla/dom/nsIMonetizationLoaderObserver.h"

class nsIContent;
class nsIPrincipal;
class nsIURI;

namespace mozilla::dom {

class Monetization : public nsIMonetizationLoaderObserver {
 public:
  Monetization() = default;

  bool IsComplete() { return false; }
  void RemoveMonetization(Monetization&){};
  void SetOwningNode(nsINode* aOwningNode) {}
  nsIURI* GetMonetizationURI() const { return nullptr; }

  NS_DECL_CYCLE_COLLECTING_ISUPPORTS
  NS_DECL_CYCLE_COLLECTION_SCRIPT_HOLDER_CLASS(Monetization)

 protected:
  static void Traverse(nsCycleCollectionTraversalCallback& cb) {}
  static void Unlink() {}

  ~Monetization() = default;
};

class Document;

class LinkMonetization {
 public:
  enum class Completed : uint8_t {
    No,
    Yes,
  };

  struct Update {
   private:
    bool mWillNotify;

   public:
    Update() : mWillNotify(false) {}

    Update(Completed aCompleted) : mWillNotify(aCompleted == Completed::No) {}

    bool WillNotify() const { return mWillNotify; }
  };

  static LinkMonetization* FromNode(nsINode& aNode) {
    return aNode.AsLinkMonetization();
  }
  static const LinkMonetization* FromNode(const nsINode& aNode) {
    return aNode.AsLinkMonetization();
  }

  static LinkMonetization* FromNodeOrNull(nsINode* aNode) {
    return aNode ? FromNode(*aNode) : nullptr;
  }

  static const LinkMonetization* FromNodeOrNull(const nsINode* aNode) {
    return aNode ? FromNode(*aNode) : nullptr;
  }

  void UpdateMonetizationInternal() {
    Unused << UpdateMonetizationInternal(nullptr);
  }

  struct MOZ_STACK_CLASS MonetizationInfo {
    nsIContent* mContent;
    // FIXME(emilio): do these really need to be strong refs?
    nsCOMPtr<nsIURI> mURI;

    // The principal of the scripted caller that initiated the load, if
    // available. Otherwise null.
    nsCOMPtr<nsIPrincipal> mTriggeringPrincipal;

    MonetizationInfo(const mozilla::dom::Document&,
                     already_AddRefed<nsIURI> aURI,
                     already_AddRefed<nsIPrincipal> aTriggeringPrincipal);

    ~MonetizationInfo();
  };

  virtual nsIContent& AsContent() = 0;
  virtual Maybe<MonetizationInfo> GetMonetizationInfo() = 0;

  /**
   * Used to make the association between a monetization and the element that
   * linked it to the document.
   *
   * @param aMonetization the monetization associated with this element.
   */
  void SetMonetization(Monetization* aMonetization);

  /**
   * Tells this element to update the monetization.
   *
   * @param aObserver    observer to notify once the monetization is loaded.
   *                     This will be passed to the CSSLoader
   */
  Result<Update, nsresult> UpdateMonetization(nsIMonetizationLoaderObserver*);

  /**
   * Tells this element whether to update the monetization when the
   * element's properties change.
   *
   * @param aEnableUpdates update on changes or not.
   */
  void SetEnableUpdates(bool aEnableUpdates) {
    mUpdatesEnabled = aEnableUpdates;
  }

  // This doesn't entirely belong here since they only make sense for
  // some types of linking elements, but it's a better place than
  // anywhere else.
  void SetLineNumber(uint32_t aLineNumber) { mLineNumber = aLineNumber; }

  /**
   * Get the line number, as previously set by SetLineNumber.
   *
   * @return the line number of this element; or 1 if no line number
   *         was set
   */
  uint32_t GetLineNumber() const { return mLineNumber; }

  // This doesn't entirely belong here since they only make sense for
  // some types of linking elements, but it's a better place than
  // anywhere else.
  void SetColumnNumber(uint32_t aColumnNumber) {
    mColumnNumber = aColumnNumber;
  }

  /**
   * Get the column number, as previously set by SetColumnNumber.
   *
   * @return the column number of this element; or 1 if no column number
   *         was set
   */
  uint32_t GetColumnNumber() const { return mColumnNumber; }

  Monetization* GetMonetization() const { return nullptr; }

  /** JS can only observe the monetization once fully loaded */
  Monetization* GetMonetizationForBindings() const;

 protected:
  LinkMonetization();
  virtual ~LinkMonetization();

  // CC methods
  void Unlink();
  void Traverse(nsCycleCollectionTraversalCallback& cb);

  /**
   * @param aOldDocument   should be non-null only if we're updating because we
   *                       removed the node from the document.
   * @param aForceUpdate true will force the update even if the URI has not
   *                     changed.  This should be used in cases when something
   *                     about the content that affects the resulting
   * monetization changed but the URI may not have changed.
   *
   * TODO(emilio): Should probably pass a single DocumentOrShadowRoot.
   */
  Result<Update, nsresult> UpdateMonetizationInternal(
      Document* aOldDocument, bool afalseUpdate = false);

  /**
   * @param aOldDocument should be non-null only if we're updating because we
   *                     removed the node from the document.
   * @param aForceUpdate true will force the update even if the URI has not
   *                     changed.  This should be used in cases when something
   *                     about the content that affects the resulting
   * monetization changed but the URI may not have changed.
   */
  Result<Update, nsresult> DoUpdateMonetization(Document* aOldDocument,
                                                nsIMonetizationLoaderObserver*,
                                                bool afalseUpdate);

  RefPtr<Monetization> mMonetization;
  nsCOMPtr<nsIPrincipal> mTriggeringPrincipal;
  bool mUpdatesEnabled;
  uint32_t mLineNumber;
  uint32_t mColumnNumber;
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_LinkMonetization_h
