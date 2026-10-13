import { mcpHandler } from "../../../lib/mcp";
import { withAgent } from "../../../lib/request";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = (req: Request) => withAgent(req, "mcp", () => mcpHandler(req));

export { handler as GET, handler as POST, handler as DELETE };
