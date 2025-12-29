/* ---------------- Course + storage ---------------- */

const getCourseId = () =>
  new URLSearchParams(location.search).get("id") || "unknown";

const COURSE_ID = getCourseId();
const STORAGE_KEY = `panopto-completed-${COURSE_ID}`;

const WORKER_URL = "https://ele-suite.harveychandler235.workers.dev";
const API_KEY = "supersecret123"; // optional: prevents random external requests
const SYNC_KEY = "panopto_sync_enabled"; // chrome.storage.local key for sync setting

// Helper wrappers for chrome.storage.local with Promise API
function getChromeStorage(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (res) => resolve(res || {}));
    } catch (e) {
      resolve({});
    }
  });
}

function setChromeStorage(obj) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(obj, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

/* ---------------- Cached email ---------------- */

let cachedEmailPromise = null;

function getEmailOnce() {
  if (cachedEmailPromise) return cachedEmailPromise;

  cachedEmailPromise = (async () => {
    try {
      const res = await fetch("/user/profile.php", { credentials: "include" });
      if (!res.ok) throw new Error("Profile fetch failed");

      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const mailLink = doc.querySelector('a[href^="mailto:"]');
      if (!mailLink) return null;

      const email = decodeURIComponent(mailLink.getAttribute("href").replace("mailto:", ""));
      return email;
    } catch (e) {
      console.error("Failed to fetch email:", e);
      return null;
    }
  })();

  return cachedEmailPromise;
}

/* ---------------- Cloudflare Worker sync ---------------- */

async function getCompletionsCloudflare(email) {
  try {
    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY
      },
      body: JSON.stringify({ email, action: "get" })
    });
    if (!res.ok) return {};
    return await res.json();
  } catch (e) {
    console.error("Cloudflare GET failed:", e);
    return {};
  }
}

async function saveCompletionsCloudflare(email, data) {
  try {
    await fetch(WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY
      },
      body: JSON.stringify({ email, completions: data, action: "set" })
    });
  } catch (e) {
    console.error("Cloudflare POST failed:", e);
  }
}

/* ---------------- Auto expand lectures ---------------- */

function autoShowAll() {
  const toggle = document.getElementById("showAllToggle");
  if (!toggle) return;

  if (toggle.textContent.trim().toLowerCase() === "show all") {
    const showAllToggle = document.getElementById("showAllToggle");
    const hiddenLecturesDiv = document.getElementById("hiddenLecturesDiv");
    if (hiddenLecturesDiv.style.display == "block") {
      hiddenLecturesDiv.style.display = "none";
      showAllToggle.innerHTML = "Show all";
    } else {
      hiddenLecturesDiv.style.display = "block";
      showAllToggle.innerHTML = "Show less";
    }
  }
}

/* ---------------- Modal system ---------------- */

function showModal(titleText, bodyNode, buttons) {
  const overlay = document.createElement("div");
  overlay.dataset.panoptoOverlay = "1";
  overlay.style = `
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.45);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  `;

  const modal = document.createElement("div");
  modal.style = `
    background: white;
    padding: 18px;
    border-radius: 8px;
    width: 420px;
    font-family: system-ui;
  `;

  const title = document.createElement("h3");
  title.textContent = titleText;
  modal.append(title);
  modal.append(bodyNode);

  const btnRow = document.createElement("div");
  btnRow.style = "margin-top: 15px; text-align: right;";

  modal.append(btnRow);
  overlay.append(modal);
  document.body.append(overlay);

  const close = () => overlay.remove();

  buttons.forEach(({ label, onClick }) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style = "margin-left: 8px;";
    b.onclick = () => onClick(close);
    btnRow.append(b);
  });
}

function addNotesModal(title, initial, onSave) {
  const container = document.createElement("div");

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "https://...";
  input.value = initial || "";
  input.style = "width:100%; padding:6px;";

  const warning = document.createElement("p");
  warning.innerHTML =
    "<strong>Warning:</strong> Notes links are stored on our server without authentication. Only use links that require login to keep them private.<br>One way to keep the links private is to share a OneDrive link with setting: <strong>(Only people with existing access</strong> can view)</p>";
  warning.style = "color:#b00020; font-size:0.85em; margin-top:8px;";

  container.append(input, warning);

  showModal("Link to notes", container, [
    { label: "Cancel", onClick: (close) => close() },
    {
      label: "Save",
      onClick: (close) => {
        onSave(input.value.trim());
        close();
      }
    }
  ]);
}

/* ---------------- Sync setting helpers & UI ---------------- */

let syncEnabledCached = null;

async function isSyncEnabled() {
  if (syncEnabledCached !== null) return !!syncEnabledCached;
  const res = await getChromeStorage([SYNC_KEY]);
  if (res[SYNC_KEY] === undefined) {
    // fall back to site localStorage if present (migration path)
    try {
      const v = localStorage.getItem(SYNC_KEY);
      if (v !== null) {
        syncEnabledCached = v === "1";
        await setChromeStorage({ [SYNC_KEY]: syncEnabledCached });
        return syncEnabledCached;
      }
    } catch (e) {}
    return false;
  }
  syncEnabledCached = res[SYNC_KEY] === true || res[SYNC_KEY] === "1" || res[SYNC_KEY] === 1;
  return !!syncEnabledCached;
}

async function setSyncEnabled(enabled) {
  syncEnabledCached = !!enabled;
  await setChromeStorage({ [SYNC_KEY]: !!enabled });
}

async function showSyncOptInIfNeeded() {
  const res = await getChromeStorage([SYNC_KEY]);
  if (res[SYNC_KEY] !== undefined) return;

  const p = document.createElement("p");
  p.textContent = "Would you like to enable optional cloud sync so your lecture completions and notes links can be available across your devices?";

  showModal("Enable cloud sync?", p, [
    { label: "No — Keep local", onClick: async (close) => { await setSyncEnabled(false); close(); } },
    { label: "Yes — Sync across devices", onClick: async (close) => { await setSyncEnabled(true); close(); } }
  ]);
}

function addSyncToggleButton() {
  if (document.getElementById("panoptoSyncToggleBtn")) return;
  const btn = document.createElement("button");
  btn.id = "panoptoSyncToggleBtn";
  btn.style = "position:fixed;right:12px;bottom:12px;z-index:9998;padding:8px 10px;border-radius:6px;border:1px solid rgba(0,0,0,0.08);background:#fff;box-shadow:0 2px 6px rgba(0,0,0,0.08);cursor:pointer;font-size:0.9rem;";

  const updateLabel = async () => {
    const on = await isSyncEnabled();
    btn.textContent = `Sync: ${on ? "On" : "Off"}`;
  };

  btn.onclick = async () => {
    const current = await isSyncEnabled();
    const p = document.createElement("p");
    p.innerHTML = `Current sync: <strong>${current ? "On" : "Off"}</strong>.<br/>Enable cloud sync to back up and share your completion state and notes links across devices.`;
    showModal("Sync settings", p, [
      { label: "Disable", onClick: async (close) => { await setSyncEnabled(false); await updateLabel(); close(); } },
      { label: "Enable", onClick: async (close) => { await setSyncEnabled(true); await updateLabel(); close(); } },
      { label: "Close", onClick: (close) => close() }
    ]);
  };

  updateLabel();
  document.body.append(btn);
}

function openNotesModal(title, url, onEdit) {
  const p = document.createElement("p");
  p.textContent = `Open notes for "${title}"`;

  showModal("Notes", p, [
    {
      label: "Edit",
      onClick: (close) => {
        close();
        onEdit();
      }
    },
    {
      label: "OK",
      onClick: (close) => {
        window.open(url, "_blank");
        close();
      }
    }
  ]);
}

/* ---------------- Core injection ---------------- */

async function inject() {
  const container = document.querySelector("#block_panopto_content");
  if (!container) return;

  const links = container.querySelectorAll(
    "a[href*='Panopto/Pages/Viewer.aspx']"
  );

  const email = await getEmailOnce(); // fetch logged-in email if available
  const syncEnabled = await isSyncEnabled();

  let cloudData = {};
  if (syncEnabled && email) {
    cloudData = await getCompletionsCloudflare(email);
  }

  chrome.storage.local.get([STORAGE_KEY], (res) => {
    const localData = res[STORAGE_KEY] || {};
    const data = { ...cloudData, ...localData };

    links.forEach((link) => {
      if (link.dataset.tracked) return;
      link.dataset.tracked = "true";

      const key = link.href;
      data[key] ||= {};

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!data[key].completed;
      cb.style.marginRight = "6px";

      cb.onchange = async () => {
        data[key].completed = cb.checked;
        chrome.storage.local.set({ [STORAGE_KEY]: data });
        styleLink(link, cb.checked);
          if (await isSyncEnabled() && email) await saveCompletionsCloudflare(email, data);
      };

      styleLink(link, cb.checked);

      const notes = document.createElement("span");
      notes.textContent = "[notes]";
      notes.style = `
        margin-right: 6px;
        font-size: 0.85em;
        color: ${data[key].notesUrl ? "#1a73e8" : "#555"};
        cursor: pointer;
      `;

      notes.onmouseenter = () => (notes.style.textDecoration = "underline");
      notes.onmouseleave = () => (notes.style.textDecoration = "none");

      notes.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();

        const title = link.textContent.trim();
        const url = data[key].notesUrl;

        if (!url) {
          addNotesModal(title, "", async (newUrl) => {
            data[key].notesUrl = newUrl;
            chrome.storage.local.set({ [STORAGE_KEY]: data });
            if (await isSyncEnabled() && email) await saveCompletionsCloudflare(email, data);
            notes.style.color = "#1a73e8";
          });
        } else {
          openNotesModal(title, url, () => {
            addNotesModal(title, url, async (newUrl) => {
              data[key].notesUrl = newUrl;
              chrome.storage.local.set({ [STORAGE_KEY]: data });
              if (await isSyncEnabled() && email) await saveCompletionsCloudflare(email, data);
            });
          });
        }
      };

      link.parentElement.prepend(notes);
      link.parentElement.prepend(cb);
    });
  });
}

function styleLink(link, done) {
  link.style.textDecoration = done ? "line-through" : "";
  link.style.opacity = done ? "0.6" : "1";
}

/* ---------------- Custom Speed Menu ---------------- */

function addSpeedMenuIfPresent() {
  const ul = document.querySelector('ul.MuiList-root[role="menu"]');
  if (!ul) return;
  if (ul.dataset.panoptoSpeedInjected) return;
  ul.dataset.panoptoSpeedInjected = "1";

  // Create the speed menu item (left icon / label / current value / chevron)
  const li = document.createElement("li");
  li.className =
    "MuiButtonBase-root MuiMenuItem-root css-2gv1q0 MuiMenuItem-gutters css-z5h7p3";
  li.tabIndex = -1;
  li.setAttribute("role", "menuitem");
  li.style = "display:flex; align-items:center; justify-content:space-between; cursor:pointer;";

  li.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px;">
      <div style="width:24px; height:24px; display:flex; align-items:center; justify-content:center;">
        <svg viewBox="0 0 24 24" role="presentation" width="20" height="20"><path d="M12,16A3,3 0 0,1 9,13C9,11.88 9.61,10.9 10.5,10.39L20.21,4.77L14.68,14.35C14.18,15.33 13.17,16 12,16M12,3C13.81,3 15.5,3.5 16.97,4.32L14.87,5.53C14,5.19 13,5 12,5A8,8 0 0,0 4,13C4,15.21 4.89,17.21 6.34,18.65H6.35C6.74,19.04 6.74,19.67 6.35,20.06C5.96,20.45 5.32,20.45 4.93,20.07V20.07C3.12,18.26 2,15.76 2,13A10,10 0 0,1 12,3M22,13C22,15.76 20.88,18.26 19.07,20.07V20.07C18.68,20.45 18.05,20.45 17.66,20.06C17.27,19.67 17.27,19.04 17.66,18.65V18.65C19.11,17.2 20,15.21 20,13C20,12 19.81,11 19.46,10.1L20.67,8C21.5,9.5 22,11.18 22,13Z" style="fill: currentcolor;"></path></svg>
      </div>
      <div style="font-size:0.95rem; color:inherit;">ELE Suite Speed Changer</div>
    </div>
    <div style="display:flex; align-items:center; gap:8px;">
      <div id="panoptoSpeedLabel" style="font-size:0.95rem; color:rgb(59,130,246); font-weight:600;">1x</div>
      <div style="width:24px; height:24px; display:flex; align-items:center; justify-content:center;">
        <svg viewBox="0 0 24 24" role="presentation" width="20" height="20"><path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z" style="fill: currentcolor;"></path></svg>
      </div>
    </div>
  `;

  // Slider container appended after the UL (hidden by default)
  const sliderContainer = document.createElement("div");
  sliderContainer.id = "panoptoSpeedContainer";
  sliderContainer.style = "display:none; padding:8px 12px 12px 12px;";
  sliderContainer.innerHTML = `
    <div style="display: flex; align-items: center; padding-left: 20px; padding-right: 20px;">
      <span style="font-size: 0.875rem; color: rgb(113, 113, 122); margin-right: 8px;">Select a value:</span>
      <input type="range" id="dynamicSlider" name="dynamicSlider" min="0.5" max="4" step="0.25" style="width: 100%; height: 8px; background-color: rgb(59, 130, 246); border-radius: 8px; appearance: none; cursor: pointer;" />
      <span id="sliderValue" title="Click to edit the speed" style="margin-left: 8px; font-size: 1.125rem; font-weight: bold; color: rgb(59, 130, 246); cursor: pointer;">2.5x</span>
    </div>
    <div style="display: flex; align-items: center; margin-bottom: 5px; padding-left: 25px; padding-top: 11px;">
      <input id="startupSpeed" type="checkbox" value="" style="width: 16px; height: 16px; vertical-align: middle;" />
      <label for="startupSpeed" style="margin-left: 8px; font-size: 0.875rem; color: rgb(113, 113, 122);">Change speed on startup</label>
    </div>
  `;

  // Insert into DOM
  ul.appendChild(li);
  ul.parentElement && ul.parentElement.appendChild(sliderContainer);

  // Initialize UI with defaults, then load stored settings from chrome.storage.local (fallback to site localStorage)
  const slider = sliderContainer.querySelector("#dynamicSlider");
  const sliderValue = sliderContainer.querySelector("#sliderValue");
  const startup = sliderContainer.querySelector("#startupSpeed");
  const speedLabel = li.querySelector("#panoptoSpeedLabel");

  const setUI = (v) => {
    const num = Number(v) || 0;
    const fmt = num.toFixed(2);
    if (slider) slider.value = String(num);
    if (sliderValue) sliderValue.textContent = `${fmt}x`;
    if (speedLabel) speedLabel.textContent = `${fmt}x`;
  };

  setUI(1);
  if (startup) startup.checked = false;

  // Load persisted speed settings (async). Prefer chrome.storage, fall back to site localStorage for migration.
  (async () => {
    try {
      const res = await getChromeStorage(["panopto_custom_speed"]);
      let stored = res["panopto_custom_speed"];
      if (!stored) {
        try {
          stored = JSON.parse(localStorage.getItem("panopto_custom_speed") || "null");
        } catch (e) {
          stored = null;
        }
      }
      stored = stored || { value: 1, startup: false };
      setUI(stored.value || 1);
      if (startup) startup.checked = !!stored.startup;
      if (stored.startup) applySpeedToVideo(stored.value || 1);
    } catch (e) {
      // ignore
    }
  })();

  function applySpeedToVideo(val) {
    const videos = document.querySelectorAll("video");
    if (!videos || videos.length === 0) return false;
    videos.forEach((v) => {
      try {
        v.playbackRate = Number(val);
      } catch (e) {}
    });
    return true;
  }

  // Click toggles slider visibility and shift menu up if it would overflow (e.g. fullscreen)
  li.addEventListener("click", () => {
    const wasHidden = sliderContainer.style.display === "none" || !sliderContainer.style.display;
    if (wasHidden) {
      sliderContainer.style.display = "block";

      // Allow layout to update then measure overflow
      requestAnimationFrame(() => {
        const menuContainer = ul.parentElement || ul;
        const containerRect = sliderContainer.getBoundingClientRect();
        const overflow = containerRect.bottom - window.innerHeight;
        if (overflow > 0) {
          const shift = overflow + 8; // small padding
          menuContainer.style.transform = `translateY(-${shift}px)`;
          menuContainer.dataset.panoptoShifted = "1";
        }
      });
    } else {
      sliderContainer.style.display = "none";
      const menuContainer = ul.parentElement || ul;
      if (menuContainer.dataset.panoptoShifted) {
        menuContainer.style.transform = "";
        delete menuContainer.dataset.panoptoShifted;
      }
      sliderContainer.style.transform = "";
      sliderContainer.removeAttribute("data-panopto-shifted");
    }
  });

  // Slider interactions
  slider && slider.addEventListener("input", async (e) => {
    const v = Number(e.target.value);
    setUI(v);
    applySpeedToVideo(v);
    await setChromeStorage({ panopto_custom_speed: { value: v, startup: !!startup.checked } });
  });

  // Click to edit numeric value
  sliderValue && sliderValue.addEventListener("click", async () => {
    const current = parseFloat(slider.value || "1");
    const input = prompt("Enter playback speed (0.5 - 3):", String(current));
    if (!input) return;
    const num = Math.min(3, Math.max(0.5, Number(input)));
    setUI(num);
    if (slider) slider.value = String(num);
    applySpeedToVideo(num);
    await setChromeStorage({ panopto_custom_speed: { value: num, startup: !!startup.checked } });
  });

  // Startup checkbox
  startup && startup.addEventListener("change", async () => {
    const v = Number(slider.value || "1");
    await setChromeStorage({ panopto_custom_speed: { value: v, startup: !!startup.checked } });
  });

  // If startup enabled, apply immediately
  if (stored.startup) applySpeedToVideo(stored.value || 1);
}

/* ---------------- Observer ---------------- */

let injectTimeout = null;
const observer = new MutationObserver(() => {
  // Ignore mutations caused by our modal overlay to avoid triggering
  // unnecessary Cloudflare worker requests when the modal opens.
  if (document.querySelector("[data-panopto-overlay]")) return;

  autoShowAll();
  addSpeedMenuIfPresent();
  if (injectTimeout) clearTimeout(injectTimeout);
  injectTimeout = setTimeout(inject, 300);
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});

// Initial run
autoShowAll();
inject();
addSpeedMenuIfPresent();
// Show opt-in prompt (only if not previously set) and add sync toggle
showSyncOptInIfNeeded();
addSyncToggleButton();
