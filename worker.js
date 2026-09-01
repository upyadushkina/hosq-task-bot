/**
 * hosq TASK BOT — Cloudflare Worker (single-file, dashboard-friendly)
 *
 * Storage: Cloudflare D1 (SQLite)
 * Tasks: Notion (via integration token)
 * UI: Telegram webhook
 *
 * IMPORTANT: Do not hardcode real tokens in this file.
 * Set them in Cloudflare Worker settings (Variables).
 */

const MessageTags = {
  systemMessageMissing: "system_message_missing",
  onboardingIntro: "onboarding_intro",
  onboardingAskName: "onboarding_ask_name",
  onboardingAskEmail: "onboarding_ask_email",
  onboardingAskLocation: "onboarding_ask_location",
  onboardingComplete: "onboarding_complete",
  menuMain: "menu_main",
  menuTasks: "menu_tasks",
  menuProfile: "menu_profile",
  menuProjects: "menu_projects",
  menuShop: "menu_shop",
  menuOnFire: "menu_on_fire",
  menuTeam: "menu_team",
  menuBack: "menu_back",
  profileCard: "profile_card",
  projectsListHeader: "projects_list_header",
  projectsEmpty: "projects_empty",
  shopListHeader: "shop_list_header",
  shopInsufficientSparks: "shop_insufficient_sparks",
  shopPurchaseSuccess: "shop_purchase_success",
  shopSellSuccess: "shop_sell_success",

  helperCard: "helper_card",
  helperActionBuy: "helper_action_buy",
  helperActionBack: "helper_action_back",

  profileSettingsOpen: "profile_settings_open",
  profileSettingsMenu: "profile_settings_menu",
  profileSettingsChangeName: "profile_settings_change_name",
  profileSettingsChangeLocation: "profile_settings_change_location",
  profileSettingsChangeReminderTime: "profile_settings_change_reminder_time",
  profileSetTask: "profile_set_task",
  profileSettingsBack: "profile_settings_back",

  settingsAskName: "settings_ask_name",
  settingsAskLocation: "settings_ask_location",
  settingsAskReminderTime: "settings_ask_reminder_time",
  settingsSaved: "settings_saved",

  setTaskAskTitle: "settask_ask_title",
  setTaskAskDeadline: "settask_ask_deadline",
  setTaskAskPriority: "settask_ask_priority",
  setTaskAskProject: "settask_ask_project",
  setTaskNoProject: "settask_no_project",
  setTaskCreated: "settask_created",

  onFireHeader: "onfire_header",
  onFireEmpty: "onfire_empty",
  teamHeader: "team_header",
  teamEmpty: "team_empty",

  teamMemberViewTasks: "team_member_view_tasks",
  teamMemberViewProjects: "team_member_view_projects",
  teamMemberBack: "team_member_back",

  tasksListHeader: "tasks_list_header",
  tasksEmpty: "tasks_empty",
  taskCardTemplate: "task_card_template",
  taskActionComplete: "task_action_complete",
  taskActionReschedule: "task_action_reschedule",
  taskAskRescheduleDate: "task_ask_reschedule_date",
  taskRescheduleOk: "task_reschedule_ok",
  taskNotFound: "task_not_found",
};

function normalizeKey(s) {
  return String(s || "").trim().toLowerCase();
}

function normalizeTemplateVarKey(raw) {
  // Supports DB templates like "{completed tasks}" by mapping to snake_case keys used in `vars`.
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  return s.replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function formatTemplate(template, vars) {
  return String(template || "").replace(/\{([^}]+)\}/g, (_, rawKey) => {
    const k = normalizeTemplateVarKey(rawKey);
    const v = vars && k && Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : "";
    return v === undefined || v === null ? "" : String(v);
  });
}

async function dbGet(db, sql, params = []) {
  return await db.prepare(sql).bind(...params).first();
}

async function dbAll(db, sql, params = []) {
  const res = await db.prepare(sql).bind(...params).all();
  return res.results || [];
}

async function getMessage(db, tag) {
  const row = await dbGet(
    db,
    "SELECT message_text FROM messages WHERE lower(message_tag)=? LIMIT 1",
    [normalizeKey(tag)],
  );
  return row ? row.message_text : null;
}

async function formatMessage(db, tag, vars = {}) {
  const t = await getMessage(db, tag);
  if (t) return formatTemplate(t, vars);
  const fallback = await getMessage(db, MessageTags.systemMessageMissing);
  if (fallback) return formatTemplate(fallback, { ...vars, tag });
  return `[missing message: ${tag}]`;
}

async function getParameter(db, key) {
  const row = await dbGet(
    db,
    "SELECT parameter_value FROM parameters WHERE lower(parameter_key)=? LIMIT 1",
    [normalizeKey(key)],
  );
  return row ? row.parameter_value : null;
}

function parseTimeHHmm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) return null;
  return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

function ymdFromDateInTimeZone(d, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map((x) => Number(x));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function parseLooseDeadlineToYmd(deadlineText, todayYmd) {
  const s = String(deadlineText || "").trim();
  if (!s) return null;

  // 1) Already ISO-like: YYYY-MM-DD...
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1];

  // 2) Format: "Jan 13" (no year)
  const m = /^([A-Za-z]{3,})\s+(\d{1,2})$/.exec(s);
  if (m) {
    const monRaw = m[1].slice(0, 3).toLowerCase();
    const day = Number(m[2]);
    const monthMap = {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12,
    };
    const month = monthMap[monRaw];
    if (!month || !(day >= 1 && day <= 31)) return null;
    const y = Number(String(todayYmd || "").slice(0, 4));
    if (!Number.isFinite(y)) return null;
    const cand = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    // If it's already passed this year, treat as next year.
    return todayYmd && cand < todayYmd
      ? `${y + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
      : cand;
  }

  return null;
}

function deadlineYmdFromPage(page) {
  const props = page && page.properties ? page.properties : {};
  const s = deadlineFromProps(props);
  if (!s) return null;
  const today = ymdFromDateInTimeZone(new Date(), "UTC");
  return parseLooseDeadlineToYmd(s, today);
}

function b64EncodeUtf8(s) {
  return btoa(unescape(encodeURIComponent(String(s || ""))));
}

function b64DecodeUtf8(s) {
  return decodeURIComponent(escape(atob(String(s || ""))));
}

function randomToken(len = 10) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function allocateShopViewToken(db, helperName) {
  // Telegram callback_data is capped at 64 bytes; helper names may be long/non-ASCII.
  // Store a short token -> helper name mapping in D1 parameters (MVP KV).
  for (let i = 0; i < 5; i++) {
    const token = randomToken(12);
    const key = `shop_view_${token}`;
    try {
      await db
        .prepare("INSERT INTO parameters(parameter_key, parameter_value, parameter_description) VALUES(?,?,?)")
        .bind(key, String(helperName || ""), "ephemeral_shop_view_token")
        .run();
      return token;
    } catch {
      // rare collision; retry
    }
  }
  throw new Error("Could not allocate shop view token");
}

async function resolveShopViewRef(db, ref) {
  const r = String(ref || "").trim();
  if (!r) return null;
  if (/^[a-z0-9]{10,16}$/.test(r)) {
    const row = await dbGet(db, "SELECT parameter_value FROM parameters WHERE parameter_key=? LIMIT 1", [
      `shop_view_${r}`,
    ]);
    return row ? row.parameter_value : null;
  }
  // Back-compat: base64-encoded UTF-8 helper name
  try {
    return b64DecodeUtf8(r);
  } catch {
    return null;
  }
}

async function sendTelegramPhotoOrText(env, { chat_id, imageUrl, caption, reply_markup }) {
  const u = String(imageUrl || "").trim();
  if (u) {
    await telegramApi(env, "sendPhoto", {
      chat_id,
      photo: u,
      caption: String(caption || ""),
      parse_mode: undefined,
      reply_markup,
    });
    return;
  }
  await telegramApi(env, "sendMessage", { chat_id, text: String(caption || ""), reply_markup });
}

async function collectActiveNotionTasksForProfile(env, profile, maxScan) {
  const pageSize = 50;
  const maxPages = Math.max(1, Math.ceil(maxScan / pageSize));
  const attempts = [
    { page_size: pageSize, sorts: [{ property: "Deadline", direction: "ascending" }] },
    { page_size: pageSize },
  ];

  let lastErr = null;
  for (const baseBody of attempts) {
    try {
      const picked = [];
      const seen = new Set();
      let cursor = undefined;

      for (let i = 0; i < maxPages; i++) {
        const body = { ...baseBody, page_size: pageSize };
        if (cursor) body.start_cursor = cursor;

        const json = await notionQueryDatabase(env, body);
        const results = json.results || [];

        for (const p of results) {
          if (!p || !p.id || seen.has(p.id)) continue;
          seen.add(p.id);
          if (!isResponsibleForTask(p, profile, env)) continue;
          if (!isActiveStatus(statusOrSelectName((p.properties && p.properties.Status) || {}))) continue;
          picked.push(p);
          if (picked.length >= maxScan) return picked;
        }

        if (!json.has_more || !json.next_cursor) break;
        cursor = json.next_cursor;
      }

      return picked;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Notion query failed");
}

async function countActiveNotionTasks(env, profile) {
  const tasks = await collectActiveNotionTasksForProfile(env, profile, 400);
  return tasks.length;
}

async function countOverdueActiveNotionTasks(env, profile, todayYmd) {
  const tasks = await collectActiveNotionTasksForProfile(env, profile, 400);
  let n = 0;
  for (const t of tasks) {
    const d = deadlineYmdFromPage(t);
    if (!d) continue;
    if (d < todayYmd) n++;
  }
  return n;
}

async function computeProfileStatusText(db, env, profile) {
  const tz = profile.timezone || (await getParameter(db, "default_timezone")) || "UTC";
  const today = ymdFromDateInTimeZone(new Date(), tz);

  const xRaw = await getParameter(db, "overload_threshold_x");
  const yRaw = await getParameter(db, "onfire_overdue_threshold_y");
  const zRaw = await getParameter(db, "chill_threshold_z");

  const x = Number(xRaw !== null && xRaw !== undefined && String(xRaw).trim() !== "" ? xRaw : 8);
  const y = Number(yRaw !== null && yRaw !== undefined && String(yRaw).trim() !== "" ? yRaw : 0);
  const z = Number(zRaw !== null && zRaw !== undefined && String(zRaw).trim() !== "" ? zRaw : 3);

  const active = await countActiveNotionTasks(env, profile);
  const overdue = await countOverdueActiveNotionTasks(env, profile, today);

  if (Number.isFinite(y) && overdue > y) return "on fire 🔥";
  if (Number.isFinite(x) && active > x) return "overwhelmed";
  if (Number.isFinite(z) && active < z) return "chill";
  return "healthy";
}

async function buildProfileCardVars(db, env, profile) {
  const status = await computeProfileStatusText(db, env, profile);
  const tg = profile.telegram_username ? `@${String(profile.telegram_username).replace(/^@/, "")}` : "";
  return {
    profile_image_link: String(profile.profile_image_link || ""),
    name: profile.user_name,
    email: profile.user_email,
    telegram_username: tg,
    sparks: profile.sparks || 0,
    streak: profile.streak || 0,
    completed_tasks: profile.completed_tasks || 0,
    status,
  };
}

async function sendProfileCard(env, db, chatId, profile, reply_markup) {
  const vars = await buildProfileCardVars(db, env, profile);
  const caption = await formatMessage(db, MessageTags.profileCard, vars);
  await sendTelegramPhotoOrText(env, {
    chat_id: chatId,
    imageUrl: vars.profile_image_link,
    caption,
    reply_markup,
  });
}

async function getProfileByTelegramUserId(db, telegramUserId) {
  return await dbGet(db, "SELECT * FROM profiles WHERE telegram_user_id=? LIMIT 1", [
    String(telegramUserId),
  ]);
}

async function getProfileByEmail(db, email) {
  return await dbGet(db, "SELECT * FROM profiles WHERE lower(user_email)=? LIMIT 1", [
    normalizeKey(email),
  ]);
}

async function upsertProfile(db, patch) {
  // patch must include user_email and user_name for create
  const now = new Date().toISOString();
  const existing = patch.telegram_user_id
    ? await getProfileByTelegramUserId(db, patch.telegram_user_id)
    : await getProfileByEmail(db, patch.user_email);

  if (existing) {
    const merged = { ...existing, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    await db
      .prepare(
        `UPDATE profiles SET
          user_name=?,
          telegram_username=?,
          profile_image_link=?,
          notion_user_id=?,
          telegram_user_id=?,
          timezone=?,
          reminder_time=?,
          sparks=?,
          streak=?,
          completed_tasks=?,
          last_activity_date=?
        WHERE user_email=?`,
      )
      .bind(
        merged.user_name,
        merged.telegram_username || null,
        merged.profile_image_link || null,
        merged.notion_user_id || null,
        merged.telegram_user_id || null,
        merged.timezone || null,
        merged.reminder_time || null,
        Number.isFinite(Number(merged.sparks)) ? Number(merged.sparks) : 0,
        Number.isFinite(Number(merged.streak)) ? Number(merged.streak) : 0,
        Number.isFinite(Number(merged.completed_tasks)) ? Number(merged.completed_tasks) : 0,
        merged.last_activity_date || null,
        existing.user_email,
      )
      .run();
    return await getProfileByEmail(db, existing.user_email);
  }

  if (!patch.user_email || !patch.user_name) {
    throw new Error("user_email and user_name are required");
  }

  await db
    .prepare(
      `INSERT INTO profiles (
        user_email, user_name, telegram_username, profile_image_link, notion_user_id,
        telegram_user_id, timezone, reminder_time, sparks, streak, completed_tasks, last_activity_date, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      patch.user_email,
      patch.user_name,
      patch.telegram_username || null,
      patch.profile_image_link || null,
      patch.notion_user_id || null,
      patch.telegram_user_id || null,
      patch.timezone || null,
      patch.reminder_time || null,
      0,
      0,
      0,
      patch.last_activity_date || null,
      now,
    )
    .run();

  return await getProfileByEmail(db, patch.user_email);
}

function requireTelegramToken(env) {
  const t = env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("Missing TELEGRAM_BOT_TOKEN (Worker variable/secret)");
  return t;
}

async function telegramApi(env, method, payload) {
  requireTelegramToken(env);
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  let json;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Telegram API ${method} returned non-JSON (${res.status}): ${raw}`);
  }
  if (!res.ok) {
    throw new Error(`Telegram API ${method} failed ${res.status}: ${raw}`);
  }
  if (!json.ok) {
    throw new Error(`Telegram API ${method} returned ok=false: ${raw}`);
  }
  return json;
}

function isStartCommand(text) {
  // Telegram may send: /start, /start@BotName, /start payload
  return /^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(String(text || ""));
}

function getCommandLikeText(message) {
  // Most cases: message.text
  if (message.text) return String(message.text);
  // Rare cases: caption on media messages
  if (message.caption) return String(message.caption);
  return "";
}

async function mainMenuKeyboard(db) {
  const tTasks = await formatMessage(db, MessageTags.menuTasks, {});
  const tProfile = await formatMessage(db, MessageTags.menuProfile, {});
  const tProjects = await formatMessage(db, MessageTags.menuProjects, {});
  const tShop = await formatMessage(db, MessageTags.menuShop, {});
  const tOnFire = await formatMessage(db, MessageTags.menuOnFire, {});
  const tTeam = await formatMessage(db, MessageTags.menuTeam, {});
  return {
    inline_keyboard: [
      [{ text: tTasks, callback_data: "menu:tasks" }],
      [
        { text: tOnFire, callback_data: "menu:onfire" },
        { text: tTeam, callback_data: "menu:team" },
      ],
      [{ text: tProfile, callback_data: "menu:profile" }],
      [{ text: tProjects, callback_data: "menu:projects" }],
      [{ text: tShop, callback_data: "menu:shop" }],
    ],
  };
}

function requireEnv(env, key) {
  const v = env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}

async function notionFetch(env, path, init = {}) {
  const token = requireEnv(env, "NOTION_TOKEN");
  const url = `https://api.notion.com/v1${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Notion ${path} failed ${res.status}: ${await res.text()}`);
  }
  return await res.json();
}

function firstTextFromTitle(prop) {
  const arr = prop && prop.title ? prop.title : [];
  return arr.map((t) => t.plain_text || "").join("").trim();
}

function firstTextFromRichText(prop) {
  const arr = prop && prop.rich_text ? prop.rich_text : [];
  return arr.map((t) => t.plain_text || "").join("").trim();
}

function selectName(prop) {
  return prop && prop.select ? prop.select.name || "" : "";
}

function emailValue(prop) {
  return prop && typeof prop.email === "string" ? prop.email : "";
}

function statusOrSelectName(prop) {
  if (!prop) return "";
  if (prop.type === "status" && prop.status) return prop.status.name || "";
  if (prop.type === "select" && prop.select) return prop.select.name || "";
  // Some responses still include nested objects even if type field is missing
  if (prop.status && prop.status.name) return prop.status.name || "";
  if (prop.select && prop.select.name) return prop.select.name || "";
  return "";
}

function multiSelectNames(prop) {
  const arr = prop && prop.multi_select ? prop.multi_select : [];
  return arr.map((x) => x.name).filter(Boolean);
}

function dateStart(prop) {
  return prop && prop.date ? prop.date.start || "" : "";
}

function peopleEmails(prop) {
  const arr = prop && prop.people ? prop.people : [];
  return arr
    .map((p) => (p.person && p.person.email ? p.person.email : null))
    .filter(Boolean);
}

function peopleIds(prop) {
  const arr = prop && prop.people ? prop.people : [];
  return arr.map((p) => (p && p.id ? String(p.id) : null)).filter(Boolean);
}

// Hosq Tasks DB schema (override via env if your workspace uses different names).
const NotionTaskProps = {
  taskName: "Task name",
  status: "Status",
  responsible: "Responsible",
  consult: "Consult",
  deadline: "Deadline",
  priority: "Priority",
  taskType: "Task Type",
  connectedProjects: "Connected Projects",
};

function notionPropName(env, key, fallback) {
  const envKey = `NOTION_PROP_${String(key).toUpperCase()}`;
  return env[envKey] ? String(env[envKey]) : fallback;
}

function getConfiguredResponsiblePropName(env) {
  return notionPropName(env, "responsible", NotionTaskProps.responsible);
}

function getConfiguredConsultPropName(env) {
  return notionPropName(env, "consult", NotionTaskProps.consult);
}

function getConfiguredTaskTypePropName(env) {
  return notionPropName(env, "task_type", NotionTaskProps.taskType);
}

function getConfiguredStatusPropName(env) {
  return notionPropName(env, "status", NotionTaskProps.status);
}

function getConfiguredDeadlinePropName(env) {
  return notionPropName(env, "deadline", NotionTaskProps.deadline);
}

function getConfiguredAssigneeEmailPropName(env) {
  // Optional override if your Notion field isn't named "Assignee email"
  return env.NOTION_ASSIGNEE_EMAIL_PROPERTY ? String(env.NOTION_ASSIGNEE_EMAIL_PROPERTY) : "Assignee email";
}

function pickAssigneeEmailPropertyFromPage(page, env) {
  const props = page && page.properties ? page.properties : {};
  const configured = getConfiguredAssigneeEmailPropName(env);
  if (configured && props[configured]) return props[configured];

  const candidates = ["Resposible Email", "Responsible Email", "Assignee email", "Assignee Email", "Assignee email"];
  for (const k of candidates) {
    if (props[k]) return props[k];
  }

  return null;
}

function firstTextFromRichTextOrTitle(prop) {
  if (!prop) return "";
  if (prop.type === "rich_text") return firstTextFromRichText(prop);
  if (prop.type === "title") return firstTextFromTitle(prop);
  // Some responses omit `type`
  if (Array.isArray(prop.rich_text)) return prop.rich_text.map((t) => t.plain_text || "").join("").trim();
  if (Array.isArray(prop.title)) return prop.title.map((t) => t.plain_text || "").join("").trim();
  return "";
}

function textValue(prop) {
  // Notion "text" properties are usually `rich_text` under the hood.
  return firstTextFromRichTextOrTitle(prop);
}

function parseEmailsLoose(s) {
  const raw = String(s || "").trim().toLowerCase();
  if (!raw) return [];
  // Split on commas/semicolons/whitespace/newlines.
  const parts = raw.split(/[,\s;]+/g).map((x) => x.trim()).filter(Boolean);
  // Keep only plausible emails to avoid accidental matches.
  return parts.filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
}

function assigneeEmailsFromTextField(page, env) {
  const prop = pickAssigneeEmailPropertyFromPage(page, env);
  if (!prop) return [];
  if (prop.type === "email" || typeof prop.email === "string") {
    return parseEmailsLoose(emailValue(prop));
  }
  const text = firstTextFromRichTextOrTitle(prop);
  return parseEmailsLoose(text);
}

function pickPeoplePropertyFromPage(page, env) {
  const props = page && page.properties ? page.properties : {};
  const configured = getConfiguredResponsiblePropName(env);
  if (configured && props[configured]) {
    const t = props[configured].type;
    if (t === "people" || Array.isArray(props[configured].people)) return props[configured];
  }

  const candidates = ["Responsible", "Resposible", "Assignee", "Owner", "Person", "People"];
  for (const k of candidates) {
    if (props[k] && props[k].type === "people") return props[k];
  }

  // Last resort: first "people" property on the page
  for (const k of Object.keys(props)) {
    if (props[k] && props[k].type === "people") return props[k];
  }
  return null;
}

function peopleFirst(prop) {
  const arr = prop && prop.people ? prop.people : [];
  return arr[0] || null;
}

function numberValue(prop) {
  return prop && typeof prop.number === "number" ? prop.number : null;
}

function isActiveStatus(status) {
  const s = normalizeKey(status);
  if (!s) return true;
  if (s === normalizeKey("Done")) return false;
  if (s === normalizeKey("Canceled")) return false;
  if (s === normalizeKey("Cancelled")) return false;
  return true;
}

function isResponsibleForTask(page, profile, env) {
  const wantEmail = normalizeKey(profile.user_email);

  // 1) People-type property (preferred)
  const resp = pickPeoplePropertyFromPage(page, env);
  if (resp) {
    const emails = peopleEmails(resp).map(normalizeKey);
    const ids = peopleIds(resp).map(String);
    if (profile.notion_user_id && ids.includes(String(profile.notion_user_id))) return true;
    if (emails.includes(wantEmail)) return true;
  }

  // 2) Text field "Assignee email" (rich_text/title) containing email(s)
  const emailsText = assigneeEmailsFromTextField(page, env).map(normalizeKey);
  if (emailsText.includes(wantEmail)) return true;

  return false;
}

function firstTitleFromAnyProperty(props) {
  for (const k of Object.keys(props || {})) {
    const p = props[k];
    if (p && (p.type === "title" || Array.isArray(p.title))) return firstTextFromTitle(p);
  }
  return "";
}

function taskTitleFromPage(page) {
  const props = (page && page.properties) || {};
  const p =
    props[NotionTaskProps.taskName] ||
    props["Task name"] ||
    props["Task Name"] ||
    props.Name ||
    props.Title ||
    null;
  const t = firstTextFromRichTextOrTitle(p);
  if (t) return t;
  return firstTitleFromAnyProperty(props);
}

function getNotionTaskNamePropertyFormat(env) {
  const f = env.NOTION_TASK_NAME_FORMAT ? String(env.NOTION_TASK_NAME_FORMAT).toLowerCase() : "rich_text";
  return f === "title" ? "title" : "rich_text";
}

function buildTaskNameNotionValue(env, title) {
  const content = String(title || "").slice(0, 2000);
  if (getNotionTaskNamePropertyFormat(env) === "title") {
    return { title: [{ type: "text", text: { content } }] };
  }
  return { rich_text: [{ type: "text", text: { content } }] };
}

function getConnectedProjectsPropertyName(env) {
  return notionPropName(env, "connected_projects", NotionTaskProps.connectedProjects);
}

async function buildCreateTaskProperties(env, db, profile, task) {
  await ensureNotionUserIdForEmail(env, db, profile);
  if (!profile.notion_user_id) {
    throw new Error(
      "Your work email does not match any Notion workspace member. Use the same email in the bot and in Notion.",
    );
  }
  const taskNameKey = notionPropName(env, "task_name", NotionTaskProps.taskName);
  const props = {
    [taskNameKey]: buildTaskNameNotionValue(env, task.title),
    [getConfiguredDeadlinePropName(env)]: { date: { start: task.deadline } },
    [notionPropName(env, "priority", NotionTaskProps.priority)]: { select: { name: task.priority } },
    [getConfiguredResponsiblePropName(env)]: { people: [{ id: String(profile.notion_user_id) }] },
  };
  if (task.project_id) {
    props[getConnectedProjectsPropertyName(env)] = { relation: [{ id: String(task.project_id) }] };
  }
  return props;
}

function levelFromPriorityName(name) {
  const s = normalizeKey(name);
  if (s === normalizeKey("low")) return 1;
  if (s === normalizeKey("medium")) return 2;
  if (s === normalizeKey("upper medium") || s === normalizeKey("upper_medium")) return 3;
  if (s === normalizeKey("high")) return 4;
  if (s === normalizeKey("very high") || s === normalizeKey("very_high")) return 5;
  return 1;
}

function relationPageIds(prop) {
  const arr = prop && prop.relation ? prop.relation : [];
  return arr.map((x) => (x && x.id ? String(x.id) : null)).filter(Boolean);
}

function pickFirstPropByNames(props, names) {
  for (const n of names) {
    if (props && Object.prototype.hasOwnProperty.call(props, n) && props[n]) return props[n];
  }
  return null;
}

function deadlineFromProps(props, env) {
  const names = env
    ? [getConfiguredDeadlinePropName(env), NotionTaskProps.deadline, "Due", "Due date", "Due Date"]
    : [NotionTaskProps.deadline, "Deadline", "Due", "Due date", "Due Date"];
  const prop = pickFirstPropByNames(props, names);
  if (!prop) return "";
  const d = dateStart(prop || {});
  if (d) return d;
  return textValue(prop);
}

function statusFromProps(props, env) {
  const names = env ? [getConfiguredStatusPropName(env), NotionTaskProps.status, "status"] : [NotionTaskProps.status, "Status", "status"];
  const prop = pickFirstPropByNames(props, names);
  return statusOrSelectName(prop || {});
}

function priorityFromProps(props, env) {
  const names = env
    ? [notionPropName(env, "priority", NotionTaskProps.priority), NotionTaskProps.priority, "priority"]
    : [NotionTaskProps.priority, "Priority", "priority"];
  const prop = pickFirstPropByNames(props, names);
  return selectName(prop || {});
}

function consultFromProps(props, env) {
  const consultName = env ? getConfiguredConsultPropName(env) : "Consult";
  const prop = pickFirstPropByNames(props, [consultName, "Consult", "consult"]);
  // Can be people (teamspace member) or text in different DBs.
  const p = peopleFirst(prop || {});
  if (p) return p;
  const t = textValue(prop || {});
  return t ? { name: t } : null;
}

function taskTypesFromProps(props, env) {
  const taskTypeName = env ? getConfiguredTaskTypePropName(env) : "Task Type";
  const prop = pickFirstPropByNames(props, [taskTypeName, "Task Type", "Category", "Categories"]);
  return multiSelectNames(prop || {});
}

async function projectNamesFromProps(env, props, limit = 3) {
  // Support old schemas:
  // - multi_select: "Related Project" / "Related Projects"
  // - relation: "Connected Project"
  const ms = pickFirstPropByNames(props, ["Related Project", "Related Projects", "Project", "Projects"]);
  const msNames = multiSelectNames(ms || {});
  if (msNames.length) return msNames.slice(0, limit);

  // Some DBs keep project as a plain text field.
  const txt = pickFirstPropByNames(props, ["Related Project", "Related Projects", "Project", "Projects"]);
  const txtVal = textValue(txt || {});
  if (txtVal) return [txtVal].slice(0, limit);

  const rel = pickFirstPropByNames(props, [
    NotionTaskProps.connectedProjects,
    "Connected Projects",
    "Connected Project",
    "Connected project",
  ]);
  const ids = relationPageIds(rel || {});
  if (!ids.length) return [];

  const out = [];
  for (const id of ids.slice(0, limit)) {
    try {
      out.push(await notionGetPageTitle(env, id));
    } catch {
      // ignore single project fetch failures
    }
  }
  return out.filter(Boolean);
}

async function notionGetPageTitle(env, pageId) {
  const page = await notionFetch(env, `/pages/${pageId}`, { method: "GET" });
  const props = page && page.properties ? page.properties : {};
  const t = firstTitleFromAnyProperty(props);
  return t || pageId;
}

function connectedProjectRelationIdsFromTask(page) {
  const props = (page && page.properties) || {};
  const prop =
    props[NotionTaskProps.connectedProjects] ||
    props["Connected Projects"] ||
    props["Connected Project"] ||
    props["Connected project"] ||
    props["Project"] ||
    props["Projects"] ||
    null;
  return relationPageIds(prop || {});
}

async function syncProjectsForUserFromNotion(env, db, profile) {
  // Build projects list from user's tasks (Connected Project relation).
  let tasks = [];
  try {
    tasks = await collectActiveNotionTasksForProfile(env, profile, 400);
  } catch (e) {
    console.error("syncProjectsForUserFromNotion notion error:", e);
    return;
  }

  const ids = new Set();
  for (const t of tasks) {
    for (const id of connectedProjectRelationIdsFromTask(t)) ids.add(id);
  }
  const projectIds = Array.from(ids);
  if (!projectIds.length) return;

  for (const projectId of projectIds) {
    const name = await notionGetPageTitle(env, projectId);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO projects(project_tag, project_name, project_owner_email, project_status) VALUES(?,?,?,?)",
    )
      .bind(projectId, name, profile.user_email, "active")
      .run();
  }
}

async function showProjectTasks(env, db, chatId, from, projectId) {
  const p = await getProfileByTelegramUserId(db, from.id);
  if (!p) return handleStart(env, db, chatId, from);
  await ensureNotionUserIdForEmail(env, db, p);

  const project = await dbGet(db, "SELECT project_name FROM projects WHERE project_tag=? LIMIT 1", [String(projectId)]);
  const projectName = project ? project.project_name : String(projectId);

  let tasks = [];
  try {
    tasks = await collectActiveNotionTasksForProfile(env, p, 400);
  } catch (e) {
    console.error("showProjectTasks notion error:", e);
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: String(e), reply_markup: await mainMenuKeyboard(db) });
    return;
  }

  const related = tasks.filter((t) => connectedProjectRelationIdsFromTask(t).includes(String(projectId)));
  if (!related.length) {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: `${projectName}\n\nNo tasks in this project.`,
      reply_markup: {
        inline_keyboard: [[{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: "menu:projects" }]],
      },
    });
    return;
  }

  const keyboard = {
    inline_keyboard: [
      ...related.map((page) => {
        const title = taskTitleFromPage(page);
        const deadline = deadlineFromProps(page.properties || {}, env);
        const label = deadline ? `${title} — ${deadline}` : title;
        return [{ text: label.slice(0, 60), callback_data: `task:open:${page.id}` }];
      }),
      [{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: "menu:projects" }],
    ],
  };
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: projectName, reply_markup: keyboard });
}

async function notionQueryDatabase(env, body) {
  const dbId = requireEnv(env, "NOTION_TASKS_DB_ID");
  return await notionFetch(env, `/databases/${dbId}/query`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * MVP-friendly Notion query:
 * - Avoid strict server-side filters on property names/types (these differ across workspaces).
 * - Fetch a larger page from the DB, then filter in code by Responsible + active Status.
 */
async function notionQueryTasksForUser(env, profile, wantCount) {
  const maxScan = Math.min(400, Math.max(50, wantCount * 10));
  const picked = await collectActiveNotionTasksForProfile(env, profile, maxScan);
  return picked.slice(0, wantCount);
}

async function notionQueryAllTasksForUser(env, profile) {
  return await collectActiveNotionTasksForProfile(env, profile, 400);
}

async function notionGetTask(env, pageId) {
  return await notionFetch(env, `/pages/${pageId}`, { method: "GET" });
}

async function notionUpdateTask(env, pageId, propertiesPatch) {
  return await notionFetch(env, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: propertiesPatch }),
  });
}

async function notionCreateTask(env, properties) {
  const dbId = requireEnv(env, "NOTION_TASKS_DB_ID");
  return await notionFetch(env, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties,
    }),
  });
}

async function ensureNotionUserIdForEmail(env, db, profile) {
  if (profile.notion_user_id) return profile.notion_user_id;
  // Try to find Notion user by email via /users (paginated). MVP: single pass.
  try {
    const users = await notionFetch(env, "/users", { method: "GET" });
    const list = users.results || [];
    const match = list.find(
      (u) => u.type === "person" && u.person && normalizeKey(u.person.email) === normalizeKey(profile.user_email),
    );
    if (match && match.id) {
      await env.DB.prepare("UPDATE profiles SET notion_user_id=? WHERE user_email=?")
        .bind(match.id, profile.user_email)
        .run();
      profile.notion_user_id = match.id;
      return match.id;
    }
  } catch (e) {
    // ignore; bot can still work with email fallback query
    console.warn("Notion user lookup failed", String(e));
  }
  return null;
}

async function handleStart(env, db, chatId, from) {
  const intro = await formatMessage(db, MessageTags.onboardingIntro, {});
  const askName = await formatMessage(db, MessageTags.onboardingAskName, {});
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: intro });
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: askName });
  // Store pending step in a lightweight way (D1 parameters table used as KV for MVP).
  await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
    .bind(`onboarding_step_${from.id}`, "name")
    .run();
  // Reset any previous onboarding partial state for this Telegram user.
  await env.DB.prepare("DELETE FROM parameters WHERE parameter_key=?")
    .bind(`onboarding_state_${from.id}`)
    .run();
}

async function handleOnboardingText(env, db, chatId, from, text) {
  const stepKey = `onboarding_step_${from.id}`;
  const row = await dbGet(db, "SELECT parameter_value FROM parameters WHERE parameter_key=? LIMIT 1", [stepKey]);
  const step = row ? row.parameter_value : null;
  if (!step) return false;

  const stateKey = `onboarding_state_${from.id}`;
  const stateRow = await dbGet(db, "SELECT parameter_value FROM parameters WHERE parameter_key=? LIMIT 1", [stateKey]);
  const state = stateRow ? JSON.parse(stateRow.parameter_value) : {};

  if (step === "name") {
    state.user_name = text.trim();
    await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
      .bind(stateKey, JSON.stringify(state))
      .run();
    await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
      .bind(stepKey, "email")
      .run();
    const askEmail = await formatMessage(db, MessageTags.onboardingAskEmail, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: askEmail });
    return true;
  }

  if (step === "email") {
    state.user_email = text.trim().toLowerCase();
    await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
      .bind(stateKey, JSON.stringify(state))
      .run();

    // If email already exists, link this Telegram account to that profile (no duplicates).
    const existingByEmail = await getProfileByEmail(db, state.user_email);
    if (existingByEmail) {
      await upsertProfile(db, {
        ...existingByEmail,
        telegram_user_id: String(from.id),
        telegram_username: from.username ? String(from.username) : existingByEmail.telegram_username,
      });
      await env.DB.prepare("DELETE FROM parameters WHERE parameter_key IN (?,?)")
        .bind(stepKey, stateKey)
        .run();
      await telegramApi(env, "sendMessage", {
        chat_id: chatId,
        text: "You logged in.",
        reply_markup: await mainMenuKeyboard(db),
      });
      return true;
    }

    await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
      .bind(stepKey, "location")
      .run();
    const askLoc = await formatMessage(db, MessageTags.onboardingAskLocation, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: askLoc });
    return true;
  }

  if (step === "location") {
    // Accept either location text or timezone. Store as timezone if it looks like Area/City.
    const loc = text.trim();
    const tzLike = /^[A-Za-z_]+\/[A-Za-z_]+/.test(loc) ? loc : null;
    const tz = tzLike || (await getParameter(db, "default_timezone")) || "UTC";
    const rt = (await getParameter(db, "default_reminder_time")) || "09:00";
    const reminder = parseTimeHHmm(rt) || "09:00";

    const profile = await upsertProfile(db, {
      user_name: state.user_name || "Unknown",
      user_email: state.user_email || "",
      telegram_user_id: String(from.id),
      telegram_username: from.username ? String(from.username) : null,
      timezone: tz,
      reminder_time: reminder,
    });

    await env.DB.prepare("DELETE FROM parameters WHERE parameter_key IN (?,?)")
      .bind(stepKey, stateKey)
      .run();

    const done = await formatMessage(db, MessageTags.onboardingComplete, { name: profile.user_name });
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: done,
      reply_markup: await mainMenuKeyboard(db),
    });
    return true;
  }

  return false;
}

async function profileSettingsKeyboard(db) {
  return {
    inline_keyboard: [
      [{ text: await formatMessage(db, MessageTags.profileSettingsChangeName, {}), callback_data: "settings:name" }],
      [{ text: await formatMessage(db, MessageTags.profileSettingsChangeLocation, {}), callback_data: "settings:location" }],
      [
        {
          text: await formatMessage(db, MessageTags.profileSettingsChangeReminderTime, {}),
          callback_data: "settings:reminder",
        },
      ],
      [{ text: await formatMessage(db, MessageTags.profileSetTask, {}), callback_data: "profile:settask" }],
      [{ text: await formatMessage(db, MessageTags.profileSettingsBack, {}), callback_data: "profile:main" }],
    ],
  };
}

async function showProfileSettings(env, db, chatId) {
  const text = await formatMessage(db, MessageTags.profileSettingsMenu, {});
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: await profileSettingsKeyboard(db),
  });
}

async function handleSettingsText(env, db, chatId, from, text) {
  const stepKey = `settings_step_${from.id}`;
  const row = await dbGet(db, "SELECT parameter_value FROM parameters WHERE parameter_key=? LIMIT 1", [stepKey]);
  const step = row ? row.parameter_value : null;
  if (!step) return false;

  const p = await getProfileByTelegramUserId(db, from.id);
  if (!p) return false;

  if (step === "name") {
    await upsertProfile(db, { ...p, user_name: text.trim() });
    await env.DB.prepare("DELETE FROM parameters WHERE parameter_key=?").bind(stepKey).run();
    const ok = await formatMessage(db, MessageTags.settingsSaved, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: ok });
    await showProfile(env, db, chatId, from);
    return true;
  }

  if (step === "location") {
    const loc = text.trim();
    const tzLike = /^[A-Za-z_]+\/[A-Za-z_]+/.test(loc) ? loc : null;
    const tz = tzLike || p.timezone || (await getParameter(db, "default_timezone")) || "UTC";
    await upsertProfile(db, { ...p, timezone: tz });
    await env.DB.prepare("DELETE FROM parameters WHERE parameter_key=?").bind(stepKey).run();
    const ok = await formatMessage(db, MessageTags.settingsSaved, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: ok });
    await showProfile(env, db, chatId, from);
    return true;
  }

  if (step === "reminder") {
    const rt = parseTimeHHmm(text);
    if (!rt) {
      const ask = await formatMessage(db, MessageTags.settingsAskReminderTime, {});
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: ask });
      return true;
    }
    await upsertProfile(db, { ...p, reminder_time: rt });
    await env.DB.prepare("DELETE FROM parameters WHERE parameter_key=?").bind(stepKey).run();
    const ok = await formatMessage(db, MessageTags.settingsSaved, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: ok });
    await showProfile(env, db, chatId, from);
    return true;
  }

  return false;
}

async function showOnFire(env, db, chatId, from) {
  const p = await getProfileByTelegramUserId(db, from.id);
  if (!p) return handleStart(env, db, chatId, from);
  await ensureNotionUserIdForEmail(env, db, p);

  const tz = p.timezone || (await getParameter(db, "default_timezone")) || "UTC";
  const today = ymdFromDateInTimeZone(new Date(), tz);
  const tomorrow = addDaysYmd(today, 1);
  const dayAfter = addDaysYmd(today, 2);

  let tasks = [];
  try {
    tasks = await collectActiveNotionTasksForProfile(env, p, 200);
  } catch (e) {
    console.error("showOnFire notion error:", e);
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: String(e), reply_markup: await mainMenuKeyboard(db) });
    return;
  }

  const withDeadline = tasks
    .map((t) => ({ t, d: parseLooseDeadlineToYmd(deadlineFromProps((t && t.properties) || {}, env), today) }))
    .filter((x) => Boolean(x.d));

  withDeadline.sort((a, b) => String(a.d).localeCompare(String(b.d)));
  const urgent = withDeadline.slice(0, 5).map((x) => x.t);

  if (!urgent.length) {
    const t = await formatMessage(db, MessageTags.onFireEmpty, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: t, reply_markup: await mainMenuKeyboard(db) });
    return;
  }

  const header = await formatMessage(db, MessageTags.onFireHeader, {});
  const keyboard = {
    inline_keyboard: [
      ...urgent.map((page) => {
        const title = taskTitleFromPage(page);
        const deadline = deadlineFromProps(page.properties || {}, env);
        const label = deadline ? `${title} — ${deadline}` : title;
        return [{ text: label.slice(0, 60), callback_data: `task:open:${page.id}` }];
      }),
      [{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: "menu:back" }],
    ],
  };
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: header, reply_markup: keyboard });
}

async function showTeam(env, db, chatId, from) {
  const me = await getProfileByTelegramUserId(db, from.id);
  if (!me) return handleStart(env, db, chatId, from);
  const rows = await dbAll(
    db,
    "SELECT user_name, telegram_user_id FROM profiles WHERE telegram_user_id IS NOT NULL AND telegram_user_id != ? ORDER BY user_name LIMIT 30",
    [String(from.id)],
  );
  if (!rows.length) {
    const t = await formatMessage(db, MessageTags.teamEmpty, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: t, reply_markup: await mainMenuKeyboard(db) });
    return;
  }
  const header = await formatMessage(db, MessageTags.teamHeader, {});
  const keyboard = {
    inline_keyboard: [
      ...rows.map((r) => [{ text: r.user_name, callback_data: `team:${String(r.telegram_user_id)}` }]),
      [{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: "menu:back" }],
    ],
  };
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: header, reply_markup: keyboard });
}

async function showTeamMemberProfile(env, db, chatId, from, targetTelegramUserId) {
  const target = await getProfileByTelegramUserId(db, targetTelegramUserId);
  if (!target) {
    const t = await formatMessage(db, MessageTags.teamEmpty, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: t, reply_markup: await mainMenuKeyboard(db) });
    return;
  }
  const keyboard = {
    inline_keyboard: [
      [
        { text: await formatMessage(db, MessageTags.teamMemberViewTasks, {}), callback_data: `team:tasks:${String(targetTelegramUserId)}` },
        { text: await formatMessage(db, MessageTags.teamMemberViewProjects, {}), callback_data: `team:projects:${String(targetTelegramUserId)}` },
      ],
      [{ text: await formatMessage(db, MessageTags.teamMemberBack, {}), callback_data: "menu:team" }],
    ],
  };
  await sendProfileCard(env, db, chatId, target, keyboard);
}

async function showProfile(env, db, chatId, from) {
  const p = await getProfileByTelegramUserId(db, from.id);
  if (!p) {
    await handleStart(env, db, chatId, from);
    return;
  }
  const keyboard = {
    inline_keyboard: [
      [{ text: await formatMessage(db, MessageTags.profileSettingsOpen, {}), callback_data: "profile:settings" }],
      [{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: "menu:back" }],
    ],
  };
  await sendProfileCard(env, db, chatId, p, keyboard);
}

async function showProjects(env, db, chatId, from) {
  const p = await getProfileByTelegramUserId(db, from.id);
  if (!p) {
    await handleStart(env, db, chatId, from);
    return;
  }
  await ensureNotionUserIdForEmail(env, db, p);
  await syncProjectsForUserFromNotion(env, db, p);
  const projects = await dbAll(
    db,
    "SELECT project_tag, project_name, project_status FROM projects WHERE lower(project_owner_email)=? ORDER BY project_name",
    [normalizeKey(p.user_email)],
  );
  if (!projects.length) {
    const t = await formatMessage(db, MessageTags.projectsEmpty, { email: p.user_email });
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: t, reply_markup: await mainMenuKeyboard(db) });
    return;
  }
  const header = await formatMessage(db, MessageTags.projectsListHeader, {});
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: header,
    reply_markup: {
      inline_keyboard: [
        ...projects.map((x) => [{ text: x.project_name, callback_data: `project:open:${x.project_tag}` }]),
        [{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: "menu:back" }],
      ],
    },
  });
}

async function showTasks(env, db, chatId, from) {
  const p = await getProfileByTelegramUserId(db, from.id);
  if (!p) return handleStart(env, db, chatId, from);
  await ensureNotionUserIdForEmail(env, db, p);
  let tasks = [];
  try {
    tasks = await notionQueryAllTasksForUser(env, p);
  } catch (e) {
    console.error("showTasks notion error:", e);
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text:
        "Could not load tasks from Notion. Common causes:\n" +
        "- integration not invited to the database\n" +
        "- wrong NOTION_TASKS_DB_ID\n" +
        "- property names differ (needs Responsible + Status + Deadline)\n" +
        "- Responsible must be a People/member field matched by work email\n\n" +
        `Details: ${String(e)}`,
      reply_markup: await mainMenuKeyboard(db),
    });
    return;
  }
  if (!tasks.length) {
    const t = await formatMessage(db, MessageTags.tasksEmpty, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: t, reply_markup: await mainMenuKeyboard(db) });
    return;
  }
  const header = await formatMessage(db, MessageTags.tasksListHeader, {});
  const sliced = tasks.slice(0, 50);
  const keyboard = {
    inline_keyboard: [
      ...sliced.map((page) => {
        const title = taskTitleFromPage(page);
        const deadline = deadlineFromProps(page.properties || {}, env);
        const label = deadline ? `${title} — ${deadline}` : title;
        return [{ text: label.slice(0, 60), callback_data: `task:open:${page.id}` }];
      }),
      [{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: "menu:back" }],
    ],
  };
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: tasks.length > sliced.length ? `${header}\n\nShowing ${sliced.length}/${tasks.length}` : header,
    reply_markup: keyboard,
  });
}

async function renderTaskCard(env, db, page) {
  const props = page.properties || {};
  const title = taskTitleFromPage(page);
  const deadline = deadlineFromProps(props, env);
  const status = statusFromProps(props, env);
  const priority = priorityFromProps(props, env);
  const level = levelFromPriorityName(priority);
  const reward = level;
  const categories = taskTypesFromProps(props, env);
  const description = firstTextFromRichText(props.Description || {}) || "";

  const projects = await projectNamesFromProps(env, props, 3);

  const consult = consultFromProps(props, env);
  const consultName = consult && consult.name ? consult.name : "";
  const consultTg = "";

  const template = await formatMessage(db, MessageTags.taskCardTemplate, {});
  const text = formatTemplate(template, {
    title,
    deadline,
    reward,
    project: projects.join(", "),
    priority,
    status,
    categories: categories.map((c) => `#${c.replace(/\s+/g, "")}`).join(" "),
    description,
    consult_name: consultName,
    consult_telegram: consultTg ? `@${consultTg.replace(/^@/, "")}` : "",
  });
  return text;
}

async function openTaskReadonly(env, db, chatId, pageId, backCb) {
  const page = await notionGetTask(env, pageId);
  if (!page) {
    const t = await formatMessage(db, MessageTags.taskNotFound, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: t, reply_markup: await mainMenuKeyboard(db) });
    return;
  }
  const text = await renderTaskCard(env, db, page);
  const keyboard = {
    inline_keyboard: [[{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: backCb }]],
  };
  await telegramApi(env, "sendMessage", { chat_id: chatId, text, reply_markup: keyboard });
}

async function showTeamMemberTasks(env, db, chatId, from, targetTelegramUserId) {
  const me = await getProfileByTelegramUserId(db, from.id);
  if (!me) return handleStart(env, db, chatId, from);
  const target = await getProfileByTelegramUserId(db, targetTelegramUserId);
  if (!target) {
    const t = await formatMessage(db, MessageTags.teamEmpty, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: t, reply_markup: await mainMenuKeyboard(db) });
    return;
  }
  await ensureNotionUserIdForEmail(env, db, target);
  let tasks = [];
  try {
    tasks = await collectActiveNotionTasksForProfile(env, target, 200);
  } catch (e) {
    console.error("showTeamMemberTasks notion error:", e);
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: String(e), reply_markup: await mainMenuKeyboard(db) });
    return;
  }
  if (!tasks.length) {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: `${target.user_name}\n\n${await formatMessage(db, MessageTags.tasksEmpty, {})}`,
      reply_markup: {
        inline_keyboard: [[{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: `team:${String(targetTelegramUserId)}` }]],
      },
    });
    return;
  }
  const keyboard = {
    inline_keyboard: [
      ...tasks.map((page) => {
        const title = taskTitleFromPage(page);
        const deadline = deadlineFromProps(page.properties || {}, env);
        const label = deadline ? `${title} — ${deadline}` : title;
        return [{ text: label.slice(0, 60), callback_data: `teamtask:open:${page.id}:${String(targetTelegramUserId)}` }];
      }),
      [{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: `team:${String(targetTelegramUserId)}` }],
    ],
  };
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: target.user_name, reply_markup: keyboard });
}

async function showTeamMemberProjects(env, db, chatId, from, targetTelegramUserId) {
  const me = await getProfileByTelegramUserId(db, from.id);
  if (!me) return handleStart(env, db, chatId, from);
  const target = await getProfileByTelegramUserId(db, targetTelegramUserId);
  if (!target) {
    const t = await formatMessage(db, MessageTags.teamEmpty, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: t, reply_markup: await mainMenuKeyboard(db) });
    return;
  }
  await ensureNotionUserIdForEmail(env, db, target);
  await syncProjectsForUserFromNotion(env, db, target);
  const projects = await dbAll(
    db,
    "SELECT project_tag, project_name FROM projects WHERE lower(project_owner_email)=? ORDER BY project_name LIMIT 50",
    [normalizeKey(target.user_email)],
  );
  if (!projects.length) {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: `${target.user_name}\n\n${await formatMessage(db, MessageTags.projectsEmpty, { email: target.user_email })}`,
      reply_markup: {
        inline_keyboard: [[{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: `team:${String(targetTelegramUserId)}` }]],
      },
    });
    return;
  }
  const keyboard = {
    inline_keyboard: [
      ...projects.map((p) => [{ text: p.project_name, callback_data: `team:project:${String(targetTelegramUserId)}:${p.project_tag}` }]),
      [{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: `team:${String(targetTelegramUserId)}` }],
    ],
  };
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: target.user_name, reply_markup: keyboard });
}

async function showTeamMemberProjectTasks(env, db, chatId, from, targetTelegramUserId, projectId) {
  const me = await getProfileByTelegramUserId(db, from.id);
  if (!me) return handleStart(env, db, chatId, from);
  const target = await getProfileByTelegramUserId(db, targetTelegramUserId);
  if (!target) return;
  await ensureNotionUserIdForEmail(env, db, target);
  let tasks = [];
  try {
    tasks = await collectActiveNotionTasksForProfile(env, target, 400);
  } catch (e) {
    console.error("showTeamMemberProjectTasks notion error:", e);
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: String(e), reply_markup: await mainMenuKeyboard(db) });
    return;
  }
  const related = tasks.filter((t) => connectedProjectRelationIdsFromTask(t).includes(String(projectId)));
  const project = await dbGet(db, "SELECT project_name FROM projects WHERE project_tag=? LIMIT 1", [String(projectId)]);
  const projectName = project ? project.project_name : String(projectId);
  if (!related.length) {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: `${projectName}\n\nNo tasks in this project.`,
      reply_markup: {
        inline_keyboard: [[{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: `team:projects:${String(targetTelegramUserId)}` }]],
      },
    });
    return;
  }
  const keyboard = {
    inline_keyboard: [
      ...related.map((page) => {
        const title = taskTitleFromPage(page);
        const deadline = deadlineFromProps(page.properties || {}, env);
        const label = deadline ? `${title} — ${deadline}` : title;
        return [{ text: label.slice(0, 60), callback_data: `teamtask:open:${page.id}:${String(targetTelegramUserId)}` }];
      }),
      [{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: `team:projects:${String(targetTelegramUserId)}` }],
    ],
  };
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: projectName, reply_markup: keyboard });
}

async function openTask(env, db, chatId, from, pageId) {
  const p = await getProfileByTelegramUserId(db, from.id);
  if (!p) return handleStart(env, db, chatId, from);
  const page = await notionGetTask(env, pageId);
  if (!page) {
    const t = await formatMessage(db, MessageTags.taskNotFound, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: t, reply_markup: await mainMenuKeyboard(db) });
    return;
  }
  const text = await renderTaskCard(env, db, page);
  const btnComplete = await formatMessage(db, MessageTags.taskActionComplete, {});
  const btnReschedule = await formatMessage(db, MessageTags.taskActionReschedule, {});
  const keyboard = {
    inline_keyboard: [
      [
        { text: btnComplete, callback_data: `task:done:${pageId}` },
        { text: btnReschedule, callback_data: `task:resched:${pageId}` },
      ],
      [{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: "menu:tasks" }],
    ],
  };
  await telegramApi(env, "sendMessage", { chat_id: chatId, text, reply_markup: keyboard });
}

async function completeTask(env, db, chatId, from, pageId) {
  const p = await getProfileByTelegramUserId(db, from.id);
  if (!p) return handleStart(env, db, chatId, from);
  const page = await notionGetTask(env, pageId);
  if (!page) return;
  const props = page.properties || {};
  const priority = priorityFromProps(props, env);
  const level = levelFromPriorityName(priority);
  const before = normalizeKey(statusFromProps(props, env));
  const alreadyDone = before === normalizeKey("Done");
  const statusKey = getConfiguredStatusPropName(env);
  const statusProp = props[statusKey] || props.Status;
  const statusType = statusProp && statusProp.type ? statusProp.type : null;
  if (statusType === "status") {
    await notionUpdateTask(env, pageId, { [statusKey]: { status: { name: "Done" } } });
  } else if (statusType === "select") {
    await notionUpdateTask(env, pageId, { [statusKey]: { select: { name: "Done" } } });
  } else {
    throw new Error(`Unsupported Notion Status field type: ${statusType || "unknown"}`);
  }

  if (!alreadyDone) {
    const newBalance = Number(p.sparks || 0) + Number(level);
    await env.DB.batch([
      env.DB.prepare("UPDATE profiles SET sparks=?, completed_tasks=completed_tasks+1 WHERE user_email=?").bind(
        newBalance,
        p.user_email,
      ),
      env.DB.prepare(
        "INSERT INTO sparks_ledger(event_at, user_email, delta, balance_after, reason, notion_page_id) VALUES(?,?,?,?,?,?)",
      ).bind(new Date().toISOString(), p.user_email, Number(level), newBalance, "task_done", pageId),
    ]);
  }

  // Re-open card
  await openTask(env, db, chatId, from, pageId);
}

async function startReschedule(env, db, chatId, from, pageId) {
  const ask = await formatMessage(db, MessageTags.taskAskRescheduleDate, {});
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: ask });
  await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
    .bind(`resched_${from.id}`, pageId)
    .run();
}

function parseISODate(s) {
  const t = String(s || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return t;
}

async function startSetTaskFlow(env, db, chatId, from) {
  await env.DB.prepare("DELETE FROM parameters WHERE parameter_key IN (?,?)")
    .bind(`settask_step_${from.id}`, `settask_state_${from.id}`)
    .run();
  await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
    .bind(`settask_step_${from.id}`, "title")
    .run();
  const ask = await formatMessage(db, MessageTags.setTaskAskTitle, {});
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: ask });
}

async function setTaskPriorityKeyboard(db) {
  const opts = ["Low", "Medium", "Upper Medium", "High", "VERY HIGH"];
  return {
    inline_keyboard: [
      ...opts.map((name) => [{ text: name, callback_data: `settask:priority:${name}` }]),
      [{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: "profile:settings" }],
    ],
  };
}

async function setTaskProjectKeyboard(env, db, profile) {
  const rows = await dbAll(
    db,
    "SELECT project_tag, project_name FROM projects WHERE lower(project_owner_email)=? ORDER BY project_name LIMIT 50",
    [normalizeKey(profile.user_email)],
  );
  const noProjText = await formatMessage(db, MessageTags.setTaskNoProject, {});
  return {
    inline_keyboard: [
      ...rows.map((r) => [{ text: r.project_name, callback_data: `settask:project:${r.project_tag}` }]),
      [{ text: noProjText, callback_data: "settask:project:none" }],
      [{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: "profile:settings" }],
    ],
  };
}

async function handleSetTaskText(env, db, chatId, from, text) {
  const stepKey = `settask_step_${from.id}`;
  const row = await dbGet(db, "SELECT parameter_value FROM parameters WHERE parameter_key=? LIMIT 1", [stepKey]);
  const step = row ? row.parameter_value : null;
  if (!step) return false;

  const stateKey = `settask_state_${from.id}`;
  const stateRow = await dbGet(db, "SELECT parameter_value FROM parameters WHERE parameter_key=? LIMIT 1", [stateKey]);
  const state = stateRow ? JSON.parse(stateRow.parameter_value) : {};

  const p = await getProfileByTelegramUserId(db, from.id);
  if (!p) return false;

  if (step === "title") {
    state.title = String(text || "").trim();
    await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
      .bind(stateKey, JSON.stringify(state))
      .run();
    await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
      .bind(stepKey, "deadline")
      .run();
    const ask = await formatMessage(db, MessageTags.setTaskAskDeadline, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: ask });
    return true;
  }

  if (step === "deadline") {
    const d = parseISODate(text);
    if (!d) {
      const ask = await formatMessage(db, MessageTags.setTaskAskDeadline, {});
      await telegramApi(env, "sendMessage", { chat_id: chatId, text: ask });
      return true;
    }
    state.deadline = d;
    await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
      .bind(stateKey, JSON.stringify(state))
      .run();
    await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
      .bind(stepKey, "priority")
      .run();
    const ask = await formatMessage(db, MessageTags.setTaskAskPriority, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: ask, reply_markup: await setTaskPriorityKeyboard(db) });
    return true;
  }

  return false;
}

async function handleRescheduleText(env, db, chatId, from, text) {
  const key = `resched_${from.id}`;
  const row = await dbGet(db, "SELECT parameter_value FROM parameters WHERE parameter_key=? LIMIT 1", [key]);
  const pageId = row ? row.parameter_value : null;
  if (!pageId) return false;
  const date = parseISODate(text);
  if (!date) {
    const ask = await formatMessage(db, MessageTags.taskAskRescheduleDate, {});
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: ask });
    return true;
  }
  await notionUpdateTask(env, pageId, {
    [getConfiguredDeadlinePropName(env)]: { date: { start: date } },
  });
  await env.DB.prepare("DELETE FROM parameters WHERE parameter_key=?").bind(key).run();
  const ok = await formatMessage(db, MessageTags.taskRescheduleOk, { date });
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: ok });
  await openTask(env, db, chatId, from, pageId);
  return true;
}

async function showHelper(env, db, chatId, from, encodedName) {
  const p = await getProfileByTelegramUserId(db, from.id);
  if (!p) return handleStart(env, db, chatId, from);
  const name = await resolveShopViewRef(db, encodedName);
  const helper = await dbGet(db, "SELECT name, price, description, image_link FROM helpers WHERE name=? LIMIT 1", [name]);
  if (!helper) return;

  const caption = await formatMessage(db, MessageTags.helperCard, {
    name: helper.name,
    price: helper.price,
    description: helper.description || "",
  });

  const btnBuy = await formatMessage(db, MessageTags.helperActionBuy, {});
  const btnBack = await formatMessage(db, MessageTags.helperActionBack, {});
  const keyboard = {
    inline_keyboard: [
      [{ text: btnBuy, callback_data: `shop:buy:${helper.name}` }],
      [{ text: btnBack, callback_data: "menu:shop" }],
    ],
  };

  await sendTelegramPhotoOrText(env, {
    chat_id: chatId,
    imageUrl: helper.image_link,
    caption,
    reply_markup: keyboard,
  });
}

async function showShop(env, db, chatId, from) {
  const helpers = await dbAll(db, "SELECT name, price, description FROM helpers ORDER BY price, name");
  const header = await formatMessage(db, MessageTags.shopListHeader, {});
  const keyboard = {
    inline_keyboard: [
      ...(await Promise.all(
        helpers.map(async (h) => {
          const token = await allocateShopViewToken(db, h.name);
          return [{ text: h.name, callback_data: `shop:view:${token}` }];
        }),
      )),
      [{ text: await formatMessage(db, MessageTags.menuBack, {}), callback_data: "menu:back" }],
    ],
  };
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text: header,
    reply_markup: keyboard,
  });
}

async function buyHelper(env, db, chatId, from, helperName) {
  const p = await getProfileByTelegramUserId(db, from.id);
  if (!p) return handleStart(env, db, chatId, from);
  const helper = await dbGet(db, "SELECT name, price FROM helpers WHERE name=? LIMIT 1", [helperName]);
  if (!helper) return;
  const balance = Number(p.sparks || 0);
  const price = Number(helper.price || 0);
  if (balance < price) {
    const t = await formatMessage(db, MessageTags.shopInsufficientSparks, { price, balance });
    await telegramApi(env, "sendMessage", { chat_id: chatId, text: t, reply_markup: await mainMenuKeyboard(db) });
    return;
  }
  const newBalance = balance - price;
  await env.DB.batch([
    env.DB.prepare("UPDATE profiles SET sparks=? WHERE user_email=?").bind(newBalance, p.user_email),
    env.DB.prepare(
      "INSERT INTO inventory(user_email, helper_name, quantity) VALUES(?,?,1) ON CONFLICT(user_email, helper_name) DO UPDATE SET quantity=quantity+1",
    ).bind(p.user_email, helper.name),
    env.DB.prepare(
      "INSERT INTO sparks_ledger(event_at, user_email, delta, balance_after, reason, helper_name) VALUES(?,?,?,?,?,?)",
    ).bind(new Date().toISOString(), p.user_email, -price, newBalance, "shop_buy", helper.name),
  ]);
  const t = await formatMessage(db, MessageTags.shopPurchaseSuccess, { helper: helper.name, balance: newBalance });
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: t, reply_markup: await mainMenuKeyboard(db) });
}

async function sellHelper(env, db, chatId, from, helperName) {
  const p = await getProfileByTelegramUserId(db, from.id);
  if (!p) return handleStart(env, db, chatId, from);
  const helper = await dbGet(db, "SELECT name, price FROM helpers WHERE name=? LIMIT 1", [helperName]);
  if (!helper) return;
  const inv = await dbGet(
    db,
    "SELECT quantity FROM inventory WHERE user_email=? AND helper_name=? LIMIT 1",
    [p.user_email, helper.name],
  );
  const qty = inv ? Number(inv.quantity || 0) : 0;
  if (qty <= 0) return;
  const refund = Number(helper.price || 0);
  const newBalance = Number(p.sparks || 0) + refund;
  await env.DB.batch([
    env.DB.prepare("UPDATE profiles SET sparks=? WHERE user_email=?").bind(newBalance, p.user_email),
    env.DB.prepare("UPDATE inventory SET quantity=quantity-1 WHERE user_email=? AND helper_name=?")
      .bind(p.user_email, helper.name),
    env.DB.prepare("DELETE FROM inventory WHERE user_email=? AND helper_name=? AND quantity<=0")
      .bind(p.user_email, helper.name),
    env.DB.prepare(
      "INSERT INTO sparks_ledger(event_at, user_email, delta, balance_after, reason, helper_name) VALUES(?,?,?,?,?,?)",
    ).bind(new Date().toISOString(), p.user_email, refund, newBalance, "shop_sell", helper.name),
  ]);
  const t = await formatMessage(db, MessageTags.shopSellSuccess, { helper: helper.name, balance: newBalance });
  await telegramApi(env, "sendMessage", { chat_id: chatId, text: t, reply_markup: await mainMenuKeyboard(db) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok");
    }

    // Lightweight diagnostics (no secrets returned).
    if (url.pathname === "/telegram/ping" && request.method === "GET") {
      const hasToken = Boolean(env.TELEGRAM_BOT_TOKEN);
      const hasDb = Boolean(env.DB);
      const hasNotion = Boolean(env.NOTION_TOKEN && env.NOTION_TASKS_DB_ID);
      let me = null;
      try {
        if (hasToken) me = await telegramApi(env, "getMe", {});
      } catch (e) {
        me = { error: String(e) };
      }
      return Response.json({ ok: true, hasToken, hasDb, hasNotion, me });
    }

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      const secret = env.TELEGRAM_WEBHOOK_SECRET;
      if (secret) {
        const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (got !== secret) return new Response("unauthorized", { status: 401 });
      }

      try {
        let update;
        try {
          update = await request.json();
        } catch {
          console.error("Webhook JSON parse failed");
          return new Response("ok");
        }
        const db = env.DB;
        if (!db) {
          console.error("Missing D1 binding env.DB — add D1 binding named DB in Worker settings.");
          return new Response("ok");
        }

        console.log("telegram update keys:", Object.keys(update || {}));

        const message = update.message || update.edited_message;
        const callback = update.callback_query;

        if (message && message.chat && message.from) {
          const chatId = message.chat.id;
          const from = message.from;
          const text = getCommandLikeText(message);
          if (isStartCommand(text)) {
            await handleStart(env, db, chatId, from);
            return new Response("ok");
          }
          if (/^\/menu(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(String(text || "")) || /^(menu|меню)$/i.test(String(text || "").trim())) {
            const menu = await formatMessage(db, MessageTags.menuMain, {});
            await telegramApi(env, "sendMessage", { chat_id: chatId, text: menu, reply_markup: await mainMenuKeyboard(db) });
            return new Response("ok");
          }
          const handled = await handleOnboardingText(env, db, chatId, from, text);
          const handledSettings = handled ? false : await handleSettingsText(env, db, chatId, from, text);
          const handledSetTask = handled || handledSettings ? false : await handleSetTaskText(env, db, chatId, from, text);
          const handledReschedule =
            handled || handledSettings || handledSetTask ? false : await handleRescheduleText(env, db, chatId, from, text);
          if (!handled && !handledSettings && !handledSetTask && !handledReschedule) {
            const menu = await formatMessage(db, MessageTags.menuMain, {});
            await telegramApi(env, "sendMessage", {
              chat_id: chatId,
              text: menu,
              reply_markup: await mainMenuKeyboard(db),
            });
          }
          return new Response("ok");
        }

        if (callback && callback.message) {
          const chatId = callback.message.chat.id;
          const from = callback.from;
          const data = String(callback.data || "");

          // Telegram shows a loading spinner until the callback query is answered.
          // Notion calls can take > few seconds, so answer immediately, then do work.
          try {
            await telegramApi(env, "answerCallbackQuery", { callback_query_id: callback.id });
          } catch (e) {
            console.error("answerCallbackQuery failed:", e);
          }

          if (!from) {
            console.warn("callback_query without from; ignoring");
            return new Response("ok");
          }

          try {
            if (data === "menu:tasks") await showTasks(env, db, chatId, from);
            else if (data === "menu:onfire") await showOnFire(env, db, chatId, from);
            else if (data === "menu:team") await showTeam(env, db, chatId, from);
            else if (data === "menu:profile") await showProfile(env, db, chatId, from);
            else if (data === "menu:projects") await showProjects(env, db, chatId, from);
            else if (data === "menu:shop") await showShop(env, db, chatId, from);
            else if (data === "profile:settings") await showProfileSettings(env, db, chatId);
            else if (data === "profile:settask") await startSetTaskFlow(env, db, chatId, from);
            else if (data === "profile:main") await showProfile(env, db, chatId, from);
            else if (data === "settings:name") {
              const ask = await formatMessage(db, MessageTags.settingsAskName, {});
              await telegramApi(env, "sendMessage", { chat_id: chatId, text: ask });
              await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
                .bind(`settings_step_${from.id}`, "name")
                .run();
            } else if (data === "settings:location") {
              const ask = await formatMessage(db, MessageTags.settingsAskLocation, {});
              await telegramApi(env, "sendMessage", { chat_id: chatId, text: ask });
              await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
                .bind(`settings_step_${from.id}`, "location")
                .run();
            } else if (data === "settings:reminder") {
              const ask = await formatMessage(db, MessageTags.settingsAskReminderTime, {});
              await telegramApi(env, "sendMessage", { chat_id: chatId, text: ask });
              await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
                .bind(`settings_step_${from.id}`, "reminder")
                .run();
            } else if (data === "menu:back") {
              const menu = await formatMessage(db, MessageTags.menuMain, {});
              await telegramApi(env, "sendMessage", { chat_id: chatId, text: menu, reply_markup: await mainMenuKeyboard(db) });
            } else if (data.startsWith("shop:view:")) {
              await showHelper(env, db, chatId, from, data.slice("shop:view:".length));
            } else if (data.startsWith("project:open:")) {
              await showProjectTasks(env, db, chatId, from, data.slice("project:open:".length));
            } else if (data.startsWith("team:tasks:")) {
              await showTeamMemberTasks(env, db, chatId, from, data.slice("team:tasks:".length));
            } else if (data.startsWith("team:projects:")) {
              await showTeamMemberProjects(env, db, chatId, from, data.slice("team:projects:".length));
            } else if (data.startsWith("team:project:")) {
              const rest = data.slice("team:project:".length);
              const idx = rest.indexOf(":");
              if (idx > 0) {
                const who = rest.slice(0, idx);
                const proj = rest.slice(idx + 1);
                await showTeamMemberProjectTasks(env, db, chatId, from, who, proj);
              }
            } else if (data.startsWith("teamtask:open:")) {
              const rest = data.slice("teamtask:open:".length);
              const idx = rest.lastIndexOf(":");
              if (idx > 0) {
                const pageId = rest.slice(0, idx);
                const who = rest.slice(idx + 1);
                await openTaskReadonly(env, db, chatId, pageId, `team:tasks:${who}`);
              }
            } else if (data.startsWith("settask:priority:")) {
              const p = await getProfileByTelegramUserId(db, from.id);
              if (!p) return;
              const stateKey = `settask_state_${from.id}`;
              const stateRow = await dbGet(db, "SELECT parameter_value FROM parameters WHERE parameter_key=? LIMIT 1", [stateKey]);
              const state = stateRow ? JSON.parse(stateRow.parameter_value) : {};
              state.priority = data.slice("settask:priority:".length);
              await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
                .bind(stateKey, JSON.stringify(state))
                .run();
              await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
                .bind(`settask_step_${from.id}`, "project")
                .run();
              // Ensure projects are present for chooser
              await ensureNotionUserIdForEmail(env, db, p);
              await syncProjectsForUserFromNotion(env, db, p);
              const ask = await formatMessage(db, MessageTags.setTaskAskProject, {});
              await telegramApi(env, "sendMessage", {
                chat_id: chatId,
                text: ask,
                reply_markup: await setTaskProjectKeyboard(env, db, p),
              });
            } else if (data.startsWith("settask:project:")) {
              const p = await getProfileByTelegramUserId(db, from.id);
              if (!p) return;
              const stateKey = `settask_state_${from.id}`;
              const stateRow = await dbGet(db, "SELECT parameter_value FROM parameters WHERE parameter_key=? LIMIT 1", [stateKey]);
              const state = stateRow ? JSON.parse(stateRow.parameter_value) : {};
              const picked = data.slice("settask:project:".length);
              state.project_id = picked === "none" ? null : picked;
              await env.DB.prepare("INSERT OR REPLACE INTO parameters(parameter_key, parameter_value) VALUES(?,?)")
                .bind(stateKey, JSON.stringify(state))
                .run();

              const title = String(state.title || "").trim();
              const deadline = String(state.deadline || "").trim();
              const priority = String(state.priority || "").trim();
              if (!title || !deadline || !priority) {
                await telegramApi(env, "sendMessage", { chat_id: chatId, text: "Set task flow expired. Start again from Profile settings." });
                await env.DB.prepare("DELETE FROM parameters WHERE parameter_key IN (?,?)")
                  .bind(`settask_step_${from.id}`, stateKey)
                  .run();
                return;
              }

              let props;
              try {
                props = await buildCreateTaskProperties(env, db, p, {
                  title,
                  deadline,
                  priority,
                  project_id: state.project_id,
                });
              } catch (e) {
                console.error("buildCreateTaskProperties error:", e);
                await telegramApi(env, "sendMessage", {
                  chat_id: chatId,
                  text:
                    "Could not create task in Notion. Make sure your work email matches your Notion account " +
                    "and the bot integration can access Tasks + hosq projects databases.\n\n" +
                    `Details: ${String(e)}`,
                });
                return;
              }

              await notionCreateTask(env, props);

              await env.DB.prepare("DELETE FROM parameters WHERE parameter_key IN (?,?)")
                .bind(`settask_step_${from.id}`, stateKey)
                .run();
              const ok = await formatMessage(db, MessageTags.setTaskCreated, {});
              await telegramApi(env, "sendMessage", { chat_id: chatId, text: ok, reply_markup: await mainMenuKeyboard(db) });
            } else if (data.startsWith("team:")) {
              await showTeamMemberProfile(env, db, chatId, from, data.slice("team:".length));
            } else if (data.startsWith("shop:buy:")) {
              await buyHelper(env, db, chatId, from, data.slice("shop:buy:".length));
            } else if (data.startsWith("shop:sell:")) {
              await sellHelper(env, db, chatId, from, data.slice("shop:sell:".length));
            } else if (data.startsWith("task:open:")) {
              await openTask(env, db, chatId, from, data.slice("task:open:".length));
            } else if (data.startsWith("task:done:")) {
              await completeTask(env, db, chatId, from, data.slice("task:done:".length));
            } else if (data.startsWith("task:resched:")) {
              await startReschedule(env, db, chatId, from, data.slice("task:resched:".length));
            }
          } catch (e) {
            console.error("callback handler error:", e);
            try {
              await telegramApi(env, "sendMessage", {
                chat_id: chatId,
                text: `Bot error while handling button: ${String(e)}`,
              });
            } catch (e2) {
              console.error("failed to send error message:", e2);
            }
          }
          return new Response("ok");
        }

        return new Response("ok");
      } catch (e) {
        console.error("Webhook error:", e);
        // Always return 200 so Telegram doesn't spin retries forever on transient errors.
        return new Response("ok");
      }
    }

    return new Response("not found", { status: 404 });
  },
};

