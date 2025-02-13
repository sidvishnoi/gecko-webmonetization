/* clang-format off */
/* -*- Mode: Objective-C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* clang-format on */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#import "mozSelectableElements.h"
#import "MacUtils.h"
#include "Accessible-inl.h"
#include "nsCocoaUtils.h"

using namespace mozilla::a11y;

@implementation mozSelectableAccessible

/**
 * Return the mozAccessibles that are selectable.
 */
- (NSArray*)selectableChildren {
  return [[self moxUnignoredChildren]
      filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(
                                                   mozAccessible* child,
                                                   NSDictionary* bindings) {
        return [child isKindOfClass:[mozSelectableChildAccessible class]];
      }]];
}

- (void)moxSetSelectedChildren:(NSArray*)selectedChildren {
  for (id child in [self selectableChildren]) {
    BOOL selected =
        [selectedChildren indexOfObjectIdenticalTo:child] != NSNotFound;
    [child moxSetSelected:@(selected)];
  }
}

/**
 * Return the mozAccessibles that are actually selected.
 */
- (NSArray*)moxSelectedChildren {
  return [[self moxUnignoredChildren]
      filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(
                                                   mozAccessible* child,
                                                   NSDictionary* bindings) {
        // Return mozSelectableChildAccessibles that have are selected (truthy
        // value).
        return [child isKindOfClass:[mozSelectableChildAccessible class]] &&
               [[(mozSelectableChildAccessible*)child moxSelected] boolValue];
      }]];
}

@end

@implementation mozSelectableChildAccessible

- (NSNumber*)moxSelected {
  return @([self stateWithMask:states::SELECTED] != 0);
}

- (void)moxSetSelected:(NSNumber*)selected {
  // Get SELECTABLE and UNAVAILABLE state.
  uint64_t state =
      [self stateWithMask:(states::SELECTABLE | states::UNAVAILABLE)];
  if ((state & states::SELECTABLE) == 0 || (state & states::UNAVAILABLE) != 0) {
    // The object is either not selectable or is unavailable. Don't do anything.
    return;
  }

  if (Accessible* acc = mGeckoAccessible.AsAccessible()) {
    acc->SetSelected([selected boolValue]);
  } else {
    mGeckoAccessible.AsProxy()->SetSelected([selected boolValue]);
  }

  // We need to invalidate the state because the accessibility service
  // may check the selected attribute synchornously and not wait for
  // selection events.
  [self invalidateState];
}

@end

@implementation mozTabGroupAccessible

- (NSArray*)moxTabs {
  return [self selectableChildren];
}

- (NSArray*)moxContents {
  return [self moxUnignoredChildren];
}

- (id)moxValue {
  // The value of a tab group is its selected child. In the case
  // of multiple selections this will return the first one.
  return [[self moxSelectedChildren] firstObject];
}

@end

@implementation mozTabAccessible

- (NSString*)moxRoleDescription {
  return utils::LocalizedString(u"tab"_ns);
}

- (id)moxValue {
  // Retuens 1 if item is selected, 0 if not.
  return [self moxSelected];
}

@end

@implementation mozListboxAccessible

- (BOOL)moxIgnoreChild:(mozAccessible*)child {
  if (!child || child->mRole == roles::GROUPING) {
    return YES;
  }

  return [super moxIgnoreChild:child];
}

- (BOOL)disableChild:(mozAccessible*)child {
  return ![child isKindOfClass:[mozSelectableChildAccessible class]];
}

- (NSString*)moxOrientation {
  return NSAccessibilityUnknownOrientationValue;
}

@end

@implementation mozOptionAccessible

- (NSString*)moxTitle {
  return @"";
}

- (id)moxValue {
  // Swap title and value of option so it behaves more like a AXStaticText.
  return [super moxTitle];
}

@end

@implementation mozMenuAccessible

- (NSString*)moxTitle {
  return @"";
}

- (NSString*)moxLabel {
  return @"";
}

- (NSArray*)moxChildren {
  // We differ from Webkit and Apple-native menus here; they expose
  // all children regardless of whether or not the menu is open.
  // In testing, VoiceOver doesn't seem to actually care what happens
  // here as long as AXVisibleChildren is exposed correctly, so
  // we expose children only when the menu is open to avoid
  // changing ignoreWithParent/ignoreChild and/or isAccessibilityElement
  if (mIsOpened) {
    return [super moxChildren];
  }
  return nil;
}

- (NSArray*)moxVisibleChildren {
  // VO expects us to expose two lists of children on menus: all children
  // (done above in moxChildren), and children which are visible (here).
  // In our code, these are essentially the same list, since at the time of
  // wiritng we filter for visibility in isAccessibilityElement before
  // passing anything to VO.
  return [[self moxChildren]
      filteredArrayUsingPredicate:[NSPredicate predicateWithBlock:^BOOL(
                                                   mozAccessible* child,
                                                   NSDictionary* bindings) {
        if (Accessible* acc = [child geckoAccessible].AsAccessible()) {
          if (acc->IsContent() && acc->GetContent()->IsXULElement()) {
            return ((acc->VisibilityState() & states::INVISIBLE) == 0);
          }
        }
        return true;
      }]];
}

- (id)moxTitleUIElement {
  id parent = [self moxUnignoredParent];
  if ([parent isKindOfClass:[mozAccessible class]] &&
      [parent geckoAccessible].Role() == roles::PARENT_MENUITEM) {
    return parent;
  }

  return nil;
}

- (void)moxPostNotification:(NSString*)notification {
  [super moxPostNotification:notification];

  if ([notification isEqualToString:@"AXMenuOpened"]) {
    mIsOpened = YES;
  } else if ([notification isEqualToString:@"AXMenuClosed"]) {
    mIsOpened = NO;
  }
}

- (void)expire {
  if (mIsOpened) {
    // VO needs to receive a menu closed event when the menu goes away.
    // If the menu is being destroyed, send a menu closed event first.
    [self moxPostNotification:@"AXMenuClosed"];
  }

  [super expire];
}

@end

@implementation mozMenuItemAccessible

- (NSString*)moxLabel {
  return @"";
}

- (NSString*)moxMenuItemMarkChar {
  Accessible* acc = mGeckoAccessible.AsAccessible();
  if (acc && acc->IsContent() &&
      acc->GetContent()->IsXULElement(nsGkAtoms::menuitem)) {
    // We need to provide a marker character. This is the visible "√" you see
    // on dropdown menus. In our a11y tree this is a single child text node
    // of the menu item.
    // We do this only with XUL menuitems that conform to the native theme, and
    // not with aria menu items that might have a pseudo element or something.
    if (acc->ChildCount() == 1 &&
        acc->FirstChild()->Role() == roles::STATICTEXT) {
      nsAutoString marker;
      acc->FirstChild()->Name(marker);
      if (marker.Length() == 1) {
        return nsCocoaUtils::ToNSString(marker);
      }
    }
  }

  return nil;
}

- (NSNumber*)moxSelected {
  // Our focused state is equivelent to native selected states for menus.
  return @([self stateWithMask:states::FOCUSED] != 0);
}

- (void)handleAccessibleEvent:(uint32_t)eventType {
  switch (eventType) {
    case nsIAccessibleEvent::EVENT_FOCUS:
      // Our focused state is equivelent to native selected states for menus.
      mozAccessible* parent = (mozAccessible*)[self moxUnignoredParent];
      [parent moxPostNotification:
                  NSAccessibilitySelectedChildrenChangedNotification];
      break;
  }

  [super handleAccessibleEvent:eventType];
}

@end
