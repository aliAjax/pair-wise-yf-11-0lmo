const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3020);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: new Date().toISOString()
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null,
      repairCount: 0
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null,
      repairCount: 0
    }
  ],
  repairers: [
    {
      id: "repairer_demo_wang",
      name: "王素贞",
      qualifiedTypes: ["虫蛀孔", "撕裂", "霉斑", "残缺"],
      dailyLimit: 5,
      createdAt: "2026-06-16T00:00:00.000Z"
    },
    {
      id: "repairer_demo_chen",
      name: "陈墨",
      qualifiedTypes: ["撕裂"],
      dailyLimit: 1,
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  batches: [],
  repairRecords: []
};

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /repairers",
  "POST /repairers",
  "PATCH /repairers/:id",
  "GET /repair-records?batchId=&damageId=&repairerId=",
  "GET /batches?status=",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete",
  "POST /batches/:id/rework",
  "POST /batches/:id/review",
  "GET /stats"
];

const BATCH_STATUS = {
  OPEN: "open", // 在修
  COMPLETED: "completed", // 已完工待核
  OBSERVATION: "observation", // 质量观察（返工）
  CLOSED: "closed" // 结案归档（复核通过 / 观察解除）
};

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(withStats(initialData), null, 2));
  }
}

function dayOf(iso) {
  return String(iso || "").slice(0, 10);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function findRepairer(db, repairerId) {
  return db.repairers.find((item) => item.id === repairerId);
}

// 统计：修复师当日在修占用 / 当日完工 / 累计完工，缺损与批次状态分布
function buildStats(db) {
  const today = todayKey();
  const repairerStats = db.repairers.map((repairer) => {
    let todayAssigned = 0;
    let completedToday = 0;
    let repairedTotal = 0;
    db.batches.forEach((batch) => {
      if (batch.status === BATCH_STATUS.OPEN && dayOf(batch.createdAt) === today) {
        (batch.assignments || []).forEach((assignment) => {
          if (assignment.repairerId === repairer.id) todayAssigned += 1;
        });
      }
    });
    db.repairRecords.forEach((record) => {
      record.items.forEach((item) => {
        if (item.repairerId !== repairer.id) return;
        repairedTotal += 1;
        if (dayOf(record.repairedAt) === today) completedToday += 1;
      });
    });
    return {
      id: repairer.id,
      name: repairer.name,
      qualifiedTypes: repairer.qualifiedTypes,
      dailyLimit: repairer.dailyLimit,
      todayAssigned,
      todayRemaining: Math.max(0, repairer.dailyLimit - todayAssigned),
      completedToday,
      repairedTotal
    };
  });

  const damageStats = { total: db.damages.length, pending: 0, in_repair: 0, repaired: 0 };
  db.damages.forEach((damage) => {
    damageStats[damage.status] = (damageStats[damage.status] || 0) + 1;
  });

  const batchStats = { total: db.batches.length, open: 0, completed: 0, observation: 0, closed: 0 };
  db.batches.forEach((batch) => {
    batchStats[batch.status] = (batchStats[batch.status] || 0) + 1;
  });

  return {
    generatedAt: new Date().toISOString(),
    date: today,
    damages: damageStats,
    batches: batchStats,
    repairers: repairerStats
  };
}

function withStats(db) {
  db.stats = buildStats(db);
  return db;
}

// 兼容旧数据文件：补齐新集合与新字段，结构变化时落盘
function normalizeDb(db) {
  let changed = false;
  if (!Array.isArray(db.repairers)) {
    db.repairers = initialData.repairers;
    changed = true;
  }
  if (!Array.isArray(db.repairRecords)) {
    db.repairRecords = [];
    changed = true;
  }
  db.damages.forEach((damage) => {
    if (damage.repairCount === undefined) {
      damage.repairCount = 0;
      changed = true;
    }
  });
  db.batches.forEach((batch) => {
    if (!Array.isArray(batch.assignments)) {
      batch.assignments = batch.damageIds.map((damageId) => ({ damageId, repairerId: null, type: null }));
      changed = true;
    }
    [
      ["observedAt", null],
      ["observationReason", ""],
      ["reworkOf", null],
      ["reworkBatchId", null],
      ["reviewedAt", null],
      ["reviewNote", ""],
      ["observationClearedAt", null],
      ["version", 1],
      ["lastReview", null]
    ].forEach(([key, fallback]) => {
      if (batch[key] === undefined) {
        batch[key] = fallback;
        changed = true;
      }
    });
  });
  return changed;
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (normalizeDb(db)) await writeDb(db);
  else db.stats = buildStats(db);
  return db;
}

async function writeDb(db) {
  db.stats = buildStats(db);
  await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

function validateRepairerPayload(body, partial = false) {
  if (!partial || body.qualifiedTypes !== undefined) {
    if (!Array.isArray(body.qualifiedTypes) || body.qualifiedTypes.length === 0) {
      const error = new Error("qualifiedTypes必须是非空数组");
      error.status = 400;
      throw error;
    }
    if (!body.qualifiedTypes.every((type) => typeof type === "string" && type.trim())) {
      const error = new Error("qualifiedTypes必须是非空字符串数组");
      error.status = 400;
      throw error;
    }
  }
  if (!partial || body.dailyLimit !== undefined) {
    if (!Number.isInteger(body.dailyLimit) || body.dailyLimit <= 0) {
      const error = new Error("dailyLimit必须是正整数");
      error.status = 400;
      throw error;
    }
  }
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  const assignments = (batch.assignments || []).map((assignment) => ({
    ...assignment,
    repairerName: (findRepairer(db, assignment.repairerId) || {}).name || null
  }));
  const repairerIds = [...new Set(assignments.map((item) => item.repairerId).filter(Boolean))];
  const parentBatch = batch.reworkOf ? db.batches.find((item) => item.id === batch.reworkOf) : null;
  return {
    ...batch,
    assignments,
    repairers: repairerIds.map((id) => {
      const repairer = findRepairer(db, id);
      return { id: repairer.id, name: repairer.name };
    }),
    reworkOfBatch: parentBatch
      ? { id: parentBatch.id, name: parentBatch.name, status: parentBatch.status }
      : null,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null,
      repairCount: 0
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const body = await parseBody(req);
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      status: body.status ?? damage.status,
      repairNote: body.repairNote ?? damage.repairNote
    });
    damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  // 修复师登记与资格维护
  if (req.method === "GET" && pathname === "/repairers") {
    const today = todayKey();
    const data = db.repairers.map((repairer) => {
      let todayAssigned = 0;
      db.batches.forEach((batch) => {
        if (batch.status === BATCH_STATUS.OPEN && dayOf(batch.createdAt) === today) {
          (batch.assignments || []).forEach((assignment) => {
            if (assignment.repairerId === repairer.id) todayAssigned += 1;
          });
        }
      });
      return { ...repairer, todayAssigned, todayRemaining: Math.max(0, repairer.dailyLimit - todayAssigned) };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/repairers") {
    const body = await parseBody(req);
    required(body, ["name", "qualifiedTypes", "dailyLimit"]);
    validateRepairerPayload(body);
    const repairer = {
      id: makeId("repairer"),
      name: body.name,
      qualifiedTypes: body.qualifiedTypes.map((type) => type.trim()),
      dailyLimit: body.dailyLimit,
      createdAt: new Date().toISOString()
    };
    db.repairers.push(repairer);
    await writeDb(db);
    return send(res, 201, { data: repairer });
  }

  const repairerPatchMatch = pathname.match(/^\/repairers\/([^/]+)$/);
  if (repairerPatchMatch && req.method === "PATCH") {
    const repairer = db.repairers.find((item) => item.id === repairerPatchMatch[1]);
    if (!repairer) return send(res, 404, { error: "修复师不存在" });
    const body = await parseBody(req);
    validateRepairerPayload(body, true);
    repairer.name = body.name ?? repairer.name;
    if (body.qualifiedTypes !== undefined) repairer.qualifiedTypes = body.qualifiedTypes.map((type) => type.trim());
    if (body.dailyLimit !== undefined) repairer.dailyLimit = body.dailyLimit;
    await writeDb(db);
    return send(res, 200, { data: repairer });
  }

  // 只读修复记录（含返工被冻结的历史版本）
  if (req.method === "GET" && pathname === "/repair-records") {
    const batchId = url.searchParams.get("batchId");
    const damageId = url.searchParams.get("damageId");
    const repairerId = url.searchParams.get("repairerId");
    const data = db.repairRecords
      .filter((record) => !batchId || record.batchId === batchId)
      .filter((record) => !repairerId || record.items.some((item) => item.repairerId === repairerId))
      .filter((record) => !damageId || record.items.some((item) => item.damageId === damageId));
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/batches") {
    const status = url.searchParams.get("status");
    const data = db.batches
      .filter((batch) => !status || batch.status === status)
      .map((batch) => enrichBatch(db, batch));
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "assignments"]);
    if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
      return send(res, 400, { error: "assignments必须是非空数组，需按缺损逐项指派修复师" });
    }

    const damageIds = [];
    const details = [];

    // —— 第一步：结构与存在性校验 ——
    body.assignments.forEach((assignment, index) => {
      if (!assignment || typeof assignment.damageId !== "string" || typeof assignment.repairerId !== "string") {
        details.push({ index, reason: "指派项必须包含damageId与repairerId" });
        return;
      }
      if (damageIds.includes(assignment.damageId)) {
        details.push({ damageId: assignment.damageId, reason: "同一缺损在批次内被重复指派" });
        return;
      }
      damageIds.push(assignment.damageId);
      const damage = db.damages.find((item) => item.id === assignment.damageId);
      if (!damage) {
        details.push({ damageId: assignment.damageId, reason: "缺损项不存在" });
        return;
      }
      if (damage.status !== "pending") {
        details.push({ damageId: assignment.damageId, reason: `缺损当前状态为${damage.status}，仅待修缺损可建批` });
      }
      const repairer = findRepairer(db, assignment.repairerId);
      if (!repairer) {
        details.push({ damageId: assignment.damageId, repairerId: assignment.repairerId, reason: "修复师不存在" });
      }
    });

    // —— 第二步：承修资格校验（按损类逐项） ——
    body.assignments.forEach((assignment) => {
      const damage = db.damages.find((item) => item.id === assignment?.damageId);
      const repairer = findRepairer(db, assignment?.repairerId);
      if (!damage || !repairer) return;
      if (!repairer.qualifiedTypes.includes(damage.type)) {
        details.push({
          damageId: damage.id,
          repairerId: repairer.id,
          reason: `修复师${repairer.name}无「${damage.type}」承修资格（可承接：${repairer.qualifiedTypes.join("、") || "无"}）`
        });
      }
    });

    // —— 第三步：同日在修上限校验（含本批新增占用） ——
    const today = todayKey();
    const load = new Map();
    db.batches.forEach((batch) => {
      if (batch.status !== BATCH_STATUS.OPEN || dayOf(batch.createdAt) !== today) return;
      (batch.assignments || []).forEach((assignment) => {
        load.set(assignment.repairerId, (load.get(assignment.repairerId) || 0) + 1);
      });
    });
    body.assignments.forEach((assignment) => {
      const repairer = findRepairer(db, assignment?.repairerId);
      if (!repairer) return;
      const used = (load.get(repairer.id) || 0) + 1;
      load.set(repairer.id, used);
      if (used > repairer.dailyLimit) {
        details.push({
          damageId: assignment.damageId,
          repairerId: repairer.id,
          reason: `超出每日在修上限：修复师${repairer.name}当日已排${used}项，上限${repairer.dailyLimit}项`
        });
      }
    });

    // —— 第四步：返工新版本归属校验 ——
    let parentBatch = null;
    if (body.reworkOf !== undefined && body.reworkOf !== null) {
      parentBatch = db.batches.find((item) => item.id === body.reworkOf);
      if (!parentBatch) {
        details.push({ reason: `返工源批次不存在：${body.reworkOf}` });
      } else if (parentBatch.status !== BATCH_STATUS.OBSERVATION) {
        details.push({ reason: `返工源批次${parentBatch.id}当前状态为${parentBatch.status}，仅质量观察批次可派生新版本` });
      } else {
        const outside = damageIds.filter((id) => !parentBatch.damageIds.includes(id));
        if (outside.length) {
          details.push({ reason: `新版本只能承接观察批次内的缺损，越界缺损：${outside.join(", ")}` });
        }
      }
    }

    // 任一校验不过：整批退回，不写库，批次不建、缺损归属保持原样
    if (details.length) {
      return send(res, 400, { error: "整批退回：承修资格或在修上限校验未通过", code: "BATCH_REJECTED", details });
    }

    const assignments = body.assignments.map((assignment) => {
      const damage = db.damages.find((item) => item.id === assignment.damageId);
      return { damageId: assignment.damageId, repairerId: assignment.repairerId, type: damage.type };
    });

    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: BATCH_STATUS.OPEN,
      damageIds,
      assignments,
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null,
      observedAt: null,
      observationReason: "",
      reworkOf: parentBatch ? parentBatch.id : null,
      reworkBatchId: null,
      reviewedAt: null,
      reviewNote: "",
      observationClearedAt: null,
      version: parentBatch ? (parentBatch.version || 1) + 1 : 1,
      lastReview: null
    };
    db.batches.push(batch);
    if (parentBatch) parentBatch.reworkBatchId = batch.id;
    db.damages.forEach((damage) => {
      if (damageIds.includes(damage.id)) {
        damage.batchId = batch.id;
        damage.status = "in_repair";
      }
    });
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === completeMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    if (batch.status === BATCH_STATUS.OBSERVATION) {
      return send(res, 409, { error: "该批次处于质量观察期，不得再次结项；请就退回待修的缺损建立新版本批次" });
    }
    if (batch.status !== BATCH_STATUS.OPEN) {
      return send(res, 409, { error: `批次当前状态为${batch.status}，仅在修批次可结项` });
    }
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    const now = new Date().toISOString();

    batch.status = BATCH_STATUS.COMPLETED;
    batch.completedAt = now;
    batch.note = body.note ?? batch.note;

    const recordItems = [];
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const assignment = (batch.assignments || []).find((item) => item.damageId === damage.id) || {};
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = now;
      damage.repairCount = (damage.repairCount || 0) + 1;
      // 快照入档：修复记录一经生成即只读，返工也不会改动或删除
      recordItems.push({
        damageId: damage.id,
        repairerId: assignment.repairerId || null,
        type: damage.type,
        position: damage.position,
        afterPhotoUrl: damage.afterPhotoUrl,
        repairNote: damage.repairNote
      });
    });

    db.repairRecords.push({
      id: makeId("record"),
      batchId: batch.id,
      batchName: batch.name,
      version: batch.version || 1,
      repairedAt: now,
      locked: true,
      items: recordItems
    });

    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const reworkMatch = pathname.match(/^\/batches\/([^/]+)\/rework$/);
  if (reworkMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === reworkMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    if (batch.status === BATCH_STATUS.OBSERVATION) {
      return send(res, 409, { error: "批次已在质量观察期，请勿重复确认返工" });
    }
    if (batch.status !== BATCH_STATUS.COMPLETED) {
      return send(res, 409, { error: `批次当前状态为${batch.status}，仅已完工批次可确认返工` });
    }
    const body = await parseBody(req);
    if (body.confirmed !== true) {
      return send(res, 400, { error: "确认返工需传 confirmed:true" });
    }

    const targetIds = Array.isArray(body.damageIds) && body.damageIds.length ? body.damageIds : batch.damageIds;
    const invalid = targetIds.filter((id) => !batch.damageIds.includes(id));
    if (invalid.length) return send(res, 400, { error: `以下缺损不属于该批次：${invalid.join(", ")}` });
    const notRepaired = targetIds.filter((id) => {
      const damage = db.damages.find((item) => item.id === id);
      return !damage || damage.status !== "repaired" || damage.batchId !== batch.id;
    });
    if (notRepaired.length) {
      return send(res, 409, { error: `以下缺损不是本批次完工状态，不能返工：${notRepaired.join(", ")}` });
    }

    const now = new Date().toISOString();
    batch.status = BATCH_STATUS.OBSERVATION;
    batch.observedAt = now;
    batch.observationReason = body.reason || "";

    // 相关缺损回到待修；原修复记录保持只读不动，历史在 repairRecords 中可溯
    db.damages.forEach((damage) => {
      if (!targetIds.includes(damage.id)) return;
      damage.status = "pending";
      damage.batchId = null;
      damage.afterPhotoUrl = "";
      damage.repairNote = "";
      damage.repairedAt = null;
    });

    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const reviewMatch = pathname.match(/^\/batches\/([^/]+)\/review$/);
  if (reviewMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === reviewMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    if (batch.status !== BATCH_STATUS.COMPLETED) {
      return send(res, 409, { error: `批次当前状态为${batch.status}，仅已完工待核批次可复核` });
    }
    const body = await parseBody(req);
    if (typeof body.passed !== "boolean") return send(res, 400, { error: "复核需传 passed 布尔值" });

    const now = new Date().toISOString();
    batch.lastReview = { passed: body.passed, note: body.note || "", reviewedAt: now };

    if (!body.passed) {
      await writeDb(db);
      return send(res, 200, { data: enrichBatch(db, batch), warning: "复核未通过，批次保持完工待核；如确认返工请调用 /rework" });
    }

    // 复核通过：新版本结案，同时解除原批次质量观察
    batch.status = BATCH_STATUS.CLOSED;
    batch.reviewedAt = now;
    batch.reviewNote = body.note || "";
    let parentBatch = null;
    if (batch.reworkOf) {
      parentBatch = db.batches.find((item) => item.id === batch.reworkOf);
      if (parentBatch && parentBatch.status === BATCH_STATUS.OBSERVATION) {
        parentBatch.status = BATCH_STATUS.CLOSED;
        parentBatch.observationClearedAt = now;
        parentBatch.reviewNote = body.note || parentBatch.reviewNote;
      }
    }

    await writeDb(db);
    return send(res, 200, {
      data: enrichBatch(db, batch),
      observationReleased: parentBatch ? enrichBatch(db, parentBatch) : null
    });
  }

  if (req.method === "GET" && pathname === "/stats") {
    return send(res, 200, { data: buildStats(db) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
