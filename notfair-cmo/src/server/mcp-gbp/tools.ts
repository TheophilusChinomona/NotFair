import { z } from "zod";
import type { ToolDefinition, ToolResult } from "@/server/mcp-server/tools";
import * as gbp from "./service";

const txt = (text: string): ToolResult => ({ ok: true, content: [{ type: "text", text }] });

export const GBP_TOOLS: ToolDefinition[] = [
  {
    name: "listAccounts",
    description: "List all Google Business Profile accounts the authenticated user can access.",
    inputSchema: z.object({}),
    handler: async () => txt(JSON.stringify(await gbp.listAccounts(), null, 2)),
  },
  {
    name: "listLocations",
    description: "List all locations for a GBP account.",
    inputSchema: z.object({
      accountName: z.string().regex(/^accounts\/[^/]+$/, "Must be in format 'accounts/{accountId}'"),
    }),
    handler: async (input) => {
      const p = input as { accountName: string };
      return txt(JSON.stringify(await gbp.listLocations(p.accountName), null, 2));
    },
  },
  {
    name: "getLocation",
    description: "Get detailed information about a specific GBP location.",
    inputSchema: z.object({
      locationName: z
        .string()
        .regex(
          /^(accounts\/[^/]+\/locations\/[^/]+|locations\/[^/]+)$/,
          "Must be in format 'accounts/{accountId}/locations/{locationId}' or 'locations/{locationId}'",
        ),
    }),
    handler: async (input) => {
      const p = input as { locationName: string };
      return txt(JSON.stringify(await gbp.getLocation(p.locationName), null, 2));
    },
  },
  {
    name: "listReviews",
    description: "List all reviews for a GBP location.",
    inputSchema: z.object({
      accountName: z.string().regex(/^accounts\/[^/]+$/),
      locationName: z.string().regex(/^locations\/[^/]+$/),
    }),
    handler: async (input) => {
      const p = input as { accountName: string; locationName: string };
      return txt(JSON.stringify(await gbp.listReviews(p.accountName, p.locationName), null, 2));
    },
  },
  {
    name: "replyToReview",
    description: "Reply to a review on a GBP location.",
    inputSchema: z.object({
      accountName: z.string().regex(/^accounts\/[^/]+$/),
      locationName: z.string().regex(/^locations\/[^/]+$/),
      reviewId: z.string().min(1),
      comment: z.string().min(1),
    }),
    handler: async (input) => {
      const p = input as { accountName: string; locationName: string; reviewId: string; comment: string };
      return txt(JSON.stringify(await gbp.replyToReview(p.accountName, p.locationName, p.reviewId, p.comment), null, 2));
    },
  },
  {
    name: "listPosts",
    description: "List all Google Posts for a GBP location.",
    inputSchema: z.object({
      accountName: z.string().regex(/^accounts\/[^/]+$/),
      locationName: z.string().regex(/^locations\/[^/]+$/),
    }),
    handler: async (input) => {
      const p = input as { accountName: string; locationName: string };
      return txt(JSON.stringify(await gbp.listPosts(p.accountName, p.locationName), null, 2));
    },
  },
  {
    name: "createPost",
    description: "Create a Google Post on a GBP location.",
    inputSchema: z.object({
      accountName: z.string().regex(/^accounts\/[^/]+$/),
      locationName: z.string().regex(/^locations\/[^/]+$/),
      topicType: z.string().describe("e.g. STANDARD, EVENT, OFFER"),
      languageCode: z.string().describe("e.g. en-US"),
      summary: z.object({}).passthrough().describe("Post summary/body text object"),
      callToAction: z
        .object({
          actionType: z.string().optional(),
          url: z.string().optional(),
        })
        .optional(),
      event: z
        .object({
          title: z.string().optional(),
          schedule: z
            .object({
              startDate: z.object({ year: z.number(), month: z.number(), day: z.number() }).optional(),
              endDate: z.object({ year: z.number(), month: z.number(), day: z.number() }).optional(),
            })
            .optional(),
        })
        .optional(),
      offer: z
        .object({
          coupon: z.string().optional(),
          redeemOnlineUrl: z.string().optional(),
          termsConditions: z.string().optional(),
        })
        .optional(),
      alertType: z.string().optional(),
    }),
    handler: async (input) => {
      const p = input as {
        accountName: string;
        locationName: string;
        topicType: string;
        languageCode: string;
        summary: Record<string, unknown>;
        callToAction?: Record<string, unknown>;
        event?: Record<string, unknown>;
        offer?: Record<string, unknown>;
        alertType?: string;
      };
      return txt(JSON.stringify(await gbp.createPost(p.accountName, p.locationName, p), null, 2));
    },
  },
  {
    name: "getInsights",
    description: "Fetch daily performance metrics for a GBP location.",
    inputSchema: z.object({
      locationName: z
        .string()
        .regex(
          /^(accounts\/[^/]+\/locations\/[^/]+|locations\/[^/]+)$/,
          "Must be in format 'accounts/{accountId}/locations/{locationId}' or 'locations/{locationId}'",
        ),
      dailyMetrics: z
        .array(z.string())
        .min(1)
        .describe(
          "e.g. ['WEBSITE_CLICKS', 'CALL_CLICKS', 'BUSINESS_DIRECTION_REQUESTS', 'BUSINESS_MESSAGES', 'ALL', 'PROFILE_VIEWS_SEARCH', 'PROFILE_VIEWS_MAPS', 'FOLLOWS']",
        ),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
    handler: async (input) => {
      const p = input as { locationName: string; dailyMetrics: string[]; startDate: string; endDate: string };
      return txt(JSON.stringify(await gbp.getInsights(p.locationName, p.dailyMetrics, p.startDate, p.endDate), null, 2));
    },
  },
];
