import { handleVercelRequest, VERCEL_FUNCTION_MAX_DURATION_SECONDS } from "../src/mcp/vercel.js";

export const maxDuration = VERCEL_FUNCTION_MAX_DURATION_SECONDS;

export default {
  fetch(request: Request): Promise<Response> | Response {
    return handleVercelRequest(request, process.env);
  },
};
