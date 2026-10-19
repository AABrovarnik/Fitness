import request from "supertest";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { extractCsrfToken, setupTestDb } from "./helpers.js";

async function login(agent: any, email: string, password = "11111") {
  return agent.post("/auth/login").type("form").send({ email, password });
}

describe("booking rules", () => {
  test("client can book when slot available", async () => {
    const { db } = setupTestDb();
    const app = createApp(db);
    const agent = request.agent(app);

    await login(agent, "a@fitclub.local");
    const csrfToken = extractCsrfToken(await agent.get("/client"));
    const response = await agent.post("/api/client/bookings").set("X-CSRF-Token", csrfToken).send({ event_id: "event-1" });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  test("second client cannot exceed capacity", async () => {
    const { db } = setupTestDb();
    const app = createApp(db);

    const agentA = request.agent(app);
    await login(agentA, "a@fitclub.local");
    const csrfA = extractCsrfToken(await agentA.get("/client"));
    await agentA.post("/api/client/bookings").set("X-CSRF-Token", csrfA).send({ event_id: "event-1" });

    const agentB = request.agent(app);
    await login(agentB, "b@fitclub.local");
    const csrfB = extractCsrfToken(await agentB.get("/client"));
    const response = await agentB.post("/api/client/bookings").set("X-CSRF-Token", csrfB).send({ event_id: "event-1" });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Свободных мест нет/);
  });

  test("visit limit decreases only when booking marked completed", async () => {
    const { db } = setupTestDb();
    const app = createApp(db);

    const client = request.agent(app);
    await login(client, "a@fitclub.local");
    const clientCsrf = extractCsrfToken(await client.get("/client"));
    const createBooking = await client.post("/api/client/bookings").set("X-CSRF-Token", clientCsrf).send({ event_id: "event-1" });
    expect(createBooking.status).toBe(200);

    const booked = db.prepare(`SELECT id FROM bookings WHERE client_id = (SELECT id FROM users WHERE email='a@fitclub.local') AND event_id='event-1' ORDER BY created_at DESC LIMIT 1`).get() as { id: string } | undefined;
    expect(booked?.id).toBeTruthy();

    const before = db.prepare(`SELECT visit_used FROM memberships WHERE client_id=(SELECT id FROM users WHERE email='a@fitclub.local') LIMIT 1`).get() as { visit_used: number };
    expect(before.visit_used).toBe(0);

    const admin = request.agent(app);
    await login(admin, "admin@fitclub.local");
    const adminCsrf = extractCsrfToken(await admin.get("/admin"));
    const complete = await admin.post(`/api/admin/bookings/${booked!.id}/status`).set("X-CSRF-Token", adminCsrf).send({ status: "completed" });
    expect(complete.status).toBe(200);

    const after = db.prepare(`SELECT visit_used FROM memberships WHERE client_id=(SELECT id FROM users WHERE email='a@fitclub.local') LIMIT 1`).get() as { visit_used: number };
    expect(after.visit_used).toBe(1);
  });

  test("no_show does not decrease visit limit", async () => {
    const { db } = setupTestDb();
    const app = createApp(db);

    const client = request.agent(app);
    await login(client, "a@fitclub.local");
    const clientCsrf = extractCsrfToken(await client.get("/client"));
    const createBooking = await client.post("/api/client/bookings").set("X-CSRF-Token", clientCsrf).send({ event_id: "event-1" });
    expect(createBooking.status).toBe(200);

    const booked = db.prepare(`SELECT id FROM bookings WHERE client_id = (SELECT id FROM users WHERE email='a@fitclub.local') AND event_id='event-1' ORDER BY created_at DESC LIMIT 1`).get() as { id: string } | undefined;
    expect(booked?.id).toBeTruthy();

    const admin = request.agent(app);
    await login(admin, "admin@fitclub.local");
    const adminCsrf = extractCsrfToken(await admin.get("/admin"));
    const markNoShow = await admin.post(`/api/admin/bookings/${booked!.id}/status`).set("X-CSRF-Token", adminCsrf).send({ status: "no_show" });
    expect(markNoShow.status).toBe(200);

    const after = db.prepare(`SELECT visit_used FROM memberships WHERE client_id=(SELECT id FROM users WHERE email='a@fitclub.local') LIMIT 1`).get() as { visit_used: number };
    expect(after.visit_used).toBe(0);
  });

  test("admin cannot create overlapping event for same trainer", async () => {
    const { db } = setupTestDb();
    const app = createApp(db);
    const admin = request.agent(app);

    await login(admin, "admin@fitclub.local");
    const csrf = extractCsrfToken(await admin.get("/admin"));

    const event = db.prepare(`SELECT starts_at, ends_at, trainer_id FROM schedule_events WHERE id='event-1'`).get() as {
      starts_at: string;
      ends_at: string;
      trainer_id: string;
    };

    const response = await admin
      .post("/admin/schedule")
      .set("X-CSRF-Token", csrf)
      .type("form")
      .send({
        type: "group",
        title: "Conflict Event",
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        trainer_id: event.trainer_id,
        resource_name: "Another Hall",
        capacity: 10,
        level: "any",
        description: "test"
      });

    expect(response.status).toBe(400);
    expect(response.text).toMatch(/Конфликт по тренеру/);
  });
});

