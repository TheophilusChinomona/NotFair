import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

const LLM_CRAWLER_USER_AGENTS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Gemini",
  "Applebot",
  "CCBot",
  "Meta-ExternalAgent",
  "FacebookBot",
  "Bytespider",
  "Amazonbot",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
      },
      ...LLM_CRAWLER_USER_AGENTS.map((userAgent) => ({
        userAgent,
        allow: "/",
      })),
    ],
    sitemap: [`${SITE_URL}/sitemap.xml`, `${SITE_URL}/blog/sitemap.xml`],
    host: SITE_URL,
  };
}
