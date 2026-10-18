import { nanoid } from "nanoid";
import type { Db } from "../db/db.js";
import { nowIso } from "../db/db.js";

interface AuditInput {
  actorType: "admin" | "system";
  actorUserId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  targetUserId?: string;
  changeSummary?: string;
  reason?: string;
  requestId?: string;
}

export function writeAudit(db: Db, input: AuditInput): void {
  db.prepare(`
    INSERT INTO audit_logs(id, timestamp_utc, actor_type, actor_user_id, action, entity_type, entity_id, target_user_id, change_summary, reason, request_id)
    VALUES(@id, @timestamp_utc, @actor_type, @actor_user_id, @action, @entity_type, @entity_id, @target_user_id, @change_summary, @reason, @request_id)
  `).run({
    id: nanoid(),
    timestamp_utc: nowIso(),
    actor_type: input.actorType,
    actor_user_id: input.actorUserId ?? null,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    target_user_id: input.targetUserId ?? null,
    change_summary: input.changeSummary ?? null,
    reason: input.reason ?? null,
    request_id: input.requestId ?? null
  });
}
