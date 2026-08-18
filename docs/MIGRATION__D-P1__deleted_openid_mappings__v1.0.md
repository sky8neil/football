# D-P1 方案 B：`deleted_openid_mappings` 数据迁移（M1–M5 + 回滚）

> 依据：`/tmp/football-reverse-review/FIX_PLAN__C-P1_D-P0_D-P1__v1.1.md` §6.10。
> 可执行实现：`src/infrastructure/deleted-openid-mapping-migration.ts`
> （`migrateDeletedOpenidMappings` = M3 前向迁移；`rollbackDeletedOpenidMappings` = down-migration），
> 测试：`src/infrastructure/deleted-openid-mapping-migration.test.ts`。
> 本迁移只处理 D-P1 范围，不修改结算/状态机/幂等门闩。

## 场景

历史数据可能存在两类 deleted 用户：

| 类型 | 形态 | 可迁移性 |
|---|---|---|
| A | `status=deleted` 且 `openid = "deleted:" + user_id`（已墓碑，丢失原 openid） | **无法重建 mapping** → 跳过并记录审计（SPEC_GAP） |
| B | `status=deleted` 且 `openid` 仍为微信 openid（旧错误/测试形态） | 可迁移：写 mapping + 墓碑 + 清 PII |

## M1. 只读代码版本（可选，推荐）

先部署只读版本（resolver 只读 mapping，不写）并核对线上数据分布（A/B 数量），再继续。

## M2. 扩展 schema

创建集合 `deleted_openid_mappings`：

- `uk_deleted_openid`：UNIQUE(`original_openid`)
- `idx_deleted_user_id`：`deleted_user_id` 查询索引
- 字段：`original_openid` / `deleted_user_id` / `deleted_at` / `created_at` / `updated_at` / `schema_version=1`

内存库在 repository bootstrap（`createStore`）即建好对应 Map 结构；CloudBase 侧为骨架
（`src/infrastructure/cloudbase-repository.ts`，TODO(B1 接线后) 真环境验证）。

## M3. 数据迁移 job（一次性）

```text
for user in users where status=deleted:
  if user.openid startsWith "deleted:":
    # 原 openid 已不可恢复
    record audit: unmigrated_deleted_user_id=user.user_id   # SPEC_GAP
    continue
  else:
    # 脏/旧形态：openid 仍是微信身份
    upsert deleted_openid_mappings(original_openid=user.openid,
                                   deleted_user_id=user.user_id,
                                   deleted_at=user.deleted_at ?? now, ...)
    update user.openid = "deleted:" + user.user_id
    clear PII（unionid/nickname/favorite_team_id）
```

执行入口：`migrateDeletedOpenidMappings(repo, serverNow)`（事务原子，失败回滚不残留 mapping）。
返回 `{ migrated, unmigrated, unmigrated_user_ids }` 供审计。

SPEC_GAP：A 类用户无法再通过原微信 openid 识别为 deleted（表现为 unregistered）；
仍可重注册新用户，与 §4.5 重注册语义一致。

## M4. 部署应用代码

resolver + 注销写 mapping + session 重注册（本 Phase 代码）。

## M5. 回归测试 / 冒烟

- 迁移后 resolver 对原 openid 仍为 deleted（D10）。
- 无 mapping 的历史墓碑用户 → unregistered（D11）。
- 重注册 201 新 user_id；active 优先不被误判 deleted（D7）。
- 注销后再注销：mapping upsert 指向新 deleted_user_id（D9）。

## 回滚边界（down-migration）

| 阶段 | 可回滚？ | 说明 |
|---|---|---|
| 仅创建空集合 | 是 | 删除集合即可 |
| M3 已把脏 deleted 的 openid 改成墓碑并写 mapping | 代码回滚需谨慎 | 若回滚到「只靠 users.openid 认 deleted」的旧代码，必须同时逆向写回（见下） |
| 新注销已写 mapping | 同上 | 回滚应用而不回滚数据会导致 deleted 识别回归失败 |

推荐：向前修复优先；若必须回滚应用，执行 `rollbackDeletedOpenidMappings(repo, mappings, serverNow)`：

```text
for mapping in deleted_openid_mappings:
  user = users.findById(mapping.deleted_user_id)
  if user 不存在 / 非 deleted / openid 不是 "deleted:"+user_id: skip
  if users.findByOpenid(mapping.original_openid) 已存在（active 占用）: skip（禁止写回）
  else: user.openid = mapping.original_openid
```

若已有新 active 占用该 openid，**禁止**写回（会破坏 uk_openid / 新老隔离）；
保持墓碑 + mapping，接受旧代码无法识别该 deleted（已知限制）。
