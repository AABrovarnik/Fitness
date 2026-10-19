import type { Db } from "../db/db.js";

export interface BookingValidationResult {
  ok: boolean;
  reason?: string;
}

type EventConflictInput = {
  startsAt: string;
  endsAt: string;
  trainerId: string | null;
  resourceName: string | null;
};

export function hasTrainerOrResourceConflict(
  db: Db,
  input: EventConflictInput,
  excludeEventId?: string
): { conflict: boolean; reason?: string } {
  if (!input.trainerId && !input.resourceName) {
    return { conflict: false };
  }

  const conflict = db.prepare(`
    SELECT id,
      CASE
        WHEN @trainerId IS NOT NULL AND trainer_id = @trainerId THEN 'trainer'
        WHEN @resourceName IS NOT NULL AND resource_name = @resourceName THEN 'resource'
        ELSE 'unknown'
      END as conflict_type
    FROM schedule_events
    WHERE status = 'active'
      AND id != COALESCE(@excludeId, '')
      AND starts_at < @endsAt
      AND ends_at > @startsAt
      AND (
        (@trainerId IS NOT NULL AND trainer_id = @trainerId)
        OR (@resourceName IS NOT NULL AND resource_name = @resourceName)
      )
    LIMIT 1
  `).get({
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    trainerId: input.trainerId,
    resourceName: input.resourceName,
    excludeId: excludeEventId ?? null
  }) as { id: string; conflict_type: "trainer" | "resource" | "unknown" } | undefined;

  if (!conflict) {
    return { conflict: false };
  }

  if (conflict.conflict_type === "trainer") {
    return { conflict: true, reason: "Конфликт по тренеру: у тренера уже есть событие в это время." };
  }
  if (conflict.conflict_type === "resource") {
    return { conflict: true, reason: "Конфликт по ресурсу: зал/ресурс уже занят в это время." };
  }

  return { conflict: true, reason: "Конфликт расписания." };
}

export function validateBooking(db: Db, clientId: string, eventId: string): BookingValidationResult {
  const event = db
    .prepare(`SELECT id, starts_at, ends_at, capacity, status, booking_enabled, trainer_id, resource_name FROM schedule_events WHERE id = ?`)
    .get(eventId) as
    | {
      id: string;
      starts_at: string;
      ends_at: string;
      capacity: number;
      status: string;
      booking_enabled: number;
      trainer_id: string | null;
      resource_name: string | null;
    }
    | undefined;

  if (!event) {
    return { ok: false, reason: "Событие не найдено." };
  }

  if (event.status !== "active" || event.booking_enabled !== 1) {
    return { ok: false, reason: "Запись на событие недоступна." };
  }

  const conflictCheck = hasTrainerOrResourceConflict(db, {
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    trainerId: event.trainer_id,
    resourceName: event.resource_name
  }, event.id);

  if (conflictCheck.conflict) {
    return { ok: false, reason: conflictCheck.reason ?? "Конфликт расписания." };
  }

  const activeMembership = db
    .prepare(`
      SELECT id FROM memberships
      WHERE client_id = ?
      AND status = 'active'
      AND starts_at <= ?
      AND ends_at >= ?
      LIMIT 1
    `)
    .get(clientId, event.starts_at, event.starts_at) as { id: string } | undefined;

  if (!activeMembership) {
    return { ok: false, reason: "Нет активного абонемента на время занятия." };
  }

  const seats = db
    .prepare(`SELECT COUNT(*) as count FROM bookings WHERE event_id = ? AND status = 'booked'`)
    .get(eventId) as { count: number };

  if (seats.count >= event.capacity) {
    return { ok: false, reason: "Свободных мест нет." };
  }

  const overlap = db
    .prepare(`
      SELECT b.id FROM bookings b
      JOIN schedule_events s ON s.id = b.event_id
      WHERE b.client_id = ?
      AND b.status = 'booked'
      AND s.starts_at < ?
      AND s.ends_at > ?
      LIMIT 1
    `)
    .get(clientId, event.ends_at, event.starts_at) as { id: string } | undefined;

  if (overlap) {
    return { ok: false, reason: "Есть пересечение с другой записью." };
  }

  return { ok: true };
}

export function canCancelByClient(eventStartsAt: string, now: Date, cutoffHours = 2): boolean {
  const starts = new Date(eventStartsAt).getTime();
  return starts - now.getTime() >= cutoffHours * 3600000;
}
