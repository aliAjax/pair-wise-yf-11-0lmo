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
      repairerId: null,
      assignedAt: null,
      repairHistory: [],
      reworkCount: 0,
      createdAt: new Date().toISOString(),
      repairedAt: null
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
      repairerId: null,
      assignedAt: null,
      repairHistory: [],
      reworkCount: 0,
      createdAt: new Date().toISOString(),
      repairedAt: null
    }
  ],
  repairers: [
    {
      id: "repairer_demo",
      name: "王师傅",
      qualifiedTypes: ["虫蛀孔", "撕裂"],
      dailyCapacity: 5,
      note: "资深修复师",
      createdAt: new Date().toISOString()
    }
  ],
  batches: [],
  stats: null
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
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete",
  "POST /batches/:id/rework",
  "POST /batches/:id/review",
  "GET /stats"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

function countBy(list, key) {
  return list.reduce((acc, item) => {
    const value = item[key];
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function repairerLoad(db, repairerId) {
  return db.damages.filter((item) => item.repairerId === repairerId && item.status === "in_repair").length;
}

function computeStats(db) {
  const damageStatus = countBy(db.damages, "status");
  const batchStatus = countBy(db.batches, "status");
  return {
    updatedAt: new Date().toISOString(),
    damages: {
      total: db.damages.length,
      pending: damageStatus.pending || 0,
      inRepair: damageStatus.in_repair || 0,
      repaired: damageStatus.repaired || 0,
      reworked: db.damages.filter((item) => item.reworkCount > 0).length
    },
    batches: {
      total: db.batches.length,
      open: batchStatus.open || 0,
      completed: batchStatus.completed || 0,
      observation: batchStatus.observation || 0,
      closed: batchStatus.closed || 0
    },
    reworks: {
      totalReworks: db.damages.reduce((sum, item) => sum + item.reworkCount, 0),
      archivedRecords: db.damages.reduce((sum, item) => sum + item.repairHistory.length, 0)
    },
    repairers: db.repairers.map((repairer) => ({
      repairerId: repairer.id,
      name: repairer.name,
      dailyCapacity: repairer.dailyCapacity,
      inRepair: repairerLoad(db, repairer.id),
      repaired: db.damages.filter((item) => item.repairerId === repairer.id && item.status === "repaired").length
    }))
  };
}

function normalizeDb(db) {
  db.rubbings = db.rubbings || [];
  db.damages = db.damages || [];
  db.repairers = db.repairers || [];
  db.batches = db.batches || [];
  db.damages.forEach((damage) => {
    if (damage.repairerId === undefined) damage.repairerId = null;
    if (damage.assignedAt === undefined) damage.assignedAt = null;
    if (!Array.isArray(damage.repairHistory)) damage.repairHistory = [];
    if (typeof damage.reworkCount !== "number") damage.reworkCount = 0;
  });
  db.batches.forEach((batch) => {
    if (!Array.isArray(batch.assignments)) batch.assignments = [];
    if (batch.observation === undefined) batch.observation = null;
  });
  db.stats = computeStats(db);
  return db;
}

async function readDb() {
  await ensureDb();
  return normalizeDb(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

async function persist(db) {
  db.stats = computeStats(db);
  await writeDb(db);
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

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  const assignments = (batch.assignments || []).map((assignment) => {
    const repairer = db.repairers.find((item) => item.id === assignment.repairerId);
    return { ...assignment, repairerName: repairer ? repairer.name : null };
  });
  return {
    ...batch,
    assignments,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

// 建批前逐项校验指派：存在性、待修状态、承修资格、每日在修上限。
// 任一问题都导致整批退回，调用方保证校验通过前不改动任何数据。
function validateAssignments(db, assignments) {
  const problems = [];
  const seen = new Set();
  const newLoadByRepairer = new Map();
  for (const assignment of assignments) {
    const damage = db.damages.find((item) => item.id === assignment.damageId);
    if (!damage) {
      problems.push(`缺损项不存在：${assignment.damageId}`);
      continue;
    }
    if (seen.has(damage.id)) {
      problems.push(`缺损项重复指派：${damage.id}`);
      continue;
    }
    seen.add(damage.id);
    if (damage.status !== "pending") {
      problems.push(`缺损项「${damage.position}」当前状态为 ${damage.status}，不在待修状态`);
      continue;
    }
    const repairer = db.repairers.find((item) => item.id === assignment.repairerId);
    if (!repairer) {
      problems.push(`修复师不存在：${assignment.repairerId}`);
      continue;
    }
    if (!repairer.qualifiedTypes.includes(damage.type)) {
      problems.push(`修复师「${repairer.name}」不具备缺损类型「${damage.type}」的承修资格（缺损：${damage.position}）`);
      continue;
    }
    newLoadByRepairer.set(repairer.id, (newLoadByRepairer.get(repairer.id) || 0) + 1);
  }
  for (const [repairerId, newCount] of newLoadByRepairer) {
    const repairer = db.repairers.find((item) => item.id === repairerId);
    const currentLoad = repairerLoad(db, repairerId);
    if (currentLoad + newCount > repairer.dailyCapacity) {
      problems.push(
        `修复师「${repairer.name}」同日在修超限：当前在修 ${currentLoad} 项 + 新指派 ${newCount} 项 > 每日上限 ${repairer.dailyCapacity} 项`
      );
    }
  }
  return problems;
}

// 返工时把当前修复记录归档到 repairHistory（只读保留，只增不改），
// 缺损回到待修并清空归属，等待重新指派。
function archiveRepairAndReset(damage, now, reason) {
  damage.repairHistory.push({
    round: damage.repairHistory.length + 1,
    batchId: damage.batchId,
    repairerId: damage.repairerId,
    afterPhotoUrl: damage.afterPhotoUrl,
    repairNote: damage.repairNote,
    repairedAt: damage.repairedAt,
    archivedAt: now,
    archiveReason: reason
  });
  damage.status = "pending";
  damage.afterPhotoUrl = "";
  damage.repairNote = "";
  damage.repairedAt = null;
  damage.batchId = null;
  damage.repairerId = null;
  damage.assignedAt = null;
  damage.reworkCount += 1;
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
    await persist(db);
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
      repairerId: null,
      assignedAt: null,
      repairHistory: [],
      reworkCount: 0,
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await persist(db);
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
    await persist(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/repairers") {
    const data = db.repairers.map((repairer) => {
      const inRepair = repairerLoad(db, repairer.id);
      return { ...repairer, inRepair, remainingCapacity: repairer.dailyCapacity - inRepair };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/repairers") {
    const body = await parseBody(req);
    required(body, ["name", "qualifiedTypes", "dailyCapacity"]);
    if (!Array.isArray(body.qualifiedTypes) || body.qualifiedTypes.length === 0) {
      return send(res, 400, { error: "qualifiedTypes必须是非空数组" });
    }
    const dailyCapacity = Number(body.dailyCapacity);
    if (!Number.isInteger(dailyCapacity) || dailyCapacity < 1) {
      return send(res, 400, { error: "dailyCapacity必须是正整数" });
    }
    const repairer = {
      id: makeId("repairer"),
      name: body.name,
      qualifiedTypes: body.qualifiedTypes,
      dailyCapacity,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.repairers.push(repairer);
    await persist(db);
    return send(res, 201, { data: repairer });
  }

  const repairerMatch = pathname.match(/^\/repairers\/([^/]+)$/);
  if (repairerMatch && req.method === "PATCH") {
    const repairer = db.repairers.find((item) => item.id === repairerMatch[1]);
    if (!repairer) return send(res, 404, { error: "修复师不存在" });
    const body = await parseBody(req);
    if (body.qualifiedTypes !== undefined) {
      if (!Array.isArray(body.qualifiedTypes) || body.qualifiedTypes.length === 0) {
        return send(res, 400, { error: "qualifiedTypes必须是非空数组" });
      }
      repairer.qualifiedTypes = body.qualifiedTypes;
    }
    if (body.dailyCapacity !== undefined) {
      const dailyCapacity = Number(body.dailyCapacity);
      if (!Number.isInteger(dailyCapacity) || dailyCapacity < 1) {
        return send(res, 400, { error: "dailyCapacity必须是正整数" });
      }
      repairer.dailyCapacity = dailyCapacity;
    }
    repairer.name = body.name ?? repairer.name;
    repairer.note = body.note ?? repairer.note;
    await persist(db);
    return send(res, 200, { data: repairer });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "assignments"]);
    if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
      return send(res, 400, { error: "assignments必须是非空数组" });
    }
    const malformed = body.assignments.some((item) => !item || !item.damageId || !item.repairerId);
    if (malformed) return send(res, 400, { error: "每项指派必须包含damageId和repairerId" });
    const problems = validateAssignments(db, body.assignments);
    if (problems.length) {
      // 整批退回：不建批、不改缺损归属，一切保持原样
      return send(res, 400, { error: "整批退回：存在资格不符或同日在修超限的指派", reasons: problems });
    }
    const now = new Date().toISOString();
    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      damageIds: body.assignments.map((item) => item.damageId),
      assignments: body.assignments.map((item) => ({ damageId: item.damageId, repairerId: item.repairerId, assignedAt: now })),
      note: body.note || "",
      observation: null,
      createdAt: now,
      completedAt: null
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      const assignment = batch.assignments.find((item) => item.damageId === damage.id);
      if (assignment) {
        damage.batchId = batch.id;
        damage.repairerId = assignment.repairerId;
        damage.assignedAt = now;
        damage.status = "in_repair";
      }
    });
    await persist(db);
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
    if (batch.status === "observation") {
      return send(res, 409, { error: "批次处于质量观察中，不得再次结项" });
    }
    if (batch.status !== "open") {
      return send(res, 409, { error: `批次当前状态为 ${batch.status}，不能结项` });
    }
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    batch.status = "completed";
    batch.completedAt = new Date().toISOString();
    batch.note = body.note ?? batch.note;
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = new Date().toISOString();
    });
    await persist(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const reworkMatch = pathname.match(/^\/batches\/([^/]+)\/rework$/);
  if (reworkMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === reworkMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    if (batch.status !== "completed") {
      return send(res, 409, { error: `只有已完工批次才能确认返工（当前状态：${batch.status}）` });
    }
    const body = await parseBody(req);
    required(body, ["damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
      return send(res, 400, { error: "damageIds必须是非空数组" });
    }
    const targets = [];
    const problems = [];
    for (const damageId of body.damageIds) {
      if (!batch.damageIds.includes(damageId)) {
        problems.push(`缺损项不属于本批次：${damageId}`);
        continue;
      }
      const damage = db.damages.find((item) => item.id === damageId);
      if (!damage) {
        problems.push(`缺损项不存在：${damageId}`);
        continue;
      }
      if (damage.status !== "repaired") {
        problems.push(`缺损项「${damage.position}」尚未修复，无需返工`);
        continue;
      }
      targets.push(damage);
    }
    if (problems.length) return send(res, 400, { error: "返工确认失败", reasons: problems });
    const now = new Date().toISOString();
    targets.forEach((damage) => archiveRepairAndReset(damage, now, body.reason || "确认返工"));
    batch.status = "observation";
    batch.observation = {
      since: now,
      reason: body.reason || "",
      damageIds: targets.map((damage) => damage.id),
      reviews: [],
      result: null,
      liftedAt: null
    };
    await persist(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const reviewMatch = pathname.match(/^\/batches\/([^/]+)\/review$/);
  if (reviewMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === reviewMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    if (batch.status !== "observation" || !batch.observation) {
      return send(res, 409, { error: "批次不在质量观察中，无需复核" });
    }
    const body = await parseBody(req);
    required(body, ["result"]);
    if (!["pass", "fail"].includes(body.result)) {
      return send(res, 400, { error: "result必须是pass或fail" });
    }
    const observation = batch.observation;
    const unfinished = observation.damageIds.filter((damageId) => {
      const damage = db.damages.find((item) => item.id === damageId);
      return !damage || damage.status !== "repaired" || !damage.repairedAt || damage.repairedAt <= observation.since;
    });
    if (unfinished.length) {
      return send(res, 409, { error: "新一版修复尚未全部完成，不能复核", pendingDamageIds: unfinished });
    }
    const now = new Date().toISOString();
    observation.reviews.push({ result: body.result, note: body.note || "", at: now });
    if (body.result === "pass") {
      // 新一版完成且复核通过，解除质量观察
      batch.status = "closed";
      observation.result = "pass";
      observation.liftedAt = now;
    } else {
      // 复核未通过：相关缺损再次回到待修，批次继续保持质量观察
      observation.damageIds.forEach((damageId) => {
        const damage = db.damages.find((item) => item.id === damageId);
        if (damage && damage.status === "repaired") archiveRepairAndReset(damage, now, "复核未通过");
      });
    }
    await persist(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  if (req.method === "GET" && pathname === "/stats") {
    return send(res, 200, { data: db.stats });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
