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
  async function api(fn, args) {
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
  const cart = { lines: [], customer: { name: "", phone: "", email: "", address: "" }, delivery: 0, discount: 0, request: null };

  function signOut(why) {
    if (session) api("rpl_mobile_logout", { p_token: session.token }).catch(() => {});
    session = null; forget("rpl-staff-session");
    render("login", why);
  }

  // --- screens ---
  const TABS = [
    ["sell", "🛒", "Sell", () => true],
    ["orders", "📋", "Orders", () => true],
    ["web", "🌐", "Web orders", () => true],
    ["reports", "📊", "Reports", isAdmin],
    ["photos", "📷", "Photos", isAdmin],
    ["more", "⚙️", "More", () => true],
  ];
  let current = "sell";

  function chrome() {
    const signedIn = !!session;
    $("tabs").hidden = !signedIn; $("signout").hidden = !signedIn; $("branch").hidden = !signedIn || session.branches.length < 2;
    if (!signedIn) return;
    const tabs = $("tabs"); tabs.textContent = "";
    for (const [key, icon, label, allowed] of TABS) {
      if (!allowed()) continue;
      tabs.append(h("button", { class: key === current ? "on" : "", onclick: () => render(key) }, h("span", { class: "i" }, icon), label));
    }
    const select = $("branch"); select.textContent = "";
    for (const b of session.branches) select.append(h("option", { value: b.code }, b.code + " · " + b.name));
    select.value = branch;
  }

  async function render(screen, note) {
    if (!session) screen = "login";
    current = screen;
    chrome();
    view.textContent = "";
    window.scrollTo(0, 0);
    try {
      await SCREENS[screen](note);
    } catch (e) {
      view.append(h("div", { class: "card err" }, e.message || "Something went wrong"));
    }
  }

  const SCREENS = {
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
          session = { token: r.token, username: r.username, role: r.role, ultra: !!r.ultra, home: r.branch_code, branches: r.branches || [] };
          store("rpl-staff-session", session);
          branch = session.branches.some((b) => b.code === branch) ? branch : session.home;
          store("rpl-staff-branch", branch);
          render("sell");
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
            h("button", { class: "gold full", onclick: () => place("charge") }, "Charge now"),
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
      const periods = [["today", "Today"], ["week", "This week"], ["month", "This month"], ["year", "This year"]];
      let period = "today";
      async function show() {
        seg.textContent = ""; box.textContent = "Loading…";
        periods.forEach(([k, label]) => seg.append(h("button", { class: k === period ? "on" : "", onclick: () => { period = k; show(); } }, label)));
        try {
          const r = await api("rpl_mobile_report", { p_token: session.token, p_branch: branch, p_period: period, p_tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
          box.textContent = "";
          const stat = (label, value) => h("div", { class: "card" }, h("span", { class: "muted" }, label), h("b", {}, value));
          box.append(h("div", { class: "stat" },
            stat("Sales", money(r.sales)), stat("Net revenue", money(r.net_revenue)),
            stat("Gross profit", money(r.gross_profit)), stat("Net profit", money(r.net_profit)),
            stat("Invoices", r.invoices), stat("Expenses", money(r.expenses)),
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

    async more() {
      view.append(h("h1", {}, "More"),
        h("div", { class: "card stack" },
          h("div", {}, "Signed in as ", h("b", {}, session.username), " (" + (session.ultra ? "Ultra Admin" : session.role.replace("_", " ")) + ")"),
          h("div", { class: "muted" }, "Branch " + branch),
          h("button", { class: "full", onclick: () => signOut() }, "Sign out")));
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
    if (o.status !== "cancelled" && o.balance > 0.004) buttons.append(h("button", { class: "gold grow", onclick: () => payment(o, () => render("orders")) }, "Take payment"));
    if (o.invoice_number) buttons.append(h("button", { onclick: () => invoicePdf(o) }, "Invoice PDF"));
    if (o.status === "payment_pending" && !(o.paid > 0.004)) buttons.append(h("button", { class: "danger", onclick: async () => {
      const reason = prompt("Delete " + o.order_number + "? Say why:"); if (reason === null) return;
      try { await api("rpl_mobile_delete_order", { p_token: session.token, p_order_id: o.id, p_reason: reason }); toast("Deleted"); render("orders"); }
      catch (e) { toast(e.message, 4000); } } }, "Delete"));
    if (buttons.childNodes.length) card.append(buttons);
    return card;
  }

  function payment(o, done) {
    const amount = h("input", { type: "number", inputmode: "decimal", step: "0.01", value: (o.balance > 0 ? o.balance : o.total).toFixed(2) });
    const method = h("select", {}, METHODS.map(([k, v]) => h("option", { value: k }, v)));
    const err = h("div", { class: "err" });
    let request = uuid();
    amount.addEventListener("input", () => { request = uuid(); });
    method.addEventListener("change", () => { request = uuid(); });
    const sheet = h("div", { class: "sheet", onclick: (e) => { if (e.target === sheet) sheet.remove(); } });
    const go = h("button", { class: "gold full", onclick: async () => {
      go.disabled = true; err.textContent = "";
      try {
        const r = await api("rpl_mobile_take_payment", { p_token: session.token, p_order_id: o.id, p_amount: Number(amount.value), p_method: method.value, p_request_id: request });
        sheet.remove();
        toast(money(r.paid) + " taken" + (r.balance > 0.004 ? ", " + money(r.balance) + " still owed" : "") + (r.invoice_number ? " · invoice " + r.invoice_number : r.invoice_waits ? " · " + r.invoice_waits : ""), 4500);
        done && done();
      } catch (e) { err.textContent = e.maybeDone ? e.message + ". Check the order before trying again." : e.message; go.disabled = false; }
    } }, "Take payment");
    sheet.append(h("div", { class: "panel stack" }, h("h2", {}, "Payment · " + o.order_number), h("div", { class: "muted" }, "Owed " + money(o.balance > 0 ? o.balance : o.total)),
      h("label", {}, "Amount"), amount, h("label", {}, "Paid with"), method,
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
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  render(session ? "sell" : "login");
})();
