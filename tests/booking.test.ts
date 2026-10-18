import request from "supertest";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { setupTestDb } from "./helpers.js";

async function login(agent: any, email: string, password = "11111") {
  return agent.post("/auth/login").type("form").send({ email, password });
}

describe("booking rules", () => {
  test("client can book when slot available", async () => {
    const { db } = setupTestDb();
    const app = createApp(db);
    const agent = request.agent(app);

    await login(agent, "a@fitclub.local");
    const response = await agent.post("/api/client/bookings").send({ event_id: "event-1" });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  test("second client cannot exceed capacity", async () => {
    const { db } = setupTestDb();
    const app = createApp(db);

    const agentA = request.agent(app);
    await login(agentA, "a@fitclub.local");
    await agentA.post("/api/client/bookings").send({ event_id: "event-1" });

    const agentB = request.agent(app);
    await login(agentB, "b@fitclub.local");
    const response = await agentB.post("/api/client/bookings").send({ event_id: "event-1" });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Свободных мест нет/);
  });
});

