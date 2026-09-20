# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修复师、修补批次与统计。

## 启动

```bash
PORT=3020 node server.js
```

## 主要接口

- `GET /health`
- `GET /rubbings`
- `POST /rubbings`
- `GET /rubbings/:id/damages`
- `POST /rubbings/:id/damages`
- `GET /damages?status=&type=`
- `PATCH /damages/:id`
- `GET /repairers` — 修复师列表（含当前在修数与剩余额度）
- `POST /repairers` — 登记修复师：`{name, qualifiedTypes:[缺损类型...], dailyCapacity:每日在修上限}`
- `PATCH /repairers/:id` — 调整承修资格类型或每日上限
- `GET /batches`
- `POST /batches` — 建批并按损类逐项指派（见下）
- `GET /batches/:id`
- `POST /batches/:id/complete` — 完工结项
- `POST /batches/:id/rework` — 确认返工
- `POST /batches/:id/review` — 质量观察复核
- `GET /stats` — 统计（每次变更后写回 `db.json` 的 `stats` 字段）

## 承修资格与建批指派

建批时按损类逐项指派修复师：

```bash
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"九月小批修补","assignments":[
    {"damageId":"damage_demo_1","repairerId":"repairer_demo"},
    {"damageId":"damage_demo_2","repairerId":"repairer_demo"}
  ]}'
```

逐项校验：缺损须存在且为待修（`pending`）、修复师须具备该缺损类型的承修资格、
修复师当日前在修数 + 新指派数不得超过其 `dailyCapacity`。
任一不满足则**整批退回**（400，附逐条原因），不建批、不改任何缺损归属。

## 返工追溯

批次状态机：`open → completed → observation → closed`。

1. 完工结项后若确认返工：`POST /batches/:id/rework`，`{"damageIds":[...], "reason":"..."}`。
   - 原修复记录（照片、修复说明、修复师、完工时间）归档进缺损的 `repairHistory`，只读保留、只增不改；
   - 相关缺损回到 `pending`，清空批次与修复师归属，等待重新建批；
   - 原批次进入 `observation`（质量观察），**不得再次结项**。
2. 返工缺损重新建批、完工后，对原观察批次复核：`POST /batches/:id/review`，`{"result":"pass|fail"}`。
   - 新一版未全部完成时复核会被拒绝（409）；
   - `pass`：解除观察，批次转为 `closed`；
   - `fail`：相关缺损再次归档并回到 `pending`，批次保持观察，等待下一轮。

## 闭环示例

```bash
curl http://127.0.0.1:3020/repairers
curl http://127.0.0.1:3020/damages?status=pending
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"九月小批修补","assignments":[{"damageId":"damage_demo_1","repairerId":"repairer_demo"}]}'
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete \
  -H 'Content-Type: application/json' \
  -d '{"results":[{"damageId":"damage_demo_1","afterPhotoUrl":"...","repairNote":"..."}]}'
curl http://127.0.0.1:3020/stats
```
