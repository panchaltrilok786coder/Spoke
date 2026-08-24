/**
 * app.js — the entire SPOKE client app, in one file.
 *
 * Sections (mirrors the original file grouping, just consolidated further
 * since there's no bundler / component tree to split across):
 *   1. Firebase SDK init
 *   2. CONST — every enum: roles, statuses, collections, in-app views
 *   3. Data layer — auth + one grouped repository object per collection
 *   4. Workflow — validators, ledger math, the delivery state machine,
 *      display formatters (the SOLE authority for status transitions)
 *   5. Tiny DOM/render helpers, Toasts, Modals, UI primitives
 *   6. Page shell (bottom nav for shop/rider, sidebar for admin)
 *   7. Views — Login, and every shop/rider/admin screen
 *   8. Router + boot
 *
 * Navigation between screens is our own lightweight client-side state
 * (see VIEWS below), not URL-based routing — this keeps the app installable
 * as a single-page PWA with no build step, deployable straight to GitHub
 * Pages. Refreshing always lands you back on your role's dashboard.
 */

// ===========================================================================
// 1. Firebase SDK init — only this section talks to the Firebase SDK.
// ===========================================================================
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  getDoc, getDocs, query, where, orderBy, limit as fbLimit,
  onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js";

/**
 * TODO: replace with your Firebase project's config (Console → Project
 * Settings → General → Your apps). Safe to expose publicly — real access
 * control lives in the Firestore/Storage security rules, not here.
 */
const firebaseConfig = {
  apiKey: "AIzaSyAhkPRMTP5vtUJmqoHKzILw_H07wNiB3JQ",
  authDomain: "spoke-3ae5c.firebaseapp.com",
  projectId: "spoke-3ae5c",
  storageBucket: "spoke-3ae5c.firebasestorage.app",
  messagingSenderId: "884215384881",
  appId: "1:884215384881:web:16243e9ea7e9eb55d57e10",
  measurementId: "G-DQGMVR5KLS"
};

const fbApp = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const storage = getStorage(fbApp);

// ===========================================================================
// 2. CONST
// ===========================================================================

const ROLES = Object.freeze({ ADMIN: "admin", SHOP: "shop", RIDER: "rider" });

const COLLECTIONS = Object.freeze({
  USERS: "users",
  SHOPS: "shops",
  RIDERS: "riders",
  DELIVERIES: "deliveries",
  LEDGER: "ledger",
  PAYMENTS: "payments",
  SETTINGS: "settings",
  ACTIVITY_LOG: "activityLog",
});
const SETTINGS_DOC_ID = "global";

const DELIVERY_STATUS = Object.freeze({
  PENDING: "pending",
  ASSIGNED: "assigned",
  ACCEPTED: "accepted",
  PICKED_UP: "picked_up",
  OUT_FOR_DELIVERY: "out_for_delivery",
  DELIVERED: "delivered",
  FAILED: "failed",
});

// Forward-only order — index comparison enforces "no backwards moves".
const STATUS_ORDER = [
  DELIVERY_STATUS.PENDING,
  DELIVERY_STATUS.ASSIGNED,
  DELIVERY_STATUS.ACCEPTED,
  DELIVERY_STATUS.PICKED_UP,
  DELIVERY_STATUS.OUT_FOR_DELIVERY,
  DELIVERY_STATUS.DELIVERED,
];
const TERMINAL_STATUSES = [DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.FAILED];

const FAILURE_REASONS = [
  "Customer unavailable",
  "Wrong address",
  "Customer refused",
  "Package issue",
  "Other",
];

const STATUS_LABELS = {
  [DELIVERY_STATUS.PENDING]: "Pending",
  [DELIVERY_STATUS.ASSIGNED]: "Assigned",
  [DELIVERY_STATUS.ACCEPTED]: "Accepted",
  [DELIVERY_STATUS.PICKED_UP]: "Picked Up",
  [DELIVERY_STATUS.OUT_FOR_DELIVERY]: "Out for Delivery",
  [DELIVERY_STATUS.DELIVERED]: "Delivered",
  [DELIVERY_STATUS.FAILED]: "Failed",
};

const STATUS_COLORS = {
  [DELIVERY_STATUS.PENDING]: "neutral",
  [DELIVERY_STATUS.ASSIGNED]: "info",
  [DELIVERY_STATUS.ACCEPTED]: "info",
  [DELIVERY_STATUS.PICKED_UP]: "warning",
  [DELIVERY_STATUS.OUT_FOR_DELIVERY]: "warning",
  [DELIVERY_STATUS.DELIVERED]: "success",
  [DELIVERY_STATUS.FAILED]: "danger",
};

// In-app "views" — our own lightweight client-side navigation.
const VIEWS = Object.freeze({
  SHOP_DASHBOARD: "shop.dashboard",
  SHOP_BOOK: "shop.book",
  SHOP_DELIVERIES: "shop.deliveries",
  SHOP_LEDGER: "shop.ledger",
  SHOP_PROFILE: "shop.profile",

  RIDER_DASHBOARD: "rider.dashboard",
  RIDER_ASSIGNED: "rider.assigned",
  RIDER_ACCEPTED: "rider.accepted",

  ADMIN_DASHBOARD: "admin.dashboard",
  ADMIN_SHOPS: "admin.shops",
  ADMIN_RIDERS: "admin.riders",
  ADMIN_DELIVERIES: "admin.deliveries",
  ADMIN_LEDGER: "admin.ledger",
  ADMIN_SETTINGS: "admin.settings",
});

const DEFAULT_VIEW_BY_ROLE = {
  [ROLES.SHOP]: VIEWS.SHOP_DASHBOARD,
  [ROLES.RIDER]: VIEWS.RIDER_DASHBOARD,
  [ROLES.ADMIN]: VIEWS.ADMIN_DASHBOARD,
};

const NAV_ITEMS_BY_ROLE = {
  [ROLES.SHOP]: [
    { view: VIEWS.SHOP_DASHBOARD, label: "Dashboard", icon: "⌂" },
    { view: VIEWS.SHOP_BOOK, label: "Book", icon: "＋" },
    { view: VIEWS.SHOP_DELIVERIES, label: "Deliveries", icon: "▣" },
    { view: VIEWS.SHOP_LEDGER, label: "Ledger", icon: "▤" },
    { view: VIEWS.SHOP_PROFILE, label: "Profile", icon: "◉" },
  ],
  [ROLES.RIDER]: [
    { view: VIEWS.RIDER_DASHBOARD, label: "Dashboard", icon: "⌂" },
    { view: VIEWS.RIDER_ASSIGNED, label: "Assigned", icon: "▥" },
    { view: VIEWS.RIDER_ACCEPTED, label: "Accepted", icon: "✓" },
  ],
  [ROLES.ADMIN]: [
    { view: VIEWS.ADMIN_DASHBOARD, label: "Dashboard", icon: "⌂" },
    { view: VIEWS.ADMIN_SHOPS, label: "Shops", icon: "▦" },
    { view: VIEWS.ADMIN_RIDERS, label: "Riders", icon: "▲" },
    { view: VIEWS.ADMIN_DELIVERIES, label: "Deliveries", icon: "▣" },
    { view: VIEWS.ADMIN_LEDGER, label: "Ledger", icon: "▤" },
    { view: VIEWS.ADMIN_SETTINGS, label: "Settings", icon: "⚙" },
  ],
};

const TITLE_BY_VIEW = {
  [VIEWS.SHOP_DASHBOARD]: "Dashboard", [VIEWS.SHOP_BOOK]: "Book Delivery", [VIEWS.SHOP_DELIVERIES]: "My Deliveries",
  [VIEWS.SHOP_LEDGER]: "Ledger", [VIEWS.SHOP_PROFILE]: "Profile",
  [VIEWS.RIDER_DASHBOARD]: "Dashboard", [VIEWS.RIDER_ASSIGNED]: "Assigned Deliveries", [VIEWS.RIDER_ACCEPTED]: "Accepted Deliveries",
  [VIEWS.ADMIN_DASHBOARD]: "Dashboard", [VIEWS.ADMIN_SHOPS]: "Shops", [VIEWS.ADMIN_RIDERS]: "Riders",
  [VIEWS.ADMIN_DELIVERIES]: "Deliveries", [VIEWS.ADMIN_LEDGER]: "Ledger", [VIEWS.ADMIN_SETTINGS]: "Settings",
};

// App-wide fallback defaults (real delivery price lives in Firestore settings).
const APP_CONFIG = {
  APP_NAME: "SPOKE",
  DEFAULT_DELIVERY_PRICE_INR: 12,
  MAX_PROOF_PHOTO_SIZE_MB: 5,
  ALLOWED_PHOTO_TYPES: ["image/jpeg", "image/png", "image/webp"],
  TOAST_DURATION_MS: 3500,
};

const PACKAGE_TYPES = ["Documents", "Food", "Groceries", "Electronics", "Clothing", "Other"];
const PRIORITIES = ["Normal", "Urgent"];
const IN_PROGRESS_STATUSES = [DELIVERY_STATUS.ACCEPTED, DELIVERY_STATUS.PICKED_UP, DELIVERY_STATUS.OUT_FOR_DELIVERY];

// ===========================================================================
// 3. Data layer — auth + one grouped repository object per collection.
//    Everything else in the app imports data access from here only.
// ===========================================================================

const now = () => serverTimestamp();
const col = (name) => collection(db, name);
const ref1 = (name, id) => doc(db, name, id);
const mapSnap = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

async function getById(name, id) {
  const snap = await getDoc(ref1(name, id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}
async function getAll(name, constraints = []) {
  const snap = await getDocs(query(col(name), ...constraints));
  return mapSnap(snap);
}
async function create(name, data) {
  const docRef = await addDoc(col(name), { ...data, createdAt: now(), updatedAt: now() });
  return docRef.id;
}
async function update(name, id, data) {
  await updateDoc(ref1(name, id), { ...data, updatedAt: now() });
}
async function remove(name, id) {
  await deleteDoc(ref1(name, id));
}
function subscribe(name, constraints, onData, onError) {
  return onSnapshot(query(col(name), ...constraints), (snap) => onData(mapSnap(snap)), onError);
}

// --- Auth ---

async function login(email, password) {
  const credential = await signInWithEmailAndPassword(auth, email, password);
alert(JSON.stringify(credential));
  const profile = await getById(COLLECTIONS.USERS, credential.user.uid);
  if (!profile) {
    await signOut(auth);
    throw new Error("No profile found for this account. Contact an admin.");
  }
  if (profile.active === false) {
    await signOut(auth);
    throw new Error("This account has been deactivated.");
  }
  return { uid: credential.user.uid, email: credential.user.email, role: profile.role, profile };
}

function logout() {
  return signOut(auth);
}

/** Subscribes to Firebase's own auth state and resolves the linked profile. */
function subscribeSession(onChange) {
  return onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) return onChange(null);
    const profile = await getById(COLLECTIONS.USERS, firebaseUser.uid);
    if (!profile || profile.active === false) {
      await signOut(auth);
      return onChange(null);
    }
    onChange({ uid: firebaseUser.uid, email: firebaseUser.email, role: profile.role, profile });
  });
}

// --- Collections — grouped repository objects ---

const Users = {
  get: (uid) => getById(COLLECTIONS.USERS, uid),
  update: (uid, data) => update(COLLECTIONS.USERS, uid, data),
  getAll: () => getAll(COLLECTIONS.USERS),
};

const Shops = {
  get: (id) => getById(COLLECTIONS.SHOPS, id),
  getAll: () => getAll(COLLECTIONS.SHOPS, [orderBy("name")]),
  getActive: () => getAll(COLLECTIONS.SHOPS, [where("active", "==", true)]),
  create: (data) => create(COLLECTIONS.SHOPS, { ...data, active: true, outstandingBalance: 0 }),
  update: (id, data) => update(COLLECTIONS.SHOPS, id, data),
  deactivate: (id) => update(COLLECTIONS.SHOPS, id, { active: false }),
};

const Riders = {
  get: (id) => getById(COLLECTIONS.RIDERS, id),
  getAll: () => getAll(COLLECTIONS.RIDERS, [orderBy("name")]),
  getAvailable: () => getAll(COLLECTIONS.RIDERS, [where("active", "==", true), where("online", "==", true)]),
  create: (data) => create(COLLECTIONS.RIDERS, { ...data, active: true, online: false, currentDeliveryCount: 0, completedCount: 0 }),
  update: (id, data) => update(COLLECTIONS.RIDERS, id, data),
  deactivate: (id) => update(COLLECTIONS.RIDERS, id, { active: false, online: false }),
  setOnline: (id, online) => update(COLLECTIONS.RIDERS, id, { online }),
  subscribeOne: (id, onData, onError) => subscribe(COLLECTIONS.RIDERS, [where("__name__", "==", id)], (rows) => onData(rows[0] || null), onError),
};

const Deliveries = {
  get: (id) => getById(COLLECTIONS.DELIVERIES, id),
  create: (data) =>
    create(COLLECTIONS.DELIVERIES, {
      ...data,
      status: DELIVERY_STATUS.PENDING,
      riderId: null,
      riderName: null,
      proofPhotoUrl: null,
      failureReason: null,
      cashCollected: null,
      cashReturnedToShop: false,
      timestamps: { created: now() },
    }),
  update: (id, data) => update(COLLECTIONS.DELIVERIES, id, data),
  subscribeByShop: (shopId, onData, onError) =>
    subscribe(COLLECTIONS.DELIVERIES, [where("shopId", "==", shopId), orderBy("createdAt", "desc")], onData, onError),
  subscribeByRider: (riderId, onData, onError) =>
    subscribe(COLLECTIONS.DELIVERIES, [where("riderId", "==", riderId), orderBy("createdAt", "desc")], onData, onError),
  subscribeAll: (onData, onError) =>
    subscribe(COLLECTIONS.DELIVERIES, [orderBy("createdAt", "desc"), fbLimit(200)], onData, onError),
};

const Ledger = {
  addCharge: ({ shopId, deliveryId, amount }) => create(COLLECTIONS.LEDGER, { shopId, deliveryId, amount, type: "charge" }),
  getByShop: (shopId) => getAll(COLLECTIONS.LEDGER, [where("shopId", "==", shopId), orderBy("createdAt", "desc")]),
};

const Payments = {
  record: ({ shopId, amount, note, recordedByUid }) => create(COLLECTIONS.PAYMENTS, { shopId, amount, note: note || "", recordedByUid }),
  getByShop: (shopId) => getAll(COLLECTIONS.PAYMENTS, [where("shopId", "==", shopId), orderBy("createdAt", "desc")]),
};

const Settings = {
  get: async () => (await getById(COLLECTIONS.SETTINGS, SETTINGS_DOC_ID)) || { deliveryPrice: APP_CONFIG.DEFAULT_DELIVERY_PRICE_INR },
  update: (data) => update(COLLECTIONS.SETTINGS, SETTINGS_DOC_ID, data),
};

const ActivityLog = {
  log: ({ action, actorUid, actorRole, entityType, entityId, details = {} }) =>
    create(COLLECTIONS.ACTIVITY_LOG, { action, actorUid, actorRole, entityType, entityId, details }),
};

// --- Storage — proof-of-delivery photos ---

async function uploadProofPhoto(deliveryId, file) {
  if (!APP_CONFIG.ALLOWED_PHOTO_TYPES.includes(file.type)) {
    throw new Error("Unsupported file type. Please upload a JPEG, PNG, or WEBP image.");
  }
  if (file.size > APP_CONFIG.MAX_PROOF_PHOTO_SIZE_MB * 1024 * 1024) {
    throw new Error(`Photo must be under ${APP_CONFIG.MAX_PROOF_PHOTO_SIZE_MB}MB.`);
  }
  const storageRef = ref(storage, `proof-photos/${deliveryId}/${Date.now()}-${file.name}`);
  await uploadBytes(storageRef, file);
  return getDownloadURL(storageRef);
}

// ===========================================================================
// 4. Workflow — business logic, kept separate from the DOM and from the
//    Firestore access layer above for testability.
// ===========================================================================

// --- Validators — pure functions, no side effects ---

function validateDeliveryInput(input) {
  const errors = {};
  if (!input.customerName?.trim()) errors.customerName = "Customer name is required.";
  if (!input.customerPhone?.trim()) {
    errors.customerPhone = "Customer phone is required.";
  } else if (!/^\d{10}$/.test(input.customerPhone.replace(/\D/g, ""))) {
    errors.customerPhone = "Enter a valid 10-digit phone number.";
  }
  if (!input.address?.trim()) errors.address = "Delivery address is required.";
  if (!input.packageType?.trim()) errors.packageType = "Package type is required.";
  if (!input.priority?.trim()) errors.priority = "Priority is required.";
  if (input.cashToCollect) {
    const amount = Number(input.cashToCollect);
    if (Number.isNaN(amount) || amount < 0) errors.cashToCollect = "Cash to collect must be a positive number.";
  }
  return { isValid: Object.keys(errors).length === 0, errors };
}

function validateShopInput(input) {
  const errors = {};
  if (!input.name?.trim()) errors.name = "Shop name is required.";
  if (!input.phone?.trim()) errors.phone = "Phone number is required.";
  if (!input.address?.trim()) errors.address = "Address is required.";
  if (input.openingTime && input.closingTime && input.openingTime >= input.closingTime) {
    errors.closingTime = "Closing time must be after opening time.";
  }
  return { isValid: Object.keys(errors).length === 0, errors };
}

function validateRiderInput(input) {
  const errors = {};
  if (!input.name?.trim()) errors.name = "Rider name is required.";
  if (!input.phone?.trim()) {
    errors.phone = "Phone number is required.";
  } else if (!/^\d{10}$/.test(input.phone.replace(/\D/g, ""))) {
    errors.phone = "Enter a valid 10-digit phone number.";
  }
  return { isValid: Object.keys(errors).length === 0, errors };
}

// --- Ledger math ---

async function getCurrentDeliveryPrice() {
  const settings = await Settings.get();
  return settings.deliveryPrice;
}

function calculateOutstandingBalance(ledgerEntries, payments) {
  const totalCharges = ledgerEntries.reduce((sum, e) => sum + (e.amount || 0), 0);
  const totalPayments = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
  return totalCharges - totalPayments;
}

// --- Delivery state machine — the SOLE authority for status transitions.
// Every status change in the UI must go through one of these functions,
// never a direct Deliveries.update() call — this guarantees "delivery
// cannot move backwards" and that ledger entries are created exactly once.

function assertForwardTransition(currentStatus, nextStatus) {
  if (nextStatus === DELIVERY_STATUS.FAILED) {
    if (TERMINAL_STATUSES.includes(currentStatus)) {
      throw new Error(`Cannot mark a ${currentStatus} delivery as failed.`);
    }
    return;
  }
  const currentIndex = STATUS_ORDER.indexOf(currentStatus);
  const nextIndex = STATUS_ORDER.indexOf(nextStatus);
  if (nextIndex <= currentIndex) {
    throw new Error(`Invalid transition: ${currentStatus} → ${nextStatus}. Deliveries cannot move backwards.`);
  }
}

async function assignRider(deliveryId, rider, actorUid) {
  const delivery = await Deliveries.get(deliveryId);
  assertForwardTransition(delivery.status, DELIVERY_STATUS.ASSIGNED);
  await Deliveries.update(deliveryId, {
    status: DELIVERY_STATUS.ASSIGNED, riderId: rider.id, riderName: rider.name,
    "timestamps.assigned": new Date(),
  });
  await Riders.update(rider.id, { currentDeliveryCount: (rider.currentDeliveryCount || 0) + 1 });
  await ActivityLog.log({ action: "Assigned", actorUid, actorRole: "admin", entityType: "delivery", entityId: deliveryId, details: { riderId: rider.id } });
}

async function acceptDelivery(deliveryId, actorUid) {
  const delivery = await Deliveries.get(deliveryId);
  assertForwardTransition(delivery.status, DELIVERY_STATUS.ACCEPTED);
  await Deliveries.update(deliveryId, { status: DELIVERY_STATUS.ACCEPTED, "timestamps.accepted": new Date() });
  await ActivityLog.log({ action: "Accepted", actorUid, actorRole: "rider", entityType: "delivery", entityId: deliveryId });
}

async function acceptMultipleDeliveries(deliveryIds, actorUid) {
  const results = await Promise.allSettled(deliveryIds.map((id) => acceptDelivery(id, actorUid)));
  const failedIds = results.map((r, i) => (r.status === "rejected" ? deliveryIds[i] : null)).filter(Boolean);
  return { succeeded: deliveryIds.length - failedIds.length, failedIds };
}

async function markPickedUp(deliveryId, actorUid) {
  const delivery = await Deliveries.get(deliveryId);
  assertForwardTransition(delivery.status, DELIVERY_STATUS.PICKED_UP);
  await Deliveries.update(deliveryId, { status: DELIVERY_STATUS.PICKED_UP, "timestamps.pickedUp": new Date() });
  await ActivityLog.log({ action: "Picked Up", actorUid, actorRole: "rider", entityType: "delivery", entityId: deliveryId });
}

async function markOutForDelivery(deliveryId, actorUid) {
  const delivery = await Deliveries.get(deliveryId);
  assertForwardTransition(delivery.status, DELIVERY_STATUS.OUT_FOR_DELIVERY);
  await Deliveries.update(deliveryId, { status: DELIVERY_STATUS.OUT_FOR_DELIVERY });
  await ActivityLog.log({ action: "Out for Delivery", actorUid, actorRole: "rider", entityType: "delivery", entityId: deliveryId });
}

async function markDelivered(deliveryId, { proofPhotoUrl, cashCollected }, actorUid) {
  if (!proofPhotoUrl) throw new Error("A proof of delivery photo is required.");
  const delivery = await Deliveries.get(deliveryId);
  assertForwardTransition(delivery.status, DELIVERY_STATUS.DELIVERED);

  const deliveryCharge = await getCurrentDeliveryPrice();
  await Deliveries.update(deliveryId, {
    status: DELIVERY_STATUS.DELIVERED, proofPhotoUrl, cashCollected: cashCollected ?? null,
    deliveryCharge, "timestamps.delivered": new Date(),
  });
  await Ledger.addCharge({ shopId: delivery.shopId, deliveryId, amount: deliveryCharge });

  if (delivery.riderId) {
    const rider = await Riders.get(delivery.riderId);
    if (rider) {
      await Riders.update(delivery.riderId, {
        currentDeliveryCount: Math.max(0, (rider.currentDeliveryCount || 1) - 1),
        completedCount: (rider.completedCount || 0) + 1,
      });
    }
  }
  await ActivityLog.log({ action: "Delivered", actorUid, actorRole: "rider", entityType: "delivery", entityId: deliveryId, details: { deliveryCharge } });
  await ActivityLog.log({ action: "Ledger Added", actorUid, actorRole: "system", entityType: "delivery", entityId: deliveryId, details: { amount: deliveryCharge } });
}

async function markFailed(deliveryId, reason, actorUid) {
  if (!reason?.trim()) throw new Error("A failure reason is required.");
  const delivery = await Deliveries.get(deliveryId);
  assertForwardTransition(delivery.status, DELIVERY_STATUS.FAILED);
  await Deliveries.update(deliveryId, { status: DELIVERY_STATUS.FAILED, failureReason: reason });

  if (delivery.riderId) {
    const rider = await Riders.get(delivery.riderId);
    if (rider) {
      await Riders.update(delivery.riderId, { currentDeliveryCount: Math.max(0, (rider.currentDeliveryCount || 1) - 1) });
    }
  }
  await ActivityLog.log({ action: "Failed", actorUid, actorRole: "rider", entityType: "delivery", entityId: deliveryId, details: { reason } });
}

// --- Small display helpers used across views ---

function formatCurrency(amount) {
  return `₹${(Number(amount) || 0).toLocaleString("en-IN")}`;
}
function formatDeliveryId(id) {
  return id ? `#${id.slice(-6).toUpperCase()}` : "—";
}
function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  return new Date(value);
}
function formatDateTime(value) {
  const d = toDate(value);
  return d ? d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
}
function isToday(value) {
  const d = toDate(value);
  if (!d) return false;
  const n = new Date();
  return d.getDate() === n.getDate() && d.getMonth() === n.getMonth() && d.getFullYear() === n.getFullYear();
}

// ===========================================================================
// 5. Tiny DOM/render helpers, Toasts, Modals, UI primitives
// ===========================================================================

const esc = (str) => String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const qs = (root, sel) => root.querySelector(sel);
const qsa = (root, sel) => Array.from(root.querySelectorAll(sel));
const on = (el, evt, sel, handler) => {
  el.addEventListener(evt, (e) => {
    const target = e.target.closest(sel);
    if (target && el.contains(target)) handler(e, target);
  });
};

// --- Toasts ---
let toastTimer = null;
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  container.innerHTML = `<div class="toast toast-${esc(type)}">${esc(message)}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { container.innerHTML = ""; }, APP_CONFIG.TOAST_DURATION_MS);
}

// --- Primitives (HTML-string generators) ---

function buttonHtml({ label, variant = "primary", disabled = false, fullWidth = false, attrs = "", type = "button" }) {
  return `<button type="${type}" class="btn btn-${variant} ${fullWidth ? "btn-full" : ""}" ${disabled ? "disabled" : ""} ${attrs}>${esc(label)}</button>`;
}

function statusBadgeHtml(status) {
  return `<span class="badge badge-${STATUS_COLORS[status] || "neutral"}">${esc(STATUS_LABELS[status] || status)}</span>`;
}

function skeletonHtml(rows = 3) {
  return `<div class="skeleton-loader">${"<div class=\"skeleton-line\"></div>".repeat(rows)}</div>`;
}

function emptyStateHtml(message, actionLabel, actionAttr) {
  return `<div class="empty-state"><p>${esc(message)}</p>${actionLabel ? buttonHtml({ label: actionLabel, variant: "secondary", attrs: actionAttr || "" }) : ""}</div>`;
}

function formFieldHtml({ label, name, type = "text", value = "", options, placeholder = "" }) {
  const id = `field-${name}`;
  let control;
  if (type === "select") {
    control = `<select class="form-input" id="${id}" name="${name}">
      ${options.map((o) => `<option value="${esc(o.value)}" ${o.value === value ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
    </select>`;
  } else if (type === "textarea") {
    control = `<textarea class="form-input" id="${id}" name="${name}" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`;
  } else {
    control = `<input class="form-input" id="${id}" name="${name}" type="${type}" placeholder="${esc(placeholder)}" value="${esc(value)}" />`;
  }
  return `<div class="form-field">
    <label class="form-label" for="${id}">${esc(label)}</label>
    ${control}
    <span class="form-error" data-error-for="${name}"></span>
  </div>`;
}

/** Reads all named fields out of a form-ish container (uncontrolled inputs). */
function readForm(container, names) {
  const values = {};
  for (const name of names) {
    const el = container.querySelector(`[name="${name}"]`);
    values[name] = el ? el.value : "";
  }
  return values;
}

/** Writes validation errors into the matching `data-error-for` spans. */
function applyFormErrors(container, errors) {
  qsa(container, "[data-error-for]").forEach((span) => { span.textContent = ""; });
  Object.entries(errors).forEach(([field, message]) => {
    const span = container.querySelector(`[data-error-for="${field}"]`);
    if (span) span.textContent = message;
  });
}

/** Generic modal shell. Returns a close() function. */
function openModal(title, bodyHtml, onMount) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-dialog">
      <div class="modal-header">
        <h3 class="modal-title">${esc(title)}</h3>
        <button class="modal-close" data-modal-close type="button">×</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(overlay);
  function close() { overlay.remove(); }
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  qs(overlay, "[data-modal-close]").addEventListener("click", close);
  if (onMount) onMount(qs(overlay, ".modal-body"), close);
  return close;
}

/** Confirmation dialog for destructive actions. */
function openConfirm({ title, message, confirmLabel = "Confirm", onConfirm }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-dialog">
      <h3 class="modal-title">${esc(title)}</h3>
      <p class="modal-message">${esc(message)}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-cancel type="button">Cancel</button>
        <button class="btn btn-danger" data-confirm type="button">${esc(confirmLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  function close() { overlay.remove(); }
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  qs(overlay, "[data-cancel]").addEventListener("click", close);
  qs(overlay, "[data-confirm]").addEventListener("click", async () => { await onConfirm(); close(); });
}

function statCardHtml(label, value) {
  return `<div class="card stat-card"><span class="stat-value">${esc(value)}</span><span class="stat-label">${esc(label)}</span></div>`;
}

// ===========================================================================
// 6. Page shell — bottom nav for shop/rider, sidebar for admin.
// ===========================================================================

function renderPageShell(root, { title, role, activeView, navigate }) {
  const isAdmin = role === ROLES.ADMIN;
  const navItems = NAV_ITEMS_BY_ROLE[role];

  root.innerHTML = isAdmin
    ? `
    <div class="app-shell app-shell-admin">
      <aside class="sidebar">
        <div class="sidebar-brand">${esc(APP_CONFIG.APP_NAME)}</div>
        <nav class="sidebar-nav">
          ${navItems.map((item) => `<button class="sidebar-nav-item ${item.view === activeView ? "active" : ""}" data-nav="${item.view}">${esc(item.label)}</button>`).join("")}
        </nav>
        <button class="sidebar-logout" data-logout>Log out</button>
      </aside>
      <div class="app-shell-main">
        <header class="page-header"><h1 class="page-title">${esc(title)}</h1></header>
        <main class="page-content" id="page-content"></main>
      </div>
    </div>`
    : `
    <div class="app-shell app-shell-mobile">
      <header class="page-header">
        <h1 class="page-title">${esc(title)}</h1>
        <button class="page-logout" data-logout>Log out</button>
      </header>
      <main class="page-content" id="page-content"></main>
      <nav class="bottom-nav">
        ${navItems.map((item) => `
          <button class="bottom-nav-item ${item.view === activeView ? "active" : ""}" data-nav="${item.view}">
            <span class="bottom-nav-icon">${item.icon}</span>
            <span class="bottom-nav-label">${esc(item.label)}</span>
          </button>`).join("")}
      </nav>
    </div>`;

  on(root, "click", "[data-nav]", (_e, el) => navigate(el.getAttribute("data-nav")));
  on(root, "click", "[data-logout]", async () => { await logout(); });

  return qs(root, "#page-content");
}

// ===========================================================================
// 7. Views
// ===========================================================================

// --- Login ---

function mountLoginView(root) {
  root.innerHTML = `
    <div class="auth-screen">
      <form class="auth-card" id="login-form">
        <h1 class="auth-title">${esc(APP_CONFIG.APP_NAME)}</h1>
        <p class="auth-subtitle">Hyperlocal delivery, sorted.</p>
        ${formFieldHtml({ label: "Email", name: "email", type: "email" })}
        ${formFieldHtml({ label: "Password", name: "password", type: "password" })}
        ${buttonHtml({ label: "Log In", type: "submit", fullWidth: true, attrs: 'id="login-submit"' })}
      </form>
    </div>`;

  const form = qs(root, "#login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { email, password } = readForm(form, ["email", "password"]);
    if (!email || !password) { showToast("Enter your email and password.", "error"); return; }
    const submitBtn = qs(form, "#login-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in…";
    try {
      await login(email, password);
      // subscribeSession's onAuthStateChanged will drive the re-render.
    } catch (err) {
      showToast(err.message || "Login failed.", "error");
      submitBtn.disabled = false;
      submitBtn.textContent = "Log In";
    }
  });

  return () => {};
}

// --- SHOP area ---

function mountShopArea(content, user, view, navigate) {
  switch (view) {
    case VIEWS.SHOP_DASHBOARD: return mountShopDashboard(content, user, navigate);
    case VIEWS.SHOP_BOOK: return mountBookDelivery(content, user, navigate);
    case VIEWS.SHOP_DELIVERIES: return mountShopDeliveries(content, user);
    case VIEWS.SHOP_LEDGER: return mountShopLedger(content, user);
    case VIEWS.SHOP_PROFILE: return mountShopProfile(content, user);
    default: return () => {};
  }
}

function mountShopDashboard(content, user, navigate) {
  content.innerHTML = skeletonHtml(3);
  const unsub = Deliveries.subscribeByShop(user.profile.linkedId, (deliveries) => {
    const today = deliveries.filter((d) => isToday(d.createdAt));
    const inProgress = deliveries.filter((d) => !["delivered", "failed"].includes(d.status)).length;
    const deliveredToday = today.filter((d) => d.status === DELIVERY_STATUS.DELIVERED).length;
    content.innerHTML = `
      <div class="dashboard">
        <div class="stats-grid">
          ${statCardHtml("Today's Deliveries", today.length)}
          ${statCardHtml("In Progress", inProgress)}
          ${statCardHtml("Delivered Today", deliveredToday)}
        </div>
        ${buttonHtml({ label: "+ Book a Delivery", fullWidth: true, attrs: 'data-book' })}
      </div>`;
    on(content, "click", "[data-book]", () => navigate(VIEWS.SHOP_BOOK));
  }, () => { content.innerHTML = emptyStateHtml("Could not load dashboard."); });
  return unsub;
}

function mountBookDelivery(content, user, navigate) {
  content.innerHTML = `
    <div class="form-card">
      <form id="book-form">
        ${formFieldHtml({ label: "Customer Name", name: "customerName" })}
        ${formFieldHtml({ label: "Customer Phone", name: "customerPhone" })}
        ${formFieldHtml({ label: "Delivery Address", name: "address", type: "textarea" })}
        ${formFieldHtml({ label: "Landmark", name: "landmark" })}
        ${formFieldHtml({ label: "Package Type", name: "packageType", type: "select", value: PACKAGE_TYPES[0], options: PACKAGE_TYPES.map((p) => ({ value: p, label: p })) })}
        ${formFieldHtml({ label: "Priority", name: "priority", type: "select", value: PRIORITIES[0], options: PRIORITIES.map((p) => ({ value: p, label: p })) })}
        ${formFieldHtml({ label: "Notes", name: "notes", type: "textarea" })}
        ${formFieldHtml({ label: "Cash to Collect (optional)", name: "cashToCollect", type: "number" })}
        ${buttonHtml({ label: "Submit Delivery", fullWidth: true, type: "submit" })}
      </form>
    </div>`;

  const form = qs(content, "#book-form");
  const fields = ["customerName", "customerPhone", "address", "landmark", "packageType", "priority", "notes", "cashToCollect"];
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const values = readForm(form, fields);
    const result = validateDeliveryInput(values);
    applyFormErrors(form, result.errors);
    if (!result.isValid) { showToast("Please fix the highlighted fields.", "error"); return; }
    try {
      await Deliveries.create({
        shopId: user.profile.linkedId,
        shopName: user.profile.displayName || "",
        ...values,
        cashToCollect: values.cashToCollect ? Number(values.cashToCollect) : null,
      });
      showToast("Delivery booked!", "success");
      navigate(VIEWS.SHOP_DELIVERIES);
    } catch (err) {
      showToast(err.message || "Failed to book delivery.", "error");
    }
  });

  return () => {};
}

function mountShopDeliveries(content, user) {
  let deliveries = [];
  let loading = true;
  let statusFilter = "all";
  let search = "";

  content.innerHTML = `
    <div class="filter-bar">
      <input class="form-input search-input" id="d-search" placeholder="Search by name or phone…" />
      <select class="form-input" id="d-status">
        <option value="all">All Statuses</option>
        ${Object.values(DELIVERY_STATUS).map((s) => `<option value="${s}">${esc(STATUS_LABELS[s])}</option>`).join("")}
      </select>
    </div>
    <div id="d-list"></div>`;

  const listEl = qs(content, "#d-list");

  function renderList() {
    if (loading) { listEl.innerHTML = skeletonHtml(4); return; }
    const filtered = deliveries.filter((d) => {
      const matchesStatus = statusFilter === "all" || d.status === statusFilter;
      const term = search.toLowerCase();
      const matchesSearch = !term || d.customerName?.toLowerCase().includes(term) || d.customerPhone?.includes(search);
      return matchesStatus && matchesSearch;
    });
    if (filtered.length === 0) { listEl.innerHTML = emptyStateHtml("No deliveries match your filters."); return; }
    listEl.innerHTML = `<div class="delivery-list">
      ${filtered.map((d) => `
        <div class="card delivery-card">
          <div class="delivery-card-top">
            <span class="delivery-id">${esc(formatDeliveryId(d.id))}</span>
            ${statusBadgeHtml(d.status)}
          </div>
          <p class="delivery-customer">${esc(d.customerName)}</p>
          <p class="delivery-meta">${esc(d.packageType)} • ${esc(d.priority)}</p>
          <p class="delivery-meta">${esc(formatDateTime(d.createdAt))}</p>
        </div>`).join("")}
    </div>`;
  }

  qs(content, "#d-search").addEventListener("input", (e) => { search = e.target.value; renderList(); });
  qs(content, "#d-status").addEventListener("change", (e) => { statusFilter = e.target.value; renderList(); });

  renderList();
  const unsub = Deliveries.subscribeByShop(user.profile.linkedId, (d) => { deliveries = d; loading = false; renderList(); }, () => { loading = false; renderList(); });
  return unsub;
}

function mountShopLedger(content, user) {
  content.innerHTML = skeletonHtml(5);
  Promise.all([Ledger.getByShop(user.profile.linkedId), Payments.getByShop(user.profile.linkedId)])
    .then(([entries, payments]) => {
      const balance = calculateOutstandingBalance(entries, payments);
      const history = [
        ...entries.map((e) => ({ ...e, kind: "charge" })),
        ...payments.map((p) => ({ ...p, kind: "payment" })),
      ].sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

      content.innerHTML = `
        <div class="card balance-card">
          <span class="balance-label">Outstanding Balance</span>
          <span class="balance-value">${esc(formatCurrency(balance))}</span>
        </div>
        <h3 class="section-title">History</h3>
        ${history.length === 0 ? emptyStateHtml("No ledger activity yet.") : `
          <div class="ledger-list">
            ${history.map((item) => `
              <div class="card ledger-row">
                <span>${item.kind === "charge" ? "Delivery charge" : `Payment${item.note ? ` — ${esc(item.note)}` : ""}`}</span>
                <span class="${item.kind === "charge" ? "amount-charge" : "amount-payment"}">${item.kind === "charge" ? "+" : "−"}${esc(formatCurrency(item.amount))}</span>
                <span class="ledger-date">${esc(formatDateTime(item.createdAt))}</span>
              </div>`).join("")}
          </div>`}`;
    });
  return () => {};
}

function mountShopProfile(content, user) {
  content.innerHTML = skeletonHtml(4);
  Shops.get(user.profile.linkedId).then((shop) => {
    if (!shop) { content.innerHTML = emptyStateHtml("Shop profile not found."); return; }
    const rows = [
      ["Shop Name", shop.name], ["Phone", shop.phone], ["Address", shop.address],
      ["Opening Time", shop.openingTime], ["Closing Time", shop.closingTime],
      ["Weekly Off", shop.weeklyOff], ["Status", shop.active ? "Active" : "Inactive"],
    ];
    content.innerHTML = `<div class="card profile-card">
      ${rows.map(([label, value]) => `
        <div class="profile-row">
          <span class="profile-label">${esc(label)}</span>
          <span class="profile-value">${esc(value || "—")}</span>
        </div>`).join("")}
    </div>`;
  });
  return () => {};
}

// --- RIDER area ---

function mountRiderArea(content, user, view) {
  switch (view) {
    case VIEWS.RIDER_DASHBOARD: return mountRiderDashboard(content, user);
    case VIEWS.RIDER_ASSIGNED: return mountRiderAssigned(content, user);
    case VIEWS.RIDER_ACCEPTED: return mountRiderAccepted(content, user);
    default: return () => {};
  }
}

function mountRiderDashboard(content, user) {
  content.innerHTML = skeletonHtml(3);
  let deliveries = [];
  let rider = null;
  let loading = true;

  function render() {
    if (loading) { content.innerHTML = skeletonHtml(3); return; }
    const completedToday = deliveries.filter((d) => d.status === DELIVERY_STATUS.DELIVERED && isToday(d.timestamps?.delivered)).length;
    const assigned = deliveries.filter((d) => d.status === DELIVERY_STATUS.ASSIGNED).length;
    const accepted = deliveries.filter((d) => ["accepted", "picked_up", "out_for_delivery"].includes(d.status)).length;

    content.innerHTML = `
      <div class="dashboard">
        <div class="card online-toggle-card">
          <span>${rider?.online ? "You're Online" : "You're Offline"}</span>
          <button class="toggle-switch ${rider?.online ? "on" : "off"}" id="online-toggle" type="button"><span class="toggle-knob"></span></button>
        </div>
        <div class="stats-grid">
          ${statCardHtml("Assigned", assigned)}
          ${statCardHtml("Accepted", accepted)}
          ${statCardHtml("Completed Today", completedToday)}
        </div>
      </div>`;

    qs(content, "#online-toggle").addEventListener("click", async () => {
      if (!rider) return;
      try {
        await Riders.setOnline(rider.id, !rider.online);
        showToast(!rider.online ? "You're online." : "You're offline.", "success");
      } catch (err) {
        showToast(err.message || "Could not update status.", "error");
      }
    });
  }

  const unsub1 = Deliveries.subscribeByRider(user.profile.linkedId, (d) => { deliveries = d; loading = false; render(); }, () => { loading = false; render(); });
  const unsub2 = Riders.subscribeOne(user.profile.linkedId, (r) => { rider = r; render(); }, () => {});
  return () => { unsub1 && unsub1(); unsub2 && unsub2(); };
}

function mountRiderAssigned(content, user) {
  let deliveries = [];
  let loading = true;
  const selected = new Set();

  function render() {
    if (loading) { content.innerHTML = skeletonHtml(4); return; }
    if (deliveries.length === 0) { content.innerHTML = emptyStateHtml("No deliveries assigned to you right now."); return; }

    content.innerHTML = `
      ${selected.size > 0 ? `
        <div class="batch-action-bar">
          <span>${selected.size} selected</span>
          ${buttonHtml({ label: "Accept Selected", attrs: 'id="accept-selected"' })}
        </div>` : ""}
      <div class="delivery-list">
        ${deliveries.map((d) => `
          <div class="card delivery-card">
            <div class="delivery-card-top">
              <input type="checkbox" data-select="${d.id}" ${selected.has(d.id) ? "checked" : ""} />
              <span class="delivery-id">${esc(formatDeliveryId(d.id))}</span>
            </div>
            <p class="delivery-customer">${esc(d.customerName)}</p>
            <p class="delivery-meta">${esc(d.address)}</p>
            <p class="delivery-meta">Shop: ${esc(d.shopName)}</p>
            ${buttonHtml({ label: "Accept", variant: "secondary", fullWidth: true, attrs: `data-accept="${d.id}"` })}
          </div>`).join("")}
      </div>`;

    on(content, "change", "[data-select]", (_e, el) => {
      const id = el.getAttribute("data-select");
      if (el.checked) selected.add(id); else selected.delete(id);
      render();
    });
    on(content, "click", "[data-accept]", async (_e, el) => {
      const id = el.getAttribute("data-accept");
      try { await acceptDelivery(id, user.uid); showToast("Delivery accepted.", "success"); }
      catch (err) { showToast(err.message || "Could not accept delivery.", "error"); }
    });
    const acceptSelectedBtn = qs(content, "#accept-selected");
    if (acceptSelectedBtn) acceptSelectedBtn.addEventListener("click", async () => {
      if (selected.size === 0) return;
      const ids = [...selected];
      const { succeeded, failedIds } = await acceptMultipleDeliveries(ids, user.uid);
      showToast(`Accepted ${succeeded} deliveries${failedIds.length ? `, ${failedIds.length} failed` : ""}.`, failedIds.length ? "error" : "success");
      selected.clear();
      render();
    });
  }

  const unsub = Deliveries.subscribeByRider(
    user.profile.linkedId,
    (d) => { deliveries = d.filter((x) => x.status === DELIVERY_STATUS.ASSIGNED); loading = false; render(); },
    () => { loading = false; render(); }
  );
  return unsub;
}

function mountRiderAccepted(content, user) {
  let deliveries = [];
  let loading = true;

  function render() {
    if (loading) { content.innerHTML = skeletonHtml(4); return; }
    if (deliveries.length === 0) { content.innerHTML = emptyStateHtml("No deliveries in progress."); return; }

    content.innerHTML = `<div class="delivery-list">
      ${deliveries.map((d) => `
        <div class="card delivery-card">
          <div class="delivery-card-top">
            <span class="delivery-id">${esc(formatDeliveryId(d.id))}</span>
            ${statusBadgeHtml(d.status)}
          </div>
          <p class="delivery-customer">${esc(d.customerName)}</p>
          <p class="delivery-meta">${esc(d.address)}</p>
          <div class="delivery-actions">
            ${d.status === DELIVERY_STATUS.ACCEPTED ? buttonHtml({ label: "Mark Picked Up", attrs: `data-action="picked_up" data-id="${d.id}"` }) : ""}
            ${d.status === DELIVERY_STATUS.PICKED_UP ? buttonHtml({ label: "Out for Delivery", attrs: `data-action="out_for_delivery" data-id="${d.id}"` }) : ""}
            ${d.status === DELIVERY_STATUS.OUT_FOR_DELIVERY ? buttonHtml({ label: "Mark Delivered", attrs: `data-action="deliver" data-id="${d.id}"` }) : ""}
            ${buttonHtml({ label: "Failed", variant: "danger", attrs: `data-action="fail" data-id="${d.id}"` })}
          </div>
        </div>`).join("")}
    </div>`;

    on(content, "click", "[data-action]", async (_e, el) => {
      const action = el.getAttribute("data-action");
      const id = el.getAttribute("data-id");
      const delivery = deliveries.find((d) => d.id === id);
      if (action === "picked_up") {
        try { await markPickedUp(id, user.uid); showToast("Status updated.", "success"); }
        catch (err) { showToast(err.message || "Could not update status.", "error"); }
      } else if (action === "out_for_delivery") {
        try { await markOutForDelivery(id, user.uid); showToast("Status updated.", "success"); }
        catch (err) { showToast(err.message || "Could not update status.", "error"); }
      } else if (action === "deliver") {
        openDeliverModal(delivery, user);
      } else if (action === "fail") {
        openFailModal(delivery, user);
      }
    });
  }

  const unsub = Deliveries.subscribeByRider(
    user.profile.linkedId,
    (d) => { deliveries = d.filter((x) => IN_PROGRESS_STATUSES.includes(x.status)); loading = false; render(); },
    () => { loading = false; render(); }
  );
  return unsub;
}

function openDeliverModal(delivery, user) {
  let selectedFile = null;
  openModal("Complete Delivery", `
    <div class="modal-form">
      <label class="form-label">Proof of Delivery Photo</label>
      <input type="file" accept="image/*" id="proof-file" />
      ${delivery.cashToCollect ? `
        <label class="form-label" style="margin-top:12px;">Cash Collected</label>
        <input class="form-input" type="number" id="cash-collected" placeholder="Cash to collect: ₹${esc(delivery.cashToCollect)}" />
      ` : ""}
      <div style="margin-top:16px;">
        ${buttonHtml({ label: "Confirm Delivered", fullWidth: true, attrs: 'id="confirm-deliver"' })}
      </div>
    </div>`, (body) => {
    qs(body, "#proof-file").addEventListener("change", (e) => { selectedFile = e.target.files[0]; });
    qs(body, "#confirm-deliver").addEventListener("click", async () => {
      if (!selectedFile) { showToast("Please select a proof photo.", "error"); return; }
      const btn = qs(body, "#confirm-deliver");
      btn.disabled = true; btn.textContent = "Saving…";
      try {
        const proofPhotoUrl = await uploadProofPhoto(delivery.id, selectedFile);
        const cashEl = qs(body, "#cash-collected");
        const cashCollected = cashEl && cashEl.value ? Number(cashEl.value) : null;
        await markDelivered(delivery.id, { proofPhotoUrl, cashCollected }, user.uid);
        showToast("Delivery completed!", "success");
        document.querySelector(".modal-overlay")?.remove();
      } catch (err) {
        showToast(err.message || "Could not complete delivery.", "error");
        btn.disabled = false; btn.textContent = "Confirm Delivered";
      }
    });
  });
}

function openFailModal(delivery, user) {
  openModal("Report Failed Delivery", `
    <div class="modal-form">
      <label class="form-label">Reason</label>
      <select class="form-input" id="fail-reason">
        ${FAILURE_REASONS.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}
      </select>
      <div style="margin-top:16px;">
        ${buttonHtml({ label: "Mark as Failed", variant: "danger", fullWidth: true, attrs: 'id="confirm-fail"' })}
      </div>
    </div>`, (body) => {
    qs(body, "#confirm-fail").addEventListener("click", async () => {
      const reason = qs(body, "#fail-reason").value;
      try {
        await markFailed(delivery.id, reason, user.uid);
        showToast("Delivery marked as failed.", "success");
        document.querySelector(".modal-overlay")?.remove();
      } catch (err) {
        showToast(err.message || "Could not update delivery.", "error");
      }
    });
  });
}

// --- ADMIN area ---

function mountAdminArea(content, user, view) {
  switch (view) {
    case VIEWS.ADMIN_DASHBOARD: return mountAdminDashboard(content);
    case VIEWS.ADMIN_SHOPS: return mountAdminShops(content, user);
    case VIEWS.ADMIN_RIDERS: return mountAdminRiders(content);
    case VIEWS.ADMIN_DELIVERIES: return mountAdminDeliveries(content, user);
    case VIEWS.ADMIN_LEDGER: return mountAdminLedger(content);
    case VIEWS.ADMIN_SETTINGS: return mountAdminSettings(content);
    default: return () => {};
  }
}

function mountAdminDashboard(content) {
  content.innerHTML = skeletonHtml(4);
  let deliveries = [];
  let riders = [];
  let shops = [];
  let loading = true;

  function render() {
    if (loading) { content.innerHTML = skeletonHtml(4); return; }
    const today = deliveries.filter((d) => isToday(d.createdAt));
    const counts = {
      pending: today.filter((d) => d.status === DELIVERY_STATUS.PENDING).length,
      assigned: today.filter((d) => d.status === DELIVERY_STATUS.ASSIGNED).length,
      completed: today.filter((d) => d.status === DELIVERY_STATUS.DELIVERED).length,
      failed: today.filter((d) => d.status === DELIVERY_STATUS.FAILED).length,
    };
    const activeRiders = riders.filter((r) => r.active && r.online).length;
    const outstanding = shops.reduce((sum, s) => sum + (s.outstandingBalance || 0), 0);

    content.innerHTML = `
      <div class="dashboard">
        <h3 class="section-title">Today's Deliveries</h3>
        <div class="stats-grid">
          ${statCardHtml("Pending", counts.pending)}
          ${statCardHtml("Assigned", counts.assigned)}
          ${statCardHtml("Completed", counts.completed)}
          ${statCardHtml("Failed", counts.failed)}
        </div>
        <h3 class="section-title">Platform</h3>
        <div class="stats-grid">
          ${statCardHtml("Active Riders", activeRiders)}
          ${statCardHtml("Total Shops", shops.length)}
          ${statCardHtml("Outstanding Balance", formatCurrency(outstanding))}
        </div>
      </div>`;
  }

  const unsub = Deliveries.subscribeAll((d) => { deliveries = d; render(); }, () => {});
  Promise.all([Riders.getAll(), Shops.getAll()]).then(([r, s]) => { riders = r; shops = s; loading = false; render(); });
  return unsub;
}

function mountAdminShops(content, user) {
  let shops = [];
  let loading = true;

  content.innerHTML = `
    <div style="margin-bottom:12px;">${buttonHtml({ label: "+ Create Shop", attrs: 'id="create-shop"' })}</div>
    <div id="shops-list"></div>`;
  const listEl = qs(content, "#shops-list");

  function reload() { Shops.getAll().then((s) => { shops = s; loading = false; render(); }); }

  function render() {
    if (loading) { listEl.innerHTML = skeletonHtml(4); return; }
    if (shops.length === 0) { listEl.innerHTML = emptyStateHtml("No shops yet."); return; }
    listEl.innerHTML = `<div class="list-table">
      ${shops.map((shop) => `
        <div class="card list-row">
          <div class="list-row-main">
            <span class="list-row-title">${esc(shop.name)}</span>
            <span class="list-row-sub">${shop.active ? "Active" : "Inactive"} • Balance: ${esc(formatCurrency(shop.outstandingBalance || 0))}</span>
          </div>
          <div class="list-row-actions">
            ${buttonHtml({ label: "Edit", variant: "ghost", attrs: `data-edit="${shop.id}"` })}
            ${buttonHtml({ label: "Payment", variant: "secondary", attrs: `data-pay="${shop.id}"` })}
            ${shop.active ? buttonHtml({ label: "Deactivate", variant: "danger", attrs: `data-deactivate="${shop.id}"` }) : ""}
          </div>
        </div>`).join("")}
    </div>`;

    on(listEl, "click", "[data-edit]", (_e, el) => openShopFormModal(shops.find((s) => s.id === el.getAttribute("data-edit")), reload));
    on(listEl, "click", "[data-pay]", (_e, el) => openPaymentModal(shops.find((s) => s.id === el.getAttribute("data-pay")), user, reload));
    on(listEl, "click", "[data-deactivate]", (_e, el) => {
      const shop = shops.find((s) => s.id === el.getAttribute("data-deactivate"));
      openConfirm({
        title: "Deactivate Shop",
        message: `${shop.name} will no longer be able to book deliveries.`,
        confirmLabel: "Deactivate",
        onConfirm: async () => { await Shops.deactivate(shop.id); reload(); showToast("Shop deactivated.", "success"); },
      });
    });
  }

  qs(content, "#create-shop").addEventListener("click", () => openShopFormModal(null, reload));
  reload();
  return () => {};
}

function openShopFormModal(shop, onSaved) {
  const values = shop || { name: "", phone: "", address: "", openingTime: "09:00", closingTime: "21:00", weeklyOff: "" };
  const fields = ["name", "phone", "address", "openingTime", "closingTime", "weeklyOff"];
  openModal(shop ? "Edit Shop" : "Create Shop", `
    <div class="modal-form">
      <form id="shop-form">
        ${formFieldHtml({ label: "Shop Name", name: "name", value: values.name })}
        ${formFieldHtml({ label: "Phone", name: "phone", value: values.phone })}
        ${formFieldHtml({ label: "Address", name: "address", type: "textarea", value: values.address })}
        ${formFieldHtml({ label: "Opening Time", name: "openingTime", type: "time", value: values.openingTime })}
        ${formFieldHtml({ label: "Closing Time", name: "closingTime", type: "time", value: values.closingTime })}
        ${formFieldHtml({ label: "Weekly Off", name: "weeklyOff", value: values.weeklyOff })}
        ${buttonHtml({ label: shop ? "Save Changes" : "Create Shop", fullWidth: true, type: "submit" })}
      </form>
    </div>`, (body, close) => {
    const form = qs(body, "#shop-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const newValues = readForm(form, fields);
      const result = validateShopInput(newValues);
      applyFormErrors(form, result.errors);
      if (!result.isValid) return;
      try {
        if (shop) await Shops.update(shop.id, newValues); else await Shops.create(newValues);
        onSaved();
        showToast(shop ? "Shop updated." : "Shop created.", "success");
        close();
      } catch (err) {
        showToast(err.message || "Save failed.", "error");
      }
    });
  });
}

function openPaymentModal(shop, user, onSaved) {
  openModal(`Record Payment — ${shop.name}`, `
    <div class="modal-form">
      <form id="payment-form">
        ${formFieldHtml({ label: "Amount", name: "amount", type: "number" })}
        ${formFieldHtml({ label: "Note", name: "note" })}
        ${buttonHtml({ label: "Record Payment", fullWidth: true, type: "submit" })}
      </form>
    </div>`, (body, close) => {
    const form = qs(body, "#payment-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const { amount, note } = readForm(form, ["amount", "note"]);
      const num = Number(amount);
      if (!num || num <= 0) { showToast("Enter a valid amount.", "error"); return; }
      try {
        await Payments.record({ shopId: shop.id, amount: num, note, recordedByUid: user.uid });
        await Shops.update(shop.id, { outstandingBalance: (shop.outstandingBalance || 0) - num });
        onSaved();
        showToast("Payment recorded.", "success");
        close();
      } catch (err) {
        showToast(err.message || "Could not record payment.", "error");
      }
    });
  });
}

function mountAdminRiders(content) {
  let riders = [];
  let loading = true;

  content.innerHTML = `
    <div style="margin-bottom:12px;">${buttonHtml({ label: "+ Create Rider", attrs: 'id="create-rider"' })}</div>
    <div id="riders-list"></div>`;
  const listEl = qs(content, "#riders-list");

  function reload() { Riders.getAll().then((r) => { riders = r; loading = false; render(); }); }

  function render() {
    if (loading) { listEl.innerHTML = skeletonHtml(4); return; }
    if (riders.length === 0) { listEl.innerHTML = emptyStateHtml("No riders yet."); return; }
    listEl.innerHTML = `<div class="list-table">
      ${riders.map((rider) => `
        <div class="card list-row">
          <div class="list-row-main">
            <span class="list-row-title">${esc(rider.name)}</span>
            <span class="list-row-sub">${rider.active ? "Active" : "Inactive"} • ${rider.online ? "Online" : "Offline"} • ${rider.currentDeliveryCount || 0} active, ${rider.completedCount || 0} completed</span>
          </div>
          <div class="list-row-actions">
            ${buttonHtml({ label: "Edit", variant: "ghost", attrs: `data-edit="${rider.id}"` })}
            ${rider.active ? buttonHtml({ label: "Deactivate", variant: "danger", attrs: `data-deactivate="${rider.id}"` }) : ""}
          </div>
        </div>`).join("")}
    </div>`;

    on(listEl, "click", "[data-edit]", (_e, el) => openRiderFormModal(riders.find((r) => r.id === el.getAttribute("data-edit")), reload));
    on(listEl, "click", "[data-deactivate]", (_e, el) => {
      const rider = riders.find((r) => r.id === el.getAttribute("data-deactivate"));
      openConfirm({
        title: "Deactivate Rider",
        message: `${rider.name} will no longer receive new assignments.`,
        confirmLabel: "Deactivate",
        onConfirm: async () => { await Riders.deactivate(rider.id); reload(); showToast("Rider deactivated.", "success"); },
      });
    });
  }

  qs(content, "#create-rider").addEventListener("click", () => openRiderFormModal(null, reload));
  reload();
  return () => {};
}

function openRiderFormModal(rider, onSaved) {
  const values = rider || { name: "", phone: "" };
  openModal(rider ? "Edit Rider" : "Create Rider", `
    <div class="modal-form">
      <form id="rider-form">
        ${formFieldHtml({ label: "Rider Name", name: "name", value: values.name })}
        ${formFieldHtml({ label: "Phone", name: "phone", value: values.phone })}
        ${buttonHtml({ label: rider ? "Save Changes" : "Create Rider", fullWidth: true, type: "submit" })}
      </form>
    </div>`, (body, close) => {
    const form = qs(body, "#rider-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const newValues = readForm(form, ["name", "phone"]);
      const result = validateRiderInput(newValues);
      applyFormErrors(form, result.errors);
      if (!result.isValid) return;
      try {
        if (rider) await Riders.update(rider.id, newValues); else await Riders.create(newValues);
        onSaved();
        showToast(rider ? "Rider updated." : "Rider created.", "success");
        close();
      } catch (err) {
        showToast(err.message || "Save failed.", "error");
      }
    });
  });
}

function mountAdminDeliveries(content, user) {
  let deliveries = [];
  let loading = true;
  let statusFilter = "all";
  let search = "";

  content.innerHTML = `
    <div class="filter-bar">
      <input class="form-input search-input" id="ad-search" placeholder="Search by ID, customer, phone, or shop…" />
      <select class="form-input" id="ad-status">
        <option value="all">All Statuses</option>
        ${Object.values(DELIVERY_STATUS).map((s) => `<option value="${s}">${esc(STATUS_LABELS[s])}</option>`).join("")}
      </select>
    </div>
    <div id="ad-list"></div>`;
  const listEl = qs(content, "#ad-list");

  function render() {
    if (loading) { listEl.innerHTML = skeletonHtml(5); return; }
    const filtered = deliveries.filter((d) => {
      const matchesStatus = statusFilter === "all" || d.status === statusFilter;
      const term = search.toLowerCase();
      const matchesSearch = !term || d.id.toLowerCase().includes(term) || d.customerName?.toLowerCase().includes(term) || d.customerPhone?.includes(search) || d.shopName?.toLowerCase().includes(term);
      return matchesStatus && matchesSearch;
    });
    if (filtered.length === 0) { listEl.innerHTML = emptyStateHtml("No deliveries match your filters."); return; }
    listEl.innerHTML = `<div class="list-table">
      ${filtered.map((d) => `
        <div class="card list-row">
          <div class="list-row-main">
            <span class="list-row-title">${esc(formatDeliveryId(d.id))} — ${esc(d.customerName)}</span>
            <span class="list-row-sub">${esc(d.shopName)} → ${esc(d.address)} • ${d.riderName ? `Rider: ${esc(d.riderName)}` : "Unassigned"} • ${esc(formatDateTime(d.createdAt))}</span>
          </div>
          ${statusBadgeHtml(d.status)}
          ${[DELIVERY_STATUS.PENDING, DELIVERY_STATUS.ASSIGNED].includes(d.status) ? buttonHtml({ label: d.status === DELIVERY_STATUS.PENDING ? "Assign" : "Reassign", variant: "secondary", attrs: `data-assign="${d.id}"` }) : ""}
        </div>`).join("")}
    </div>`;

    on(listEl, "click", "[data-assign]", (_e, el) => openAssignModal(deliveries.find((d) => d.id === el.getAttribute("data-assign")), user));
  }

  qs(content, "#ad-search").addEventListener("input", (e) => { search = e.target.value; render(); });
  qs(content, "#ad-status").addEventListener("change", (e) => { statusFilter = e.target.value; render(); });

  render();
  const unsub = Deliveries.subscribeAll((d) => { deliveries = d; loading = false; render(); }, () => { loading = false; render(); });
  return unsub;
}

function openAssignModal(delivery, user) {
  const close = openModal(`Assign Rider — ${formatDeliveryId(delivery.id)}`, `<div class="modal-form"><div id="assign-riders">${skeletonHtml(2)}</div></div>`, (body) => {
    Riders.getAvailable().then((riders) => {
      if (riders.length === 0) {
        showToast("No active, online riders available right now.", "error");
        close();
        return;
      }
      qs(body, "#assign-riders").innerHTML = riders.map((rider) => `
        <div class="card list-row">
          <span>${esc(rider.name)} (${rider.currentDeliveryCount || 0} active)</span>
          ${buttonHtml({ label: "Assign", variant: "secondary", attrs: `data-assign-rider="${rider.id}"` })}
        </div>`).join("");
      on(body, "click", "[data-assign-rider]", async (_e, el) => {
        const rider = riders.find((r) => r.id === el.getAttribute("data-assign-rider"));
        try {
          await assignRider(delivery.id, rider, user.uid);
          showToast(`Assigned to ${rider.name}.`, "success");
          close();
        } catch (err) {
          showToast(err.message || "Could not assign rider.", "error");
        }
      });
    });
  });
}

function mountAdminLedger(content) {
  content.innerHTML = skeletonHtml(4);
  Shops.getAll().then((shops) => {
    const totalOutstanding = shops.reduce((sum, s) => sum + (s.outstandingBalance || 0), 0);
    const sorted = [...shops].sort((a, b) => (b.outstandingBalance || 0) - (a.outstandingBalance || 0));
    content.innerHTML = `
      <div class="card balance-card">
        <span class="balance-label">Total Outstanding (All Shops)</span>
        <span class="balance-value">${esc(formatCurrency(totalOutstanding))}</span>
      </div>
      ${shops.length === 0 ? emptyStateHtml("No shops yet.") : `
        <div class="list-table">
          ${sorted.map((shop) => `
            <div class="card list-row">
              <span class="list-row-title">${esc(shop.name)}</span>
              <span>${esc(formatCurrency(shop.outstandingBalance || 0))}</span>
            </div>`).join("")}
        </div>`}`;
  });
  return () => {};
}

function mountAdminSettings(content) {
  content.innerHTML = skeletonHtml(2);
  Settings.get().then((s) => {
    content.innerHTML = `
      <div class="form-card">
        <form id="settings-form">
          ${formFieldHtml({ label: "Delivery Price (₹ per completed delivery)", name: "deliveryPrice", type: "number", value: String(s.deliveryPrice) })}
          ${buttonHtml({ label: "Save", fullWidth: true, type: "submit" })}
        </form>
      </div>`;
    const form = qs(content, "#settings-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const { deliveryPrice } = readForm(form, ["deliveryPrice"]);
      const num = Number(deliveryPrice);
      if (!num || num <= 0) { showToast("Enter a valid price.", "error"); return; }
      try {
        await Settings.update({ deliveryPrice: num });
        showToast("Delivery price updated.", "success");
      } catch (err) {
        showToast(err.message || "Could not save settings.", "error");
      }
    });
  });
  return () => {};
}

// ===========================================================================
// 8. Router + boot
// ===========================================================================

let currentUser = null;
let authLoading = true;
let currentView = null;
let destroyCurrentView = null;

const root = document.getElementById("root");

function navigate(view) {
  currentView = view;
  renderRoot();
}

function renderRoot() {
  if (destroyCurrentView) { destroyCurrentView(); destroyCurrentView = null; }
  document.querySelectorAll(".modal-overlay").forEach((el) => el.remove());

  if (authLoading) {
    root.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;
    return;
  }
  if (!currentUser) {
    currentView = null;
    destroyCurrentView = mountLoginView(root);
    return;
  }
  if (!currentView) currentView = DEFAULT_VIEW_BY_ROLE[currentUser.role];

  const content = renderPageShell(root, {
    title: TITLE_BY_VIEW[currentView] || "",
    role: currentUser.role,
    activeView: currentView,
    navigate,
  });

  if (currentUser.role === ROLES.SHOP) destroyCurrentView = mountShopArea(content, currentUser, currentView, navigate);
  else if (currentUser.role === ROLES.RIDER) destroyCurrentView = mountRiderArea(content, currentUser, currentView);
  else if (currentUser.role === ROLES.ADMIN) destroyCurrentView = mountAdminArea(content, currentUser, currentView);
}

subscribeSession((sessionUser) => {
  currentUser = sessionUser;
  authLoading = false;
  if (sessionUser) currentView = currentView || DEFAULT_VIEW_BY_ROLE[sessionUser.role];
  else currentView = null;
  renderRoot();
});