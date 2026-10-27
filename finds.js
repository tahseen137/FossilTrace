/* FossilTrace: amateur find logging on Supabase.
 * Sign in by emailed link, log a find (spot, date, guess, photos), see community finds on the map.
 * Exact spots stay private to the finder; everyone else gets map_finds(), snapped to ~10 km.
 * Photos are re-encoded in the browser before upload, which drops EXIF (and any GPS in it).
 */
(function () {
  "use strict";

  const SUPABASE_URL = "https://synkznfltjxppnnsnuca.supabase.co";
  const SUPABASE_KEY = "sb_publishable_s8TFnu4UebyAIw2ZglmP-w_Ir2ATyvc"; // publishable key; safe in the browser, row-level security does the guarding
  const BUCKET = "find-photos";
  const MAX_PHOTOS = 4;
  const MAX_EDGE = 1600;        // px; photos are shrunk to this before upload
  const COLOR = "#2ec4b6";
  const TURNSTILE_SITE_KEY = "0x4AAAAAAFoZXegjqVIcr4z1"; // Cloudflare Turnstile (works on fossiltrace.vercel.app only); the secret lives in Supabase Auth
  const PBDB = "https://paleobiodb.org/data1.2";
  // Period spans in millions of years (ICS 2024), for the age checks.
  const PERIOD_SPANS = {
    Cambrian: [538.8, 486.85], Ordovician: [486.85, 443.1], Silurian: [443.1, 419.62], Devonian: [419.62, 358.86],
    Carboniferous: [358.86, 298.9], Permian: [298.9, 251.9], Triassic: [251.9, 201.4], Jurassic: [201.4, 143.1],
    Cretaceous: [143.1, 66], Paleogene: [66, 23.04], Neogene: [23.04, 2.58], Quaternary: [2.58, 0],
  };
  const REPORT_REASONS = [
    ["fake", "Looks fake or made up"], ["wrong_id", "Wrong identification"], ["spam", "Spam or advertising"],
    ["inappropriate", "Inappropriate photo or text"], ["sensitive_site", "Reveals a site that should be protected"],
  ];

  function start() {
    const FT = window.FossilTrace;
    if (!FT || !SUPABASE_URL || !SUPABASE_KEY || !window.supabase) return;
    const { map, esc, fact, ageChip, periodFromMa, periodFromName, cached, fetchJSON, panelBody, maRange } = FT;
    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    const photoUrl = (path) => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    let user = null, profile = null, communityOn = true, confirmedOnly = false, picking = null, pickMarker = null;
    const findById = new Map();

    // ---------- controls ----------
    document.querySelector(".layers").insertAdjacentHTML("beforeend",
      `<label class="toggle"><input id="layer-community" type="checkbox" checked><span class="key key-community"></span><span>Amateur finds <small>FossilTrace</small></span></label>
       <label class="toggle sub"><input id="community-confirmed" type="checkbox"><span>Only confirmed amateur finds</span></label>`);
    document.querySelector(".actions").insertAdjacentHTML("afterbegin",
      `<button id="log-find" type="button" class="btn btn-primary">+ Log a find</button>`);
    document.getElementById("layer-community").addEventListener("change", (e) => {
      communityOn = e.target.checked;
      if (map.getLayer("community")) map.setLayoutProperty("community", "visibility", communityOn ? "visible" : "none");
      if (communityOn) loadCommunity();
    });
    document.getElementById("community-confirmed").addEventListener("change", (e) => { confirmedOnly = e.target.checked; drawCommunity(); });
    document.getElementById("log-find").addEventListener("click", () => (user ? showForm() : showSignIn()));

    // ---------- map layer ----------
    function addLayer() {
      if (map.getSource("community")) return;
      map.addSource("community", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "community", type: "circle", source: "community",
        paint: {
          "circle-color": COLOR, "circle-radius": ["interpolate", ["linear"], ["zoom"], 4, 7, 12, 9],
          "circle-opacity": ["case", ["get", "confirmed"], 1, 0.55],
          "circle-stroke-color": ["case", ["get", "confirmed"], "#fff", "#cfeeea"], "circle-stroke-width": ["case", ["get", "mine"], 3, 1.5],
        },
      });
      FT.CLICK_LAYERS.push("community");
      map.on("click", "community", (e) => { const f = e.features && e.features[0]; if (f) showFind(f.properties.id); });
      map.on("mouseenter", "community", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "community", () => { map.getCanvas().style.cursor = ""; });
      map.on("moveend", () => { if (communityOn) loadCommunity(); });
      loadCommunity();
    }
    if (map.loaded()) addLayer(); else { map.once("load", addLayer); map.once("idle", addLayer); }

    let loadSeq = 0;
    async function loadCommunity() {
      if (map.getZoom() < 3 || !map.getSource("community")) return;
      const seq = ++loadSeq;
      const b = map.getBounds();
      const [pub, mine] = await Promise.all([
        sb.rpc("map_finds", { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() }),
        user ? sb.rpc("own_finds") : Promise.resolve({ data: [] }),
      ]);
      if (seq !== loadSeq) return;
      findById.clear();
      for (const f of pub.data || []) findById.set(f.id, { ...f, mine: false });
      for (const f of mine.data || []) findById.set(f.id, { ...f, mine: true }); // my own finds at their exact spot
      drawCommunity();
    }
    function drawCommunity() {
      const src = map.getSource("community");
      if (!src) return;
      src.setData({
        type: "FeatureCollection",
        features: [...findById.values()].filter((f) => !confirmedOnly || f.status === "confirmed").map((f) => ({
          type: "Feature", geometry: { type: "Point", coordinates: [f.lng, f.lat] },
          properties: { id: f.id, mine: f.mine, confirmed: f.status === "confirmed" },
        })),
      });
    }

    // ---------- auth ----------
    sb.auth.onAuthStateChange(async (_event, session) => {
      user = session ? session.user : null;
      profile = null;
      if (user) {
        const { data } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
        profile = data;
      }
      document.getElementById("log-find").textContent = "+ Log a find";
      loadCommunity();
    });

    function showSignIn(note) {
      FT.select("signin");
      panelBody.innerHTML = `
        <div class="panel-content">
          <div>
            <p class="eyebrow">Log your finds</p>
            <h2 class="common">Sign in</h2>
            <p class="wikidesc">We'll email you a sign-in link. No password needed.</p>
          </div>
          <form id="signin-form" class="form">
            <label>Email<input id="signin-email" type="email" required autocomplete="email"></label>
            ${TURNSTILE_SITE_KEY ? `<div id="signin-captcha"></div>` : ""}
            <button type="submit" class="btn btn-primary">Email me a link</button>
            <p id="signin-msg" class="note">${note ? esc(note) : ""}</p>
          </form>
          <p class="dim small">Exact spots you log stay private to you. Everyone else sees them rounded to about 10 km, so sites don't get stripped.</p>
        </div>`;
      FT.openPanel();
      let captchaToken = null;
      if (TURNSTILE_SITE_KEY) {
        loadTurnstile().then((ts) => ts.render("#signin-captcha", {
          sitekey: TURNSTILE_SITE_KEY, theme: "dark",
          callback: (t) => { captchaToken = t; }, "expired-callback": () => { captchaToken = null; },
        }));
      }
      document.getElementById("signin-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = document.getElementById("signin-email").value.trim();
        const msg = document.getElementById("signin-msg");
        if (TURNSTILE_SITE_KEY && !captchaToken) { msg.textContent = "Please finish the check above first."; return; }
        msg.textContent = "Sending…";
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname, captchaToken: captchaToken || undefined } });
        msg.textContent = error ? `Couldn't send the link: ${error.message}` : "Check your email and open the link on this device.";
        if (TURNSTILE_SITE_KEY && window.turnstile) { window.turnstile.reset("#signin-captcha"); captchaToken = null; }
      });
    }

    let turnstileLoading = null;
    function loadTurnstile() {
      if (window.turnstile) return Promise.resolve(window.turnstile);
      turnstileLoading = turnstileLoading || new Promise((ok, fail) => {
        const sc = document.createElement("script");
        sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        sc.onload = () => ok(window.turnstile); sc.onerror = fail;
        document.head.appendChild(sc);
      });
      return turnstileLoading;
    }

    // ---------- log a find ----------
    function showForm() {
      FT.select("form");
      const c = map.getCenter();
      const here = { lng: Number(c.lng.toFixed(5)), lat: Number(c.lat.toFixed(5)) };
      panelBody.innerHTML = `
        <div class="panel-content">
          <div>
            <p class="eyebrow" id="who">Signed in as ${esc(profile ? profile.display_name : user.email)} · ${profile ? `<button type="button" class="linklike" id="rename">change name</button> · ` : ""}<button type="button" class="linklike" id="signout">sign out</button></p>
            <h2 class="common">Log a find</h2>
          </div>
          <form id="find-form" class="form">
            ${profile ? "" : `<label>Your name on the map<input id="f-name" required minlength="2" maxlength="40" placeholder="e.g. Motu R."></label>`}
            <fieldset>
              <legend>Where</legend>
              <p id="f-where" class="note"></p>
              <div class="row">
                <button type="button" class="btn" id="f-gps">Use my location</button>
                <button type="button" class="btn" id="f-pick">Tap the map</button>
              </div>
            </fieldset>
            <label>Date found<input id="f-date" type="date" max="${new Date().toISOString().slice(0, 10)}"></label>
            <label>What do you think it is?<input id="f-taxon" placeholder="e.g. trilobite, Flexicalymene, crinoid stem" maxlength="120"></label>
            <label>Age (period)<input id="f-period" placeholder="filled in from the bedrock map" maxlength="60"></label>
            <label>Rock unit<input id="f-rock" placeholder="filled in from the bedrock map" maxlength="120"></label>
            <label>Notes<textarea id="f-notes" rows="3" maxlength="2000" placeholder="How you found it, size, what was around it"></textarea></label>
            <label>Photos (up to ${MAX_PHOTOS})<input id="f-photos" type="file" accept="image/*" multiple></label>
            <div id="f-previews" class="previews"></div>
            <p class="note">Others only see finds that have a photo. Without one, a find stays visible just to you.</p>
            <label class="toggle"><input id="f-private" type="checkbox"><span>Keep this find private</span></label>
            <label class="toggle"><input id="f-notable" type="checkbox"><span>Flag it for a museum to look at (bones, rare or unusual finds)</span></label>
            <button type="submit" class="btn btn-primary">Save find</button>
            <p id="f-msg" class="note"></p>
          </form>
        </div>`;
      FT.openPanel();
      const spot = { ...here };
      const setSpot = async (lng, lat) => {
        spot.lng = Number(lng.toFixed(5)); spot.lat = Number(lat.toFixed(5));
        document.getElementById("f-where").textContent = `${spot.lat}, ${spot.lng} (only you see the exact spot)`;
        if (pickMarker) pickMarker.remove();
        const el = document.createElement("div"); el.className = "place-pin";
        pickMarker = new maplibregl.Marker({ element: el }).setLngLat([spot.lng, spot.lat]).addTo(map);
        const rock = await bedrock(spot.lng, spot.lat);
        const p = document.getElementById("f-period"), r = document.getElementById("f-rock");
        if (rock && p && !p.dataset.touched) p.value = rock.period || "";
        if (rock && r && !r.dataset.touched) r.value = rock.unit || "";
      };
      setSpot(spot.lng, spot.lat);
      for (const id of ["f-period", "f-rock"]) document.getElementById(id).addEventListener("input", (e) => { e.target.dataset.touched = "1"; });
      document.getElementById("signout").addEventListener("click", async () => { await sb.auth.signOut(); FT.closePanel(); });
      document.getElementById("rename")?.addEventListener("click", () => {
        const who = document.getElementById("who");
        who.innerHTML = `<input id="new-name" minlength="2" maxlength="40" value="${esc(profile.display_name)}"> <button type="button" class="linklike" id="save-name">save</button>`;
        const input = document.getElementById("new-name");
        input.focus();
        document.getElementById("save-name").addEventListener("click", async () => {
          const name = input.value.trim();
          if (name.length < 2) { input.focus(); return; }
          const { data, error } = await sb.from("profiles").update({ display_name: name }).eq("id", user.id).select().single();
          if (error) { FT.setStatus("Couldn't save your name: " + error.message); return; }
          profile = data;
          showForm();
        });
      });
      document.getElementById("f-gps").addEventListener("click", () => {
        navigator.geolocation.getCurrentPosition(
          (pos) => { setSpot(pos.coords.longitude, pos.coords.latitude); map.easeTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: Math.max(map.getZoom(), 12) }); },
          () => { document.getElementById("f-where").textContent = "Couldn't get your location. Tap the map instead."; });
      });
      document.getElementById("f-pick").addEventListener("click", () => {
        picking = (lngLat) => setSpot(lngLat.lng, lngLat.lat);
        document.body.classList.add("picking");
        document.getElementById("f-where").textContent = "Tap the spot on the map…";
      });

      let files = [];
      document.getElementById("f-photos").addEventListener("change", (e) => {
        files = [...e.target.files].slice(0, MAX_PHOTOS);
        document.getElementById("f-previews").innerHTML = files.map((f) => `<img alt="" src="${URL.createObjectURL(f)}">`).join("");
      });

      document.getElementById("find-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const msg = document.getElementById("f-msg");
        const btn = e.target.querySelector("button[type=submit]");
        btn.disabled = true;
        try {
          if (!profile) {
            msg.textContent = "Saving your name…";
            const { data, error } = await sb.from("profiles").insert({ id: user.id, display_name: document.getElementById("f-name").value.trim() }).select().single();
            if (error) throw error;
            profile = data;
          }
          const paths = [];
          for (let i = 0; i < files.length; i++) {
            msg.textContent = `Uploading photo ${i + 1} of ${files.length}…`;
            const blob = await shrink(files[i]);
            const path = `${user.id}/${crypto.randomUUID()}.jpg`;
            const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg" });
            if (error) throw error;
            paths.push(path);
          }
          msg.textContent = "Saving…";
          const val = (id) => document.getElementById(id).value.trim() || null;
          const info = val("f-taxon") ? await taxonInfo(val("f-taxon")) : null;
          const { error } = await sb.from("finds").insert({
            location: `SRID=4326;POINT(${spot.lng} ${spot.lat})`,
            found_on: val("f-date"), taxon_guess: val("f-taxon"), taxon_name: info ? info.name : null, period_guess: val("f-period"), rock_unit: val("f-rock"),
            notes: val("f-notes"), photo_paths: paths,
            visibility: document.getElementById("f-private").checked ? "private" : "public",
            notable: document.getElementById("f-notable").checked,
          });
          if (error) throw error;
          if (pickMarker) { pickMarker.remove(); pickMarker = null; }
          msg.textContent = "Saved.";
          await loadCommunity();
          FT.closePanel();
          FT.setStatus(files.length ? "Find saved. It's the teal dot with the thick ring." : "Find saved. Add a photo later so others can see it; for now only you can.");
        } catch (err) {
          console.error(err);
          msg.textContent = `Couldn't save: ${err.message || err}`;
          btn.disabled = false;
        }
      });
    }

    // app.js asks this before opening "what rock is here", so a tap-to-place tap does only that.
    FT.beforePlaceClick = (e) => {
      if (!picking) return false;
      const fn = picking; picking = null;
      document.body.classList.remove("picking");
      fn(e.lngLat);
      return true;
    };

    async function bedrock(lng, lat) {
      try {
        const j = await fetchJSON(cached(`https://macrostrat.org/api/v2/mobile/map_query?lat=${lat.toFixed(3)}&lng=${lng.toFixed(3)}&z=10`));
        const u = ((j.success && j.success.data && j.success.data.burwell) || [])[0];
        if (!u) return null;
        const period = periodFromMa(Number(u.b_age ?? u.b_int_age), Number(u.t_age ?? u.t_int_age)) || periodFromName(u.b_int_name);
        return { period, unit: (u.strat_name || u.name || "").split(/;\s*/)[0] };
      } catch (err) { return null; }
    }

    // Re-encode through a canvas: smaller uploads, and the EXIF block (with any GPS position) is not carried over.
    async function shrink(file) {
      const img = await createImageBitmap(file);
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      return new Promise((ok) => canvas.toBlob(ok, "image/jpeg", 0.85));
    }

    // ---------- fossil names and ages (PBDB) ----------
    // Resolves a guess like "trilobite" or "Flexicalymene" to PBDB's scientific name and the span the group lived.
    const taxonCache = new Map();
    function taxonInfo(label) {
      const key = label.trim().toLowerCase();
      if (!taxonCache.has(key)) taxonCache.set(key, (async () => {
        try {
          const auto = await fetchJSON(cached(`${PBDB}/taxa/auto.json?name=${encodeURIComponent(key.slice(0, 60))}&limit=10`));
          const recs = (auto.records || []).filter((r) => r.typ === "txn");
          const hit = recs.find((r) => r.nam.toLowerCase() === key) || recs[0];
          if (!hit) return null;
          const j = await fetchJSON(cached(`${PBDB}/taxa/single.json?id=txn:${hit.oid}&show=app&vocab=pbdb`));
          const t = j.records && j.records[0];
          if (!t) return null;
          return { name: t.taxon_name, common: /^[a-z]/.test(hit.nam) ? hit.nam : null,
            maxMa: Number(t.firstapp_max_ma), minMa: Number(t.lastapp_min_ma) };
        } catch (err) { return null; }
      })());
      return taxonCache.get(key);
    }

    // Plausibility checks a viewer can see: does the fossil group's lifespan fit the claimed age and the bedrock?
    const HARD_ROCK = /granit|gneiss|migmat|schist|basalt|gabbro|diorit|rhyolit|andesit|volcan|igneous|metamorph|plutonic|quartzite|anorthosite/i;
    async function plausibility(f) {
      const label = f.community_taxon || f.taxon_name || f.taxon_guess;
      const [info, rock] = await Promise.all([label ? taxonInfo(label) : null, bedrockAt(f.lng, f.lat)]);
      const out = [];
      const lived = info && Number.isFinite(info.maxMa) && Number.isFinite(info.minMa) ? [info.maxMa, info.minMa] : null;
      const who = info ? (info.common ? `${info.common} (${info.name})` : info.name) : null;
      const pid = periodFromName(f.period_guess || "");
      const claimed = pid && { id: pid, start: PERIOD_SPANS[pid][0], end: PERIOD_SPANS[pid][1] };
      const overlaps = (a, b) => a[0] >= b[1] - 2 && b[0] >= a[1] - 2; // ranges in Ma, oldest first, 2 My slack
      if (lived && claimed) {
        out.push(overlaps(lived, [claimed.start, claimed.end])
          ? ["ok", `${who} lived ${maRange(lived[0], lived[1])}, which fits the ${claimed.id}.`]
          : ["warn", `${who} lived ${maRange(lived[0], lived[1])}, so a ${claimed.id} age doesn't fit.`]);
      } else if (label && !info) {
        out.push(["info", `"${label}" isn't a fossil group the Paleobiology Database knows, so its age can't be checked.`]);
      }
      if (rock) {
        const where = f.mine ? "at this spot" : "near this spot";
        if (HARD_ROCK.test(rock.lith)) {
          out.push(["warn", `The bedrock ${where} is ${rock.lith.split(/[.;]/)[0].toLowerCase()}, which almost never holds fossils. It may be a loose find carried from elsewhere.`]);
        } else if (lived && Number.isFinite(rock.maxMa)) {
          out.push(overlaps(lived, [rock.maxMa, rock.minMa])
            ? ["ok", `The bedrock ${where} (${maRange(rock.maxMa, rock.minMa)}) is the right age for it.`]
            : ["warn", `The bedrock ${where} is ${maRange(rock.maxMa, rock.minMa)}, outside the time ${info.name} lived. Loose finds can travel, but this is unusual.`]);
        }
      }
      return out;
    }
    async function bedrockAt(lng, lat) {
      try {
        const j = await fetchJSON(cached(`https://macrostrat.org/api/v2/mobile/map_query?lat=${lat.toFixed(3)}&lng=${lng.toFixed(3)}&z=10`));
        const u = ((j.success && j.success.data && j.success.data.burwell) || [])[0];
        if (!u) return null;
        return { lith: [u.lith, u.name].filter(Boolean).join(". "), maxMa: Number(u.b_age ?? u.b_int_age), minMa: Number(u.t_age ?? u.t_int_age) };
      } catch (err) { return null; }
    }

    // ---------- find details ----------
    function showFind(id) {
      const f = findById.get(id);
      if (!f) return;
      const selKey = `find:${id}`;
      FT.select(selKey);
      const photos = f.photo_paths || [];
      const period = periodFromName(f.period_guess || "");
      const confirmed = f.status === "confirmed";
      const title = confirmed ? f.community_taxon : (f.taxon_guess || "Unidentified find");
      panelBody.innerHTML = `
        ${photos.length ? `<figure class="figure"><img alt="Photo of this find" src="${esc(photoUrl(photos[0]))}">
          <figcaption><span class="badge find">Finder's photo</span><span>${photos.length > 1 ? `${photos.length} photos` : ""}</span></figcaption></figure>` : ""}
        <div class="panel-content">
          <div>
            <p class="eyebrow" style="color:${COLOR}">Amateur find${f.notable ? " · flagged for a museum" : ""}${f.mine ? " · yours" : ""}</p>
            <h2 class="common">${esc(title)}</h2>
            <p class="wikidesc"><span class="badge ${confirmed ? "confirmed" : "unverified"}">${confirmed ? "Confirmed" : "Unverified"}</span>
              ${confirmed ? `Identified by the community${f.taxon_guess && f.taxon_guess.toLowerCase() !== String(f.community_taxon).toLowerCase() ? `; the finder said "${esc(f.taxon_guess)}"` : ""}.`
                : "The finder's own identification, not yet confirmed by others."}</p>
          </div>
          ${f.mine && f.hidden ? `<p class="verdict no">Hidden from the map after several reports.</p>` : ""}
          ${f.mine && !photos.length ? `<p class="verdict maybe">No photo, so only you can see this find.</p>` : ""}
          <dl class="facts">
            ${fact("Found by", f.mine ? "You" : esc(f.display_name))}
            ${fact("Date found", f.found_on ? esc(f.found_on) : null)}
            ${fact("Age", f.period_guess ? `${ageChip(period)} ${esc(f.period_guess)}` : null)}
            ${fact("Rock unit", f.rock_unit ? esc(f.rock_unit) : null)}
            ${fact("Location", f.mine ? `${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}` : "Shown to within about 10 km")}
            ${f.mine && f.notes ? fact("Notes", esc(f.notes)) : ""}
          </dl>
          ${photos.length > 1 ? `<div class="previews">${photos.slice(1).map((p) => `<img alt="" src="${esc(photoUrl(p))}">`).join("")}</div>` : ""}
          <div class="checks" data-checks><p class="eyebrow">Does it add up?</p><div class="skeleton"></div></div>
          <div class="ids" data-ids><p class="eyebrow">Community ID</p><div class="skeleton"></div></div>
          ${f.mine ? "" : `<div class="report" data-report><button type="button" class="linklike" id="report-open">Report this find</button></div>`}
        </div>`;
      FT.openPanel();
      const open = document.getElementById("report-open");
      if (open) open.addEventListener("click", () => showReport(f));
      const current = () => FT.isSelected(selKey);

      plausibility(f).then((items) => {
        const box = current() && panelBody.querySelector("[data-checks]");
        if (!box) return;
        box.innerHTML = `<p class="eyebrow">Does it add up?</p>${items.length
          ? `<ul class="checklist">${items.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join("")}</ul>`
          : `<p class="dim">Not enough information to check this find.</p>`}
          <p class="dim small">Automatic checks against the Paleobiology Database and the bedrock map. A warning means "look twice", not "fake".</p>`;
      });
      renderIds(f, current);
    }

    async function renderIds(f, current) {
      const { data } = await sb.rpc("find_identifications", { fid: f.id });
      const box = current() && panelBody.querySelector("[data-ids]");
      if (!box) return;
      const ids = data || [];
      const myId = ids.find((i) => i.mine);
      const canId = user && !f.mine && f.visibility !== "private";
      const leading = f.community_taxon || f.taxon_name || f.taxon_guess;
      box.innerHTML = `
        <p class="eyebrow">Community ID${ids.length ? ` · ${ids.length}` : ""}</p>
        ${ids.length ? `<ul class="idlist">${ids.map((i) => `<li><strong>${esc(i.taxon_label)}</strong>${i.taxon_name && i.taxon_name.toLowerCase() !== i.taxon_label.toLowerCase() ? ` <i>${esc(i.taxon_name)}</i>` : ""} <span class="dim">· ${i.mine ? "you" : esc(i.display_name)}</span></li>`).join("")}</ul>`
          : `<p class="dim">No one else has identified this yet. A find is confirmed when two other people agree on what it is.</p>`}
        ${canId ? `
          <form id="id-form" class="form">
            ${myId ? `<p class="note">Your ID: <strong>${esc(myId.taxon_label)}</strong>. <button type="button" class="linklike" id="id-withdraw">Withdraw</button></p>` : ""}
            ${profile ? "" : `<label>Your name on the map<input id="id-name" minlength="2" maxlength="40" placeholder="shown next to your IDs"></label>`}
            <div class="row">
              ${leading && !myId ? `<button type="button" class="btn" id="id-agree">Agree: ${esc(leading)}</button>` : ""}
            </div>
            <label>${myId ? "Change your ID" : "Or suggest another ID"}<input id="id-taxon" maxlength="120" placeholder="e.g. Flexicalymene, crinoid, brachiopod"></label>
            <button type="submit" class="btn btn-primary">Save ID</button>
            <p id="id-msg" class="note"></p>
          </form>` : user || f.mine ? "" : `<p class="dim small"><button type="button" class="linklike" id="id-signin">Sign in</button> to help identify finds.</p>`}`;
      const signin = document.getElementById("id-signin");
      if (signin) signin.addEventListener("click", () => showSignIn());
      if (!canId) return;
      const msg = document.getElementById("id-msg");
      const done = async () => { await loadCommunity(); if (current()) showFind(f.id); };
      const save = async (label) => {
        if (!profile) {
          const name = document.getElementById("id-name").value.trim();
          if (name.length < 2) { msg.textContent = "Add the name to show next to your ID first."; return; }
          const { data, error } = await sb.from("profiles").insert({ id: user.id, display_name: name }).select().single();
          if (error) { msg.textContent = `Couldn't save your name: ${error.message}`; return; }
          profile = data;
        }
        msg.textContent = "Saving…";
        const info = await taxonInfo(label);
        const row = { taxon_label: label, taxon_name: info ? info.name : null };
        const { error } = myId
          ? await sb.from("identifications").update(row).eq("find_id", f.id).eq("user_id", user.id)
          : await sb.from("identifications").insert({ find_id: f.id, ...row });
        if (error) { msg.textContent = `Couldn't save: ${error.message}`; return; }
        done();
      };
      const agree = document.getElementById("id-agree");
      if (agree) agree.addEventListener("click", () => save(leading));
      const withdraw = document.getElementById("id-withdraw");
      if (withdraw) withdraw.addEventListener("click", async () => {
        const { error } = await sb.from("identifications").delete().eq("find_id", f.id).eq("user_id", user.id);
        if (error) msg.textContent = `Couldn't withdraw: ${error.message}`; else done();
      });
      document.getElementById("id-form").addEventListener("submit", (e) => {
        e.preventDefault();
        const label = document.getElementById("id-taxon").value.trim();
        if (label) save(label);
      });
    }

    function showReport(f) {
      const box = panelBody.querySelector("[data-report]");
      if (!box) return;
      if (!user) { showSignIn("Sign in to report a find. Reports from accounts keep the system from being abused."); return; }
      box.innerHTML = `
        <form id="report-form" class="form">
          <p class="eyebrow">What's wrong with this find?</p>
          ${REPORT_REASONS.map(([v, label], i) => `<label class="toggle"><input type="radio" name="reason" value="${v}"${i ? "" : " checked"}><span>${esc(label)}</span></label>`).join("")}
          <div class="row"><button type="submit" class="btn btn-primary">Send report</button><button type="button" class="btn" id="report-cancel">Cancel</button></div>
          <p id="report-msg" class="note"></p>
        </form>`;
      document.getElementById("report-cancel").addEventListener("click", () => showFind(f.id));
      document.getElementById("report-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const reason = new FormData(e.target).get("reason");
        const msg = document.getElementById("report-msg");
        msg.textContent = "Sending…";
        const { error } = await sb.from("reports").insert({ find_id: f.id, reason });
        if (error && error.code !== "23505") { msg.textContent = `Couldn't send the report: ${error.message}`; return; }
        box.innerHTML = `<p class="note">${error ? "You've already reported this find." : "Thanks. Finds with several reports are hidden until they're reviewed."}</p>`;
      });
    }
  }

  if (window.FossilTrace) start(); else document.addEventListener("fossiltrace:ready", start, { once: true });
})();
