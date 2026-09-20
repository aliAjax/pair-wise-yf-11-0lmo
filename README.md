# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修复师、修补批次与只读修复记录。

## 启动

```bash
PORT=3020 node server.js
```

## 主要接口

拓片与缺损：

- `GET /health`
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages` / `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`

修复师（承修资格与每日在修上限）：

- `GET /repairers` — 含 `todayAssigned`（当日在修占用）、`todayRemaining`
- `POST /repairers` — 登记：`name`、`qualifiedTypes`（可承接缺损类型）、`dailyLimit`
- `PATCH /repairers/:id` — 调整资格损类或每日上限

批次：

- `GET /batches?status=` — 状态：`open` / `completed` / `observation` / `closed`
- `POST /batches` — 按缺损逐项指派，见下
- `GET /batches/:id`
- `POST /batches/:id/complete` — 完工结项（观察期批次禁止）
- `POST /batches/:id/review` — 复核 `{passed: true|false, note}`
- `POST /batches/:id/rework` — 完工批次确认返工

追溯与统计：

- `GET /repair-records?batchId=&damageId=&repairerId` — 修复记录只读
- `GET /stats` — 人员当日占用/上限、批次与缺损状态统计（每次写库同时回写 `db.json.stats`）

## 建批指派与整批退回

`POST /batches` 请求体：

```json
{
  "name": "六月小批修补",
  "assignments": [
    { "damageId": "damage_demo_1", "repairerId": "repairer_demo_wang" },
    { "damageId": "damage_demo_2", "repairerId": "repairer_demo_chen" }
  ],
  "reworkOf": "可选：观察期批次ID，用于建立返工新版本"
}
```

校验任一不过即 **整批退回**（HTTP 400，`code: BATCH_REJECTED`，批次不创建、缺损归属原样不动），`details` 列出全部原因：

1. 指派项需含 `damageId` / `repairerId`，缺损不得重复；
2. 缺损必须存在且为 `pending`；修复师必须存在；
3. **承修资格**：修复师的 `qualifiedTypes` 必须包含该缺损的 `type`；
4. **每日在修上限**：当日（UTC）该修复师名下在修批次指派数 + 本批指派数不得超过 `dailyLimit`；
5. 返工新版本（`reworkOf`）只能承接质量观察批次内的缺损。

校验通过后缺损置 `in_repair` 并归属新批次。

## 返工追溯闭环

1. `POST /batches/:id/complete`：批次完工，缺损置 `repaired`，同时生成带 `locked: true` 的修复记录快照（修复师、损类、位置、完工照片、修复说明）。
2. `POST /batches/:id/rework`，`{confirmed: true, reason, damageIds?}`：
   - 原修复记录**只读保留**（不修改、不删除，可在 `/repair-records` 查询）；
   - 相关缺损回到 `pending`（清空完工照片/说明/结项时间、解除批次归属，`repairCount` 保留累计次数）；
   - 原批次进入 `observation` 质量观察，此后 `complete` 一律 409，**不得再次结项**。
3. 以 `POST /batches` 携带 `reworkOf` 建立新一版批次（逐项重新指派，同样过资格/上限校验），完工后 `POST /batches/:id/review` 复核：
   - `passed: true`：新版本结案，**原批次同步解除观察并结案**（`observationClearedAt`）；
   - `passed: false`：新版本保持完工待核，可再次返工。

## 闭环示例

```bash
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"六月小批修补","assignments":[{"damageId":"damage_demo_1","repairerId":"repairer_demo_wang"},{"damageId":"damage_demo_2","repairerId":"repairer_demo_chen"}]}'

curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete \
  -H 'Content-Type: application/json' \
  -d '{"defaultAfterPhotoUrl":"https://example.local/after.jpg","defaultRepairNote":"托裱补缀"}'

curl -X POST http://127.0.0.1:3020/batches/<batchId>/rework \
  -H 'Content-Type: application/json' -d '{"confirmed":true,"reason":"补缀处起翘"}'
```
