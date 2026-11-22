/* The online shop page. Reads the shop's window from the cloud
   (rpl_web_shop), keeps the basket in this browser, and sends the order
   (rpl_web_order): priced by the shop, never by the page. */
(function () {
  "use strict";

  const config = window.SHOP_CONFIG || {};
  const params = new URLSearchParams(location.search);
  // A branch's own page with ?b=BR-01; without one, every online branch on
  // one page, each product once.
  const branch = (params.get("b") || config.defaultBranch || "").toUpperCase();
  const everyBranch = !branch;
  let branches = []; // every online branch, on the all-branches page
  const $ = (id) => document.getElementById(id);
  const money = (n) => (config.currency || "$") + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const basketKey = "rpl-basket-" + (branch || "all");

  let products = [];

  // --- How the page is used: anonymous counts for the shop's own report ---
  // A random id per browser visit (gone when the tab closes), the kind of
  // device, and where the visitor came from. No name, no address, nothing
  // that says who: the page can't know, and doesn't try.
  const visitId = (() => {
    try {
      let id = sessionStorage.getItem("rpl-visit");
      if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); sessionStorage.setItem("rpl-visit", id); }
      return id;
    } catch (e) { return String(Math.random()).slice(2); }
  })();
  const source = (() => {
    const tag = (params.get("utm_source") || params.get("ref") || "").toLowerCase();
    const from = tag || (document.referrer ? new URL(document.referrer).hostname.toLowerCase() : "");
    if (!from) return "direct";
    if (tag === "qr") return "qr";  // a printed QR code: ?utm_source=qr
    for (const [name, marks] of [["whatsapp", ["whatsapp", "wa.me"]], ["facebook", ["facebook", "fb.", "fb"]],
      ["instagram", ["instagram"]], ["google", ["google"]], ["tiktok", ["tiktok"]]]) {
      if (marks.some((m) => from.includes(m))) return name;
    }
    return from === location.hostname.toLowerCase() ? "direct" : "other";  // moving within the shop's own site
  })();
  const device = (() => {
    const w = Math.min(screen.width || innerWidth, innerWidth || screen.width);
    const touch = matchMedia("(pointer: coarse)").matches;
    return w < 600 ? "phone" : touch && w < 1100 ? "tablet" : "computer";
  })();
  const events = [];
  const seen = new Set();
  function track(event, product) {
    if (event === "view") { if (seen.has(product)) return; seen.add(product); }
    events.push({ visit: visitId, event, product: product || "", source, device, branch });
  }
  function sendEvents(leaving) {
    if (!events.length || !config.supabaseUrl) return;
    const batch = events.splice(0, 25);
    fetch(config.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/rpl_web_track", {
      method: "POST", keepalive: !!leaving,
      headers: { "Content-Type": "application/json", apikey: config.publishableKey, Authorization: "Bearer " + config.publishableKey },
      body: JSON.stringify({ p_events: batch }),
    }).catch(() => {});
  }
  setInterval(() => sendEvents(false), 5000);
  addEventListener("pagehide", () => sendEvents(true));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") sendEvents(true); });
  track("visit");
  let whatsapp = ""; // the shop's number, for asking about a product coming soon
  let basket = loadBasket();
  const photos = new Map(); // photo id -> object URL, fetched once

  // --- The cloud ---

  async function rpc(fn, body) {
    // Signed in: as the customer, so their orders are on their account.
    const bearer = (await accessToken()) || config.publishableKey;
    const response = await fetch(config.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: config.publishableKey, Authorization: "Bearer " + bearer },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || "Something went wrong. Please try again.");
      error.code = data.code;
      throw error;
    }
    return data;
  }

  async function photoUrl(id) {
    if (!photos.has(id)) {
      photos.set(id, rpc("rpl_web_photo", { p_id: id }).then((photo) => {
        const bytes = Uint8Array.from(atob(photo.data), (c) => c.charCodeAt(0));
        return URL.createObjectURL(new Blob([bytes], { type: photo.content_type }));
      }).catch(() => null));
    }
    return photos.get(id);
  }

  // --- The basket, kept in this browser ---

  function loadBasket() {
    try { return JSON.parse(localStorage.getItem(basketKey)) || {}; } catch (e) { return {}; }
  }
  function saveBasket() {
    try { localStorage.setItem(basketKey, JSON.stringify(basket)); } catch (e) { /* private window: kept for this visit */ }
  }
  function count() { return Object.values(basket).reduce((a, b) => a + b, 0); }
  function total() {
    return Object.entries(basket).reduce((sum, [id, qty]) => {
      const product = products.find((p) => p.id === id);
      return sum + (product ? product.price * qty : 0);
    }, 0);
  }
  function setQty(id, qty) {
    if (qty <= 0) delete basket[id]; else basket[id] = Math.min(qty, 50);
    saveBasket();
    renderBasket();
    renderGrid();
  }

  // --- Drawing ---

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  }

  function renderShop(shop) {
    const company = shop.company || {};
    const name = company.name || shop.branch.name;
    document.title = name + " · Order online";
    for (const id of ["brand-name", "shop-name", "footer-name"]) $(id).textContent = name;
    branches = shop.branches || [];
    $("branch-name").textContent = shop.branch.name ? shop.branch.name + " · Order online"
      : branches.length > 1 ? "Order online · " + branches.length + " shops" : "Order online";
    $("tagline").textContent = company.tagline || "";
    // The shop's announcement, while it is switched on (Settings → Online shop).
    $("banner").textContent = company.banner || "";
    $("banner").hidden = !company.banner;
    if (company.logo) {
      $("logo").src = "data:image/png;base64," + company.logo;
      $("logo").hidden = false;
    }
    $("footer-address").textContent = (company.address || "").split(/\s*[,\n]\s*/).filter(Boolean).join("\n");
    const actions = $("footer-actions");
    actions.textContent = "";
    const phone = (company.phone || "").split(/[,;/\n]/)[0].trim();
    if (phone) {
      const digits = phone.replace(/[^\d+]/g, "");
      const wa = digits.startsWith("+") ? digits.slice(1) : digits.startsWith("0") ? "263" + digits.slice(1) : digits;
      whatsapp = wa;
      actions.append(link("https://wa.me/" + wa, "WhatsApp us", "chip-link whatsapp"), link("tel:" + digits, "Call " + phone, "chip-link"));
    }
    const email = (company.email || "").split(/[,;/\n]/)[0].trim();
    if (email) actions.append(link("mailto:" + email, email, "chip-link"));

    // The contact band: the same ways to reach the shop, larger.
    const contact = $("contact-actions");
    contact.textContent = "";
    for (const a of actions.querySelectorAll("a")) contact.append(a.cloneNode(true));

    // About us: the shop's own words, a paragraph each, and its shops.
    $("about-title").textContent = name;
    const about = $("about-text");
    about.textContent = "";
    // The shop's own words from its settings (the cloud); the page's built-in text until set.
    for (const para of String(company.about || config.about || "").split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)) {
      const el = document.createElement("p");
      el.textContent = para;
      about.append(el);
    }
    const shops = (shop.branches && shop.branches.length ? shop.branches : (shop.branch && shop.branch.name ? [shop.branch] : []));
    const list = $("shop-list");
    list.textContent = "";
    shops.forEach((b) => {
      const li = document.createElement("li");
      li.textContent = b.name;
      list.append(li);
    });
    $("shops").hidden = shops.length === 0;
  }

  function link(href, text, cls) {
    const a = document.createElement("a");
    a.href = href; a.textContent = text; a.className = cls;
    if (href.startsWith("http")) { a.target = "_blank"; a.rel = "noopener"; }
    return a;
  }

  function renderGrid() {
    const query = $("search").value.trim().toLowerCase();
    const shown = products.filter((p) => !query || p.name.toLowerCase().includes(query));
    const grid = $("grid");
    grid.textContent = "";
    $("empty").hidden = shown.length > 0;
    $("empty").textContent = products.length ? "Nothing matches “" + $("search").value + "”." : "No products online yet. Please check back soon.";
    shown.forEach((p, index) => {
      const card = document.createElement("article");
      card.className = "product reveal" + (p.in_stock ? "" : p.coming_soon ? " soon" : " out");
      card.dataset.product = p.name;
      card.style.transitionDelay = (index % 4) * 70 + "ms";

      const photo = document.createElement("div");
      photo.className = "photo";
      const placeholder = document.createElement("div");
      placeholder.className = "placeholder";
      placeholder.textContent = initials(p.name);
      placeholder.setAttribute("aria-hidden", "true");
      photo.append(placeholder);
      if (p.photo) {
        const img = document.createElement("img");
        img.alt = p.name; img.loading = "lazy";
        img.onload = () => { img.classList.add("loaded"); placeholder.remove(); };
        photo.append(img);
        photoUrl(p.photo).then((url) => { if (url) img.src = url; });
      }
      if (!p.in_stock) {
        const tag = document.createElement("span");
        tag.className = p.coming_soon ? "soon-tag" : "sold-out-tag";
        tag.textContent = p.coming_soon ? "Coming soon" : "Sold out";
        photo.append(tag);
      }

      const body = document.createElement("div");
      body.className = "product-body";
      const name = document.createElement("h3");
      name.className = "product-name"; name.textContent = p.name;
      const expected = document.createElement("p");
      expected.className = "expected";
      expected.textContent = p.coming_soon && p.expected ? "Expected " + p.expected : "";
      const foot = document.createElement("div");
      foot.className = "product-foot";
      const price = document.createElement("span");
      // On a purchase order with no product made yet: no price set to show.
      price.className = "price"; price.textContent = p.price == null ? "Price to follow" : money(p.price);
      // A lower price online: the shop's own shown crossed out beside it.
      if (p.was && p.price != null) {
        const was = document.createElement("s");
        was.className = "was"; was.textContent = money(p.was);
        price.prepend(was, " ");
      }
      let add;
      if (p.coming_soon) {
        // Not in stock yet: ask about it rather than order it.
        add = document.createElement("a");
        add.className = "add ask";
        add.textContent = "Ask on WhatsApp";
        add.target = "_blank"; add.rel = "noopener";
        add.href = whatsapp ? "https://wa.me/" + whatsapp + "?text=" + encodeURIComponent(
          "Hi, I'm interested in " + p.name + " (coming soon on your online shop). When will it be in?") : "#";
        add.setAttribute("aria-label", "Ask about " + p.name + " on WhatsApp");
      } else {
        add = document.createElement("button");
        add.type = "button";
        const inBasket = basket[p.id] || 0;
        add.className = "add" + (inBasket ? " in" : "");
        add.textContent = !p.in_stock ? "Sold out" : inBasket ? inBasket + " in basket" : "Add";
        add.disabled = !p.in_stock;
        add.setAttribute("aria-label", p.in_stock ? "Add " + p.name + " to your basket" : p.name + " is sold out");
        add.onclick = () => { setQty(p.id, (basket[p.id] || 0) + 1); toast("Added " + p.name); bump(); track("add", p.name); };
      }
      foot.append(price, add);
      body.append(name);
      if (expected.textContent) body.append(expected);
      body.append(foot);
      if (p.featured) {
        const star = document.createElement("span");
        star.className = "featured-tag"; star.textContent = "Featured";
        photo.append(star);
      }
      card.append(photo, body);
      grid.append(card);
    });
    watchReveals();
  }

  // Things fade up into place as they scroll into view, once each.
  const revealer = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("shown");
        if (entry.target.dataset.product) track("view", entry.target.dataset.product);
        revealer.unobserve(entry.target);
      }
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }) : null;

  function watchReveals() {
    for (const el of document.querySelectorAll(".reveal:not(.shown)")) {
      if (revealer) revealer.observe(el); else el.classList.add("shown");
    }
  }

  // The bar darkens a touch once the page is scrolled.
  window.addEventListener("scroll", () => document.body.classList.toggle("scrolled", window.scrollY > 24), { passive: true });

  function renderBasket() {
    // Products no longer sold (or not in this shop) leave the basket.
    for (const id of Object.keys(basket)) if (products.length && !products.some((p) => p.id === id && p.in_stock)) delete basket[id];
    const n = count();
    $("basket-count").hidden = n === 0;
    $("basket-count").textContent = n;
    const lines = $("lines");
    lines.textContent = "";
    for (const [id, qty] of Object.entries(basket)) {
      const p = products.find((x) => x.id === id);
      if (!p) continue;
      const li = document.createElement("li");
      li.className = "line";
      const thumb = document.createElement("div");
      thumb.className = "line-thumb"; thumb.textContent = initials(p.name);
      if (p.photo) photoUrl(p.photo).then((url) => {
        if (url) { const img = document.createElement("img"); img.src = url; img.alt = ""; thumb.textContent = ""; thumb.append(img); }
      });
      const info = document.createElement("div");
      info.innerHTML = '<div class="line-name"></div><div class="line-price"></div>';
      info.firstChild.textContent = p.name;
      info.lastChild.textContent = money(p.price) + " each · " + money(p.price * qty);
      const stepper = document.createElement("div");
      stepper.className = "stepper";
      const minus = Object.assign(document.createElement("button"), { type: "button", textContent: "−" });
      minus.setAttribute("aria-label", "One fewer " + p.name);
      minus.onclick = () => setQty(id, qty - 1);
      const shown = Object.assign(document.createElement("span"), { textContent: qty });
      const plus = Object.assign(document.createElement("button"), { type: "button", textContent: "+" });
      plus.setAttribute("aria-label", "One more " + p.name);
      plus.onclick = () => setQty(id, qty + 1);
      stepper.append(minus, shown, plus);
      li.append(thumb, info, stepper);
      lines.append(li);
    }
    $("basket-empty").hidden = n > 0;
    $("total-row").hidden = n === 0;
    $("checkout").hidden = n === 0;
    $("total").textContent = money(total());
    renderCollect();
  }

  // Collecting, on the all-branches page: only the shops that have every
  // item in the basket. Delivering, the shop picks one that has.
  function renderCollect() {
    const field = $("collect-field"), note = $("collect-note"), select = $("collect");
    const collecting = (document.querySelector('input[name="how"]:checked') || {}).value !== "deliver";
    if (!everyBranch) { field.hidden = true; note.hidden = true; return; }
    const ids = Object.keys(basket);
    const able = branches.filter((b) => ids.every((id) => {
      const p = products.find((x) => x.id === id);
      return p && (p.at || []).includes(b.code);
    }));
    const chosen = select.value;
    select.textContent = "";
    able.forEach((b) => select.append(new Option(b.name, b.code, false, b.code === chosen)));
    field.hidden = !collecting || able.length === 0;
    note.hidden = !collecting || able.length > 0 || ids.length === 0;
    note.textContent = "No one shop has all of these right now. Choose Deliver, or order them separately.";
  }

  function bump() {
    const badge = $("basket-count");
    badge.classList.remove("bump");
    void badge.offsetWidth;
    badge.classList.add("bump");
  }

  let toastTimer;
  function toast(text) {
    const t = $("toast");
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
  }

  // --- The basket sheet ---

  function openBasket() {
    fillCheckout();
    $("basket-view").hidden = false;
    $("done").hidden = true;
    $("scrim").hidden = false;
    $("sheet").hidden = false;
    document.body.style.overflow = "hidden";
    renderBasket();
  }
  function closeBasket() {
    $("scrim").hidden = true;
    $("sheet").hidden = true;
    $("account-sheet").hidden = true;
    document.body.style.overflow = "";
  }

  async function placeOrder(event) {
    event.preventDefault();
    const form = $("checkout");
    const data = new FormData(form);
    const deliver = data.get("how") === "deliver";
    const error = $("form-error");
    const fail = (text) => { error.textContent = text; error.hidden = false; };
    error.hidden = true;
    if ((data.get("name") || "").trim().length < 2) return fail("Please give your name.");
    if ((data.get("phone") || "").replace(/\D/g, "").length < 9) return fail("Please give a phone number we can call you on.");
    if (deliver && !(data.get("address") || "").trim()) return fail("Please give the delivery address.");
    if (everyBranch && !deliver && !data.get("collect")) return fail("Choose Deliver: no one shop has all of these to collect.");

    const button = $("place");
    button.disabled = true;
    button.textContent = "Placing your order…";
    try {
      const made = await rpc("rpl_web_order", {
        // Collecting: from the shop chosen. Delivering from the all-branches
        // page: left to the shop, which picks one that has everything.
        p_branch: everyBranch ? (deliver ? "" : data.get("collect")) : branch,
        p_name: data.get("name"),
        p_phone: data.get("phone"),
        p_email: data.get("email") || "",
        p_address: deliver ? data.get("address") : "",
        p_note: data.get("note") || "",
        p_lines: Object.entries(basket).map(([id, qty]) => ({ id, qty })),
      });
      for (const id of Object.keys(basket)) {
        const ordered = products.find((x) => x.id === id);
        if (ordered) track("order", ordered.name);
      }
      sendEvents(false);
      basket = {};
      saveBasket();
      form.reset();
      $("address-field").hidden = true;
      $("basket-view").hidden = true;
      $("done").hidden = false;
      $("done-text").textContent = "Your order " + made.number + " (" + money(made.total) + ")" +
        (made.branch && everyBranch ? " is with our " + made.branch + " shop. " : " is in. ") +
        "We'll call you shortly to confirm, then send a secure Paynow link to pay.";
      renderBasket();
      renderGrid();
    } catch (e) {
      fail(e.message);
      load(); // stock may have changed: the page shows what is there now
    } finally {
      button.disabled = false;
      button.textContent = "Place order";
    }
  }

  // --- The customer's account ---
  // Signed in by Supabase Auth with a code (or link) sent to their email; the
  // shop's functions then know them by that email (rpl_web_me), so they see
  // their own orders and receipts and keep their details. Kept in this browser.

  const ACCOUNT_KEY = "rpl-shop-account";
  let account = (() => { try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || "null"); } catch (e) { return null; } })();
  let me = null; // the account's details and orders, once loaded

  async function auth(path, body, bearer) {
    const response = await fetch(config.supabaseUrl.replace(/\/$/, "") + "/auth/v1/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: config.publishableKey, Authorization: "Bearer " + (bearer || config.publishableKey) },
      body: JSON.stringify(body || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.msg || data.error_description || data.message || "That didn't work. Please try again.");
    return data;
  }
  function emailIn(jwt) {
    try { return JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email || ""; } catch (e) { return ""; }
  }
  function keep(session) {
    account = { access: session.access_token, refresh: session.refresh_token,
      expires: Date.now() + (Number(session.expires_in) || 3600) * 1000,
      email: (session.user && session.user.email) || emailIn(session.access_token) };
    try { localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account)); } catch (e) { /* private window: this visit only */ }
  }
  function forgetAccount() {
    account = null; me = null;
    try { localStorage.removeItem(ACCOUNT_KEY); } catch (e) { /* nothing kept */ }
  }
  async function accessToken() {
    if (!account) return null;
    if (Date.now() > account.expires - 60000) {
      try { keep(await auth("token?grant_type=refresh_token", { refresh_token: account.refresh })); }
      catch (e) { forgetAccount(); renderAccount(); return null; }
    }
    return account.access;
  }
  // Back from the link in the email: the session is in the address.
  function fromEmailLink() {
    const found = new URLSearchParams(location.hash.slice(1));
    if (found.get("access_token")) {
      keep({ access_token: found.get("access_token"), refresh_token: found.get("refresh_token"), expires_in: found.get("expires_in") });
      history.replaceState(null, "", location.pathname + location.search);
      toast("You're signed in");
      return true;
    }
    if (found.get("error_description")) {
      history.replaceState(null, "", location.pathname + location.search);
      toast(found.get("error_description"));
    }
    return false;
  }

  function openAccount() {
    $("scrim").hidden = false;
    $("account-sheet").hidden = false;
    document.body.style.overflow = "hidden";
    renderAccount();
  }
  function closeAccount() {
    $("scrim").hidden = true;
    $("account-sheet").hidden = true;
    document.body.style.overflow = "";
  }

  async function renderAccount() {
    const signedIn = Boolean(account);
    $("sign-in").hidden = signedIn;
    $("account-view").hidden = !signedIn;
    if (!signedIn) return;
    $("account-email").textContent = account.email;
    try {
      me = await rpc("rpl_web_me", {});
    } catch (e) {
      if (e.code === "PT401" || /JWT|sign in/i.test(e.message)) { forgetAccount(); renderAccount(); }
      else toast(e.message);
      return;
    }
    const form = $("my-details");
    for (const field of ["name", "phone", "address"]) form.elements[field].value = me[field] || "";
    const list = $("my-orders");
    list.textContent = "";
    if (!me.orders.length) {
      const li = document.createElement("li"); li.textContent = "No orders yet. They'll show here once you order."; list.append(li);
    }
    for (const o of me.orders) {
      const li = document.createElement("li");
      const head = document.createElement("div"); head.className = "order-head";
      const number = document.createElement("span"); number.textContent = o.number;
      const total = document.createElement("span"); total.textContent = money(o.total);
      head.append(number, total);
      const status = document.createElement("div"); status.className = "order-status";
      status.textContent = o.status + " · " + String(o.placed_at || "").slice(0, 10) + (o.invoice_number ? " · invoice " + o.invoice_number : "");
      const lines = document.createElement("p"); lines.className = "order-lines";
      lines.textContent = (o.lines || []).map((l) => l.qty + " × " + l.name).join(", ");
      const actions = document.createElement("div"); actions.className = "order-actions";
      if (o.pay_link) {
        const pay = document.createElement("a"); pay.className = "pay"; pay.href = o.pay_link; pay.rel = "noopener";
        pay.textContent = "Pay " + money(o.balance) + " now"; actions.append(pay);
      }
      const again = document.createElement("button"); again.type = "button"; again.textContent = "Order again";
      again.onclick = () => orderAgain(o);
      actions.append(again);
      li.append(head, status, lines, actions);
      list.append(li);
    }
  }

  function orderAgain(order) {
    let added = 0;
    for (const l of order.lines || []) {
      const product = products.find((x) => (x.id === l.item_id || x.id === l.key) && x.in_stock);
      if (product) { setQty(product.id, (basket[product.id] || 0) + Number(l.qty)); added++; }
    }
    if (!added) { toast("None of those are in stock right now"); return; }
    closeAccount();
    openBasket();
    if (added < (order.lines || []).length) toast("Some of those aren't in stock right now");
  }

  async function sendCode(event) {
    event.preventDefault();
    const email = $("sign-in").elements.email.value.trim();
    const error = $("sign-in-error");
    error.hidden = true;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { error.textContent = "Please give your email address."; error.hidden = false; return; }
    const button = $("send-code");
    button.disabled = true;
    try {
      await auth("otp?redirect_to=" + encodeURIComponent(location.origin + location.pathname), { email, create_user: true });
      $("code-step").hidden = false;
      button.textContent = "Send another code";
      $("sign-in").elements.code.focus();
    } catch (e) { error.textContent = e.message; error.hidden = false; }
    finally { button.disabled = false; }
  }
  async function verifyCode() {
    const form = $("sign-in");
    const error = $("sign-in-error");
    error.hidden = true;
    try {
      keep(await auth("verify", { type: "email", email: form.elements.email.value.trim(), token: form.elements.code.value.trim() }));
      form.reset(); $("code-step").hidden = true; $("send-code").textContent = "Email me a sign-in code";
      renderAccount();
    } catch (e) { error.textContent = e.message; error.hidden = false; }
  }
  async function saveDetails(event) {
    event.preventDefault();
    const form = $("my-details");
    try {
      await rpc("rpl_web_save_me", { p_name: form.elements.name.value, p_phone: form.elements.phone.value, p_address: form.elements.address.value });
      toast("Saved");
      renderAccount();
    } catch (e) { toast(e.message); }
  }
  async function signOut(event) {
    event.preventDefault();
    const bearer = account && account.access;
    forgetAccount();
    renderAccount();
    if (bearer) auth("logout", {}, bearer).catch(() => {});
  }
  // The order form, filled in from the account.
  function fillCheckout() {
    if (!account) return;
    const form = $("checkout");
    form.elements.email.value = account.email; form.elements.email.readOnly = true;
    if (!me) return;
    for (const field of ["name", "phone", "address"]) if (!form.elements[field].value && me[field]) form.elements[field].value = me[field];
  }

  // --- The receipt, after paying a pay link ---
  // Paynow sends the customer back here with the payment's reference and
  // a seal (rpl_web_receipt): the order they paid for, and whether Paynow
  // has confirmed it yet. Until it has, asked again every few seconds.

  async function showReceipt(reference, seal) {
    const box = $("receipt");
    box.hidden = false;
    box.scrollIntoView({ behavior: "smooth" });
    const started = Date.now();
    const money2 = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    for (;;) {
      let r;
      try {
        r = await rpc("rpl_web_receipt", { p_reference: reference, p_seal: seal });
      } catch (e) {
        $("receipt-state").textContent = "Receipt";
        $("receipt-title").textContent = "We couldn't open this receipt";
        $("receipt-note").textContent = e.message;
        return;
      }
      $("receipt-title").textContent = r.paid ? "Paid. Thank you" + (r.customer ? ", " + r.customer.split(" ")[0] : "") + "!" : "Thank you";
      $("receipt-meta").textContent = [r.shop, "Order " + r.order_number, r.invoice_number ? "Invoice " + r.invoice_number : ""]
        .filter(Boolean).join(" · ");
      const list = $("receipt-lines");
      list.textContent = "";
      for (const l of r.lines || []) {
        const li = document.createElement("li");
        const what = document.createElement("span"); what.textContent = l.qty + " × " + l.name;
        const cost = document.createElement("span"); cost.textContent = money2(l.line_total);
        li.append(what, cost); list.append(li);
      }
      $("receipt-total").textContent = "Paid " + money2(r.amount) + (r.paynow_reference ? " · Paynow ref " + r.paynow_reference : "")
        + (r.balance > 0.004 ? " · still owed " + money2(r.balance) : "");
      if (r.paid) {
        $("receipt-state").textContent = "Payment confirmed";
        $("receipt-note").textContent = (r.email ? "Your invoice is on its way to your email. " : "")
          + "We'll be in touch about collection or delivery. Keep this page as your receipt.";
        return;
      }
      if (r.status === "failed" || r.status === "cancelled") {
        $("receipt-state").textContent = "Not paid";
        $("receipt-note").textContent = "Paynow didn't take this payment. Nothing was charged; please contact us to try again.";
        return;
      }
      $("receipt-state").textContent = "Waiting for Paynow to confirm…";
      $("receipt-note").textContent = "This usually takes under a minute. This page checks by itself.";
      if (Date.now() - started > 180000) {
        $("receipt-note").textContent = "Paynow hasn't confirmed it yet. If you paid, it will reach us: keep your Paynow reference, and we'll confirm.";
        return;
      }
      await new Promise((done) => setTimeout(done, 5000));
    }
  }

  // --- Start ---

  async function load() {
    if (!config.supabaseUrl) {
      $("grid").textContent = "";
      $("empty").hidden = false;
      $("empty").textContent = "This shop link is missing its branch. Please use the link the shop shared.";
      return;
    }
    try {
      const shop = await rpc("rpl_web_shop", { p_branch: branch || "" });
      products = shop.products || [];
      renderShop(shop);
      renderGrid();
      renderBasket();
    } catch (e) {
      $("grid").textContent = "";
      $("empty").hidden = false;
      $("empty").textContent = e.code === "PT404" ? "This shop isn't taking orders online right now." : "We couldn't load the shop. Please check your connection and try again.";
    }
  }

  $("open-basket").onclick = openBasket;
  $("open-account").onclick = openAccount;
  $("close-account").onclick = closeAccount;
  $("sign-in").addEventListener("submit", sendCode);
  $("verify-code").onclick = verifyCode;
  $("my-details").addEventListener("submit", saveDetails);
  $("sign-out").addEventListener("click", signOut);
  $("close-basket").onclick = closeBasket;
  $("scrim").onclick = closeBasket;
  $("done-close").onclick = closeBasket;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeBasket(); });
  $("search").addEventListener("input", renderGrid);
  $("checkout").addEventListener("submit", placeOrder);
  for (const radio of document.querySelectorAll('input[name="how"]')) {
    radio.addEventListener("change", () => { $("address-field").hidden = radio.value !== "deliver" || !radio.checked; renderCollect(); });
  }
  watchReveals();
  requestAnimationFrame(() => document.body.classList.add("ready")); // the hero rises in
  load();
  if (fromEmailLink()) openAccount();
  else if (account) rpc("rpl_web_me", {}).then((found) => { me = found; }).catch(() => {});
  const landed = new URLSearchParams(location.search);
  if (landed.get("receipt") && landed.get("s")) showReceipt(landed.get("receipt"), landed.get("s"));
})();
