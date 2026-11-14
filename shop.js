/* The online shop page. Reads the shop's window from the cloud
   (rpl_web_shop), keeps the basket in this browser, and sends the order
   (rpl_web_order): priced by the shop, never by the page. */
(function () {
  "use strict";

  const config = window.SHOP_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const branch = (params.get("b") || config.defaultBranch || "").toUpperCase();
  const $ = (id) => document.getElementById(id);
  const money = (n) => (config.currency || "$") + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const basketKey = "rpl-basket-" + branch;

  let products = [];
  let basket = loadBasket();
  const photos = new Map(); // photo id -> object URL, fetched once

  // --- The cloud ---

  async function rpc(fn, body) {
    const response = await fetch(config.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: config.publishableKey, Authorization: "Bearer " + config.publishableKey },
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
    $("branch-name").textContent = shop.branch.name ? shop.branch.name + " · Order online" : "Order online";
    $("tagline").textContent = company.tagline || "";
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
      actions.append(link("https://wa.me/" + wa, "WhatsApp us", "chip-link whatsapp"), link("tel:" + digits, "Call " + phone, "chip-link"));
    }
    const email = (company.email || "").split(/[,;/\n]/)[0].trim();
    if (email) actions.append(link("mailto:" + email, email, "chip-link"));
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
      card.className = "product" + (p.in_stock ? "" : " out");
      card.style.animationDelay = Math.min(index * 30, 300) + "ms";

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
        tag.className = "sold-out-tag"; tag.textContent = "Sold out";
        photo.append(tag);
      }

      const body = document.createElement("div");
      body.className = "product-body";
      const name = document.createElement("h3");
      name.className = "product-name"; name.textContent = p.name;
      const foot = document.createElement("div");
      foot.className = "product-foot";
      const price = document.createElement("span");
      price.className = "price"; price.textContent = money(p.price);
      const add = document.createElement("button");
      add.type = "button";
      const inBasket = basket[p.id] || 0;
      add.className = "add" + (inBasket ? " in" : "");
      add.textContent = !p.in_stock ? "Sold out" : inBasket ? inBasket + " in basket" : "Add";
      add.disabled = !p.in_stock;
      add.setAttribute("aria-label", p.in_stock ? "Add " + p.name + " to your basket" : p.name + " is sold out");
      add.onclick = () => { setQty(p.id, (basket[p.id] || 0) + 1); toast("Added " + p.name); bump(); };
      foot.append(price, add);
      body.append(name, foot);
      card.append(photo, body);
      grid.append(card);
    });
  }

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

    const button = $("place");
    button.disabled = true;
    button.textContent = "Placing your order…";
    try {
      const made = await rpc("rpl_web_order", {
        p_branch: branch,
        p_name: data.get("name"),
        p_phone: data.get("phone"),
        p_email: data.get("email") || "",
        p_address: deliver ? data.get("address") : "",
        p_note: data.get("note") || "",
        p_lines: Object.entries(basket).map(([id, qty]) => ({ id, qty })),
      });
      basket = {};
      saveBasket();
      form.reset();
      $("address-field").hidden = true;
      $("basket-view").hidden = true;
      $("done").hidden = false;
      $("done-text").textContent = "Your order " + made.number + " (" + money(made.total) + ") is in. " +
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

  // --- Start ---

  async function load() {
    if (!branch || !config.supabaseUrl) {
      $("grid").textContent = "";
      $("empty").hidden = false;
      $("empty").textContent = "This shop link is missing its branch. Please use the link the shop shared.";
      return;
    }
    try {
      const shop = await rpc("rpl_web_shop", { p_branch: branch });
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
  $("close-basket").onclick = closeBasket;
  $("scrim").onclick = closeBasket;
  $("done-close").onclick = closeBasket;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeBasket(); });
  $("search").addEventListener("input", renderGrid);
  $("checkout").addEventListener("submit", placeOrder);
  for (const radio of document.querySelectorAll('input[name="how"]')) {
    radio.addEventListener("change", () => { $("address-field").hidden = radio.value !== "deliver" || !radio.checked; });
  }
  load();
})();
