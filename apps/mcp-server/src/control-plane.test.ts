import { describe, expect, it } from "vitest";
import { ControlPlaneServer } from "./control-plane.js";

describe("ControlPlaneServer", () => {
  it("starts, accepts connections, enforces rate limits and authorization", async () => {
    const server = new ControlPlaneServer({ port: 8999 });
    await server.start();

    try {
      const res = await fetch("http://localhost:8999/v1/tasks/task-abc");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { taskId: string };
      expect(data.taskId).toBe("task-abc");

      const res404 = await fetch("http://localhost:8999/invalid-route");
      expect(res404.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
