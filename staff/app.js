/* The staff app for iPhone (and any phone's browser): the Android app's
   everyday work, through the same checked cloud functions (rpl_mobile_*),
   signed in with the usual username and PIN. Installed from Safari:
   Share → Add to Home Screen. EcoCash and InnBucks prompts and pay links
   go through Paynow from a PC or the Android app (a browser can't reach
   Paynow itself). Everything shown is typed into the page as text, never
   as markup. */
(function () {
  "use strict";

  const config = window.STAFF_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const view = $("view");
  const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const METHODS = [["cash", "Cash"], ["card", "Card"], ["bank_transfer", "Bank transfer"],
    ["ecocash", "EcoCash (already paid)"], ["innbucks", "InnBucks (already paid)"]];
  const METHOD_LABEL = Object.fromEntries(METHODS.map(([k, v]) => [k, v.replace(" (already paid)", "")]).concat([["paynow", "Paynow (online)"]]));

  // --- small DOM helper: text only, never HTML ---
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "value") el.value = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  function toast(text, ms = 2600) {
    const t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
  }
  function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() : "r" + Date.now() + Math.random().toString(16).slice(2);
  }
  function store(key, value) {
    try { if (value === undefined) return JSON.parse(localStorage.getItem(key) || "null"); localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { return null; }
  }
  function forget(key) { try { localStorage.removeItem(key); } catch (e) { /* private browsing */ } }

  // --- the cloud ---
  class ApiError extends Error { constructor(message, maybeDone) { super(message); this.maybeDone = maybeDone; } }
  // --- practice: selling on this iPad with nothing reaching the shop ---
  // Reads (products, prices, stock, rates, lists) go to the shop as usual;
  // orders, quotes, payments, invoices and the sales report are made here,
  // in the shop's own words, and kept only until practice ends. Anything
  // else that would change the shop is refused. As the Android app's.
  const NOT_IN_PRACTICE = "Not in practice: this would change the shop. End practice (More) to do it for real.";
  const PRACTICE_READS = new Set(["rpl_mobile_login", "rpl_mobile_logout", "rpl_mobile_connection", "rpl_mobile_catalog",
    "rpl_mobile_company", "rpl_mobile_rates", "rpl_mobile_duty_proof", "rpl_mobile_consignments", "rpl_mobile_consignment_choices",
    "rpl_mobile_consignment_taken", "rpl_mobile_consignment_report", "rpl_mobile_users", "rpl_mobile_web_orders",
    "rpl_mobile_photo_products", "rpl_mobile_approvals", "rpl_mobile_purchase_orders", "rpl_mobile_stock_lookup",
    "rpl_mobile_count_items", "rpl_mobile_order_plan", "rpl_mobile_attachment"]);
  const practice = { on: false, products: {}, rates: {}, orders: [], quotes: [], requests: [], n: 0 };
  function practiceStart() { Object.assign(practice, { on: true, products: {}, rates: {}, orders: [], quotes: [], requests: [], n: 0 }); }
  function practiceStop() { Object.assign(practice, { on: false, products: {}, rates: {}, orders: [], quotes: [], requests: [], n: 0 }); }
  const pnow = () => new Date().toISOString().slice(0, 19);
  const pnum = (prefix) => "PRACTICE-" + prefix + "-" + String(++practice.n).padStart(4, "0");
  const r2 = (x) => Math.round(x * 100) / 100;
  function practiceSaw(fn, data) {
    if (!practice.on) return data;
    if (fn === "rpl_mobile_catalog" && Array.isArray(data)) {
      const held = {};
      for (const o of practice.orders) if (o.status !== "cancelled") for (const l of o.lines) held[l.item_id] = (held[l.item_id] || 0) + l.qty;
      for (const row of data) { practice.products[row.id] = row; if (held[row.id]) row.qty = (row.qty || 0) - held[row.id]; }
    }
    if (fn === "rpl_mobile_rates" && data) Object.assign(practice.rates, data);
    return data;
  }
  function practiceLines(args) {
    const out = (args.p_lines || []).map((g) => {
      const p = practice.products[g.item_id];
      if (!p) throw new ApiError("That product isn't in today's list: refresh it");
      const price = g.unit_price ?? p.price;
      return { item_id: g.item_id, sku: p.sku, name: p.name, qty: g.qty, unit_price: price, list_price: p.price, line_total: r2(g.qty * price) };
    });
    if (!out.length) throw new ApiError("Add something to sell");
    return out;
  }
  function practiceRow(args, kind) {
    const lines = practiceLines(args);
    const c = args.p_customer || {};
    const total = r2(lines.reduce((t, l) => t + l.line_total, 0) - (args.p_discount || 0) + (args.p_delivery || 0));
    return { id: "practice-" + kind + "-" + (practice.n + 1), branch: args.p_branch, lines, total, discount: args.p_discount || 0,
      customer_name: c.name || "", customer_phone: c.phone || "", customer_address: c.address || "", customer_email: c.email || "",
      created_by: session ? session.username : "", created_at: pnow() };
  }
  function practiceInvoiced(o) {
    if (o.status === "payment_pending") { o.status = "invoiced"; o.invoice_number = pnum("INV"); o.invoiced_at = pnow(); }
    return { order_number: o.order_number, paid: o.paid, balance: o.balance, invoice_number: o.invoice_number, invoice_waits: null };
  }
  function practiceAnswer(fn, args) {
    const order = (id) => practice.orders.find((o) => o.id === id) || (() => { throw new ApiError("That order no longer exists"); })();
    switch (fn) {
      case "rpl_mobile_create_order": {
        const o = Object.assign(practiceRow(args, "order"), { status: "payment_pending", paid: 0, payments: [], invoice_number: null });
        o.order_number = pnum("SO"); o.balance = o.total; practice.orders.push(o);
        return { id: o.id, order_number: o.order_number, total: o.total, discount: o.discount };
      }
      case "rpl_mobile_create_quote": {
        const q = Object.assign(practiceRow(args, "quote"), { status: "open", order_number: null, delivery: args.p_delivery || 0,
          valid_until: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10) });
        q.quote_number = pnum("QT"); practice.quotes.push(q);
        return { id: q.id, quote_number: q.quote_number, total: q.total, discount: q.discount };
      }
      case "rpl_mobile_quotes": return practice.quotes.filter((q) => q.branch === args.p_branch).slice().reverse();
      case "rpl_mobile_orders": return practice.orders.filter((o) => o.branch === args.p_branch).slice().reverse();
      case "rpl_mobile_take_payment": {
        const o = order(args.p_order_id);
        if (o.status === "cancelled") throw new ApiError(o.order_number + " was deleted");
        if (o.balance <= 0.004) throw new ApiError(o.order_number + " is paid in full");
        const currency = args.p_currency || "USD";
        let amount = r2(args.p_amount || 0), tendered = args.p_tendered || 0;
        if (currency !== "USD") {
          const rate = practice.rates[currency];
          if (!rate) throw new ApiError(currency + " isn't taken: set its rate on a shop PC first");
          amount = r2(tendered / rate);
          if (amount > o.balance) { amount = o.balance; tendered = r2(o.balance * rate); }
        }
        if (amount <= 0) throw new ApiError("Enter the amount paid");
        if (amount > o.balance + 0.004) throw new ApiError("That is more than the " + o.balance.toFixed(2) + " owed on " + o.order_number);
        o.payments.push({ method: args.p_method, amount }); o.paid = r2(o.paid + amount); o.balance = r2(o.balance - amount);
        return Object.assign(practiceInvoiced(o), { amount, currency, tendered: currency === "USD" ? amount : tendered });
      }
      case "rpl_mobile_issue_invoice": return practiceInvoiced(order(args.p_order_id));
      case "rpl_mobile_delete_order": {
        const o = order(args.p_order_id);
        if (o.status !== "payment_pending" || o.paid > 0.004) throw new ApiError(o.order_number + " is already invoiced");
        o.status = "cancelled"; return {};
      }
      case "rpl_mobile_report": {
        const sold = practice.orders.filter((o) => o.status === "invoiced" && (!args.p_branch || o.branch === args.p_branch));
        const sales = sold.reduce((t, o) => t + o.total, 0);
        const mix = {}, top = {};
        for (const o of sold) {
          for (const p of o.payments) mix[p.method] = (mix[p.method] || 0) + p.amount;
          for (const l of o.lines) { const t = top[l.sku] || { sku: l.sku, name: l.name, units: 0, revenue: 0 }; t.units += l.qty; t.revenue += l.line_total; top[l.sku] = t; }
        }
        const tops = Object.values(top).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
        const taken = Object.values(mix).reduce((t, x) => t + x, 0);
        return { sales, returns: 0, net_revenue: sales, previous_net_revenue: 0, full: false, invoices: sold.length,
          payment_mix: Object.entries(mix).map(([method, amount]) => ({ method, amount })), top_products: tops,
          orders_awaiting_payment: { count: 0, total: 0 }, stock: { out: 0, low: 0 }, received: taken,
          owed: { count: sold.filter((o) => o.balance > 0.004).length, total: sold.reduce((t, o) => t + o.balance, 0) },
          me: { sales, returns: 0, invoices: sold.length, previous: 0, payments_taken: taken, top_products: tops },
          gross_profit: null, expenses: null, written_off: null, net_profit: null, balances: null };
      }
      case "rpl_mobile_request": {
        practice.requests.push({ id: "practice-request-" + (++practice.n), kind: args.p_kind, branch: args.p_branch, status: "failed",
          result: "Practice: not sent to the shop", created_at: pnow(), done_at: pnow() });
        return { id: practice.requests[practice.requests.length - 1].id, status: "waiting" };
      }
      case "rpl_mobile_requests": return practice.requests.slice().reverse();
      case "rpl_mobile_invoice_pdf": throw new ApiError("Practice invoices aren't printed: the invoice PDF comes from the shop's PC");
      default: throw new ApiError(NOT_IN_PRACTICE);
    }
  }

  async function api(fn, args) {
    if (practice.on && !PRACTICE_READS.has(fn)) return practiceAnswer(fn, args || {});
    return practiceSaw(fn, await shopApi(fn, args));
  }

  async function shopApi(fn, args) {
    let response;
    try {
      response = await fetch(config.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/" + fn, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: config.publishableKey,
          ...(config.publishableKey.startsWith("eyJ") ? { Authorization: "Bearer " + config.publishableKey } : {}) },
        body: JSON.stringify(args || {}),
      });
    } catch (e) {
      throw new ApiError("Couldn't reach the shop: check mobile data or Wi-Fi");
    }
    const text = await response.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch (e) { return null; } })() : null;
    if ([502, 503, 504].includes(response.status)) throw new ApiError("No reply from the shop: it may have gone through", true);
    if (!response.ok) {
      const message = (data && data.message) || "The shop's server refused that (" + response.status + ")";
      if (/session|sign in|signed out|switched off/i.test(message)) signOut(message);
      throw new ApiError(message);
    }
    return data;
  }

  // --- the session ---
  let session = store("rpl-staff-session");
  let branch = store("rpl-staff-branch");
  const device = store("rpl-staff-device") || (() => { const d = "iPhone web " + uuid().slice(0, 8); store("rpl-staff-device", d); return d; })();
  const isAdmin = () => session && session.role === "admin";
  // What this person may do: their own set when one is saved on a PC
  // (Branches & Users → Permissions…), else their role's. The shop checks
  // again on every call; this only keeps away what they can't use.
  function can(key) {
    if (!session) return false;
    // A part of a screen goes with the screen unless taken away ("not:<key>").
    if (key.startsWith("screen:") && key.includes("/")) {
      return can(key.split("/")[0]) && !(Array.isArray(session.permissions) && session.permissions.includes("not:" + key));
    }
    if (Array.isArray(session.permissions)) return session.permissions.includes(key);
    if (session.role === "admin") return true;
    return session.role === "sales_person" && ["take_payments", "give_discounts", "record_expenses", "screen:Sales Order", "screen:Web Orders"].includes(key);
  }
  const cart = { lines: [], customer: { name: "", phone: "", email: "", address: "" }, delivery: 0, discount: 0, request: null };

  // --- Face ID / Touch ID: a passkey kept on this iPad or iPhone, asked
  // for on opening and after five minutes away, as the Android app asks
  // for the fingerprint or face. It only guards this device's sign-in: the
  // shop still checks the session on every call. ---
  const LOCK_KEY = "rpl-staff-lock";
  const AWAY_LIMIT = 5 * 60 * 1000;
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
  function lockOn() { const l = store(LOCK_KEY); return l && session && l.user === session.username ? l : null; }
  let locked = !!lockOn();
  async function faceIdAvailable() {
    try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
    catch (e) { return false; }
  }
  async function turnOnFaceId() {
    const made = await navigator.credentials.create({ publicKey: {
      challenge: randomBytes(32), rp: { name: (config.name || "RPL") + " staff", id: location.hostname },
      user: { id: randomBytes(16), name: session.username, displayName: session.username },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
      attestation: "none", timeout: 60000 } });
    store(LOCK_KEY, { id: b64(made.rawId), user: session.username });
  }
  async function unlock() {
    const l = lockOn();
    if (!l) { locked = false; return; }
    await navigator.credentials.get({ publicKey: { challenge: randomBytes(32), rpId: location.hostname, userVerification: "required",
      allowCredentials: [{ type: "public-key", id: unb64(l.id), transports: ["internal"] }], timeout: 60000 } });
    locked = false;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { store("rpl-staff-away", Date.now()); return; }
    const away = store("rpl-staff-away");
    if (lockOn() && !locked && away && Date.now() - away > AWAY_LIMIT) { locked = true; render("lock"); }
  });

  function signOut(why) {
    practiceStop();
    if (session) api("rpl_mobile_logout", { p_token: session.token }).catch(() => {});
    session = null; forget("rpl-staff-session"); forget(LOCK_KEY); locked = false;
    render("login", why);
  }

  // --- screens ---
  const TABS = [
    ["sell", "🛒", "Sell", () => can("screen:Sales Order")],
    ["orders", "📋", "Orders", () => can("screen:Sales Order")],
    ["web", "🌐", "Web orders", () => can("screen:Web Orders")],
    ["reports", "📊", "Reports", () => can("screen:Reports") || can("sales_report")],
    ["tools", "🧰", "Tools", () => TOOLS.some(([, , , ok]) => ok())],
    ["photos", "📷", "Photos", () => can("screen:Inventory") && !TOOLS.some(([, , , ok]) => ok())],
    ["more", "⚙️", "More", () => true],
  ];
  // Approvals, purchase orders, counts, stock and expenses, as on the
  // Android app: each follows this person's permissions.
  const TOOLS = [
    ["approvals", "✅", "Approvals", () => ["approve_purchase_orders", "approve_stock", "approve_write_offs"].some(can)],
    ["pos", "🚚", "Purchase orders", () => can("screen:Purchase Orders/Orders")],
    ["consignments", "✈️", "Consignments", () => can("screen:Consignments")],
    ["count", "📋", "Stock take", () => can("screen:Stock Take/Count and send for approval")],
    ["lookup", "🔎", "Stock lookup", () => can("screen:Sales Order") || can("screen:Inventory")],
    ["expense", "💸", "Record expense", () => can("record_expenses")],
    ["photos", "📷", "Product photos", () => can("screen:Inventory")],
  ];
  const REQUEST_LABEL = { approve_po: "Purchase order approval", approve_receipt: "Stock approval", approve_journal: "Count / write-off approval",
    stock_take: "Stock take", receive_po: "Delivery received", create_po: "New purchase order", record_expense: "Expense", change_price: "Price change", create_consignment: "New consignment", consignment_orders: "A consignment's orders" };
  let current = "sell";

  // Work a shop PC carries out (as the person who asked), within a minute.
  async function ask(kind, payload, sent) {
    await api("rpl_mobile_request", { p_token: session.token, p_kind: kind, p_branch: branch, p_payload: payload });
    toast(sent + ". A shop PC carries it out within a minute.", 4000);
  }
  async function requestsCard(kinds) {
    const all = await api("rpl_mobile_requests", { p_token: session.token }).catch(() => []);
    const shown = (all || []).filter((r) => !kinds || kinds.includes(r.kind)).slice(0, 10);
    if (!shown.length) return null;
    return h("div", {}, h("h2", {}, "Requests"), h("div", { class: "card list" }, shown.map((r) => h("div", { class: "item" },
      h("div", { class: "grow" }, h("div", {}, REQUEST_LABEL[r.kind] || r.kind), h("div", { class: "muted" }, r.result || new Date(r.created_at).toLocaleString())),
      h("span", { class: "pill " + (r.status === "done" ? "good" : r.status === "failed" ? "bad" : "warn") }, r.status)))));
  }

  function chrome() {
    const signedIn = !!session && current !== "lock";
    $("tabs").hidden = !signedIn; $("signout").hidden = !signedIn; $("branch").hidden = !signedIn || session.branches.length < 2;
    if (!signedIn) return;
    const tabs = $("tabs"); tabs.textContent = "";
    for (const [key, icon, label, allowed] of TABS) {
      if (!allowed()) continue;
      const on = key === current || (key === "tools" && TOOLS.some(([k]) => k === current) && !TABS.some(([t, , , ok]) => t === current && ok()));
      tabs.append(h("button", { class: on ? "on" : "", onclick: () => render(key) }, h("span", { class: "i" }, icon), label));
    }
    const select = $("branch"); select.textContent = "";
    for (const b of session.branches) select.append(h("option", { value: b.code }, b.code + " · " + b.name));
    select.value = branch;
  }

  async function render(screen, note) {
    if (!session) screen = "login";
    else if (locked && lockOn()) screen = "lock";
    // Into a tool slides in from the right; back to a tab, from the left.
    const backwards = TOOLS.some(([t]) => t === current) && screen === "tools";
    view.classList.remove("enter", "back"); void view.offsetWidth;
    if (screen !== current) view.classList.add(backwards ? "back" : "enter");
    current = screen;
    chrome();
    view.textContent = "";
    if (practice.on && session) view.append(h("div", { class: "practice" }, h("b", { class: "grow" }, "PRACTICE · nothing here is real or sent to the shop"),
      h("button", { onclick: () => { practiceStop(); toast("Practice over: back to the real shop"); render(current); } }, "End")));
    window.scrollTo(0, 0);
    try {
      await SCREENS[screen](note);
    } catch (e) {
      view.append(h("div", { class: "card err" }, e.message || "Something went wrong"));
    }
  }

  const SCREENS = {
    lock() {
      const err = h("div", { class: "err" });
      const go = h("button", { class: "primary full", onclick: async () => {
        err.textContent = "";
        try { await unlock(); render(TABS.find(([, , , ok]) => ok())[0]); }
        catch (e) { err.textContent = e.name === "NotAllowedError" ? "Not unlocked. Try again." : (e.message || "Couldn't unlock"); }
      } }, "Unlock with Face ID");
      view.append(h("div", { class: "login card stack" },
        h("div", { class: "mark" }, "R"),
        h("h1", { class: "center" }, "Signed in as " + session.username),
        h("p", { class: "muted center" }, "Unlock with Face ID, Touch ID or this device's passcode."),
        go, err,
        h("button", { class: "full", onclick: () => signOut() }, "Sign in as someone else")));
    },

    login(note) {
      const user = h("input", { autocomplete: "username", autocapitalize: "none", placeholder: "Username" });
      const pin = h("input", { type: "password", inputmode: "numeric", autocomplete: "current-password", placeholder: "PIN" });
      const err = h("div", { class: "err" }, note || "");
      const go = h("button", { class: "primary full", onclick: submit }, "Sign in");
      async function submit() {
        go.disabled = true; err.textContent = "";
        try {
          const r = await api("rpl_mobile_login", { p_username: user.value.trim(), p_pin: pin.value, p_device: device });
          if (r && r.error) throw new ApiError(r.error);
          session = { token: r.token, username: r.username, role: r.role, ultra: !!r.ultra, home: r.branch_code, branches: r.branches || [],
            permissions: Array.isArray(r.permissions) ? r.permissions : null };
          store("rpl-staff-session", session);
          branch = session.branches.some((b) => b.code === branch) ? branch : session.home;
          store("rpl-staff-branch", branch);
          render(TABS.find(([, , , ok]) => ok())[0]);
        } catch (e) { err.textContent = e.message; go.disabled = false; }
      }
      pin.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
      view.append(h("div", { class: "login card stack" },
        h("div", { class: "mark" }, "R"),
        h("h1", { class: "center" }, (config.name || "RPL Retail") + " staff"),
        h("p", { class: "muted center" }, "Sign in with your usual username and PIN."),
        user, pin, go, err,
        h("p", { class: "muted center small" }, "On iPhone: Share → Add to Home Screen to keep it like an app.")));
    },

    async sell() {
      view.append(h("h1", {}, "New sale"));
      const products = await api("rpl_mobile_catalog", { p_token: session.token, p_branch: branch });
      const search = h("input", { placeholder: "Find a product, SKU or barcode", type: "search" });
      const results = h("div", { class: "card list" });
      const basket = h("div");
      function showResults() {
        const q = search.value.trim().toLowerCase();
        results.textContent = "";
        const found = products.filter((p) => !q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.barcode || "") === q).slice(0, 40);
        if (!found.length) results.append(h("div", { class: "muted" }, products.length ? "Nothing matches." : "Nothing in stock here."));
        for (const p of found) {
          results.append(h("div", { class: "item", onclick: () => { add(p); } },
            h("div", { class: "grow" }, h("div", {}, p.name), h("div", { class: "muted" }, p.sku + (p.service ? " · service" : " · " + p.qty + " available"))),
            h("div", { class: "money" }, money(p.price)), h("button", { "aria-label": "Add " + p.name }, "+")));
        }
      }
      function add(p) {
        const line = cart.lines.find((l) => l.id === p.id);
        if (line) line.qty += 1; else cart.lines.push({ id: p.id, name: p.name, sku: p.sku, price: p.price, qty: 1, max: p.service ? Infinity : p.qty });
        cart.request = null; showBasket(); toast(p.name + " added");
      }
      function showBasket() {
        basket.textContent = "";
        if (!cart.lines.length) return;
        const box = h("div", { class: "card" }, h("h2", {}, "Basket"));
        for (const l of cart.lines) {
          box.append(h("div", { class: "item row" },
            h("div", { class: "grow" }, h("div", {}, l.name), h("div", { class: "muted" }, money(l.price) + " each")),
            h("div", { class: "qty" },
              h("button", { onclick: () => { l.qty -= 1; if (l.qty <= 0) cart.lines.splice(cart.lines.indexOf(l), 1); cart.request = null; showBasket(); } }, "−"),
              h("span", {}, l.qty),
              h("button", { onclick: () => { if (l.qty < l.max) { l.qty += 1; cart.request = null; showBasket(); } else toast("Only " + l.max + " available"); } }, "+"))));
        }
        const field = (key, label, attrs) => {
          const input = h("input", { value: cart.customer[key], ...attrs });
          input.addEventListener("input", () => { cart.customer[key] = input.value; cart.request = null; });
          return [h("label", {}, label), input];
        };
        const delivery = h("input", { type: "number", inputmode: "decimal", min: "0", step: "0.01", value: cart.delivery || "" });
        delivery.addEventListener("input", () => { cart.delivery = Number(delivery.value) || 0; cart.request = null; totalEl.textContent = money(total()); });
        const totalEl = h("span", {}, money(total()));
        box.append(
          h("h2", {}, "Customer (optional over the counter)"),
          ...field("name", "Name"), ...field("phone", "Phone", { inputmode: "tel" }),
          ...field("email", "Email", { type: "email", inputmode: "email" }), ...field("address", "Delivery address"),
          h("label", {}, "Delivery fee"), delivery,
          h("div", { class: "total" }, h("span", {}, "Total"), totalEl),
          h("div", { class: "stack" },
            can("take_payments") ? h("button", { class: "gold full", onclick: () => place("charge") }, "Charge now") : null,
            h("button", { class: "primary full", onclick: () => place("order") }, "Create order, pay later"),
            h("button", { class: "full", onclick: () => place("quote") }, "Save as quote"),
            h("button", { class: "full danger", onclick: () => { cart.lines = []; cart.request = null; showBasket(); } }, "Clear")));
        basket.append(box);
      }
      function total() { return cart.lines.reduce((s, l) => s + l.qty * l.price, 0) + (cart.delivery || 0); }
      async function place(how) {
        cart.request = cart.request || uuid();
        const args = { p_token: session.token, p_branch: branch, p_lines: cart.lines.map((l) => ({ item_id: l.id, qty: l.qty, unit_price: l.price })),
          p_customer: cart.customer, p_delivery: cart.delivery || 0, p_request_id: cart.request };
        try {
          if (how === "quote") {
            const r = await api("rpl_mobile_create_quote", { ...args, p_discount: 0 });
            toast("Quote " + r.quote_number + " saved");
          } else {
            const r = await api("rpl_mobile_create_order", args);
            toast("Order " + r.order_number + " created");
            if (how === "charge") {
              const orders = await api("rpl_mobile_orders", { p_token: session.token, p_branch: branch, p_limit: 20 });
              const made = orders.find((o) => o.order_number === r.order_number);
              if (made) payment(made, () => render("orders"));
            }
          }
          cart.lines = []; cart.customer = { name: "", phone: "", email: "", address: "" }; cart.delivery = 0; cart.request = null;
          showBasket();
        } catch (e) { toast(e.maybeDone ? e.message + " (check Orders before trying again)" : e.message, 4000); }
      }
      search.addEventListener("input", showResults);
      view.append(search, h("div", { style: "height:8px" }), results, basket);
      showResults(); showBasket();
    },

    async orders() {
      view.append(h("h1", {}, "Orders"));
      const seg = h("div", { class: "seg" });
      const box = h("div");
      const all = await api("rpl_mobile_orders", { p_token: session.token, p_branch: branch, p_limit: 100 });
      const groups = [["Awaiting payment", (o) => o.status === "payment_pending"], ["Owing", (o) => o.status === "invoiced" && o.balance > 0.004],
        ["Paid", (o) => o.status === "invoiced" && !(o.balance > 0.004)], ["Deleted", (o) => o.status === "cancelled"]];
      let pick = 0;
      function show() {
        seg.textContent = ""; box.textContent = "";
        groups.forEach(([label, test], i) => seg.append(h("button", { class: i === pick ? "on" : "", onclick: () => { pick = i; show(); } },
          label + " (" + all.filter(test).length + ")")));
        const list = all.filter(groups[pick][1]);
        if (!list.length) box.append(h("div", { class: "card muted" }, "None."));
        for (const o of list) box.append(orderCard(o));
      }
      view.append(seg, box);
      show();
    },

    async web() {
      view.append(h("h1", {}, "Web orders"), h("p", { class: "muted" }, "Call the customer first, then accept or reject. Send the Paynow link from a PC or the Android app."));
      const orders = await api("rpl_mobile_web_orders", { p_token: session.token });
      if (!orders.length) view.append(h("div", { class: "card muted" }, "No web orders."));
      for (const w of orders) {
        const waiting = w.status === "new" || w.status === "waiting" || w.status === "pending";
        const card = h("div", { class: "card" },
          h("div", { class: "row" }, h("b", { class: "grow" }, w.number + " · " + w.name), h("span", { class: "pill " + (waiting ? "warn" : w.status === "rejected" ? "bad" : "good") }, w.status)),
          h("div", { class: "muted" }, [w.phone, w.branch, w.address].filter(Boolean).join(" · ")),
          ...(w.lines || []).map((l) => h("div", { class: "row small" }, h("span", { class: "grow" }, l.qty + " × " + l.name), h("span", { class: "money" }, money(l.qty * l.price)))),
          h("div", { class: "total" }, h("span", {}, "Total"), h("span", {}, money(w.total))),
          w.note ? h("p", { class: "muted" }, "Note: " + w.note) : null,
          w.reason ? h("p", { class: "muted" }, "Reason: " + w.reason) : null);
        if (waiting) {
          card.append(h("div", { class: "row" },
            w.phone ? h("a", { href: "tel:" + w.phone.replace(/[^\d+]/g, "") }, h("button", {}, "Call")) : null,
            w.phone ? h("a", { href: "https://wa.me/" + w.phone.replace(/\D/g, "").replace(/^0/, "263") }, h("button", {}, "WhatsApp")) : null,
            h("button", { class: "primary grow", onclick: async () => {
              try { await api("rpl_mobile_web_order_accept", { p_token: session.token, p_id: w.id }); toast("Accepted: it's an order now"); render("web"); }
              catch (e) { toast(e.message, 4000); } } }, "Accept"),
            h("button", { class: "danger", onclick: async () => {
              const reason = prompt("Why can't it be filled?"); if (!reason) return;
              try { await api("rpl_mobile_web_order_reject", { p_token: session.token, p_id: w.id, p_reason: reason }); toast("Rejected"); render("web"); }
              catch (e) { toast(e.message, 4000); } } }, "Reject")));
        }
        view.append(card);
      }
    },

    async reports() {
      view.append(h("h1", {}, "Reports"));
      const seg = h("div", { class: "seg" });
      const box = h("div");
      const full = can("screen:Reports");
      const periods = [["today", "Today"], ["week", "This week"], ["month", "This month"]].concat(full ? [["year", "This year"]] : []);
      let period = "today";
      async function show() {
        seg.textContent = ""; box.textContent = "Loading…";
        periods.forEach(([k, label]) => seg.append(h("button", { class: k === period ? "on" : "", onclick: () => { period = k; show(); } }, label)));
        try {
          const r = await api("rpl_mobile_report", { p_token: session.token, p_branch: branch, p_period: period, p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
          box.textContent = "";
          const stat = (label, value) => h("div", { class: "card" }, h("span", { class: "muted" }, label), h("b", {}, value));
          const me = r.me;
          if (me && (!full || me.invoices > 0)) {
            const pct = (a, b) => (b ? Math.round((a - b) / b * 1000) / 10 : null);
            const change = pct(me.sales, me.previous);
            box.append(h("div", { class: "card" }, h("span", { class: "muted" }, "Your sales"),
              h("div", { class: "total" }, h("span", {}, money(me.sales - me.returns)),
                change === null ? null : h("span", { class: "pill " + (change >= 0 ? "good" : "bad") }, (change >= 0 ? "▲ " : "▼ ") + Math.abs(change) + "%")),
              r.sales > 0 ? h("div", { class: "muted" }, Math.round(me.sales / r.sales * 100) + "% of the branch's sales") : null),
              h("div", { class: "stat" }, stat("Sales made", me.invoices), stat("Average sale", money(me.invoices ? me.sales / me.invoices : 0)),
                stat("Payments you took", money(me.payments_taken)), stat("Returned", money(me.returns))));
            if ((me.top_products || []).length) {
              box.append(h("h2", {}, "What you sold"), h("div", { class: "card list" },
                me.top_products.map((p) => h("div", { class: "item" }, h("span", { class: "grow" }, p.units + " × " + p.name), h("span", { class: "money" }, money(p.revenue))))));
            }
            box.append(h("h2", {}, full ? "The whole picture" : "Your branch"));
          }
          const has = (v) => v !== null && v !== undefined;
          box.append(h("div", { class: "stat" },
            stat("Sales", money(r.sales)), stat("Net revenue", money(r.net_revenue)),
            has(r.gross_profit) ? stat("Gross profit", money(r.gross_profit)) : null, has(r.net_profit) ? stat("Net profit", money(r.net_profit)) : null,
            stat("Invoices", r.invoices), has(r.expenses) ? stat("Expenses", money(r.expenses)) : null,
            r.balances ? stat("Cash at hand", money(r.balances.cash_at_hand)) : null,
            r.owed ? stat("Owed to you", money(r.owed.total)) : null));
          if ((r.payment_mix || []).length) {
            box.append(h("h2", {}, "How it was paid"), h("div", { class: "card list" },
              r.payment_mix.map((m) => h("div", { class: "item" }, h("span", { class: "grow" }, METHOD_LABEL[m.method] || m.method), h("span", { class: "money" }, money(m.amount))))));
          }
          if ((r.top_products || []).length) {
            box.append(h("h2", {}, "Best sellers"), h("div", { class: "card list" },
              r.top_products.map((p) => h("div", { class: "item" }, h("span", { class: "grow" }, p.units + " × " + p.name), h("span", { class: "money" }, money(p.revenue))))));
          }
        } catch (e) { box.textContent = ""; box.append(h("div", { class: "card err" }, e.message)); }
      }
      view.append(seg, box);
      show();
    },

    async photos() {
      if (TOOLS.some(([k, , , ok]) => k !== "photos" && ok())) view.append(back());
      view.append(h("h1", {}, "Product photos"), h("p", { class: "muted" }, "A clear photo on a plain background, in good light, sells best."));
      const products = await api("rpl_mobile_photo_products", { p_token: session.token, p_branch: branch });
      const list = h("div", { class: "card list" });
      for (const p of products) {
        const file = h("input", { type: "file", accept: "image/*", hidden: true });
        file.addEventListener("change", async () => {
          if (!file.files[0]) return;
          try {
            const jpeg = await shrink(file.files[0], 1000, 0.8);
            await api("rpl_mobile_product_photo", { p_token: session.token, p_item_id: p.id, p_data: jpeg });
            toast("Photo saved: the shop page shows it now"); render("photos");
          } catch (e) { toast(e.message, 4000); }
        });
        list.append(h("div", { class: "item" },
          h("div", { class: "thumb" }, p.has_photo ? "✓" : "📷"),
          h("div", { class: "grow" }, h("div", {}, p.name), h("div", { class: "muted" }, [p.sku, p.coming_soon ? "Coming soon" : null, p.has_photo ? "has a photo" : "no photo yet"].filter(Boolean).join(" · "))),
          h("button", { onclick: () => file.click() }, "Photo"), file));
      }
      view.append(list);
    },

    tools() {
      view.append(h("h1", {}, "Tools"));
      const list = h("div", { class: "card list" });
      for (const [key, icon, label, ok] of TOOLS) {
        if (!ok()) continue;
        list.append(h("div", { class: "item", onclick: () => render(key) }, h("div", { class: "thumb" }, icon), h("div", { class: "grow" }, label), h("span", { class: "muted" }, "›")));
      }
      view.append(list);
    },

    async approvals() {
      view.append(back(), h("h1", {}, "Approvals"));
      const found = await api("rpl_mobile_approvals", { p_token: session.token, p_branch: branch });
      const items = [];
      for (const po of found.purchase_orders || []) items.push(["approve_po", "po_id", po, "Order from " + po.supplier, (l) => l.qty * l.unit_cost]);
      for (const r of found.receipts || []) items.push(["approve_receipt", "receipt_id", r, "Delivery from " + r.supplier + (r.po_number ? " · " + r.po_number : ""), (l) => l.qty * (l.landed || 0)]);
      for (const j of found.journals || []) items.push(["approve_journal", "journal_id", j, String(j.reason || "").replace(/_/g, " ") + (j.note ? ": " + j.note : ""), (l) => l.qty * l.unit_cost]);
      if (!items.length) view.append(h("div", { class: "card muted" }, "Nothing waits for you."));
      for (const [kind, key, it, title, worth] of items) {
        const lines = it.lines || [];
        const card = h("div", { class: "card" },
          h("div", { class: "row" }, h("b", { class: "grow" }, it.number), it.asked ? h("span", { class: "pill warn" }, "sent") : null),
          h("div", {}, title), h("div", { class: "muted" }, [it.by, it.created_at && new Date(it.created_at).toLocaleString()].filter(Boolean).join(" · ")),
          ...lines.map((l) => h("div", { class: "row small" }, h("span", { class: "grow" }, l.qty + " × " + l.name), h("span", { class: "money" }, money(worth(l))))),
          h("div", { class: "total" }, h("span", {}, "Value"), h("span", {}, money(lines.reduce((s, l) => s + worth(l), 0)))));
        if (!it.asked) {
          const decide = async (approve) => {
            const note = approve ? "" : prompt("Why not?");
            if (!approve && !note) return;
            try { await ask(kind, { [key]: it.id, decision: approve ? "approve" : "reject", note }, it.number + (approve ? " approval" : " rejection") + " sent"); render("approvals"); }
            catch (e) { toast(e.message, 4000); }
          };
          card.append(h("div", { class: "row" }, h("button", { class: "primary grow", onclick: () => decide(true) }, "Approve"),
            h("button", { class: "danger", onclick: () => decide(false) }, "Reject")));
        }
        view.append(card);
      }
      const reqs = await requestsCard(["approve_po", "approve_receipt", "approve_journal"]); if (reqs) view.append(reqs);
    },

    async pos() {
      view.append(back(), h("h1", {}, "Purchase orders"), h("button", { class: "primary full", onclick: newOrder }, "New purchase order"), h("div", { style: "height:10px" }));
      const orders = await api("rpl_mobile_purchase_orders", { p_token: session.token, p_branch: branch });
      if (!orders.length) view.append(h("div", { class: "card muted" }, "No open orders."));
      for (const po of orders) {
        const lines = po.lines || [];
        const receivable = po.status === "ordered" && po.approval === "approved" && !po.awaiting_receipt;
        view.append(h("div", { class: "card" },
          h("div", { class: "row" }, h("b", { class: "grow" }, po.number + " · " + po.supplier),
            h("span", { class: "pill " + (po.approval === "approved" ? "good" : "warn") }, po.awaiting_receipt ? "delivery waits" : po.approval || po.status)),
          ...lines.map((l) => h("div", { class: "row small" }, h("span", { class: "grow" }, l.qty + " × " + l.name), h("span", { class: "money" }, money(l.qty * l.unit_cost)))),
          h("div", { class: "small " + (po.shipment ? "muted" : receivable ? "warn" : "muted") },
            po.shipment ? "Consignment " + po.shipment : receivable ? "On no consignment: add it from Consignments → its consignment → Orders…, then receive it" : "On no consignment"),
          // Consignment first: received once it is on its consignment.
          receivable && po.shipment ? h("button", { class: "gold full", onclick: () => receive(po) }, "Receive") : null,
          po.shipment_id && can("screen:Consignments")
            ? h("button", { class: "full", onclick: () => consignmentReport(po.shipment_id, po.shipment) }, "Consignment report") : null));
      }
      const reqs = await requestsCard(["receive_po", "create_po"]); if (reqs) view.append(reqs);
    },

    // Consignment first: record it, add its purchase orders, then receive them.
    async consignments() {
      const mayEdit = can("screen:Consignments/New and edit consignments");
      view.append(back(), h("h1", {}, "Consignments"),
        mayEdit ? h("button", { class: "primary full", onclick: newConsignment }, "+ New consignment") : null, h("div", { style: "height:10px" }));
      const list = await api("rpl_mobile_consignments", { p_token: session.token });
      if (!list.length) view.append(h("div", { class: "card muted" }, "No consignments yet."));
      for (const c of list) {
        view.append(h("div", { class: "card" },
          h("div", { class: "row" }, h("b", { class: "grow" }, c.number), h("span", { class: "muted small" }, String(c.arrived || "").slice(0, 10))),
          h("div", { class: "muted small" }, [c.supplier, c.debit_note && "debit note " + c.debit_note].filter(Boolean).join(" · ")),
          h("div", { class: "small " + ((c.orders || []).length ? "" : "warn") },
            (c.orders || []).length ? "Orders " + c.orders.map((o) => o.number).join(", ") : "No purchase orders on it yet"),
          h("div", { class: "row" },
            mayEdit ? h("button", { class: "grow", onclick: () => consignmentOrders(c) }, "Orders…") : null,
            h("button", { class: "grow", onclick: () => consignmentReport(c.id, c.number) }, "Report"))));
      }
      const reqs = await requestsCard(["create_consignment", "consignment_orders"]); if (reqs) view.append(reqs);
    },

    async count() {
      view.append(back(), h("h1", {}, "Stock take"), h("p", { class: "muted" }, "Type what is on the shelf. A shop PC raises the count for approval; nothing moves until it is approved."));
      const items = await api("rpl_mobile_count_items", { p_token: session.token, p_branch: branch });
      const counted = {};
      const search = h("input", { type: "search", placeholder: "Find a product, SKU or barcode" });
      const list = h("div", { class: "card list" });
      const send = h("button", { class: "gold full" }, "Send the count");
      function show() {
        const q = search.value.trim().toLowerCase();
        list.textContent = "";
        for (const it of items.filter((i) => !q || i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q) || i.barcode === q).slice(0, 60)) {
          const box = h("input", { type: "number", inputmode: "decimal", min: "0", step: "1", value: counted[it.id] ?? "", style: "width:90px", "aria-label": "Counted " + it.name });
          box.addEventListener("input", () => { if (box.value === "") delete counted[it.id]; else counted[it.id] = Number(box.value); label(); });
          list.append(h("div", { class: "item" }, h("div", { class: "grow" }, h("div", {}, it.name), h("div", { class: "muted" }, it.sku + " · books say " + it.on_hand)), box));
        }
      }
      function label() { send.textContent = "Send the count (" + Object.keys(counted).length + ")"; }
      send.addEventListener("click", async () => {
        const counts = Object.entries(counted).map(([item_id, n]) => ({ item_id, counted: n }));
        if (!counts.length) { toast("Count something first"); return; }
        try { await ask("stock_take", { counts }, "Count of " + counts.length + " product(s) sent"); render("count"); } catch (e) { toast(e.message, 4000); }
      });
      search.addEventListener("input", show);
      view.append(search, h("div", { style: "height:8px" }), list, send);
      show(); label();
      const reqs = await requestsCard(["stock_take"]); if (reqs) view.append(reqs);
    },

    async lookup() {
      view.append(back(), h("h1", {}, "Stock lookup"));
      const mayPrice = can("change_prices");
      const search = h("input", { type: "search", placeholder: "Name, SKU or barcode (2 letters or more)" });
      const box = h("div");
      async function find() {
        if (search.value.trim().length < 2) return;
        box.textContent = "Looking…";
        try {
          const lines = await api("rpl_mobile_stock_lookup", { p_token: session.token, p_query: search.value.trim() });
          box.textContent = "";
          if (!lines.length) box.append(h("div", { class: "card muted" }, "Nothing matches."));
          for (const l of lines) {
            const margin = l.cost !== null && l.cost !== undefined && l.price > 0 ? Math.round((l.price - l.cost) / l.price * 1000) / 10 : null;
            box.append(h("div", { class: "card", onclick: mayPrice ? () => price(l, find) : null },
              h("div", { class: "row" }, h("b", { class: "grow" }, l.name), h("span", { class: "money" }, money(l.price))),
              h("div", { class: "muted" }, l.branch + " · " + l.sku),
              h("div", {}, "On hand " + l.on_hand + (l.held > 0 ? " · held " + l.held : "") + (l.on_order > 0 ? " · on order " + l.on_order : "")),
              margin !== null ? h("div", { class: "muted" }, "Cost " + money(l.cost) + " · margin " + margin + "%" + (l.target ? " · target " + l.target + "%" : "")) : null,
              mayPrice ? h("div", { class: "muted" }, "Tap to change the price") : null));
          }
        } catch (e) { box.textContent = ""; box.append(h("div", { class: "card err" }, e.message)); }
      }
      search.addEventListener("keydown", (e) => { if (e.key === "Enter") find(); });
      view.append(h("div", { class: "row" }, h("div", { class: "grow" }, search), h("button", { class: "primary", onclick: find }, "Find")), h("div", { style: "height:8px" }), box);
      if (mayPrice) { const reqs = await requestsCard(["change_price"]); if (reqs) view.append(reqs); }
    },

    async expense() {
      view.append(back(), h("h1", {}, "Record an expense"));
      const types = ["Rent", "Transport", "Advertising", "Wages", "Airtime", "Electricity", "Other"];
      const type = h("select", {}, types.map((t) => h("option", { value: t }, t)));
      const other = h("input", { placeholder: "What it was", hidden: true });
      type.addEventListener("change", () => { other.hidden = type.value !== "Other"; });
      const amount = h("input", { type: "number", inputmode: "decimal", min: "0", step: "0.01", placeholder: "0.00" });
      const paid = h("select", {}, [["cash", "Cash (till)"], ["bank", "Bank"], ["ecocash", "EcoCash"], ["other", "Other"]].map(([k, v]) => h("option", { value: k }, v)));
      const note = h("input", { placeholder: "Optional" });
      const file = h("input", { type: "file", accept: "image/*", capture: "environment" });
      const go = h("button", { class: "gold full" }, "Send");
      go.addEventListener("click", async () => {
        const what = type.value === "Other" ? other.value.trim() : type.value;
        const value = Number(amount.value);
        if (!what || !(value > 0)) { toast("Say what it was for and how much"); return; }
        go.disabled = true;
        try {
          const photo = file.files[0] ? await shrink(file.files[0], 1400, 0.75) : "";
          await ask("record_expense", { type: what, amount: value, paid_with: paid.value, note: note.value.trim(), photo },
            what + " " + money(value) + " sent" + (photo ? " with its receipt" : ""));
          render("expense");
        } catch (e) { toast(e.message, 4000); go.disabled = false; }
      });
      view.append(h("div", { class: "card stack" }, h("label", {}, "What for"), type, other, h("label", {}, "Amount (USD)"), amount,
        h("label", {}, "Paid with"), paid, h("label", {}, "Note"), note, h("label", {}, "Photo of the receipt or slip"), file, go));
      const reqs = await requestsCard(["record_expense"]); if (reqs) view.append(reqs);
    },

    async more() {
      view.append(h("h1", {}, "More"),
        h("div", { class: "card stack" },
          h("div", {}, "Signed in as ", h("b", {}, session.username), " (" + (session.ultra ? "Ultra Admin" : session.role.replace("_", " ")) + ")"),
          h("div", { class: "muted" }, "Branch " + branch),
          h("button", { class: "full", onclick: () => signOut() }, "Sign out")));
      view.append(h("div", { class: "card stack" },
        h("b", {}, "Practice"),
        h("div", { class: "muted" }, "Sell, take payments and return on today's real products, with nothing reaching the shop. What you do in practice stays on this iPad and goes when you end it."),
        practice.on ? h("button", { class: "danger full", onclick: () => { practiceStop(); toast("Practice over: back to the real shop"); render("more"); } }, "End practice")
          : h("button", { class: "primary full", onclick: () => { practiceStart(); toast("Practice: nothing here reaches the shop"); render("sell"); } }, "Start practice")));
      if (await faceIdAvailable()) {
        const on = !!lockOn();
        view.append(h("div", { class: "card stack" },
          h("b", {}, "Face ID unlock"),
          h("div", { class: "muted" }, on ? "On: the app asks for Face ID (or Touch ID) on opening and after five minutes away."
            : "Ask for Face ID (or Touch ID) on opening and after five minutes away, so no one else works as you."),
          on ? h("div", { class: "row" },
            h("button", { class: "grow", onclick: () => { locked = true; render("lock"); } }, "Lock now"),
            h("button", { class: "danger", onclick: () => { forget(LOCK_KEY); toast("Face ID unlock is off"); render("more"); } }, "Turn off"))
            : h("button", { class: "primary full", onclick: async () => {
                try { await turnOnFaceId(); toast("Face ID unlock is on"); render("more"); }
                catch (e) { toast(e.name === "NotAllowedError" ? "Face ID wasn't set up" : (e.message || "Couldn't turn it on"), 4000); }
              } }, "Turn on Face ID unlock")));
      }
      if (session.ultra) {
        const users = await api("rpl_mobile_users", { p_token: session.token });
        const list = h("div", { class: "card list" });
        for (const u of users) {
          list.append(h("div", { class: "item" },
            h("div", { class: "grow" }, h("div", {}, u.username + (u.me ? " (you)" : "")), h("div", { class: "muted" }, u.role.replace("_", " ") + " · " + u.branch_code)),
            h("span", { class: "pill " + (u.status === "active" ? "good" : "bad") }, u.status || "active"),
            u.me ? null : h("button", { onclick: async () => {
              const on = (u.status || "active") === "active";
              if (!confirm((on ? "Switch off " : "Switch on ") + u.username + "?")) return;
              try { await api("rpl_mobile_set_user_status", { p_token: session.token, p_user_id: u.id, p_status: on ? "off" : "active", p_pin: null }); render("more"); }
              catch (e) { toast(e.message, 4000); } } }, (u.status || "active") === "active" ? "Switch off" : "Switch on")));
        }
        view.append(h("h2", {}, "Users"), list);
      }
      view.append(h("p", { class: "muted small" }, "EcoCash and InnBucks prompts and pay links: use a shop PC or the Android app. Payments taken there show here."));
    },
  };

  function back() { return h("button", { class: "full", style: "margin-bottom:10px", onclick: () => render("tools") }, "‹ Tools"); }

  // A new consignment, recorded by a shop PC (never a number already used).
  async function newConsignment() {
    const f = (placeholder, type) => h("input", Object.assign({ placeholder }, type ? { type, inputmode: "decimal", step: "0.01" } : {}));
    const number = f("Consignment number"), supplier = f("Supplier"), agent = f("Clearing agent"), debit = f("Agent's debit note"),
      boe = f("Bill of entry"), duty = f("Duty (all of it)", "number"), freight = f("Freight and clearing (all of it)", "number");
    const arrival = h("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
    const sheet = sheetWith("New consignment", number, h("label", {}, "Arrived"), arrival, supplier, agent, debit, boe, duty, freight,
      h("p", { class: "muted small" }, "Its duty and freight are shared over its purchase orders by value. Add them next with Orders…."),
      h("button", { class: "gold full", onclick: async () => {
        const n = number.value.trim().toUpperCase();
        if (!n) { toast("Give the consignment its number"); return; }
        try {
          if (await api("rpl_mobile_consignment_taken", { p_token: session.token, p_number: n })) { toast("There is already a consignment " + n, 4000); return; }
          await ask("create_consignment", { number: n, arrival: arrival.value, supplier: supplier.value.trim(), agent: agent.value.trim(),
            debit_note: debit.value.trim(), boe: boe.value.trim(), duty: Number(duty.value) || 0, freight: Number(freight.value) || 0 }, "Consignment " + n + " sent");
          sheet.remove(); render("consignments");
        } catch (e) { toast(e.message, 4000); }
      } }, "Send"));
  }

  // The purchase orders a consignment brings: those ticked go on it, the others come off.
  async function consignmentOrders(c) {
    let orders = [];
    try { orders = await api("rpl_mobile_purchase_orders", { p_token: session.token, p_branch: branch }); } catch (e) { toast(e.message, 4000); return; }
    const choices = orders.filter((o) => o.approval !== "not_approved" && (!o.shipment_id || o.shipment_id === c.id));
    const elsewhere = (c.orders || []).filter((o) => !choices.some((x) => x.id === o.id));
    const on = new Set((c.orders || []).map((o) => o.id));
    const row = (id, label) => {
      const box = h("input", { type: "checkbox" }); box.checked = on.has(id);
      box.addEventListener("change", () => { if (box.checked) on.add(id); else on.delete(id); });
      return h("label", { class: "row" }, box, h("span", { class: "grow" }, label));
    };
    const sheet = sheetWith(c.number + ": its purchase orders",
      ...choices.map((o) => row(o.id, o.number + " · " + o.supplier)),
      ...elsewhere.map((o) => row(o.id, o.number + " (another branch)")),
      !choices.length && !elsewhere.length ? h("div", { class: "muted" }, "No purchase orders to add at " + branch + ".") : null,
      h("button", { class: "gold full", onclick: async () => {
        try { await ask("consignment_orders", { shipment_id: c.id, order_ids: [...on] }, c.number + ": its orders sent"); sheet.remove(); render("consignments"); }
        catch (e) { toast(e.message, 4000); }
      } }, "Send"));
  }

  // A consignment from start to now, as a shop PC's Consignment Report.
  async function consignmentReport(id, number) {
    let r;
    try { r = await api("rpl_mobile_consignment_report", { p_token: session.token, p_shipment_id: id }); } catch (e) { toast(e.message, 4000); return; }
    const sum = (k) => r.rows.reduce((t, row) => t + (row[k] || 0), 0);
    const kids = [h("div", { class: "muted small" }, [r.supplier, "arrived " + String(r.arrival || "").slice(0, 10)].filter(Boolean).join(" · ")),
      h("div", { class: "small" }, r.orders.length ? "Orders " + r.orders.join(", ") : "No purchase orders on it yet")];
    if (r.money) {
      const landed = sum("landed"), taken = sum("revenue"), margin = taken - sum("cost_of_sold");
      kids.push(
        h("div", { class: "row" }, h("span", { class: "grow muted" }, "Landed (duty " + money(r.duty) + ", freight " + money(r.freight) + ")"), h("b", {}, money(landed))),
        h("div", { class: "row" }, h("span", { class: "grow muted" }, "Taken from sales"), h("b", {}, money(taken))),
        h("div", { class: "row" }, h("span", { class: "grow muted" }, "Margin on what sold"), h("b", {}, money(margin))),
        h("div", { class: "row" }, h("span", { class: "grow muted" }, "Still on the shelf"), h("b", {}, money(sum("value_left")))),
        h("div", { class: "small " + (taken >= landed ? "good" : "warn") }, taken >= landed ? "Paid for itself: " + money(taken - landed) + " over its landed cost" : money(landed - taken) + " still to take before it has paid for itself"),
        h("div", { class: "row" }, h("span", { class: "grow muted" }, "Projected takings (all " + r.orders.length + " order(s), today's prices)"), h("b", {}, money(sum("projected_revenue")))),
        h("div", { class: "row" }, h("span", { class: "grow muted" }, "Projected margin"), h("b", {}, money(sum("projected_margin")))));
    }
    for (const row of r.rows) {
      kids.push(h("div", { class: "card" }, h("b", {}, row.name || row.sku),
        h("div", { class: "small" }, "Ordered " + row.ordered + " · received " + row.received + " · sold " + row.sold + (row.written_off ? " · written off " + row.written_off : "") + " · left " + row.left + (row.to_come ? " · to come " + row.to_come : "")),
        r.money ? h("div", { class: "muted small" }, "Landed " + money(row.received ? row.landed / row.received : 0) + " each · took " + money(row.revenue) + " · margin " + money(row.revenue - row.cost_of_sold)) : null));
    }
    sheetWith((number || r.number) + ": report", ...kids);
  }

  function sheetWith(title, ...kids) {
    const sheet = h("div", { class: "sheet", onclick: (e) => { if (e.target === sheet) sheet.remove(); } });
    sheet.append(h("div", { class: "panel stack" }, h("h2", {}, title), ...kids, h("button", { class: "full", onclick: () => sheet.remove() }, "Cancel")));
    document.body.append(sheet);
    return sheet;
  }

  function price(l, again) {
    const box = h("input", { type: "number", inputmode: "decimal", step: "0.01", value: Number(l.price).toFixed(2) });
    const hint = h("div", { class: "muted" });
    const update = () => {
      const p = Number(box.value);
      hint.textContent = l.cost !== null && l.cost !== undefined && p > 0 ? "Margin " + Math.round((p - l.cost) / p * 1000) / 10 + "%" + (p < l.cost ? " — below cost" : "") : "";
    };
    box.addEventListener("input", update); update();
    const suggest = l.cost > 0 && l.target > 0 ? Math.ceil(l.cost / (1 - l.target / 100) / 0.5 - 1e-9) * 0.5 : null;
    const sheet = sheetWith("New price · " + l.name, h("div", { class: "muted" }, l.branch + ", now " + money(l.price)), box, hint,
      suggest ? h("button", { class: "full", onclick: () => { box.value = suggest.toFixed(2); update(); } }, "Use " + money(suggest) + " (the target margin)") : null,
      h("button", { class: "gold full", onclick: async () => {
        const p = Number(box.value);
        if (!(p > 0)) return;
        try { await ask("change_price", { item_id: l.id, price: p }, l.name + ": new price " + money(p) + " sent"); sheet.remove(); again(); }
        catch (e) { toast(e.message, 4000); }
      } }, "Send"));
  }

  // A delivery, into the order's consignment (consignment first: put on it from the consignment).
  function receive(po) {
    const rows = (po.lines || []).map((l) => {
      const qty = h("input", { type: "number", inputmode: "decimal", value: l.qty });
      const cost = h("input", { type: "number", inputmode: "decimal", step: "0.01", value: l.unit_cost });
      return [l, qty, cost];
    });
    const sheet = sheetWith("Receive " + po.number,
      h("b", {}, "Consignment " + po.shipment),
      h("p", { class: "muted small" }, "What arrived, at what cost. Its consignment's duty and freight are shared over the lines by value. A shop PC raises it for approval."),
      ...rows.map(([l, qty, cost]) => h("div", { class: "card" }, h("b", {}, l.name), h("div", { class: "row" },
        h("div", { class: "grow" }, h("label", {}, "Qty"), qty), h("div", { class: "grow" }, h("label", {}, "Unit cost"), cost)))),
      h("button", { class: "gold full", onclick: async () => {
        const lines = rows.map(([l, qty, cost]) => ({ line_id: l.id, qty: Number(qty.value), unit_cost: Number(cost.value), duty: 0, freight: 0 }));
        try { await ask("receive_po", { po_id: po.id, shipment_id: po.shipment_id, lines }, "Delivery of " + po.number + " sent"); sheet.remove(); render("pos"); }
        catch (e) { toast(e.message, 4000); }
      } }, "Send"));
  }

  function newOrder() {
    const supplier = h("input", { placeholder: "Supplier" });
    const lines = h("div");
    const addLine = () => lines.append(h("div", { class: "card stack" },
      h("input", { placeholder: "SKU", class: "sku" }), h("input", { placeholder: "Product name", class: "name" }),
      h("div", { class: "row" }, h("input", { type: "number", inputmode: "decimal", placeholder: "Qty", class: "qty" }),
        h("input", { type: "number", inputmode: "decimal", step: "0.01", placeholder: "Unit cost", class: "cost" }))));
    addLine();
    const sheet = sheetWith("New purchase order", supplier, lines, h("button", { class: "full", onclick: addLine }, "Another line"),
      h("button", { class: "gold full", onclick: async () => {
        const got = [...lines.children].map((c) => ({ sku: c.querySelector(".sku").value.trim(), name: c.querySelector(".name").value.trim(),
          qty: Number(c.querySelector(".qty").value), unit_cost: Number(c.querySelector(".cost").value) || 0 })).filter((l) => l.sku && l.name && l.qty > 0);
        if (!supplier.value.trim() || !got.length) { toast("Give the supplier and at least one line"); return; }
        try { await ask("create_po", { supplier: supplier.value.trim(), funding: "working_capital", paid_with: "", lines: got }, "New order for " + supplier.value.trim() + " sent"); sheet.remove(); render("pos"); }
        catch (e) { toast(e.message, 4000); }
      } }, "Send"));
  }

  // --- an order, and taking payment on it ---
  function orderCard(o) {
    const pill = o.status === "cancelled" ? ["bad", "Deleted"] : o.status === "payment_pending" ? (o.paid > 0.004 ? ["warn", "Part paid"] : ["warn", "Awaiting payment"])
      : o.balance > 0.004 ? ["warn", "Owing " + money(o.balance)] : ["good", "Paid"];
    const card = h("div", { class: "card" },
      h("div", { class: "row" }, h("b", { class: "grow" }, o.order_number), h("span", { class: "pill " + pill[0] }, pill[1])),
      h("div", { class: "muted" }, [o.customer_name, o.customer_phone, new Date(o.created_at).toLocaleString(), "by " + o.created_by].filter(Boolean).join(" · ")),
      ...(o.lines || []).map((l) => h("div", { class: "row small" }, h("span", { class: "grow" }, l.qty + " × " + l.name), h("span", { class: "money" }, money(l.line_total)))),
      h("div", { class: "total" }, h("span", {}, "Total"), h("span", {}, money(o.total))),
      o.invoice_number ? h("div", { class: "muted" }, "Invoice " + o.invoice_number) : null);
    const buttons = h("div", { class: "row" });
    if (o.status !== "cancelled" && o.balance > 0.004 && can("take_payments")) buttons.append(h("button", { class: "gold grow", onclick: () => payment(o, () => render("orders")) }, "Take payment"));
    if (o.invoice_number) buttons.append(h("button", { onclick: () => invoicePdf(o) }, "Invoice PDF"));
    if (o.status === "payment_pending" && !(o.paid > 0.004)) buttons.append(h("button", { class: "danger", onclick: async () => {
      const reason = prompt("Delete " + o.order_number + "? Say why:"); if (reason === null) return;
      try { await api("rpl_mobile_delete_order", { p_token: session.token, p_order_id: o.id, p_reason: reason }); toast("Deleted"); render("orders"); }
      catch (e) { toast(e.message, 4000); } } }, "Delete"));
    if (buttons.childNodes.length) card.append(buttons);
    return card;
  }

  // ZiG and Rand, once a shop PC sets their rate: what is typed is what the
  // customer handed over in it, converted in the cloud at that rate; cash
  // beyond the balance is change. Rand is cash only. Paynow has no ZiG yet.
  const CURRENCY = { USD: "US$", ZWG: "ZiG", ZAR: "Rand" };
  const cents = (n) => Math.round(n * 100) / 100;
  const plain = (n) => Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function payment(o, done) {
    let rates = {};
    try { rates = await api("rpl_mobile_rates", { p_token: session.token }) || {}; } catch (e) { rates = {}; }
    const balance = o.balance > 0 ? o.balance : o.total;
    let currency = "USD";
    const amount = h("input", { type: "number", inputmode: "decimal", step: "0.01", value: balance.toFixed(2) });
    const method = h("select", {});
    const reference = h("input", { type: "text", maxlength: "64", placeholder: "Transaction reference (optional)" });
    const owedLine = h("div", { class: "muted" });
    const note = h("div", { class: "muted small" });
    const err = h("div", { class: "err" });
    let request = uuid();
    const fresh = () => { request = uuid(); };
    const owed = () => currency === "USD" ? balance : cents(balance * rates[currency]);
    function fillMethods() {
      const keep = method.value;
      method.replaceChildren(...METHODS.filter(([k]) => currency !== "ZAR" || k === "cash").map(([k, v]) => h("option", { value: k }, v)));
      if ([...method.options].some((op) => op.value === keep)) method.value = keep;
    }
    function show() {
      const wallet = method.value === "ecocash" || method.value === "innbucks";
      reference.style.display = wallet ? "" : "none";
      if (currency === "USD") { owedLine.textContent = "Owed " + money(balance); note.textContent = ""; return; }
      const name = CURRENCY[currency], value = Number(amount.value) || 0;
      owedLine.textContent = "Owed " + money(balance) + " · " + name + " " + plain(owed()) + " at " + rates[currency] + " per US$";
      const change = method.value === "cash" ? value - owed() : 0;
      note.textContent = value <= 0 ? "" : change > 0.004 ? "Change: " + name + " " + plain(change) + " · records " + money(balance)
        : "Records " + money(cents(value / rates[currency])) + " in the books";
      if (wallet) note.textContent += (note.textContent ? ". " : "") + "Paynow doesn't take ZiG yet: record what was already paid.";
    }
    const chips = h("div", { class: "row" });
    const codes = ["USD"].concat(["ZWG", "ZAR"].filter((c) => rates[c] > 0));
    const pick = (code) => {
      currency = code; fresh(); fillMethods(); amount.value = owed().toFixed(2);
      chips.querySelectorAll("button").forEach((b) => b.classList.toggle("gold", b.dataset.code === code));
      show();
    };
    codes.forEach((c) => chips.append(h("button", { "data-code": c, class: c === "USD" ? "gold" : "", onclick: () => pick(c) }, CURRENCY[c])));
    fillMethods();
    amount.addEventListener("input", () => { fresh(); show(); });
    method.addEventListener("change", () => { fresh(); show(); });
    const sheet = h("div", { class: "sheet", onclick: (e) => { if (e.target === sheet) sheet.remove(); } });
    const go = h("button", { class: "gold full", onclick: async () => {
      go.disabled = true; err.textContent = "";
      const args = { p_token: session.token, p_order_id: o.id, p_method: method.value, p_request_id: request };
      if (reference.value.trim() && reference.style.display !== "none") args.p_reference = reference.value.trim();
      if (currency === "USD") args.p_amount = Number(amount.value);
      else Object.assign(args, { p_amount: 0, p_currency: currency, p_tendered: Number(amount.value) });
      try {
        const r = await api("rpl_mobile_take_payment", args);
        sheet.remove();
        const what = currency === "USD" ? money(r.paid) + " taken" : CURRENCY[currency] + " " + plain(r.tendered) + " (" + money(r.amount) + ") taken";
        toast(what + (r.balance > 0.004 ? ", " + money(r.balance) + " still owed" : "") + (r.invoice_number ? " · invoice " + r.invoice_number : r.invoice_waits ? " · " + r.invoice_waits : ""), 4500);
        done && done();
      } catch (e) { err.textContent = e.maybeDone ? e.message + ". Check the order before trying again." : e.message; go.disabled = false; }
    } }, "Take payment");
    show();
    sheet.append(h("div", { class: "panel stack" }, h("h2", {}, "Payment · " + o.order_number), owedLine,
      codes.length > 1 ? chips : null,
      h("label", {}, "Amount"), amount, note, h("label", {}, "Paid with"), method, reference,
      h("p", { class: "muted small" }, "EcoCash or InnBucks here only records money already paid. To prompt the customer's phone, use a shop PC or the Android app."),
      go, h("button", { class: "full", onclick: () => sheet.remove() }, "Cancel"), err));
    document.body.append(sheet);
  }

  async function invoicePdf(o) {
    try {
      const r = await api("rpl_mobile_invoice_pdf", { p_token: session.token, p_order_id: o.id });
      if (r.pending) { toast("The invoice is still being made: try again in a minute"); return; }
      const bytes = Uint8Array.from(atob(r.pdf), (c) => c.charCodeAt(0));
      const file = new File([bytes], (o.invoice_number || o.order_number) + ".pdf", { type: "application/pdf" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: file.name });
      else window.open(URL.createObjectURL(file), "_blank");
    } catch (e) { if (e.name !== "AbortError") toast(e.message, 4000); }
  }

  function shrink(file, edge, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, edge / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality).split(",")[1]);
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => reject(new Error("Couldn't read that photo"));
      img.src = URL.createObjectURL(file);
    });
  }

  // --- start ---
  $("signout").addEventListener("click", () => signOut());
  $("branch").addEventListener("change", (e) => { branch = e.target.value; store("rpl-staff-branch", branch); cart.lines = []; render(current); });
  setTimeout(() => { const i = $("intro"); if (i) i.remove(); }, 2000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  render(session ? (locked && lockOn() ? "lock" : (TABS.find(([, , , ok]) => ok()) || ["more"])[0]) : "login");
})();
