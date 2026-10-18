import request from "supertest";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { setupTestDb } from "./helpers.js";

async function login(agent: any, email: string) {
  await agent.post("/auth/login").type("form").send({ email, password: "11111" });
}

describe("memory and access isolation", () => {
  test("client stores memory and sees own records", async () => {
    const { db } = setupTestDb();
    const app = createApp(db);
    const agent = request.agent(app);

    await login(agent, "a@fitclub.local");
    const add = await agent.post("/api/client/memory").send({ category: "time", fact: "Будни после 18:00" });
    expect(add.status).toBe(200);

    const page = await agent.get("/client/memory");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Будни после 18:00");
  });

  test("client A cannot delete memory of client B", async () => {
    const { db, users } = setupTestDb();
    const app = createApp(db);

    db.prepare(`
      INSERT INTO user_memory(id, user_id, category, fact, source, state, created_at, updated_at)
      VALUES('mem-b', ?, 'goal', 'Силовые днём', 'manual', 'confirmed', datetime('now'), datetime('now'))
    `).run(users.clientBId);

    const agentA = request.agent(app);
    await login(agentA, "a@fitclub.local");
    const response = await agentA.delete("/api/client/memory/mem-b");
    expect(response.status).toBe(404);

    const still = db.prepare(`SELECT id FROM user_memory WHERE id='mem-b'`).get() as { id: string } | undefined;
    expect(still?.id).toBe("mem-b");
  });

  test("client cannot access admin route", async () => {
    const { db } = setupTestDb();
    const app = createApp(db);

    const agent = request.agent(app);
    await login(agent, "a@fitclub.local");
    const response = await agent.get("/admin");
    expect(response.status).toBe(403);
  });

  test("admin can access admin route", async () => {
    const { db } = setupTestDb();
    const app = createApp(db);

    const agent = request.agent(app);
    await login(agent, "admin@fitclub.local");
    const response = await agent.get("/admin");
    expect(response.status).toBe(200);
  });
});

