import { z } from "zod";
import type { ToolDefinition, ToolResult } from "@/server/mcp-server/tools";
import * as gsc from "./service";

const txt = (text: string): ToolResult => ({ ok: true, content: [{ type: "text", text }] });

export const GSC_TOOLS: ToolDefinition[] = [
  {
    name: "sites",
    description: "List all Search Console properties the authenticated account can access.",
    inputSchema: z.object({}),
    handler: async () => txt(JSON.stringify(await gsc.listSites(), null, 2)),
  },
  {
    name: "searchAnalytics",
    description: "Query Search Analytics data for top queries, pages, device/country breakdowns.",
    inputSchema: z.object({
      siteUrl: z.string().describe("GSC property URL"),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      dimensions: z.array(z.enum(["query", "page", "device", "country", "date"])).optional(),
      rowLimit: z.number().int().min(1).max(25000).optional().default(1000),
      type: z.enum(["web", "image", "video", "news", "discover", "googleNews"]).optional(),
    }),
    handler: async (input) => {
      const p = input as z.infer<typeof GSC_TOOLS[1]["inputSchema"]>;
      const result = await gsc.querySearchAnalytics(p.siteUrl, p.startDate, p.endDate, p.dimensions, p.rowLimit, p.type);
      return txt(JSON.stringify(result, null, 2));
    },
  },
  {
    name: "inspectUrl",
    description: "Inspect a URL's index status, mobile usability, and rich results.",
    inputSchema: z.object({
      siteUrl: z.string(),
      inspectionUrl: z.string().url(),
    }),
    handler: async (input) => {
      const p = input as { siteUrl: string; inspectionUrl: string };
      const result = await gsc.inspectUrl(p.siteUrl, p.inspectionUrl);
      return txt(JSON.stringify(result, null, 2));
    },
  },
];
