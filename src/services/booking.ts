import type { Db } from "../db/db.js";

export interface BookingValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateBooking(db: Db, clientId: string, eventId: string): BookingValidationResult {
  const event = db
    .prepare(`SELECT id, starts_at, ends_at, capacity, status, booking_enabled FROM schedule_events WHERE id = ?`)
    .get(eventId) as
    | { id: string; starts_at: string; ends_at: string; capacity: number; status: string; booking_enabled: number }
    | undefined;

  if (!event) {
    return { ok: false, reason: "Событие не найдено." };
  }

  if (event.status !== "active" || event.booking_enabled !== 1) {
    return { ok: false, reason: "Запись на событие недоступна." };
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
