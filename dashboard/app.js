const config = window.REMOTECTR_CONFIG || {};
const FALLBACK_SYNC_MS = 5 * 60 * 1000;
const REMEMBERED_USERNAME_COOKIE = "remotectr_username";

const elements = {
  authView: document.querySelector("#authView"),
  dashboardView: document.querySelector("#dashboardView"),
  loginForm: document.querySelector("#loginForm"),
  loginButton: document.querySelector("#loginButton"),
  username: document.querySelector("#usernameInput"),
  usernameLabel: document.querySelector("#usernameLabel"),
  password: document.querySelector("#passwordInput"),
  rememberAccount: document.querySelector("#rememberAccountInput"),
  rememberedAccount: document.querySelector("#rememberedAccount"),
  rememberedUsername: document.querySelector("#rememberedUsername"),
  changeAccount: document.querySelector("#changeAccountButton"),
  authNotice: document.querySelector("#authNotice"),
  accountName: document.querySelector("#accountName"),
  logout: document.querySelector("#logoutButton"),
  devicesNav: document.querySelector("#devicesNav"),
  usersNav: document.querySelector("#usersNav"),
  devicesView: document.querySelector("#devicesView"),
  usersView: document.querySelector("#usersView"),
  refresh: document.querySelector("#refreshButton"),
  refreshLabel: document.querySelector("#refreshLabel"),
  grid: document.querySelector("#deviceGrid"),
  template: document.querySelector("#deviceTemplate"),
  empty: document.querySelector("#emptyState"),
  deviceNotice: document.querySelector("#deviceNotice"),
  online: document.querySelector("#onlineCount"),
  away: document.querySelector("#awayCount"),
  offline: document.querySelector("#offlineCount"),
  generatedAt: document.querySelector("#generatedAt"),
  userCount: document.querySelector("#userCount"),
  userList: document.querySelector("#userList"),
  userNotice: document.querySelector("#userNotice"),
  addUser: document.querySelector("#addUserButton"),
  addUserDialog: document.querySelector("#addUserDialog"),
  addUserForm: document.querySelector("#addUserForm"),
  closeDialog: document.querySelector("#closeDialogButton"),
  cancelDialog: document.querySelector("#cancelDialogButton"),
  createUser: document.querySelector("#createUserButton"),
  newUsername: document.querySelector("#newUsernameInput"),
  newDisplayName: document.querySelector("#newDisplayNameInput"),
  newPassword: document.querySelector("#newUserPasswordInput"),
  newUserDevices: document.querySelector("#newUserDevices"),
  dialogNotice: document.querySelector("#dialogNotice"),
};

let client;
let currentSession;
let currentProfile;
let devices = [];
let adminData = { users: [], devices: [] };
let channels = [];
let channelSignature = "";
let loading = false;
let refreshQueued = false;
let activeView = "devices";
let fallbackTimer;
let clockTimer;
let rememberedUsername = readRememberedUsername();

function configured() {
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.supabaseUrl || "")
    && /^(sb_publishable_|eyJ)/.test(config.supabasePublishableKey || "")
    && !config.supabaseUrl.includes("YOUR_PROJECT")
    && !config.supabasePublishableKey.includes("REPLACE_ME");
}

async function initialize() {
  if (!configured()) {
    showNotice(elements.authNotice, "Supabase 연결 설정이 필요합니다.", "error");
    elements.loginForm.hidden = true;
    return;
  }
  if (!window.supabase?.createClient) {
    showNotice(elements.authNotice, "로그인 모듈을 불러오지 못했습니다.", "error");
    return;
  }

  if (location.hash) history.replaceState(null, "", `${location.pathname}${location.search}`);
  client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storage: window.sessionStorage,
    },
    realtime: { params: { eventsPerSecond: 2 } },
  });

  client.auth.onAuthStateChange((event, session) => {
    currentSession = session;
    if (event === "TOKEN_REFRESHED" && session) queueMicrotask(() => client.realtime.setAuth(session.access_token));
    if (event === "SIGNED_OUT") queueMicrotask(showLogin);
  });

  const { data } = await client.auth.getSession();
  if (data.session) await restoreSession(data.session);
  else showLogin();
}

async function restoreSession(session) {
  currentSession = session;
  try {
    const result = await callControl("me", {}, true);
    currentProfile = result.profile;
    await showDashboard();
  } catch {
    await client.auth.signOut({ scope: "local" });
    showLogin();
  }
}

async function signIn(event) {
  event.preventDefault();
  const username = (rememberedUsername || elements.username.value).trim().toLowerCase();
  const password = elements.password.value;
  if (!username || !password) return;

  setButtonLoading(elements.loginButton, true, "확인 중…", "로그인");
  hideNotice(elements.authNotice);
  try {
    const result = await callControl("login", { username, password }, false);
    const { data, error } = await client.auth.setSession({
      access_token: result.session.access_token,
      refresh_token: result.session.refresh_token,
    });
    if (error || !data.session) throw new Error("session_failed");
    currentSession = data.session;
    currentProfile = result.profile;
    if (elements.rememberAccount.checked) writeRememberedUsername(username);
    else writeRememberedUsername("");
    elements.password.value = "";
    await showDashboard();
  } catch {
    elements.password.select();
    showNotice(elements.authNotice, "아이디 또는 비밀번호가 맞지 않습니다.", "error");
  } finally {
    setButtonLoading(elements.loginButton, false, "확인 중…", "로그인");
  }
}

function showLogin() {
  currentSession = null;
  currentProfile = null;
  devices = [];
  adminData = { users: [], devices: [] };
  cleanupRealtime();
  clearInterval(fallbackTimer);
  clearInterval(clockTimer);
  elements.dashboardView.hidden = true;
  elements.authView.hidden = false;
  syncRememberedAccountUI();
  window.setTimeout(() => (rememberedUsername ? elements.password : elements.username).focus(), 0);
}

async function showDashboard() {
  elements.authView.hidden = true;
  elements.dashboardView.hidden = false;
  elements.accountName.textContent = currentProfile.display_name || currentProfile.username;
  elements.usersNav.hidden = !currentProfile.is_admin;
  switchView("devices");
  await loadDevices();
  startTimers();
}

async function logout() {
  elements.logout.disabled = true;
  cleanupRealtime();
  await client.auth.signOut();
  elements.logout.disabled = false;
  showLogin();
}

async function callControl(action, payload = {}, authenticated = true) {
  const headers = {
    "content-type": "application/json",
    "apikey": config.supabasePublishableKey,
  };
  if (authenticated) {
    const { data } = await client.auth.getSession();
    currentSession = data.session;
    if (!currentSession) throw new Error("unauthorized");
    headers.authorization = `Bearer ${currentSession.access_token}`;
  }

  const response = await fetch(`${config.supabaseUrl}/functions/v1/control`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action, ...payload }),
  });
  let result = {};
  try { result = await response.json(); } catch { /* handled by status */ }
  if (!response.ok) {
    const error = new Error(result.error || "request_failed");
    error.code = result.error || "request_failed";
    error.status = response.status;
    throw error;
  }
  return result;
}

function switchView(view) {
  if (view === "users" && !currentProfile?.is_admin) return;
  activeView = view;
  const showingUsers = view === "users";
  elements.devicesView.hidden = showingUsers;
  elements.usersView.hidden = !showingUsers;
  elements.devicesNav.classList.toggle("active", !showingUsers);
  elements.usersNav.classList.toggle("active", showingUsers);
  if (showingUsers) loadUsers();
}

async function refreshActiveView() {
  if (activeView === "users") await loadUsers();
  else await loadDevices();
}

async function loadDevices() {
  if (!client || !currentSession || loading || document.hidden) return;
  loading = true;
  elements.grid.setAttribute("aria-busy", "true");
  elements.refresh.classList.add("loading");
  elements.refreshLabel.textContent = "동기화 중";
  hideNotice(elements.deviceNotice);

  const { data, error } = await client
    .from("devices")
    .select("id,device_key,device_name,os,arch,agent_version,idle_seconds,away,activity,activity_kind,window_title,uptime_seconds,agent_sent_at,last_seen")
    .order("device_name", { ascending: true });

  loading = false;
  elements.grid.setAttribute("aria-busy", "false");
  elements.refresh.classList.remove("loading");
  if (error) {
    showNotice(elements.deviceNotice, "기기 정보를 불러오지 못했습니다.", "error");
    elements.refreshLabel.textContent = "연결 오류";
    return;
  }

  devices = data || [];
  renderDevices();
  elements.generatedAt.textContent = `${formatClock(new Date())} 동기화`;
  await setupRealtime(devices);
  if (refreshQueued) {
    refreshQueued = false;
    queueMicrotask(loadDevices);
  }
}

async function setupRealtime(visibleDevices) {
  if (!currentSession || document.hidden) return;
  const nextSignature = visibleDevices.map((device) => device.id).sort().join(",");
  if (channels.length && nextSignature === channelSignature) {
    elements.refreshLabel.textContent = "실시간 연결";
    return;
  }
  cleanupRealtime();
  channelSignature = nextSignature;
  await client.realtime.setAuth(currentSession.access_token);
  channels = visibleDevices.map((device) => client
    .channel(`device:${device.id}`, { config: { private: true } })
    .on("broadcast", { event: "*" }, scheduleRealtimeRefresh)
    .subscribe((status) => {
      if (status === "SUBSCRIBED") elements.refreshLabel.textContent = "실시간 연결";
    }));
  if (!channels.length) elements.refreshLabel.textContent = "연결됨";
}

function scheduleRealtimeRefresh() {
  if (loading) {
    refreshQueued = true;
    return;
  }
  window.setTimeout(loadDevices, 150);
}

function cleanupRealtime() {
  if (client) channels.forEach((channel) => client.removeChannel(channel));
  channels = [];
  channelSignature = "";
}

function startTimers() {
  clearInterval(fallbackTimer);
  clearInterval(clockTimer);
  fallbackTimer = window.setInterval(loadDevices, FALLBACK_SYNC_MS);
  clockTimer = window.setInterval(renderDevices, 5000);
}

function renderDevices() {
  const counts = { online: 0, away: 0, offline: 0 };
  const now = Date.now();
  const offlineAfter = Number(config.offlineAfterSeconds) || 150;
  const cardsByID = new Map(
    [...elements.grid.children].map((card) => [card.dataset.deviceId, card]),
  );
  const visibleIDs = new Set();

  devices.forEach((device, index) => {
    visibleIDs.add(device.id);
    const seenAt = Date.parse(device.last_seen || "");
    const ageSeconds = Number.isFinite(seenAt) ? Math.max(0, Math.floor((now - seenAt) / 1000)) : Number.POSITIVE_INFINITY;
    const status = ageSeconds > offlineAfter ? "offline" : (device.away ? "away" : "online");
    counts[status] += 1;
    let card = cardsByID.get(device.id);
    if (!card) {
      card = elements.template.content.firstElementChild.cloneNode(true);
      card.dataset.deviceId = device.id;
    }
    if (card.dataset.status !== status) card.dataset.status = status;
    setText(card, ".device-name", device.device_name || device.device_key);
    setText(card, ".device-meta", `${osLabel(device.os)} · ${device.arch || "알 수 없음"}`);
    setText(card, ".status-pill span", statusLabel(status));
    setText(card, ".os-mark", osMark(device.os));
    const isOffline = status === "offline";
    setText(card, ".activity-name", isOffline ? "—" : (device.activity || device.activity_kind || "확인 불가"));
    setText(card, ".window-title", !isOffline && device.window_title ? device.window_title : "");
    setText(card, ".idle-time", isOffline ? "—" : formatDuration(device.idle_seconds, "방금"));
    setText(card, ".uptime", formatDuration(device.uptime_seconds, "0초"));
    setText(card, ".last-seen", formatAgo(ageSeconds));
    const cardAtIndex = elements.grid.children[index];
    if (cardAtIndex !== card) elements.grid.insertBefore(card, cardAtIndex || null);
  });

  for (const card of [...elements.grid.children]) {
    if (!visibleIDs.has(card.dataset.deviceId)) card.remove();
  }

  setElementText(elements.online, counts.online);
  setElementText(elements.away, counts.away);
  setElementText(elements.offline, counts.offline);
  const isEmpty = devices.length === 0;
  if (elements.empty.hidden === isEmpty) elements.empty.hidden = !isEmpty;
  if (elements.grid.hidden !== isEmpty) elements.grid.hidden = isEmpty;
}

async function loadUsers() {
  if (!currentProfile?.is_admin) return;
  elements.refresh.classList.add("loading");
  hideNotice(elements.userNotice);
  try {
    adminData = await callControl("list");
    renderUsers();
  } catch (error) {
    showNotice(elements.userNotice, error.status === 401 ? "다시 로그인해 주세요." : "사용자 정보를 불러오지 못했습니다.", "error");
  } finally {
    elements.refresh.classList.remove("loading");
  }
}

function renderUsers() {
  elements.userList.replaceChildren();
  elements.userCount.textContent = `${adminData.users.length}명`;
  for (const user of adminData.users) {
    const card = document.createElement("article");
    card.className = "user-card";
    card.dataset.userId = user.user_id;

    const identity = document.createElement("div");
    identity.className = "user-identity";
    const name = document.createElement("strong");
    name.textContent = user.display_name;
    const username = document.createElement("span");
    username.textContent = user.username;
    identity.append(name, username);
    if (user.is_admin) {
      const badge = document.createElement("span");
      badge.className = "admin-badge";
      badge.textContent = "관리자";
      identity.append(badge);
    }

    const assignments = document.createElement("div");
    const title = document.createElement("span");
    title.className = "assignment-title";
    title.textContent = user.is_admin ? "모든 PC 접근 가능" : "볼 수 있는 PC";
    assignments.append(title);
    if (!user.is_admin) {
      const list = document.createElement("div");
      list.className = "checkbox-list";
      for (const device of adminData.devices) list.append(createDeviceCheckbox(device, user.device_ids.includes(device.id)));
      if (!adminData.devices.length) list.textContent = "등록된 PC 없음";
      assignments.append(list);
    }

    const actions = document.createElement("div");
    actions.className = "user-actions";
    if (!user.is_admin) {
      const save = document.createElement("button");
      save.className = "plain-button";
      save.type = "button";
      save.textContent = "저장";
      save.addEventListener("click", () => saveAssignments(card, user, save));
      const remove = document.createElement("button");
      remove.className = "plain-button danger-button";
      remove.type = "button";
      remove.textContent = "삭제";
      remove.addEventListener("click", () => removeUser(user, remove));
      actions.append(save, remove);
    }
    card.append(identity, assignments, actions);
    elements.userList.append(card);
  }
}

function createDeviceCheckbox(device, checked = false) {
  const label = document.createElement("label");
  label.className = "device-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.value = device.id;
  input.checked = checked;
  const text = document.createElement("span");
  text.textContent = device.device_name || device.device_key;
  label.append(input, text);
  return label;
}

async function saveAssignments(card, user, button) {
  const deviceIDs = [...card.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  setButtonLoading(button, true, "저장 중…", "저장");
  hideNotice(elements.userNotice);
  try {
    await callControl("set_assignments", { user_id: user.user_id, device_ids: deviceIDs });
    showNotice(elements.userNotice, `${user.display_name}의 권한을 저장했습니다.`, "success");
    await loadUsers();
  } catch {
    showNotice(elements.userNotice, "권한을 저장하지 못했습니다.", "error");
  } finally {
    setButtonLoading(button, false, "저장 중…", "저장");
  }
}

async function removeUser(user, button) {
  if (!window.confirm(`${user.display_name} (${user.username}) 사용자를 삭제할까요?`)) return;
  setButtonLoading(button, true, "삭제 중…", "삭제");
  hideNotice(elements.userNotice);
  try {
    await callControl("delete_user", { user_id: user.user_id });
    showNotice(elements.userNotice, "사용자를 삭제했습니다.", "success");
    await loadUsers();
  } catch {
    showNotice(elements.userNotice, "사용자를 삭제하지 못했습니다.", "error");
  } finally {
    setButtonLoading(button, false, "삭제 중…", "삭제");
  }
}

function openAddUserDialog() {
  elements.addUserForm.reset();
  elements.newUserDevices.replaceChildren();
  hideNotice(elements.dialogNotice);
  for (const device of adminData.devices) elements.newUserDevices.append(createDeviceCheckbox(device));
  if (!adminData.devices.length) elements.newUserDevices.textContent = "등록된 PC 없음";
  elements.addUserDialog.showModal();
  elements.newUsername.focus();
}

async function createUser(event) {
  event.preventDefault();
  const username = elements.newUsername.value.trim().toLowerCase();
  const displayName = elements.newDisplayName.value.trim();
  const password = elements.newPassword.value;
  const deviceIDs = [...elements.newUserDevices.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  setButtonLoading(elements.createUser, true, "추가 중…", "추가");
  hideNotice(elements.dialogNotice);
  try {
    await callControl("create_user", { username, display_name: displayName, password, device_ids: deviceIDs });
    elements.addUserDialog.close();
    showNotice(elements.userNotice, `${displayName} 사용자를 추가했습니다.`, "success");
    await loadUsers();
  } catch (error) {
    const message = error.code === "username_exists" ? "이미 사용 중인 아이디입니다." : "사용자를 추가하지 못했습니다. 입력값을 확인하세요.";
    showNotice(elements.dialogNotice, message, "error");
  } finally {
    setButtonLoading(elements.createUser, false, "추가 중…", "추가");
  }
}

function readRememberedUsername() {
  const prefix = `${REMEMBERED_USERNAME_COOKIE}=`;
  const value = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!value) return "";
  try { return decodeURIComponent(value.slice(prefix.length)).trim().toLowerCase(); } catch { return ""; }
}

function writeRememberedUsername(username) {
  rememberedUsername = username.trim().toLowerCase();
  const secure = location.protocol === "https:" ? "; Secure" : "";
  if (rememberedUsername) {
    document.cookie = `${REMEMBERED_USERNAME_COOKIE}=${encodeURIComponent(rememberedUsername)}; Max-Age=31536000; Path=/; SameSite=Strict${secure}`;
  } else {
    document.cookie = `${REMEMBERED_USERNAME_COOKIE}=; Max-Age=0; Path=/; SameSite=Strict${secure}`;
  }
}

function syncRememberedAccountUI() {
  rememberedUsername = readRememberedUsername();
  elements.rememberedAccount.hidden = !rememberedUsername;
  elements.usernameLabel.hidden = Boolean(rememberedUsername);
  elements.rememberedUsername.textContent = rememberedUsername;
  elements.username.required = !rememberedUsername;
  if (rememberedUsername) elements.username.value = "";
  elements.rememberAccount.checked = true;
}

function changeRememberedAccount() {
  rememberedUsername = "";
  elements.rememberedAccount.hidden = true;
  elements.usernameLabel.hidden = false;
  elements.username.required = true;
  elements.username.focus();
}

function setText(root, selector, value) { setElementText(root.querySelector(selector), value); }
function setElementText(element, value) {
  const nextValue = String(value ?? "");
  if (element.textContent !== nextValue) element.textContent = nextValue;
}
function hideNotice(element) { element.hidden = true; }
function showNotice(element, message, type) {
  element.textContent = message;
  element.dataset.type = type;
  element.hidden = false;
}
function setButtonLoading(button, loadingState, loadingText, idleText) {
  button.disabled = loadingState;
  button.textContent = loadingState ? loadingText : idleText;
}

function formatDuration(value, zeroLabel) {
  let seconds = Math.max(0, Number(value) || 0);
  if (seconds < 5) return zeroLabel;
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  if (days) return `${days}일 ${hours}시간`;
  if (hours) return `${hours}시간 ${minutes}분`;
  if (minutes) return `${minutes}분`;
  return `${Math.floor(seconds)}초`;
}

function formatAgo(seconds) {
  if (!Number.isFinite(seconds)) return "기록 없음";
  if (seconds < 8) return "방금";
  if (seconds < 60) return `${seconds}초 전`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return `${Math.floor(seconds / 86400)}일 전`;
}

function formatClock(date) {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

function statusLabel(status) { return ({ online: "온라인", away: "자리 비움", offline: "오프라인" })[status]; }
function osLabel(os) { return ({ windows: "Windows", darwin: "macOS", linux: "Linux" })[os] || "Unknown"; }
function osMark(os) { return ({ windows: "WIN", darwin: "MAC", linux: "LNX" })[os] || "PC"; }

elements.loginForm.addEventListener("submit", signIn);
elements.changeAccount.addEventListener("click", changeRememberedAccount);
elements.logout.addEventListener("click", logout);
elements.devicesNav.addEventListener("click", () => switchView("devices"));
elements.usersNav.addEventListener("click", () => switchView("users"));
elements.refresh.addEventListener("click", refreshActiveView);
elements.addUser.addEventListener("click", openAddUserDialog);
elements.closeDialog.addEventListener("click", () => elements.addUserDialog.close());
elements.cancelDialog.addEventListener("click", () => elements.addUserDialog.close());
elements.addUserForm.addEventListener("submit", createUser);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) cleanupRealtime();
  else if (currentSession) loadDevices();
});

initialize();
