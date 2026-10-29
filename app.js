const reactions = [["👍", "Like", 0], ["❤️", "Heart", 1], ["😆", "Haha", 2], ["😢", "Sad", 4], ["😡", "Angry", 5]];
const $ = (id) => document.getElementById(id);
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};

const themeRoot = document.documentElement;
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const savedTheme = LS.get("nglmb-theme");
if (savedTheme === "light" || savedTheme === "dark") themeRoot.dataset.theme = savedTheme;

function updateThemeToggle() {
  const isDark = themeRoot.dataset.theme
    ? themeRoot.dataset.theme === "dark"
    : systemTheme.matches;
  document.querySelectorAll(".theme-toggle").forEach((toggle) => {
    toggle.innerHTML = `<span aria-hidden="true">${isDark ? "☀" : "☾"}</span>`;
    toggle.setAttribute("aria-label", `Switch to ${isDark ? "light" : "dark"} mode`);
    toggle.title = `Switch to ${isDark ? "light" : "dark"} mode`;
  });
}

updateThemeToggle();
document.querySelectorAll(".theme-toggle").forEach((toggle) => toggle.addEventListener("click", () => {
  const isDark = themeRoot.dataset.theme
    ? themeRoot.dataset.theme === "dark"
    : systemTheme.matches;
  const nextTheme = isDark ? "light" : "dark";
  themeRoot.dataset.theme = nextTheme;
  LS.set("nglmb-theme", nextTheme);
  updateThemeToggle();
}));
systemTheme.addEventListener("change", () => {
  if (!themeRoot.dataset.theme) updateThemeToggle();
});

// Anonymous id so each visitor keeps one reaction per post (no personal data).
let voter = LS.get("voter");
if (!voter) {
  voter = crypto.randomUUID ? crypto.randomUUID() : ("v" + Date.now() + Math.random().toString(16).slice(2)).padEnd(24, "0");
  LS.set("voter", voter);
}

let admin = null;
let member = null;
let siteInitialized = false;
let nglLinks = [];
let posts = [];

async function api(action, body) {
  let path;
  let method = "GET";
  let payload = body;
  let auth = "none";
  switch (action) {
    case "posts": path = "/api/posts"; break;
    case "settings": path = "/api/settings"; break;
    case "react":
      path = `/api/posts/${encodeURIComponent(body.id)}/react`;
      method = "POST";
      payload = { kind: body.kind };
      break;
    case "comment_add":
      path = `/api/posts/${encodeURIComponent(body.id)}/comments`;
      method = "POST";
      payload = { text: body.text };
      break;
    case "login": path = "/api/auth/login"; method = "POST"; break;
    case "me": path = "/api/auth/me"; auth = "admin"; break;
    case "logout":
      LS.del("nglmb-admin-token");
      return { ok: true };
    case "ngl_save": path = "/api/settings/ngl"; method = "PUT"; auth = "admin"; payload = { link: body.link }; break;
    case "post_create": path = "/api/posts"; method = "POST"; auth = "admin"; break;
    case "post_update":
      path = `/api/posts/${encodeURIComponent(body.id)}`;
      method = "PUT";
      auth = "admin";
      break;
    case "post_delete": path = `/api/posts/${encodeURIComponent(body.id)}`; method = "DELETE"; auth = "admin"; break;
    case "admins": path = "/api/admins"; auth = "admin"; break;
    case "admin_add": path = "/api/admins"; method = "POST"; auth = "admin"; break;
    case "admin_delete": path = `/api/admins/${encodeURIComponent(body.id)}`; method = "DELETE"; auth = "admin"; break;
    case "admin_password_reset": path = "/api/auth/password"; method = "PUT"; auth = "admin"; payload = { current: body.currentPassword, next: body.newPassword }; break;
    case "account_register": path = "/api/account/register"; method = "POST"; break;
    case "account_login": path = "/api/account/login"; method = "POST"; break;
    case "account_me": path = "/api/account/me"; auth = "member"; break;
    case "account_logout":
      LS.del("nglmb-member-token");
      return { ok: true };
    case "account_forgot_password":
    case "account_reset_password":
      throw new Error("Password resets are not available on this server.");
    default:
      throw new Error("This action is not available.");
  }

  const headers = { "Content-Type": "application/json", "X-Voter": voter };
  if (auth === "admin") {
    const token = LS.get("nglmb-admin-token");
    if (token) headers.Authorization = "Bearer " + token;
  } else if (auth === "member") {
    const token = LS.get("nglmb-member-token");
    if (token) headers["X-Member-Token"] = token;
  }
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    if (res.status === 401 && admin) { admin = null; renderAdminUI(); }
    const err = new Error((data && data.error) || "Something went wrong. Try again.");
    err.status = res.status;
    throw err;
  }
  if (action === "login") {
    if (!data || !data.token || !data.admin) throw new Error("The admin service returned an invalid response.");
    LS.set("nglmb-admin-token", data.token);
    return { admin: data.admin };
  }
  if (action === "account_register" || action === "account_login") {
    if (!data || !data.token || !data.member) throw new Error("The account service returned an invalid response.");
    LS.set("nglmb-member-token", data.token);
  }
  return data;
}

function ago(t) {
  const timestamp = Number(t);
  const milliseconds = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  const m = Math.round((Date.now() - milliseconds) / 6e4);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + " h ago";
  return Math.round(h / 24) + " d ago";
}

function say(msg) {
  const notice = $("nglNotice") || $("accountError");
  if (notice) notice.textContent = msg;
  else console.error(msg);
}

function photoDataUrl(file) {
  if (!file) return Promise.resolve(null);
  if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type) || file.size > 3 * 1024 * 1024) {
    return Promise.reject(new Error("Choose a JPG, PNG, GIF, or WebP image under 3 MB."));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

/* ---------- Render ---------- */
function makeIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.appendChild(use);
  return svg;
}

let feedView = "home";
let feedSort = "latest";
let savedPosts = new Set();
try {
  const storedSaved = JSON.parse(LS.get("nglmb-saved") || "[]");
  if (Array.isArray(storedSaved)) savedPosts = new Set(storedSaved.map(String));
} catch (error) {
  savedPosts = new Set();
}
const commentVisibility = new Map();

function reactionTotal(post) {
  return (post.r || []).reduce((total, count) => total + Number(count || 0), 0);
}

function updateFeedControls() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === feedView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll("[data-sort]").forEach((button) => {
    const active = button.dataset.sort === feedSort;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function renderPosts() {
  const list = $("list");
  if (!list) return;
  list.textContent = "";
  const query = ($("search")?.value || "").trim().toLowerCase();
  const visible = posts.filter((post) => {
    const matchesSearch = `${post.text || ""} ${post.posted_by || ""} ${post.id}`.toLowerCase().includes(query);
    return matchesSearch && (feedView !== "saved" || savedPosts.has(String(post.id)));
  });
  visible.sort((a, b) => {
    if (feedView === "popular" || feedSort === "trending") return reactionTotal(b) - reactionTotal(a);
    return Number(b.t || 0) - Number(a.t || 0);
  });
  const count = $("feedCount");
  if (count) count.textContent = visible.length + (visible.length === 1 ? " story" : " stories");

  if (!visible.length) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = posts.length
      ? feedView === "saved" ? "You haven't saved any stories yet. Use the bookmark on a confession to keep it here." : "No confessions match your search. Try another word."
      : "No confessions yet. Check back soon for new stories.";
    list.appendChild(d);
    updateFeedControls();
    return;
  }
  visible.forEach((p) => {
    const el = document.createElement("article");
    el.className = "card";
    el.id = "post-" + p.id;
    el.dataset.id = p.id;

    const body = document.createElement("div");
    body.className = "card-body";
    const header = document.createElement("div");
    header.className = "post-header";
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.appendChild(makeIcon("ghost"));
    const identity = document.createElement("div");
    identity.className = "post-identity";
    const anonymous = document.createElement("div");
    anonymous.className = "author";
    anonymous.textContent = "Anonymous";
    const meta = document.createElement("div");
    meta.className = "meta";
    const id = document.createElement("span");
    id.textContent = "Confession #" + String(posts.length - posts.indexOf(p)).padStart(3, "0");
    const when = document.createElement("span");
    when.textContent = " · " + ago(p.t);
    meta.append(id, when);
    identity.append(anonymous, meta);
    const authorTag = document.createElement("span");
    authorTag.className = "author-tag";
    authorTag.textContent = "Admin post · " + (p.posted_by || p.admin_name || "Admin");
    header.append(avatar, identity, authorTag);

    const text = document.createElement("p");
    text.className = "post-text";
    text.textContent = p.text || "";
    if (!p.text) text.hidden = true;
    body.append(header, text);
    if (p.photo) {
      const photo = document.createElement("img");
      photo.className = "post-photo";
      photo.src = p.photo;
      photo.alt = "Photo attached to this confession";
      body.appendChild(photo);
    }

    const actions = document.createElement("div");
    actions.className = "actions";
    reactions.forEach(([emoji, name, kind]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "action reaction" + (p.mine === kind ? " liked" : "");
      button.title = name;
      button.setAttribute("aria-label", name + ", " + Number((p.r || [])[kind] || 0));
      button.setAttribute("aria-pressed", String(p.mine === kind));
      const emojiNode = document.createElement("span");
      emojiNode.className = "reaction-emoji";
      emojiNode.textContent = emoji;
      const countNode = document.createElement("span");
      countNode.textContent = Number((p.r || [])[kind] || 0);
      button.append(emojiNode, countNode);
      button.onclick = async () => {
        try {
          await api("react", { id: p.id, kind: p.mine === kind ? null : kind });
          await loadPosts();
        } catch (e) { say(e.message); }
      };
      actions.appendChild(button);
    });
    const commentsAction = document.createElement("button");
    commentsAction.type = "button";
    commentsAction.className = "action";
    commentsAction.dataset.action = "comments";
    const hasComments = (p.comments || []).length > 0;
    const commentsAreVisible = commentVisibility.has(String(p.id))
      ? commentVisibility.get(String(p.id))
      : hasComments;
    commentsAction.setAttribute("aria-expanded", String(commentsAreVisible));
    commentsAction.setAttribute("aria-controls", "comments-" + p.id);
    commentsAction.append(makeIcon("comment"));
    const commentCount = document.createElement("span");
    commentCount.textContent = (p.comments || []).length;
    commentsAction.appendChild(commentCount);

    const shareAction = document.createElement("button");
    shareAction.type = "button";
    shareAction.className = "action";
    shareAction.dataset.action = "share";
    shareAction.setAttribute("aria-label", "Share confession");
    shareAction.appendChild(makeIcon("share"));

    const saveAction = document.createElement("button");
    saveAction.type = "button";
    saveAction.className = "action bookmark" + (savedPosts.has(String(p.id)) ? " saved" : "");
    saveAction.dataset.action = "save";
    saveAction.setAttribute("aria-label", savedPosts.has(String(p.id)) ? "Remove saved confession" : "Save confession");
    saveAction.setAttribute("aria-pressed", String(savedPosts.has(String(p.id))));
    saveAction.appendChild(makeIcon("bookmark"));
    actions.append(commentsAction, shareAction, saveAction);
    body.appendChild(actions);
    el.appendChild(body);

    if (admin) {
      const adminActions = document.createElement("div");
      adminActions.className = "post-admin-actions";
      const edit = document.createElement("button");
      edit.className = "btn ghost small";
      edit.type = "button";
      edit.textContent = "Edit";
      edit.onclick = () => {
        adminActions.textContent = "";
        const form = document.createElement("form");
        form.className = "post-edit-form";
        const text = document.createElement("textarea");
        text.value = p.text;
        text.maxLength = 2000;
        text.setAttribute("aria-label", "Edit confession");
        const photoLabel = document.createElement("label");
        photoLabel.textContent = "Replace photo";
        const photoInput = document.createElement("input");
        photoInput.type = "file";
        photoInput.accept = "image/jpeg,image/png,image/gif,image/webp";
        const removeLabel = document.createElement("label");
        removeLabel.className = "remove-photo-label";
        const removePhoto = document.createElement("input");
        removePhoto.type = "checkbox";
        removeLabel.append(removePhoto, document.createTextNode(" Remove current photo"));
        const save = document.createElement("button");
        save.className = "btn red small";
        save.textContent = "Save changes";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn ghost small";
        cancel.textContent = "Cancel";
        cancel.onclick = renderPosts;
        form.append(text, photoLabel, photoInput);
        if (p.photo) form.appendChild(removeLabel);
        form.append(save, cancel);
        form.onsubmit = async (event) => {
          event.preventDefault();
          try {
            const photo = await photoDataUrl(photoInput.files[0]);
            const body = { id: p.id, text: text.value, removePhoto: removePhoto.checked && !photo };
            if (photo) body.photo = photo;
            await api("post_update", body);
            await loadPosts();
          } catch (e) { say(e.message); }
        };
        adminActions.appendChild(form);
        text.focus();
      };
      const remove = document.createElement("button");
      remove.className = "btn ghost small post-delete";
      remove.type = "button";
      remove.textContent = "Delete";
      remove.onclick = async () => {
        if (!confirm("Delete this confession?")) return;
        try { await api("post_delete", { id: p.id }); await loadPosts(); } catch (e) { say(e.message); }
      };
      adminActions.append(edit, remove);
      body.appendChild(adminActions);
    }

    const comments = document.createElement("section");
    comments.className = "comments";
    comments.id = "comments-" + p.id;
    comments.hidden = !commentsAreVisible;
    comments.setAttribute("aria-label", "Comments");
    const commentsTitle = document.createElement("h3");
    commentsTitle.textContent = "A little support from the community";
    comments.appendChild(commentsTitle);
    const commentList = document.createElement("ul");
    commentList.className = "comment-list";
    (p.comments || []).forEach((comment) => {
      const item = document.createElement("li");
      item.textContent = comment.text;
      commentList.appendChild(item);
    });
    if (!commentList.children.length) {
      const emptyComments = document.createElement("li");
      emptyComments.className = "no-comments";
      emptyComments.textContent = "No comments yet.";
      commentList.appendChild(emptyComments);
    }
    comments.appendChild(commentList);
    const commentForm = document.createElement("form");
    commentForm.className = "comment-form";
    const commentInput = document.createElement("input");
    commentInput.type = "text";
    commentInput.required = true;
    commentInput.maxLength = 1000;
    commentInput.placeholder = "Write a comment...";
    commentInput.setAttribute("aria-label", "Write a comment");
    const commentSubmit = document.createElement("button");
    commentSubmit.className = "primary";
    commentSubmit.type = "submit";
    commentSubmit.setAttribute("aria-label", "Post comment");
    commentSubmit.appendChild(makeIcon("send"));
    commentForm.append(commentInput, commentSubmit);
    commentForm.onsubmit = async (event) => {
      event.preventDefault();
      try {
        await api("comment_add", { id: p.id, text: commentInput.value });
        commentVisibility.set(String(p.id), true);
        await loadPosts();
      } catch (e) { say(e.message); }
    };
    comments.appendChild(commentForm);
    el.appendChild(comments);
    list.appendChild(el);
  });
  updateFeedControls();
}

function renderNgl() {
  const select = $("adminLinkSelect");
  const confessionLink = $("confessionLink");
  const selectedLink = select.value;
  select.replaceChildren(new Option("Select an admin", ""));
  nglLinks.forEach((entry) => {
    const name = entry.name.trim().toLowerCase() === "main admin" ? "Admin" : entry.name;
    const option = new Option(name, entry.ngl);
    select.add(option);
  });
  if (nglLinks.some((entry) => entry.ngl === selectedLink)) {
    select.value = selectedLink;
  }
  const selected = nglLinks.find((entry) => entry.ngl === select.value);
  confessionLink.hidden = !selected;
  if (selected) confessionLink.href = selected.ngl;
  else confessionLink.removeAttribute("href");
  select.disabled = nglLinks.length === 0;
  if (!nglLinks.length) {
    select.replaceChildren(new Option("No admin links available", ""));
  }
  if (admin && $("nglInput").value !== admin.ngl) $("nglInput").value = admin.ngl || "";
  if (admin && !admin.ngl) {
    $("nglNotice").dataset.state = "missing-admin";
    say("Add your NGL link in the admin panel below.");
  } else if (nglLinks.length) {
    if (["missing", "missing-admin"].includes($("nglNotice").dataset.state)) say("");
    $("nglNotice").dataset.state = "";
  } else {
    $("nglNotice").dataset.state = "missing";
    say("Admin NGL links are not set yet. Please check back soon.");
  }
}

$("adminLinkSelect").addEventListener("change", renderNgl);

function renderAdmins(rows) {
  const ul = $("adminList");
  ul.textContent = "";
  rows.forEach((a) => {
    const li = document.createElement("li");
    const s = document.createElement("span");
    s.textContent = a.name + " (" + a.email + ")";
    li.appendChild(s);
    if (a.ngl) {
      const link = document.createElement("a");
      link.href = a.ngl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Open NGL";
      li.appendChild(link);
    }
    if (admin && a.id !== admin.id) {
      const d = document.createElement("button");
      d.className = "del";
      d.textContent = "Remove";
      d.onclick = async () => {
        if (!confirm("Remove " + a.email + " as admin?")) return;
        try { await api("admin_delete", { id: a.id }); await loadAdmins(); } catch (e) { say(e.message); }
      };
      li.appendChild(d);
    }
    ul.appendChild(li);
  });
}

function renderAdminUI() {
  $("adminPanel").hidden = !admin;
  $("loginBtn").hidden = !!admin;
  if (admin) $("who").textContent = admin.name;
  renderNgl();
  renderPosts();
}

function showSite() {
  $("memberName").textContent = member ? "Welcome, " + member.name : "";
  $("memberLogoutBtn").hidden = !member;
  $("accountGate").hidden = true;
  $("siteContent").hidden = false;
  renderAdminUI();
  if (!siteInitialized) {
    siteInitialized = true;
    Promise.all([loadSettings(), loadPosts()]).then(renderAdminUI);
  }
}

/* ---------- Loaders ---------- */
async function loadPosts() {
  try { posts = await api("posts"); }
  catch (e) { say(e.message); }
  renderPosts();
  if (/^#post-\d+$/.test(location.hash)) {
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "center" });
  }
}

function refreshPostsIfIdle() {
  if (!siteInitialized || document.hidden) return;
  const active = document.activeElement;
  if (active && active.matches("input, textarea, select")) return;
  loadPosts();
}

window.addEventListener("focus", refreshPostsIfIdle);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshPostsIfIdle();
});
window.setInterval(refreshPostsIfIdle, 30000);

async function loadSettings() {
  try {
    const settings = await api("settings");
    nglLinks = settings.admins || (settings.ngl ? [{ name: "Main admin", ngl: settings.ngl }] : []);
  } catch (e) {
    say(e.message);
    return;
  }
  renderNgl();
}
async function loadAdmins() { try { renderAdmins(await api("admins")); } catch (e) {} }

async function logout() {
  try { await api("logout", {}); } catch (e) {}
  admin = null;
  renderAdminUI();
}

/* ---------- Events ---------- */
document.querySelector("#search").addEventListener("input", renderPosts);

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    feedView = button.dataset.view;
    renderPosts();
  });
});

document.querySelectorAll("[data-sort]").forEach((button) => {
  button.addEventListener("click", () => {
    feedSort = button.dataset.sort;
    renderPosts();
  });
});

$("list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const postElement = button.closest("[data-id]");
  if (!postElement) return;
  const postId = String(postElement.dataset.id);
  const post = posts.find((item) => String(item.id) === postId);
  if (!post) return;

  if (button.dataset.action === "comments") {
    const expanded = button.getAttribute("aria-expanded") === "true";
    commentVisibility.set(postId, !expanded);
    renderPosts();
    $("post-" + postId)?.querySelector('[data-action="comments"]')?.focus();
    return;
  }

  if (button.dataset.action === "save") {
    if (savedPosts.has(postId)) savedPosts.delete(postId);
    else savedPosts.add(postId);
    LS.set("nglmb-saved", JSON.stringify([...savedPosts]));
    renderPosts();
    $("post-" + postId)?.querySelector('[data-action="save"]')?.focus();
    return;
  }

  if (button.dataset.action !== "share") return;
  const url = new URL(location.href);
  url.hash = "post-" + postId;
  const shareData = { title: "NGL MB Confessions", text: post.text || "A confession from NGL MB", url: url.href };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
    } else if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(`${shareData.text}\n\n${url.href}`);
      say("Confession link copied to clipboard.");
    } else {
      window.prompt("Copy this confession link:", `${shareData.text}\n\n${url.href}`);
    }
  } catch (error) {
    if (error.name !== "AbortError") say("Sharing is not available right now.");
  }
});

function openAdminLogin() {
  $("err").textContent = "";
  $("loginDlg").showModal();
  $("em").focus();
}
$("loginBtn").onclick = openAdminLogin;
$("accountGateLogin").onclick = openAdminLogin;
$("cancelLogin").onclick = () => $("loginDlg").close();
$("doLogin").onclick = async () => {
  try {
    const r = await api("login", { email: $("em").value, password: $("pw").value });
    admin = r.admin;
    $("pw").value = ""; $("loginDlg").close();
    if (!member) showSite();
    await loadAdmins();
    renderAdminUI();
  } catch (e) { $("err").textContent = e.message; }
};
$("logoutBtn").onclick = () => logout();
$("saveNgl").onclick = async () => {
  try {
    admin.ngl = (await api("ngl_save", { link: $("nglInput").value.trim() })).ngl;
    $("nglNotice").dataset.state = "";
    renderNgl();
    await Promise.all([loadSettings(), loadAdmins()]);
    say("NGL link inserted.");
  } catch (e) { say(e.message); }
};
$("postBtn").onclick = async () => {
  const text = $("newText").value.trim();
  const file = $("newPhoto").files[0];
  if (!text && !file) { say("Write a confession or choose a photo first."); return; }
  try {
    const body = { text, photo: await photoDataUrl(file) };
    const created = await api("post_create", body);
    $("newText").value = "";
    $("newPhoto").value = "";
    say("Confession posted.");
    feedView = "home";
    feedSort = "latest";
    $("search").value = "";
    await loadPosts();
    document.getElementById("post-" + created.id)?.scrollIntoView({ block: "center" });
  } catch (e) { say(e.message); }
};
$("resetAdminPassword").onclick = async () => {
  const currentPassword = $("adminCurrentPassword").value;
  const newPassword = $("adminNewPassword").value;
  const confirmPassword = $("adminConfirmPassword").value;
  const message = $("adminPasswordMessage");
  message.style.color = "";
  if (newPassword !== confirmPassword) {
    message.textContent = "The new passwords do not match.";
    return;
  }
  try {
    await api("admin_password_reset", { currentPassword, newPassword });
    $("adminCurrentPassword").value = $("adminNewPassword").value = $("adminConfirmPassword").value = "";
    message.style.color = "var(--green)";
    message.textContent = "Your password was changed successfully.";
  } catch (e) {
    message.textContent = e.message;
  }
};
$("addAdmin").onclick = async () => {
  try {
    await api("admin_add", { name: $("aName").value, email: $("aEmail").value, password: $("aPass").value });
    $("aName").value = $("aEmail").value = $("aPass").value = "";
    say("Admin added. Share the email and password with them privately.");
    await loadAdmins();
  } catch (e) { say(e.message); }
};

/* ---------- Member account ---------- */
let accountMode = "login";
let passwordResetToken = null;
const resetHash = /^#reset=([a-f0-9]{64})$/i.exec(window.location.hash);
const invalidResetHash = window.location.hash.startsWith("#reset=");
if (resetHash) passwordResetToken = resetHash[1].toLowerCase();
if (invalidResetHash) history.replaceState(null, "", window.location.pathname + window.location.search);

function setAccountMode(mode) {
  accountMode = mode;
  const registering = mode === "register";
  const forgot = mode === "forgot";
  const resetting = mode === "reset";
  const needsEmail = registering || mode === "login" || forgot;
  const needsPassword = registering || mode === "login" || resetting;
  $("accountTitle").textContent = registering ? "Create account" : forgot ? "Reset password" : resetting ? "Choose a new password" : "Welcome";
  $("accountIntro").textContent = registering
    ? "Create a member account to continue."
    : forgot
      ? "Enter your account email and we will send a password reset link."
      : resetting
        ? "Choose a new password for your account."
        : "Log in or create a member account to continue. Admins can sign in separately.";
  $("accountNameLabel").hidden = !registering;
  $("accountName").hidden = !registering;
  $("accountName").required = registering;
  $("accountName").autocomplete = registering ? "name" : "off";
  $("accountEmailLabel").hidden = !needsEmail;
  $("accountEmail").hidden = !needsEmail;
  $("accountEmail").required = needsEmail;
  $("accountPasswordLabel").hidden = !needsPassword;
  $("accountPasswordLabel").textContent = resetting ? "New password" : "Password";
  $("accountPassword").hidden = !needsPassword;
  $("accountPassword").required = needsPassword;
  $("accountPassword").autocomplete = registering || resetting ? "new-password" : "current-password";
  $("accountPassword").placeholder = resetting ? "Enter a new password" : "Enter your password";
  $("accountPasswordConfirmLabel").hidden = !resetting;
  $("accountPasswordConfirm").hidden = !resetting;
  $("accountPasswordConfirm").required = resetting;
  $("accountSubmit").textContent = registering ? "Create account" : forgot ? "Send reset link" : resetting ? "Reset password" : "Log in";
  $("accountSwitchPrompt").textContent = registering ? "Already have an account?" : mode === "login" ? "Don't have an account?" : "Remembered your password?";
  $("accountSwitch").textContent = registering ? "Log in" : "Create an account";
  if (forgot || resetting) $("accountSwitch").textContent = "Back to login";
  $("accountForgotWrap").hidden = mode !== "login";
  $("accountError").classList.remove("success");
  $("accountError").textContent = "";
}

function enterSite(account) {
  member = account;
  showSite();
}

$("accountForgot").onclick = () => {
  $("accountPassword").value = "";
  setAccountMode("forgot");
};
$("accountSwitch").onclick = () => {
  if (accountMode === "login") setAccountMode("register");
  else {
    if (accountMode === "reset") {
      passwordResetToken = null;
      $("accountPassword").value = "";
      $("accountPasswordConfirm").value = "";
    }
    setAccountMode("login");
  }
};
$("accountForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (accountMode === "reset" && $("accountPassword").value !== $("accountPasswordConfirm").value) {
    $("accountError").textContent = "The passwords do not match.";
    return;
  }
  $("accountError").classList.remove("success");
  $("accountError").textContent = "";
  $("accountSubmit").disabled = true;
  try {
    if (accountMode === "forgot") {
      await api("account_forgot_password", { email: $("accountEmail").value.trim() });
      $("accountError").classList.add("success");
      $("accountError").textContent = "If an account uses that email, a password reset link will be sent shortly.";
    } else if (accountMode === "reset") {
      await api("account_reset_password", {
        token: passwordResetToken,
        password: $("accountPassword").value,
      });
      passwordResetToken = null;
      $("accountPassword").value = "";
      $("accountPasswordConfirm").value = "";
      setAccountMode("login");
      $("accountError").classList.add("success");
      $("accountError").textContent = "Your password was reset. Log in with your new password.";
    } else {
      const registering = accountMode === "register";
      const result = await api(registering ? "account_register" : "account_login", {
        name: $("accountName").value.trim(),
        email: $("accountEmail").value.trim(),
        password: $("accountPassword").value,
      });
      if (!result || !result.member) throw new Error("The account service returned an invalid response.");
      $("accountPassword").value = "";
      enterSite(result.member);
    }
  } catch (error) {
    $("accountError").textContent = error.message;
  } finally {
    $("accountSubmit").disabled = false;
  }
});

$("memberLogoutBtn").onclick = async () => {
  try { await api("account_logout", {}); }
  catch (error) { say(error.message); }
  member = null;
  $("siteContent").hidden = true;
  $("accountGate").hidden = false;
  $("memberLogoutBtn").hidden = true;
  $("accountPassword").value = "";
  setAccountMode("login");
};

/* ---------- Start ---------- */
(async () => {
  if (passwordResetToken) {
    setAccountMode("reset");
    return;
  }
  if (invalidResetHash) {
    setAccountMode("login");
    $("accountError").textContent = "This reset link is invalid or incomplete.";
    return;
  }
  let restoreError = null;
  try {
    const result = await api("account_me");
    if (result && result.member) member = result.member;
  } catch (error) {
    if (error.status !== 401) restoreError = error;
  }
  try {
    const result = await api("me");
    if (result && result.admin) admin = result.admin;
  } catch (error) {
    if (error.status !== 401) restoreError = error;
  }
  if (member || admin) {
    showSite();
    if (admin) await loadAdmins();
    renderAdminUI();
  } else if (restoreError) {
    $("accountError").textContent = restoreError.message;
  }
})();
