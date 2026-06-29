---
name: create-ads
description: Create Google and Meta ads from scratch for any business using their website URL or a business description. No active ad account or API key required. Trigger on "create ads", "make ads", "ad generator", "generate ads from URL", "write ads for my business", "new business ads", "ads for any business", "campaign brainstorm".
argument-hint: "<website URL or business description>"
---

# Standalone Ad Creation for Any Business

Generate complete Google Ads and Meta Ads campaigns, ad copy, keyword lists, and negative keyword exclusions for any business without requiring a connected ad account or OAuth authorization.

## Workflow

### 1. Retrieve Business Details
If a website URL or business description was not passed as an argument, prompt the user:
> What is the website URL or description of the business you want to create ads for?

- **If a URL is provided**: Use your native web fetching tools (e.g. `read_url_content`) to fetch the homepage, and if possible, `/about` or `/services`. Skim these pages to extract:
  - Business Name
  - Primary offerings / services
  - Target audience / buyer personas
  - Unique differentiators (e.g., "same-day service", "licensed & insured", "family-owned")
  - Brand voice and tone (approach/words used)
- **If only a description is provided**: Extract key services, differentiators, and name from the description. Prompt the user for clarification if the description is too sparse to write quality copy.

### 2. Match Industry Template
Map the extracted industry to one of the templates in `google-ads/shared/industry-templates.json` (case-insensitive substring match against `aliases` list).
- If a match is found (e.g., `legal`, `home_services`, `saas_b2b`), load the template's guidelines:
  - Typical conversion rate (`typical_cvr`) and margin (`typical_margin`)
  - Target CPA range
  - `quick_start_negatives` (to be used as the base negative keyword list)
- If no match is found, fallback to the `generic` template.

Write the complete business context to `{data_dir}/business-context.json` according to the standard schema:
```json
{
  "business_name": "extracted_name",
  "industry": "matched_industry",
  "industry_template_key": "matched_key",
  "website": "url_or_null",
  "services": ["service1", "service2"],
  "locations": [],
  "target_audience": "audience_description",
  "brand_voice": {
    "tone": "brand_tone",
    "words_to_avoid": [],
    "words_to_use": []
  },
  "differentiators": ["diff1", "diff2"],
  "competitors": [],
  "seasonality": {
    "peak_months": [],
    "slow_months": [],
    "seasonal_hooks": []
  },
  "keyword_landscape": {
    "high_intent_terms": [],
    "competitive_terms": [],
    "long_tail_opportunities": []
  },
  "social_proof": [],
  "offers_or_promotions": [],
  "landing_pages": {},
  "notes": "Generated offline via create-ads skill",
  "audit_date": "YYYY-MM-DD",
  "account_id": "offline"
}
```

### 3. Generate Google Ads RSA Copy
Create a complete Responsive Search Ad (RSA) copy set targeting the core offering/differentiators. You must adhere strictly to these constraints:
- **Headlines (12 total)**: Exactly 30 characters or fewer. Count characters (including spaces) for each. Organize into these categories:
  - 3x Service/Product Focus (e.g., "Affordable Plumbing", "Austin Plumber Experts")
  - 3x Value Proposition/Differentiator (e.g., "Same-Day Emergency Service", "No Hidden Fees Ever")
  - 2x Trust Signal/Social Proof (e.g., "5-Star Rated on Google", "25+ Years Experience")
  - 2x CTA (e.g., "Get a Free Estimate Now", "Book Online in 60 Secs")
  - 2x Price/Offer (e.g., "Spring Special: 20% Off", "AC Service From $89")
- **Descriptions (4 total)**: Exactly 90 characters or fewer. Organize into these categories:
  - 1x Core Benefit + CTA
  - 1x Differentiator + CTA
  - 1x Trust + Social Proof + CTA
  - 1x Pain Point + Solution + CTA
- **Display Paths**: Propose two Display Path segments (15 chars max each).
- **Pinning Recommendations**: Suggest pinning 1 headline (Service/Brand focus) to Position 1, and 1 CTA headline to Position 3, keeping Position 2 unpinned for Google's machine learning optimization.

### 4. Generate Meta Ads Copy Variants
Generate 4 Facebook/Instagram ad copy variations reflecting different angles to allow the user to A/B test creatives:
1. **Pain Point Angle**: Highlight a common user problem and present the product/service as the solution.
2. **Social Proof Angle**: Incorporate customer reviews, ratings, or client numbers to build credibility.
3. **Core Benefit Angle**: Focus heavily on the primary outcome/benefit of the service.
4. **Offer/Incentive Angle**: Lead with an introductory promotion or free estimate to drive action.

For each variation, output:
- **Primary Text**: Hook + main body copy (100–150 words).
- **Headline**: Short punchy hook (40 chars max).
- **Description**: Supporting benefit (30 chars max).

### 5. Recommend Keyword & Campaign Structure
Propose a campaign structure containing:
- **2 Campaign Themes** (e.g., Brand/Core Services vs. High-Intent Secondary Category).
- **2-3 Ad Groups per Campaign**, matching specific search intent themes.
- **5-10 High-Intent Keywords** per Ad Group, indicating match type (Broad, Phrase, Exact).
- **Negative Keywords**: Provide the list of `quick_start_negatives` from the matched industry template as a starting point.

### 6. Save & Present Report
Write the complete output (business context, Google Ads copy, Meta Ads copy, campaign structure, negative keywords) to a markdown file:
`{data_dir}/generated-ads-[business-name].md`

Present the complete report beautifully to the user in the console/chat, highlighting the character lengths and copy angles. Tell the user where the file was saved.
