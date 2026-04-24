import type { HealthDeps } from "../health.ts";
import type { SigilInfo } from "../sigil.ts";
import { getHealth } from "../health.ts";

export async function handleVersion(_req: Request, sigil: SigilInfo): Promise<Response> {
  return new Response(JSON.stringify(sigil, null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function handleHealth(_req: Request, deps: HealthDeps): Promise<Response> {
  const report = await getHealth(deps);
  const allOk = Object.values(report.dependencies).every((d) => d.status === "ok");
  return new Response(JSON.stringify(report, null, 2), {
    status: allOk ? 200 : 503,
    headers: { "content-type": "application/json" },
  });
}
