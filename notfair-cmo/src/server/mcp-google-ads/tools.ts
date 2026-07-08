import { google, type Auth } from "googleapis";
import { z } from "zod";
import type { ToolDefinition, ToolResult } from "@/server/mcp-server/tools";

// ── Config ─────────────────────────────────────────────────────────────────

const API_BASE = "https://googleads.googleapis.com/v17";

// ── Auth (ADC) ──────────────────────────────────────────────────────────────

let _client: Auth.OAuth2Client | Auth.JWT | null = null;

async function getClient(): Promise<Auth.OAuth2Client | Auth.JWT> {
  if (_client) return _client;
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/adwords"],
  });
  _client = (await auth.getClient()) as Auth.OAuth2Client | Auth.JWT;
  return _client;
}

async function getAccessToken(): Promise<string> {
  const client = await getClient();
  const token = await client.getAccessToken();
  return token?.token ?? "";
}

// ── Response helpers ────────────────────────────────────────────────────────

const txt = (text: string): ToolResult => ({ ok: true, content: [{ type: "text", text }] });
const fail = (msg: string): ToolResult => ({ ok: false, error: msg });

// ── API helpers ─────────────────────────────────────────────────────────────

function resolveCustomerId(customerId?: string): string {
  return customerId ?? (process.env.GOOGLE_ADS_CUSTOMER_ID || "");
}

async function apiFetch(
  path: string,
  body: Record<string, unknown>,
  customerId: string,
): Promise<unknown> {
  const token = await getAccessToken();
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "";
  if (!devToken) throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN not set");
  if (!customerId) throw new Error("No customer ID provided; set GOOGLE_ADS_CUSTOMER_ID or pass customerId");

  const url = `${API_BASE}/customers/${customerId}/${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "developer-token": devToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Ads API error (${res.status}): ${text}`);
  }

  return res.json() as Promise<unknown>;
}

// ── GAQL search ─────────────────────────────────────────────────────────────

async function search(
  customerId: string,
  query: string,
  pageSize?: number,
  pageToken?: string,
): Promise<unknown> {
  const body: Record<string, unknown> = { query };
  if (pageSize !== undefined) body.pageSize = pageSize;
  if (pageToken !== undefined) body.pageToken = pageToken;
  return apiFetch("googleAds:search", body, customerId);
}

// ── Campaign mutations (pause / enable) ─────────────────────────────────────

async function mutateCampaignStatus(
  customerId: string,
  campaignId: string,
  status: "PAUSED" | "ENABLED",
): Promise<unknown> {
  const resourceName = `customers/${customerId}/campaigns/${campaignId}`;
  return apiFetch("googleAds:mutate", {
    mutateOperations: [
      {
        campaignOperation: {
          update: {
            resourceName,
            status,
          },
          updateMask: "status",
        },
      },
    ],
  }, customerId);
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const GOOGLE_ADS_TOOLS: ToolDefinition[] = [
  {
    name: "search",
    description:
      "Run a GAQL (Google Ads Query Language) query against the Google Ads API. " +
      "Returns matching rows as JSON. Supports pagination via pageSize and pageToken.",
    inputSchema: z.object({
      query: z.string().min(1).describe("GAQL query string (e.g. SELECT campaign.id, campaign.name FROM campaign)"),
      customerId: z.string().optional().describe("Google Ads customer ID without hyphens; falls back to GOOGLE_ADS_CUSTOMER_ID"),
      pageSize: z.number().int().min(1).max(10000).optional().describe("Max results per page (default: API default)"),
      pageToken: z.string().optional().describe("Page token for pagination"),
    }),
    handler: async (input) => {
      const p = input as {
        query: string;
        customerId?: string;
        pageSize?: number;
        pageToken?: string;
      };
      const cid = resolveCustomerId(p.customerId);
      if (!cid) return fail("No customer ID provided. Set GOOGLE_ADS_CUSTOMER_ID in env or pass customerId to the tool.");
      try {
        const result = await search(cid, p.query, p.pageSize, p.pageToken);
        return txt(JSON.stringify(result, null, 2));
      } catch (e: unknown) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  },
  {
    name: "pauseCampaign",
    description: "Pause a Google Ads campaign by ID.",
    inputSchema: z.object({
      campaignId: z.string().min(1).describe("Campaign ID (numeric, without customer prefix)"),
      customerId: z.string().optional().describe("Falls back to GOOGLE_ADS_CUSTOMER_ID"),
    }),
    handler: async (input) => {
      const p = input as { campaignId: string; customerId?: string };
      const cid = resolveCustomerId(p.customerId);
      if (!cid) return fail("No customer ID provided.");
      try {
        const result = await mutateCampaignStatus(cid, p.campaignId, "PAUSED");
        return txt(JSON.stringify(result, null, 2));
      } catch (e: unknown) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  },
  {
    name: "enableCampaign",
    description: "Enable (reactivate) a paused Google Ads campaign by ID.",
    inputSchema: z.object({
      campaignId: z.string().min(1).describe("Campaign ID (numeric, without customer prefix)"),
      customerId: z.string().optional().describe("Falls back to GOOGLE_ADS_CUSTOMER_ID"),
    }),
    handler: async (input) => {
      const p = input as { campaignId: string; customerId?: string };
      const cid = resolveCustomerId(p.customerId);
      if (!cid) return fail("No customer ID provided.");
      try {
        const result = await mutateCampaignStatus(cid, p.campaignId, "ENABLED");
        return txt(JSON.stringify(result, null, 2));
      } catch (e: unknown) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  },
];
