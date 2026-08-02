# SPOKE — Hyperlocal Delivery (Vanilla JS)

Shops book deliveries, riders fulfill them, admin coordinates. Pure HTML/CSS/JS
— no build step, no framework, no bundler. Deployable straight to GitHub
Pages. Firebase (Auth, Firestore, Storage) via CDN ESM imports.

## Why so few files

**4 files total:**

| File | Responsibility |
|---|---|
| `index.html` | entry point — fonts, manifest link, `#root` mount point, loads `app.js` as an ES module |
| `styles.css` | every design token and component style (ink-navy / route-orange design system, dark mode included) |
| `app.js` | **everything else**: Firebase init, constants (roles/statuses/collections/views), the Firestore data layer, business logic (delivery state machine, ledger math, validators), and every screen in the app |
| `manifest.json` | PWA manifest (must be a separate file — browsers require this) |

Compared to the 12-file Next.js/React version this was converted from, `app.js`
folds `lib/constants.js` + `lib/firebase.js` + `lib/workflow.js` +
`components/ui.js` + `components/views.js` + `app/page.js` into one file,
since there's no component tree or JSX to keep physically separate anymore —
it's organized into the same logical sections instead (see the numbered
comment headers inside `app.js`).

**How navigation works:** there's no router and no React. `app.js` keeps a
tiny `currentView` string and a `renderRoot()` function that tears down the
previous screen's Firestore listeners, then mounts the next screen's HTML +
event listeners directly into `#root`. Forms are uncontrolled (values read
from the DOM on submit, not tracked in JS state on every keystroke) so typing
never triggers a re-render or loses focus. Lists (deliveries, shops, riders)
re-render only their own container when filtered or when a Firestore
`onSnapshot` fires — the search box and filters around them are untouched.

## Setup

1. Create a Firebase project → enable **Authentication (Email/Password)**,
   **Cloud Firestore**, **Cloud Storage**.
2. Open `app.js` and fill in `firebaseConfig` near the top with your web
   app's config (Console → Project Settings → General → Your apps). Safe to
   commit publicly — real access control is in the Firestore/Storage rules
   below.
3. Deploy the security rules below (Firebase Console → Firestore/Storage →
   Rules, or `firebase deploy --only firestore:rules,storage:rules` with them
   saved as `firestore.rules` / `storage.rules`).
4. Seed initial data:
   - `settings/global` → `{ deliveryPrice: 12 }`
   - Your first admin: create the Auth user, then a matching `users/{uid}`
     doc → `{ role: "admin", displayName: "...", active: true }`
5. Open `index.html` directly, or serve the folder with any static file
   server (e.g. `npx serve .`), or push it to a GitHub Pages branch.
6. Optional: add `icon-192.png` and `icon-512.png` next to `manifest.json` for
   full PWA install icons (referenced by `manifest.json` but not included
   here).

## Creating shops and riders

As admin: **Shops → Create Shop** / **Riders → Create Rider** creates the
Firestore doc. You then manually create the matching Firebase Auth user +
`users/{uid}` doc with `role` and `linkedId` pointing at that shop/rider —
intentional for now; self-serve signup is a straightforward addition later.

## Extension points

- **Automatic rider assignment**: replace the manual picker in
  `openAssignModal` (`app.js`) with a Cloud Function trigger on delivery
  creation, calling `Riders.getAvailable()`.
- **Maps / GPS / distance pricing**: `getCurrentDeliveryPrice()` is the one
  place delivery price is read — extend it to accept distance without
  touching any view.
- **Push notifications**: every status transition already writes to
  `activityLog` — hook a Cloud Function off those writes to trigger FCM.
- **Customer tracking / OTP / QR verification**: deliveries already carry
  `customerPhone`; a public read-only tracking page can query a single
  delivery doc without needing the shop/rider/admin auth flow.

## Firestore rules (`firestore.rules`)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isSignedIn() { return request.auth != null; }
    function myProfile() { return get(/databases/$(database)/documents/users/$(request.auth.uid)).data; }
    function myRole() { return myProfile().role; }
    function isAdmin() { return isSignedIn() && myRole() == 'admin'; }
    function isShop() { return isSignedIn() && myRole() == 'shop'; }
    function isRider() { return isSignedIn() && myRole() == 'rider'; }
    function isOwnShop(shopId) { return isShop() && myProfile().linkedId == shopId; }
    function isOwnRider(riderId) { return isRider() && myProfile().linkedId == riderId; }

    match /users/{uid} {
      allow read: if isSignedIn() && (request.auth.uid == uid || isAdmin());
      allow write: if isAdmin();
    }
    match /shops/{shopId} {
      allow read: if isAdmin() || isOwnShop(shopId) || isRider();
      allow create, update, delete: if isAdmin();
    }
    match /riders/{riderId} {
      allow read: if isAdmin() || isOwnRider(riderId) || isShop();
      allow update: if isAdmin() || (isOwnRider(riderId) &&
        request.resource.data.diff(resource.data).affectedKeys()
          .hasOnly(['online', 'currentDeliveryCount', 'completedCount', 'updatedAt']));
      allow create, delete: if isAdmin();
    }
    match /deliveries/{deliveryId} {
      allow read: if isAdmin() ||
        (isShop() && resource.data.shopId == myProfile().linkedId) ||
        (isRider() && resource.data.riderId == myProfile().linkedId);
      allow create: if isAdmin() ||
        (isShop() && request.resource.data.shopId == myProfile().linkedId &&
         request.resource.data.status == 'pending');
      allow update: if isAdmin() ||
        (isRider() && resource.data.riderId == myProfile().linkedId &&
         request.resource.data.shopId == resource.data.shopId &&
         request.resource.data.cashToCollect == resource.data.cashToCollect);
      allow delete: if isAdmin();
    }
    match /ledger/{entryId} {
      allow read: if isAdmin() || (isShop() && resource.data.shopId == myProfile().linkedId);
      allow create: if isAdmin() || isRider();
      allow update, delete: if false;
    }
    match /payments/{paymentId} {
      allow read: if isAdmin() || (isShop() && resource.data.shopId == myProfile().linkedId);
      allow create, update: if isAdmin();
      allow delete: if false;
    }
    match /settings/{settingId} {
      allow read: if isSignedIn();
      allow write: if isAdmin();
    }
    match /activityLog/{logId} {
      allow read: if isAdmin();
      allow create: if isSignedIn();
      allow update, delete: if false;
    }
  }
}
```

## Storage rules (`storage.rules`)

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    function isSignedIn() { return request.auth != null; }
    match /proof-photos/{deliveryId}/{fileName} {
      allow read: if isSignedIn();
      allow write: if isSignedIn() &&
        request.resource.size < 5 * 1024 * 1024 &&
        request.resource.contentType.matches('image/.*');
    }
  }
}
```
